/* 電気の入り切りを組み合わせる部品（Core Keeper の論理回路など。ユーザーの依頼 2026-10-06）。
 *
 * 部品（data の signal.type）と、資料の記述（https://corekeeper.atma.gg/en/ の各ページ、2026-10-06 に確認）:
 *   lever   レバー。「Generates a low amount of electricity that can be turned on and off」
 *           「currently (v1.0.0.8) levers can power any electrical device, including drills」
 *           → **入っているあいだ電源になる**（発電機は要らない。ユーザーの指摘 2026-10-07）。強さは signal.source
 *             （資料に数は無い。ユーザーが教えてくれたゲームの値で 12＝発電機の半分。2026-10-07）。
 *             入っているときは電線と同じく電気も通す。置いた直後は切れている。クリックで入り切り
 *   plate   感圧板。「Generates a low amount of electricity」「stepped on by the player」
 *           → 人はいないので、**そのマスの床に物があるあいだ**電源になる。強さは signal.source（仮に 5）
 *   logic   論理回路。「Electricity can move through the circuit when it receives electricity on exactly 2 out of 3 inputs」
 *           → 入力は左・右・背面の3マス。**ちょうど2つ**に電気が来ているとき、正面のマスへ電気を出す
 *   delay   遅延回路。「Stores electricity input and sends it out during intervals of 1 second」
 *           → 背面から入った電気を、signal.seconds（1秒）遅れて正面へ出す
 *   cross   交差回路。「Separates horizontal and vertical wires. Allows crossing wires without connecting」
 *           → 来た向きのまま、まっすぐ向こう側へだけ通す（縦と横が混ざらない）
 * 入出力の向き・強さの下がり方は資料に無いので仮に決めた。回路から出る電気の強さは「入った強さ − 1」。
 *
 * 計算: 部品が盤面に1つでもあれば、power.js の差分計算の代わりにここで盤面全体を計算し直す。
 * 計算し直すのは、盤面・レバー・感圧板・遅延回路の出力のどれかが変わったときだけ。
 * 論理回路どうしがつながると答えが1回で決まらないので、変わらなくなるまで（最大 8 回）繰り返す。
 *
 * **描画も DOM も知らない。**
 */

import { DELTA, DIRS, OPPOSITE, footprint, key } from './grid.js';
import { isPowered, powerDef } from './power.js';

const MAX_ROUNDS = 8;
const LEFT = { N: 'W', E: 'N', S: 'E', W: 'S' };
const RIGHT = { N: 'E', E: 'S', S: 'W', W: 'N' };

export function signalDef(registry, building) {
  const def = building && registry.building(building.type);
  return (def && def.signal) || null;
}

export function makeSignal(def) {
  if (def.type === 'delay') return { on: false, level: 0, history: [] };
  return { on: false, level: 0 };
}

const step = (c, d) => ({ x: c.x + DELTA[d].x, y: c.y + DELTA[d].y });

/** 論理回路・遅延回路の入力のマス（向きごと）。 */
export function signalInputs(b, def) {
  const dir = b.dir || 'N';
  if (def.type === 'logic') return [LEFT[dir], RIGHT[dir], OPPOSITE[dir]].map(d => ({ dir: d, ...step(b, d) }));
  if (def.type === 'delay') return [{ dir: OPPOSITE[dir], ...step(b, OPPOSITE[dir]) }];
  return [];
}

export function signalOutput(b) { return step(b, b.dir || 'N'); }

/** 盤面に部品があるか。 */
export function hasSignals(sim) { return sim.signals.size > 0; }

/** 部品の入り切りの合図（これが変わらなければ計算し直さない）。 */
function signature(sim) {
  let s = '';
  for (const [id, st] of sim.signals) {
    const def = signalDef(sim.registry, sim.world.buildings.get(id));
    if (!def) continue;
    if (def.type === 'lever') s += st.on ? 'L' : 'l';
    else if (def.type === 'plate') { const b = sim.world.buildings.get(id); s += plateActive(sim, b) ? 'P' : 'p'; }
    else if (def.type === 'delay') s += `d${delayedLevel(sim, st, def)}`;
    s += id + ',';
  }
  return s;
}

function plateActive(sim, b) {
  const g = sim.groundAt(b.x, b.y);
  return !!(g && g.length);
}

function delayedLevel(sim, st, def) {
  const n = Math.max(1, Math.round((def.seconds || 1) * sim.tickHz));
  return st.history.length >= n ? st.history[st.history.length - n] : 0;
}

