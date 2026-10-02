'use strict';

const express = require('express');
const { loadProject, listRevisions, loadRevision, bumpSubVersion, DEFAULT_RULES } = require('./db');
const { computeLayout, validateStructure, validateRules } = require('./layout');
const { validateWords, validateCuts, validateRules: validateRulesInput, validateSubtitleEdit } = require('./validate');
const { parseRevisionItems, evaluateRevision } = require('./revision');
const { toWebVtt } = require('./vtt');

/**
 * 挂载 API 路由。统一错误格式：
 *   400 { error }                 请求体非法
 *   404 { error }                 资源不存在
 *   409 { error, current }        版本过期，current 为当前内容
 *   422 { error, errors|conflicts } 校验失败 / 规则冲突
 */
function createApp(db) {
  const app = express();
  app.use(express.json({ limit: '50mb' }));

  const getProject = (req, res) => {
    const p = loadProject(db, Number(req.params.id));
    if (!p) {
      res.status(404).json({ error: `项目 ${req.params.id} 不存在` });
      return null;
    }
    return p;
  };

  // ---------- 项目 ----------

  app.get('/api/projects', (req, res) => {
    const rows = db.prepare(
      `SELECT p.id, p.name, p.created_at,
              (SELECT COUNT(*) FROM words w WHERE w.project_id = p.id)  AS word_count,
              (SELECT COUNT(*) FROM subtitles s WHERE s.project_id = p.id) AS cue_count,
              (SELECT COUNT(*) FROM exports e WHERE e.project_id = p.id)   AS export_count
       FROM projects p ORDER BY p.id DESC`
    ).all();
    res.json(rows);
  });

  app.post('/api/projects', (req, res) => {
    const { name, words, cuts, rules } = req.body || {};
    if (typeof name !== 'string' || name.trim() === '') {
      return res.status(400).json({ error: 'name 必须是非空字符串' });
    }
    let wordRows = null;
    let cutList = [];
    if (words !== undefined) {
      const w = validateWords(words);
      if (!w.ok) return res.status(422).json({ error: '逐词转写校验失败，拒绝导入', errors: w.errors });
      wordRows = words.map((x) => ({ text: x.text.trim(), start_ms: x.start_ms, end_ms: x.end_ms }));
    }
    const c = validateCuts(cuts);
    if (!c.ok) return res.status(422).json({ error: '镜头切点校验失败，拒绝导入', errors: c.errors });
    cutList = c.cuts;
    const ruleValues = rules !== undefined ? rules : DEFAULT_RULES;
    const rv = validateRulesInput(ruleValues);
    if (!rv.ok) return res.status(422).json({ error: '排版规则校验失败', errors: rv.errors });

    const tx = db.transaction(() => {
      const info = db.prepare('INSERT INTO projects (name) VALUES (?)').run(name.trim());
      const pid = info.lastInsertRowid;
      db.prepare(
        'INSERT INTO rules (project_id, max_chars, min_duration_ms, max_cps) VALUES (?, ?, ?, ?)'
      ).run(pid, ruleValues.max_chars, ruleValues.min_duration_ms, ruleValues.max_cps);
      if (wordRows) {
        const ins = db.prepare('INSERT INTO words (project_id, idx, text, start_ms, end_ms) VALUES (?, ?, ?, ?, ?)');
        wordRows.forEach((w, i) => ins.run(pid, i, w.text, w.start_ms, w.end_ms));
      }
      const insCut = db.prepare('INSERT INTO shots (project_id, idx, cut_ms) VALUES (?, ?, ?)');
      cutList.forEach((ms, i) => insCut.run(pid, i, ms));
      return pid;
    });
    const pid = tx();
    res.status(201).json(loadProject(db, pid));
  });

  app.get('/api/projects/:id', (req, res) => {
    const p = getProject(req, res);
    if (p) res.json(p);
  });

  // ---------- 导入（替换转写与切点） ----------

  app.post('/api/projects/:id/import', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const { words, cuts, force } = req.body || {};
    const w = validateWords(words);
    if (!w.ok) return res.status(422).json({ error: '逐词转写校验失败，拒绝导入', errors: w.errors });
    const c = validateCuts(cuts);
    if (!c.ok) return res.status(422).json({ error: '镜头切点校验失败，拒绝导入', errors: c.errors });

    const cueCount = db.prepare('SELECT COUNT(*) AS n FROM subtitles WHERE project_id = ?').get(p.id).n;
    if (cueCount > 0 && !force) {
      return res.status(409).json({
        error: `项目已有 ${cueCount} 条字幕，重新导入将清空全部字幕（含已锁定）。确认请携带 {"force": true}`,
        cue_count: cueCount,
      });
    }
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM subtitles WHERE project_id = ?').run(p.id);
      db.prepare('DELETE FROM words WHERE project_id = ?').run(p.id);
      db.prepare('DELETE FROM shots WHERE project_id = ?').run(p.id);
      const ins = db.prepare('INSERT INTO words (project_id, idx, text, start_ms, end_ms) VALUES (?, ?, ?, ?, ?)');
      words.forEach((x, i) => ins.run(p.id, i, x.text.trim(), x.start_ms, x.end_ms));
      const insCut = db.prepare('INSERT INTO shots (project_id, idx, cut_ms) VALUES (?, ?, ?)');
      c.cuts.forEach((ms, i) => insCut.run(p.id, i, ms));
      bumpSubVersion(db, p.id);
    });
    tx();
    res.json(loadProject(db, p.id));
  });

  // ---------- 规则（版本号拒绝过期提交） ----------

  app.put('/api/projects/:id/rules', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const { version, max_chars, min_duration_ms, max_cps } = req.body || {};
    const current = db.prepare('SELECT * FROM rules WHERE project_id = ?').get(p.id);
    if (version !== current.version) {
      return res.status(409).json({
        error: `规则版本过期：你基于 v${version} 修改，但当前已是 v${current.version}`,
        current: {
          version: current.version, max_chars: current.max_chars,
          min_duration_ms: current.min_duration_ms, max_cps: current.max_cps,
        },
      });
    }
    const rv = validateRulesInput({ max_chars, min_duration_ms, max_cps });
    if (!rv.ok) return res.status(422).json({ error: '排版规则校验失败', errors: rv.errors });
    db.prepare(
      `UPDATE rules SET version = version + 1, max_chars = ?, min_duration_ms = ?, max_cps = ?,
       updated_at = datetime('now') WHERE project_id = ?`
    ).run(max_chars, min_duration_ms, max_cps, p.id);
    res.json(loadProject(db, p.id).rules);
  });

  // ---------- 重排（只改未锁定部分） ----------

  app.post('/api/projects/:id/layout', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const { sub_version } = req.body || {};
    if (sub_version !== p.sub_version) {
      return res.status(409).json({
        error: `字幕集已被修改（当前版本 ${p.sub_version}），请刷新后重试`,
        current: { sub_version: p.sub_version, subtitles: p.subtitles },
      });
    }
    if (p.words.length === 0) {
      return res.status(422).json({ error: '尚未导入逐词转写，无法排版', conflicts: [] });
    }
    const locked = p.subtitles.filter((s) => s.locked === 1);
    const result = computeLayout({ words: p.words, cuts: p.cuts, rules: p.rules, locked });
    if (!result.ok) {
      return res.status(422).json({
        error: `排版规则无法同时满足，共 ${result.conflicts.length} 处冲突；未改动任何字幕`,
        conflicts: result.conflicts,
      });
    }
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM subtitles WHERE project_id = ? AND locked = 0').run(p.id);
      const ins = db.prepare(
        `INSERT INTO subtitles (project_id, idx, word_start, word_end, text, start_ms, end_ms, locked)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
      );
      const updIdx = db.prepare('UPDATE subtitles SET idx = ? WHERE id = ?');
      // 锁定字幕保留原行（id/version 不变），仅按新顺序更新 idx
      const lockedByWords = new Map(locked.map((s) => [`${s.word_start}:${s.word_end}`, s]));
      result.cues.forEach((cue, i) => {
        const key = `${cue.word_start}:${cue.word_end}`;
        if (cue.locked === 1 && lockedByWords.has(key)) {
          updIdx.run(i, lockedByWords.get(key).id);
        } else {
          ins.run(p.id, i, cue.word_start, cue.word_end, cue.text, cue.start_ms, cue.end_ms);
        }
      });
      bumpSubVersion(db, p.id);
    });
    tx();
    const fresh = loadProject(db, p.id);
    res.json({ sub_version: fresh.sub_version, subtitles: fresh.subtitles });
  });

  // ---------- 单条字幕编辑 / 锁定（行级版本号） ----------

  app.patch('/api/projects/:id/subtitles/:sid', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const sid = Number(req.params.sid);
    const row = db.prepare('SELECT * FROM subtitles WHERE id = ? AND project_id = ?').get(sid, p.id);
    if (!row) return res.status(404).json({ error: `字幕 ${req.params.sid} 不存在` });

    const { version, text, start_ms, end_ms, locked } = req.body || {};
    if (version !== row.version) {
      return res.status(409).json({
        error: `字幕版本过期：你基于 v${version} 修改，但当前已是 v${row.version}`,
        current: row,
      });
    }

    const newText = text !== undefined ? String(text) : row.text;
    const newStart = start_ms !== undefined ? start_ms : row.start_ms;
    const newEnd = end_ms !== undefined ? end_ms : row.end_ms;
    const newLocked = locked !== undefined ? (locked ? 1 : 0) : row.locked;

    if (newText.trim() === '') {
      return res.status(422).json({ error: '字幕文本不能为空', errors: ['字幕文本不能为空'] });
    }
    if (start_ms !== undefined || end_ms !== undefined) {
      const neighbors = {
        prev: db.prepare(
          'SELECT start_ms, end_ms FROM subtitles WHERE project_id = ? AND idx < ? ORDER BY idx DESC LIMIT 1'
        ).get(p.id, row.idx) || null,
        next: db.prepare(
          'SELECT start_ms, end_ms FROM subtitles WHERE project_id = ? AND idx > ? ORDER BY idx LIMIT 1'
        ).get(p.id, row.idx) || null,
      };
      const errors = validateSubtitleEdit(
        { start_ms: newStart, end_ms: newEnd },
        { word_start: row.word_start, word_end: row.word_end },
        p.words, p.cuts, neighbors
      );
      if (errors.length > 0) {
        return res.status(422).json({ error: '字幕时间校验失败', errors });
      }
    }

    const tx = db.transaction(() => {
      db.prepare(
        `UPDATE subtitles SET text = ?, start_ms = ?, end_ms = ?, locked = ?, version = version + 1
         WHERE id = ?`
      ).run(newText, newStart, newEnd, newLocked, sid);
      bumpSubVersion(db, p.id);
    });
    tx();
    const fresh = loadProject(db, p.id);
    res.json({ sub_version: fresh.sub_version, subtitle: fresh.subtitles.find((s) => s.id === sid) });
  });

  // ---------- 导出（确认后生成不可变快照） ----------

  app.post('/api/projects/:id/exports', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    // 可选的乐观锁：携带 sub_version 时校验，防止导出与界面不一致的内容
    const { sub_version } = req.body || {};
    if (sub_version !== undefined && sub_version !== p.sub_version) {
      return res.status(409).json({
        error: `字幕集已被修改（当前版本 ${p.sub_version}），请刷新后再确认导出`,
        current: { sub_version: p.sub_version, subtitles: p.subtitles },
      });
    }
    if (p.subtitles.length === 0) {
      return res.status(422).json({ error: '没有字幕可导出，请先排版', conflicts: [] });
    }
    if (p.words.length === 0) {
      return res.status(422).json({ error: '尚未导入逐词转写', conflicts: [] });
    }
    const structural = validateStructure(p.subtitles, p.words, p.cuts);
    const ruleProblems = validateRules(p.subtitles, p.rules);
    const conflicts = [...structural, ...ruleProblems];
    if (conflicts.length > 0) {
      return res.status(422).json({
        error: `字幕未通过导出校验（${conflicts.length} 处问题），未生成文件`,
        conflicts,
      });
    }
    const content = toWebVtt(p.subtitles);
    const tx = db.transaction(() => {
      const next = (db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM exports WHERE project_id = ?')
        .get(p.id).v) + 1;
      db.prepare(
        'INSERT INTO exports (project_id, version, content, cue_count) VALUES (?, ?, ?, ?)'
      ).run(p.id, next, content, p.subtitles.length);
      return next;
    });
    const version = tx();
    res.status(201).json({
      version,
      cue_count: p.subtitles.length,
      download_url: `/api/projects/${p.id}/exports/${version}`,
      content,
    });
  });

  app.get('/api/projects/:id/exports', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    res.json(db.prepare(
      'SELECT version, cue_count, created_at FROM exports WHERE project_id = ? ORDER BY version DESC'
    ).all(p.id));
  });

  app.get('/api/projects/:id/exports/:version', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const row = db.prepare(
      'SELECT * FROM exports WHERE project_id = ? AND version = ?'
    ).get(p.id, Number(req.params.version));
    if (!row) return res.status(404).json({ error: `导出版本 ${req.params.version} 不存在` });
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="project-${p.id}-v${row.version}.vtt"`
    );
    res.send(row.content);
  });

  // ---------- 校对者批量修订提议（提交 → 预览 → 采纳） ----------
  //
  // 一组针对同一项目“未锁定字幕”的待采纳修订：
  //   提交只保存原值快照与当时规则版本，绝不动正式字幕；
  //   预览并列原值/当前值/建议值并按整版候选核对冲突；
  //   采纳时在同一事务中再次核对（存在、未锁定、行版本、规则版本、整版校验），
  //   全部通过才写入全部修订并推进 sub_version；任一不过则整组不生效。

  function getRevision(req, res) {
    const p = getProject(req, res);
    if (!p) return null;
    const rid = Number(req.params.rid);
    const revision = loadRevision(db, p.id, rid);
    if (!revision) {
      res.status(404).json({ error: `修订提议 ${req.params.rid} 不存在` });
      return null;
    }
    return { p, revision };
  }

  /** 提交修订提议 */
  app.post('/api/projects/:id/revisions', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const body = req.body || {};
    const note = body.note !== undefined ? String(body.note) : '';
    // 1. 形状校验：空组 / 重复 ID / 空文本 / 非法时间 / 字段类型 → 400
    const parsed = parseRevisionItems(body);
    if (!parsed.ok) return res.status(400).json({ error: '修订请求非法，未保存提议', errors: parsed.errors });

    // 2. 状态校验（逐项）：目标须仍存在且未锁定；单侧时间与原值合并后仍须 start < end
    const cueById = new Map(p.subtitles.map((s) => [s.id, s]));
    const stateErrors = [];
    for (const it of parsed.items) {
      const cue = cueById.get(it.subtitle_id);
      if (!cue) {
        stateErrors.push(`字幕 ${it.subtitle_id} 不存在，无法提议修订`);
        continue;
      }
      if (cue.locked === 1) {
        stateErrors.push(`字幕 ${it.subtitle_id}（"${cue.text}"）已锁定，锁定字幕不能提交修订提议`);
        continue;
      }
      const s = it.start_ms !== null ? it.start_ms : cue.start_ms;
      const e = it.end_ms !== null ? it.end_ms : cue.end_ms;
      if (s >= e) {
        stateErrors.push(`字幕 ${it.subtitle_id} 合并单侧时间后为 [${s}, ${e}]，开始必须早于结束`);
      }
    }
    if (stateErrors.length > 0) {
      return res.status(422).json({ error: '修订请求未通过目标状态校验，未保存提议', errors: stateErrors });
    }

    const tx = db.transaction(() => {
      const info = db.prepare(
        `INSERT INTO revisions (project_id, note, rules_version_snapshot, sub_version_snapshot)
         VALUES (?, ?, ?, ?)`
      ).run(p.id, note, p.rules.version, p.sub_version);
      const rid = info.lastInsertRowid;
      const ins = db.prepare(
        `INSERT INTO revision_items
           (revision_id, ord, subtitle_id, cue_version, orig_text, orig_start_ms, orig_end_ms,
            proposed_text, start_ms, end_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      parsed.items.forEach((it, i) => {
        const cue = cueById.get(it.subtitle_id);
        ins.run(
          rid, i, it.subtitle_id, it.cue_version,
          cue.text, cue.start_ms, cue.end_ms,
          it.text, it.start_ms, it.end_ms
        );
      });
      return rid;
    });
    const rid = tx();
    res.status(201).json(loadRevision(db, p.id, rid));
  });

  /** 提议历史列表 */
  app.get('/api/projects/:id/revisions', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    res.json(listRevisions(db, p.id));
  });

  /** 单个提议（逐项并列原值与建议值） */
  app.get('/api/projects/:id/revisions/:rid', (req, res) => {
    const got = getRevision(req, res);
    if (got) res.json(got.revision);
  });

  /**
   * 预览核对：按“整组应用后的候选整版”检查
   * 词区间、词时段、切点、相邻字幕、字数/时长/字速，以及行/规则版本与锁定状态。
   * 只读，不改任何数据。
   */
  app.post('/api/projects/:id/revisions/:rid/preview', (req, res) => {
    const got = getRevision(req, res);
    if (!got) return;
    const { revision } = got;
    if (revision.status === 'accepted') {
      return res.json({
        revision,
        evaluation: {
          ok: false, rule_version_stale: false, items: [], conflicts: [],
          already_accepted: true, accepted_sub_version: revision.accepted_sub_version,
        },
      });
    }
    const evaluation = evaluateRevision({ project: got.p, revision });
    res.json({ revision, evaluation });
  });

  /**
   * 采纳：同一事务内再次核对目标仍存在且未锁定、各行版本、规则版本与整版校验；
   * 通过后写入全部修订、推进每行版本与字幕集版本、标记提议已采纳。
   * 任一过期或违规则整组不生效，返回当前值与原因。
   */
  app.post('/api/projects/:id/revisions/:rid/accept', (req, res) => {
    const got = getRevision(req, res);
    if (!got) return;
    const { p, revision } = got;
    if (revision.status === 'accepted') {
      return res.status(409).json({
        error: `修订提议 ${revision.id} 已采纳（字幕集推进到 v${revision.accepted_sub_version}），重复提交不得再改字幕`,
        already_accepted: true,
        accepted_sub_version: revision.accepted_sub_version,
        current: { sub_version: p.sub_version, subtitles: p.subtitles },
      });
    }

    class AcceptReject extends Error {
      constructor(statusCode, payload) {
        super(payload.error || '采纳被拒绝');
        this.statusCode = statusCode;
        this.payload = payload;
      }
    }

    const tx = db.transaction(() => {
      // 事务内读取权威当前状态
      const fresh = loadProject(db, p.id);
      const evaluation = evaluateRevision({ project: fresh, revision });

      if (!evaluation.ok) {
        const staleTypes = new Set([
          'cue_version_stale', 'subtitle_missing', 'subtitle_locked', 'rules_version_stale',
        ]);
        const isStale =
          evaluation.rule_version_stale ||
          evaluation.items.some(
            (r) => r.state !== 'ok' || r.conflicts.some((c) => staleTypes.has(c.type))
          );
        const items = evaluation.items
          .filter((r) => r.state !== 'ok' || r.conflicts.length > 0)
          .map((r) => ({
            ord: r.ord,
            subtitle_id: r.subtitle_id,
            state: r.state,
            cue_version: r.cue_version,
            current: r.cue,
            proposed: r.proposed,
            reasons: r.conflicts,
          }));
        throw new AcceptReject(isStale ? 409 : 422, {
          error: isStale
            ? `修订提议 ${revision.id} 存在过期/失效项，整组未生效，请刷新后重新提议`
            : `修订提议 ${revision.id} 共 ${items.length} 项核对未通过（当前规则 v${fresh.rules.version}），整组未生效`,
          rules_version: fresh.rules.version,
          current: { sub_version: fresh.sub_version, subtitles: fresh.subtitles },
          items,
          conflicts: evaluation.conflicts,
        });
      }

      // 全部通过：写入全部修订（WHERE version 兜底防并发）、行版本 +1、推进字幕集版本
      const upd = db.prepare(
        `UPDATE subtitles
           SET text = ?, start_ms = ?, end_ms = ?, version = version + 1
         WHERE id = ? AND project_id = ? AND locked = 0 AND version = ?`
      );
      for (const it of revision.items) {
        const cue = fresh.subtitles.find((s) => s.id === it.subtitle_id);
        const s = it.proposed.has_start_ms ? it.proposed.start_ms : cue.start_ms;
        const e = it.proposed.has_end_ms ? it.proposed.end_ms : cue.end_ms;
        const info = upd.run(it.proposed.text, s, e, it.subtitle_id, fresh.id, it.cue_version);
        if (info.changes !== 1) {
          throw new AcceptReject(409, {
            error: `字幕 ${it.subtitle_id} 在采纳瞬间发生变化，请刷新后重试`,
            current: { sub_version: fresh.sub_version },
          });
        }
      }

      // 写入后整版自检（结构 + 当前规则，含锁定行），失败即回滚
      const updated = loadProject(db, fresh.id);
      const finalProblems = [
        ...validateStructure(updated.subtitles, updated.words, updated.cuts),
        ...validateRules(updated.subtitles, updated.rules),
      ];
      if (finalProblems.length > 0) {
        throw new AcceptReject(422, {
          error: `采纳后整版校验发现 ${finalProblems.length} 处问题，整组已回滚`,
          conflicts: finalProblems,
        });
      }
      const subVersion = bumpSubVersion(db, fresh.id);
      db.prepare(
        `UPDATE revisions SET status = 'accepted', accepted_at = datetime('now'),
           accepted_sub_version = ? WHERE id = ?`
      ).run(subVersion, revision.id);
      return subVersion;
    });

    try {
      const subVersion = tx();
      const after = loadProject(db, p.id);
      const accepted = after.subtitles.filter((s) =>
        revision.items.some((it) => it.subtitle_id === s.id)
      );
      res.json({
        revision_id: revision.id,
        status: 'accepted',
        sub_version: subVersion,
        applied: revision.items.length,
        subtitles: accepted,
      });
    } catch (err) {
      if (err instanceof AcceptReject) {
        return res.status(err.statusCode).json(err.payload);
      }
      throw err;
    }
  });

  return app;
}

module.exports = { createApp };
