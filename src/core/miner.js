/* 採掘機。**正面のマスの鉱脈**から、決まった間隔で鉱石を掘り出して**背面**へ出す。
 *
 * 規則（Phase 3 で決めたもの。Core Keeper の実機の挙動ではない）:
 *   - 鉱脈は World の地面の層（world.resources）。建物と重ねて置ける。いまは掘っても減らない
 *   - data の miner.periodSeconds ごとに miner.amount 個掘る
 *   - 掘るのは正面のマス（ユーザーが選択。Core Keeper のドリルと同じ向き）。
 *     大きな採掘機なら正面の列のマスを順番に回って掘る
 *   - 出し先は**背面**（向きの逆）のマス。ユーザーの指摘（Core Keeper の挙動）に合わせた。
 *     ベルトならその上へ、それ以外は**そのマスの床に落ちる**（ベルトの行き止まりと同じ）
 *   - 出し先が盤面の外なら止まる
 *   - data の power.needs があれば、電気が届いていないと止まる（進み具合は保つ）
 */

import { DELTA, footprint, inBounds, key, rotatedSize } from './grid.js';
import { pileMerge, pilePush } from './inventory.js';

export const MINER_STATE = { WORKING: '採掘中', NO_RESOURCE: '鉱脈なし', BLOCKED: '出し先が盤面の外', NO_POWER: '電力なし' };

export function minerDef(registry, building) {
  const def = building && registry.building(building.type);
  return def && def.miner ? def.miner : null;
}

export function makeMiner() {
  return { progress: 0, cursor: 0, state: MINER_STATE.NO_RESOURCE };
}

/** 掘り出した物を出すマス（背面。1x1 なら向きの逆隣）。 */
export function minerOutput(b) {
  const { width: w, height: h } = rotatedSize(b.size, b.dir);
  switch (b.dir) {
    case 'N': return { x: b.x, y: b.y + h };
    case 'E': return { x: b.x - 1, y: b.y };
    case 'S': return { x: b.x, y: b.y - 1 };
    default:  return { x: b.x + w, y: b.y };          // W
  }
}

/** 採掘機が掘るマス（正面の列）。 */
export function minerTargets(b) {
  const own = footprint(b.x, b.y, b.size, b.dir);
  const inside = new Set(own.map(c => key(c.x, c.y)));
  const d = DELTA[b.dir];
  return own.map(c => ({ x: c.x + d.x, y: c.y + d.y })).filter(c => !inside.has(key(c.x, c.y)));
}

/** 正面の列にある鉱脈のマス。 */
export function minerDeposits(world, b) {
  return minerTargets(b)
    .map(c => ({ ...c, item: world.resourceAt(c.x, c.y) }))
    .filter(c => c.item);
}

export function stepMiners(sim) {
  const { world, registry } = sim;
  for (const [id, m] of sim.miners) {
    const b = world.buildings.get(id);
    const def = minerDef(registry, b);
    if (!def) continue;
    if (sim.unpowered.has(id)) { m.state = MINER_STATE.NO_POWER; continue; }
    const deposits = minerDeposits(world, b);
    if (!deposits.length) { m.state = MINER_STATE.NO_RESOURCE; m.progress = 0; continue; }
    const out = minerOutput(b);
    if (!inBounds(out.x, out.y, world.width, world.height)) { m.state = MINER_STATE.BLOCKED; continue; }
    m.state = MINER_STATE.WORKING;
    m.progress += 1;
    if (m.progress < Math.max(1, Math.round((def.periodSeconds || 1) * sim.tickHz))) continue;
    m.progress = 0;
    const d = deposits[m.cursor % deposits.length];
    m.cursor = (m.cursor + 1) % deposits.length;
    const n = def.amount || 1, limit = sim.limit(d.item);
    const target = world.at(out.x, out.y);
    if (target && sim.belts.has(target.id)) pilePush(sim.belts.get(target.id), d.item, n, limit);
    else pileMerge(sim.groundAt(out.x, out.y, true), d.item, n, limit);
    sim.produced[d.item] = (sim.produced[d.item] || 0) + n;
  }
}
