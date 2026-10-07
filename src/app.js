/* 配線。UI・Input・Renderer・シミュレータをつなぐだけの層。
 *
 * ここだけが DOM と core の両方を知る。
 * core の中（world / placement）は DOM を知らないままにしておく。
 *
 * Phase 5b から、World と Sim は Web Worker の中（worker/engine.js）で動く。
 * ここは命令を送り（client.js）、返ってきた「画面に映る範囲の写し」を描くだけ。
 * 写しは render/view.js で World / Sim と同じ形に戻すので、renderer は前と同じように読める。
 */

import { Registry } from './core/registry.js';
import { canPlace, pathCells } from './core/placement.js';
import { rotateCW } from './core/grid.js';
import { TICK_HZ } from './core/sim.js';
import { lineRecipes } from './core/linegen.js';
import { Renderer } from './render/renderer.js';
import { ViewSim, ViewWorld } from './render/view.js';
import { Input } from './input/input.js';
import { SimClient } from './client.js';
import { listLocal, loadLocal, removeLocal, saveLocal } from './storage.js';
import { askChoice, askConfirm, askText } from './ui/dialog.js';
import {
  BLUEPRINT_FORMAT, buildingsInside, captureBlueprint, checkBlueprint, flipBlueprint, previewBlueprint, rectFrom, rotateBlueprint,
} from './core/blueprint.js';

const BOARD = { width: 64, height: 64 };
/** ブラウザの中に自動保存する名前と間隔。 */
const AUTOSAVE = 'autosave';
const AUTOSAVE_MS = 5000;
const EMPTY = { tick: 0, seconds: 0, count: 0, ...BOARD, rect: { x0: 0, y0: 0, x1: -1, y1: -1 },
                buildings: [], resources: [], power: [], unpowered: [], busy: [],
                belts: [], containers: [], machines: [], miners: [], collectors: [], signals: [], ground: [] };

const state = {
  registry: null,
  client: null,
  view: null,         // { world: ViewWorld, sim: ViewSim }  Worker から届いた最新の写し
  fresh: false,       // まだ描いていない写しがある
  rect: null,         // Worker に伝えた画面の範囲
  renderer: null,
  selected: null,     // 選んでいる建物の id（ITEM_TOOL ならアイテムを置く道具）
  running: false,     // 再生中か
  version: 0,         // 届いた写しの version（盤面が変わるたびに増える）
  savedVersion: -1,   // 最後に自動保存したときの version
  dir: 'N',           // これから置く向き
  selStart: null,     // 範囲選択を始めたマス
  selection: null,    // 選んでいる範囲 { x0, y0, x1, y1 }
  clipboard: null,    // コピーした設計図
  paste: null,        // 貼り付け中・移動中の設計図（マウスに付いてくる）{ bp, anchor, move, ctrl }
  swallow: false,     // 左ボタンを離すまで、ドラッグを無視する（クリックで貼り終えた直後）
};

const $ = id => document.getElementById(id);

/** 動作確認用の道具: クリックしたマスにアイテムを置く（採掘機が動くのは Phase 3 から）。 */
const ITEM_TOOL = '__items';
/** 鉱脈を置く道具（右クリックで消す）。 */
const RESOURCE_TOOL = '__resource';
const ITEM_AMOUNT = 10;
/** 範囲を選ぶ道具。 */
const SELECT_TOOL = '__select';
/** 設計図をブラウザの中に保存するときの名前の頭。 */
const BP_PREFIX = 'blueprint:';

async function main() {
  state.registry = await Registry.load('data');
  setView(EMPTY);
  state.renderer = new Renderer($('board'), state.registry);
  state.renderer.resize();

  state.client = new SimClient(snap => {
    setView(snap);
    state.version = snap.version;
    state.fresh = true;
    requestDraw();
  });
  await state.client.start(state.registry, { dataUrl: new URL('data', location.href).href, ...BOARD });
  $('mode').textContent = state.client.mode === 'worker' ? 'Worker で計算中' : '画面と同じスレッドで計算中';
  sendView();

  buildPalette();
  new Input($('board'), state.renderer, onCommand);
  window.addEventListener('resize', () => { state.renderer.resize(); sendView(); draw(); });

  $('btnClear').onclick = async () => {
    if (!state.view.world.count) return;
    if (!await askConfirm({
      title: '全部消す', message: `盤面の建物 ${state.view.world.count} 個と中身を全部消します（自動保存も上書きされます）。\n残したいときは先に「書き出し」で保存してください。`,
      ok: '全部消す', danger: true,
    })) return;
    stop();
    await state.client.call('clear');
    status(`全部消しました`);
  };
  $('btnRotate').onclick = () => {
    state.dir = rotateCW(state.dir);
    status(`これから置く向き: ${state.dir}`);
  };

  $('toolSelect').onclick = () => selectBuilding(SELECT_TOOL);
  $('btnCopy').onclick = () => onCommand({ type: 'copy' });
  $('btnCut').onclick = () => onCommand({ type: 'cut' });
  $('btnDelete').onclick = () => onCommand({ type: 'delete' });
  $('btnPaste').onclick = () => onCommand({ type: 'paste' });
  $('btnUndo').onclick = () => onCommand({ type: 'undo' });
  $('btnRedo').onclick = () => onCommand({ type: 'redo' });
  $('btnMove').onclick = () => onCommand({ type: 'move' });
  $('btnPRot').onclick = () => onCommand({ type: 'rotate', ...(state.renderer.hover || { x: -1, y: -1 }) });
  $('btnFlipH').onclick = () => onCommand({ type: 'flip', axis: 'h' });
  $('btnFlipV').onclick = () => onCommand({ type: 'flip', axis: 'v' });
  $('btnSaveBp').onclick = saveBlueprint;
  $('cgN').onchange = drawCircuitTable;
  $('btnGen').onclick = genCircuit;
  drawCircuitTable();
  setupLineForm();
  $('btnLine').onclick = genLine;
  $('btnFit').onclick = () => onCommand({ type: 'fit' });
  $('btnZoomIn').onclick = () => { state.renderer.zoomCenter(1.25); onCommand({ type: 'redraw' }); };
  $('btnZoomOut').onclick = () => { state.renderer.zoomCenter(1 / 1.25); onCommand({ type: 'redraw' }); };
  updateSelButtons();
  refreshBlueprints();
  refreshExamples();
  $('btnResize').onclick = resizeBoard;
  for (const id of ['boardW', 'boardH']) $(id).onkeydown = e => { if (e.key === 'Enter') resizeBoard(); };

  $('btnExport').onclick = exportFile;
  $('btnImport').onclick = () => $('fileImport').click();
  $('fileImport').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) importFile(f); };

  $('btnPlay').onclick = togglePlay;
  $('btnPower').onclick = () => {
    state.renderer.showPower = !state.renderer.showPower;
    $('btnPower').classList.toggle('on', state.renderer.showPower);
    draw();
  };
  $('btnTick').onclick = () => { stop(); state.client.call('step', { ticks: 1 }); };
  $('btnSec').onclick = () => { stop(); state.client.call('step', { ticks: TICK_HZ }); };
  const sel = $('itemSel');
  for (const it of state.registry.items.values()) {
    const o = document.createElement('option');
    o.value = it.id; o.textContent = it.name;
    sel.appendChild(o);
  }

  if (state.registry.problems.length) {
    status(`データに問題: ${state.registry.problems[0]}`, true);
  } else {
    status(`読み込み完了 — 建物 ${state.registry.buildings.size} 種 / アイテム ${state.registry.items.size} 種`);
  }
  await restoreAutosave();
  setInterval(autosave, AUTOSAVE_MS);
  document.addEventListener('visibilitychange', () => { if (document.hidden) autosave(); });
  draw();
}

