/* World — 盤面の状態の持ち主。
 *
 * ここが唯一「いま何がどこにあるか」を知っている場所。
 * **描画も DOM も知らない。** 後で Web Worker に移せるよう、ブラウザのAPIを使わない。
 *
 * マスごとの層（設置物・床・鉱脈）は**チャンク**（chunks.js）で持つ（Phase 5）。
 * 外からは at / floorAt / resourceAt / add / remove / forEach / buildingsIn を使ってもらう。
 *
 * 変更は changes に記録する。Sim はこれを読んで、変わった所の近くだけを計算し直す。
 */

import { footprint } from './grid.js';
import { ChunkLayer } from './chunks.js';

/** changes に残す数。これより古い変更を読みたい Sim は全部を計算し直す。 */
const CHANGE_LOG_LIMIT = 4096;

let nextId = 1;

export class World {
  constructor({ width = 64, height = 64 } = {}) {
    this.width = width;
    this.height = height;
    /** @type {Map<number, object>} id -> building */
    this.buildings = new Map();
    /** 設置物の層: マス -> building id */
    this.occupancy = new ChunkLayer();
    /** 床の層（電線など。設置物と同じマスに置ける）: マス -> building id */
    this.floor = new ChunkLayer();
    /** 地面の層（鉱脈。建物とは重ねて置ける）: マス -> アイテム id */
    this.resources = new ChunkLayer();
    /** 変更のたびに増える。描画側が「描き直すべきか」を判断するのに使う。 */
    this.revision = 0;
    /** 変更の記録: { rev, op: 'add' | 'remove' | 'resource', building?, x?, y? }（古いものから捨てる） */
    this.changes = [];
  }

  record(change) {
    change.rev = ++this.revision;
    this.changes.push(change);
    if (this.changes.length > CHANGE_LOG_LIMIT * 2) this.changes.splice(0, this.changes.length - CHANGE_LOG_LIMIT);
  }

  /** rev より後の変更。記録が足りない（古すぎる）ときは null。 */
  changesSince(rev) {
    if (rev === this.revision) return [];
    const first = this.changes.length ? this.changes[0].rev : this.revision + 1;
    if (rev < first - 1) return null;
    return this.changes.filter(c => c.rev > rev);
  }

  /** そのマスにある建物。無ければ null。 */
  at(x, y) {
    const id = this.occupancy.get(x, y);
    return id === undefined ? null : this.buildings.get(id);
  }

  /** そのマスの床の層の建物（電線など）。無ければ null。 */
  floorAt(x, y) {
    const id = this.floor.get(x, y);
    return id === undefined ? null : this.buildings.get(id);
  }

  /** 層ごとの占有表。 */
  layerMap(layer) { return layer === 'floor' ? this.floor : this.occupancy; }

  /** 建物を1つ置く。重なりの判定は placement.js が先に行う前提。layer は 'object'（既定）か 'floor'。 */
  add({ type, x, y, dir = 'N', size, layer = 'object' }) {
    const b = { id: nextId++, type, x, y, dir, size, layer };
    this.buildings.set(b.id, b);
    const occ = this.layerMap(layer);
    for (const c of footprint(x, y, size, dir)) occ.set(c.x, c.y, b.id);
    this.record({ op: 'add', building: b });
    return b;
  }

  /** 建物を取り除く。取り除いた建物を返す（無ければ null）。 */
  remove(building) {
    if (!building || !this.buildings.has(building.id)) return null;
    const occ = this.layerMap(building.layer);
    for (const c of footprint(building.x, building.y, building.size, building.dir)) {
      if (occ.get(c.x, c.y) === building.id) occ.delete(c.x, c.y);
    }
    this.buildings.delete(building.id);
    this.record({ op: 'remove', building });
    return building;
  }

  /** そのマスの鉱脈（アイテム id）。無ければ null。 */
  resourceAt(x, y) {
    return this.resources.get(x, y) || null;
  }

  /** 鉱脈を置く。item が null なら取り除く。 */
  setResource(x, y, item) {
    if ((this.resources.get(x, y) || null) === item) return;
    if (item) this.resources.set(x, y, item); else this.resources.delete(x, y);
    this.record({ op: 'resource', x, y });
  }

  /** 置いてある建物を順に渡す。 */
  forEach(fn) {
    for (const b of this.buildings.values()) fn(b);
  }

  get count() { return this.buildings.size; }

  /** 矩形 [x0..x1] x [y0..y1] に1マスでもかかっている建物（床の層を先に）。範囲にかかるチャンクだけ見る。 */
  buildingsIn(x0, y0, x1, y1) {
    const seen = new Set(), out = [];
    const take = (x, y, id) => { if (!seen.has(id)) { seen.add(id); out.push(this.buildings.get(id)); } };
    this.floor.forEachIn(x0, y0, x1, y1, take);
    this.occupancy.forEachIn(x0, y0, x1, y1, take);
    return out;
  }

  /** 保存用の素のデータにする（Phase 6 でサーバへ送る形の原型）。 */
  toJSON() {
    return {
      version: 1,
      width: this.width,
      height: this.height,
      buildings: [...this.buildings.values()].map(({ type, x, y, dir }) => ({ type, x, y, dir })),
      resources: (() => {
        const out = [];
        this.resources.forEach((x, y, item) => out.push({ x, y, item }));
        return out;
      })(),
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
