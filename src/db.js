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

-- 校对者批量修订提议：一组针对未锁定字幕的待采纳修订
CREATE TABLE IF NOT EXISTS revisions (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id             INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  note                   TEXT NOT NULL DEFAULT '',   -- 校对说明
  rules_version_snapshot INTEGER NOT NULL,           -- 提议保存时的规则版本
  sub_version_snapshot   INTEGER NOT NULL,           -- 提议保存时的字幕集版本
  status                 TEXT NOT NULL DEFAULT 'pending', -- pending（待采纳）/ accepted（已采纳）
  accepted_at            TEXT,
  accepted_sub_version   INTEGER,                    -- 采纳后字幕集推进到的版本
  created_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS revision_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  revision_id   INTEGER NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
  ord           INTEGER NOT NULL,               -- 组内顺序
  subtitle_id   INTEGER NOT NULL,               -- 目标字幕 ID（提交时存在且未锁定）
  cue_version   INTEGER NOT NULL,               -- 校对者读取该行时的版本号
  orig_text     TEXT NOT NULL,                  -- 原值快照
  orig_start_ms INTEGER NOT NULL,
  orig_end_ms   INTEGER NOT NULL,
  proposed_text TEXT NOT NULL,                  -- 替代文本
  start_ms      INTEGER,                        -- 可选：替代开始毫秒，NULL 表示沿用原值
  end_ms        INTEGER,                        -- 可选：替代结束毫秒，NULL 表示沿用原值
  UNIQUE(revision_id, ord)
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
  const revisions = listRevisions(db, id);
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
    revisions,
  };
}

/** 项目下全部修订提议摘要（不含逐项明细），按时间倒序 */
function listRevisions(db, projectId) {
  return db.prepare(
    `SELECT r.id, r.note, r.status, r.rules_version_snapshot, r.sub_version_snapshot,
            r.accepted_sub_version, r.created_at, r.accepted_at,
            (SELECT COUNT(*) FROM revision_items i WHERE i.revision_id = r.id) AS item_count
     FROM revisions r WHERE r.project_id = ? ORDER BY r.id DESC`
  ).all(projectId);
}

/**
 * 读取一个修订提议（含逐项明细）。不存在或不属于该项目返回 null。
 * 每项同时给出 orig_*（提交时原值）、proposed_*（建议值，start_ms/end_ms 为 null 表示沿用原值）。
 */
function loadRevision(db, projectId, revisionId) {
  const head = db.prepare('SELECT * FROM revisions WHERE id = ? AND project_id = ?')
    .get(revisionId, projectId);
  if (!head) return null;
  const items = db.prepare(
    'SELECT * FROM revision_items WHERE revision_id = ? ORDER BY ord'
  ).all(revisionId);
  return {
    id: head.id,
    project_id: head.project_id,
    note: head.note,
    status: head.status,
    rules_version_snapshot: head.rules_version_snapshot,
    sub_version_snapshot: head.sub_version_snapshot,
    accepted_sub_version: head.accepted_sub_version,
    created_at: head.created_at,
    accepted_at: head.accepted_at,
    items: items.map((it) => ({
      ord: it.ord,
      subtitle_id: it.subtitle_id,
      cue_version: it.cue_version,
      orig: { text: it.orig_text, start_ms: it.orig_start_ms, end_ms: it.orig_end_ms },
      proposed: {
        text: it.proposed_text,
        start_ms: it.start_ms,
        end_ms: it.end_ms,
        has_start_ms: it.start_ms !== null,
        has_end_ms: it.end_ms !== null,
      },
    })),
  };
}

function bumpSubVersion(db, projectId) {
  db.prepare('UPDATE projects SET sub_version = sub_version + 1 WHERE id = ?').run(projectId);
  return db.prepare('SELECT sub_version FROM projects WHERE id = ?').get(projectId).sub_version;
}

module.exports = {
  initDb, loadProject, listRevisions, loadRevision, bumpSubVersion, DEFAULT_RULES,
};
