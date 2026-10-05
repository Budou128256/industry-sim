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

import { DELTA, inBounds } from './grid.js';
import { pileMerge, pilePush } from './inventory.js';

/** ベルトの定義（data の belt）。ベルトでなければ null。 */
export function beltDef(registry, building) {
  const def = building && registry.building(building.type);
  return def && def.belt ? def.belt : null;
}

export function frontCell(b) {
  return { x: b.x + DELTA[b.dir].x, y: b.y + DELTA[b.dir].y };
}

/** 盤面のベルトを線にまとめる。戻り値: [{ ids:[後ろ→先頭], ring, type }] */
export function buildBeltLines(world, registry) {
  const belts = [];
  world.forEach(b => { if (beltDef(registry, b)) belts.push(b); });
  belts.sort((a, b) => (a.y - b.y) || (a.x - b.x));   // 順序を固定（結果を毎回同じにする）

  const next = new Map();       // id -> 次のベルトの id
  const feeders = new Map();    // id -> 入ってくるベルトの数
  for (const b of belts) {
    const f = frontCell(b);
    const n = world.at(f.x, f.y);
    if (n && n.type === b.type && beltDef(registry, n) && n.id !== b.id) {
      next.set(b.id, n.id);
      feeders.set(n.id, (feeders.get(n.id) || 0) + 1);
    }
  }
  // 同じ線に続けてよいか（次のベルトへ入るのが自分だけ）
  const continues = id => next.has(id) && feeders.get(next.get(id)) === 1;
  const continued = new Set();   // 前のベルトから同じ線として続いてくるベルト
  for (const id of next.keys()) if (continues(id)) continued.add(next.get(id));

  const lines = [];
  const seen = new Set();
  const walk = start => {
    const ids = [start];
    seen.add(start);
    let cur = start;
    while (continues(cur) && !seen.has(next.get(cur))) {
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
  // 残ったものは輪（どこから始めても同じ）
  for (const b of belts) {
    if (seen.has(b.id)) continue;
    lines.push({ ids: walk(b.id), ring: true, type: b.type });
  }
  return lines;
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
    } else if (target && beltDef(registry, target)) {
      incoming.push([target.id, lists[lists.length - 1].splice(0)]);
    } else if (def.onBlocked !== 'stop') {
      for (const st of lists[lists.length - 1].splice(0)) {
        pileMerge(sim.groundAt(out.x, out.y, true), st.item, st.count, sim.limit(st.item));
      }
    }

    // 線の中で1マスずつ前へ
    for (let i = lists.length - 1; i > 0; i--) lists[i].push(...lists[i - 1].splice(0));
  }

  // 別の線（合流先・違う種類のベルト）へ渡す。今tickはもう動かない
  for (const [id, stacks] of incoming) {
    const dst = sim.belts.get(id);
    for (const st of stacks) pilePush(dst, st.item, st.count, sim.limit(st.item));
  }
}
