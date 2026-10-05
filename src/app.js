/* 配線。UI・Input・Renderer・World をつなぐだけの層。
 *
 * ここだけが DOM と core の両方を知る。
 * core の中（world / placement）は DOM を知らないままにしておく。
 */

import { Registry } from './core/registry.js';
import { World } from './core/world.js';
import { canPlace, dragDirection, lineCells, place, removeAt, rotateAt } from './core/placement.js';
import { rotateCW } from './core/grid.js';
import { Renderer } from './render/renderer.js';
import { Input } from './input/input.js';

const state = {
  registry: null,
  world: null,
  renderer: null,
  selected: null,     // 選んでいる建物の id
  dir: 'N',           // これから置く向き
  dragged: new Set(), // 1回のドラッグで置いたマス
};

const $ = id => document.getElementById(id);

async function main() {
  state.registry = await Registry.load('data');
  state.world = new World({ width: 64, height: 64 });
  state.renderer = new Renderer($('board'), state.registry);
  state.renderer.resize();

  buildPalette();
  new Input($('board'), state.renderer, onCommand);
  window.addEventListener('resize', () => { state.renderer.resize(); draw(); });

  $('btnClear').onclick = () => {
    if (!state.world.count) return;
    state.world = new World({ width: 64, height: 64 });
    draw(); status(`全部消しました`);
  };
  $('btnRotate').onclick = () => {
    state.dir = rotateCW(state.dir);
    status(`これから置く向き: ${state.dir}`);
  };

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
}

function selectBuilding(id) {
  state.selected = id;
  for (const el of document.querySelectorAll('.pal')) {
    el.classList.toggle('sel', el.dataset.id === id);
  }
  const def = state.registry.building(id);
  status(`${def.name} を選択${def.directional ? '（R で回転）' : ''}`);
}

/** Input から来たコマンドをここで実行する。 */
function onCommand(cmd) {
  const { registry, world, renderer } = state;
  const def = state.selected ? registry.building(state.selected) : null;

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
      if (!def) { inspect(cmd.x, cmd.y); break; }
      tryPlace(def, cmd.x, cmd.y, state.dir);
      draw();
      break;
    }
    case 'drag': {
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

function inspect(x, y) {
  const b = state.world.at(x, y);
  if (!b) { status(`(${x}, ${y}) は空きマス`); return; }
  const def = state.registry.building(b.type);
  status(`(${b.x}, ${b.y}) ${def.name}${def.directional ? ` / 向き ${b.dir}` : ''}`
    + `${def.note ? ` — ${def.note}` : ''}`);
}

function draw() {
  state.renderer.draw(state.world);
  $('count').textContent = state.world.count;
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
