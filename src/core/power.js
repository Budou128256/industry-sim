/* 電力。発電機から「電気を通すマス」をたどって届く範囲と強さを求める。
 *
 * 規則（corekeeper_layout/static/sim.js の computePower と同じ考え方）:
 *   - data の power.source を持つ建物（発電機）が電源。強さ source で出す
 *   - 電気を通すのは power.conducts を持つ建物（電線・電気を使う機械）のマス
 *   - 上下左右にたどり、1マス進むごとに強さが1下がる。0 になったら届かない
 *   - 「24ブロック先まで供給」= 隣のマスが強さ 24、24マス先が 1。
 *     そのため電源自身のマスは source + 1 から数える（sim.js と同じ）
 *   - power.needs を持つ建物は、自分のどれかのマスに強さ 1 以上が届いていないと動かない
 */

import { DIRS, DELTA, footprint, key, parseKey } from './grid.js';

export function powerDef(registry, building) {
  const def = building && registry.building(building.type);
  return (def && def.power) || null;
}

/** 盤面全体の電力。戻り値: Map("x,y" -> 強さ) */
export function computePower(world, registry) {
  const conduct = new Set();
  const best = new Map();
  const queue = [];
  world.forEach(b => {
    const p = powerDef(registry, b);
    if (!p) return;
    const cells = footprint(b.x, b.y, b.size, b.dir).map(c => key(c.x, c.y));
    if (p.conducts) for (const k of cells) conduct.add(k);
    if (p.source > 0) {
      for (const k of cells) {
        if ((best.get(k) || 0) < p.source + 1) { best.set(k, p.source + 1); queue.push(k); }
      }
    }
  });
  for (let i = 0; i < queue.length; i++) {
    const k = queue[i];
    const lv = best.get(k);
    if (lv <= 1) continue;
    const { x, y } = parseKey(k);
    for (const d of DIRS) {
      const nk = key(x + DELTA[d].x, y + DELTA[d].y);
      if (!conduct.has(nk)) continue;
      if ((best.get(nk) || 0) < lv - 1) { best.set(nk, lv - 1); queue.push(nk); }
    }
  }
  return best;
}

/** その建物が動けるか。電気が要らない建物は常に true。 */
export function isPowered(power, registry, b) {
  const p = powerDef(registry, b);
  if (!p || !p.needs) return true;
  return footprint(b.x, b.y, b.size, b.dir).some(c => (power.get(key(c.x, c.y)) || 0) >= 1);
}