/* ---------- 保存・読込（Phase 6） ---------- */

/** 前回の自動保存があれば、その続きから始める。 */
async function restoreAutosave() {
  let data;
  try { data = await loadLocal(AUTOSAVE); } catch (e) {
    console.warn('ブラウザの中への保存が使えません:', e);
    $('saveState').textContent = '自動保存は使えません';
    return;
  }
  if (!data) return;
  try {
    const r = await state.client.call('load', { data, record: false });
    status(`前回の続きを読み込みました（${when(r.savedAt)} に保存・建物 ${r.count}）`
      + (r.skipped ? ` — 知らない・置けない建物 ${r.skipped} 個を飛ばしました` : ''), !!r.skipped);
  } catch (e) {
    // 読めなかった自動保存は、上書きされる前に別の名前で残しておく
    try { await saveLocal(`${AUTOSAVE}-unreadable`, data); } catch { /* 残せなくても続ける */ }
    status(`前回の自動保存を読めませんでした: ${e.message}（「${AUTOSAVE}-unreadable」として残しました）`, true);
  }
}

/** 盤面が変わっていれば、ブラウザの中に保存する。 */
async function autosave() {
  if (!state.client || state.version === state.savedVersion) return;
  const version = state.version;
  try {
    const data = await state.client.call('save');
    await saveLocal(AUTOSAVE, data);
    state.savedVersion = version;
    $('saveState').textContent = `自動保存 ${when(data.savedAt)}`;
  } catch (e) {
    $('saveState').textContent = '自動保存できません';
    console.warn('自動保存できません:', e);
  }
}

async function exportFile() {
  const data = await state.client.call('save');
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  const d = new Date(data.savedAt), pad = n => String(n).padStart(2, '0');
  a.download = `industry-sim-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
    + `-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
  a.href = URL.createObjectURL(blob);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  status(`${a.download} に書き出しました（建物 ${data.world.buildings.length}）`);
}

async function importFile(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch {
    status(`${file.name} は JSON として読めません`, true);
    return;
  }
  if (data && data.format === BLUEPRINT_FORMAT) { await importBlueprint(data, file.name); return; }
  if (state.view.world.count && !await askConfirm({
    title: '盤面を読み込む', message: `${file.name} を読み込むと、今の盤面と入れ替わります（自動保存も上書きされます）。\n残したいときは先に「書き出し」で保存してください。`,
    ok: '読み込む', danger: true,
  })) return;
  try {
    stop();
    const r = await state.client.call('load', { data });
    status(`${file.name} を読み込みました（${when(r.savedAt)} に保存・建物 ${r.count}）`
      + (r.skipped ? ` — 知らない・置けない建物 ${r.skipped} 個を飛ばしました` : ''), !!r.skipped);
    autosave();
  } catch (e) {
    status(`${file.name} を読み込めません: ${e.message}`, true);
  }
}

/* ---------- 見本（examples/。動きの確認用の盤面） ---------- */

/** examples/index.json を読んで、左の一覧に並べる。 */
async function refreshExamples() {
  const box = $('exList');
  let list = [];
  try {
    const res = await fetch('examples/index.json', { cache: 'no-store' });
    if (res.ok) list = (await res.json()).examples || [];
  } catch { /* 無ければ並べない */ }
  box.innerHTML = '';
  for (const ex of list) {
    const el = document.createElement('button');
    el.className = 'pal';
    el.title = ex.note || '';
    el.innerHTML = `<i style="background:#a78bfa"></i><span class="n"></span><span class="sz">開く</span>`;
    el.querySelector('.n').textContent = ex.name;
    el.onclick = () => openExample(ex);
    box.appendChild(el);
  }
  if (!list.length) box.innerHTML = '<div class="sub">（examples/ が見つかりません）</div>';
}

/* ---------- 回路の自動生成 ---------- */

const CG_NAMES = ['A', 'B', 'C'];

/** 入力の数に合わせて、組み合わせの表（どの組み合わせで電気を出すか）を描き直す。 */
function drawCircuitTable() {
  const n = Number($('cgN').value);
  const box = $('cgTable');
  let html = '<tr>' + CG_NAMES.slice(0, n).map(c => `<th>${c}</th>`).join('') + '<th>出す</th></tr>';
  for (let r = 0; r < 1 << n; r++) {
    html += '<tr>';
    for (let i = 0; i < n; i++) html += `<td>${(r >> (n - 1 - i)) & 1 ? '入' : '切'}</td>`;
    html += `<td><input type="checkbox" data-r="${r}"></td></tr>`;
  }
  box.innerHTML = html;
  $('cgList').innerHTML = '';
  $('cgText').textContent = '';
}

async function genCircuit() {
  const n = Number($('cgN').value);
  const table = [];
  for (let r = 0; r < 1 << n; r++) table.push(!!$('cgTable').querySelector(`input[data-r="${r}"]`).checked);
  if (!table.some(Boolean)) { status('電気を出したい組み合わせに、1つ以上印を付けてください', true); return; }
  $('btnGen').disabled = true;
  $('cgText').textContent = '作っています…（型ごとに作って全部の組み合わせを確かめ、建物がいちばん少ない形を選んでいます）';
  $('cgList').innerHTML = '';
  try {
    const res = await state.client.call('genCircuit', { n, table });
    $('cgText').textContent = `式: ${res.text}`;
    showCircuitList(res, n);
  } catch (e) {
    $('cgText').textContent = '';
    status(`回路を作れません: ${e.message}`, true);
  } finally {
    $('btnGen').disabled = false;
  }
}

function showCircuitList(res, n) {
  const box = $('cgList');
  box.innerHTML = '';
  if (!res.candidates.length) {
    box.innerHTML = '<div class="sub">この条件では、どの型でも正しく動く配置を作れませんでした</div>';
    return;
  }
  res.candidates.forEach((c, i) => {
    const el = document.createElement('button');
    el.className = 'pal cand';
    el.title = 'クリックで下見して貼り付け（Ctrl+クリックで上書き、R で回す）';
    el.innerHTML = '<span class="n"></span><span class="sz"></span>';
    el.querySelector('.n').textContent = c.kinds.join('・');
    el.querySelector('.sz').textContent = `${c.width}×${c.height}=${c.area}・${c.count}個・曲がり${c.bends}`;
    el.title = `${c.patternName}。論理回路 ${c.gates} 個。クリックで下見して貼り付け（Ctrl+クリックで上書き、R で回す）`;
    el.onclick = () => {
      for (const b of box.querySelectorAll('.cand')) b.classList.toggle('on', b === el);
      enterPaste(c.blueprint);
      const ins = c.input.map((p, k) => `${CG_NAMES[k]}=(${p.x},${p.y})`).join(' ');
      status(`${c.kinds.join('・')}: ${c.name} — ${c.width}×${c.height}（面積 ${c.area}）・${c.count}個・電線の曲がり角 ${c.bends}。設計図の中で、レバー ${ins}、出力の電線 (${c.output.x},${c.output.y})。クリックで貼り付け`);
    };
    box.appendChild(el);
  });
  status(`${res.candidates.length} 通りの配置ができました（面積の小さい順、同じなら置く数の少ない順）。クリックで下見できます`);
}

