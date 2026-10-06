/* 機械の自動配置（生産ライン。ユーザーの依頼 2026-10-06）。
 *
 * 「何を・何台で・材料はどこから」を選ぶと、機械・アーム・ベルト・スプリッター・箱・発電機・電線を並べた
 * 設計図を、型ごとに作る。回路の自動生成（circuitgen.js）と同じく、盤面に置いてシミュレーションで確かめ、
 * 外接する長方形の面積が小さい順、同じなら置く数が少ない順に並べる（ユーザーの指定）。
 *
 * 材料の取り方（ユーザーの選択「両方」）:
 *   ore   鉱脈から掘る。鉱脈は 2x2 の塊（Core Keeper）で、ドリルを塊の下の辺に並べる。
 *         設計図の resources に鉱脈を入れる（貼ると鉱脈も置く）
 *   chest 材料の箱から。人が箱に材料を入れる
 *
 * 型（ユーザーの判断で1つ）: まとめて掘った材料（または箱の中身）を、スプリッターを2つに分ける木で、
 *   機械に均等に配る。スプリッターは1個ずつの物も交互に分けるので、ドリルは必要な数だけで足りる。
 *   製品はベルトで集め、左端の出口の箱へ。材料の箱と出口の箱は、外接する長方形の同じ辺（左）に並ぶ
 *
 * このシミュレーターの決まりで、配り方に気をつけた点:
 *   アームは1回に1スタックを丸ごと運び、機械の入力は1スタックまで（9999 個）入る。
 *   そのため、1本のベルトに沿ってアームを並べるだけだと、最初の機械が材料をほとんど持っていってしまい、
 *   ほかの機械が動かない。この形はシミュレーションで落ちるので候補に出さない。
 *
 * 電気: 電気を使う建物（power.needs）を、発電機から電線でつなぐ。電線は床の層なので建物の下に通せる。
 *   届かなければ発電機を足す（最大 4 台）。
 *
 * **描画も DOM も知らない。**
 */

import { World } from './world.js';
import { Sim } from './sim.js';
import { place } from './placement.js';
import { DELTA, key } from './grid.js';
import { containerTotal } from './inventory.js';
import { BLUEPRINT_FORMAT, BLUEPRINT_VERSION } from './blueprint.js';

export const MAX_MACHINES = 16;
export const SOURCES = { ore: '鉱脈から掘る', chest: '材料の箱から' };
const DRILLS = ['miner', 'crude-drill'];
const WARMUP = 60, MEASURE = 100;          // 確かめるとき: 最初の 60 秒は数えず、次の 100 秒の出来高を見る

/** 作れる製品の一覧（材料が1種類のレシピ）。 */
export function lineRecipes(registry) {
  const out = [];
  for (const r of registry.recipes.values()) {
    const ins = Object.keys(r.inputs || {});
    if (ins.length !== 1) continue;
    const machines = (r.machines || []).filter(m => registry.building(m));
    if (!machines.length) continue;
    const item = registry.item(ins[0]);
    out.push({ id: r.id, name: r.name || r.id, input: ins[0], ore: !!(item && item.resource), machines });
  }
  return out;
}

/** 掘るのに使えるドリル。 */
export function lineDrills(registry) {
  return DRILLS.filter(id => registry.building(id) && registry.building(id).miner);
}

class Plan {
  constructor(registry) {
    this.registry = registry;
    this.parts = [];          // { type, x, y, dir }
    this.obj = new Map();     // 設置物のマス
    this.wires = new Set();   // 電線のマス
    this.keep = new Set();    // 何も置かないマス（床に物が落ちるところ）
    this.keepY = new Map();
    this.ores = [];           // 鉱脈のマス
    this.inputs = [];         // 材料を入れる箱のマス
    this.outputs = [];        // 製品が入る箱のマス
  }
  put(type, x, y, dir = 'N') {
    const k = key(x, y);
    if (this.obj.has(k)) throw new Error(`重なり ${type} (${x}, ${y})`);
    this.obj.set(k, type);
    this.parts.push({ type, x, y, dir });
  }
  hold(x, y) { this.keep.add(key(x, y)); this.keepY.set(key(x, y), y); }
  wire(x, y) {
    const k = key(x, y);
    if (this.wires.has(k)) return;
    this.wires.add(k);
    this.parts.push({ type: 'wire', x, y, dir: 'N' });
  }
  bounds() {
    const cells = [...this.parts, ...this.ores];
    const xs = cells.map(c => c.x), ys = cells.map(c => c.y);
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  }
}

