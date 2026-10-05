/* 写し（core/snapshot.js）を、renderer が読む World / Sim と同じ形に戻したもの。
 *
 * renderer と placement の canPlace は、World なら at / floorAt / resourceAt / buildingsIn / resources、
 * Sim なら power / unpowered / busy / belts / containers / machines / miners / ground を読む。
 * ここではそれを写しから作る。写しに入っているのは画面に映る範囲だけなので、その外は「何も無い」に見える。
 */

import { footprint, key } from '../core/grid.js';
import { ChunkLayer } from '../core/chunks.js';

export class ViewWorld {
  constructor(snap) {
    this.width = snap.width;
    this.height = snap.height;
    this.count = snap.count;
    this.rect = snap.rect;
    this.buildings = new Map();
    this.occupancy = new ChunkLayer();
    this.floor = new ChunkLayer();
    this.resources = new ChunkLayer();
    for (const b of snap.buildings) {
      this.buildings.set(b.id, b);
      const layer = b.layer === 'floor' ? this.floor : this.occupancy;
      for (const c of footprint(b.x, b.y, b.size, b.dir)) layer.set(c.x, c.y, b.id);
    }
    for (const [x, y, item] of snap.resources) this.resources.set(x, y, item);
  }

  at(x, y) { const id = this.occupancy.get(x, y); return id === undefined ? null : this.buildings.get(id); }
  floorAt(x, y) { const id = this.floor.get(x, y); return id === undefined ? null : this.buildings.get(id); }
  resourceAt(x, y) { return this.resources.get(x, y) || null; }
  forEach(fn) { for (const b of this.buildings.values()) fn(b); }

  buildingsIn(x0, y0, x1, y1) {
    const seen = new Set(), out = [];
    const take = (x, y, id) => { if (!seen.has(id)) { seen.add(id); out.push(this.buildings.get(id)); } };
    this.floor.forEachIn(x0, y0, x1, y1, take);
    this.occupancy.forEachIn(x0, y0, x1, y1, take);
    return out;
  }

  /** 写しに入っている範囲か（その外は分からない）。 */
  covers(x, y) {
    const r = this.rect;
    return x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
  }
}

export class ViewSim {
  constructor(snap) {
    this.tick = snap.tick;
    this.seconds = snap.seconds;
    this.power = new Map(snap.power.map(([x, y, lv]) => [key(x, y), lv]));
    this.unpowered = new Set(snap.unpowered);
    this.busy = new Set(snap.busy);
    this.belts = new Map(snap.belts);
    this.containers = new Map(snap.containers);
    this.machines = new Map(snap.machines);
    this.miners = new Map(snap.miners);
    this.ground = new Map(snap.ground.map(([x, y, list]) => [key(x, y), list]));
  }

  sync() {}
}
