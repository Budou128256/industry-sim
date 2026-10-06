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
import { checkSize, countOutside, loadSave, makeSave, resizeSave } from '../core/save.js';
import { key } from '../core/grid.js';
import { toggleLever } from '../core/signal.js';
import { generateCircuits } from '../core/circuitgen.js';
import { generateLines } from '../core/linegen.js';
import { buildingsInside, captureBlueprint, checkBlueprint, moveArea, pasteBlueprint } from '../core/blueprint.js';
import { History, applyEntry } from '../core/history.js';

/** 画面の範囲の外にも少し余分に入れる（電線のつながりや、端の建物を描くため）。 */
const MARGIN = 2;

export class Engine {
  /** post: 画面へ送る関数（Worker なら postMessage） */
  constructor(registry, post, { width = 64, height = 64 } = {}) {
    this.registry = registry;
    this.post = post;
    this.size = { width, height };
    this.history = new History();     // 元に戻す / やり直す
    this.reset();
    this.rect = { x0: 0, y0: 0, x1: -1, y1: -1 };
    this.running = false;
    this.timer = null;
    this.waiting = false;     // 画面が前の写しを描き終えていない
    this.dirty = true;
    this.version = 0;         // 変わるたびに増える（画面が「保存し直すべきか」を判断するのに使う）
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
    const snap = makeSnapshot(this.world, this.sim, this.rect);
    snap.version = this.version;
    this.post({ type: 'view', snap });
  }

  changed() { this.dirty = true; this.version++; }

  /**
   * 置き方を変える操作を、元に戻せるように記録しながら行う。
   * group: 直前の記録に足す（ドラッグの続き）。open: 次の group で続きを足せるようにしておく
   */
  record(label, fn, { group = false, open = false } = {}) {
    const entry = this.history.begin(this.world, label, { group });
    let result;
    try { result = fn(entry); } finally { this.history.end(this.world, { open }); }
    return result;
  }

  /** セーブデータで盤面を入れ替える（読み込み・元に戻す）。 */
  replaceWith(data) {
    const { world, sim, skipped, savedAt } = loadSave(data, this.registry);
    this.op_pause();
    this.drag = null;
    this.world = world;
    this.sim = sim;
    this.size = { width: world.width, height: world.height };
    this.changed();
    return { world, sim, skipped, savedAt };
  }

  /* ---------- 命令 ---------- */

  op_view({ rect }) {
    this.rect = { x0: rect.x0 - MARGIN, y0: rect.y0 - MARGIN, x1: rect.x1 + MARGIN, y1: rect.y1 + MARGIN };
    this.dirty = true;          // 盤面は変わっていないので version は増やさない
  }

  /** cells: [{ x, y, dir }] を順に置く。戻り値: 置けた数と、最後に置けなかった理由 */
  op_place(args) { return this.record('設置', () => this.place(args)); }

  place({ type, cells }) {
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
    return this.record('設置', () => {
      this.drag = new PathPlacer(this.world, this.registry, this.registry.building(type), dir);
      const r = this.drag.start(x, y);
      this.changed();
      return r;
    }, { open: true });
  }

  /** ドラッグの続き。cells: 前のマスから上下左右に隣り合う順のマス */
  op_dragTo({ cells }) {
    if (!this.drag) return { placed: 0, reason: null, last: null };
    return this.record('設置', () => {
      const r = this.drag.extend(cells);
      this.changed();
      return r;
    }, { group: true, open: true });
  }

  op_remove({ x, y }) {
    const b = this.record('撤去', () => removeAt(this.world, x, y));
    if (b) this.changed();
    return b ? { type: b.type } : null;
  }

  op_rotate({ x, y }) {
    const b = this.record('回転', () => rotateAt(this.world, this.registry, x, y));
    if (b) this.changed();
    return b ? { type: b.type, dir: b.dir } : null;
  }

  /** 鉱脈を置く（item が null なら消す）。cells: [{ x, y }]。group: ドラッグの続き（元に戻すとき1回にまとめる） */
  op_resource({ item, cells, group = false }) {
    if (item && !(this.registry.item(item) || {}).resource) return { ok: false };
    this.record(item ? '鉱脈' : '鉱脈を消す', () => {
      for (const c of cells) {
        if (c.x < 0 || c.y < 0 || c.x >= this.world.width || c.y >= this.world.height) continue;
        this.world.setResource(c.x, c.y, item);
      }
    }, { group, open: true });
    this.changed();
    return { ok: true };
  }