const powerOf = (registry, type) => (registry.building(type) || {}).power || null;
const needsPower = (registry, type) => !!(powerOf(registry, type) || {}).needs;

/* ---------- 型 ---------- */

/** 機械1台ぶん（右向きの流れ）。(x, y) が材料の落ちるマス。戻り値は製品の出るマスの x。 */
function unitE(P, machine, x, y, inputIsChest) {
  const def = P.registry.building(machine);
  if (inputIsChest) { P.put('chest', x, y); P.inputs.push({ x, y }); } else P.hold(x, y);
  P.put('inserter', x + 1, y, 'W');                       // 正面（左）から取り、背面（右）の機械へ
  if (def.machine.outputFront) { P.put(machine, x + 2, y, 'E'); return x + 3; }
  P.put(machine, x + 2, y, def.directional ? 'E' : 'N');
  P.put('inserter', x + 3, y, 'W');                       // 機械から取り、右へ
  return x + 4;
}

/** tree: スプリッターの木で均等に配る。右向きの流れで、機械を縦に並べる。 */
function planTree(P, o) {
  const k = o.count;
  const m = Math.ceil(Math.log2(k));
  const L = 1 << m;                                        // 葉（配り先）の数
  const D = o.source === 'ore' ? o.drills : 0;
  const Xr = o.source === 'chest' && L === 1 ? 0 : Math.max(D, 2);   // 根のスプリッターの列（箱から1台なら、箱が左端）
  const Xl = Xr + m - 1;                                   // 葉へ出すスプリッターの列（k=1 なら Xr-1）
  const leafRow = i => (L === 1 ? 0 : 3 * (i >> 1) + (i & 1) * 2);
  // 木（葉の範囲 [lo, hi)）。物が西から入ってくるマス { row, x } を返す。
  // 機械の無い葉しか無い側は作らない（台数が2の累乗でないとき。その分、残りの機械へ多めに配られる）
  const node = (lo, hi, level) => {
    if (hi - lo === 1) return { row: leafRow(lo), x: Xl + 1 };         // 葉: 機械の手前の落ちるマス
    const mid = (lo + hi) >> 1;
    if (mid >= k) return node(lo, mid, level + 1);
    const X = Xr + level;
    const a = node(lo, mid, level + 1), b = node(mid, hi, level + 1);
    const c = (a.row + b.row) >> 1;
    P.put('splitter', X, c, 'N');                                      // 西から入り、上下へ半分ずつ
    for (let y = c - 1; y >= a.row; y--) P.put('belt', X, y, y === a.row ? 'E' : 'N');
    for (let y = c + 1; y <= b.row; y++) P.put('belt', X, y, y === b.row ? 'E' : 'S');
    for (const t of [a, b]) for (let x = X + 1; x < t.x; x++) P.put('belt', x, t.row, 'E');
    return { row: c, x: X };
  };
  const root = L === 1 ? 0 : node(0, L, 0).row;
  // 入口
  if (o.source === 'ore') {
    // 鉱脈は 2x2 の塊（Core Keeper。data/game.json の veinSize）。ドリルは塊の下の辺に並べて上を掘る
    const vs = Math.max(1, (P.registry.game.defaults || {}).veinSize || 1);
    const blocks = Math.ceil(D / vs);
    for (let j = 0; j < blocks; j++) for (let dy = 0; dy < vs; dy++) for (let dx = 0; dx < vs; dx++) P.ores.push({ x: j * vs + dx, y: -2 - vs + dy });
    for (let i = 0; i < D; i++) P.put(o.drill, i, -2, 'N');
    for (let x = 0; x < Xr - 1; x++) P.put('belt', x, -1, 'E');
    for (let y = -1; y < root; y++) P.put('belt', Xr - 1, y, 'S');
    P.put('belt', Xr - 1, root, 'E');                      // 根のスプリッターへ（k=1 なら機械の手前の落ちるマスへ）
  } else if (L > 1) {
    P.put('chest', Xr - 2, root); P.inputs.push({ x: Xr - 2, y: root });
    P.put('inserter', Xr - 1, root, 'W');                  // 箱から取り、スプリッターへ入れる
  }
  // 機械
  let xo = 0, rows = [];
  for (let i = 0; i < k; i++) {
    const r = leafRow(i);
    const chestIn = o.source === 'chest' && L === 1;
    xo = unitE(P, o.machine, (L === 1 ? Xr : Xl + 1), r, chestIn);
    rows.push(r);
  }
  // 製品: 右の列を下へ流し、いちばん下の行を左へ戻して、左端の出口の箱へ。
  // 材料の箱（左端）と出口の箱が、外接する長方形の同じ辺（左）に並ぶ（ユーザーの希望 2026-10-07）
  const top = Math.min(...rows);
  let bottom = Math.max(...P.parts.map(p => p.y));
  for (const k2 of P.keep) bottom = Math.max(bottom, P.keepY.get(k2));
  const yo = bottom + 1;                                     // 出口の行
  for (let y = top; y < yo; y++) P.put('belt', xo, y, 'S');
  for (let x = xo; x >= 3; x--) P.put('belt', x, yo, 'W');
  P.hold(2, yo); P.put('inserter', 1, yo, 'E'); P.put('chest', 0, yo);   // 落ちるマス → アーム → 箱
  P.outputs.push({ x: 0, y: yo });
  return true;
}

