/* 速さの測定（bench.html）。core と renderer を、大きな盤面で動かして時間を測る。
 * テストではないので、結果の数字は PC とブラウザによって変わる。 */

import { Registry } from './core/registry.js';
import { World } from './core/world.js';
import { Sim } from './core/sim.js';
import { place, removeAt } from './core/placement.js';
import { Renderer } from './render/renderer.js';
import { SimClient } from './client.js';

const $ = id => document.getElementById(id);
const reg = await Registry.load('data');
const B = id => reg.building(id);

/** 採掘機から箱までの列（2行 x 16マス）を敷き詰める。 */
function fill(n) {
  const w = new World({ width: n, height: n });
  for (let y = 0; y + 1 < n; y += 2) {
    for (let x = 0; x + 16 < n; x += 16) {
      w.setResource(x, y, 'iron-ore');
      place(w, B('miner'), x + 1, y, 'W');
      for (let i = 2; i <= 9; i++) place(w, B('belt'), x + i, y, 'E');
      place(w, B('inserter'), x + 11, y, 'W'); place(w, B('furnace'), x + 12, y, 'N');
      place(w, B('inserter'), x + 13, y, 'W'); place(w, B('chest'), x + 14, y, 'N');
      place(w, B('generator'), x + 1, y + 1, 'N');
      for (let i = 2; i <= 13; i++) place(w, B('wire'), x + i, y + 1, 'N');
    }
  }
  return w;
}

const ms = (f, times = 1) => { const t = performance.now(); for (let i = 0; i < times; i++) f(); return (performance.now() - t) / times; };
const fmt = v => `${v.toFixed(v < 10 ? 2 : 0)} ms`;

/** fill と同じ並びを、Engine への「置く」命令にする（建物の種類ごとに1回）。 */
function fillCommands(n) {
  const cmds = new Map(), res = [];
  const add = (type, x, y, dir) => { if (!cmds.has(type)) cmds.set(type, []); cmds.get(type).push({ x, y, dir }); };
  for (let y = 0; y + 1 < n; y += 2) {
    for (let x = 0; x + 16 < n; x += 16) {
      res.push({ x, y });
      add('miner', x + 1, y, 'W');
      for (let i = 2; i <= 9; i++) add('belt', x + i, y, 'E');
      add('inserter', x + 11, y, 'W'); add('furnace', x + 12, y, 'N');
      add('inserter', x + 13, y, 'W'); add('chest', x + 14, y, 'N');
      add('generator', x + 1, y + 1, 'N');
      for (let i = 2; i <= 13; i++) add('wire', x + i, y + 1, 'N');
    }
  }
  return { cmds, res };
}

/** 再生中に、画面のスレッドがいちばん長く止まった時間（requestAnimationFrame の間隔の最大）。
 *  start: 建物を置いた直後に再生を始めてから3秒、steady: その後の2秒 */
async function playStall(n, worker) {
  let frames = 0;
  const client = new SimClient(() => { frames++; client.send({ op: 'ack' }); });
  await client.start(reg, { dataUrl: new URL('data', location.href).href, width: n, height: n, worker });
  const { cmds, res } = fillCommands(n);
  await client.call('resource', { item: 'iron-ore', cells: res });
  for (const [type, cells] of cmds) await client.call('place', { type, cells });
  await client.call('view', { rect: { x0: 0, y0: 0, x1: 60, y1: 34 } });
  await client.call('play');            // 置いた直後に再生する（置いた分の追いつきの計算も入る）
  const watch = ms => new Promise(done => {
    let worst = 0, last = performance.now();
    const end = last + ms;
    const tick = now => {
      worst = Math.max(worst, now - last); last = now;
      if (now < end) requestAnimationFrame(tick); else done(worst);
    };
    requestAnimationFrame(tick);
  });
  const start = await watch(3000);      // 再生を始めてから3秒
  const steady = await watch(2000);     // その後の2秒
  await client.call('pause');
  if (client.worker) client.worker.terminate();
  return { start, steady, frames, mode: client.mode };
}

$('run').onclick = async () => {
  const n = +$('size').value;
  $('msg').textContent = ' 測定中…';
  await new Promise(r => setTimeout(r, 30));
  const w = fill(n);
  let sim;
  const first = ms(() => { sim = new Sim(w, reg); });
  const tick = ms(() => sim.step(), 60);
  const edits = [['belt', 5, 4, 'E'], ['wire', 7, 5, 'N'], ['inserter', 11, 6, 'W'], ['generator', 3, 9, 'N']];
  let count = 0;
  const editTotal = ms(() => {
    for (let r = 0; r < 5; r++) {
      for (const [id, x, y, d] of edits) {
        const xx = (x + r * 32) % n, yy = (y + r * 32) % n;
        removeAt(w, xx, yy); sim.sync();
        place(w, B(id), xx, yy, d); sim.sync();
        count += 2;
      }
    }
  });
  const r = new Renderer($('board'), reg);
  r.resize();
  r.tile = 16;
  r.origin = { x: n / 2 - 30, y: n / 2 - 17 };
  const frame = ms(() => r.draw(w, sim), 20);
  $('msg').textContent = ' 再生して測定中…（6秒ほど）';
  const onMain = await playStall(n, false);
  const inWorker = await playStall(n, true);
  const row = document.createElement('tr');
  row.innerHTML = [`${n}x${n}`, w.count.toLocaleString(), fmt(first), fmt(tick), fmt(editTotal / count), fmt(frame),
                   `${fmt(onMain.start)} / ${fmt(onMain.steady)}`,
                   inWorker.mode === 'worker' ? `${fmt(inWorker.start)} / ${fmt(inWorker.steady)}` : 'Worker を使えない']
    .map(v => `<td>${v}</td>`).join('');
  $('out').appendChild(row);
  $('msg').textContent = '';
};
