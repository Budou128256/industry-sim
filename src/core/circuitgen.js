/* 回路の自動生成（ユーザーの依頼 2026-10-06）。
 *
 * 「どのレバーの組み合わせのときに電気を出すか」（真理値表）から、レバー・論理回路・交差回路・電線・発電機で
 * 回路を組み、設計図にする。
 *
 * 使う部品の性質（signal.js。資料に無いところは仮に決めたもの）:
 *   論理回路は左・右・背面の3入力のうち**ちょうど2つ**に電気が来ると正面へ出す。
 *   入力に線・発電機（いつも入）・空き（いつも切）を選ぶと、1つでいろいろな働きになる（下の「2.」）。
 *   回路から出る電気は「入った強さ − 1」。発電機を入力に使う回路は、出力が発電機の強さに戻る（強め直し）。
 *   出力どうしを電線でつなぐと「または」。交差回路は縦と横を混ぜずに通すので、線が交わるところに置く。
 *
 * 流れ:
 *   1. 真理値表を読める式（積和形）にする（画面に出すだけ。クワイン・マクラスキー）
 *   2. その働きを作る、いちばん安い部品の組み合わせを選ぶ（入力3つまでの全部の働きを先に求めておく）
 *   3. 型（PATTERNS）× 強め直しの有無 × レバーの並び順ごとに部品を並べ、線を迷路探索でつなぐ。
 *      線どうしは隣り合わない（隣ると電気が混ざる）
 *   4. 盤面に置いてシミュレーションで全部の組み合わせを確かめ、正しいものだけを残す
 *   5. 外接する長方形の面積が小さい順、同じなら置く数が少ない順、それも同じなら試した順（ユーザーの指定）
 *
 * **描画も DOM も知らない。**
 */

import { World } from './world.js';
import { Sim } from './sim.js';
import { place } from './placement.js';
import { key } from './grid.js';
import { pathArms, toggleLever } from './signal.js';
import { BLUEPRINT_FORMAT, BLUEPRINT_VERSION } from './blueprint.js';

export const MAX_INPUTS = 3;
export const INPUT_NAMES = ['A', 'B', 'C'];

/** 真理値表の行 r で、入力 i が入っているか（A が上の桁）。 */
export function inputOn(r, i, n) { return ((r >> (n - 1 - i)) & 1) === 1; }

/* ---------- 1. 読める式にする ---------- */

/** 項は { mask, value }。mask の立っている入力だけを見る。value はその入力の入り切り。 */
function covers(term, r) { return (r & term.mask) === (term.value & term.mask); }

/** 最小に近い積和形。true の行が無ければ []、全部 true なら [{mask:0}]。 */
export function minimize(n, table) {
  const ones = [];
  for (let r = 0; r < 1 << n; r++) if (table[r]) ones.push(r);
  if (!ones.length) return [];
  const full = (1 << n) - 1;
  // 全部の項（3^n 個）のうち、false の行を含まないもの
  const implicants = [];
  for (let mask = 0; mask <= full; mask++) {
    for (let value = 0; value <= full; value++) {
      if ((value & ~mask) !== 0) continue;
      const t = { mask, value };
      let ok = true;
      for (let r = 0; r <= full && ok; r++) if (covers(t, r) && !table[r]) ok = false;
      if (ok) implicants.push(t);
    }
  }
  // 主項（それより広い項に含まれないもの）
  const wider = (a, b) => (a.mask & b.mask) === a.mask && a.mask !== b.mask && (a.value & a.mask) === (b.value & a.mask);
  const primes = implicants.filter(t => !implicants.some(u => wider(u, t)));
  // 主項の組み合わせで true の行を全部覆う最小のもの（数が少ない順、同じなら文字の数が少ない順）
  const bits = t => { let c = 0; for (let m = t.mask; m; m &= m - 1) c++; return c; };
  let best = null;
  for (let set = 1; set < 1 << primes.length; set++) {
    const chosen = primes.filter((_, i) => set & (1 << i));
    if (!ones.every(r => chosen.some(t => covers(t, r)))) continue;
    const cost = chosen.length * 100 + chosen.reduce((a, t) => a + bits(t), 0);
    if (!best || cost < best.cost) best = { cost, chosen };
  }
  return best.chosen;
}

/** 積和形を読める式にする（A・B'＋C のような形）。 */
export function termsText(n, terms) {
  if (!terms.length) return '（いつも出さない）';
  return terms.map(t => {
    if (!t.mask) return '（いつも出す）';
    const lits = [];
    for (let i = 0; i < n; i++) {
      const bit = 1 << (n - 1 - i);
      if (t.mask & bit) lits.push(t.value & bit ? INPUT_NAMES[i] : `${INPUT_NAMES[i]}でない`);
    }
    return lits.join(' かつ ');
  }).join(' または ');
}

/* ---------- 2. 部品の組み合わせを探す ---------- */