  /** レバーを入れる・切る。レバーでなければ { on: null }。 */
  op_toggle({ x, y }) {
    this.sim.sync();
    const on = toggleLever(this.sim, x, y);
    if (on !== null) { this.sim.sync(); this.changed(); }
    return { on };
  }

  /** 回路の自動生成。table は長さ 2^n の真偽の並び（A が上の桁）。盤面は変えない。 */
  op_genCircuit({ n, table }) {
    return generateCircuits(this.registry, n, table);
  }

  /** アームのフィルタを決める（item が null なら全部運ぶ）。アームでなければ { ok: false }。 */
  op_filter({ x, y, item }) {
    const b = this.world.at(x, y);
    const def = b && this.registry.building(b.type);
    if (!def || !def.inserter) return { ok: false };
    if (item && !this.registry.item(item)) return { ok: false };
    if ((b.filter || null) === (item || null)) return { ok: true, item: item || null };
    // 置き直して記録する（元に戻す・やり直すにも乗る）。アームは中身を持たないので置き直しても困らない
    this.record(item ? 'アームのフィルタ' : 'フィルタを外す', () => {
      this.world.remove(b);
      place(this.world, def, b.x, b.y, b.dir, { filter: item || null });
    });
    this.changed();
    return { ok: true, item: item || null };
  }

  /** 機械の自動配置（生産ライン）。盤面は変えない。 */
  op_genLine(opts) {
    return generateLines(this.registry, opts);
  }

  op_items({ x, y, item, count }) {
    const w = this.world;
    if (x < 0 || y < 0 || x >= w.width || y >= w.height) return { where: null };
    const where = this.sim.addItems(x, y, item, count);
    this.changed();
    return { where };
  }

  op_clear() {
    let any = this.world.count > 0;
    if (!any) this.world.resources.forEach(() => { any = true; });
    const before = any ? makeSave(this.world, this.sim) : null;
    this.op_pause();
    this.drag = null;
    this.reset();
    this.changed();
    if (before) this.history.pushSnapshot('全消去', before, null);
  }

  /** 元に戻す。戻した操作の名前と、置き直せなかった建物の数を返す。 */
  op_undo() {
    const e = this.history.undoList.pop();
    if (!e) return { done: false, undo: 0, redo: this.history.redoList.length };
    let skipped = 0;
    if (e.snapshot) skipped = this.replaceWith(e.before).skipped;
    else { this.sim.sync(); skipped = applyEntry(this.world, this.registry, this.sim, e, 'undo').skipped; }
    e.open = false;
    this.history.redoList.push(e);
    this.changed();
    return { done: true, label: e.label, skipped, undo: this.history.undoList.length, redo: this.history.redoList.length };
  }

