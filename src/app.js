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
import { canPlace, dragDirection, lineCells } from './core/placement.js';
import { rotateCW } from './core/grid.js';
import { TICK_HZ } from './core/sim.js';
import { Renderer } from './render/renderer.js';
import { ViewSim, ViewWorld } from './render/view.js';
import { Input } from './input/input.js';
import { SimClient } from './client.js';

const BOARD = { width: 64, height: 64 };
const EMPTY = { tick: 0, seconds: 0, count: 0, ...BOARD, rect: { x0: 0, y0: 0, x1: -1, y1: -1 },
                buildings: [], resources: [], power: [], unpowered: [], busy: [],
                belts: [], containers: [], machines: [], miners: [], ground: [] };

const state = {
  registry: null,
  client: null,
  view: null,         // { world: ViewWorld, sim: ViewSim }  Worker から届いた最新の写し
  fresh: false,       // まだ描いていない写しがある
  rect: null,         // Worker に伝えた画面の範囲
  renderer: null,
  selected: null,     // 選んでいる建物の id（ITEM_TOOL ならアイテムを置く道具）
  running: false,     // 再生中か
  dir: 'N',           // これから置く向き
  dragged: new Set(), // 1回のドラッグで置いたマス
};

const $ = id => document.getElementById(id);

/** 動作確認用の道具: クリックしたマスにアイテムを置く（採掘機が動くのは Phase 3 から）。 */
const ITEM_TOOL = '__items';
/** 鉱脈を置く道具（右クリックで消す）。 */
const RESOURCE_TOOL = '__resource';
const ITEM_AMOUNT = 10;

async function main() {
  state.registry = await Registry.load('data');
  setView(EMPTY);
  state.renderer = new Renderer($('board'), state.registry);
  state.renderer.resize();

  state.client = new SimClient(snap => { setView(snap); state.fresh = true; requestDraw(); });
  await state.client.start(state.registry, { dataUrl: new URL('data', location.href).href, ...BOARD });
  $('mode').textContent = state.client.mode === 'worker' ? 'Worker で計算中' : '画面と同じスレッドで計算中';
  sendView();

  buildPalette();
  new Input($('board'), state.renderer, onCommand);
  window.addEventListener('resize', () => { state.renderer.resize(); sendView(); draw(); });

  $('btnClear').onclick = async () => {
    if (!state.view.world.count) return;
    stop();
    await state.client.call('clear');
    status(`全部消しました`);
  };
  $('btnRotate').onclick = () => {
    state.dir = rotateCW(state.dir);
    status(`これから置く向き: ${state.dir}`);
  };

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
  draw();
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
  state.selected = id;
  for (const el of document.querySelectorAll('.pal')) {
    el.classList.toggle('sel', el.dataset.id === id);
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
  const { registry, renderer } = state;
  const world = state.view.world;
  const tool = state.selected === ITEM_TOOL || state.selected === RESOURCE_TOOL;
  const paint = state.selected === RESOURCE_TOOL;
  const def = state.selected && !tool ? registry.building(state.selected) : null;

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
      state.dragged.clear();
      if (paint) { setResource([{ x: cmd.x, y: cmd.y }]); break; }
      if (tool) { addItems(cmd.x, cmd.y); break; }
      if (!def) { inspect(cmd.x, cmd.y); break; }
      state.dragged.add(`${cmd.x},${cmd.y}`);
      tryPlace(def, [{ x: cmd.x, y: cmd.y, dir: state.dir }]);
      break;
    }
    case 'drag': {
      if (paint) {
        setResource(lineCells(cmd.from, cmd.to), true);
        break;
      }
      if (!def) break;
      const dir = def.directional ? (dragDirection(cmd.from, cmd.to) || state.dir) : state.dir;
      const cells = [];
      for (const c of lineCells(cmd.from, cmd.to)) {
        const k = `${c.x},${c.y}`;
        if (state.dragged.has(k)) continue;
        state.dragged.add(k);
        cells.push({ x: c.x, y: c.y, dir });
      }
      if (cells.length) tryPlace(def, cells);
      break;
    }
    case 'remove': {
      if (paint) {
        state.client.call('resource', { item: null, cells: [{ x: cmd.x, y: cmd.y }] })
          .then(() => status(`(${cmd.x}, ${cmd.y}) の鉱脈を消しました`));
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

/** 置く（判定と設置は Worker が行う。cells: [{ x, y, dir }]） */
async function tryPlace(def, cells) {
  const r = await state.client.call('place', { type: def.id, cells });
  if (r.placed === cells.length) {
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

async function setResource(cells, quiet = false) {
  const item = $('itemSel').value;
  const { ok } = await state.client.call('resource', { item, cells });
  if (!ok) {
    status(`${itemName(item)} は鉱脈になりません（data/items で resource: true のものだけ）`, true);
    return;
  }
  if (!quiet) status(`(${cells[0].x}, ${cells[0].y}) に ${itemName(item)} の鉱脈`);
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

async function inspect(x, y) {
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

function setView(snap) {
  state.view = { world: new ViewWorld(snap), sim: new ViewSim(snap) };
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
  el.style.color = warn ? '#fca5a5' : '';
}

main().catch(err => {
  document.getElementById('status').textContent = `起動できません: ${err.message}`;
  console.error(err);
});