/*
 * 論理回路1つは「3つの入力のうちちょうど2つ」。入力に、レバーの線・ほかの回路の出力・発電機（いつも入）・
 * 空き（いつも切）を選べば、1つでいろいろな働きになる:
 *   (A, B, 空き) = A かつ B     (A, B, 発電機) = A と B のどちらか一方だけ
 *   (A, 発電機, 発電機) = A でない   (A, 発電機, 空き) = A そのまま（強め直し）
 * 出力どうしを電線でつなぐと「または」。
 * 表（真理値表）を数（ビット列）で表し、「その働きを作るいちばん安い組み方」を全部の働きについて求めておく。
 * 安さ = 論理回路 10 + 発電機 2 + 「または」1。入力が3つまでなら働きは 256 通りなので、全部求められる。
 */
const COST_GATE = 10, COST_GEN = 2, COST_OR = 1;
const synthCache = new Map();

function fullMask(n) { return (1 << (1 << n)) - 1; }

/** 働き（ビット列）の表。n 入力の全部の働き → いちばん安い組み方。 */
function synthTable(n) {
  if (synthCache.has(n)) return synthCache.get(n);
  const FULL = fullMask(n);
  const best = new Map();
  for (let i = 0; i < n; i++) {
    let f = 0;
    for (let r = 0; r < 1 << n; r++) if (inputOn(r, i, n)) f |= 1 << r;
    best.set(f, { f, cost: 0, kind: 'in', i });
  }
  const ONE = { f: FULL, cost: COST_GEN, kind: 'const', v: '1' };
  const ZERO = { f: 0, cost: 0, kind: 'const', v: '0' };
  const ex2 = (a, b, c) => ((a & b & ~c) | (a & ~b & c) | (~a & b & c)) & FULL;
  for (let round = 0; round < 5; round++) {
    let changed = false;
    const list = [...best.values(), ONE, ZERO];
    for (let a = 0; a < list.length; a++) {
      for (let b = a; b < list.length; b++) {
        for (let c = b; c < list.length; c++) {
          const A = list[a], B = list[b], C = list[c];
          const f = ex2(A.f, B.f, C.f);
          const cost = A.cost + B.cost + C.cost + COST_GATE;
          const cur = best.get(f);
          if (!cur || cost < cur.cost) { best.set(f, { f, cost, kind: 'gate', args: [A, B, C] }); changed = true; }
        }
      }
    }
    // または: 回路の出力どうし（レバーの線は直接つながない。逆流するため）
    const outs = [...best.values()].filter(x => x.kind !== 'in');
    for (let a = 0; a < outs.length; a++) {
      for (let b = a + 1; b < outs.length; b++) {
        const f = outs[a].f | outs[b].f;
        const cost = outs[a].cost + outs[b].cost + COST_OR;
        const cur = best.get(f);
        if (!cur || cost < cur.cost) { best.set(f, { f, cost, kind: 'or', parts: [outs[a], outs[b]] }); changed = true; }
      }
    }
    if (!changed) break;
  }
  synthCache.set(n, best);
  return best;
}

/** 表 table の働きを作る組み方（無ければ null）。 */
function synthFor(n, table) {
  let f = 0;
  table.forEach((on, r) => { if (on) f |= 1 << r; });
  if (f === 0) return null;
  if (f === fullMask(n)) return { kind: 'always' };
  return synthTable(n).get(f) || null;
}

/**
 * 組み方からネットリストを作る。
 * gates: [{ id, sig: [線の名前 | '1'（発電機） | '0'（空き） x3], out }]
 * boost: 発電機の入っていない回路の後ろに「強め直し」を挟む（電気が弱まって届かない配置を減らす）
 */
function netlist(n, root, boost = false) {
  const gates = [];
  let seq = 0;
  const memo = new Map();
  const addGate = (sig, out) => {
    const id = `g${seq++}`;
    const g = { id, sig, out: out || id };
    gates.push(g);
    if (boost && !sig.includes('1')) {               // 強め直し: (この出力, 発電機, 空き)
      g.out = `${id}w`;
      gates.push({ id: `g${seq++}`, sig: [g.out, '1', '0'], out: out || id });
    }
    return out || id;
  };
  const build = (node, outName = null) => {
    if (node.kind === 'in') {
      if (!outName) return `in${node.i}`;
      return addGate([`in${node.i}`, '1', '0'], outName);       // 出力をまとめる側へは強め直しを挟む
    }
    if (node.kind === 'gate') {
      if (!outName && memo.has(node)) return memo.get(node);
      const sig = node.args.map(a => (a.kind === 'const' ? a.v : build(a)));
      const net = addGate(sig, outName);
      if (!outName) memo.set(node, net);
      return net;
    }
    // または: 中の回路を、同じ出力の線に向けて新しく作る
    const name = outName || `o${seq++}`;
    const flat = [];
    const walk = x => { if (x.kind === 'or') x.parts.forEach(walk); else flat.push(x); };
    walk(node);
    for (const part of flat) build(part, name);
    return name;
  };
  const out = build(root);
  for (const g of gates) g.ins = [...new Set(g.sig.filter(x => x !== '1' && x !== '0'))];
  return { gates, out };
}