// ユーザーの判断（2026-10-07）「基本はスプリッターで均等に配る方法がいい」で、この型だけにした
// （機械ごとに専用のドリル・箱を付ける型は、ドリルが台数ぶん要り、材料の箱が機械ごとに分かれるのでやめた）
export const LINE_PATTERNS = [
  { id: 'tree', name: 'スプリッターで均等に配る', plan: planTree, collect: ['belt'] },
];

/* ---------- 電気 ---------- */

/**
 * 電気を使う建物を、発電機と電線でつなぐ。電線は床の層なので、どのマスにも置ける（落ちるマスは避ける）。
 * gens 台の発電機を、遠い建物ができるだけ近くなる空きマスに置き、建物から近い順に電線でつなぐ。
 */
function planPower(P, gens) {
  const reg = P.registry;
  const need = P.parts.filter(p => needsPower(reg, p.type));
  if (!need.length) return true;
  const b = P.bounds();
  const free = (x, y) => !P.obj.has(key(x, y)) && !P.keep.has(key(x, y)) && !P.ores.some(o => o.x === x && o.y === y);
  // 発電機の場所: 外接する長方形の中の空きマス（無ければ1マス外側）から、建物までの最大距離が小さい所
  const cand = [];
  for (let y = b.y0 - 1; y <= b.y1 + 1; y++) for (let x = b.x0 - 1; x <= b.x1 + 1; x++) if (free(x, y)) cand.push({ x, y, out: x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1 });
  const groups = [];
  const sorted = [...need].sort((a, c) => (a.x - c.x) || (a.y - c.y));
  for (let g = 0; g < gens; g++) groups.push(sorted.slice(Math.floor(g * sorted.length / gens), Math.floor((g + 1) * sorted.length / gens)));
  const placed = [];
  for (const grp of groups) {
    if (!grp.length) continue;
    let best = null, bestScore = Infinity;
    for (const c of cand) {
      if (placed.some(p => p.x === c.x && p.y === c.y)) continue;
      const far = Math.max(...grp.map(p => Math.abs(p.x - c.x) + Math.abs(p.y - c.y)));
      const score = far + (c.out ? 100 : 0);
      if (score < bestScore) { bestScore = score; best = c; }
    }
    if (!best) return false;
    P.put('generator', best.x, best.y);
    placed.push(best);
  }
  // 電線: 発電機・つないだ所から、まだの建物へ最短でつなぐ（電気を通す建物・電線は通り放題）
  const conducts = (x, y) => P.wires.has(key(x, y)) || !!(powerOf(reg, P.obj.get(key(x, y))) || {}).conducts || !!(powerOf(reg, P.obj.get(key(x, y))) || {}).source;
  const reached = new Set(placed.map(p => key(p.x, p.y)));
  const grow = () => {                                      // つながっている所を広げる
    const q = [...reached].map(k2 => P.parts.find(p => key(p.x, p.y) === k2) || placed.find(p => key(p.x, p.y) === k2)).filter(Boolean).map(p => ({ x: p.x, y: p.y }));
    for (let i = 0; i < q.length; i++) {
      for (const d of Object.values(DELTA)) {
        const nx = q[i].x + d.x, ny = q[i].y + d.y, nk = key(nx, ny);
        if (reached.has(nk) || !conducts(nx, ny)) continue;
        reached.add(nk); q.push({ x: nx, y: ny });
      }
    }
  };
  grow();
  const inside = (x, y) => x >= b.x0 - 1 && x <= b.x1 + 1 && y >= b.y0 - 1 && y <= b.y1 + 1;
  for (let guard = 0; guard < need.length + 1; guard++) {
    const left = need.filter(p => !reached.has(key(p.x, p.y)));
    if (!left.length) return true;
    // つながっている所から幅優先で、まだの建物のどれかへ
    const prev = new Map();
    const q = [];
    for (const k2 of reached) { prev.set(k2, null); }
    for (const p of [...P.parts, ...placed]) if (reached.has(key(p.x, p.y))) q.push({ x: p.x, y: p.y });
    const goal = new Set(left.map(p => key(p.x, p.y)));
    let hit = null;
    for (let i = 0; i < q.length && !hit; i++) {
      for (const d of Object.values(DELTA)) {
        const nx = q[i].x + d.x, ny = q[i].y + d.y, nk = key(nx, ny);
        if (prev.has(nk) || !inside(nx, ny)) continue;
        if (P.keep.has(nk)) continue;
        prev.set(nk, key(q[i].x, q[i].y));
        if (goal.has(nk)) { hit = { x: nx, y: ny }; break; }
        q.push({ x: nx, y: ny });
      }
    }
    if (!hit) return false;
    // たどって電線を置く（電気を通す建物の上には置かない）
    let k2 = prev.get(key(hit.x, hit.y));
    while (k2 != null && !reached.has(k2)) {
      const c = q.find(c2 => key(c2.x, c2.y) === k2);
      if (!conducts(c.x, c.y)) P.wire(c.x, c.y);
      k2 = prev.get(k2);
    }
    reached.add(key(hit.x, hit.y));
    grow();
  }
  return need.every(p => reached.has(key(p.x, p.y)));
}

