'use strict';

/* 字幕校时工作台前端：项目/导入/规则/排版/锁定/导出，全部带乐观锁处理 */

const state = {
  projects: [],
  project: null,      // 当前项目完整载荷
  edits: new Map(),   // cueId -> { text, start_ms, end_ms } 未保存修改
  preview: null,      // 当前打开的提议预览
};

// ---------- 工具 ----------

const $ = (sel) => document.querySelector(sel);

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let body = null;
  const text = await res.text();
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

let toastTimer = null;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 5000);
}

function fmtMs(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}

// ---------- 数据加载 ----------

async function loadProjects(selectId) {
  const { body } = await api('/api/projects');
  state.projects = body || [];
  const sel = $('#project-select');
  sel.innerHTML = '';
  if (state.projects.length === 0) {
    sel.innerHTML = '<option value="">（无项目，请先导入）</option>';
    state.project = null;
    renderAll();
    return;
  }
  for (const p of state.projects) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `#${p.id} ${p.name}（${p.word_count} 词 / ${p.cue_count} 字幕 / ${p.export_count} 导出）`;
    sel.appendChild(opt);
  }
  const id = selectId ?? state.projects[0].id;
  sel.value = id;
  await loadProject(Number(sel.value));
}

async function loadProject(id) {
  const { status, body } = await api(`/api/projects/${id}`);
  if (status !== 200) { toast(body?.error || '加载项目失败', true); return; }
  state.project = body;
  state.edits.clear();
  renderAll();
}

// ---------- 渲染 ----------

function renderAll() {
  renderRules();
  renderSubtitles();
  renderExports();
  renderProposals();
  $('#force-row').classList.add('hidden');
  $('#proposal-panel').classList.add('hidden');
  state.preview = null;
}

function renderRules() {
  const p = state.project;
  $('#rules-version').textContent = p?.rules ? `v${p.rules.version}` : '';
  $('#rule-max-chars').value = p?.rules?.max_chars ?? '';
  $('#rule-min-duration').value = p?.rules?.min_duration_ms ?? '';
  $('#rule-max-cps').value = p?.rules?.max_cps ?? '';
}

function renderSubtitles() {
  const p = state.project;
  const box = $('#cue-table');
  box.innerHTML = '';
  $('#sub-version').textContent = p ? `字幕集 v${p.sub_version}` : '';
  if (!p || p.subtitles.length === 0) {
    box.innerHTML = '<div class="empty">暂无字幕：导入转写后点击「重新排版」。</div>';
    $('#cue-stats').textContent = p ? `（${p.words.length} 词 / ${p.cuts.length} 切点）` : '';
    return;
  }
  const maxChars = p.rules.max_chars;
  $('#cue-stats').textContent =
    `（${p.subtitles.length} 条，其中锁定 ${p.subtitles.filter((s) => s.locked).length} 条）`;

  p.subtitles.forEach((cue) => {
    const row = document.createElement('div');
    row.className = 'cue-row' + (cue.locked ? ' locked' : '');
    row.dataset.id = cue.id;

    const idx = document.createElement('div');
    idx.className = 'idx';
    idx.innerHTML = `${cue.idx + 1}<div class="word-ref">词${cue.word_start}–${cue.word_end} · v${cue.version}</div>`;

    const startInput = document.createElement('input');
    startInput.type = 'number'; startInput.min = '0'; startInput.value = cue.start_ms;
    startInput.title = `开始 ms（${fmtMs(cue.start_ms)}）`;
    const endInput = document.createElement('input');
    endInput.type = 'number'; endInput.min = '0'; endInput.value = cue.end_ms;
    endInput.title = `结束 ms（${fmtMs(cue.end_ms)}）`;

    const textInput = document.createElement('input');
    textInput.type = 'text'; textInput.value = cue.text; textInput.className = 'text-input';

    const meta = document.createElement('div');
    meta.className = 'meta';
    const updateMeta = () => {
      const len = textInput.value.length;
      const dur = Number(endInput.value) - Number(startInput.value);
      const cps = dur > 0 ? (len / (dur / 1000)) : Infinity;
      const badLen = len > maxChars;
      const badDur = dur < p.rules.min_duration_ms;
      const badCps = cps > p.rules.max_cps;
      meta.innerHTML =
        `<span class="${badLen ? 'bad' : ''}">${len}/${maxChars} 字</span> · ` +
        `<span class="${badDur ? 'bad' : ''}">${dur}ms</span> · ` +
        `<span class="${badCps ? 'bad' : ''}">${cps.toFixed(1)}字/s</span>`;
    };
    updateMeta();

    const markDirty = () => {
      state.edits.set(cue.id, {
        text: textInput.value,
        start_ms: Number(startInput.value),
        end_ms: Number(endInput.value),
      });
      updateMeta();
    };
    textInput.addEventListener('input', markDirty);
    startInput.addEventListener('input', markDirty);
    endInput.addEventListener('input', markDirty);

    const ops = document.createElement('div');
    ops.className = 'ops';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'small'; saveBtn.textContent = '保存';
    saveBtn.onclick = () => saveCue(cue);
    const lockBtn = document.createElement('button');
    lockBtn.className = 'small secondary';
    lockBtn.textContent = cue.locked ? '🔒 解锁' : '🔓 锁定';
    lockBtn.title = cue.locked ? '已校对锁定，重排不会改动' : '锁定后重排不再改动此条';
    lockBtn.onclick = () => toggleLock(cue);
    ops.append(saveBtn, lockBtn);

    row.append(idx, startInput, endInput, textInput, meta, ops);
    box.appendChild(row);
  });
}

