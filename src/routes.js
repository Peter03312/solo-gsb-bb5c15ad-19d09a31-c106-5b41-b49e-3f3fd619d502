'use strict';

const express = require('express');
const { loadProject, loadProposal, listProposals, bumpSubVersion, DEFAULT_RULES } = require('./db');
const { computeLayout, validateStructure, validateRules } = require('./layout');
const { validateWords, validateCuts, validateRules: validateRulesInput, validateSubtitleEdit } = require('./validate');
const { validateProposalPayload, buildHypothetical, computePreview } = require('./proposals');
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

  const getProposal = (req, res, projectId) => {
    const detail = loadProposal(db, projectId, Number(req.params.pid));
    if (!detail) {
      res.status(404).json({ error: `提议 ${req.params.pid} 不存在` });
      return null;
    }
    return detail;
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

  // ---------- 修订提议（校对）：提交 / 历史 / 明细 / 预览 / 采纳 ----------

  /**
   * 提交一组待采纳修订。逐项：字幕ID、读取时行版本、替代文本、可选起止毫秒、可选说明。
   * 空组 / 重复ID / 非法时间 / 空文本 / 目标不存在或已锁定 → 422，整组不保存。
   * 保存时快照各项原值与当时规则版本；不改动任何正式字幕。
   */
  app.post('/api/projects/:id/proposals', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const v = validateProposalPayload(req.body);
    if (!v.ok) {
      return res.status(422).json({ error: '修订提议校验失败，未保存', errors: v.errors });
    }
    // 目标字幕必须属于本项目、存在且未锁定；有效时间（缺省取当前值）必须开始早于结束
    const errors = [];
    const subById = new Map(p.subtitles.map((s) => [s.id, s]));
    const rows = [];
    v.items.forEach((it, i) => {
      const label = `第 ${i + 1} 项（字幕 #${it.subtitle_id}）`;
      const cur = subById.get(it.subtitle_id);
      if (!cur) {
        errors.push(`${label} 在当前项目中不存在（可能已被重排或重新导入删除）`);
        return;
      }
      if (cur.locked === 1) {
        errors.push(`${label} 已锁定，修订只能针对未锁定字幕`);
        return;
      }
      const effStart = it.start_ms ?? cur.start_ms;
      const effEnd = it.end_ms ?? cur.end_ms;
      if (effStart >= effEnd) {
        errors.push(`${label} 时间无效：[${effStart}, ${effEnd}]，开始必须早于结束`);
        return;
      }
      rows.push({ it, cur });
    });
    if (errors.length > 0) {
      return res.status(422).json({ error: '修订提议校验失败，未保存', errors });
    }

    const tx = db.transaction(() => {
      const info = db.prepare(
        'INSERT INTO proposals (project_id, note, rules_version, sub_version) VALUES (?, ?, ?, ?)'
      ).run(p.id, v.note, p.rules.version, p.sub_version);
      const pid = info.lastInsertRowid;
      const ins = db.prepare(
        `INSERT INTO proposal_items
         (proposal_id, idx, subtitle_id, base_version, orig_version,
          orig_text, orig_start_ms, orig_end_ms, new_text, new_start_ms, new_end_ms, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      rows.forEach(({ it, cur }, i) => {
        ins.run(
          pid, i, it.subtitle_id, it.base_version, cur.version,
          cur.text, cur.start_ms, cur.end_ms,
          it.text, it.start_ms, it.end_ms, it.note
        );
      });
      return pid;
    });
    const pid = tx();
    res.status(201).json(loadProposal(db, p.id, pid));
  });

  app.get('/api/projects/:id/proposals', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    res.json(listProposals(db, p.id));
  });

  app.get('/api/projects/:id/proposals/:pid', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const detail = getProposal(req, res, p.id);
    if (detail) res.json(detail);
  });

  /** 预览：并列原值/当前值/建议值，按当前数据核对整组候选并列出每处冲突；不产生任何写入 */
  app.get('/api/projects/:id/proposals/:pid/preview', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const detail = getProposal(req, res, p.id);
    if (!detail) return;
    res.json(computePreview(detail, p));
  });

  /**
   * 采纳：事务内再次核对目标存在且未锁定、各行版本与规则版本，
   * 校验整版后写入全部修订并推进字幕集版本；任一过期或违规则整组不生效。
   * 已采纳的提议重复提交是幂等空操作：不再改动任何字幕。
   */
  app.post('/api/projects/:id/proposals/:pid/adopt', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const detail = getProposal(req, res, p.id);
    if (!detail) return;

    if (detail.status === 'adopted') {
      return res.json({
        status: 'adopted',
        already_adopted: true,
        proposal_id: detail.id,
        adopted_at: detail.adopted_at,
        sub_version: p.sub_version,
        message: '该提议已采纳过，本次未改动任何字幕',
      });
    }

    const tx = db.transaction(() => {
      // 事务内重新读取，保证"核对 → 校验 → 写入"原子完成
      const fresh = loadProject(db, p.id);
      const subById = new Map(fresh.subtitles.map((s) => [s.id, s]));
      const reasons = [];
      for (const it of detail.items) {
        const cur = subById.get(it.subtitle_id);
        if (!cur) {
          reasons.push(`字幕 #${it.subtitle_id} 已不存在（可能被重排或重新导入删除）`);
        } else if (cur.locked === 1) {
          reasons.push(`字幕 #${it.subtitle_id} 已锁定，修订只能针对未锁定字幕`);
        } else if (cur.version !== it.orig_version) {
          reasons.push(
            `字幕 #${it.subtitle_id} 已被修改：提议基于行版本 v${it.orig_version}，当前 v${cur.version}` +
            `（当前文本："${cur.text}" [${cur.start_ms}, ${cur.end_ms}]）`
          );
        }
      }
      if (!fresh.rules || fresh.rules.version !== detail.rules_version) {
        reasons.push(
          `排版规则已更新：提议基于规则 v${detail.rules_version}，` +
          `当前 v${fresh.rules ? fresh.rules.version : '无'}`
        );
      }
      if (reasons.length > 0) return { stale: true, reasons, current: fresh };

      // 套用整组修订后校验整版（结构 + 规则，含未涉及的字幕）
      const hypo = buildHypothetical(fresh.subtitles, detail.items);
      const conflicts = [
        ...validateStructure(hypo, fresh.words, fresh.cuts),
        ...validateRules(hypo, fresh.rules),
      ];
      if (conflicts.length > 0) return { invalid: true, conflicts };

      // 同一事务：写入全部修订 + 推进字幕集版本 + 标记提议已采纳
      const hypoById = new Map(hypo.map((h) => [h.id, h]));
      const upd = db.prepare(
        'UPDATE subtitles SET text = ?, start_ms = ?, end_ms = ?, version = version + 1 WHERE id = ?'
      );
      for (const it of detail.items) {
        const h = hypoById.get(it.subtitle_id);
        upd.run(h.text, h.start_ms, h.end_ms, it.subtitle_id);
      }
      const newSubVersion = bumpSubVersion(db, p.id);
      db.prepare(
        `UPDATE proposals SET status = 'adopted', adopted_at = datetime('now'),
         applied_sub_version = ? WHERE id = ?`
      ).run(newSubVersion, detail.id);
      return { ok: true, sub_version: newSubVersion };
    });

    const result = tx();
    if (result.stale) {
      return res.status(409).json({
        error: `提议已过期（${result.reasons.length} 处），整组未生效`,
        reasons: result.reasons,
        current: {
          sub_version: result.current.sub_version,
          rules: result.current.rules,
          subtitles: result.current.subtitles,
        },
      });
    }
    if (result.invalid) {
      return res.status(422).json({
        error: `提议未通过整版校验（${result.conflicts.length} 处问题），整组未生效`,
        conflicts: result.conflicts,
      });
    }
    const fresh = loadProject(db, p.id);
    res.json({
      status: 'adopted',
      proposal_id: detail.id,
      sub_version: fresh.sub_version,
      subtitles: fresh.subtitles,
    });
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

  return app;
}

module.exports = { createApp };