/* ---- 機械の自動配置 ---- */

const nameOf = id => ((state.registry.building(id) || state.registry.item(id) || state.registry.recipe(id) || {}).name || id);

/** 作る物・機械の選び肢を作る。材料はいつも材料の箱から（ユーザーの判断 2026-10-07）。 */
function setupLineForm() {
  const recipes = lineRecipes(state.registry);
  const rs = $('lgRecipe');
  rs.innerHTML = '';
  for (const r of recipes) {
    const o = document.createElement('option');
    o.value = r.id; o.textContent = `${nameOf(r.id)}（材料: ${nameOf(r.input)}）`;
    rs.appendChild(o);
  }
  const sync = () => {
    const r = recipes.find(x => x.id === rs.value);
    if (!r) return;
    const ms = $('lgMachine'), keep = ms.value;
    ms.innerHTML = '';
    for (const m of r.machines) { const o = document.createElement('option'); o.value = m; o.textContent = nameOf(m); ms.appendChild(o); }
    if (r.machines.includes(keep)) ms.value = keep;
    $('lgList').innerHTML = ''; $('lgText').textContent = '';
  };
  rs.onchange = sync;
  sync();
}

async function genLine() {
  const opts = {
    recipe: $('lgRecipe').value, machine: $('lgMachine').value,
    count: Math.max(1, Math.min(16, Number($('lgCount').value) || 1)),
  };
  $('lgCount').value = opts.count;
  $('btnLine').disabled = true;
  $('lgText').textContent = '作っています…（型ごとに並べ、電気をつなぎ、動かして出来高を確かめています）';
  $('lgList').innerHTML = '';
  try {
    const res = await state.client.call('genLine', opts);
    const r = state.registry.recipe(opts.recipe);
    $('lgText').textContent = `目標: ${nameOf(opts.recipe)} 毎分 ${fmt(res.target)} 個（${nameOf(opts.machine)} ${opts.count} 台。1台 ${r.craftTime} 秒で1回）。材料は毎分 ${fmt(res.need)} 個`;
    showLineList(res, opts);
  } catch (e) {
    $('lgText').textContent = '';
    status(`配置を作れません: ${e.message}`, true);
  } finally {
    $('btnLine').disabled = false;
  }
}

const fmt = v => (Math.round(v * 10) / 10).toString();

function showLineList(res, opts) {
  const box = $('lgList');
  box.innerHTML = '';
  if (!res.candidates.length) {
    box.innerHTML = '<div class="sub">どの型でも、目標の出来高で動く配置を作れませんでした</div>';
  }
  res.candidates.forEach((c, i) => {
    const el = document.createElement('button');
    el.className = 'pal cand';
    el.innerHTML = '<span class="n"></span><span class="sz"></span>';
    el.querySelector('.n').textContent = `${i + 1}. ${c.patternName}`;
    const parts = [`${c.width}×${c.height}=${c.area}`, `${c.count}個`];
    parts.push(`発電機${c.generators}`);
    el.querySelector('.sz').textContent = parts.join('・');
    el.title = `動かして測った出来高: 毎分 ${fmt(c.perMin)} 個。クリックで下見して貼り付け（Ctrl+クリックで上書き、R で回す）`;
    el.onclick = () => {
      for (const b of box.querySelectorAll('.cand')) b.classList.toggle('on', b === el);
      enterPaste(c.blueprint);
      const where = `左の辺の材料の箱に ${nameOf(Object.keys(state.registry.recipe(opts.recipe).inputs)[0])} を入れてください`;
      status(`${c.name} — ${c.width}×${c.height}（面積 ${c.area}）・${c.count}個・毎分 ${fmt(c.perMin)} 個（測定）。${where}。製品は左下の出口の箱へ。クリックで貼り付け`);
    };
    box.appendChild(el);
  });
  for (const r of res.rejected) {
    const d = document.createElement('div');
    d.className = 'sub';
    d.textContent = `× ${r.patternName}: ${r.why}（毎分 ${fmt(r.perMin || 0)} 個）`;
    box.appendChild(d);
  }
  if (res.candidates.length) status(`${res.candidates.length} 通りの配置ができました（面積の小さい順、同じなら置く数の少ない順）。クリックで下見できます`);
}