/* ---------- 確かめる ---------- */

/**
 * 盤面に置いて動かし、出口の箱に入った製品の数から、1分あたりの出来高を測る。
 * 戻り値: { ok, perMin, unpowered }
 */
export function verifyLine(registry, o, P) {
  const b = P.bounds();
  const w = new World({ width: b.x1 - b.x0 + 3, height: b.y1 - b.y0 + 3 });
  const at = c => ({ x: c.x - b.x0 + 1, y: c.y - b.y0 + 1 });
  for (const p of P.parts) {
    const c = at(p);
    if (!place(w, registry.building(p.type), c.x, c.y, p.dir)) return { ok: false, why: `置けない ${p.type}` };
  }
  for (const c of P.ores) { const q = at(c); w.setResource(q.x, q.y, o.input); }
  const sim = new Sim(w, registry);
  for (const c of P.inputs) { const q = at(c); sim.addItems(q.x, q.y, o.input, Math.ceil(o.count * 40 / P.inputs.length)); }
  sim.sync();
  const unpowered = sim.unpowered.size;
  if (unpowered) return { ok: false, perMin: 0, unpowered };
  const outItems = Object.keys(o.recipe.outputs);
  const count = () => P.outputs.reduce((a, c) => {
    const q = at(c);
    const box = w.at(q.x, q.y);
    const ch = box && sim.containers.get(box.id);
    if (!ch) return a;
    return a + ch.slots.filter(s => s && outItems.includes(s.item)).reduce((n, s) => n + s.count, 0);
  }, 0);
  for (let s = 0; s < WARMUP; s++) sim.stepSecond();
  const c0 = count();
  for (let s = 0; s < MEASURE; s++) sim.stepSecond();
  const perMin = (count() - c0) * 60 / MEASURE;
  return { ok: perMin >= o.target * 0.9, perMin, unpowered };
}

