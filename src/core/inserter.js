/* アーム（インサータ）。**正面のマスから取り、背面のマスへ置く。**
 *
 * 規則（corekeeper_layout/static/sim.js と同じ。Core Keeper の実機確認に基づく）:
 *   - 決まった間隔（data の inserter.periodSeconds）に1回動く
 *   - 1回に1スタック丸ごと持つ（amount が数値なら、その数まで）
 *   - 取る順: そのマスの建物の中身（ベルト → 保管箱 → 加工機の出力）、空なら**そのマスの床**
 *   - 加工機へ置くと入力へ入る。扱えない物・入力と違う種類の物は入らず床へ（machine.js）
 *   - 置き先に入りきらない分は、**置こうとしたマスの床**に落とす。
 *     「置けないから拾わない」ではなく、拾って溢れさせる
 *   - 置き先がベルトなら、その上に載る（何スタックでも載る）
 *   - 置き先が盤面の外なら動かない
 *   - data の power.needs があれば、電気が届いていないと動かない
 */

import { DELTA, OPPOSITE, inBounds } from './grid.js';
import { beltDef } from './belt.js';
import { containerAdd, containerPeek, containerTake, pileMerge, pilePush } from './inventory.js';
import { machinePut, machineTake } from './machine.js';

export function inserterDef(registry, building) {
  const def = building && registry.building(building.type);
  return def && def.inserter ? def.inserter : null;
}

export function inserterPeriod(def, tickHz) {
  return Math.max(1, Math.round((def.periodSeconds || 1) * tickHz));
}

/** 取るマスと置くマス。 */
export function inserterCells(b) {
  const f = DELTA[b.dir], back = DELTA[OPPOSITE[b.dir]];
  return {
    from: { x: b.x + f.x, y: b.y + f.y },
    to: { x: b.x + back.x, y: b.y + back.y },
  };
}

/** そのマスから1スタック取り出す。取れなければ null。 */
function takeFrom(sim, cell, max) {
  const b = sim.world.at(cell.x, cell.y);
  if (b && sim.belts.has(b.id)) {
    const list = sim.belts.get(b.id);
    if (list.length) return takePart(list, 0, max);
  } else if (b && sim.containers.has(b.id)) {
    const ch = sim.containers.get(b.id);
    const top = containerPeek(ch);
    if (top) {
      const got = containerTake(ch, top.slot, Math.min(max, top.count));
      return { item: top.item, count: got };
    }
  } else if (b && sim.machines.has(b.id)) {
    const got = machineTake(sim.machines.get(b.id), max);
    if (got) return got;
  }
  const ground = sim.groundAt(cell.x, cell.y);
  if (ground && ground.length) {
    const got = takePart(ground, 0, max);
    if (!ground.length) sim.ground.delete(sim.cellKey(cell.x, cell.y));
    return got;
  }
  return null;
}

function takePart(list, i, max) {
  const st = list[i];
  const n = Math.min(max, st.count);
  st.count -= n;
  if (st.count <= 0) list.splice(i, 1);
  return { item: st.item, count: n };
}

/** そのマスへ置く。入りきらない分はそのマスの床へ。床に落ちた数を返す。 */
function deliverTo(sim, cell, item, count) {
  const limit = sim.limit(item);
  const b = sim.world.at(cell.x, cell.y);
  let left = count;
  if (b && beltDef(sim.registry, b)) {
    pilePush(sim.belts.get(b.id), item, left, limit);
    left = 0;
  } else if (b && sim.containers.has(b.id)) {
    left -= containerAdd(sim.containers.get(b.id), item, left, limit);
  } else if (b && sim.machines.has(b.id)) {
    left -= machinePut(sim.registry, b, sim.machines.get(b.id), item, left);
  }
  if (left > 0) pileMerge(sim.groundAt(cell.x, cell.y, true), item, left, limit);
  return left;
}

/** このtickで動くアームを全部動かす。上の行から、同じ行なら左から（順序を固定）。 */
export function stepInserters(sim) {
  for (const b of sim.inserters) {
    const def = inserterDef(sim.registry, b);
    if (sim.unpowered.has(b.id)) continue;            // 電気が届いていない
    if (sim.tick % inserterPeriod(def, sim.tickHz) !== 0) continue;
    const { from, to } = inserterCells(b);
    const { width, height } = sim.world;
    if (!inBounds(from.x, from.y, width, height) || !inBounds(to.x, to.y, width, height)) continue;
    const max = typeof def.amount === 'number' ? def.amount : Infinity;
    const got = takeFrom(sim, from, max);
    if (!got || got.count <= 0) continue;
    const spilled = deliverTo(sim, to, got.item, got.count);
    sim.busy.add(b.id);
    sim.events.push({ tick: sim.tick, by: b.id, from, to, item: got.item, count: got.count, spilled });
  }
}
