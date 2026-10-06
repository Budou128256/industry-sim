/* スプリッター（ベルトの分岐。Phase 7）。
 *
 * 規則（Core Keeper の Conveyor Belt Splitter。出典: https://corekeeper.atma.gg/en/Conveyor_Belt_Splitter ）:
 *   - 入ってきたスタックを半分に分けて、反対の2方向（背面と正面）へ送る
 *   - 半端な数のときは、多い方を背面と正面へ交互に送る。最初は背面
 *   - 1個だけのスタックも「多い方 1・少ない方 0」として交互に送る
 *   - ベルトは**横（左右）から**入る。正面・背面から向かってくるベルトは入らず、ベルトの行き止まりと同じく床に落ちる
 *     （入口の向きは資料に無く、ユーザーが選択 2026-10-06）
 * 資料に無いので仮に決めたこと（ゲームで違えば data かここを直す）:
 *   - アーム・採掘機はどの向きからでも入れられる
 *   - 送る間隔はベルトと同じ（data の splitter.tilesPerSecond）
 *   - 出し先がベルトでもスプリッターでもなければ、そのマスの床に落とす。盤面の外へは送らずに残す
 *
 * 中身は sim.belts（ベルトと同じ入れ物）に持つ。アーム・保存・撤去・画面はベルトと同じに扱える。
 * 次に多い方を送る向きは sim.splitState（id -> { next: 'back' | 'front' }）。
 */

import { DELTA, OPPOSITE, inBounds } from './grid.js';
import { beltDef } from './belt.js';
import { pileMerge } from './inventory.js';

export function splitterDef(registry, building) {
  const def = building && registry.building(building.type);
  return def && def.splitter ? def.splitter : null;
}

export function makeSplitterState() {
  return { next: 'back' };
}

/** 出し先のマス。 */
export function splitterOutputs(b) {
  const f = DELTA[b.dir], k = DELTA[OPPOSITE[b.dir]];
  return {
    front: { x: b.x + f.x, y: b.y + f.y },
    back: { x: b.x + k.x, y: b.y + k.y },
  };
}

/** (fromX, fromY) のマスから送られてきた物を受け取るか（横からだけ受け取る）。 */
export function splitterAccepts(registry, s, fromX, fromY) {
  if (!splitterDef(registry, s)) return false;
  const d = DELTA[s.dir];
  const dx = fromX - s.x, dy = fromY - s.y;
  if (Math.abs(dx) + Math.abs(dy) !== 1) return false;
  return dx * d.x + dy * d.y === 0;       // 向きと直角（横）
}

/** スタックを半分にする。戻り値: { back, front } の個数。state.next を進める。 */
export function splitStack(count, state) {
  const small = Math.floor(count / 2), big = count - small;
  if (big === small) return { back: big, front: small };
  const out = state.next === 'back' ? { back: big, front: small } : { back: small, front: big };
  state.next = state.next === 'back' ? 'front' : 'back';
  return out;
}

export function splitterPeriod(def, tickHz) {
  return Math.max(1, Math.round(tickHz / (def.tilesPerSecond || 1)));
}

/**
 * このtickで動くスプリッターを動かす。incoming: [[受け取る id, stacks]]（stepBelts と共有。全部動かしてから置く）
 * 順序は上の行から、同じ行なら左から（結果を毎回同じにする）。
 */
export function stepSplitters(sim, incoming) {
  const { world, registry } = sim;
  const list = [];
  for (const id of sim.splitState.keys()) { const b = world.buildings.get(id); if (b) list.push(b); }
  list.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  for (const s of list) {
    const def = splitterDef(registry, s);
    if (sim.tick % splitterPeriod(def, sim.tickHz) !== 0) continue;
    const stacks = sim.belts.get(s.id);
    if (!stacks || !stacks.length) continue;
    const state = sim.splitState.get(s.id);
    const outs = splitterOutputs(s);
    const keep = [];
    for (const st of stacks.splice(0)) {
      const parts = splitStack(st.count, state);
      for (const side of ['back', 'front']) {
        if (parts[side] > 0) send(sim, s, outs[side], st.item, parts[side], incoming, keep);
      }
    }
    stacks.push(...keep);
  }
}

function send(sim, s, cell, item, count, incoming, keep) {
  const { world, registry } = sim;
  if (!inBounds(cell.x, cell.y, world.width, world.height)) { keep.push({ item, count }); return; }
  const target = world.at(cell.x, cell.y);
  if (target && (beltDef(registry, target) || splitterAccepts(registry, target, s.x, s.y))) {
    incoming.push([target.id, [{ item, count }]]);
    return;
  }
  pileMerge(sim.groundAt(cell.x, cell.y, true), item, count, sim.limit(item));
}