/** 組み方を読める式にする。 */
export function synthText(n, table) {
  const node = synthFor(n, table);
  if (!node) return '（いつも出さない）';
  if (node.kind === 'always') return '（いつも出す）';
  const name = x => (x.kind === 'in' ? INPUT_NAMES[x.i] : x.kind === 'const' ? (x.v === '1' ? '入' : '空') : text(x));
  const text = x => (x.kind === 'or' ? x.parts.map(text).join(' または ') : x.kind === 'in' ? INPUT_NAMES[x.i] : `[${x.args.map(name).join('・')}]`);
  return text(node);
}

/** 回路の深さ（入力から何段目か）。 */
function depths(gates) {
  const d = {};
  const driver = {};
  for (const g of gates) driver[g.out] = g;
  const depthOfNet = net => (/^in/.test(net) ? 0 : depthOf(driver[net]));
  const depthOf = g => {
    if (d[g.id] !== undefined) return d[g.id];
    d[g.id] = 1 + Math.max(...g.ins.map(depthOfNet));
    return d[g.id];
  };
  for (const g of gates) depthOf(g);
  return d;
}

/* ---------- 3. 並べて、つなぐ ---------- */

/**
 * 型。どれも回路は東（右）向き。入力のレバーは左端に縦に並べ、出力は右端。
 *   col: 段と段の横の間隔 / row: 同じ段の回路の縦の間隔 / inGap: レバーの縦の間隔
 *   line: 回路を全部1行に並べる（段ごとに右へ）
 *   stagger: 段ごとに回路の縦の位置をずらす
 */
export const PATTERNS = [
  { id: 'compact', name: '詰める', col: 4, row: 5, inGap: 3 },
  { id: 'standard', name: '標準', col: 5, row: 6, inGap: 4 },
  { id: 'wide', name: 'ゆったり', col: 6, row: 7, inGap: 4 },
  { id: 'line', name: '一列', col: 4, row: 5, inGap: 3, line: true },
  { id: 'stagger', name: '段違い', col: 4, row: 6, inGap: 3, stagger: true },
  { id: 'tall', name: '縦長', col: 4, row: 5, inGap: 6 },
  // I・L・T 回路で別の線を隣に並べる前提の、詰めた型（tight のときだけ試す）
  { id: 'packed', name: 'ぎっしり', col: 3, row: 4, inGap: 2, tightOnly: true },
];

const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIR_OF = { '1,0': 'E', '-1,0': 'W', '0,1': 'S', '0,-1': 'N' };
const STEP = { E: [1, 0], W: [-1, 0], S: [0, 1], N: [0, -1] };
const ORDER = ['N', 'E', 'S', 'W'];
const BACK = { N: 'S', S: 'N', E: 'W', W: 'E' };
/** I・L・T 回路（北向きのときの辺。data/buildings と同じ）。 */
const PATH_ARMS = { 'i-circuit': ['N', 'S'], 'l-circuit': ['N', 'E'], 't-circuit': ['W', 'N', 'E'] };

/** 辺の組（2〜3）に合う I・L・T 回路と向き。合わなければ null。 */
export function pathTile(arms) {
  const want = [...arms].sort().join();
  for (const type of Object.keys(PATH_ARMS)) {
    for (const dir of ORDER) {
      if (pathArms({ arms: PATH_ARMS[type] }, dir).sort().join() === want) return { type, dir };
    }
  }
  return null;
}

/** 迷路探索の待ち行列（距離 d が小さい順、同じなら入れた順 s）。 */
class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  less(i, j) { const p = this.a[i], q = this.a[j]; return p.d < q.d || (p.d === q.d && p.s < q.s); }
  swap(i, j) { const t = this.a[i]; this.a[i] = this.a[j]; this.a[j] = t; }
  push(v) {
    const a = this.a; a.push(v);
    for (let i = a.length - 1; i > 0; ) { const p = (i - 1) >> 1; if (!this.less(i, p)) break; this.swap(i, p); i = p; }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && this.less(l, m)) m = l;
        if (r < a.length && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m); i = m;
      }
    }
    return top;
  }
}

class Layout {
  constructor(width, height) {
    this.W = width; this.H = height;
    this.occ = new Map();     // key -> { t: 'net'|'pin'|'gate'|'gen'|'lever'|'res'|'cross', n? }
    this.parts = [];          // 置く建物 { type, x, y, dir }
    this.link = new Map();    // 回路の口のマス -> 回路のある向き（I・L・T 回路にするとき、その辺を開ける）
    this.tight = false;       // 別の線と隣り合ってよいか（隣るマスは、あとで I・L・T 回路にする）
  }
  in(x, y) { return x >= 0 && y >= 0 && x < this.W && y < this.H; }
  get(x, y) { return this.occ.get(key(x, y)); }
  set(x, y, v) { this.occ.set(key(x, y), v); }
  /** 空いているか、空き予約（何も置かない）か。 */
  free(x, y) { return this.in(x, y) && !this.get(x, y); }
  reserve(x, y) { if (this.in(x, y) && !this.get(x, y)) this.set(x, y, { t: 'res' }); }

