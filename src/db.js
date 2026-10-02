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
  };
}

function bumpSubVersion(db, projectId) {
  db.prepare('UPDATE projects SET sub_version = sub_version + 1 WHERE id = ?').run(projectId);
  return db.prepare('SELECT sub_version FROM projects WHERE id = ?').get(projectId).sub_version;
}

module.exports = { initDb, loadProject, bumpSubVersion, DEFAULT_RULES };
