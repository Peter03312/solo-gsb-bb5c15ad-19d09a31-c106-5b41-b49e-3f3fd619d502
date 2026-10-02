'use strict';

/**
 * 修订提议（校对流程）的纯逻辑：提交校验、假设字幕集构建、预览核对。
 * 不依赖数据库，数据库读写都在 routes 层。
 *
 * 生命周期：
 *   提交（pending）→ 预览核对 → 采纳（adopted，整组写入并推进字幕集版本）
 * 提交时不改正式字幕；已采纳的提议重复采纳不再改动任何字幕（幂等）。
 */

const { validateStructure, validateRules } = require('./layout');

const MAX_ITEMS = 5000;

function isInt(v) {
  return typeof v === 'number' && Number.isInteger(v);
}

/**
 * 校验修订提议请求体的"形状"（不依赖数据库）：
 *  - items 必须是非空数组（空组拒绝）；
 *  - 同一组内 subtitle_id 不得重复（重复ID拒绝）；
 *  - 每项必须给出字幕ID、读取时行版本（正整数）、非空替代文本（空文本拒绝）；
 *  - 起止毫秒可选，但若给出必须是非负整数（非法时间拒绝），两者都给定时开始必须早于结束。
 * 返回 { ok, errors, note, items }；items 为规范化后的数组（时间缺省为 null）。
 */
function validateProposalPayload(body) {
  const errors = [];
  const b = body || {};
  if (b.note !== undefined && typeof b.note !== 'string') {
    errors.push('note（整组说明）必须是字符串');
  }
  const raw = b.items;
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.push('items 必须是非空数组（空组不予受理）');
    return { ok: false, errors };
  }
  if (raw.length > MAX_ITEMS) {
    errors.push(`单组提议最多 ${MAX_ITEMS} 条，当前 ${raw.length} 条`);
    return { ok: false, errors };
  }

  const seen = new Map(); // subtitle_id -> 首次出现的下标
  const items = [];
  for (let i = 0; i < raw.length; i++) {
    const it = raw[i] || {};
    const label = `第 ${i + 1} 项`;
    let bad = false;
    if (!isInt(it.subtitle_id)) {
      errors.push(`${label}：subtitle_id（字幕ID）必须是整数`);
      bad = true;
    } else if (seen.has(it.subtitle_id)) {
      errors.push(
        `${label}：字幕 #${it.subtitle_id} 与第 ${seen.get(it.subtitle_id) + 1} 项重复，` +
        `同一组内同一字幕只能修订一次`
      );
      bad = true;
    }
    if (!isInt(it.version) || it.version < 1) {
      errors.push(`${label}：version（读取时行版本）必须是正整数`);
      bad = true;
    }
    if (typeof it.text !== 'string' || it.text.trim() === '') {
      errors.push(`${label}：text（替代文本）必须是非空字符串`);
      bad = true;
    }
    let start = null;
    let end = null;
    if (it.start_ms !== undefined && it.start_ms !== null) {
      if (!isInt(it.start_ms) || it.start_ms < 0) {
        errors.push(`${label}：start_ms 必须是非负整数毫秒`);
        bad = true;
      } else {
        start = it.start_ms;
      }
    }
    if (it.end_ms !== undefined && it.end_ms !== null) {
      if (!isInt(it.end_ms) || it.end_ms < 0) {
        errors.push(`${label}：end_ms 必须是非负整数毫秒`);
        bad = true;
      } else {
        end = it.end_ms;
      }
    }
    if (start !== null && end !== null && start >= end) {
      errors.push(`${label}：时间无效：[${start}, ${end}]，开始必须早于结束`);
      bad = true;
    }
    if (it.note !== undefined && typeof it.note !== 'string') {
      errors.push(`${label}：note（逐项说明）必须是字符串`);
      bad = true;
    }
    if (bad) continue;
    seen.set(it.subtitle_id, i);
    items.push({
      subtitle_id: it.subtitle_id,
      base_version: it.version,
      text: it.text,
      start_ms: start,
      end_ms: end,
      note: typeof it.note === 'string' ? it.note : '',
    });
  }
  return { ok: errors.length === 0, errors, note: typeof b.note === 'string' ? b.note : '', items };
}

/**
 * 把一组修订项套用到当前字幕集，得到假设字幕集（未涉及的行原样保留）。
 * items 为 loadProposal 返回的形状：{ subtitle_id, suggested: { text, start_ms, end_ms } }，
 * 时间字段为 null 时沿用当前值。
 */
function buildHypothetical(subtitles, items) {
  const byId = new Map(items.map((it) => [it.subtitle_id, it]));
  return subtitles.map((s) => {
    const it = byId.get(s.id);
    if (!it) return s;
    return {
      ...s,
      text: it.suggested.text,
      start_ms: it.suggested.start_ms ?? s.start_ms,
      end_ms: it.suggested.end_ms ?? s.end_ms,
    };
  });
}