  /** 線 n の電線を (x, y) に置けるか。隣に別の線・電源があると混ざるので置けない。 */
  canWire(x, y, n, ignore = null) {
    if (!this.in(x, y)) return false;
    const o = this.get(x, y);
    if (o && !((o.t === 'pin' || o.t === 'net') && o.n === n)) return false;
    for (const [dx, dy] of DIRS4) {
      if (ignore && ignore.x === x + dx && ignore.y === y + dy) continue;   // 交差回路になるマス
      const nb = this.get(x + dx, y + dy);
      if (!nb || nb.t === 'res' || nb.t === 'cross') continue;
      if (nb.t === 'gate') { if (!(o && o.t === 'pin')) return false; continue; }   // 回路の隣は決めた口だけ
      if (nb.t === 'gen') return false;
      if (nb.n !== n && !this.tight) return false;
    }
    return true;
  }

  /** 別の線の口（まだつないでいない入口）の近くは通りにくくする（その口へ入れなくなるのを防ぐ）。 */
  crowd(x, y, n) {
    let c = 0;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const o = this.get(x + dx, y + dy);
        if (o && o.t === 'pin' && o.n !== n) c += Math.abs(dx) + Math.abs(dy) <= 2 ? 2 : 1;
      }
    }
    return c;
  }

  /** (x, y) が線 m のまっすぐな電線で、向き (dx, dy) の線 n が交差回路で横切れるか。 */
  canCross(x, y, dx, dy, n) {
    const o = this.get(x, y);
    if (!o || o.t !== 'net' || o.n === n) return false;
    const a = this.get(x + dy, y + dx), b = this.get(x - dy, y - dx);     // 直角の両側
    const c = this.get(x + dx, y + dy), d = this.get(x - dx, y - dy);     // 進む向きの前後
    const same = v => v && v.t === 'net' && v.n === o.n;
    return same(a) && same(b) && !same(c) && !same(d);
  }

  /** 線 n を、すでにつないだマス（tree）から target まで迷路探索でつなぐ。 */
  route(n, tree, target) {
    const dist = new Map(), prev = new Map();
    const heap = new MinHeap();
    let seq = 0;                                   // 同じ距離なら先に入れた方から（前と同じ結果にする）
    const push = (k, x, y, d, from, cross) => {
      if (dist.has(k) && dist.get(k) <= d) return;
      dist.set(k, d); prev.set(k, { from, cross, x, y });
      heap.push({ k, x, y, d, s: seq++ });
    };
    for (const c of tree) push(key(c.x, c.y), c.x, c.y, 0, null, null);
    const tk = key(target.x, target.y);
    while (heap.size) {
      const cur = heap.pop();
      if (cur.d > dist.get(cur.k)) continue;
      if (cur.k === tk) break;
      for (const [dx, dy] of DIRS4) {
        const nx = cur.x + dx, ny = cur.y + dy;
        if (this.canWire(nx, ny, n)) push(key(nx, ny), nx, ny, cur.d + 1 + this.crowd(nx, ny, n), cur.k, null);
        // 別の線をまっすぐ横切る: 手前のマス a → 交差回路 q → 向こうのマス b
        const q = { x: nx + dx, y: ny + dy }, b = { x: nx + 2 * dx, y: ny + 2 * dy };
        if (this.canCross(q.x, q.y, dx, dy, n) && this.canWire(nx, ny, n, q) && this.canWire(b.x, b.y, n, q)) {
          push(key(b.x, b.y), b.x, b.y, cur.d + 6, cur.k, { mid: { x: nx, y: ny }, q });
        }
      }
    }
    if (!dist.has(tk)) return false;
    for (let k = tk; k; ) {
      const p = prev.get(k);
      const o = this.get(p.x, p.y);
      if (!o || o.t !== 'net') this.set(p.x, p.y, { t: 'net', n });
      tree.push({ x: p.x, y: p.y });
      if (p.cross) {
        this.set(p.cross.q.x, p.cross.q.y, { t: 'cross' });
        this.set(p.cross.mid.x, p.cross.mid.y, { t: 'net', n });
        tree.push({ ...p.cross.mid });
      }
      k = p.from;
    }
    return true;
  }
}

