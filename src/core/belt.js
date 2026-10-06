/* ベルト。つながったベルトを1本の「線」にまとめて動かす。
 *
 * 規則（corekeeper_layout/static/sim.js と同じ。Core Keeper の実機確認に基づく）:
 *   - 1タイルに何スタックでも載る。スタックどうしは合体しない
 *   - 決まった間隔（data の belt.tilesPerSecond）で、載っている物を全部1マス先へ送る
 *   - 先がベルトならその上に載る。ベルトでなければ**そのマスの床に落ちる**
 *     （保管箱や機械が置かれていても中には入らない。受け渡しはアームの仕事）
 *   - onBlocked が "stop" のベルトは、先がベルトでないと進まずに溜まる
 *   - 盤面の外へは送らない（その場に溜まる）
 *
 * 線の作り方:
 *   ベルト b の「次」は、b の正面のマスにあるベルト。
 *   次のベルトへ入ってくるのが b だけなら同じ線を続け、
 *   横から合流しているベルトがあればそこで線を切る（合流先が新しい線の始まりになる）。
 *   ぐるっと一周しているベルトは「輪」として扱う。
 */

import { DELTA, DIRS, inBounds } from './grid.js';
import { pileMerge, pilePush } from './inventory.js';
import { splitterAccepts, stepSplitters } from './splitter.js';

/** ベルトの定義（data の belt）。ベルトでなければ null。 */
export function beltDef(registry, building) {
  const def = building && registry.building(building.type);
  return def && def.belt ? def.belt : null;
}

export function frontCell(b) {
  return { x: b.x + DELTA[b.dir].x, y: b.y + DELTA[b.dir].y };
}

/** b の次のベルト（正面のマスにある同じ種類のベルト）。無ければ null。 */
function nextBelt(world, registry, b) {
  const f = frontCell(b);
  const n = world.at(f.x, f.y);
  return n && n.type === b.type && n.id !== b.id && beltDef(registry, n) ? n : null;
}

/** n へ入ってくるベルトの数（上下左右から n を向いている同じ種類のベルト）。 */
function feederCount(world, registry, n) {
  let k = 0;
  for (const d of DIRS) {
    const p = world.at(n.x + DELTA[d].x, n.y + DELTA[d].y);
    if (p && p.id !== n.id && beltDef(registry, p)) {
      const q = nextBelt(world, registry, p);
      if (q && q.id === n.id) k++;
    }
  }
  return k;
}

/**
 * ベルトを線にまとめる。戻り値: [{ ids:[後ろ→先頭], ring, type }]
 * belts を渡すとそのベルトだけをまとめる（変わった所の近くだけ作り直すとき。Phase 5）。
 * 渡すベルトは「線の途中で切れない」まとまりであること（Sim.sync が線ごと渡す）。
 */
export function buildBeltLines(world, registry, belts = null) {
  if (!belts) {
    belts = [];
    world.forEach(b => { if (beltDef(registry, b)) belts.push(b); });
  }
  belts = [...belts].sort((a, b) => (a.y - b.y) || (a.x - b.x));   // 順序を固定（結果を毎回同じにする）

  const next = new Map();       // id -> 次のベルトの id（同じ線として続くときだけ）
  for (const b of belts) {
    const n = nextBelt(world, registry, b);
    // 次のベルトへ入るのが自分だけなら同じ線を続ける。合流していればそこで切る
    if (n && feederCount(world, registry, n) === 1) next.set(b.id, n.id);
  }
  const continued = new Set(next.values());   // 前のベルトから同じ線として続いてくるベルト

  const lines = [];
  const seen = new Set();
  const walk = start => {
    const ids = [start];
    seen.add(start);
    let cur = start;
    while (next.has(cur) && !seen.has(next.get(cur))) {
      cur = next.get(cur);
      ids.push(cur);
      seen.add(cur);
    }
    return ids;
  };
  for (const b of belts) {
    if (seen.has(b.id) || continued.has(b.id)) continue;
    lines.push({ ids: walk(b.id), ring: false, type: b.type });
  }
  // 残ったものは輪（どこから始めても同じ。いちばん上・左のベルトから）
  for (const b of belts) {
    if (seen.has(b.id)) continue;
    lines.push({ ids: walk(b.id), ring: true, type: b.type });
  }
  return lines;
}

/** 線の並び順（線の始まりのベルトの位置で決める。全部作り直しても一部だけでも同じ順になる）。 */
export function sortBeltLines(world, lines) {
  const pos = l => world.buildings.get(l.ids[0]);
  return lines.sort((a, b) => (a.ring - b.ring) || (pos(a).y - pos(b).y) || (pos(a).x - pos(b).x));
}

/** そのベルトが送る間隔（tick）。 */
export function beltPeriod(def, tickHz) {
  return Math.max(1, Math.round(tickHz / (def.tilesPerSecond || 1)));
}

/** このtickで動く線を1マスずつ進める。sim の belts（id -> スタックの列）と ground を書き換える。 */
export function stepBelts(sim) {
  const { world, registry } = sim;
  const incoming = [];      // [beltId, stacks]  別の線へ渡すもの（全部動かしてから置く）

  for (const line of sim.beltLines) {
    const head = world.buildings.get(line.ids[line.ids.length - 1]);
    const def = beltDef(registry, head);
    if (sim.tick % beltPeriod(def, sim.tickHz) !== 0) continue;
    const lists = line.ids.map(id => sim.belts.get(id));

    if (line.ring) {
      // 輪: 全部が1つずつ前へ。先頭の物は最後尾（＝先頭の次）へ戻る
      const last = lists[lists.length - 1].splice(0);
      for (let i = lists.length - 1; i > 0; i--) lists[i].push(...lists[i - 1].splice(0));
      lists[0].push(...last);
      continue;
    }

    // 先頭のベルトから外へ送り出す
    const out = frontCell(head);
    const target = world.at(out.x, out.y);
    // 送れないとき（盤面の外 / onBlocked が stop）は先頭に残り、後ろから来た物もそこへ積み重なる
    if (!inBounds(out.x, out.y, world.width, world.height)) {
      // 送らない
    } else if (target && (beltDef(registry, target) || splitterAccepts(registry, target, head.x, head.y))) {
      incoming.push([target.id, lists[lists.length - 1].splice(0)]);
    } else if (def.onBlocked !== 'stop') {
      for (const st of lists[lists.length - 1].splice(0)) {
        pileMerge(sim.groundAt(out.x, out.y, true), st.item, st.count, sim.limit(st.item));
      }
    }

    // 線の中で1マスずつ前へ
    for (let i = lists.length - 1; i > 0; i--) lists[i].push(...lists[i - 1].splice(0));
  }

  // スプリッター（Phase 7）。出す物も incoming に入れるので、今tickに2マス進むことはない
  if (sim.splitState.size) stepSplitters(sim, incoming);

  // 別の線（合流先・違う種類のベルト・スプリッター）へ渡す。今tickはもう動かない
  for (const [id, stacks] of incoming) {
    const dst = sim.belts.get(id);
    for (const st of stacks) pilePush(dst, st.item, st.count, sim.limit(st.item));
  }
}
