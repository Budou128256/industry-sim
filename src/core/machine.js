/* 加工機（炉など）。レシピに従って、入力を1つずつ製品に変える。
 *
 * 規則（corekeeper_layout/static/sim.js の stepProcessors / put と同じ）:
 *   - 入力1スタック・出力1スタックだけを持つ
 *   - アームが置いた物は入力へ。**その機械が扱えない物・入力と違う種類の物は入らない**
 *     （アーム側で、置こうとしたマスの床に落ちる。かまどにインゴットが入って詰まるのを防ぐ）
 *   - アームが取るのは出力だけ
 *   - 1回の加工にレシピの craftTime 秒。材料を inputs の数だけ使い、outputs を出す
 *   - 出力が違う種類で埋まっている、または上限を超えるなら止まる
 *   - data の power.needs があれば、電気が届いていないと止まる
 *
 * data の machine.outputFront が真の機械（送り出し加工機。ユーザーの依頼 2026-10-06）:
 *   - できた製品を、向いている方向（正面）のマスへ自分で送り出す。アームが要らない
 *   - 正面がベルト・スプリッターならその上へ、それ以外はそのマスの床へ（採掘機と同じ）
 *   - 正面が盤面の外なら送れずに出力に溜まり、満杯になれば止まる
 *   - 材料の入れ方は炉と同じ（アームで入れる）
 *
 * 扱えるレシピは、data/recipes の machines にその建物の id が入っているもの。
 * いまは**材料1種類・製品1種類**のレシピだけを扱う（入力が1スタックのため）。
 */

import { DELTA, inBounds } from './grid.js';
import { pileMerge, pilePush, stackLimit } from './inventory.js';

export const STATE = { WORKING: '稼働中', WAITING: '原料待ち', FULL: '出力が満杯', NO_POWER: '電力なし' };

export function machineDef(registry, building) {
  const def = building && registry.building(building.type);
  return def && def.machine ? def.machine : null;
}

export function makeMachine() {
  return { input: null, output: null, progress: 0, state: STATE.WAITING };
}

/** その機械で、その材料から作れるレシピ。無ければ null。 */
export function recipeFor(registry, type, item) {
  for (const r of registry.recipes.values()) {
    if (!(r.machines || []).includes(type)) continue;
    const ins = Object.keys(r.inputs || {}), outs = Object.keys(r.outputs || {});
    if (ins.length === 1 && outs.length === 1 && ins[0] === item) return r;
  }
  return null;
}

/** 入力へ入る分だけ入れて、入れた数を返す。 */
export function machinePut(registry, building, m, item, n) {
  if (!recipeFor(registry, building.type, item)) return 0;   // 扱えない物は入らない
  const limit = stackLimit(registry, item);
  if (!m.input) {
    const got = Math.min(n, limit);
    m.input = { item, count: got };
    return got;
  }
  if (m.input.item !== item) return 0;                         // 入力は1スタックだけ
  const got = Math.min(n, limit - m.input.count);
  m.input.count += got;
  return got;
}

/** 出力から取る。 */
export function machineTake(m, max) {
  if (!m.output) return null;
  const n = Math.min(max, m.output.count);
  m.output.count -= n;
  const got = { item: m.output.item, count: n };
  if (m.output.count <= 0) m.output = null;
  return got;
}

/** その機械の1回の加工にかかる tick。 */
export function craftTicks(recipe, tickHz) {
  return Math.max(1, Math.round((recipe.craftTime || 1) * tickHz));
}

/** 送り出し加工機が製品を出すマス（正面）。 */
export function machineOutputCell(b) {
  const d = DELTA[b.dir || 'N'];
  return { x: b.x + d.x, y: b.y + d.y };
}

/** 出力を正面のマスへ送り出す（outputFront の機械だけ）。 */
function pushOutput(sim, b, m) {
  if (!m.output) return;
  const { world } = sim;
  const out = machineOutputCell(b);
  if (!inBounds(out.x, out.y, world.width, world.height)) return;   // 送れない。出力に溜まる
  const { item, count } = m.output;
  const limit = sim.limit(item);
  const target = world.at(out.x, out.y);
  if (target && sim.belts.has(target.id)) pilePush(sim.belts.get(target.id), item, count, limit);
  else pileMerge(sim.groundAt(out.x, out.y, true), item, count, limit);
  m.output = null;
}

/**
 * 送り出し加工機の出力を正面へ送り出す。ベルトの後に呼ぶ（送り出したばかりの物が同じ tick に1マス進まないように。採掘機と同じ）。
 */
export function stepMachineOutputs(sim) {
  for (const [id, m] of sim.machines) {
    if (!m.output) continue;
    const b = sim.world.buildings.get(id);
    if (b && (machineDef(sim.registry, b) || {}).outputFront) pushOutput(sim, b, m);
  }
}

/** 全部の加工機を1 tick 進める。 */
export function stepMachines(sim) {
  const { registry } = sim;
  for (const [id, m] of sim.machines) {
    const b = sim.world.buildings.get(id);
    if (!b) continue;
    if (sim.unpowered.has(id)) { m.state = STATE.NO_POWER; continue; }
    const recipe = m.input && recipeFor(registry, b.type, m.input.item);
    const need = recipe ? Object.values(recipe.inputs)[0] : 0;
    if (!recipe || m.input.count < need) { m.state = STATE.WAITING; m.progress = 0; continue; }
    const [outItem, made] = Object.entries(recipe.outputs)[0];
    if (m.output && (m.output.item !== outItem
        || m.output.count + made > stackLimit(registry, outItem))) {
      m.state = STATE.FULL;
      continue;
    }
    m.state = STATE.WORKING;
    m.progress += 1;
    if (m.progress < craftTicks(recipe, sim.tickHz)) continue;
    m.progress = 0;
    m.input.count -= need;
    if (m.input.count <= 0 || m.input.count < need) {
      if (m.input.count <= 0) m.input = null;
      m.state = STATE.WAITING;               // 次の材料が足りない
    }
    if (m.output) m.output.count += made;
    else m.output = { item: outItem, count: made };
    sim.produced[outItem] = (sim.produced[outItem] || 0) + made;
  }
}