/** 型 pattern で並べてつなぐ。できなければ null。 */
function layoutCircuit(n, root, pattern, boost = false, perm = null, direct = false, nearOut = true, leverGen = false, tight = false) {
  if (!root) return null;
  const always = root.kind === 'always';
  const { gates, out } = always ? { gates: [], out: 'out' } : netlist(n, root, boost);
  const dep = depths(gates);
  const maxDepth = gates.length ? Math.max(...Object.values(dep)) : 0;
  // 段ごとの回路
  const cols = [];
  for (const g of gates) (cols[dep[g.id]] = cols[dep[g.id]] || []).push(g);
  const tallest = Math.max(1, ...cols.filter(Boolean).map(c => c.length));
  // 周りに余白を取り、線が回り込めるようにする（できた設計図は外接する長方形に詰める）
  const W = 4 + (maxDepth + 2) * pattern.col + 4 + 6;
  const H = Math.max(n * pattern.inGap + 2, (pattern.line ? 1 : tallest) * pattern.row + 2, 7) + 6 + 8;
  const L = new Layout(W, H);
  L.tight = tight;
  const pins = {};                  // net -> 入る口のマス [{x, y}]
  const sources = {};               // net -> 出る口のマス {x, y}
  const addPin = (net, x, y) => { (pins[net] = pins[net] || []).push({ x, y }); L.set(x, y, { t: 'pin', n: net }); };

  // 入力: レバー → 線（レバーは入っているあいだ自分が電源。全部いつも出す回路なら、発電機だけ）
  const inTop = Math.floor((H - (n - 1) * pattern.inGap) / 2);
  if (always) {
    const y = Math.floor(H / 2);
    L.set(1, y, { t: 'lever', n: out }); L.parts.push({ type: 'generator', x: 1, y, dir: 'N' });   // 線の出元なので lever と同じ扱い
    for (const [dx, dy] of DIRS4) if (dx !== 1) L.reserve(1 + dx, y + dy);
    sources[out] = { x: 2, y };
  } else {
    for (let i = 0; i < n; i++) {
      const y = inTop + (perm ? perm.indexOf(i) : i) * pattern.inGap;     // perm: 上から並べるレバーの順
      L.set(1, y, { t: 'lever', n: `in${i}` }); L.parts.push({ type: 'lever', x: 1, y, dir: 'N', input: i });
      // leverGen: レバーの電気は発電機の半分（強さ12）なので、線が長いと届かない。そのときは隣に発電機を置き、
      // 入っているあいだ発電機の電気を通す（切れていれば通さない）
      if (leverGen) { L.set(0, y, { t: 'gen' }); L.parts.push({ type: 'generator', x: 0, y, dir: 'N' }); }
      for (const [x, yy] of [[0, y], [0, y - 1], [0, y + 1], [1, y - 1], [1, y + 1]]) L.reserve(x, yy);
      sources[`in${i}`] = { x: 2, y };
    }
  }
  // 回路
  let lineX = 4;
  const netY = net => (sources[net] ? sources[net].y : (gates.find(g => g.out === net && g.at) || { at: { y: H / 2 } }).at.y);
  cols.forEach((list, d) => {
    if (!list) return;
    // 入ってくる線の高さの平均で並べる（線が交わりにくくなる）
    const bary = g => g.ins.reduce((a, net) => a + netY(net), 0) / g.ins.length;
    list.sort((a, b) => bary(a) - bary(b));
    list.forEach((g, j) => {
      let x, y;
      if (pattern.line) { x = lineX; y = Math.floor(H / 2); lineX += pattern.col; }
      else {
        x = 4 + d * pattern.col;
        const top = Math.floor((H - (list.length - 1) * pattern.row) / 2);
        y = top + j * pattern.row + (pattern.stagger && d % 2 ? Math.floor(pattern.row / 2) : 0);
      }
      if (!L.in(x + 1, y + 2) || y < 2) return;
      for (const [cx, cy] of [[x, y], [x, y - 1], [x, y + 1], [x - 1, y], [x + 1, y]]) {
        if (L.get(cx, cy)) { g.bad = true; }
      }
      if (g.bad) return;
      L.set(x, y, { t: 'gate' }); L.parts.push({ type: 'logic-circuit', x, y, dir: 'E' });
      g.at = { x, y };
      // 3つの口（上・下・背面）に、線・発電機・空きを割り当てる。線は来る方向に近い口へ
      const sides = { N: [x, y - 1], S: [x, y + 1], W: [x - 1, y] };
      const free = new Set(['N', 'S', 'W']);
      const nets = g.sig.filter(v => v !== '1' && v !== '0').sort((a, b) => Math.abs(netY(b) - y) - Math.abs(netY(a) - y));
      for (const net of nets) {
        const ny = netY(net);
        const pref = ny < y ? ['N', 'W', 'S'] : ny > y ? ['S', 'W', 'N'] : ['W', 'N', 'S'];
        const side = pref.find(sd => free.has(sd));
        free.delete(side);
        addPin(net, ...sides[side]);
        L.link.set(key(...sides[side]), BACK[side]);
      }
      const rest = [...free];
      for (const v of g.sig.filter(v => v === '1' || v === '0')) {
        const side = rest.shift();
        const [cx, cy] = sides[side];
        if (v === '0') { L.reserve(cx, cy); continue; }
        L.set(cx, cy, { t: 'gen' }); L.parts.push({ type: 'generator', x: cx, y: cy, dir: 'N' });
        for (const [dx, dy] of DIRS4) {
          const nx = cx + dx, ny = cy + dy;
          if (nx === x && ny === y) continue;
          const o = L.get(nx, ny);
          if (o && o.t !== 'res') g.bad = true;                // 発電機の隣に線があると電気が漏れる
          L.reserve(nx, ny);
        }
      }
      if (sources[g.out]) addPin(g.out, x + 1, y);            // 「または」: 同じ線に出す2つ目以降の回路
      else { L.set(x + 1, y, { t: 'pin', n: g.out }); sources[g.out] = { x: x + 1, y }; }
      L.link.set(key(x + 1, y), 'W');
    });
  });
  if (gates.some(g => g.bad || !g.at)) return null;
  // direct: 1か所でしか使わないレバーは、左端に並べずに回路の口へ直接置く。線が要らない
  let moved = 0;
  if (direct) {
    for (let i = 0; i < n; i++) {
      const net = `in${i}`;
      const list = pins[net] || [];
      if (list.length !== 1) continue;
      const p = list[0];
      const g = gates.find(gg => Math.abs(gg.at.x - p.x) + Math.abs(gg.at.y - p.y) === 1);
      if (!g) continue;
      const around = c => DIRS4.map(([dx, dy]) => ({ x: c.x + dx, y: c.y + dy }));
      // レバーは電源なので、回路の口のほかに隣り合う物があってはいけない（電気が漏れる）
      if (!around(p).every(q => (q.x === g.at.x && q.y === g.at.y) || !L.get(q.x, q.y) || L.get(q.x, q.y).t === 'res')) continue;
      // 左端のレバーを外す
      const src = sources[net];
      const li = L.parts.findIndex(q => q.type === 'lever' && q.input === i);
      L.parts.splice(li, 1);
      const gi = L.parts.findIndex(q => q.type === 'generator' && q.x === 0 && q.y === src.y);
      if (gi >= 0) L.parts.splice(gi, 1);
      for (const [x, yy] of [[0, src.y], [1, src.y], [0, src.y - 1], [0, src.y + 1], [1, src.y - 1], [1, src.y + 1]]) L.occ.delete(key(x, yy));
      delete sources[net]; delete pins[net];
      L.set(p.x, p.y, { t: 'lever', n: net }); L.parts.push({ type: 'lever', x: p.x, y: p.y, dir: 'N', input: i });
      for (const q of around(p)) L.reserve(q.x, q.y);
      moved++;
    }
  }
  // 出力の口（右端）
  // 出力の口は、出力を出す回路の正面のマスそのもの（線を延ばさない。遠いと電気が弱まり、場所も取る）
  let ox, oy;
  if (sources[out] && !always && nearOut) {
    ({ x: ox, y: oy } = sources[out]);
    if (!L.get(ox, oy)) L.set(ox, oy, { t: 'pin', n: out });        // 回路が無い（レバーそのまま）ときは、レバーの隣の電線1マス
  }
  else {
    ox = Math.min(W - 2, (gates.length ? Math.max(...gates.map(g => g.at.x)) : 2) + 3); oy = Math.floor(H / 2);
    if (L.get(ox, oy)) return null;
    addPin(out, ox, oy);
  }
  // 線をつなぐ。つなげない線があったら、その線を先にしてやり直す（最大 6 回。つなげる配置は、ほとんどが 1〜3 回目でつながる。
  // 型・並び順の違う試しがたくさんあるので、つながらない配置に時間をかけない）
  const base = new Map(L.occ);
  let order = Object.keys(pins).sort((a, b) => (pins[a].length - pins[b].length) || (a < b ? -1 : 1));
  let done = false;
  for (let attempt = 0; attempt < 6 && !done; attempt++) {
    L.occ = new Map(base);
    let failed = null;
    for (const net of order) {
      const src = sources[net] || pins[net][0];
      if (!L.canWire(src.x, src.y, net)) { failed = net; break; }
      L.set(src.x, src.y, { t: 'net', n: net });
      const tree = [{ ...src }];
      const targets = pins[net].filter(p => p.x !== src.x || p.y !== src.y)
        .sort((a, b) => (Math.abs(a.x - src.x) + Math.abs(a.y - src.y)) - (Math.abs(b.x - src.x) + Math.abs(b.y - src.y)));
      if (!targets.every(t => L.route(net, tree, t))) { failed = net; break; }
    }
    if (!failed) done = true;
    else if (order[0] === failed) order = [...order.slice(1), failed];   // 先頭でもだめなら後ろへ
    else order = [failed, ...order.filter(x => x !== failed)];
  }
  if (!done) return null;
  if (L.get(ox, oy) && L.get(ox, oy).t === 'pin') L.set(ox, oy, { t: 'net', n: out });   // 線をつながなかった出力の口も電線にする
  // 建物にする。別の物と隣り合う電線は、自分の線の向きだけを開けた I・L・T 回路にする（tight のときだけ起きる）
  const parts = [...L.parts];
  let tiles = 0;
  for (let y = 0; y < L.H; y++) {
    for (let x = 0; x < L.W; x++) {
      const o = L.get(x, y);
      if (!o) continue;
      if (o.t === 'cross') { parts.push({ type: 'cross-circuit', x, y, dir: 'N' }); continue; }
      if (o.t !== 'net') continue;
      const own = [], open = [];
      let foreign = false;
      for (const d of ORDER) {
        const nb = L.get(x + STEP[d][0], y + STEP[d][1]);
        if (L.link.get(key(x, y)) === d || (nb && nb.t === 'cross')) own.push(d);
        else if (nb && (nb.t === 'net' || nb.t === 'pin' || nb.t === 'lever') && nb.n === o.n) own.push(d);
        else if (!nb || nb.t === 'res') open.push(d);
        else foreign = true;
      }
      if (!foreign) { parts.push({ type: 'wire', x, y, dir: 'N' }); continue; }
      if (own.length === 1) {                        // 行き止まり: 空いている辺を1つ足す（まっすぐを先に）
        const extra = [BACK[own[0]], ...open].find(d => open.includes(d));
        if (!extra) return null;
        own.push(extra);
      }
      const tile = pathTile(own);
      if (!tile) return null;
      parts.push({ type: tile.type, x, y, dir: tile.dir });
      tiles++;
    }
  }
  return { parts, out: { x: ox, y: oy }, moved, tiles };
}

