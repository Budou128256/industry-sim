/* World — 盤面の状態の持ち主。
 *
 * ここが唯一「いま何がどこにあるか」を知っている場所。
 * **描画も DOM も知らない。** 後で Web Worker に移せるよう、ブラウザのAPIを使わない。
 *
 * いまは 1 枚のマップとして持つが、Chunk へ広げられるよう
 * 外から見える操作（at / add / remove / forEach）だけを使ってもらう。
 */

import { footprint, key } from './grid.js';

let nextId = 1;

export class World {
  constructor({ width = 64, height = 64 } = {}) {
    this.width = width;
    this.height = height;
    /** @type {Map<number, object>} id -> building */
    this.buildings = new Map();
    /** @type {Map<string, number>} "x,y" -> building id（設置物の層） */
    this.occupancy = new Map();
    /** @type {Map<string, number>} "x,y" -> building id（床の層。電線など。設置物と同じマスに置ける） */
    this.floor = new Map();
    /** @type {Map<string, string>} "x,y" -> 鉱脈のアイテム id（地面の層。建物とは重ねて置ける） */
    this.resources = new Map();
    /** 変更のたびに増える。描画側が「描き直すべきか」を判断するのに使う。 */
    this.revision = 0;
  }

  /** そのマスにある建物。無ければ null。 */
  at(x, y) {
    const id = this.occupancy.get(key(x, y));
    return id === undefined ? null : this.buildings.get(id);
  }

  /** そのマスの床の層の建物（電線など）。無ければ null。 */
  floorAt(x, y) {
    const id = this.floor.get(key(x, y));
    return id === undefined ? null : this.buildings.get(id);
  }

  /** 層ごとの占有表。 */
  layerMap(layer) { return layer === 'floor' ? this.floor : this.occupancy; }

  /** 建物を1つ置く。重なりの判定は placement.js が先に行う前提。layer は 'object'（既定）か 'floor'。 */
  add({ type, x, y, dir = 'N', size, layer = 'object' }) {
    const b = { id: nextId++, type, x, y, dir, size, layer };
    this.buildings.set(b.id, b);
    const occ = this.layerMap(layer);
    for (const c of footprint(x, y, size, dir)) occ.set(key(c.x, c.y), b.id);
    this.revision++;
    return b;
  }

  /** 建物を取り除く。取り除いた建物を返す（無ければ null）。 */
  remove(building) {
    if (!building || !this.buildings.has(building.id)) return null;
    const occ = this.layerMap(building.layer);
    for (const c of footprint(building.x, building.y, building.size, building.dir)) {
      if (occ.get(key(c.x, c.y)) === building.id) occ.delete(key(c.x, c.y));
    }
    this.buildings.delete(building.id);
    this.revision++;
    return building;
  }

  /** そのマスの鉱脈（アイテム id）。無ければ null。 */
  resourceAt(x, y) {
    return this.resources.get(key(x, y)) || null;
  }

  /** 鉱脈を置く。item が null なら取り除く。 */
  setResource(x, y, item) {
    const k = key(x, y);
    if ((this.resources.get(k) || null) === item) return;
    if (item) this.resources.set(k, item); else this.resources.delete(k);
    this.revision++;
  }

  /** 置いてある建物を順に渡す。 */
  forEach(fn) {
    for (const b of this.buildings.values()) fn(b);
  }

  get count() { return this.buildings.size; }

  /** 保存用の素のデータにする（Phase 6 でサーバへ送る形の原型）。 */
  toJSON() {
    return {
      version: 1,
      width: this.width,
      height: this.height,
      buildings: [...this.buildings.values()].map(({ type, x, y, dir }) => ({ type, x, y, dir })),
      resources: [...this.resources].map(([k, item]) => {
        const [x, y] = k.split(',').map(Number);
        return { x, y, item };
      }),
    };
  }

  /** toJSON の逆。建物の大きさは registry から引き直す。 */
  static fromJSON(data, registry) {
    const w = new World({ width: data.width, height: data.height });
    for (const b of data.buildings || []) {
      const def = registry.building(b.type);
      if (!def) continue;                 // 知らない建物は黙って飛ばす（データが増減しても壊れない）
      w.add({ type: b.type, x: b.x, y: b.y, dir: b.dir || 'N', size: def.size, layer: def.layer || 'object' });
    }
    for (const r of data.resources || []) w.setResource(r.x, r.y, r.item);
    return w;
  }
}