  /** やり直す。 */
  op_redo() {
    const e = this.history.redoList.pop();
    if (!e) return { done: false, undo: this.history.undoList.length, redo: 0 };
    let skipped = 0;
    if (e.snapshot) {
      if (e.after) skipped = this.replaceWith(e.after).skipped;
      else { this.op_pause(); this.drag = null; this.reset(); }
    } else { this.sim.sync(); skipped = applyEntry(this.world, this.registry, this.sim, e, 'redo').skipped; }
    this.history.undoList.push(e);
    this.changed();
    return { done: true, label: e.label, skipped, undo: this.history.undoList.length, redo: this.history.redoList.length };
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
      building: b && { type: b.type, x: b.x, y: b.y, dir: b.dir, filter: b.filter || null },
      unpowered: !!(b && sim.unpowered.has(b.id)),
      power: sim.power.get(key(x, y)) || 0,
      wire: wire && wire.type,
      belt: c.belt || null,
      container: c.container ? { slots: c.container.slots } : null,
      machine: c.machine || null,
      miner: c.miner ? { state: c.miner.state } : null,
      device: c.collector ? { state: c.collector.state } : c.signal ? { state: c.signal.on ? '入' : '切' } : null,
      ground: c.ground,
      resource: c.resource || null,
    };
  }

  /* ---------- 範囲選択・設計図 ---------- */

  /** 範囲 rect（両端を含む）を設計図にする。盤面は変えない。 */
  op_copy({ rect, name = '' }) {
    return captureBlueprint(this.world, rect, name);
  }

  /** 設計図を左上 (x, y) に貼る。置けない建物は飛ばす。overwrite なら重なる建物を撤去して置く。 */
  op_paste({ blueprint, x, y, overwrite = false }) {
    const reason = checkBlueprint(blueprint);
    if (reason) throw new Error(reason);
    const r = this.record('貼り付け', () => pasteBlueprint(this.world, this.registry, blueprint, x, y, { overwrite }));
    if (r.placed || r.replaced) this.changed();
    return r;
  }

  /**
   * 範囲の建物をまとめて動かす。transforms（'r' / 'h' / 'v' の並び）で回す・反転してから左上 (x, y) へ。
   * 中身（ベルトの上の物・炉の中など）も一緒に動く。置けない所が1つでもあれば何も動かさない。
   */
  op_move({ rect, transforms = [], x, y, overwrite = false }) {
    this.sim.sync();                     // 動かす前の建物を Sim に覚えさせる（中身を引き継ぐため）
    const before = new Map(buildingsInside(this.world, rect).map(b => [b.id, { type: b.type, x: b.x, y: b.y, layer: b.layer }]));
    const r = this.record('移動', entry => {
      const res = moveArea(this.world, this.registry, rect, transforms, x, y, { overwrite });
      // 元に戻すときも中身が付いてくるように、どこからどこへ動いたかを覚える
      for (const [from, to] of res.moves) {
        const nb = this.world.buildings.get(to);
        if (before.has(from) && nb) entry.moves.push({ from: before.get(from), to: { type: nb.type, x: nb.x, y: nb.y, layer: nb.layer } });
      }
      return res;
    });
    for (const [from, to] of r.moves) this.sim.moved.set(from, to);
    if (r.moved) this.changed();
    return { moved: r.moved, replaced: r.replaced, blocked: r.blocked, width: r.width, height: r.height };
  }

  /** 範囲に1マスでもかかっている建物を撤去する（中身は床に落ちる）。 */
  op_removeArea({ rect, label = '範囲の削除' }) {
    const list = this.world.buildingsIn(rect.x0, rect.y0, rect.x1, rect.y1);
    this.record(label, () => { for (const b of list) this.world.remove(b); });
    if (list.length) this.changed();
    return { removed: list.length };
  }

  /** セーブデータを作る（Phase 6）。 */
  op_save() {
    return makeSave(this.world, this.sim);
  }

  /**
   * 盤面の大きさを変える。左上は動かさず、右と下を広げる・縮める。
   * dryRun なら変えずに、はみ出して消える建物の数だけ返す（画面が確認を出すため）。
   */
  op_resize({ width, height, dryRun = false }) {
    const reason = checkSize(width, height);
    if (reason) throw new Error(reason);
    const lost = countOutside(this.world, width, height);
    if (dryRun) return { lost };
    const before = makeSave(this.world, this.sim);
    const { world, sim } = resizeSave(this.world, this.sim, this.registry, width, height);
    this.history.pushSnapshot('大きさの変更', before, makeSave(world, sim));   // 元に戻すと、消えた建物も中身ごと戻る
    const wasRunning = this.running;
    this.op_pause();
    this.drag = null;
    this.world = world;
    this.sim = sim;
    this.size = { width, height };
    this.changed();
    if (wasRunning) this.op_play();
    return { width, height, lost, count: world.count };
  }

  /** セーブデータを読み込んで、今の盤面と入れ替える。形が違えばエラーで、今の盤面はそのまま。 */
  /** record: false なら元に戻す記録を残さず、記録を空にする（起動時の自動保存の読み込み）。 */
  op_load({ data, record = true }) {
    const before = record ? makeSave(this.world, this.sim) : null;
    const { world, sim, skipped, savedAt } = this.replaceWith(data);   // 形が違えばここでエラー（今の盤面も記録もそのまま）
    if (record) this.history.pushSnapshot('読み込み', before, data);
    else this.history.clear();
    return { count: world.count, skipped, savedAt, tick: sim.tick };
  }
}