/* ---------- 4. 確かめる ---------- */

/** 盤面に置いて、全部の組み合わせで出力が表どおりか確かめる。 */
export function verifyCircuit(registry, n, table, parts, outCell) {
  const xs = parts.map(p => p.x), ys = parts.map(p => p.y);
  const w = new World({ width: Math.max(...xs) + 3, height: Math.max(...ys) + 3 });
  for (const p of parts) if (!place(w, registry.building(p.type), p.x + 1, p.y + 1, p.dir)) return false;
  const sim = new Sim(w, registry);
  const levers = parts.filter(p => p.type === 'lever').sort((a, b) => a.input - b.input);
  const on = levers.map(() => false);
  for (let r = 0; r < 1 << n; r++) {
    levers.forEach((l, i) => {
      const want = inputOn(r, l.input, n);
      if (on[i] !== want) { toggleLever(sim, l.x + 1, l.y + 1); on[i] = want; }
    });
    sim.sync();
    const powered = (sim.power.get(key(outCell.x + 1, outCell.y + 1)) || 0) >= 1;
    if (powered !== !!table[r]) return false;
  }
  return true;
}

/* ---------- まとめ ---------- */

function permutations(list) {
  if (list.length <= 1) return [list];
  const out = [];
  list.forEach((v, i) => { for (const rest of permutations(list.filter((_, j) => j !== i))) out.push([v, ...rest]); });
  return out;
}

