/* チャンク。盤面を CHUNK x CHUNK マスの区画に分けて、マスごとの値を持つ。
 *
 * World の「層」（設置物・床・鉱脈）はこれで持つ。
 *   - 区画は何かが置かれたときに初めて作る（何も無い所は記憶を使わない）
 *   - マスを引くのは「区画を1回引いて、配列の添字」なので、"x,y" の文字列で引くより速い
 *   - 範囲（画面に映っている所など）を、範囲にかかる区画だけ見て回れる
 *
 * **描画も DOM も知らない。** World と同じく Web Worker へ移せる。
 */

import { CHUNK } from './grid.js';

const AREA = CHUNK * CHUNK;
const SPAN = 8192, OFF = 4096;

/** 区画の鍵。grid.js の key と同じく、小さな整数に収める（Map が速い）。 */
const chunkKey = (cx, cy) => (cy + OFF) * SPAN + (cx + OFF);

export class ChunkLayer {
  constructor() {
    /** @type {Map<number, { cx:number, cy:number, cells:Array, count:number }>} */
    this.chunks = new Map();
    this.size = 0;              // 値の入っているマスの数
  }

  chunk(x, y, create = false) {
    const cx = Math.floor(x / CHUNK), cy = Math.floor(y / CHUNK);
    const k = chunkKey(cx, cy);
    let c = this.chunks.get(k);
    if (!c && create) {
      c = { cx, cy, cells: new Array(AREA).fill(undefined), count: 0 };
      this.chunks.set(k, c);
    }
    return c;
  }

  get(x, y) {
    const c = this.chunk(x, y);
    if (!c) return undefined;
    return c.cells[(y - c.cy * CHUNK) * CHUNK + (x - c.cx * CHUNK)];
  }

  set(x, y, value) {
    const c = this.chunk(x, y, true);
    const i = (y - c.cy * CHUNK) * CHUNK + (x - c.cx * CHUNK);
    if (c.cells[i] === undefined) { c.count++; this.size++; }
    c.cells[i] = value;
  }

  delete(x, y) {
    const c = this.chunk(x, y);
    if (!c) return false;
    const i = (y - c.cy * CHUNK) * CHUNK + (x - c.cx * CHUNK);
    if (c.cells[i] === undefined) return false;
    c.cells[i] = undefined;
    c.count--; this.size--;
    if (!c.count) this.chunks.delete(chunkKey(c.cx, c.cy));   // 空になった区画は捨てる
    return true;
  }

  clear() {
    this.chunks.clear();
    this.size = 0;
  }

  /** 値の入っている全マス: fn(x, y, value) */
  forEach(fn) {
    for (const c of this.chunks.values()) this.eachIn(c, 0, 0, CHUNK - 1, CHUNK - 1, fn);
  }

  /** 矩形 [x0..x1] x [y0..y1]（両端を含む）の中の値の入っているマス: fn(x, y, value) */
  forEachIn(x0, y0, x1, y1, fn) {
    const cx0 = Math.floor(x0 / CHUNK), cx1 = Math.floor(x1 / CHUNK);
    const cy0 = Math.floor(y0 / CHUNK), cy1 = Math.floor(y1 / CHUNK);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = this.chunks.get(chunkKey(cx, cy));
        if (!c) continue;
        const bx = cx * CHUNK, by = cy * CHUNK;
        this.eachIn(c, Math.max(0, x0 - bx), Math.max(0, y0 - by),
                    Math.min(CHUNK - 1, x1 - bx), Math.min(CHUNK - 1, y1 - by), fn);
      }
    }
  }

  eachIn(c, lx0, ly0, lx1, ly1, fn) {
    const bx = c.cx * CHUNK, by = c.cy * CHUNK;
    for (let ly = ly0; ly <= ly1; ly++) {
      for (let lx = lx0; lx <= lx1; lx++) {
        const v = c.cells[ly * CHUNK + lx];
        if (v !== undefined) fn(bx + lx, by + ly, v);
      }
    }
  }
}