/** 見本の盤面を開く（今の盤面と入れ替わる）。中身は普通のセーブデータ。 */
async function openExample(ex) {
  if (state.view.world.count && !await askConfirm({
    title: '見本を開く', message: `見本「${ex.name}」を開くと、今の盤面と入れ替わります（自動保存も上書きされます）。\n残したいときは先に「書き出し」で保存してください。`,
    ok: '開く', danger: true,
  })) return;
  try {
    const res = await fetch(ex.file, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${ex.file} を読めません (${res.status})`);
    const data = await res.json();
    // 見本は小さく作ってあるので、盤面は今の大きさのまま（見本の方が大きいときだけ広げる）。左上に置く
    const exW = data.world.width, exH = data.world.height;
    const now = state.view.world;
    data.world.width = Math.max(exW, now.width || 0);
    data.world.height = Math.max(exH, now.height || 0);
    stop();
    selectBuilding(null);
    setSelection(null);
    await state.client.call('load', { data });
    state.renderer.fitTo(exW, exH);
    sendView(); draw();
    status(`見本「${ex.name}」を開きました。▶ 再生で動きます — ${ex.note || ''}`);
    autosave();
  } catch (e) {
    status(`見本を開けません: ${e.message}`, true);
  }
}

/* ---------- 盤面の大きさ ---------- */

/** 入力された大きさに変える。はみ出して消える建物があれば先に確かめる。 */
async function resizeBoard() {
  const width = Number($('boardW').value), height = Number($('boardH').value);
  const w = state.view.world;
  if (width === w.width && height === w.height) { status(`盤面はもう ${width}x${height} です`); return; }
  try {
    const { lost } = await state.client.call('resize', { width, height, dryRun: true });
    if (lost && !await askConfirm({
      title: '盤面の大きさを変える', message: `${width}x${height} にすると、盤面の外になる建物 ${lost} 個が中身ごと消えます（元に戻すで戻せます）。`,
      ok: '変える', danger: true,
    })) {
      showSize(w.width, w.height);
      status('大きさを変えるのをやめました');
      return;
    }
    const r = await state.client.call('resize', { width, height });
    if (['boardW', 'boardH'].includes(document.activeElement.id)) document.activeElement.blur();   // 続けて Ctrl+Z などが盤面に届くように
    status(`盤面を ${r.width}x${r.height} にしました` + (r.lost ? `（建物 ${r.lost} 個が消えました）` : ''));
    autosave();
  } catch (e) {
    status(e.message, true);
    showSize(w.width, w.height);
  }
}

/** 大きさの入力欄に今の大きさを出す（入力中は触らない）。 */
function showSize(width, height) {
  for (const [id, v] of [['boardW', width], ['boardH', height]]) {
    const el = $(id);
    if (el && document.activeElement !== el) el.value = v;
  }
}

/** 保存した時刻を短く書く。 */
function when(iso) {
  if (!iso) return '時刻不明';
  const d = new Date(iso), pad = n => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function buildPalette() {
  const box = $('palette');
  const groups = new Map();
  for (const b of state.registry.buildings.values()) {
    const tag = (b.tags && b.tags[0]) || 'other';
    if (!groups.has(tag)) groups.set(tag, []);
    groups.get(tag).push(b);
  }
  const label = { production: '生産', logistics: '物流', storage: '保管', power: '電力', other: 'その他' };
  box.innerHTML = '';
  for (const [tag, list] of groups) {
    const h = document.createElement('div');
    h.className = 'group';
    h.textContent = label[tag] || tag;
    box.appendChild(h);
    for (const b of list) {
      const el = document.createElement('button');
      el.className = 'pal';
      el.dataset.id = b.id;
      el.innerHTML = `<i style="background:${b.color}"></i>`
        + `<span class="n">${b.name}</span>`
        + `<span class="sz">${b.size.width}x${b.size.height}</span>`;
      el.onclick = () => selectBuilding(b.id);
      box.appendChild(el);
    }
  }
  const h = document.createElement('div');
  h.className = 'group';
  h.textContent = '動作確認';
  box.appendChild(h);
  const el = document.createElement('button');
  el.className = 'pal';
  el.dataset.id = ITEM_TOOL;
  el.innerHTML = `<i style="background:#e5e7eb"></i><span class="n">アイテムを置く</span>`
    + `<span class="sz">+${ITEM_AMOUNT}</span>`;
  el.onclick = () => selectBuilding(ITEM_TOOL);
  box.appendChild(el);
  const r = document.createElement('button');
  r.className = 'pal';
  r.dataset.id = RESOURCE_TOOL;
  r.innerHTML = `<i style="background:#64748b"></i><span class="n">鉱脈を置く</span><span class="sz">地面</span>`;
  r.onclick = () => selectBuilding(RESOURCE_TOOL);
  box.appendChild(r);
}

/* ---------- 時間（進めるのは Worker。ここは再生・停止を伝えるだけ） ---------- */

function togglePlay() {
  if (state.running) { stop(); return; }
  state.running = true;
  state.client.call('play');
  $('btnPlay').textContent = '⏸ 停止';
}

function stop() {
  if (state.running) state.client.call('pause');
  state.running = false;
  $('btnPlay').textContent = '▶ 再生';
}

function selectBuilding(id) {
  exitPaste(true);
  state.selected = id;
  for (const el of document.querySelectorAll('.pal')) {
    el.classList.toggle('sel', el.dataset.id === id);
  }
  if (!id) { state.renderer.ghost = null; return; }
  if (id === SELECT_TOOL) {
    state.renderer.ghost = null;
    status('ドラッグで範囲を選びます。選んだ範囲の中をドラッグするとまとめて動かせます（M でも）。Ctrl+C コピー / Ctrl+X 切り取り / Delete 削除');
    return;
  }
  if (id === RESOURCE_TOOL) {
    state.renderer.ghost = null;
    status(`クリック・ドラッグで ${itemName($('itemSel').value)} の鉱脈を置きます（右クリックで消す）。採掘機を鉱脈の方へ向けて隣に置くと掘ります`);
    return;
  }
  if (id === ITEM_TOOL) {
    state.renderer.ghost = null;
    status(`クリックしたマスに ${itemName($('itemSel').value)} を ${ITEM_AMOUNT} 個置きます（保管箱なら中へ、ベルトなら上へ、それ以外は床へ）`);
    return;
  }
  const def = state.registry.building(id);
  status(`${def.name} を選択${def.directional ? '（R で回転）' : ''}`);
}

/** Input から来たコマンドをここで実行する。 */
function onCommand(cmd) {
  tipCommand(cmd);
  const { registry, renderer } = state;
  const world = state.view.world;
  const tool = state.selected === ITEM_TOOL || state.selected === RESOURCE_TOOL;
  const paint = state.selected === RESOURCE_TOOL;
  const select = state.selected === SELECT_TOOL;
  const def = state.selected && !tool && !select ? registry.building(state.selected) : null;

  // クリックで貼り終えた直後は、左ボタンを離すまでドラッグを無視する
  if (state.swallow) {
    if (cmd.type === 'drag') return;
    if (cmd.type === 'release') { state.swallow = false; return; }
  }
  // 設計図を貼っている・まとめて動かしているとき（マウスに付いてくる）
  if (state.paste && pasteCommand(cmd)) return;
  // 範囲選択・コピー・貼り付け・画面
  switch (cmd.type) {
    case 'copy': copySelection(false); return;
    case 'cut': copySelection(true); return;
    case 'delete': deleteSelection(); return;
    case 'paste':
      if (state.clipboard) enterPaste(state.clipboard);
      else status('コピーした範囲がありません（範囲を選んで Ctrl+C）', true);
      return;
    case 'move': startMove(renderer.hover, false); return;
    case 'undo': case 'redo': undoRedo(cmd.type); return;
    case 'flip':
      status('反転（V・ボタン）は、貼り付け中（Ctrl+V）か移動中（M）に使えます');
      return;
    case 'fit':
      renderer.fitTo(world.width, world.height);
      sendView(); draw();
      return;
    case 'release':
      if (select && state.selection) selectionStatus();
      return;
  }
  if (select && (cmd.type === 'place' || cmd.type === 'drag')) {
    // 選んだ範囲の中を押したら、ドラッグでまとめて動かす
    if (cmd.type === 'place' && inRect(state.selection, cmd)) { state.selStart = null; startMove(cmd, true); return; }
    const to = cmd.type === 'place' ? cmd : cmd.to;
    if (cmd.type === 'place') state.selStart = { x: cmd.x, y: cmd.y };
    if (!state.selStart) return;
    setSelection(rectFrom(state.selStart, to));
    return;
  }

  switch (cmd.type) {
    case 'hover': {
      if (def) {
        const { ok } = canPlace(world, def, cmd.x, cmd.y, state.dir);
        renderer.setGhost(def, cmd.x, cmd.y, state.dir, ok);
      } else renderer.ghost = null;
      draw();
      break;
    }
    case 'place': {
      if (paint) { setResource([{ x: cmd.x, y: cmd.y }]); break; }
      if (tool) { addItems(cmd.x, cmd.y); break; }
      if (!def) { inspect(cmd.x, cmd.y); break; }
      placeResult(def, state.client.call('dragStart', { type: def.id, x: cmd.x, y: cmd.y, dir: state.dir }), 1);
      break;
    }
    case 'drag': {
      const cells = pathCells(cmd.from, cmd.to);     // マウスの通った道（上下左右に隣り合う順）
      if (paint) { setResource(cells, true); break; }
      if (!def) break;
      placeResult(def, state.client.call('dragTo', { cells }), cells.length);
      break;
    }
    case 'remove': {
      if (paint) {
        const cells = veinCells([{ x: cmd.x, y: cmd.y }]);
        state.client.call('resource', { item: null, cells })
          .then(() => status(`(${cells[0].x}, ${cells[0].y}) からの ${veinSize()}x${veinSize()} の鉱脈を消しました`));
        break;
      }
      state.client.call('remove', { x: cmd.x, y: cmd.y })
        .then(r => status(r ? `${registry.building(r.type).name} を撤去` : '何もありません'));
      break;
    }
    case 'rotate': {
      state.client.call('rotate', { x: cmd.x, y: cmd.y }).then(r => {
        if (r) status(`${registry.building(r.type).name} を ${r.dir} 向きに`);
        else { state.dir = rotateCW(state.dir); status(`これから置く向き: ${state.dir}`); }
      });
      break;
    }
    case 'cancel':
      setSelection(null);
      state.selected = null;
      renderer.ghost = null;
      for (const el of document.querySelectorAll('.pal')) el.classList.remove('sel');
      status('選択を解除');
      draw();
      break;
    case 'redraw':
      sendView();
      draw();
      break;
  }
}

/* ---------- 元に戻す / やり直す（中身は core/history.js） ---------- */

async function undoRedo(kind) {
  if (state.paste) exitPaste(true);
  const r = await state.client.call(kind);
  const word = kind === 'undo' ? '元に戻しました' : 'やり直しました';
  if (!r.done) { status(kind === 'undo' ? 'これ以上は戻せません' : 'やり直せる操作がありません'); return; }
  status(`「${r.label}」を${word}（戻せる ${r.undo}・やり直せる ${r.redo}）`
    + (r.skipped ? ` — その後に置いた物と重なるなどで ${r.skipped} 個は戻せませんでした` : ''), !!r.skipped);
}

/* ---------- 範囲選択・コピー・貼り付け・設計図 ---------- */

function setSelection(rect) {
  state.selection = rect;
  state.renderer.selection = rect;
  updateSelButtons();
  draw();
}

function updateSelButtons() {
  for (const id of ['btnCopy', 'btnCut', 'btnDelete', 'btnSaveBp', 'btnMove']) $(id).disabled = !state.selection;
  $('btnPaste').disabled = !state.clipboard;
  for (const id of ['btnPRot', 'btnFlipH', 'btnFlipV']) $(id).disabled = !state.paste;
}

const inRect = (r, c) => !!r && !!c && c.x >= r.x0 && c.x <= r.x1 && c.y >= r.y0 && c.y <= r.y1;

function selectionStatus() {
  const s = state.selection;
  status(`範囲 (${s.x0}, ${s.y0})〜(${s.x1}, ${s.y1})（${s.x1 - s.x0 + 1}x${s.y1 - s.y0 + 1}）を選びました — 中をドラッグ・M で移動 / Ctrl+C コピー / Ctrl+X 切り取り / Delete 削除 / 設計図として保存`);
}

async function copySelection(cut) {
  if (!state.selection) { status('先に「範囲を選ぶ」で範囲を選んでください', true); return; }
  const bp = await state.client.call('copy', { rect: state.selection });
  if (!bp.buildings.length) { status('範囲の中に（全部が入っている）建物がありません', true); return; }
  state.clipboard = bp;
  if (cut) await state.client.call('removeArea', { rect: state.selection, label: '切り取り' });
  updateSelButtons();
  status(`建物 ${bp.buildings.length} 個を${cut ? '切り取り' : 'コピー'}しました（${bp.width}x${bp.height}）。Ctrl+V で貼ります`);
  if (cut) setSelection(null);
}

async function deleteSelection() {
  if (!state.selection) return;
  if (!state.view.world.buildingsIn(state.selection.x0, state.selection.y0, state.selection.x1, state.selection.y1).length) {
    status('範囲の中に建物がありません'); return;
  }
  const { removed } = await state.client.call('removeArea', { rect: state.selection });
  status(`建物 ${removed} 個を削除しました（中身は床に落ちます）`);
}

/**
 * 設計図をマウスに付けて、クリックで貼れるようにする。
 * opts.anchor: 設計図のどのマスをマウスの下に置くか（既定は真ん中あたり）
 * opts.move:   まとめて移動のとき { rect, transforms, drag }（drag: ボタンを離したら置く）
 */
function enterPaste(bp, opts = {}) {
  const anchor = opts.anchor || { x: Math.floor((bp.width - 1) / 2), y: Math.floor((bp.height - 1) / 2) };
  state.paste = { bp, anchor, move: opts.move || null, ctrl: false };
  state.renderer.ghost = null;
  setSelection(null);
  pasteStatus();
  if (state.renderer.hover) pastePreview(state.renderer.hover);
}

function exitPaste(quiet = false) {
  if (!state.paste) return;
  const wasMove = !!state.paste.move;
  state.paste = null;
  state.renderer.pasteGhost = null;
  updateSelButtons();
  if (!quiet) status(wasMove ? '移動をやめました' : '貼り付けをやめました');
  draw();
}

/** 選んだ範囲を、まとめて動かし始める。cell が範囲の中なら、そのマスを掴んだ形で動かす。 */
function startMove(cell, drag) {
  const rect = state.selection;
  if (!rect) { status('先に「範囲を選ぶ」で範囲を選んでください', true); return; }
  // 下見用の写しは画面の写し（view）から作る。実際に動かすのは Worker の中の本物
  const bp = captureBlueprint(state.view.world, rect);
  if (!bp.buildings.length) { status('範囲の中に（全部が入っている）建物がありません', true); return; }
  const anchor = inRect(rect, cell) ? { x: cell.x - rect.x0, y: cell.y - rect.y0 } : null;
  enterPaste(bp, { anchor, move: { rect, transforms: [], drag } });
}

/** マウスのマスと掴んでいるマスから、設計図の左上を決める。 */
function pasteOrigin(cell) {
  const a = state.paste.anchor;
  return { x: cell.x - a.x, y: cell.y - a.y };
}

function pasteStatus(counts) {
  const p = state.paste;
  const what = p.move ? `建物 ${p.bp.buildings.length} 個を移動中` : `「${p.bp.name || 'コピー'}」（${p.bp.width}x${p.bp.height}・建物 ${p.bp.buildings.length}）を貼り付け中`;
  const how = p.move && p.move.drag ? 'ボタンを離すと置きます' : 'クリックで置きます';
  let line = `${what} — ${how}（Ctrl を押しながらだと上書き）。R 回す / V 上下反転 / 左右反転はボタン / 右クリック・Esc でやめる`;
  if (counts) {
    const parts = [`置ける ${counts.ok}`];
    if (counts.replace) parts.push(`上書き ${counts.replace}`);
    if (counts.same) parts.push(`同じ物がある ${counts.same}`);
    if (counts.blocked) parts.push(`置けない ${counts.blocked}`);
    line += `　［${parts.join('・')}］`;
  }
  status(line, !!(counts && counts.blocked));
}

/** マウスの位置に置いたときの下見。建物そのものを半透明で描き、置ける（緑）・上書き（橙）・置けない（赤）で囲む。 */
function pastePreview(cell, ctrl, quiet = false) {
  const p = state.paste;
  if (ctrl !== undefined) p.ctrl = ctrl;
  const o = pasteOrigin(cell);
  const world = state.view.world;
  const ignore = p.move ? new Set(buildingsInside(world, p.move.rect).map(b => b.id)) : null;
  const items = previewBlueprint(world, state.registry, p.bp, o.x, o.y, { overwrite: p.ctrl, ignore, same: !p.move });
  state.renderer.pasteGhost = { items, from: p.move ? p.move.rect : null };
  const counts = { ok: 0, replace: 0, same: 0, blocked: 0 };
  for (const g of items) counts[g.state]++;
  if (!quiet) pasteStatus(counts);
  draw();
}

/** 回す（'r'）・左右反転（'h'）・上下反転（'v'）。掴んでいるマスも一緒に動かすので、マウスの下が軸になる。 */
function transformPaste(t) {
  const p = state.paste, { width: W, height: H } = p.bp, a = p.anchor;
  if (t === 'r') {
    p.bp = rotateBlueprint(p.bp, state.registry);
    p.anchor = { x: H - 1 - a.y, y: a.x };
  } else {
    p.bp = flipBlueprint(p.bp, state.registry, t);
    p.anchor = t === 'h' ? { x: W - 1 - a.x, y: a.y } : { x: a.x, y: H - 1 - a.y };
  }
  if (p.move) p.move.transforms.push(t);
  if (state.renderer.hover) pastePreview(state.renderer.hover);
  else pasteStatus();
}

/** 置く（貼る・動かす）。ctrl なら重なる建物を上書きする。 */
async function commitPaste(cell, ctrl) {
  const p = state.paste, o = pasteOrigin(cell);
  if (p.move) {
    const { rect, transforms } = p.move;
    exitPaste(true);
    if (!transforms.length && o.x === rect.x0 && o.y === rect.y0) {
      setSelection(rect);
      status('元の場所のままです（動かしていません）');
      return;
    }
    const r = await state.client.call('move', { rect, transforms, x: o.x, y: o.y, overwrite: !!ctrl });
    if (r.blocked) {
      setSelection(rect);
      status(`重なる・盤面の外の建物が ${r.blocked} 個あるので動かしませんでした。Ctrl を押しながら置くと上書きします`, true);
      return;
    }
    if (!r.moved) { setSelection(rect); status('範囲の中に動かせる建物がありません', true); return; }
    setSelection({ x0: o.x, y0: o.y, x1: o.x + r.width - 1, y1: o.y + r.height - 1 });
    status(`建物 ${r.moved} 個を中身ごと動かしました` + (r.replaced ? `（上書きで ${r.replaced} 個を撤去。中身は床へ）` : ''));
    return;
  }
  const r = await state.client.call('paste', { blueprint: p.bp, x: o.x, y: o.y, overwrite: !!ctrl });
  const notes = [];
  if (r.replaced) notes.push(`上書きで ${r.replaced} 個を撤去（中身は床へ）`);
  if (r.same) notes.push(`同じ物がもうある ${r.same} 個はそのまま`);
  if (r.skipped) notes.push(`重なる・盤面の外の ${r.skipped} 個は飛ばしました（Ctrl+クリックで上書き）`);
  if (r.ores) notes.push(`鉱脈 ${r.ores} マスも置きました`);
  status(`建物 ${r.placed} 個を貼りました` + (notes.length ? `（${notes.join('、')}）` : '') + '。続けてクリックで貼れます', !!r.skipped);
}

/** 貼り付け中・移動中のコマンド。処理したら true。 */
function pasteCommand(cmd) {
  const p = state.paste, dragMove = !!(p.move && p.move.drag);
  switch (cmd.type) {
    case 'hover': pastePreview(cmd, cmd.ctrl); return true;
    case 'place':
      if (dragMove) return true;
      if (p.move) state.swallow = true;      // 移動はこれで終わり。このボタンのドラッグは範囲選択にしない
      // 貼った結果を読めるように、下見は描き直すが案内の文は変えない（次にマウスを動かすまで）
      commitPaste(cmd, cmd.ctrl).then(() => { if (state.paste && state.renderer.hover) pastePreview(state.renderer.hover, undefined, true); });
      return true;
    case 'drag':
      if (dragMove) pastePreview(cmd.to, cmd.ctrl);
      return true;
    case 'release':
      if (dragMove && state.renderer.hover) commitPaste(state.renderer.hover, cmd.ctrl);
      return true;
    case 'rotate': transformPaste('r'); return true;
    case 'flip': transformPaste(cmd.axis); return true;
    case 'move': return true;
    case 'remove': case 'cancel': {
      const rect = p.move && p.move.rect;
      exitPaste();
      if (rect) setSelection(rect);
      return true;
    }
    default: return false;
  }
}

/** 選んだ範囲を、名前を付けてブラウザの中に保存する。 */
async function saveBlueprint() {
  if (!state.selection) { status('先に「範囲を選ぶ」で範囲を選んでください', true); return; }
  const bp = await state.client.call('copy', { rect: state.selection });
  if (!bp.buildings.length) { status('範囲の中に（全部が入っている）建物がありません', true); return; }
  const name = await askText({ title: '設計図として保存', message: `選んだ範囲（建物 ${bp.buildings.length}・${bp.width}x${bp.height}）に名前を付けて、このブラウザの中に保存します。`, placeholder: '設計図の名前', ok: '保存' });
  if (!name) return;
  bp.name = name;
  try {
    if (await loadLocal(BP_PREFIX + name)
        && !await askConfirm({ title: '設計図を上書き', message: `設計図「${name}」はもうあります。上書きしますか？`, ok: '上書き', danger: true })) return;
    await saveLocal(BP_PREFIX + name, bp);
    status(`設計図「${name}」を保存しました（建物 ${bp.buildings.length}・${bp.width}x${bp.height}）`);
    refreshBlueprints();
  } catch (e) {
    status(`設計図を保存できません: ${e.message}`, true);
  }
}

async function importBlueprint(bp, fileName) {
  const reason = checkBlueprint(bp);
  if (reason) { status(`${fileName} を読み込めません: ${reason}`, true); return; }
  const name = (bp.name || fileName.replace(/\.json$/i, '')).trim() || '設計図';
  try {
    if (await loadLocal(BP_PREFIX + name)
        && !await askConfirm({ title: '設計図を上書き', message: `設計図「${name}」はもう一覧にあります。読み込んだ物で上書きしますか？`, ok: '上書き', danger: true })) return;
    await saveLocal(BP_PREFIX + name, { ...bp, name });
    status(`設計図「${name}」を一覧に加えました（建物 ${bp.buildings.length}）`);
    refreshBlueprints();
  } catch (e) {
    status(`設計図を保存できません: ${e.message}`, true);
  }
}

/** 保存した設計図の一覧を作り直す。 */
async function refreshBlueprints() {
  const box = $('bpList');
  let names = [];
  try { names = await listLocal(BP_PREFIX); } catch { box.textContent = ''; return; }
  box.innerHTML = '';
  for (const key of names) {
    const name = key.slice(BP_PREFIX.length);
    const row = document.createElement('div');
    row.className = 'bp';
    const use = document.createElement('button');
    use.className = 'pal';
    use.title = 'クリックで貼り付け';
    use.innerHTML = `<i style="background:#38bdf8"></i><span class="n"></span><span class="sz"></span>`;
    use.querySelector('.n').textContent = name;
    const bp = await loadLocal(key);
    if (!bp) continue;
    use.querySelector('.sz').textContent = `${bp.width}x${bp.height}`;
    use.onclick = () => { selectBuilding(null); enterPaste(bp); };
    const out = document.createElement('button');
    out.className = 'mini'; out.textContent = '⤓'; out.title = 'ファイルに書き出す';
    // ファイル名は英数字だけにする（日本語の名前だとブラウザによって "download" になることがあった）。名前はファイルの中に入っている
    out.onclick = () => {
      const d = new Date(), pad = n => String(n).padStart(2, '0');
      downloadJSON(bp, `blueprint-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.json`);
      status(`設計図「${name}」を書き出しました。「読み込み」で一覧に戻せます`);
    };
    const del = document.createElement('button');
    del.className = 'mini'; del.textContent = '×'; del.title = '削除';
    del.onclick = async () => {
      if (!await askConfirm({ title: '設計図を削除', message: `設計図「${name}」を削除しますか？`, ok: '削除', danger: true })) return;
      await removeLocal(key);
      refreshBlueprints();
      status(`設計図「${name}」を削除しました`);
    };
    row.append(use, out, del);
    box.appendChild(row);
  }
}

function downloadJSON(data, fileName) {
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.download = fileName;
  a.href = URL.createObjectURL(blob);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** 置いた結果を出す（判定と設置は Worker が行う）。tried: 置こうとしたマスの数 */
async function placeResult(def, call, tried) {
  const r = await call;
  if (r.placed === tried) {
    const c = r.last;
    status(r.placed === 1 ? `${def.name} を (${c.x}, ${c.y}) に設置` : `${def.name} を ${r.placed} 個設置`);
  } else if (r.reason) status(r.reason, true);
}

async function addItems(x, y) {
  const item = $('itemSel').value;
  const { where } = await state.client.call('items', { x, y, item, count: ITEM_AMOUNT });
  if (!where) { status('盤面の外です', true); return; }
  const label = { belt: 'ベルトの上', container: '保管箱の中', machine: '加工機の中', ground: '床' }[where];
  status(`(${x}, ${y}) の${label}に ${itemName(item)} を ${ITEM_AMOUNT} 個`);
}

/** 鉱脈の大きさ（data/game.json の defaults.veinSize。Core Keeper は 2x2）。 */
const veinSize = () => Math.max(1, (state.registry.game.defaults || {}).veinSize || 1);

/** マスを、そのマスを含む鉱脈の塊（veinSize 四方。盤面に合わせて揃える）のマスに広げる。 */
function veinCells(cells) {
  const n = veinSize(), out = [], seen = new Set();
  for (const c of cells) {
    const x0 = Math.floor(c.x / n) * n, y0 = Math.floor(c.y / n) * n;
    for (let dy = 0; dy < n; dy++) for (let dx = 0; dx < n; dx++) {
      const k = `${x0 + dx},${y0 + dy}`;
      if (!seen.has(k)) { seen.add(k); out.push({ x: x0 + dx, y: y0 + dy }); }
    }
  }
  return out;
}

async function setResource(cells, quiet = false) {
  const item = $('itemSel').value;
  cells = veinCells(cells);
  const { ok } = await state.client.call('resource', { item, cells, group: quiet });   // ドラッグの続きは1回の操作にまとめる
  if (!ok) {
    status(`${itemName(item)} は鉱脈になりません（data/items で resource: true のものだけ）`, true);
    return;
  }
  if (!quiet) status(`(${cells[0].x}, ${cells[0].y}) から ${veinSize()}x${veinSize()} に ${itemName(item)} の鉱脈`);
}

function itemName(id) {
  const it = state.registry.item(id);
  return it ? it.name : id;
}

/** スタックの列を「鉄鉱石 10, 銅鉱石 3」のように書く。 */
function describe(list) {
  const sum = new Map();
  for (const s of list) if (s) sum.set(s.item, (sum.get(s.item) || 0) + s.count);
  return [...sum].map(([id, n]) => `${itemName(id)} ${n}`).join(', ');
}

/* ---------- カーソルを止めたときの詳細（ユーザーの依頼 2026-10-06） ---------- */

/** カーソルを同じマスに止めてから詳細を出すまでの時間（ミリ秒）。 */
const TIP_DELAY = 800;
/** 出している間、中身を読み直す間隔（ミリ秒。再生中は中身が動くので）。 */
const TIP_REFRESH = 400;
/** 1つの欄に並べるスタックの最大数（多いときは残りを数だけ出す）。 */
const TIP_MAX_STACKS = 12;
const tip = { cell: null, timer: 0, refresh: 0, shown: false };

/** マウスの動きに合わせて、詳細を出す・消す。 */
function tipCommand(cmd) {
  if (cmd.type === 'hover') {
    const c = tip.cell;
    if (c && c.x === cmd.x && c.y === cmd.y) return;     // 同じマス（Ctrl を押しただけ等）はそのまま
    hideTip();
    if (state.paste || document.body.classList.contains('modal-open')) return;
    tip.cell = { x: cmd.x, y: cmd.y };
    tip.timer = setTimeout(showTip, TIP_DELAY);
    return;
  }
  // 押した・ドラッグした・画面を動かした・盤面の外へ出た・やめた などは消す
  if (['place', 'remove', 'drag', 'redraw', 'leave', 'cancel', 'rotate', 'paste', 'move', 'fit'].includes(cmd.type)) hideTip();
}

function hideTip() {
  clearTimeout(tip.timer); clearInterval(tip.refresh);
  tip.timer = 0; tip.refresh = 0; tip.cell = null; tip.shown = false;
  $('tip').hidden = true;
}

async function showTip() {
  const cell = tip.cell;
  if (!cell) return;
  await updateTip(cell);
  if (tip.cell !== cell || !tip.shown) return;
  tip.refresh = setInterval(() => updateTip(cell), TIP_REFRESH);
}

async function updateTip(cell) {
  let c;
  try { c = await state.client.call('inspect', cell); } catch { return; }
  if (tip.cell !== cell) return;                       // 待っている間に別のマスへ動いた
  const html = tipHTML(cell, c);
  const el = $('tip');
  if (!html) { el.hidden = true; tip.shown = false; return; }
  el.innerHTML = html;
  el.hidden = false;
  tip.shown = true;
  // マスの右下に出す。画面からはみ出すなら左・上へ
  const rect = state.renderer.canvas.getBoundingClientRect();
  const { px, py } = state.renderer.toScreen(cell.x + 1, cell.y + 1);
  let left = rect.left + px + 8, top = rect.top + py + 8;
  const w = el.offsetWidth, h = el.offsetHeight;
  if (left + w > window.innerWidth - 4) left = rect.left + px - state.renderer.tile - w - 8;
  if (top + h > window.innerHeight - 4) top = rect.top + py - state.renderer.tile - h - 8;
  el.style.left = `${Math.max(4, left)}px`;
  el.style.top = `${Math.max(4, top)}px`;
}

const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

/** スタックの列を「何種類・何スタック・合計いくつ」と、1スタックずつの行にする。 */
function stacksHTML(title, list, extra = '') {
  const stacks = (list || []).filter(Boolean);
  const kinds = new Set(stacks.map(s => s.item)).size;
  const total = stacks.reduce((a, s) => a + s.count, 0);
  let out = `<div class="sec">${esc(title)}: ${stacks.length ? `${kinds} 種類・${stacks.length} スタック・計 ${total}` : '空'}${extra}</div>`;
  for (const s of stacks.slice(0, TIP_MAX_STACKS)) {
    const it = state.registry.item(s.item) || {};
    out += `<div class="st"><i style="background:${esc(it.color || '#94a3b8')}"></i>${esc(itemName(s.item))} ×${s.count}</div>`;
  }
  if (stacks.length > TIP_MAX_STACKS) out += `<div class="st">…ほか ${stacks.length - TIP_MAX_STACKS} スタック</div>`;
  return out;
}

/** 詳細の中身。何も無いマスなら null（出さない）。 */
function tipHTML(cell, c) {
  const b = c.building;
  const def = b && state.registry.building(b.type);
  let out = '';
  if (def) out += `<div class="h">${esc(def.name)}</div><div class="sec">(${b.x}, ${b.y})${def.directional ? `・向き ${b.dir}` : ''}</div>`;
  else out += `<div class="h">(${cell.x}, ${cell.y})</div>`;
  if (c.belt) out += stacksHTML('ベルトの上', c.belt);
  if (c.container) out += stacksHTML('中身', c.container.slots, `（${c.container.slots.filter(Boolean).length}/${c.container.slots.length} 枠）`);
  if (c.machine) {
    out += `<div class="sec">状態: ${esc(c.machine.state)}</div>`;
    out += stacksHTML('入力', [c.machine.input]) + stacksHTML('出力', [c.machine.output]);
  }
  if (c.miner) out += `<div class="sec">状態: ${esc(c.miner.state)}</div>`;
  if (c.device) out += `<div class="sec">状態: ${esc(c.device.state)}</div>`;
  if (b && b.filter) out += `<div class="sec">フィルタ: ${esc(itemName(b.filter))} だけ運ぶ</div>`;
  if (c.ground && c.ground.length) out += stacksHTML('床', c.ground);
  if (c.resource) out += `<div class="sec">鉱脈: ${esc(itemName(c.resource))}</div>`;
  if (c.wire) out += `<div class="sec">床の層: ${esc(state.registry.building(c.wire).name)}</div>`;
  if (c.unpowered) out += '<div class="sec" style="color:#f87171">電気が届いていません</div>';
  else if (c.power > 0) out += `<div class="sec">電気の強さ: ${c.power}</div>`;
  const nothing = !def && !(c.ground && c.ground.length) && !c.resource && !c.wire;
  return nothing ? null : out;
}

async function inspect(x, y) {
  // レバーはクリックで入り切りする
  const hit = state.view.world.at(x, y);
  const hitDef = hit && state.registry.building(hit.type);
  if (hitDef && hitDef.signal && hitDef.signal.type === 'lever') {
    const { on } = await state.client.call('toggle', { x, y });
    if (on !== null) { status(`(${hit.x}, ${hit.y}) ${hitDef.name}を${on ? '入れました（電気を通す）' : '切りました（電気を通さない）'}`); return; }
  }
  // アームはクリックでフィルタ（運ぶ物を1種類に絞る）を選ぶ
  if (hitDef && hitDef.inserter) { await chooseFilter(hit); return; }
  const c = await state.client.call('inspect', { x, y });
  const parts = [];
  if (c.belt && c.belt.length) parts.push(`ベルト上: ${describe(c.belt)}`);
  if (c.container) parts.push(`中身: ${describe(c.container.slots) || '空'}`
    + `（${c.container.slots.filter(Boolean).length}/${c.container.slots.length} 枠）`);
  if (c.machine) {
    const m = c.machine;
    parts.push(`${m.state} / 入力: ${m.input ? describe([m.input]) : '空'} / 出力: ${m.output ? describe([m.output]) : '空'}`);
  }
  if (c.miner) parts.push(c.miner.state);
  if (c.device) parts.push(c.device.state);
  if (c.power > 0) parts.push(`電力 ${c.power}`);
  if (c.unpowered) parts.push('電気が届いていません');
  if (c.wire) parts.push(`床: ${state.registry.building(c.wire).name}`);
  if (c.ground.length) parts.push(`床: ${describe(c.ground)}`);
  if (c.resource) parts.push(`鉱脈: ${itemName(c.resource)}`);
  const extra = parts.length ? ` — ${parts.join(' / ')}` : '';
  const b = c.building;
  if (!b) { status(`(${x}, ${y}) は空きマス${extra}`); return; }
  const def = state.registry.building(b.type);
  status(`(${b.x}, ${b.y}) ${def.name}${def.directional ? ` / 向き ${b.dir}` : ''}`
    + (extra || `${def.note ? ` — ${def.note}` : ''}`));
}

/** アームのフィルタを選ぶ窓。 */
async function chooseFilter(b) {
  const options = [{ value: null, label: '（全部運ぶ）' }];
  for (const it of state.registry.items.values()) options.push({ value: it.id, label: it.name || it.id });
  const v = await askChoice({
    title: 'アームのフィルタ', options, value: b.filter || null, ok: '決める',
    message: `(${b.x}, ${b.y}) のアームが運ぶ物を1種類に絞ります（Core Keeper の Robot Arm のフィルタ）。絞ると、ほかの物は取りません`,
  });
  if (v === undefined) return;
  const r = await state.client.call('filter', { x: b.x, y: b.y, item: v });
  if (r.ok) status(v ? `(${b.x}, ${b.y}) のアームは ${itemName(v)} だけ運びます` : `(${b.x}, ${b.y}) のアームは全部運びます`);
}

function setView(snap) {
  const old = state.view && state.view.world;
  state.view = { world: new ViewWorld(snap), sim: new ViewSim(snap) };
  if (!old || old.width !== snap.width || old.height !== snap.height) showSize(snap.width, snap.height);
}

/** 画面に映る範囲が変わったら Worker に伝える（その範囲の写しが返ってくる）。 */
function sendView() {
  if (!state.client || !state.client.mode) return;
  const r = state.renderer.visibleRect();
  const old = state.rect;
  if (old && old.x0 === r.x0 && old.y0 === r.y0 && old.x1 === r.x1 && old.y1 === r.y1) return;
  state.rect = r;
  state.client.call('view', { rect: r });
}

let drawQueued = false;
/** 次の画面の1コマで描く（写しが続けて届いても、1コマに1回だけ描く）。 */
function requestDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; draw(); });
}

function draw() {
  const { world, sim } = state.view;
  state.renderer.draw(world, sim);
  $('count').textContent = world.count;
  $('clock').textContent = `${sim.seconds.toFixed(2)} 秒（${sim.tick} tick）`;
  if (state.fresh) {          // 描き終えたので次の写しをもらう
    state.fresh = false;
    state.client.send({ op: 'ack' });
  }
}

function status(text, warn = false) {
  const el = $('status');
  el.textContent = text;
  el.title = text;            // 長くて切れたときは、マウスを乗せると全部読める
  el.style.color = warn ? '#fca5a5' : '';
}

main().catch(err => {
  document.getElementById('status').textContent = `起動できません: ${err.message}`;
  console.error(err);
});
