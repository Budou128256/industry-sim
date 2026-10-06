/* 元に戻す / やり直す（Ctrl+Z / Ctrl+Y）。
 *
 * 戻すのは「置き方」: 建物の設置・撤去・回転・移動・貼り付け・範囲の削除と、鉱脈。
 * 中身（ベルトの上の物・箱の中など）と時間は戻さない。
 *   - 置いた建物を戻して消すと、中身は撤去と同じく床に落ちる
 *   - 消した建物を戻すと、空の建物として戻る（床に落ちた物はそのまま。ベルトなら拾って流す）
 *   - まとめて移動を戻すときだけは、中身も一緒に元の場所へ戻る（移動のときと同じ）
 * 全消去と読み込み（盤面ごと入れ替わる操作）は、前の盤面をまるごと覚えておき、中身も含めて戻す。
 *
 * 1回の操作 = 1つの記録。ドラッグで置いた・塗った分は、押してから離すまでで1つにまとめる。
 * **描画も DOM も知らない。**
 */

import { place } from './placement.js';

/** 覚えておく操作の数。古いものから捨てる。 */
export const HISTORY_LIMIT = 100;

/** 記録の中の建物（置き場所を引くのに要る分だけ写す）。 */
const plain = b => ({ type: b.type, x: b.x, y: b.y, dir: b.dir, size: b.size, layer: b.layer, ...(b.filter ? { filter: b.filter } : {}) });

export class History {
  constructor() {
    this.undoList = [];
    this.redoList = [];
    this.recording = null;       // 集めている途中の記録
  }

  clear() { this.undoList = []; this.redoList = []; this.recording = null; }

  get canUndo() { return this.undoList.length > 0; }
  get canRedo() { return this.redoList.length > 0; }

  /** World の変更を集め始める。group なら、直前の記録に足す（ドラッグの続き）。 */
  begin(world, label, { group = false } = {}) {
    const last = this.undoList[this.undoList.length - 1];
    const entry = group && last && last.open ? last : { label, changes: [], moves: [], open: false };
    this.recording = entry;
    world.onRecord = c => {
      if (c.op === 'resource') entry.changes.push({ op: 'resource', x: c.x, y: c.y, prev: c.prev, item: c.item });
      else entry.changes.push({ op: c.op, b: plain(c.building) });
    };
    return entry;
  }

  /** 集め終わる。何も変わっていなければ記録しない。open なら、次の group の begin で続きを足せる。 */
  end(world, { open = false } = {}) {
    const entry = this.recording;
    world.onRecord = null;
    this.recording = null;
    if (!entry) return null;
    const last = this.undoList[this.undoList.length - 1];
    if (last && last !== entry) last.open = false;
    entry.open = open;
    if (entry !== last) {
      if (!entry.changes.length && !entry.snapshot) return null;
      this.undoList.push(entry);
      if (this.undoList.length > HISTORY_LIMIT) this.undoList.shift();
    }
    this.redoList = [];
    return entry;
  }

  /** 盤面ごと入れ替わる操作（全消去・読み込み）の記録。before / after はセーブデータ。 */
  pushSnapshot(label, before, after) {
    this.closeOpen();
    this.undoList.push({ label, snapshot: true, before, after, changes: [], moves: [] });
    if (this.undoList.length > HISTORY_LIMIT) this.undoList.shift();
    this.redoList = [];
  }

  closeOpen() {
    const last = this.undoList[this.undoList.length - 1];
    if (last) last.open = false;
  }
}

/** 建物の記録が指すものを、今の盤面から探す（同じ層・同じ位置・同じ種類）。 */
function findBuilding(world, b) {
  const o = b.layer === 'floor' ? world.floorAt(b.x, b.y) : world.at(b.x, b.y);
  return o && o.type === b.type && o.x === b.x && o.y === b.y ? o : null;
}

/**
 * 記録を逆向き（undo）または順向き（redo）に当てる。
 * 置き直せない建物（その後に別の物が置かれた等）は飛ばして、その数を返す。
 * sim があれば、まとめて移動の中身の引き継ぎを Sim に伝える。
 */
export function applyEntry(world, registry, sim, entry, direction) {
  const undo = direction === 'undo';
  const list = undo ? [...entry.changes].reverse() : entry.changes;
  // 移動の記録: undo なら「行き先 → 元の場所」、redo なら「元の場所 → 行き先」へ中身を渡す
  const pairs = (entry.moves || []).map(m => (undo ? { src: m.to, dst: m.from } : { src: m.from, dst: m.to }));
  const srcIds = pairs.map(p => { const b = findBuilding(world, p.src); return b ? b.id : null; });
  let skipped = 0;
  for (const c of list) {
    if (c.op === 'resource') { world.setResource(c.x, c.y, undo ? c.prev : c.item); continue; }
    const add = (c.op === 'add') !== undo;            // undo では add を消し、remove を置き直す
    if (add) {
      const def = registry.building(c.b.type);
      if (!place(world, def, c.b.x, c.b.y, c.b.dir, { filter: c.b.filter })) skipped++;
    } else {
      const b = findBuilding(world, c.b);
      if (b) world.remove(b); else skipped++;
    }
  }
  if (sim) {
    pairs.forEach((p, i) => {
      const to = findBuilding(world, p.dst);
      if (srcIds[i] != null && to) sim.moved.set(srcIds[i], to.id);
    });
  }
  return { skipped };
}