/* ---------- まとめ ---------- */

/**
 * 生産ラインを型ごとに作って確かめ、よい順に並べる。
 * opts: { recipe: レシピ id, machine: 建物 id, count: 台数, source: 'ore'|'chest', drill: ドリルの id }
 * 戻り値: { target, need, candidates: [{ pattern, patternName, name, width, height, area, count, perMin, drills, generators, ore, inputs, outputs, blueprint }], rejected }
 */
export function generateLines(registry, opts) {
  const recipe = registry.recipe(opts.recipe);
  if (!recipe) throw new Error('レシピが無い');
  const input = Object.keys(recipe.inputs)[0];
  const count = Math.max(1, Math.min(MAX_MACHINES, opts.count | 0));
  const perCycle = Object.values(recipe.outputs).reduce((a, v) => a + v, 0);
  const target = count * perCycle * 60 / recipe.craftTime;            // 1分あたり
  const needPerMachine = recipe.inputs[input] / recipe.craftTime;     // 1秒あたり
  const drill = opts.drill || lineDrills(registry)[0];
  const drillRate = opts.source === 'ore' ? (registry.building(drill).miner.amount || 1) / registry.building(drill).miner.periodSeconds : 0;
  const o = { ...opts, recipe, input, count, target, drill };
  const candidates = [], rejected = [];
  let order = 0;
  for (const pat of LINE_PATTERNS) {
    for (const collect of pat.collect) {
      for (let gens = 1; gens <= 4; gens++) {
        const P = new Plan(registry);
        const oo = { ...o, collect };
        if (pat.id === 'tree' && opts.source === 'ore') {
          const L = 1 << Math.ceil(Math.log2(count));
          oo.drills = Math.max(1, Math.ceil(L * needPerMachine / drillRate - 1e-9));
        }
        let ok;
        try { ok = pat.plan(P, oo); } catch (e) { ok = false; }
        if (!ok) break;
        if (!planPower(P, gens)) continue;
        const v = verifyLine(registry, oo, P);
        const label = pat.name + (collect === 'chests' ? '・出口の箱を機械ごとに' : '');
        if (!v.ok) {
          if (v.unpowered) continue;                                  // 電気が足りない → 発電機を足して試す
          rejected.push({ patternName: label, perMin: v.perMin, why: v.why || '出来高が足りない' });
          break;
        }
        const bb = P.bounds();
        const shift = c => ({ x: c.x - bb.x0, y: c.y - bb.y0 });
        const buildings = P.parts.map(p => ({ type: p.type, ...shift(p), dir: p.dir }))
          .sort((a, c) => (a.y - c.y) || (a.x - c.x) || (a.type < c.type ? -1 : 1));
        const width = bb.x1 - bb.x0 + 1, height = bb.y1 - bb.y0 + 1;
        const name = `${recipe.name || recipe.id} ×${count}（${label}）`;
        candidates.push({
          pattern: pat.id, collect, patternName: label, name, order: order++,
          width, height, area: width * height, count: buildings.length,
          perMin: v.perMin, target,
          drills: buildings.filter(x => DRILLS.includes(x.type)).length,
          generators: buildings.filter(x => x.type === 'generator').length,
          ore: P.ores.map(shift), inputs: P.inputs.map(shift), outputs: P.outputs.map(shift),
          blueprint: { format: BLUEPRINT_FORMAT, version: BLUEPRINT_VERSION, name, width, height, buildings,
            ...(P.ores.length ? { resources: P.ores.map(c => ({ ...shift(c), item: input })) } : {}) },
        });
        break;
      }
    }
  }
  candidates.sort((a, c) => (a.area - c.area) || (a.count - c.count) || (a.order - c.order));
  return { target, need: needPerMachine * count * 60, candidates, rejected };
}