/**
 * 真理値表 table（長さ 2^n。A が上の桁）から、型ごとの回路を作って確かめ、よい順に並べる。
 * 戻り値: { terms, text, candidates: [{ pattern, name, kinds, blueprint, width, height, area, count, bends, input, output }], all }
 * candidates は「建物が最少」「見てわかりやすい」の2つ（同じなら1つ）。all は確かめた配置の全部（面積の小さい順）
 */
export function generateCircuits(registry, n, table) {
  if (!(n >= 1 && n <= MAX_INPUTS)) throw new Error(`入力は1〜${MAX_INPUTS}つ`);
  const terms = minimize(n, table);
  const text = termsText(n, terms);
  const root = synthFor(n, table);
  const how = synthText(n, table);
  const candidates = [];
  const seen = new Set();
  // 型 × 強め直しの有無 × レバーの並び順（入力が3つなら6通り）を全部試す
  const perms = permutations([...Array(n).keys()]);
  const tries = [];
  for (const tight of [false, true]) for (const direct of [true, false]) for (const boost of [false, true]) for (const p of PATTERNS) for (const perm of perms) {
    if (p.tightOnly && !tight) continue;
    tries.push({ pattern: p, boost, perm, direct, tight });
  }
  // レバーは電源（強さ12）。まず発電機なしで試し、レバーの電気が届かず1つも作れないときだけ、
  // 左端のレバーの隣に発電機を置いて強める形も試す
  const attempt = (leverGen) => (t, order) => {
    const { pattern, boost, perm, direct, tight } = t;
    // 出力の口は回路のすぐ前（線を延ばさない）。つなげなければ、少し先に離してもう一度
    let got = layoutCircuit(n, root, pattern, boost, perm, direct, true, leverGen, tight);
    if (!got || !verifyCircuit(registry, n, table, got.parts, got.out)) {
      got = layoutCircuit(n, root, pattern, boost, perm, direct, false, leverGen, tight);
      if (!got || !verifyCircuit(registry, n, table, got.parts, got.out)) return;
    }
    const gen = leverGen && got.parts.some(p => p.type === 'generator' && p.x === 0);
    // 外接する長方形に詰める
    const x0 = Math.min(...got.parts.map(p => p.x)), y0 = Math.min(...got.parts.map(p => p.y));
    const x1 = Math.max(...got.parts.map(p => p.x)), y1 = Math.max(...got.parts.map(p => p.y));
    const buildings = got.parts
      .map(p => ({ type: p.type, x: p.x - x0, y: p.y - y0, dir: p.dir }))
      .sort((a, b) => (a.y - b.y) || (a.x - b.x) || (a.type < b.type ? -1 : 1));
    const sig = JSON.stringify(buildings);
    if (seen.has(sig)) return;                      // 違う型でも同じ形になったら1つだけ
    seen.add(sig);
    const width = x1 - x0 + 1, height = y1 - y0 + 1;
    const name = `回路 ${text}（${pattern.name}${boost ? '・強め直し' : ''}）`;
    candidates.push({
      pattern: pattern.id, boost, name, order,
      patternName: pattern.name + (boost ? '・強め直し' : '') + (got.moved ? '・レバー直付け' : '') + (got.tiles ? '・I/L/T回路' : '') + (gen ? '・発電機でレバーを強める' : '') + (perm.some((v, i) => v !== i) ? `・${perm.map(i => INPUT_NAMES[i]).join('')}順` : ''),
      tiles: got.tiles || 0,
      gates: buildings.filter(b => b.type === 'logic-circuit').length, width, height, area: width * height, count: buildings.length,
      input: got.parts.filter(p => p.type === 'lever').sort((a, b) => a.input - b.input).map(p => ({ x: p.x - x0, y: p.y - y0 })),
      output: { x: got.out.x - x0, y: got.out.y - y0 },
      blueprint: { format: BLUEPRINT_FORMAT, version: BLUEPRINT_VERSION, name, width, height, buildings },
    });
  };
  tries.forEach(attempt(false));
  if (!candidates.length) tries.forEach((t, i) => attempt(true)(t, tries.length + i));
  for (const c of candidates) c.bends = countBends(c.blueprint.buildings);
  candidates.sort((a, b) => (a.area - b.area) || (a.count - b.count) || (a.order - b.order));
  return { terms, text, how, candidates: pickCircuits(candidates), all: candidates };
}

