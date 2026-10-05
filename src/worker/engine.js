/* エンジン。World と Sim を持ち、画面からの命令を実行して、時間を進める（Phase 5b）。
 *
 * ふだんは Web Worker（worker.js）の中で動く。Worker が使えないブラウザでは、
 * 画面と同じスレッドでそのまま動かす（client.js）。どちらでも同じ命令・同じ返事。
 *
 * 命令: { id, op, ...引数 } → 返事: { re: id, result } か { re: id, error }
 * 画面へは、変わったときに写し { type: 'view', snap } を送る。
 * 画面が描き終えて 'ack' を返すまで次の写しは送らない（描くのが遅いときに写しが溜まらないように）。
 */

import { World } from '../core/world.js';
import { Sim, TICK_HZ } from '../core/sim.js';
import { PathPlacer, canPlace, place, removeAt, rotateAt } from '../core/placement.js';
import { makeSnapshot } from '../core/snapshot.js';
import { key } from '../core/grid.js';

/** 画面の範囲の外にも少し余分に入れる（電線のつながりや、端の建物を描くため）。 */
const MARGIN = 2;

export class Engine {
  /** post: 画面へ送る関数（Worker なら postMessage） */
  constructor(registry, post, { width = 64, height = 64 } = {}) {
    this.registry = registry;
    this.post = post;
    this.size = { width, height };
    this.reset();
    this.rect = { x0: 0, y0: 0, x1: -1, y1: -1 };
    this.running = false;
    this.timer = null;
    this.waiting = false;     // 画面が前の写しを描き終えていない
    this.dirty = true;
  }

  reset() {
    this.world = new World(this.size);
    this.sim = new Sim(this.world, this.registry);
  }

  /** 画面からの命令を1つ実行する。 */
  handle(msg) {
    if (msg.op === 'ack') { this.waiting = false; this.flush(); return; }
    let reply;
    try {
      const fn = this[`op_${msg.op}`];
      if (!fn) throw new Error(`知らない命令: ${msg.op}`);
      reply = { re: msg.id, result: fn.call(this, msg) };
    } catch (e) {
      reply = { re: msg.id, error: e.message };
    }
    if (msg.id !== undefined) this.post(reply);
    this.flush();
  }

  /** 変わっていて、画面が待っていれば写しを送る。 */
  flush() {
    if (!this.dirty || this.waiting) return;
    this.dirty = false;
    this.waiting = true;
    this.post({ type: 'view', snap: makeSnapshot(this.world, this.sim, this.rect) });
  }

  changed() { this.dirty = true; }

  /* ---------- 命令 ---------- */

  op_view({ rect }) {
    this.rect = { x0: rect.x0 - MARGIN, y0: rect.y0 - MARGIN, x1: rect.x1 + MARGIN, y1: rect.y1 + MARGIN };
    this.changed();
  }

  /** cells: [{ x, y, dir }] を順に置く。戻り値: 置けた数と、最後に置けなかった理由 */
  op_place({ type, cells }) {
    const def = this.registry.building(type);
    let placed = 0, reason = null, last = null;
    for (const c of cells) {
      const check = canPlace(this.world, def, c.x, c.y, c.dir);
      if (!check.ok) { reason = check.reason; continue; }
      place(this.world, def, c.x, c.y, c.dir);
      placed++; last = c;
    }
    if (placed) this.changed();
    return { placed, reason, last };
  }

  /** ドラッグで置き始める（押したマス）。続きは dragTo。 */
  op_dragStart({ type, x, y, dir }) {
    this.drag = new PathPlacer(this.world, this.registry, this.registry.building(type), dir);
    const r = this.drag.start(x, y);
    this.changed();
    return r;
  }

  /** ドラッグの続き。cells: 前のマスから上下左右に隣り合う順のマス */
  op_dragTo({ cells }) {
    if (!this.drag) return { placed: 0, reason: null, last: null };
    const r = this.drag.extend(cells);
    this.changed();
    return r;
  }

  op_remove({ x, y }) {
    const b = removeAt(this.world, x, y);
    if (b) this.changed();
    return b ? { type: b.type } : null;
  }

  op_rotate({ x, y }) {
    const b = rotateAt(this.world, this.registry, x, y);
    if (b) this.changed();
    return b ? { type: b.type, dir: b.dir } : null;
  }

  /** 鉱脈を置く（item が null なら消す）。cells: [{ x, y }] */
  op_resource({ item, cells }) {
    if (item && !(this.registry.item(item) || {}).resource) return { ok: false };
    for (const c of cells) {
      if (c.x < 0 || c.y < 0 || c.x >= this.world.width || c.y >= this.world.height) continue;
      this.world.setResource(c.x, c.y, item);
    }
    this.changed();
    return { ok: true };
  }

  op_items({ x, y, item, count }) {
    const w = this.world;
    if (x < 0 || y < 0 || x >= w.width || y >= w.height) return { where: null };
    const where = this.sim.addItems(x, y, item, count);
    this.changed();
    return { where };
  }

  op_clear() {
    this.op_pause();
    this.drag = null;
    this.reset();
    this.changed();
  }

  op_step({ ticks = 1 }) {
    this.op_pause();
    for (let i = 0; i < ticks; i++) this.sim.step();
    this.changed();
    return { tick: this.sim.tick };
  }

  op_play() {
    if (this.running) return;
    this.running = true;
    let last = Date.now(), carry = 0;
    const loop = () => {
      if (!this.running) return;
      const now = Date.now();
      carry += Math.min(1, (now - last) / 1000) * TICK_HZ;   // 遅れても一度に進めるのは1秒まで
      last = now;
      let moved = false;
      while (carry >= 1) { this.sim.step(); carry -= 1; moved = true; }
      if (moved) { this.changed(); this.flush(); }
      this.timer = setTimeout(loop, 1000 / TICK_HZ / 2);
    };
    this.timer = setTimeout(loop, 0);
  }

  op_pause() {
    this.running = false;
    clearTimeout(this.timer);
  }

  /** そのマスの中身（画面の「中身を見る」用）。 */
  op_inspect({ x, y }) {
    const { world, sim } = this;
    const c = sim.contentsAt(x, y);
    const b = world.at(x, y);
    const wire = world.floorAt(x, y);
    return {
      building: b && { type: b.type, x: b.x, y: b.y, dir: b.dir },
      unpowered: !!(b && sim.unpowered.has(b.id)),
      power: sim.power.get(key(x, y)) || 0,
      wire: wire && wire.type,
      belt: c.belt || null,
      container: c.container ? { slots: c.container.slots } : null,
      machine: c.machine || null,
      miner: c.miner ? { state: c.miner.state } : null,
      ground: c.ground,
      resource: c.resource || null,
    };
  }
}
