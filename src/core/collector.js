/* 回収機（Core Keeper の Item Collector）。**正面の 5x5 マスの床の物を、背面のマスへ移す。**
 *
 * 資料: 「It collects all the items in a 5x5 square from in front of it and teleports them to behind it」
 *   （https://corekeeper.atma.gg/en/Item_Collector、2026-10-06 に確認）
 *
 * 規則（資料に無いところは仮に決めた。data で変えられる）:
 *   - 集めるのは**床の物だけ**（ベルトの上・箱の中は取らない）
 *   - 範囲は、正面の隣の列から奥へ collector.range マス、左右に (range-1)/2 マスずつ（range 5 なら 5x5）
 *   - collector.periodSeconds ごとに、範囲の床の物を**全部まとめて**移す（資料は「瞬間移動」。間隔は資料に無く仮に1秒）
 *   - 移す先は背面のマス。アームの置き方と同じ（ベルトなら上へ、箱・加工機なら中へ、入らない分は床）
 *   - 背面が盤面の外なら動かない
 *   - data の power.needs があれば、電気が届いていないと動かない
 */

import { DELTA, OPPOSITE, inBounds } from './grid.js';
import { deliverTo } from './inserter.js';

export const COLLECTOR_STATE = { WORKING: '稼働中', IDLE: '床に物なし', BLOCKED: '出し先が盤面の外', NO_POWER: '電力なし' };

export function collectorDef(registry, building) {
  const def = building && registry.building(building.type);
  return def && def.collector ? def.collector : null;
}

export function makeCollector() {
  return { progress: 0, state: COLLECTOR_STATE.IDLE };
}

/** 集める範囲のマス（手前の列から奥へ、各列は左から）。 */
export function collectorArea(b, range = 5) {
  const f = DELTA[b.dir || 'N'];
  const side = { x: -f.y, y: f.x };            // 向きに直角
  const half = Math.floor((range - 1) / 2);
  const out = [];
  for (let depth = 1; depth <= range; depth++) {
    for (let s = -half; s <= range - 1 - half; s++) {
      out.push({ x: b.x + f.x * depth + side.x * s, y: b.y + f.y * depth + side.y * s });
    }
  }
  return out;
}

/** 移す先（背面）のマス。 */
export function collectorOutput(b) {
  const d = DELTA[OPPOSITE[b.dir || 'N']];
  return { x: b.x + d.x, y: b.y + d.y };
}

export function stepCollectors(sim) {
  const { world, registry } = sim;
  for (const [id, c] of sim.collectors) {
    const b = world.buildings.get(id);
    const def = collectorDef(registry, b);
    if (!def) continue;
    if (sim.unpowered.has(id)) { c.state = COLLECTOR_STATE.NO_POWER; continue; }
    const out = collectorOutput(b);
    if (!inBounds(out.x, out.y, world.width, world.height)) { c.state = COLLECTOR_STATE.BLOCKED; continue; }
    c.progress += 1;
    if (c.progress < Math.max(1, Math.round((def.periodSeconds || 1) * sim.tickHz))) continue;
    c.progress = 0;
    let moved = 0;
    for (const cell of collectorArea(b, def.range || 5)) {
      if (!inBounds(cell.x, cell.y, world.width, world.height)) continue;
      const k = sim.cellKey(cell.x, cell.y);
      const list = sim.ground.get(k);
      if (!list || !list.length) continue;
      sim.ground.delete(k);
      for (const st of list) { deliverTo(sim, out, st.item, st.count); moved += st.count; }
    }
    c.state = moved ? COLLECTOR_STATE.WORKING : COLLECTOR_STATE.IDLE;
    if (moved) sim.busy.add(id);
  }
}