/** 電線（I・L・T 回路も）の曲がり角の数。つながる先がちょうど2方向で、それが縦と横のマス。T字は数えない。 */
export function countBends(buildings) {
  const at = new Map(buildings.map(b => [`${b.x},${b.y}`, b]));
  const sides = b => b.type === 'wire' ? ORDER : PATH_ARMS[b.type] ? pathArms({ arms: PATH_ARMS[b.type] }, b.dir) : null;
  let n = 0;
  for (const b of buildings) {
    const mine = sides(b);
    if (!mine) continue;
    const conn = mine.filter(d => {
      const nb = at.get(`${b.x + STEP[d][0]},${b.y + STEP[d][1]}`);
      if (!nb) return false;
      const theirs = sides(nb);
      return !theirs || theirs.includes(BACK[d]);       // 電線・I・L・T 回路どうしは、両方の辺が向き合うときだけ
    });
    const h = conn.filter(d => d === 'E' || d === 'W').length, v = conn.length - h;
    if (h === 1 && v === 1) n++;
  }
  return n;
}

/**
 * 見て仕組みがわかりやすいか。左の辺にレバーが A・B・C の順に上から並び、出力が右の辺にある
 * （左から右へ信号が流れる図）なら clear。そのうえで、曲がり角・交差回路・I・L・T 回路の数が少ないほどよい。
 */
export function clarity(c) {
  const ins = c.input;
  const clear = ins.every(p => p.x === 0) && ins.every((p, i) => i === 0 || ins[i - 1].y < p.y) && c.output.x === c.width - 1;
  // 交差回路・I・L・T 回路は、見て向きを読み取る必要がある部品なので、曲がり角と同じく1つと数える
  const special = c.blueprint.buildings.filter(b => b.type === 'cross-circuit' || PATH_ARMS[b.type]).length;
  return { clear, turns: c.bends + special };
}

/**
 * 候補を2種類だけに絞る（ユーザーの希望 2026-10-07「型が増えても結局はこの二つ」）:
 * 「建物が最少」と「見てわかりやすい」（曲がりが最少。ユーザーの言葉では「視覚的に仕組みがわかりやすい」）。
 * わかりやすいほうは、左にレバー・右に出力の図になっている物を先に、曲がり角＋交差 → 建物 → 面積の少ない順。
 * 同じ配置なら1つにまとめる。
 */
export function pickCircuits(list) {
  if (!list.length) return [];
  const pick = cmp => list.reduce((m, c) => (cmp(c, m) < 0 ? c : m));
  const fewest = pick((a, b) => a.count - b.count || a.bends - b.bends || a.area - b.area || a.order - b.order);
  const readable = pick((a, b) => {
    const x = clarity(a), y = clarity(b);
    return (y.clear - x.clear) || (x.turns - y.turns) || a.count - b.count || a.area - b.area || a.order - b.order;
  });
  const out = [{ ...fewest, kinds: ['建物が最少'] }];
  if (readable === fewest) out[0].kinds.push('見てわかりやすい');
  else out.push({ ...readable, kinds: ['見てわかりやすい'] });
  return out;
}
