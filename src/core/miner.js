/* 採掘機。下にある鉱脈から、決まった間隔で鉱石を掘り出して正面へ出す。
 *
 * 規則（Phase 3 で決めたもの。Core Keeper の実機の挙動ではない）:
 *   - 鉱脈は World の地面の層（world.resources）。建物と重ねて置ける。いまは掘っても減らない
 *   - data の miner.periodSeconds ごとに miner.amount 個掘る
 *   - 下に鉱脈が何種類かあれば、マスを順番に回って掘る
 *   - 出し先は正面の「左前」のマス（向いた方向から見て左側）。
 *     ベルトならその上へ、それ以外は**そのマスの床に落ちる**（ベルトの行き止まりと同じ）
 *   - 出し先が盤面の外なら止まる
 *   - 電力は Phase 4。今は電力なしで動く
 */

import { footprint, inBounds, rotatedSize } from './grid.js';
import { pileMerge, pilePush } from './inventory.js';

export const MINER_STATE = { WORKING: '採掘中', NO_RESOURCE: '鉱脈なし', BLOCKED: '出し先が盤面の外' };

export function minerDef(registry, building) {
  const def = building && registry.building(building.type);
  return def && def.miner ? def.miner : null;
}

export function makeMiner() {
  return { progress: 0, cursor: 0, state: MINER_STATE.NO_RESOURCE };
}

/** 掘り出した物を出すマス（向いた方向から見て左前）。 */
export function minerOutput(b) {
  const { width: w, height: h } = rotatedSize(b.size, b.dir);
  switch (b.dir) {
    case 'N': return { x: b.x, y: b.y - 1 };
    case 'E': return { x: b.x + w, y: b.y };
    case 'S': return { x: b.x + w - 1, y: b.y + h };
    default:  return { x: b.x - 1, y: b.y + h - 1 };   // W
  }
}

/** 採掘機の下にある鉱脈のマス。 */
export function minerDeposits(world, b) {
  return footprint(b.x, b.y, b.size, b.dir)
    .map(c => ({ ...c, item: world.resourceAt(c.x, c.y) }))
    .filter(c => c.item);
}

export function stepMiners(sim) {
  const { world, registry } = sim;
  for (const [id, m] of sim.miners) {
    const b = world.buildings.get(id);
    const def = minerDef(registry, b);
    if (!def) continue;
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
