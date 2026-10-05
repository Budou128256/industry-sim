/* 電力。発電機から「電気を通すマス」をたどって届く範囲と強さを求める。
 *
 * 規則（corekeeper_layout/static/sim.js の computePower と同じ考え方）:
 *   - data の power.source を持つ建物（発電機）が電源。強さ source で出す
 *   - 電気を通すのは power.conducts を持つ建物（電線・電気を使う機械）のマス
 *   - 上下左右にたどり、1マス進むごとに強さが1下がる。0 になったら届かない
 *   - 「24ブロック先まで供給」= 隣のマスが強さ 24、24マス先が 1。
 *     そのため電源自身のマスは source + 1 から数える（sim.js と同じ）
 *   - power.needs を持つ建物は、自分のどれかのマスに強さ 1 以上が届いていないと動かない
 *
 * 計算し直す範囲（Phase 5）:
 *   盤面全体（computePower）と、変わったマスにつながっている電線網だけ（updatePower）の2通り。
 *   電線網 = 電気を通すマスと電源のマスが上下左右につながったひとかたまり。
 *   あるマスの強さは、同じ電線網の中の電源だけで決まるので、網の外は計算し直さなくてよい。
 */

import { DIRS, DELTA, footprint, key } from './grid.js';

export function powerDef(registry, building) {
  const def = building && registry.building(building.type);
  return (def && def.power) || null;
}

/** そのマスが電気を通すか・電源の強さ（設置物と床の層の両方を見る）。 */
function cellInfo(world, registry, x, y) {
  const a = powerDef(registry, world.at(x, y)), f = powerDef(registry, world.floorAt(x, y));
  if (!a && !f) return null;
  return {
    conducts: !!((a && a.conducts) || (f && f.conducts)),
    source: Math.max((a && a.source) || 0, (f && f.source) || 0),
  };
}

/** 電源から広げる。best: Map(key -> 強さ) に書き込む。starts: [{x, y, level}]、conducts(key) で電気を通すか */
function spread(best, starts, conducts) {
  const queue = [];
  for (const s of starts) {
    const k = key(s.x, s.y);
    if ((best.get(k) || 0) < s.level) { best.set(k, s.level); queue.push(s); }
  }
  for (let i = 0; i < queue.length; i++) {
    const { x, y } = queue[i];
    const lv = best.get(key(x, y));
    if (lv <= 1) continue;
    for (const d of DIRS) {
      const nx = x + DELTA[d].x, ny = y + DELTA[d].y;
      const nk = key(nx, ny);
      if ((best.get(nk) || 0) >= lv - 1) continue;
      if (!conducts(nk)) continue;
      best.set(nk, lv - 1);
      queue.push({ x: nx, y: ny, level: lv - 1 });
    }
  }
}

/** 盤面全体の電力。戻り値: Map(key(x, y) -> 強さ) */
export function computePower(world, registry) {
  const best = new Map();
  const starts = [];
  const conduct = new Set();
  world.forEach(b => {
    const p = powerDef(registry, b);
    if (!p) return;
    for (const c of footprint(b.x, b.y, b.size, b.dir)) {
      if (p.conducts) conduct.add(key(c.x, c.y));
      if (p.source > 0) starts.push({ x: c.x, y: c.y, level: p.source + 1 });
    }
  });
  spread(best, starts, k => conduct.has(k));
  return best;
}

/**
 * seeds（変わったマス）とその隣につながる電線網だけを計算し直し、power を書き換える。
 * 戻り値: 計算し直したマスの配列（電気が要る建物の判定をやり直す範囲）。
 */
export function updatePower(world, registry, power, seeds) {
  const net = new Map();           // key -> {x, y, source}
  const queue = [];
  const outside = new Set();       // 網に入らないと分かったマス（何度も調べない）
  const visit = (x, y) => {
    const k = key(x, y);
    if (net.has(k) || outside.has(k)) return;
    const info = cellInfo(world, registry, x, y);
    if (!info || (!info.conducts && !info.source)) { outside.add(k); return; }
    net.set(k, { x, y, source: info.source, conducts: info.conducts });
    queue.push({ x, y });
  };
  for (const s of seeds) {
    visit(s.x, s.y);
    for (const d of DIRS) visit(s.x + DELTA[d].x, s.y + DELTA[d].y);
  }
  for (let i = 0; i < queue.length; i++) {
    const { x, y } = queue[i];
    for (const d of DIRS) visit(x + DELTA[d].x, y + DELTA[d].y);
  }
  // 網の中だけで計算し、結果を power へ書き戻す（消えた建物のマスは消す）。
  // 大きな Map から消して入れ直すのを繰り返すと遅くなるので、値が残るマスは上書きだけにする
  const fresh = new Map();
  const starts = [];
  for (const c of net.values()) if (c.source) starts.push({ x: c.x, y: c.y, level: c.source + 1 });
  spread(fresh, starts, k => { const c = net.get(k); return !!(c && c.conducts); });
  const touched = [...seeds];
  for (const s of seeds) { const k = key(s.x, s.y); if (!fresh.has(k)) power.delete(k); }
  for (const [k, c] of net) {
    const v = fresh.get(k);
    if (v) power.set(k, v); else power.delete(k);
    touched.push(c);
  }
  for (const s of seeds) { const k = key(s.x, s.y); const v = fresh.get(k); if (v) power.set(k, v); }
  return touched;
}

/** その建物が動けるか。電気が要らない建物は常に true。 */
export function isPowered(power, registry, b) {
  const p = powerDef(registry, b);
  if (!p || !p.needs) return true;
  return footprint(b.x, b.y, b.size, b.dir).some(c => (power.get(key(c.x, c.y)) || 0) >= 1);
}
