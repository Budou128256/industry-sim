/* 置ける / 置けないの規則と、設置・撤去。
 *
 * World は「状態の持ち主」、ここは「規則」。分けておくと、
 * 規則を増やしても World の形を変えずに済む（例: 地面の種類、建設コスト）。
 */

import { footprint, inBounds, rotateCW } from './grid.js';

/** 置けるか調べる。置けない理由も返す（画面に出すため）。 */
export function canPlace(world, def, x, y, dir = 'N') {
  if (!def) return { ok: false, reason: '知らない建物です' };
  const cells = footprint(x, y, def.size, dir);
  for (const c of cells) {
    if (!inBounds(c.x, c.y, world.width, world.height)) {
      return { ok: false, reason: '盤面の外です', cells };
    }
    if (world.at(c.x, c.y)) {
      return { ok: false, reason: 'すでに何か置いてあります', cells };
    }
  }
  return { ok: true, cells };
}

/** 置く。置けなければ null を返す（例外にしない。連続設置で毎回止まると困る）。 */
export function place(world, def, x, y, dir = 'N') {
  const check = canPlace(world, def, x, y, dir);
  if (!check.ok) return null;
  return world.add({ type: def.id, x, y, dir, size: def.size });
}

/** そのマスの建物を取り除く。取り除いた建物を返す。 */
export function removeAt(world, x, y) {
  return world.remove(world.at(x, y));
}

/** そのマスの建物を回す。向きを持たない建物は何もしない。 */
export function rotateAt(world, registry, x, y) {
  const b = world.at(x, y);
  if (!b) return null;
  const def = registry.building(b.type);
  if (!def || !def.directional) return null;
  const dir = rotateCW(b.dir);
  world.remove(b);
  const placed = place(world, def, b.x, b.y, dir);
  if (!placed) {                       // 回すと入らない（長方形の建物）なら元に戻す
    world.add({ type: b.type, x: b.x, y: b.y, dir: b.dir, size: b.size });
    return null;
  }
  return placed;
}

/** 直線のドラッグで通ったマスを列挙する（連続設置用）。 */
export function lineCells(from, to) {
  const cells = [];
  const dx = to.x - from.x, dy = to.y - from.y;
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  if (steps === 0) return [{ ...from }];
  // 長いほうの軸に沿ってまっすぐ引く（斜めには置かない）
  if (Math.abs(dx) >= Math.abs(dy)) {
    const s = Math.sign(dx);
    for (let i = 0; i <= Math.abs(dx); i++) cells.push({ x: from.x + i * s, y: from.y });
  } else {
    const s = Math.sign(dy);
    for (let i = 0; i <= Math.abs(dy); i++) cells.push({ x: from.x, y: from.y + i * s });
  }
  return cells;
}

/** ドラッグの向き（連続設置でベルトの向きを自動で決める）。 */
export function dragDirection(from, to) {
  const dx = to.x - from.x, dy = to.y - from.y;
  if (dx === 0 && dy === 0) return null;
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 'E' : 'W';
  return dy > 0 ? 'S' : 'N';
}
