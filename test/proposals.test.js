'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { initDb } = require('../src/db');
const { createApp } = require('../src/routes');

let server;
let base;

before(async () => {
  const db = initDb(':memory:');
  const app = createApp(db);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function api(path, method = 'GET', body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

const GOOD_WORDS = [
  { text: '你好', start_ms: 0, end_ms: 500 },
  { text: '世界', start_ms: 550, end_ms: 1000 },
  { text: '欢迎', start_ms: 1500, end_ms: 2000 },
  { text: '光临', start_ms: 2050, end_ms: 2500 },
];

/** 建项目并排版，返回最新项目载荷与字幕行（cuts=[1200] → 两条字幕） */
async function layoutProject(overrides = {}) {
  const created = await api('/api/projects', 'POST', {
    name: '提议测试', words: GOOD_WORDS, cuts: [1200], ...overrides,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const p = created.body;
  const layout = await api(`/api/projects/${p.id}/layout`, 'POST', { sub_version: p.sub_version });
  assert.equal(layout.status, 200, JSON.stringify(layout.body));
  const fresh = await api(`/api/projects/${p.id}`);
  return { project: fresh.body, cues: layout.body.subtitles };
}

// ---------- 提交校验 ----------

test('提议：空组被拒绝（422）', async () => {
  const { project } = await layoutProject();
  for (const body of [{}, { items: [] }, { items: 'x' }]) {
    const r = await api(`/api/projects/${project.id}/proposals`, 'POST', body);
    assert.equal(r.status, 422, JSON.stringify(body));
    assert.ok(r.body.errors.some((e) => e.includes('非空数组')));
  }
});

test('提议：重复字幕ID被拒绝', async () => {
  const { project, cues } = await layoutProject();
  const r = await api(`/api/projects/${project.id}/proposals`, 'POST', {
    items: [
      { subtitle_id: cues[0].id, version: 1, text: '甲' },
      { subtitle_id: cues[0].id, version: 1, text: '乙' },
    ],
  });
  assert.equal(r.status, 422);
  assert.ok(r.body.errors.some((e) => e.includes('重复')));
});

test('提议：空文本与非法时间被拒绝', async () => {
  const { project, cues } = await layoutProject();
  const emptyText = await api(`/api/projects/${project.id}/proposals`, 'POST', {
    items: [{ subtitle_id: cues[0].id, version: 1, text: '   ' }],
  });
  assert.equal(emptyText.status, 422);
  assert.ok(emptyText.body.errors.some((e) => e.includes('非空字符串')));

  const badOrder = await api(`/api/projects/${project.id}/proposals`, 'POST', {
    items: [{ subtitle_id: cues[0].id, version: 1, text: '好', start_ms: 900, end_ms: 100 }],
  });
  assert.equal(badOrder.status, 422);
  assert.ok(badOrder.body.errors.some((e) => e.includes('开始必须早于结束')));

  const negative = await api(`/api/projects/${project.id}/proposals`, 'POST', {
    items: [{ subtitle_id: cues[0].id, version: 1, text: '好', start_ms: -5 }],
  });
  assert.equal(negative.status, 422);

  const fractional = await api(`/api/projects/${project.id}/proposals`, 'POST', {
    items: [{ subtitle_id: cues[0].id, version: 1, text: '好', end_ms: 100.5 }],
  });
  assert.equal(fractional.status, 422);

  // 只给开始、但晚于当前结束 → 有效区间非法
  const effBad = await api(`/api/projects/${project.id}/proposals`, 'POST', {
    items: [{ subtitle_id: cues[0].id, version: 1, text: '好', start_ms: 5000 }],
  });
  assert.equal(effBad.status, 422);
  assert.ok(effBad.body.errors.some((e) => e.includes('开始必须早于结束')));
});

test('提议：缺少读取时行版本 / 目标不存在 / 目标已锁定被拒绝', async () => {
  const { project, cues } = await layoutProject();
  const noVersion = await api(`/api/projects/${project.id}/proposals`, 'POST', {
    items: [{ subtitle_id: cues[0].id, text: '好' }],
  });
  assert.equal(noVersion.status, 422);
  assert.ok(noVersion.body.errors.some((e) => e.includes('行版本')));

  const missing = await api(`/api/projects/${project.id}/proposals`, 'POST', {
    items: [{ subtitle_id: 99999, version: 1, text: '好' }],
  });
  assert.equal(missing.status, 422);
  assert.ok(missing.body.errors.some((e) => e.includes('不存在')));

  // 锁定第二条后，针对它的提议被拒绝
  const lock = await api(`/api/projects/${project.id}/subtitles/${cues[1].id}`, 'PATCH', {
    version: cues[1].version, locked: true,
  });
  assert.equal(lock.status, 200);
  const locked = await api(`/api/projects/${project.id}/proposals`, 'POST', {
    items: [{ subtitle_id: cues[1].id, version: 2, text: '好' }],
  });
  assert.equal(locked.status, 422);
  assert.ok(locked.body.errors.some((e) => e.includes('已锁定')));
});

// ---------- 提交成功：快照原值与规则版本，不改正式字幕 ----------

test('提议：提交保存原值快照与当时规则版本，且不改动正式字幕', async () => {
  const { project, cues } = await layoutProject();
  const before = await api(`/api/projects/${project.id}`);
  const r = await api(`/api/projects/${project.id}/proposals`, 'POST', {
    note: '第一轮校对',
    items: [
      { subtitle_id: cues[0].id, version: cues[0].version, text: '你好呀世界', end_ms: 1100, note: '语序' },
      { subtitle_id: cues[1].id, version: cues[1].version, text: '欢迎光临本店' },
    ],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.status, 'pending');
  assert.equal(r.body.note, '第一轮校对');
  assert.equal(r.body.rules_version, project.rules.version);
  assert.equal(r.body.items.length, 2);
  // 原值快照
  assert.equal(r.body.items[0].original.text, '你好世界');
  assert.equal(r.body.items[0].original.start_ms, 0);
  assert.equal(r.body.items[0].original.end_ms, 1000);
  assert.equal(r.body.items[0].orig_version, cues[0].version);
  // 建议值：未给时间的项为 null（不修改）
  assert.equal(r.body.items[0].suggested.text, '你好呀世界');
  assert.equal(r.body.items[0].suggested.end_ms, 1100);
  assert.equal(r.body.items[1].suggested.start_ms, null);
  // 正式字幕与字幕集版本不变
  const after = await api(`/api/projects/${project.id}`);
  assert.equal(after.body.sub_version, before.body.sub_version);
  assert.deepEqual(after.body.subtitles, before.body.subtitles);
});

// ---------- 预览 ----------

test('预览：并列原值/当前值/建议值，无冲突时 adoptable', async () => {
  const { project, cues } = await layoutProject();
  const created = await api(`/api/projects/${project.id}/proposals`, 'POST', {
    items: [{ subtitle_id: cues[0].id, version: 1, text: '你好朋友', end_ms: 1100 }],
  });
  assert.equal(created.status, 201);
  const pv = await api(`/api/projects/${project.id}/proposals/${created.body.id}/preview`);
  assert.equal(pv.status, 200);
  assert.equal(pv.body.adoptable, true, JSON.stringify(pv.body.conflicts));
  assert.equal(pv.body.conflicts.length, 0);
  const item = pv.body.items[0];
  assert.equal(item.original.text, '你好世界');
  assert.equal(item.current.text, '你好世界');
  assert.equal(item.suggested.text, '你好朋友');
  assert.equal(item.suggested.start_ms, 0);    // 未给 → 沿用当前
  assert.equal(item.suggested.end_ms, 1100);
});

test('预览：按当前词时段/切点/相邻字幕/字数/字速规则指出每处冲突', async () => {
  const { project, cues } = await layoutProject();
  const created = await api(`/api/projects/${project.id}/proposals`, 'POST', {
    items: [
      { subtitle_id: cues[0].id, version: 1, text: '好', start_ms: 200 },          // 缩短词时段（首词 0 开始）
      { subtitle_id: cues[1].id, version: 1, text: '长'.repeat(31) },              // 超 max_chars=30
    ],
  });
  assert.equal(created.status, 201);
  const pv = await api(`/api/projects/${project.id}/proposals/${created.body.id}/preview`);
  assert.equal(pv.body.adoptable, false);
  const types = pv.body.conflicts.map((c) => c.type);
  assert.ok(types.includes('word_span_shortened'), JSON.stringify(pv.body.conflicts));
  assert.ok(types.includes('max_chars'), JSON.stringify(pv.body.conflicts));
  // 冲突能归属到具体字幕
  const bySub = Object.fromEntries(pv.body.conflicts.map((c) => [c.type, c.subtitle_id]));
  assert.equal(bySub.word_span_shortened, cues[0].id);
  assert.equal(bySub.max_chars, cues[1].id);

  // 跨切点与相邻重叠：把第一条结束延到 1600（跨切点 1200 且与第二条 [1500,2500] 重叠）
  const p2 = await api(`/api/projects/${project.id}/proposals`, 'POST', {
    items: [{ subtitle_id: cues[0].id, version: 1, text: '你好世界', end_ms: 1600 }],
  });
  const pv2 = await api(`/api/projects/${project.id}/proposals/${p2.body.id}/preview`);
  const types2 = pv2.body.conflicts.map((c) => c.type);
  assert.ok(types2.includes('cut_crossed'), JSON.stringify(pv2.body.conflicts));
  assert.ok(types2.includes('overlap'), JSON.stringify(pv2.body.conflicts));

  // 字速：25 字 / 1s = 25 字/秒 > 20（未超 30 字上限）
  const p3 = await api(`/api/projects/${project.id}/proposals`, 'POST', {
    items: [{ subtitle_id: cues[0].id, version: 1, text: '字'.repeat(25) }],
  });
  const pv3 = await api(`/api/projects/${project.id}/proposals/${p3.body.id}/preview`);
  assert.ok(pv3.body.conflicts.some((c) => c.type === 'max_cps'), JSON.stringify(pv3.body.conflicts));
});

test('预览：提议后被单条编辑 / 锁定 / 改规则 → 标出过期冲突', async () => {
  const { project, cues } = await layoutProject();
  const created = await api(`/api/projects/${project.id}/proposals`, 'POST', {
    items: [
      { subtitle_id: cues[0].id, version: 1, text: '改动甲' },
      { subtitle_id: cues[1].id, version: 1, text: '改动乙' },
    ],
  });
  assert.equal(created.status, 201);
  // 提议后：单条编辑第一条、锁定第二条、改规则
  await api(`/api/projects/${project.id}/subtitles/${cues[0].id}`, 'PATCH', { version: 1, text: '别人改的' });
  const after1 = await api(`/api/projects/${project.id}`);
  const cue2 = after1.body.subtitles.find((s) => s.id === cues[1].id);
  await api(`/api/projects/${project.id}/subtitles/${cue2.id}`, 'PATCH', { version: cue2.version, locked: true });
  const after2 = await api(`/api/projects/${project.id}`);
  await api(`/api/projects/${project.id}/rules`, 'PUT', {
    version: after2.body.rules.version, max_chars: 20, min_duration_ms: 800, max_cps: 20,
  });

  const pv = await api(`/api/projects/${project.id}/proposals/${created.body.id}/preview`);
  const types = pv.body.conflicts.map((c) => c.type);
  assert.ok(types.includes('version_stale'), JSON.stringify(pv.body.conflicts));
  assert.ok(types.includes('target_locked'), JSON.stringify(pv.body.conflicts));
  assert.ok(types.includes('rules_version_stale'), JSON.stringify(pv.body.conflicts));
  assert.equal(pv.body.adoptable, false);
  // 当前值随预览返回
  const item0 = pv.body.items.find((i) => i.subtitle_id === cues[0].id);
  assert.equal(item0.current.text, '别人改的');
});

// ---------- 采纳 ----------

test('采纳：整组生效，行版本与字幕集版本推进，提议状态可查', async () => {
  const { project, cues } = await layoutProject();
  const created = await api(`/api/projects/${project.id}/proposals`, 'POST', {
    note: '整组采纳',
    items: [
      { subtitle_id: cues[0].id, version: 1, text: '你好朋友', end_ms: 1100 },
      { subtitle_id: cues[1].id, version: 1, text: '欢迎光临本店' },
    ],
  });
  assert.equal(created.status, 201);
  const before = await api(`/api/projects/${project.id}`);

  const adopt = await api(`/api/projects/${project.id}/proposals/${created.body.id}/adopt`, 'POST');
  assert.equal(adopt.status, 200, JSON.stringify(adopt.body));
  assert.equal(adopt.body.status, 'adopted');
  assert.equal(adopt.body.sub_version, before.body.sub_version + 1);

  const s0 = adopt.body.subtitles.find((s) => s.id === cues[0].id);
  const s1 = adopt.body.subtitles.find((s) => s.id === cues[1].id);
  assert.equal(s0.text, '你好朋友');
  assert.equal(s0.end_ms, 1100);
  assert.equal(s0.start_ms, 0);          // 未给的字段保持原值
  assert.equal(s0.version, cues[0].version + 1);
  assert.equal(s1.text, '欢迎光临本店');
  assert.equal(s1.version, cues[1].version + 1);

  // 历史可查：列表 + 明细
  const list = await api(`/api/projects/${project.id}/proposals`);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].status, 'adopted');
  assert.equal(list.body[0].item_count, 2);
  assert.equal(list.body[0].applied_sub_version, adopt.body.sub_version);
  const detail = await api(`/api/projects/${project.id}/proposals/${created.body.id}`);
  assert.equal(detail.body.status, 'adopted');
  assert.ok(detail.body.adopted_at);
  assert.equal(detail.body.items[0].original.text, '你好世界');
  assert.equal(detail.body.items[0].suggested.text, '你好朋友');
});

test('采纳：行版本过期 → 409 返回当前值与原因，整组不生效', async () => {
  const { project, cues } = await layoutProject();
  const created = await api(`/api/projects/${project.id}/proposals`, 'POST', {
    items: [
      { subtitle_id: cues[0].id, version: 1, text: '改动甲' },
      { subtitle_id: cues[1].id, version: 1, text: '改动乙' },
    ],
  });
  assert.equal(created.status, 201);
  // 提议后有人单条编辑了第二条
  const edit = await api(`/api/projects/${project.id}/subtitles/${cues[1].id}`, 'PATCH', {
    version: 1, text: '别人先改了',
  });
  assert.equal(edit.status, 200);

  const adopt = await api(`/api/projects/${project.id}/proposals/${created.body.id}/adopt`, 'POST');
  assert.equal(adopt.status, 409);
  assert.ok(adopt.body.reasons.some((r) => r.includes(`#${cues[1].id}`) && r.includes('已被修改')));
  assert.equal(adopt.body.current.subtitles.find((s) => s.id === cues[1].id).text, '别人先改了');
  // 整组不生效：第一项目标保持原值，字幕集版本只被单条编辑推进过一次
  const after = await api(`/api/projects/${project.id}`);
  assert.equal(after.body.subtitles.find((s) => s.id === cues[0].id).text, '你好世界');
  assert.equal(after.body.sub_version, edit.body.sub_version);
  // 提议仍是 pending，可在新基础上重新提交
  const detail = await api(`/api/projects/${project.id}/proposals/${created.body.id}`);
  assert.equal(detail.body.status, 'pending');
});

test('采纳：规则版本过期 / 目标被锁定 / 目标被重排删除 → 409', async () => {
  const { project, cues } = await layoutProject();

  // 规则过期
  const p1 = await api(`/api/projects/${project.id}/proposals`, 'POST', {
    items: [{ subtitle_id: cues[0].id, version: 1, text: '甲' }],
  });
  await api(`/api/projects/${project.id}/rules`, 'PUT', {
    version: project.rules.version, max_chars: 25, min_duration_ms: 800, max_cps: 20,
  });
  const a1 = await api(`/api/projects/${project.id}/proposals/${p1.body.id}/adopt`, 'POST');
  assert.equal(a1.status, 409);
  assert.ok(a1.body.reasons.some((r) => r.includes('规则')));
  assert.equal(a1.body.current.rules.max_chars, 25);

  // 目标被锁定
  const cur = await api(`/api/projects/${project.id}`);
  const c0 = cur.body.subtitles.find((s) => s.id === cues[0].id);
  const p2 = await api(`/api/projects/${project.id}/proposals`, 'POST', {
    items: [{ subtitle_id: c0.id, version: c0.version, text: '乙' }],
  });
  await api(`/api/projects/${project.id}/subtitles/${c0.id}`, 'PATCH', { version: c0.version, locked: true });
  const a2 = await api(`/api/projects/${project.id}/proposals/${p2.body.id}/adopt`, 'POST');
  assert.equal(a2.status, 409);
  assert.ok(a2.body.reasons.some((r) => r.includes('已锁定')));

  // 目标被重排删除（未锁定字幕重排后 id 变更）
  const cur2 = await api(`/api/projects/${project.id}`);
  const unlocked = cur2.body.subtitles.find((s) => s.locked === 0);
  const p3 = await api(`/api/projects/${project.id}/proposals`, 'POST', {
    items: [{ subtitle_id: unlocked.id, version: unlocked.version, text: '丙' }],
  });
  const relayout = await api(`/api/projects/${project.id}/layout`, 'POST', { sub_version: cur2.body.sub_version });
  assert.equal(relayout.status, 200);
  const a3 = await api(`/api/projects/${project.id}/proposals/${p3.body.id}/adopt`, 'POST');
  assert.equal(a3.status, 409);
  assert.ok(a3.body.reasons.some((r) => r.includes('不存在')));
});

test('采纳：违反当前规则 → 422 列出冲突，整组不生效', async () => {
  const { project, cues } = await layoutProject();
  const created = await api(`/api/projects/${project.id}/proposals`, 'POST', {
    items: [
      { subtitle_id: cues[0].id, version: 1, text: '长'.repeat(31) }, // 超 max_chars=30
      { subtitle_id: cues[1].id, version: 1, text: '合规文本' },
    ],
  });
  assert.equal(created.status, 201);
  const before = await api(`/api/projects/${project.id}`);
  const adopt = await api(`/api/projects/${project.id}/proposals/${created.body.id}/adopt`, 'POST');
  assert.equal(adopt.status, 422);
  assert.ok(adopt.body.conflicts.some((c) => c.type === 'max_chars'));
  // 整组不生效：两条都保持原值，字幕集版本不变
  const after = await api(`/api/projects/${project.id}`);
  assert.equal(after.body.sub_version, before.body.sub_version);
  assert.deepEqual(after.body.subtitles, before.body.subtitles);
});

test('采纳：已采纳提议重复提交是幂等空操作', async () => {
  const { project, cues } = await layoutProject();
  const created = await api(`/api/projects/${project.id}/proposals`, 'POST', {
    items: [{ subtitle_id: cues[0].id, version: 1, text: '你好朋友' }],
  });
  const a1 = await api(`/api/projects/${project.id}/proposals/${created.body.id}/adopt`, 'POST');
  assert.equal(a1.status, 200);
  assert.equal(a1.body.already_adopted, undefined);

  const a2 = await api(`/api/projects/${project.id}/proposals/${created.body.id}/adopt`, 'POST');
  assert.equal(a2.status, 200);
  assert.equal(a2.body.already_adopted, true);
  assert.equal(a2.body.sub_version, a1.body.sub_version, '重复采纳不得推进字幕集版本');
  // 字幕行版本不再增加
  const after = await api(`/api/projects/${project.id}`);
  const s0 = after.body.subtitles.find((s) => s.id === cues[0].id);
  assert.equal(s0.text, '你好朋友');
  assert.equal(s0.version, cues[0].version + 1);
});

// ---------- 与既有功能兼容 ----------

test('提议：旧导出快照不受采纳影响，新导出包含已采纳修订', async () => {
  const { project, cues } = await layoutProject();
  const cur = await api(`/api/projects/${project.id}`);
  const e1 = await api(`/api/projects/${project.id}/exports`, 'POST', { sub_version: cur.body.sub_version });
  assert.equal(e1.status, 201);

  const created = await api(`/api/projects/${project.id}/proposals`, 'POST', {
    items: [{ subtitle_id: cues[0].id, version: 1, text: '你好朋友' }],
  });
  const adopt = await api(`/api/projects/${project.id}/proposals/${created.body.id}/adopt`, 'POST');
  assert.equal(adopt.status, 200);

  const e2 = await api(`/api/projects/${project.id}/exports`, 'POST', { sub_version: adopt.body.sub_version });
  assert.equal(e2.status, 201);
  assert.equal(e2.body.version, 2);
  assert.ok(e2.body.content.includes('你好朋友'));

  const dl1 = await api(`/api/projects/${project.id}/exports/1`);
  assert.equal(dl1.body, e1.body.content, 'v1 快照不得被提议采纳影响');
  assert.ok(!dl1.body.includes('你好朋友'));
});

test('提议：项目载荷包含提议历史；单条编辑与锁定接口行为不变', async () => {
  const { project, cues } = await layoutProject();
  const created = await api(`/api/projects/${project.id}/proposals`, 'POST', {
    items: [{ subtitle_id: cues[0].id, version: 1, text: '你好朋友' }],
  });
  assert.equal(created.status, 201);
  const cur = await api(`/api/projects/${project.id}`);
  assert.equal(cur.body.proposals.length, 1);
  assert.equal(cur.body.proposals[0].id, created.body.id);
  assert.equal(cur.body.proposals[0].status, 'pending');

  // 单条编辑接口照旧（行版本过期仍 409）
  const stale = await api(`/api/projects/${project.id}/subtitles/${cues[0].id}`, 'PATCH', {
    version: 99, text: 'x',
  });
  assert.equal(stale.status, 409);
  const ok = await api(`/api/projects/${project.id}/subtitles/${cues[0].id}`, 'PATCH', {
    version: cues[0].version, text: '手工改',
  });
  assert.equal(ok.status, 200);
});

test('提议：404 与未定义路径', async () => {
  const { project } = await layoutProject();
  const noProj = await api('/api/projects/99999/proposals', 'POST', { items: [{ subtitle_id: 1, version: 1, text: 'x' }] });
  assert.equal(noProj.status, 404);
  const noProp = await api(`/api/projects/${project.id}/proposals/8888`);
  assert.equal(noProp.status, 404);
  const noPreview = await api(`/api/projects/${project.id}/proposals/8888/preview`);
  assert.equal(noPreview.status, 404);
  const noAdopt = await api(`/api/projects/${project.id}/proposals/8888/adopt`, 'POST');
  assert.equal(noAdopt.status, 404);
});
