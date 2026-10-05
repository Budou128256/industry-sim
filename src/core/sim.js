/* Sim — 時間を進める本体。World（何がどこにあるか）の上に「中身」と「時間」を載せる。
 *
 * **描画も DOM も知らない。** あとで Web Worker へ移せるよう、ブラウザの API を使わない。
 *
 * 時間: 1秒 = 20 tick（corekeeper_layout/static/sim.js と同じ。出典は Core Keeper 日本語 Wiki の回路使用例）。
 * 1 tick の順番: ベルト → アーム（sim.js と同じ）。
 *
 * 中身の持ち方:
 *   belts      建物 id -> スタックの列（ベルトの上）
 *   containers 建物 id -> { slots }（保管箱）
 *   ground     "x,y"   -> スタックの列（床。同じ種類は1つの山にまとまる）
 *
 * World は編集で変わる。step() の前に sync() で追いつく。
 *   - 撤去された建物の中身は、その建物があったマスの床に落とす
 *   - 回転（撤去して同じ場所に置き直す）では中身を引き継ぐ
 */

import { key } from './grid.js';
import { buildBeltLines, stepBelts } from './belt.js';
import { inserterDef, stepInserters } from './inserter.js';
import { containerAdd, containerTotal, makeContainer, pileMerge, pilePush, pileTotal, stackLimit } from './inventory.js';

export const TICK_HZ = 20;

export class Sim {
  constructor(world, registry) {
    this.world = world;
    this.registry = registry;
    this.tickHz = TICK_HZ;
    this.tick = 0;
    this.belts = new Map();
    this.containers = new Map();
    this.ground = new Map();
    this.beltLines = [];
    this.inserters = [];
    this.events = [];          // このtickにアームが動かしたもの
    this.busy = new Set();     // このtickに動いたアームの id
    this.known = new Map();    // id -> { type, x, y }  前回 sync した時点の建物
    this.rev = -1;
    this.sync();
  }

  cellKey(x, y) { return key(x, y); }
  limit(item) { return stackLimit(this.registry, item); }

  /** 床のスタックの列。create が真なら無ければ作る。 */
  groundAt(x, y, create = false) {
    const k = key(x, y);
    let list = this.ground.get(k);
    if (!list && create) { list = []; this.ground.set(k, list); }
    return list || null;
  }

  dropToGround(x, y, stacks) {
    for (const st of stacks) pileMerge(this.groundAt(x, y, true), st.item, st.count, this.limit(st.item));
  }

  /** World の変更に追いつく。 */
  sync() {
    const world = this.world;
    if (world.revision === this.rev) return;
    this.rev = world.revision;

    const removed = [];
    for (const [id, old] of this.known) if (!world.buildings.has(id)) removed.push({ id, ...old });

    world.forEach(b => {
      if (this.known.has(b.id)) return;
      // 同じ種類が同じ場所から消えていれば、回しただけ。中身を引き継ぐ
      const i = removed.findIndex(r => r.type === b.type && r.x === b.x && r.y === b.y);
      if (i >= 0) {
        const r = removed.splice(i, 1)[0];
        this.move(r.id, b.id);
        return;
      }
      const def = this.registry.building(b.type) || {};
      if (def.belt) this.belts.set(b.id, []);
      if (def.container) this.containers.set(b.id, makeContainer(def.container.slots || 1));
    });

    for (const r of removed) {
      if (this.belts.has(r.id)) this.dropToGround(r.x, r.y, this.belts.get(r.id));
      if (this.containers.has(r.id)) {
        this.dropToGround(r.x, r.y, this.containers.get(r.id).slots.filter(Boolean));
      }
      this.belts.delete(r.id);
      this.containers.delete(r.id);
    }

    this.known = new Map();
    world.forEach(b => this.known.set(b.id, { type: b.type, x: b.x, y: b.y }));
    this.beltLines = buildBeltLines(world, this.registry);
    const ins = [];
    world.forEach(b => { if (inserterDef(this.registry, b)) ins.push(b); });
    this.inserters = ins.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  }

