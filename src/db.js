'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  sub_version INTEGER NOT NULL DEFAULT 0,   -- 字幕集每次变更（编辑/锁定/重排）都 +1，用于乐观锁
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS words (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,
  text       TEXT NOT NULL,
  start_ms   INTEGER NOT NULL,
  end_ms     INTEGER NOT NULL,
  UNIQUE(project_id, idx)
);

CREATE TABLE IF NOT EXISTS shots (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,
  cut_ms     INTEGER NOT NULL,
  UNIQUE(project_id, idx)
);

CREATE TABLE IF NOT EXISTS rules (
  project_id      INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  version         INTEGER NOT NULL DEFAULT 1,  -- 每次修改 +1，提交时携带以拒绝过期写入
  max_chars       INTEGER NOT NULL,
  min_duration_ms INTEGER NOT NULL,
  max_cps         REAL NOT NULL,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS subtitles (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,               -- 展示顺序（按时间升序）
  word_start INTEGER NOT NULL,               -- 覆盖的词区间 [word_start, word_end]
  word_end   INTEGER NOT NULL,
  text       TEXT NOT NULL,
  start_ms   INTEGER NOT NULL,
  end_ms     INTEGER NOT NULL,
  locked     INTEGER NOT NULL DEFAULT 0,
  version    INTEGER NOT NULL DEFAULT 1,     -- 行级乐观锁
  UNIQUE(project_id, idx)
);

CREATE TABLE IF NOT EXISTS exports (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,               -- 项目内递增，确认一次 +1
  content    TEXT NOT NULL,                  -- WebVTT 快照，确认后不再改变
  cue_count  INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, version)
);

CREATE TABLE IF NOT EXISTS proposals (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id          INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status              TEXT NOT NULL DEFAULT 'pending',  -- pending | adopted
  note                TEXT NOT NULL DEFAULT '',         -- 整组说明
  rules_version       INTEGER NOT NULL,                 -- 提交时的规则版本（采纳时核对）
  sub_version         INTEGER NOT NULL,                 -- 提交时的字幕集版本（信息性）
  applied_sub_version INTEGER,                          -- 采纳后推进到的字幕集版本
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  adopted_at          TEXT
);

CREATE TABLE IF NOT EXISTS proposal_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id   INTEGER NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  idx           INTEGER NOT NULL,            -- 组内顺序
  subtitle_id   INTEGER NOT NULL,            -- 目标字幕（提交时存在且未锁定）
  base_version  INTEGER NOT NULL,            -- 校对者读取时的行版本
  orig_version  INTEGER NOT NULL,            -- 提交时服务器快照的行版本（采纳时核对）
  orig_text     TEXT NOT NULL,               -- 提交时的原值快照
  orig_start_ms INTEGER NOT NULL,
  orig_end_ms   INTEGER NOT NULL,
  new_text      TEXT NOT NULL,               -- 替代文本
  new_start_ms  INTEGER,                     -- NULL = 不修改
  new_end_ms    INTEGER,
  note          TEXT NOT NULL DEFAULT '',    -- 逐项说明
  UNIQUE(proposal_id, subtitle_id)           -- 同一组内同一字幕只能修订一次
);
`;

const DEFAULT_RULES = { max_chars: 30, min_duration_ms: 800, max_cps: 20 };

function initDb(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.exec(SCHEMA);
  return db;
}

/** 项目完整载荷：项目 + 词 + 切点 + 规则 + 字幕 + 导出版本列表 */
function loadProject(db, id) {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!project) return null;
  const words = db.prepare(
    'SELECT idx, text, start_ms, end_ms FROM words WHERE project_id = ? ORDER BY idx'
  ).all(id);
  const cuts = db.prepare(
    'SELECT cut_ms FROM shots WHERE project_id = ? ORDER BY idx'
  ).all(id).map((r) => r.cut_ms);
  const rules = db.prepare('SELECT * FROM rules WHERE project_id = ?').get(id);
  const subtitles = db.prepare(
    `SELECT id, idx, word_start, word_end, text, start_ms, end_ms, locked, version
     FROM subtitles WHERE project_id = ? ORDER BY idx`
  ).all(id);
  const exportsList = db.prepare(
    'SELECT version, cue_count, created_at FROM exports WHERE project_id = ? ORDER BY version DESC'
  ).all(id);
  return {
    id: project.id,
    name: project.name,
    sub_version: project.sub_version,
    created_at: project.created_at,
    words,
    cuts,
    rules: rules
      ? { version: rules.version, max_chars: rules.max_chars,
          min_duration_ms: rules.min_duration_ms, max_cps: rules.max_cps }
      : null,
    subtitles,
    exports: exportsList,
    proposals: listProposals(db, id),
  };
}

/** 项目的修订提议历史（不含逐项明细），按时间倒序 */
function listProposals(db, projectId) {
  return db.prepare(
    `SELECT p.id, p.status, p.note, p.rules_version, p.sub_version, p.applied_sub_version,
            p.created_at, p.adopted_at,
            (SELECT COUNT(*) FROM proposal_items i WHERE i.proposal_id = p.id) AS item_count
     FROM proposals p WHERE p.project_id = ? ORDER BY p.id DESC`
  ).all(projectId);
}

/**
 * 单条提议的完整明细：原值（提交时快照）与建议值并列。
 * 建议值中 start_ms/end_ms 为 null 表示该项不修改时间。
 */
function loadProposal(db, projectId, proposalId) {
  const row = db.prepare('SELECT * FROM proposals WHERE id = ? AND project_id = ?')
    .get(proposalId, projectId);
  if (!row) return null;
  const items = db.prepare(
    'SELECT * FROM proposal_items WHERE proposal_id = ? ORDER BY idx'
  ).all(proposalId).map((it) => ({
    subtitle_id: it.subtitle_id,
    base_version: it.base_version,
    orig_version: it.orig_version,
    note: it.note,
    original: { text: it.orig_text, start_ms: it.orig_start_ms, end_ms: it.orig_end_ms },
    suggested: { text: it.new_text, start_ms: it.new_start_ms, end_ms: it.new_end_ms },
  }));
  return {
    id: row.id,
    project_id: row.project_id,
    status: row.status,
    note: row.note,
    rules_version: row.rules_version,
    sub_version: row.sub_version,
    applied_sub_version: row.applied_sub_version,
    created_at: row.created_at,
    adopted_at: row.adopted_at,
    items,
  };
}

function bumpSubVersion(db, projectId) {
  db.prepare('UPDATE projects SET sub_version = sub_version + 1 WHERE id = ?').run(projectId);
  return db.prepare('SELECT sub_version FROM projects WHERE id = ?').get(projectId).sub_version;
}

module.exports = { initDb, loadProject, loadProposal, listProposals, bumpSubVersion, DEFAULT_RULES };
