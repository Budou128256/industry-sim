/* アイテムの入れ物。保管箱のスロットと、「スタックの列」（ベルト・床）の共通処理。
 *
 * スタックは { item, count }。1スタックに入る数はアイテムの stackSize（data/items）。
 * ここは状態を持たない関数だけ。持ち主は sim.js。
 */

/** そのアイテムの1スタックの上限。 */
export function stackLimit(registry, item) {
  const def = registry.item(item);
  return (def && def.stackSize) || 100;
}

/* ---------- 保管箱（スロット） ---------- */

export function makeContainer(slots) {
  return { slots: new Array(slots).fill(null) };
}

/** 入る分だけ入れて、入れた数を返す。同じ種類のスタックを先に埋め、次に空きスロットを使う。 */
export function containerAdd(ch, item, count, limit) {
  let left = count;
  for (const s of ch.slots) {
    if (left <= 0) break;
    if (s && s.item === item && s.count < limit) {
      const n = Math.min(left, limit - s.count);
      s.count += n; left -= n;
    }
  }
  for (let i = 0; i < ch.slots.length && left > 0; i++) {
    if (ch.slots[i]) continue;
    const n = Math.min(left, limit);
    ch.slots[i] = { item, count: n }; left -= n;
  }
  return count - left;
}

/** 先頭から最初に見つかったスタック（消費しない）。slot はその位置。 */
export function containerPeek(ch) {
  const i = ch.slots.findIndex(s => s && s.count > 0);
  return i < 0 ? null : { ...ch.slots[i], slot: i };
}

/** 指定スロットから取る。取れた数を返す。 */
export function containerTake(ch, slot, n) {
  const s = ch.slots[slot];
  if (!s) return 0;
  const got = Math.min(n, s.count);
  s.count -= got;
  if (s.count <= 0) ch.slots[slot] = null;
  return got;
}

export function containerTotal(ch) {
  return ch.slots.reduce((a, s) => a + (s ? s.count : 0), 0);
}

/* ---------- スタックの列（ベルト・床） ---------- */

/** 新しいスタックとして後ろに積む。**既にあるスタックとは合体させない**（ベルトの上は1つ1つ別の存在）。 */
export function pilePush(list, item, n, limit) {
  let left = n;
  while (left > 0) {
    const take = Math.min(left, limit);
    list.push({ item, count: take });
    left -= take;
  }
}

/** 同じ種類の山にまとめて積む（床の上はまとまる）。 */
export function pileMerge(list, item, n, limit) {
  let left = n;
  for (const s of list) {
    if (s.item !== item || s.count >= limit) continue;
    const take = Math.min(left, limit - s.count);
    s.count += take; left -= take;
    if (left <= 0) return;
  }
  if (left > 0) pilePush(list, item, left, limit);
}

/** 先頭（＝先に来たもの）のスタックを1つ取り出す。 */
export function pileShift(list) {
  return list && list.length ? list.shift() : null;
}

export function pileTotal(list) {
  return list ? list.reduce((a, s) => a + s.count, 0) : 0;
}
