/* 配線。UI・Input・Renderer・World をつなぐだけの層。
 *
 * ここだけが DOM と core の両方を知る。
 * core の中（world / placement）は DOM を知らないままにしておく。
 */

import { Registry } from './core/registry.js';
import { World } from './core/world.js';
import { Sim, TICK_HZ } from './core/sim.js';
import { canPlace, dragDirection, lineCells, place, removeAt, rotateAt } from './core/placement.js';
import { rotateCW } from './core/grid.js';
import { Renderer } from './render/renderer.js';
import { Input } from './input/input.js';

const state = {
  registry: null,
  world: null,
  sim: null,
  renderer: null,
  selected: null,     // 選んでいる建物の id（ITEM_TOOL ならアイテムを置く道具）
  running: false,     // 再生中か
  carry: 0,           // 次の tick までに溜まった時間（tick 単位）
  lastFrame: 0,
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
  state.world = new World({ width: 64, height: 64 });
  state.sim = new Sim(state.world, state.registry);
  state.renderer = new Renderer($('board'), state.registry);
  state.renderer.resize();

  buildPalette();
  new Input($('board'), state.renderer, onCommand);
  window.addEventListener('resize', () => { state.renderer.resize(); draw(); });

  $('btnClear').onclick = () => {
    if (!state.world.count) return;
    state.world = new World({ width: 64, height: 64 });
    state.sim = new Sim(state.world, state.registry);
    draw(); status(`全部消しました`);
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
  $('btnTick').onclick = () => { stop(); state.sim.step(); draw(); };
  $('btnSec').onclick = () => { stop(); state.sim.stepSecond(); draw(); };
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

/* ---------- 時間 ---------- */

function togglePlay() {
  if (state.running) { stop(); return; }
  state.running = true;
  state.carry = 0;
  state.lastFrame = performance.now();
  $('btnPlay').textContent = '⏸ 停止';
  requestAnimationFrame(frame);
}

function stop() {
  state.running = false;
  $('btnPlay').textContent = '▶ 再生';
}

/** 画面の1コマ。経った時間ぶん tick を進める（遅れても一度に進めるのは1秒まで）。 */
function frame(now) {
  if (!state.running) return;
  state.carry += Math.min(1, (now - state.lastFrame) / 1000) * TICK_HZ;
  state.lastFrame = now;
  let moved = false;
  while (state.carry >= 1) { state.sim.step(); state.carry -= 1; moved = true; }
  if (moved) draw();
  requestAnimationFrame(frame);
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
  const { registry, world, renderer } = state;
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
      if (paint) { setResource(cmd.x, cmd.y); break; }
      if (tool) { addItems(cmd.x, cmd.y); break; }
      if (!def) { inspect(cmd.x, cmd.y); break; }
      tryPlace(def, cmd.x, cmd.y, state.dir);
      draw();
      break;
    }
    case 'drag': {
      if (paint) {
        for (const c of lineCells(cmd.from, cmd.to)) setResource(c.x, c.y, true);
        draw();
        break;
      }
      if (!def) break;
      const dir = def.directional ? (dragDirection(cmd.from, cmd.to) || state.dir) : state.dir;
      for (const c of lineCells(cmd.from, cmd.to)) {
        const k = `${c.x},${c.y}`;
        if (state.dragged.has(k)) continue;
        state.dragged.add(k);
        tryPlace(def, c.x, c.y, dir);
      }
      draw();
      break;
    }
    case 'remove': {
      if (paint) {
        world.setResource(cmd.x, cmd.y, null);
        status(`(${cmd.x}, ${cmd.y}) の鉱脈を消しました`);
        draw();
        break;
      }
      const removed = removeAt(world, cmd.x, cmd.y);
      status(removed ? `${registry.building(removed.type).name} を撤去` : '何もありません');
      draw();
      break;
    }
    case 'rotate': {
      const r = rotateAt(world, registry, cmd.x, cmd.y);
      if (r) status(`${registry.building(r.type).name} を ${r.dir} 向きに`);
      else { state.dir = rotateCW(state.dir); status(`これから置く向き: ${state.dir}`); }
      draw();
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
      draw();
      break;
  }
}

function tryPlace(def, x, y, dir) {
  const { ok, reason } = canPlace(state.world, def, x, y, dir);
  if (!ok) { status(reason, true); return false; }
  place(state.world, def, x, y, dir);
  status(`${def.name} を (${x}, ${y}) に設置`);
  return true;
}

function addItems(x, y) {
  const { world, sim } = state;
  if (x < 0 || y < 0 || x >= world.width || y >= world.height) { status('盤面の外です', true); return; }
  const item = $('itemSel').value;
  const where = sim.addItems(x, y, item, ITEM_AMOUNT);
  const label = { belt: 'ベルトの上', container: '保管箱の中', ground: '床' }[where];
  status(`(${x}, ${y}) の${label}に ${itemName(item)} を ${ITEM_AMOUNT} 個`);
  draw();
}

function setResource(x, y, quiet = false) {
  const { world, registry } = state;
  if (x < 0 || y < 0 || x >= world.width || y >= world.height) return;
  const item = $('itemSel').value;
  if (!(registry.item(item) || {}).resource) {
    status(`${itemName(item)} は鉱脈になりません（data/items で resource: true のものだけ）`, true);
    return;
  }
  world.setResource(x, y, item);
  if (!quiet) { status(`(${x}, ${y}) に ${itemName(item)} の鉱脈`); draw(); }
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

function inspect(x, y) {
  const c = state.sim.contentsAt(x, y);
  const parts = [];
  if (c.belt && c.belt.length) parts.push(`ベルト上: ${describe(c.belt)}`);
  if (c.container) parts.push(`中身: ${describe(c.container.slots) || '空'}`
    + `（${c.container.slots.filter(Boolean).length}/${c.container.slots.length} 枠）`);
  if (c.machine) {
    const m = c.machine;
    parts.push(`${m.state} / 入力: ${m.input ? describe([m.input]) : '空'} / 出力: ${m.output ? describe([m.output]) : '空'}`);
  }
  if (c.miner) parts.push(c.miner.state);
  const lv = state.sim.power.get(`${x},${y}`) || 0;
  if (lv > 0) parts.push(`電力 ${lv}`);
  const b0 = state.world.at(x, y);
  if (b0 && state.sim.unpowered.has(b0.id)) parts.push('電気が届いていません');
  const wire = state.world.floorAt(x, y);
  if (wire) parts.push(`床: ${state.registry.building(wire.type).name}`);
  if (c.ground.length) parts.push(`床: ${describe(c.ground)}`);
  if (c.resource) parts.push(`鉱脈: ${itemName(c.resource)}`);
  const extra = parts.length ? ` — ${parts.join(' / ')}` : '';
  const b = state.world.at(x, y);
  if (!b) { status(`(${x}, ${y}) は空きマス${extra}`); return; }
  const def = state.registry.building(b.type);
  status(`(${b.x}, ${b.y}) ${def.name}${def.directional ? ` / 向き ${b.dir}` : ''}`
    + (extra || `${def.note ? ` — ${def.note}` : ''}`));
}

function draw() {
  state.sim.sync();
  state.renderer.draw(state.world, state.sim);
  $('count').textContent = state.world.count;
  $('clock').textContent = `${state.sim.seconds.toFixed(2)} 秒（${state.sim.tick} tick）`;
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
