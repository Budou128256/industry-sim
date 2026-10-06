/* Sim — 時間を進める本体。World（何がどこにあるか）の上に「中身」と「時間」を載せる。
 *
 * **描画も DOM も知らない。** あとで Web Worker へ移せるよう、ブラウザの API を使わない。
 *
 * 時間: 1秒 = 20 tick（corekeeper_layout/static/sim.js と同じ。出典は Core Keeper 日本語 Wiki の回路使用例）。
 * 1 tick の順番: 加工機 → ベルト → 採掘機 → 送り出し加工機の送り出し → 回収機 → アーム（採掘機以外は sim.js と同じ順）。
 *
 * 中身の持ち方:
 *   belts      建物 id -> スタックの列（ベルトの上。スプリッターの中もここ）
 *   containers 建物 id -> { slots }（保管箱）
 *   machines   建物 id -> { input, output, progress, state }（加工機）
 *   ground     マスの鍵 -> スタックの列（床。同じ種類は1つの山にまとまる）
 *
 * World は編集で変わる。step() の前に sync() で追いつく（変わった所の近くだけ計算し直す）。
 *   - 撤去された建物の中身は、その建物があったマスの床に落とす
 *   - 回転（撤去して同じ場所に置き直す）では中身を引き継ぐ
 *   - 床に物が落ちているマスにベルトを敷くと、その物はベルトに載る
 */

import { footprint, key, parseKey } from './grid.js';
import { beltDef, buildBeltLines, sortBeltLines, stepBelts } from './belt.js';
import { inserterDef, stepInserters } from './inserter.js';
import { machinePut, makeMachine, stepMachineOutputs, stepMachines } from './machine.js';
import { makeMiner, stepMiners } from './miner.js';
import { makeCollector, stepCollectors } from './collector.js';
import { computeSignals, makeSignal, recordDelays } from './signal.js';
import { makeSplitterState } from './splitter.js';
import { computePower, isPowered, updatePower } from './power.js';
import { containerAdd, containerTotal, makeContainer, pileMerge, pilePush, pileTotal, stackLimit } from './inventory.js';

export const TICK_HZ = 20;

/** 上の行から、同じ行なら左から（アームを動かす順。結果を毎回同じにする）。 */
const byPosition = (a, b) => (a.y - b.y) || (a.x - b.x);

export class Sim {
  constructor(world, registry) {
    this.world = world;
    this.registry = registry;
    this.tickHz = TICK_HZ;
    this.tick = 0;
    this.belts = new Map();
    this.containers = new Map();
    this.machines = new Map();
    this.miners = new Map();     // 建物 id -> { progress, cursor, state }
    this.collectors = new Map(); // 回収機の id -> { progress, state }
    this.signals = new Map();    // レバー・感圧板・回路の id -> { on, level, history }（signal.js）
    this.signalSig = null;       // 回路の計算をし直すかの目印（signal.js）
    this.splitState = new Map(); // スプリッターの id -> { next }（中身は belts に持つ。Phase 7）
    this.moved = new Map();      // まとめて移動した建物の 元の id -> 新しい id（次の sync で中身を引き継ぐ）
    this.produced = {};        // 作った数の累計（item -> 個数）
    this.destroyed = {};       // 焼却炉で消した数の累計（item -> 個数）
    this.ground = new Map();
    this.beltLines = [];
    this.lineOf = new Map();     // ベルトの id -> そのベルトが入っている線
    this.power = new Map();      // マスの鍵（grid.js の key） -> 電力の強さ（World が変わった所だけ求め直す）
    this.unpowered = new Set();  // 電気が要るのに届いていない建物の id
    this.inserters = [];
    this.events = [];          // このtickにアームが動かしたもの
    this.busy = new Set();     // このtickに動いたアームの id
    this.known = new Map();    // id -> { type, x, y }  前回 sync した時点の建物
    this.rev = -1;
    this.sync();
  }

  cellKey(x, y) { return key(x, y); }
  signalType(id) { const b = this.world.buildings.get(id); return b && ((this.registry.building(b.type) || {}).signal || {}).type; }
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