/** 電気の届き方を盤面全体で計算し直す。sim.power と sim.unpowered を書き換える。 */
export function computeSignals(sim, force = false) {
  const { world, registry } = sim;
  const sig = `${world.revision}|${signature(sim)}`;
  if (!force && sig === sim.signalSig) return;
  sim.signalSig = sig;

  // マスの種類: 'c' 電気を通す、'x' 交差回路、'g' 回路（自分では通さない）
  const kind = new Map();
  const starts = [];
  const gates = [];
  // 先に部品のマスを決める（同じマスの床に電線があっても、部品の決まりが勝つ。切れたレバーの下の電線は通さない）
  world.forEach(b => {
    const s = signalDef(registry, b);
    if (!s) return;
    const st = sim.signals.get(b.id);
    for (const c of footprint(b.x, b.y, b.size, b.dir)) {
      const k = key(c.x, c.y);
      if (s.type === 'cross') kind.set(k, 'x');
      else if (s.type === 'logic' || s.type === 'delay') kind.set(k, 'g');
      else if (s.type === 'lever') {
        kind.set(k, st && st.on ? 'c' : 'off');
        if (st && st.on) starts.push({ x: c.x, y: c.y, level: (s.source || 12) + 1 });
      }
      else if (s.type === 'plate') {
        kind.set(k, 'off');
        if (plateActive(sim, b)) starts.push({ x: c.x, y: c.y, level: (s.source || 5) + 1 });
      }
    }
    if (s.type === 'logic' || s.type === 'delay') gates.push({ b, def: s, st });
  });
  world.forEach(b => {
    const p = powerDef(registry, b);
    if (!p || signalDef(registry, b)) return;
    for (const c of footprint(b.x, b.y, b.size, b.dir)) {
      const k = key(c.x, c.y);
      if (p.conducts && !kind.has(k)) kind.set(k, 'c');
      if (p.source > 0) starts.push({ x: c.x, y: c.y, level: p.source + 1 });
    }
  });

  const levelIn = (best, gateOut, g, cell) => {
    // 隣が回路で、その出力がこのマスを向いていれば、その回路の出力を入力とみなす
    const up = gateOut.get(key(cell.x, cell.y));
    if (up && up.to === key(g.b.x, g.b.y)) return up.level;
    const k = key(cell.x, cell.y);
    const t = kind.get(k);
    if (t !== 'c' && !starts.some(s => s.x === cell.x && s.y === cell.y)) return 0;
    return best.get(k) || 0;
  };

  let best = new Map();
  let gateOut = new Map();                 // 回路のマスの鍵 -> { to: 正面のマスの鍵, level }
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const seeds = [...starts];
    for (const [, o] of gateOut) {
      if (o.level > 0 && kind.get(o.to) === 'c') {
        const { x, y } = o.cell;
        seeds.push({ x, y, level: o.level });
      }
    }
    best = new Map();
    spread(best, seeds, kind);
    const next = new Map();
    for (const g of gates) {
      const out = signalOutput(g.b);
      let level = 0;
      if (g.def.type === 'logic') {
        const ins = signalInputs(g.b, g.def).map(c => levelIn(best, gateOut, g, c));
        const on = ins.filter(v => v >= 1);
        if (on.length === 2) level = Math.max(...on) - 1;
      } else {
        level = delayedLevel(sim, g.st, g.def);
      }
      if (g.st) { g.st.on = level >= 1; g.st.level = level; }
      if (level >= 1) next.set(key(g.b.x, g.b.y), { to: key(out.x, out.y), cell: out, level });
    }
    const same = next.size === gateOut.size && [...next].every(([k, o]) => gateOut.has(k) && gateOut.get(k).level === o.level);
    gateOut = next;
    if (same) break;
  }
  sim.power = best;
  sim.unpowered = new Set();
  world.forEach(b => { if (!isPowered(sim.power, registry, b)) sim.unpowered.add(b.id); });
  // 遅延回路の入力（1 tick に1回、recordDelays で記録）のために、今の入力の強さを覚えておく
  sim.gateInputs = gates.filter(g => g.def.type === 'delay')
    .map(g => ({ id: g.b.id, level: levelIn(best, gateOut, g, signalInputs(g.b, g.def)[0]) }));
}

/** 遅延回路の入力を1 tick ぶん記録する。step() の最後に呼ぶ。 */
export function recordDelays(sim) {
  for (const { id, level } of sim.gateInputs || []) {
    const st = sim.signals.get(id);
    const def = signalDef(sim.registry, sim.world.buildings.get(id));
    if (!st || !def) continue;
    st.history.push(level >= 1 ? level - 1 : 0);
    const keep = Math.max(1, Math.round((def.seconds || 1) * sim.tickHz));
    if (st.history.length > keep) st.history.splice(0, st.history.length - keep);
  }
}

/** power.js の spread と同じ。ただし交差回路は、来た向きのまままっすぐ飛び越える。 */
function spread(best, starts, kind) {
  const queue = [];
  for (const s of starts) {
    const k = key(s.x, s.y);
    if ((best.get(k) || 0) < s.level) { best.set(k, s.level); queue.push(s); }
  }
  for (let i = 0; i < queue.length; i++) {
    const { x, y } = queue[i];
    const lv = best.get(key(x, y));
    if (lv <= 1) continue;
    for (const d of DIRS) {
      let nx = x + DELTA[d].x, ny = y + DELTA[d].y, nlv = lv - 1;
      // 交差回路: 向こう側のマスへ（いくつ並んでいても、まっすぐ）
      while (kind.get(key(nx, ny)) === 'x' && nlv > 1) {
        const ck = key(nx, ny);
        if ((best.get(ck) || 0) < nlv) best.set(ck, nlv);   // 表示用（ここからは広げない）
        nx += DELTA[d].x; ny += DELTA[d].y; nlv -= 1;
      }
      const nk = key(nx, ny);
      if (kind.get(nk) !== 'c') continue;
      if ((best.get(nk) || 0) >= nlv) continue;
      best.set(nk, nlv);
      queue.push({ x: nx, y: ny, level: nlv });
    }
  }
}

/** レバーを入れる・切る。レバーでなければ null、入れ替えたら新しい状態。 */
export function toggleLever(sim, x, y) {
  const b = sim.world.at(x, y);
  const def = signalDef(sim.registry, b);
  if (!def || def.type !== 'lever') return null;
  const st = sim.signals.get(b.id);
  st.on = !st.on;
  return st.on;
}
