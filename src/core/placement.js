/* 置ける / 置けないの規則と、設置・撤去。
 *
 * World は「状態の持ち主」、ここは「規則」。分けておくと、
 * 規則を増やしても World の形を変えずに済む（例: 地面の種類、建設コスト）。
 */

import { DELTA, footprint, inBounds, rotateCW } from './grid.js';

/** 置けるか調べる。置けない理由も返す（画面に出すため）。 */
export function canPlace(world, def, x, y, dir = 'N') {
  if (!def) return { ok: false, reason: '知らない建物です' };
  const cells = footprint(x, y, def.size, dir);
  for (const c of cells) {
    if (!inBounds(c.x, c.y, world.width, world.height)) {
      return { ok: false, reason: '盤面の外です', cells };
    }
    if (def.layer === 'floor' ? world.floorAt(c.x, c.y) : world.at(c.x, c.y)) {
      return { ok: false, reason: 'すでに何か置いてあります', cells };
    }
  }
  return { ok: true, cells };
}

/** 置く。置けなければ null を返す（例外にしない。連続設置で毎回止まると困る）。 */
export function place(world, def, x, y, dir = 'N', { filter = null } = {}) {
  const check = canPlace(world, def, x, y, dir);
  if (!check.ok) return null;
  return world.add({ type: def.id, x, y, dir, size: def.size, layer: def.layer || 'object', filter: def.inserter ? filter : null });
}

/** そのマスの建物を取り除く。設置物を先に、無ければ床の層（電線など）。取り除いた建物を返す。 */
export function removeAt(world, x, y) {
  return world.remove(world.at(x, y) || world.floorAt(x, y));
}

/** そのマスの建物を回す。向きを持たない建物は何もしない。 */
export function rotateAt(world, registry, x, y) {
  const b = world.at(x, y);
  if (!b) return null;
  const def = registry.building(b.type);
  if (!def || !def.directional) return null;
  const dir = rotateCW(b.dir);
  world.remove(b);
  const placed = place(world, def, b.x, b.y, dir, { filter: b.filter });
  if (!placed) {                       // 回すと入らない（長方形の建物）なら元に戻す
    world.add({ type: b.type, x: b.x, y: b.y, dir: b.dir, size: b.size, layer: b.layer, filter: b.filter });
    return null;
  }
  return placed;
}

/**
 * from から to へ、上下左右だけで進むマスを列挙する（from は含まず、to は含む）。
 * マウスは1回の動きで何マスも飛ぶので、その間を埋めるのに使う。斜めに進むところは横 → 縦の順に埋める。
 */
export function pathCells(from, to) {
  const cells = [];
  const dx = to.x - from.x, dy = to.y - from.y;
  const n = Math.max(Math.abs(dx), Math.abs(dy));
  let cur = { x: from.x, y: from.y };
  for (let i = 1; i <= n; i++) {
    const nx = from.x + Math.round(dx * i / n), ny = from.y + Math.round(dy * i / n);
    if (nx !== cur.x && ny !== cur.y) cells.push({ x: nx, y: cur.y });   // 斜めの1歩を2歩に分ける
    if (nx !== cur.x || ny !== cur.y) cells.push({ x: nx, y: ny });
    cur = { x: nx, y: ny };
  }
  return cells;
}

/** 隣り合う2マスの向き（a から b へ）。隣でなければ null。 */
export function stepDirection(a, b) {
  for (const [d, v] of Object.entries(DELTA)) if (a.x + v.x === b.x && a.y + v.y === b.y) return d;
  return null;
}

/** 建物を dir 向きにする（置き直す。入らなければ元に戻して null）。 */
export function turnTo(world, registry, b, dir) {
  if (b.dir === dir) return b;
  const def = registry.building(b.type);
  world.remove(b);
  const placed = place(world, def, b.x, b.y, dir, { filter: b.filter });
  if (!placed) {
    world.add({ type: b.type, x: b.x, y: b.y, dir: b.dir, size: b.size, layer: b.layer, filter: b.filter });
    return null;
  }
  return placed;
}

/**
 * ドラッグで、マウスの通った道どおりに置く（ユーザーの選択 2026-10-05）。
 *   - 通ったマスに順に置く。すでに何かあるマスは飛ばす（上書きしない）
 *   - 向きのある建物（ベルトなど）は進んだ向きにする。
 *     曲がったら、ひとつ前に置いた建物を新しい進む向きに回す（曲がり角でつながるように）
 *   - 回すのは、このドラッグで置いた直前の1つだけ。前からあった建物には触らない
 */
export class PathPlacer {
  constructor(world, registry, def, dir = 'N') {
    this.world = world;
    this.registry = registry;
    this.def = def;
    this.dir = dir;
    this.cursor = null;     // 最後に通ったマス
    this.last = null;       // このドラッグで最後に置いた建物（cursor にあるときだけ回す）
  }

  /** 押し始めのマス。 */
  start(x, y) {
    this.cursor = { x, y };
    return this.put([{ x, y }], true);
  }

  /** 続けて通ったマス（上下左右に隣り合う順）。 */
  extend(cells) {
    return this.put(cells, false);
  }

  put(cells, first) {
    const { world, registry, def } = this;
    const result = { placed: 0, reason: null, last: null };
    for (const c of cells) {
      const step = first ? null : stepDirection(this.cursor, c);
      const dir = def.directional ? (step || this.dir) : this.dir;
      const check = canPlace(world, def, c.x, c.y, dir);
      if (check.ok && def.directional && step && this.last
          && this.last.x === this.cursor.x && this.last.y === this.cursor.y && this.last.dir !== step) {
        const turned = turnTo(world, registry, this.last, step);     // 曲がり角: 直前の建物を進む向きへ
        if (turned) this.last = turned;
      }
      this.cursor = { x: c.x, y: c.y };
      if (!check.ok) { result.reason = check.reason; this.last = null; continue; }
      this.last = place(world, def, c.x, c.y, dir);
      result.placed++;
      result.last = { x: c.x, y: c.y, dir };
    }
    return result;
  }
}