  move(fromId, toId) {
    for (const m of [this.belts, this.containers]) {
      if (m.has(fromId)) { m.set(toId, m.get(fromId)); m.delete(fromId); }
    }
  }

  /** 1 tick 進める。 */
  step() {
    this.sync();
    this.tick += 1;
    this.events = [];
    this.busy.clear();
    stepBelts(this);
    stepInserters(this);
    return this.tick;
  }

  /** 1秒ぶん進める。 */
  stepSecond() {
    for (let i = 0; i < this.tickHz; i++) this.step();
    return this.tick;
  }

  get seconds() { return this.tick / this.tickHz; }

  /** アイテムを置く（動作確認用）。保管箱なら中へ、ベルトなら上へ、それ以外は床へ。 */
  addItems(x, y, item, count) {
    this.sync();
    const limit = this.limit(item);
    const b = this.world.at(x, y);
    if (b && this.belts.has(b.id)) { pilePush(this.belts.get(b.id), item, count, limit); return 'belt'; }
    if (b && this.containers.has(b.id)) {
      const left = count - containerAdd(this.containers.get(b.id), item, count, limit);
      if (left > 0) pileMerge(this.groundAt(x, y, true), item, left, limit);
      return 'container';
    }
    pileMerge(this.groundAt(x, y, true), item, count, limit);
    return 'ground';
  }

  /** そのマスの中身（画面の表示用）。 */
  contentsAt(x, y) {
    this.sync();
    const b = this.world.at(x, y);
    const out = { ground: this.groundAt(x, y) || [] };
    if (b && this.belts.has(b.id)) out.belt = this.belts.get(b.id);
    if (b && this.containers.has(b.id)) out.container = this.containers.get(b.id);
    return out;
  }

  totals() {
    let onBelts = 0, inContainers = 0, onGround = 0;
    for (const l of this.belts.values()) onBelts += pileTotal(l);
    for (const c of this.containers.values()) inContainers += containerTotal(c);
    for (const l of this.ground.values()) onGround += pileTotal(l);
    return { tick: this.tick, seconds: this.seconds, onBelts, inContainers, onGround };
  }

  /** 保存用。建物の id は保存しないので、中身は座標で持つ。 */
  toJSON() {
    this.sync();
    const at = id => { const b = this.world.buildings.get(id); return { x: b.x, y: b.y }; };
    const copy = list => list.map(s => (s ? { item: s.item, count: s.count } : null));
    return {
      version: 1,
      tick: this.tick,
      belts: [...this.belts].filter(([, l]) => l.length).map(([id, l]) => ({ ...at(id), stacks: copy(l) })),
      containers: [...this.containers].filter(([, c]) => containerTotal(c))
        .map(([id, c]) => ({ ...at(id), slots: copy(c.slots) })),
      ground: [...this.ground].filter(([, l]) => l.length).map(([k, l]) => {
        const [x, y] = k.split(',').map(Number);
        return { x, y, stacks: copy(l) };
      }),
    };
  }

  /** toJSON の逆。World は先に World.fromJSON で作っておく。 */
  static fromJSON(data, world, registry) {
    const sim = new Sim(world, registry);
    sim.tick = data.tick || 0;
    for (const e of data.belts || []) {
      const b = world.at(e.x, e.y);
      if (b && sim.belts.has(b.id)) sim.belts.set(b.id, e.stacks.map(s => ({ ...s })));
    }
    for (const e of data.containers || []) {
      const b = world.at(e.x, e.y);
      if (!b || !sim.containers.has(b.id)) continue;
      const ch = sim.containers.get(b.id);
      e.slots.forEach((s, i) => { if (s && i < ch.slots.length) ch.slots[i] = { ...s }; });
    }
    for (const e of data.ground || []) sim.ground.set(key(e.x, e.y), e.stacks.map(s => ({ ...s })));
    return sim;
  }
}