  /**
   * World の変更に追いつく。
   * World の変更の記録（changes）が読めれば、変わった所の近くだけを計算し直す（Phase 5）。
   * 読めなければ（初回・記録が古すぎる）盤面全体を計算し直す。どちらでも結果は同じ。
   */
  sync() {
    const world = this.world;
    if (world.revision !== this.rev) {
      const changes = this.rev < 0 ? null : world.changesSince(this.rev);
      this.rev = world.revision;
      if (changes) this.syncChanges(changes);
      else this.syncAll();
    }
    if (this.signals.size) computeSignals(this);
    else if (this.signalSig) {             // 回路が無くなった: 普通の計算に戻す
      this.signalSig = null;
      this.power = computePower(this.world, this.registry);
      this.unpowered = new Set();
      this.world.forEach(b => { if (!isPowered(this.power, this.registry, b)) this.unpowered.add(b.id); });
    }
  }

  /** 盤面全体を見て追いつく。 */
  syncAll() {
    const world = this.world;
    const removed = [];
    for (const [id, old] of this.known) if (!world.buildings.has(id)) removed.push({ id, ...old });
    const added = [];
    world.forEach(b => { if (!this.known.has(b.id)) added.push(b); });
    this.applyContents(removed, added);

    this.known = new Map();
    world.forEach(b => this.known.set(b.id, { type: b.type, x: b.x, y: b.y }));
    this.beltLines = buildBeltLines(world, this.registry);
    this.lineOf = new Map();
    for (const l of this.beltLines) for (const id of l.ids) this.lineOf.set(id, l);
    this.power = computePower(world, this.registry);
    this.unpowered = new Set();
    world.forEach(b => { if (!isPowered(this.power, this.registry, b)) this.unpowered.add(b.id); });
    const ins = [];
    world.forEach(b => { if (inserterDef(this.registry, b)) ins.push(b); });
    this.inserters = ins.sort(byPosition);
  }

