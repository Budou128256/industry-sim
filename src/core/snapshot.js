/* 写し（スナップショット）。World と Sim から「画面に映る範囲」だけを取り出した素のデータ。
 *
 * Phase 5b でシミュレータを Web Worker へ移したため、画面は World / Sim を直接読めない。
 * Worker はこの写しを作って画面へ送り、画面は render/view.js でこれを World / Sim と同じ形に戻して描く。
 * 中身は postMessage でそのまま送れる形（配列・素のオブジェクト）だけにする。
 *
 * **描画も DOM も知らない。**
 */

import { key } from './grid.js';

const copy = list => list.map(s => (s ? { item: s.item, count: s.count } : null));

/** rect: { x0, y0, x1, y1 }（両端を含む）。盤面の外は切り詰める。 */
export function makeSnapshot(world, sim, rect) {
  sim.sync();
  const x0 = Math.max(0, rect.x0), y0 = Math.max(0, rect.y0);
  const x1 = Math.min(world.width - 1, rect.x1), y1 = Math.min(world.height - 1, rect.y1);
  const snap = {
    tick: sim.tick, seconds: sim.seconds, count: world.count,
    width: world.width, height: world.height,
    rect: { x0, y0, x1, y1 },
    buildings: [], resources: [], power: [], unpowered: [], busy: [],
    belts: [], containers: [], machines: [], miners: [], collectors: [], signals: [], ground: [],
  };
  if (x1 < x0 || y1 < y0) return snap;
  for (const b of world.buildingsIn(x0, y0, x1, y1)) {
    snap.buildings.push({ id: b.id, type: b.type, x: b.x, y: b.y, dir: b.dir, size: b.size, layer: b.layer, ...(b.filter ? { filter: b.filter } : {}) });
    if (sim.unpowered.has(b.id)) snap.unpowered.push(b.id);
    if (sim.busy.has(b.id)) snap.busy.push(b.id);
    if (sim.belts.has(b.id)) snap.belts.push([b.id, copy(sim.belts.get(b.id))]);
    if (sim.containers.has(b.id)) snap.containers.push([b.id, { slots: copy(sim.containers.get(b.id).slots) }]);
    if (sim.machines.has(b.id)) {
      const m = sim.machines.get(b.id);
      snap.machines.push([b.id, { input: m.input && { ...m.input }, output: m.output && { ...m.output },
                                  progress: m.progress, state: m.state }]);
    }
    if (sim.miners.has(b.id)) snap.miners.push([b.id, { ...sim.miners.get(b.id) }]);
    if (sim.collectors.has(b.id)) snap.collectors.push([b.id, { ...sim.collectors.get(b.id) }]);
    if (sim.signals.has(b.id)) snap.signals.push([b.id, { on: sim.signals.get(b.id).on }]);
  }
  world.resources.forEachIn(x0, y0, x1, y1, (x, y, item) => snap.resources.push([x, y, item]));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const k = key(x, y);
      const lv = sim.power.get(k);
      if (lv) snap.power.push([x, y, lv]);
      const g = sim.ground.get(k);
      if (g && g.length) snap.ground.push([x, y, copy(g)]);
    }
  }
  return snap;
}