/**
 * 预览一组提议：逐项并列 原值（提交时快照）/ 当前值 / 建议值，
 * 并按当前词区间、词时段、切点、相邻字幕及字数/时长/字速规则核对整组候选。
 *
 * proposal: loadProposal 的完整明细；project: loadProject 的完整载荷。
 * 返回 { proposal, current, items, conflicts, adoptable }：
 *  - conflicts 每项 { type, subtitle_id, word_start, word_end, message }；
 *  - 已采纳的提议不再做新鲜度核对（版本号是采纳时自己推进的），adoptable 恒为 false。
 */
function computePreview(proposal, project) {
  const subById = new Map(project.subtitles.map((s) => [s.id, s]));
  const conflicts = [];
  const currentRulesVersion = project.rules ? project.rules.version : null;

  if (proposal.status !== 'adopted') {
    // 1. 规则版本：提议保存提交时的规则版本，之后规则被改过则整组过期
    if (currentRulesVersion !== proposal.rules_version) {
      conflicts.push({
        type: 'rules_version_stale', subtitle_id: null, word_start: null, word_end: null,
        message: `排版规则已更新：提议基于规则 v${proposal.rules_version}，当前为 v${currentRulesVersion}`,
      });
    }
    // 2. 逐项新鲜度：目标仍存在、未锁定、行版本未变
    for (const it of proposal.items) {
      const cur = subById.get(it.subtitle_id) || null;
      if (!cur) {
        conflicts.push({
          type: 'target_missing', subtitle_id: it.subtitle_id, word_start: null, word_end: null,
          message: `目标字幕 #${it.subtitle_id} 已不存在（可能被重排或重新导入删除）`,
        });
        continue;
      }
      if (cur.locked === 1) {
        conflicts.push({
          type: 'target_locked', subtitle_id: it.subtitle_id,
          word_start: cur.word_start, word_end: cur.word_end,
          message: `目标字幕 #${it.subtitle_id} 已锁定，修订只能针对未锁定字幕`,
        });
      }
      if (cur.version !== it.orig_version) {
        conflicts.push({
          type: 'version_stale', subtitle_id: it.subtitle_id,
          word_start: cur.word_start, word_end: cur.word_end,
          message:
            `目标字幕 #${it.subtitle_id} 在提议后被修改：` +
            `提议基于行版本 v${it.orig_version}，当前 v${cur.version}`,
        });
      }
    }
    // 3. 整组套用后校验整版：词区间覆盖、词时段不被缩短、不跨切点、
    //    与相邻字幕不重叠，以及字数/时长/字速规则（含未涉及的字幕）
    if (project.subtitles.length > 0) {
      const hypo = buildHypothetical(project.subtitles, proposal.items);
      const rangeToId = new Map(project.subtitles.map((s) => [`${s.word_start}:${s.word_end}`, s.id]));
      const problems = [
        ...validateStructure(hypo, project.words, project.cuts),
        ...(project.rules ? validateRules(hypo, project.rules) : []),
      ];
      for (const prob of problems) {
        conflicts.push({
          ...prob,
          subtitle_id: rangeToId.get(`${prob.word_start}:${prob.word_end}`) ?? null,
        });
      }
    }
  }

  const items = proposal.items.map((it) => {
    const cur = subById.get(it.subtitle_id) || null;
    return {
      subtitle_id: it.subtitle_id,
      note: it.note,
      base_version: it.base_version,
      orig_version: it.orig_version,
      stale_at_submit: it.base_version !== it.orig_version, // 提交时读取版本已落后于快照
      original: it.original,
      current: cur
        ? { version: cur.version, text: cur.text, start_ms: cur.start_ms, end_ms: cur.end_ms, locked: cur.locked }
        : null,
      suggested: {
        text: it.suggested.text,
        start_ms: it.suggested.start_ms ?? (cur ? cur.start_ms : it.original.start_ms),
        end_ms: it.suggested.end_ms ?? (cur ? cur.end_ms : it.original.end_ms),
      },
      conflicts: conflicts.filter((c) => c.subtitle_id === it.subtitle_id).map((c) => c.message),
    };
  });

  return {
    proposal: {
      id: proposal.id,
      status: proposal.status,
      note: proposal.note,
      rules_version: proposal.rules_version,
      sub_version: proposal.sub_version,
      created_at: proposal.created_at,
      adopted_at: proposal.adopted_at,
    },
    current: { rules_version: currentRulesVersion, sub_version: project.sub_version },
    items,
    conflicts,
    adoptable: proposal.status !== 'adopted' && conflicts.length === 0,
  };
}

module.exports = { validateProposalPayload, buildHypothetical, computePreview, MAX_ITEMS };