function renderExports() {
  const p = state.project;
  const ul = $('#export-list');
  ul.innerHTML = '';
  if (!p || p.exports.length === 0) {
    ul.innerHTML = '<li class="empty">尚无导出版本</li>';
    return;
  }
  for (const e of p.exports) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `/api/projects/${p.id}/exports/${e.version}`;
    a.textContent = `⬇ v${e.version}.vtt`;
    a.download = `project-${p.id}-v${e.version}.vtt`;
    const info = document.createElement('span');
    info.className = 'hint';
    info.textContent = `${e.cue_count} 条 · ${e.created_at}`;
    li.append(a, info);
    ul.appendChild(li);
  }
}

function renderConflicts(conflicts, title) {
  const panel = $('#conflict-panel');
  const ul = $('#conflict-list');
  ul.innerHTML = '';
  panel.querySelector('h2').textContent = title || '⚠ 冲突报告';
  for (const c of conflicts) {
    const li = document.createElement('li');
    const range = document.createElement('span');
    range.className = 'word-range';
    range.textContent = `词 ${c.word_start}${c.word_end !== c.word_start ? '–' + c.word_end : ''}`;
    li.append(range, document.createTextNode(c.message));
    ul.appendChild(li);
  }
  panel.classList.remove('hidden');
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function clearConflicts() {
  $('#conflict-panel').classList.add('hidden');
}

// ---------- 操作 ----------

async function saveCue(cue) {
  const edit = state.edits.get(cue.id);
  const payload = { version: cue.version };
  if (edit) Object.assign(payload, edit);
  const { status, body } = await api(
    `/api/projects/${state.project.id}/subtitles/${cue.id}`,
    { method: 'PATCH', body: JSON.stringify(payload) }
  );
  if (status === 200) {
    state.project.sub_version = body.sub_version;
    const i = state.project.subtitles.findIndex((s) => s.id === cue.id);
    state.project.subtitles[i] = body.subtitle;
    state.edits.delete(cue.id);
    renderSubtitles();
    toast(`字幕 #${cue.idx + 1} 已保存（v${body.subtitle.version}）`);
  } else if (status === 409) {
    toast(body.error + '，已刷新当前内容', true);
    await loadProject(state.project.id);
  } else {
    toast((body?.errors || [body?.error || '保存失败']).join('；'), true);
  }
}

async function toggleLock(cue) {
  const { status, body } = await api(
    `/api/projects/${state.project.id}/subtitles/${cue.id}`,
    { method: 'PATCH', body: JSON.stringify({ version: cue.version, locked: !cue.locked }) }
  );
  if (status === 200) {
    state.project.sub_version = body.sub_version;
    const i = state.project.subtitles.findIndex((s) => s.id === cue.id);
    state.project.subtitles[i] = body.subtitle;
    renderSubtitles();
    toast(body.subtitle.locked ? `字幕 #${cue.idx + 1} 已锁定，重排不再改动` : `字幕 #${cue.idx + 1} 已解锁`);
  } else if (status === 409) {
    toast(body.error + '，已刷新当前内容', true);
    await loadProject(state.project.id);
  } else {
    toast(body?.error || '操作失败', true);
  }
}

async function saveRules() {
  const p = state.project;
  if (!p) return toast('请先选择项目', true);
  const payload = {
    version: p.rules.version,
    max_chars: Number($('#rule-max-chars').value),
    min_duration_ms: Number($('#rule-min-duration').value),
    max_cps: Number($('#rule-max-cps').value),
  };
  const { status, body } = await api(`/api/projects/${p.id}/rules`, {
    method: 'PUT', body: JSON.stringify(payload),
  });
  if (status === 200) {
    state.project.rules = body;
    renderRules();
    renderSubtitles();
    toast(`规则已保存（v${body.version}），点击「重新排版」应用`);
  } else if (status === 409) {
    state.project.rules = body.current;
    renderRules();
    toast(body.error + '，已载入当前规则', true);
  } else {
    toast((body?.errors || [body?.error || '保存失败']).join('；'), true);
  }
}

async function runLayout() {
  const p = state.project;
  if (!p) return toast('请先选择项目', true);
  clearConflicts();
  const { status, body } = await api(`/api/projects/${p.id}/layout`, {
    method: 'POST', body: JSON.stringify({ sub_version: p.sub_version }),
  });
  if (status === 200) {
    state.project.sub_version = body.sub_version;
    state.project.subtitles = body.subtitles;
    state.edits.clear();
    renderSubtitles();
    toast(`排版完成：${body.subtitles.length} 条字幕（字幕集 v${body.sub_version}）`);
  } else if (status === 409) {
    toast(body.error, true);
    await loadProject(p.id);
  } else if (status === 422) {
    renderConflicts(body.conflicts || [], `⚠ ${body.error}`);
    toast(body.error, true);
  } else {
    toast(body?.error || '排版失败', true);
  }
}

async function doExport() {
  const p = state.project;
  if (!p) return toast('请先选择项目', true);
  clearConflicts();
  const { status, body } = await api(`/api/projects/${p.id}/exports`, {
    method: 'POST', body: JSON.stringify({ sub_version: p.sub_version }),
  });
  if (status === 201) {
    toast(`已确认导出 v${body.version}（${body.cue_count} 条），旧版本不受影响`);
    await loadProject(p.id);
  } else if (status === 409) {
    toast(body.error, true);
    await loadProject(p.id);
  } else if (status === 422) {
    renderConflicts(body.conflicts || [], `⚠ ${body.error}`);
    toast(body.error, true);
  } else {
    toast(body?.error || '导出失败', true);
  }
}

// ---------- 修订提议（校对） ----------

function renderProposals() {
  const p = state.project;
  const ul = $('#proposal-list');
  ul.innerHTML = '';
  if (!p || !p.proposals || p.proposals.length === 0) {
    ul.innerHTML = '<li class="empty">尚无修订提议</li>';
    return;
  }
  for (const pr of p.proposals) {
    const li = document.createElement('li');
    const info = document.createElement('span');
    info.innerHTML =
      `<span class="status-${pr.status}">#${pr.id} ${pr.status === 'adopted' ? '✅ 已采纳' : '⏳ 待采纳'}</span> ` +
      `${pr.note ? `「${pr.note}」` : ''} ${pr.item_count} 条 · ${pr.created_at}`;
    const ops = document.createElement('span');
    ops.className = 'ops';
    const pvBtn = document.createElement('button');
    pvBtn.className = 'small secondary';
    pvBtn.textContent = '预览';
    pvBtn.onclick = () => previewProposal(pr.id);
    ops.appendChild(pvBtn);
    if (pr.status === 'pending') {
      const adBtn = document.createElement('button');
      adBtn.className = 'small';
      adBtn.textContent = '采纳';
      adBtn.onclick = () => adoptProposal(pr.id);
      ops.appendChild(adBtn);
    }
    li.append(info, ops);
    ul.appendChild(li);
  }
}

function fillProposalTemplate() {
  const p = state.project;
  if (!p || p.subtitles.length === 0) return toast('请先排版生成字幕', true);
  const items = p.subtitles.filter((s) => !s.locked).slice(0, 2).map((s) => ({
    subtitle_id: s.id,
    version: s.version,
    text: s.text,
    start_ms: null,
    end_ms: null,
    note: '',
  }));
  if (items.length === 0) return toast('当前没有未锁定字幕可修订', true);
  $('#proposal-json').value = JSON.stringify({ note: '', items }, null, 2);
  toast('已按当前未锁定字幕填入模板，请修改 text/时间后提交');
}

async function submitProposal() {
  const p = state.project;
  if (!p) return toast('请先选择项目', true);
  let data;
  try {
    data = JSON.parse($('#proposal-json').value);
  } catch (e) {
    return toast('JSON 解析失败：' + e.message, true);
  }
  clearConflicts();
  const { status, body } = await api(`/api/projects/${p.id}/proposals`, {
    method: 'POST', body: JSON.stringify(data),
  });
  if (status === 201) {
    toast(`提议 #${body.id} 已提交（${body.items.length} 条），正式字幕未改动`);
    await loadProject(p.id);
    await previewProposal(body.id);
  } else {
    toast((body?.errors || [body?.error || '提交失败']).join('；'), true);
  }
}

async function previewProposal(id) {
  const p = state.project;
  if (!p) return;
  clearConflicts();
  const { status, body } = await api(`/api/projects/${p.id}/proposals/${id}/preview`);
  if (status !== 200) return toast(body?.error || '预览失败', true);
  state.preview = body;
  renderProposalPreview();
}

function renderProposalPreview() {
  const pv = state.preview;
  const panel = $('#proposal-panel');
  const box = $('#proposal-items');
  const ul = $('#proposal-conflicts');
  box.innerHTML = '';
  ul.innerHTML = '';
  if (!pv) { panel.classList.add('hidden'); return; }

  $('#proposal-meta').textContent =
    `#${pv.proposal.id} ${pv.proposal.status === 'adopted' ? '✅ 已采纳' : '⏳ 待采纳'}` +
    ` · 基于规则 v${pv.proposal.rules_version}（当前 v${pv.current.rules_version}）` +
    (pv.proposal.note ? ` · 「${pv.proposal.note}」` : '');

  const fmtCue = (v) => (v ? `"${v.text}" [${v.start_ms}, ${v.end_ms}]` : '（不存在）');
  for (const item of pv.items) {
    const div = document.createElement('div');
    div.className = 'proposal-item' + (item.conflicts.length ? ' has-conflict' : '');
    const cur = item.current;
    const drifted = cur && (cur.version !== item.orig_version ||
      cur.text !== item.original.text || cur.start_ms !== item.original.start_ms ||
      cur.end_ms !== item.original.end_ms);
    div.innerHTML =
      `<div class="pv-head">字幕 #${item.subtitle_id}（读取时行版本 v${item.base_version}）` +
      `${item.note ? ` · 说明：${item.note}` : ''}</div>` +
      `<div class="pv-row"><span class="pv-label">原值</span><span>${fmtCue(item.original)}</span></div>` +
      `<div class="pv-row"><span class="pv-label">建议值</span><span class="pv-diff">${fmtCue(item.suggested)}</span></div>` +
      (cur
        ? `<div class="pv-row"><span class="pv-label">当前值</span>` +
          `<span class="${drifted ? 'pv-diff' : ''}">${fmtCue(cur)}（v${cur.version}${cur.locked ? ' 🔒' : ''}）</span></div>`
        : `<div class="pv-row"><span class="pv-label">当前值</span><span class="pv-diff">（目标已不存在）</span></div>`) +
      (item.conflicts.length
        ? `<div class="pv-conflicts">⚠ ${item.conflicts.join('<br>⚠ ')}</div>`
        : '');
    box.appendChild(div);
  }

  for (const c of pv.conflicts) {
    const li = document.createElement('li');
    li.textContent = `⚠ ${c.subtitle_id ? `字幕 #${c.subtitle_id}：` : ''}${c.message}`;
    ul.appendChild(li);
  }

  const adoptBtn = $('#btn-proposal-adopt');
  adoptBtn.disabled = !pv.adoptable;
  adoptBtn.textContent = pv.proposal.status === 'adopted'
    ? '该提议已采纳'
    : pv.adoptable
      ? '采纳该提议（整组生效）'
      : `存在 ${pv.conflicts.length} 处冲突，暂不可采纳`;

  panel.classList.remove('hidden');
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function adoptProposal(id) {
  const p = state.project;
  if (!p) return;
  clearConflicts();
  const { status, body } = await api(`/api/projects/${p.id}/proposals/${id}/adopt`, {
    method: 'POST',
  });
  if (status === 200) {
    toast(body.already_adopted
      ? `提议 #${id} 此前已采纳，本次未改动任何字幕`
      : `提议 #${id} 已采纳，整组修订生效（字幕集 v${body.sub_version}）`);
    await loadProject(p.id);
    await previewProposal(id);
  } else if (status === 409) {
    toast(`${body.error}：${(body.reasons || []).join('；')}`, true);
    await loadProject(p.id);
    await previewProposal(id);
  } else if (status === 422) {
    renderConflicts(body.conflicts || [], `⚠ ${body.error}`);
    toast(body.error, true);
    await previewProposal(id);
  } else {
    toast(body?.error || '采纳失败', true);
  }
}

async function doImport() {
  const p = state.project;
  let data;
  try {
    data = JSON.parse($('#import-json').value);
  } catch (e) {
    return toast('JSON 解析失败：' + e.message, true);
  }
  const name = $('#import-name').value.trim();
  clearConflicts();

  if (name || !p) {
    // 新建项目
    const { status, body } = await api('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: name || `项目 ${new Date().toLocaleString()}`, ...data }),
    });
    if (status === 201) {
      toast(`项目 #${body.id} 已创建（${body.words.length} 词 / ${body.cuts.length} 切点），请点击「重新排版」`);
      await loadProjects(body.id);
    } else {
      toast((body?.errors || [body?.error || '导入失败']).join('；'), true);
    }
    return;
  }

  // 导入当前项目
  const force = $('#import-force').checked;
  const { status, body } = await api(`/api/projects/${p.id}/import`, {
    method: 'POST', body: JSON.stringify({ ...data, force }),
  });
  if (status === 200) {
    toast(`已导入：${body.words.length} 词 / ${body.cuts.length} 切点，请点击「重新排版」`);
    await loadProject(p.id);
  } else if (status === 409) {
    $('#force-row').classList.remove('hidden');
    toast(body.error, true);
  } else {
    toast((body?.errors || [body?.error || '导入失败']).join('；'), true);
  }
}

async function newProject() {
  const name = prompt('新项目名称：', '未命名项目');
  if (!name) return;
  const { status, body } = await api('/api/projects', {
    method: 'POST', body: JSON.stringify({ name }),
  });
  if (status === 201) {
    toast(`项目 #${body.id} 已创建，请导入转写数据`);
    await loadProjects(body.id);
  } else {
    toast(body?.error || '创建失败', true);
  }
}

// ---------- 示例数据 ----------

const SAMPLE_WORDS = [
  ['大家好',100,700],['欢迎收看',750,1450],['本期',1500,1900],['节目',1950,2400],
  ['今天',2500,2900],['我们',2950,3300],['来到',3350,3700],['了',3750,3950],
  ['江边',4000,4450],['的',4500,4650],['老',4700,4900],['茶馆',4950,5450],
  ['这里',6100,6500],['每天',6550,6950],['都',7000,7150],['有',7200,7350],
  ['很多',7400,7800],['茶客',7850,8300],['一边',8400,8800],['喝茶',8850,9250],
  ['一边',9300,9700],['聊天',9750,10200],['老板',11100,11500],['说',11550,11700],
  ['这',11750,11850],['壶',11900,12050],['茶',12100,12250],['泡',12300,12500],
  ['了',12550,12700],['三十年',12750,13300],['镜头',14100,14500],['转向',14550,14950],
  ['窗外',15000,15400],['的',15450,15550],['江面',15600,16000],['雾气',16100,16500],
  ['正在',16550,16950],['缓缓',17000,17400],['升起',17450,17900],['我们',19100,19500],
  ['下期',19550,19950],['再见',20000,20600],
];

function samplePayload(cuts) {
  return JSON.stringify({
    words: SAMPLE_WORDS.map(([text, start_ms, end_ms]) => ({ text, start_ms, end_ms })),
    cuts,
  }, null, 2);
}

// ---------- 事件绑定 ----------

$('#project-select').addEventListener('change', (e) => loadProject(Number(e.target.value)));
$('#btn-new-project').addEventListener('click', newProject);
$('#btn-refresh').addEventListener('click', () => state.project && loadProject(state.project.id));
$('#btn-save-rules').addEventListener('click', saveRules);
$('#btn-layout').addEventListener('click', runLayout);
$('#btn-export').addEventListener('click', doExport);
$('#btn-import').addEventListener('click', doImport);
$('#btn-proposal-template').addEventListener('click', fillProposalTemplate);
$('#btn-proposal-submit').addEventListener('click', submitProposal);
$('#btn-proposal-adopt').addEventListener('click', () => {
  if (state.preview) adoptProposal(state.preview.proposal.id);
});
$('#btn-sample').addEventListener('click', () => {
  $('#import-json').value = samplePayload([6000, 11000, 14000, 19000]);
  toast('已载入示例，点击「导入」');
});
$('#btn-sample-conflict').addEventListener('click', () => {
  // 切点 1300ms 落在词「欢迎收看」[750,1450] 内部 → 必然冲突，用于演示冲突报告
  $('#import-json').value = samplePayload([1300, 6000, 11000, 14000, 19000]);
  toast('已载入冲突示例（切点落在词内部），导入后点「重新排版」查看冲突报告');
});

loadProjects();