  /** 変更の記録から、変わった所の近くだけ追いつく。 */
  syncChanges(changes) {
    const { world, registry } = this;
    const removed = [], added = [], cells = [];
    let belts = false, power = false;
    for (const c of changes) {
      if (c.op === 'resource') continue;          // 鉱脈は採掘機が毎回 World から読む
      const b = c.building;
      const def = registry.building(b.type) || {};
      if (c.op === 'remove' && this.known.has(b.id)) removed.push({ id: b.id, ...this.known.get(b.id), building: b });
      if (c.op === 'add' && world.buildings.has(b.id) && !this.known.has(b.id)) added.push(b);
      for (const p of footprint(b.x, b.y, b.size, b.dir)) cells.push(p);
      if (def.belt) belts = true;
      if (def.power) power = true;
    }
    // 前の sync の後に置いてすぐ消した建物は、どちらにも入らない
    this.applyContents([...removed], added);      // 回した分は applyContents が removed から抜くので写しを渡す
    for (const r of removed) this.known.delete(r.id);
    for (const b of added) this.known.set(b.id, { type: b.type, x: b.x, y: b.y });

    if (belts) this.updateBeltLines(removed, cells);
    if (power) {
      const touched = updatePower(world, registry, this.power, cells);
      for (const r of removed) this.unpowered.delete(r.id);
      const check = new Set(added);
      for (const c of touched) for (const b of [world.at(c.x, c.y), world.floorAt(c.x, c.y)]) if (b) check.add(b);
      for (const b of check) {
        if (isPowered(this.power, registry, b)) this.unpowered.delete(b.id);
        else this.unpowered.add(b.id);
      }
    } else {
      for (const r of removed) this.unpowered.delete(r.id);
      for (const b of added) if (!isPowered(this.power, registry, b)) this.unpowered.add(b.id);
    }
    // アームの列: 並び順を保ったまま抜き差しする（全部を並べ直さない）
    for (const r of removed) {
      if (!inserterDef(registry, r.building)) continue;
      const i = this.inserters.findIndex(b => b.id === r.id);
      if (i >= 0) this.inserters.splice(i, 1);
    }
    for (const b of added) {
      if (!inserterDef(registry, b)) continue;
      let lo = 0, hi = this.inserters.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (byPosition(this.inserters[mid], b) < 0) lo = mid + 1; else hi = mid; }
      this.inserters.splice(lo, 0, b);
    }
  }

  /**
   * 変わったマスから2マス以内にかかるベルトの線だけ作り直す。
   * ベルトが同じ線で続くかは「自分・次のベルト・次のベルトの隣」で決まるので、2マス以内で足りる。
   */
  updateBeltLines(removed, cells) {
    const { world, registry } = this;
    const hit = new Set();
    for (const r of removed) hit.add(r.id);
    for (const c of cells) {
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2 + Math.abs(dy); dx <= 2 - Math.abs(dy); dx++) {
          const b = world.at(c.x + dx, c.y + dy);
          if (b && beltDef(registry, b)) hit.add(b.id);
        }
      }
    }
    const dropped = new Set();
    const subset = new Map();
    for (const id of hit) {
      const line = this.lineOf.get(id);
      if (line && !dropped.has(line)) {
        dropped.add(line);
        for (const lid of line.ids) this.lineOf.delete(lid);
        for (const lid of line.ids) { const b = world.buildings.get(lid); if (b) subset.set(lid, b); }
      }
      const b = world.buildings.get(id);
      if (b && beltDef(registry, b)) subset.set(id, b);
    }
    const fresh = buildBeltLines(world, registry, [...subset.values()]);
    for (const l of fresh) for (const id of l.ids) this.lineOf.set(id, l);
    this.beltLines = sortBeltLines(world, this.beltLines.filter(l => !dropped.has(l)).concat(fresh));
  }

  /** 撤去された建物の中身を床へ落とし、置かれた建物の中身の入れ物を作る。回しただけなら引き継ぐ。 */
  applyContents(removed, added) {
    const newBelts = [];
    // まとめて移動した建物は、元の建物の中身を引き継ぐ（added は呼び出し元でも使うので写しで扱う）
    if (this.moved.size) {
      added = added.slice();
      for (const b of added.slice()) {
        const i = removed.findIndex(r => this.moved.get(r.id) === b.id);
        if (i < 0) continue;
        this.move(removed.splice(i, 1)[0].id, b.id);
        added.splice(added.indexOf(b), 1);
        if (this.belts.has(b.id)) newBelts.push(b);      // 行き先の床の物も載せる
      }
      this.moved.clear();
    }
    for (const b of added) {
      // 同じ種類が同じ場所から消えていれば、回しただけ。中身を引き継ぐ
      const i = removed.findIndex(r => r.type === b.type && r.x === b.x && r.y === b.y);
      if (i >= 0) {
        const r = removed.splice(i, 1)[0];
        this.move(r.id, b.id);
        continue;
      }
      const def = this.registry.building(b.type) || {};
      if (def.belt || def.splitter) { this.belts.set(b.id, []); newBelts.push(b); }
      if (def.splitter) this.splitState.set(b.id, makeSplitterState());
      if (def.container) this.containers.set(b.id, makeContainer(def.container.slots || 1));
      if (def.machine) this.machines.set(b.id, makeMachine());
      if (def.miner) this.miners.set(b.id, makeMiner());
      if (def.collector) this.collectors.set(b.id, makeCollector());
      if (def.signal) this.signals.set(b.id, makeSignal(def.signal));
    }
    for (const r of removed) {
      if (this.belts.has(r.id)) this.dropToGround(r.x, r.y, this.belts.get(r.id));
      if (this.containers.has(r.id)) {
        this.dropToGround(r.x, r.y, this.containers.get(r.id).slots.filter(Boolean));
      }
      if (this.machines.has(r.id)) {
        const m = this.machines.get(r.id);
        this.dropToGround(r.x, r.y, [m.input, m.output].filter(Boolean));
      }
      this.belts.delete(r.id);
      this.containers.delete(r.id);
      this.machines.delete(r.id);
      this.miners.delete(r.id);
      this.collectors.delete(r.id);
      this.signals.delete(r.id);
      this.splitState.delete(r.id);
    }
    // 床に落ちている物の上にベルトを敷いたら、その物はベルトに載って流れる。
    // 撤去で落ちた物も拾えるよう、落とした後に拾う
    for (const b of newBelts) this.pickUpGround(b);
  }

  /** ベルトのマスの床の物を、そのベルトの上へ移す。 */
  pickUpGround(b) {
    const list = this.belts.get(b.id);
    const ground = this.groundAt(b.x, b.y);
    if (!list || !ground) return;
    for (const st of ground) pilePush(list, st.item, st.count, this.limit(st.item));
    this.ground.delete(key(b.x, b.y));
  }

  move(fromId, toId) {
    for (const m of [this.belts, this.containers, this.machines, this.miners, this.collectors, this.signals, this.splitState]) {
      if (m.has(fromId)) { m.set(toId, m.get(fromId)); m.delete(fromId); }
    }
  }

  /** 1 tick 進める。 */
  step() {
    this.sync();
    this.tick += 1;
    this.events = [];
    this.busy.clear();
    stepMachines(this);
    stepBelts(this);
    stepMiners(this);      // ベルトの後。出したばかりの物が同じ tick に1マス進まないように
    stepMachineOutputs(this);   // 送り出し加工機も同じ理由でベルトの後
    stepCollectors(this);       // 回収機も同じ理由でベルトの後
    stepInserters(this);
    if (this.signals.size) recordDelays(this);
    return this.tick;
  }

  /** 1秒ぶん進める。 */
  stepSecond() {
    for (let i = 0; i < this.tickHz; i++) this.step();
    return this.tick;
  }

  get seconds() { return this.tick / this.tickHz; }

  /** アイテムを置く（動作確認用）。保管箱・加工機なら中へ（入らない分は床へ）、ベルトなら上へ、それ以外は床へ。 */
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
    if (b && this.machines.has(b.id)) {
      const left = count - machinePut(this.registry, b, this.machines.get(b.id), item, count);
      if (left > 0) pileMerge(this.groundAt(x, y, true), item, left, limit);
      return left === count ? 'ground' : 'machine';
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
    if (b && this.machines.has(b.id)) out.machine = this.machines.get(b.id);
    if (b && this.miners.has(b.id)) out.miner = this.miners.get(b.id);
    if (b && this.collectors.has(b.id)) out.collector = this.collectors.get(b.id);
    if (b && this.signals.has(b.id)) out.signal = this.signals.get(b.id);
    const res = this.world.resourceAt(x, y);
    if (res) out.resource = res;
    return out;
  }

  totals() {
    let onBelts = 0, inContainers = 0, inMachines = 0, onGround = 0;
    for (const l of this.belts.values()) onBelts += pileTotal(l);
    for (const c of this.containers.values()) inContainers += containerTotal(c);
    for (const m of this.machines.values()) inMachines += pileTotal([m.input, m.output].filter(Boolean));
    for (const l of this.ground.values()) onGround += pileTotal(l);
    return { tick: this.tick, seconds: this.seconds, onBelts, inContainers, inMachines, onGround,
             produced: { ...this.produced }, destroyed: { ...this.destroyed } };
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
      machines: [...this.machines].filter(([, m]) => m.input || m.output || m.progress)
        .map(([id, m]) => ({ ...at(id), input: m.input && { ...m.input },
                             output: m.output && { ...m.output }, progress: m.progress, state: m.state })),
      miners: [...this.miners].filter(([, m]) => m.progress || m.cursor)
        .map(([id, m]) => ({ ...at(id), progress: m.progress, cursor: m.cursor })),
      levers: [...this.signals].filter(([id, st]) => st.on && this.signalType(id) === 'lever').map(([id]) => at(id)),
      splitters: [...this.splitState].filter(([, s]) => s.next !== 'back')
        .map(([id, s]) => ({ ...at(id), next: s.next })),
      produced: { ...this.produced },
      destroyed: { ...this.destroyed },
      ground: [...this.ground].filter(([, l]) => l.length).map(([k, l]) => {
        const { x, y } = parseKey(k);
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
    for (const e of data.machines || []) {
      const b = world.at(e.x, e.y);
      if (!b || !sim.machines.has(b.id)) continue;
      Object.assign(sim.machines.get(b.id), {
        input: e.input ? { ...e.input } : null, output: e.output ? { ...e.output } : null,
        progress: e.progress || 0, state: e.state || sim.machines.get(b.id).state,
      });
    }
    for (const e of data.miners || []) {
      const b = world.at(e.x, e.y);
      if (!b || !sim.miners.has(b.id)) continue;
      Object.assign(sim.miners.get(b.id), { progress: e.progress || 0, cursor: e.cursor || 0 });
    }
    for (const e of data.splitters || []) {
      const b = world.at(e.x, e.y);
      if (b && sim.splitState.has(b.id) && (e.next === 'back' || e.next === 'front')) sim.splitState.get(b.id).next = e.next;
    }
    for (const e of data.levers || []) {
      const b = world.at(e.x, e.y);
      const st = b && sim.signals.get(b.id);
      if (st && sim.signalType(b.id) === 'lever') st.on = true;
    }
    sim.signalSig = null;
    sim.produced = { ...(data.produced || {}) };
    sim.destroyed = { ...(data.destroyed || {}) };
    for (const e of data.ground || []) sim.ground.set(key(e.x, e.y), e.stacks.map(s => ({ ...s })));
    // 前の版で保存した、ベルトの下に残った床の物もベルトに載せる
    world.forEach(b => { if (sim.belts.has(b.id)) sim.pickUpGround(b); });
    return sim;
  }
}
