/* core の自動テスト。
 *
 * この環境には Node が無いので、ブラウザで走らせる（tests.html を開く）。
 * core は DOM を知らないので、ここでは描画も入力も使わない。
 */

import { CHUNK, DELTA, footprint, key, neighbors, parseKey, rotateCW, rotatedSize } from './core/grid.js';
import { ChunkLayer } from './core/chunks.js';
import { World } from './core/world.js';
import { PathPlacer, canPlace, pathCells, place, removeAt, rotateAt } from './core/placement.js';
import { Registry } from './core/registry.js';
import { Sim, TICK_HZ } from './core/sim.js';
import { buildBeltLines } from './core/belt.js';
import { makeSnapshot } from './core/snapshot.js';
import { ViewSim, ViewWorld } from './render/view.js';
import { wireColors } from './render/renderer.js';
import { splitStack, splitterAccepts } from './core/splitter.js';
import { captureBlueprint, checkBlueprint, flipBlueprint, moveArea, pasteBlueprint, previewBlueprint, rectFrom, rotateBlueprint } from './core/blueprint.js';
import { Engine } from './worker/engine.js';
import { checkSize, countOutside, loadSave, makeSave, resizeSave } from './core/save.js';
import { stackLimit } from './core/inventory.js';
import { toggleLever } from './core/signal.js';
import { generateCircuits } from './core/circuitgen.js';

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, message: e.message }); }
}
function eq(a, b, msg = '') {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${msg} 期待 ${sb} / 実際 ${sa}`);
}
function ok(v, msg = '') { if (!v) throw new Error(msg || '偽でした'); }

const SIZE_1 = { width: 1, height: 1 };
const SIZE_2 = { width: 2, height: 2 };
const SIZE_12 = { width: 1, height: 2 };
const defBelt = { id: 'belt', name: 'ベルト', size: SIZE_1, directional: true };
const defFurnace = { id: 'furnace', name: '炉', size: SIZE_2, directional: false };
const defChest = { id: 'chest', name: '箱', size: SIZE_12, directional: true };

/* ---- grid ---- */
test('向きは時計回りに回る', () => {
  eq(rotateCW('N'), 'E'); eq(rotateCW('E'), 'S');
  eq(rotateCW('S'), 'W'); eq(rotateCW('W'), 'N');
});
test('東西を向くと縦横が入れ替わる', () => {
  eq(rotatedSize(SIZE_12, 'N'), { width: 1, height: 2 });
  eq(rotatedSize(SIZE_12, 'E'), { width: 2, height: 1 });
});
test('占有するマスを列挙できる', () => {
  eq(footprint(3, 4, SIZE_2).length, 4);
  eq(footprint(3, 4, SIZE_2)[3], { x: 4, y: 5 });
});
test('上下左右のマスが出る', () => {
  const n = neighbors(5, 5);
  eq(n.length, 4);
  eq(n.find(c => c.dir === 'N'), { x: 5, y: 4, dir: 'N' });
  eq(DELTA.E, { x: 1, y: 0 });
});

/* ---- world ---- */
test('置いた建物をマスから引ける', () => {
  const w = new World({ width: 10, height: 10 });
  const b = w.add({ type: 'furnace', x: 2, y: 2, dir: 'N', size: SIZE_2 });
  ok(w.at(2, 2) === b, '左上で引けない');
  ok(w.at(3, 3) === b, '2x2 の右下で引けない');
  ok(w.at(4, 4) === null, '範囲外のマスに何かある');
  eq(w.count, 1);
});
test('撤去すると占有も消える', () => {
  const w = new World({ width: 10, height: 10 });
  const b = w.add({ type: 'furnace', x: 0, y: 0, dir: 'N', size: SIZE_2 });
  w.remove(b);
  eq(w.count, 0);
  ok(w.at(1, 1) === null, '占有が残っている');
});
test('変更のたびに revision が増える', () => {
  const w = new World({ width: 5, height: 5 });
  const r0 = w.revision;
  const b = w.add({ type: 'chest', x: 0, y: 0, dir: 'N', size: SIZE_1 });
  ok(w.revision > r0, '追加で増えない');
  const r1 = w.revision;
  w.remove(b);
  ok(w.revision > r1, '撤去で増えない');
});
test('保存して読み戻せる', () => {
  const reg = { building: id => ({ belt: defBelt, furnace: defFurnace }[id]) };
  const w = new World({ width: 8, height: 8 });
  w.add({ type: 'belt', x: 1, y: 1, dir: 'E', size: SIZE_1 });
  w.add({ type: 'furnace', x: 3, y: 3, dir: 'N', size: SIZE_2 });
  const back = World.fromJSON(JSON.parse(JSON.stringify(w)), reg);
  eq(back.count, 2);
  eq(back.at(1, 1).dir, 'E');
  ok(back.at(4, 4), '2x2 が復元されていない');
});
test('知らない建物は読み飛ばす', () => {
  const reg = { building: id => (id === 'belt' ? defBelt : undefined) };
  const back = World.fromJSON(
    { width: 5, height: 5, buildings: [{ type: 'belt', x: 0, y: 0 }, { type: '謎', x: 2, y: 2 }] }, reg);
  eq(back.count, 1);
});

/* ---- placement ---- */
test('盤面の外には置けない', () => {
  const w = new World({ width: 4, height: 4 });
  eq(canPlace(w, defFurnace, 3, 3).ok, false);
  eq(canPlace(w, defFurnace, 2, 2).ok, true);
});
test('重ねて置けない', () => {
  const w = new World({ width: 8, height: 8 });
  ok(place(w, defFurnace, 1, 1, 'N'), '1つ目が置けない');
  eq(canPlace(w, defBelt, 2, 2).ok, false, '2x2 の内側に置けてしまう');
  eq(place(w, defBelt, 2, 2, 'N'), null);
  eq(w.count, 1);
});
test('撤去できる', () => {
  const w = new World({ width: 8, height: 8 });
  place(w, defFurnace, 0, 0, 'N');
  ok(removeAt(w, 1, 1), '2x2 の一部を指して撤去できない');
  eq(w.count, 0);
});
test('向きのある建物だけ回る', () => {
  const reg = { building: id => ({ belt: defBelt, furnace: defFurnace }[id]) };
  const w = new World({ width: 8, height: 8 });
  place(w, defBelt, 2, 2, 'N');
  eq(rotateAt(w, reg, 2, 2).dir, 'E');
  place(w, defFurnace, 4, 4, 'N');
  eq(rotateAt(w, reg, 4, 4), null, '向きを持たない建物が回った');
});
test('回すと入らない場所では元に戻す', () => {
  const reg = { building: id => (id === 'chest' ? defChest : undefined) };
  const w = new World({ width: 2, height: 4 });
  place(w, defChest, 0, 0, 'N');        // 1x2 縦。回すと 2x1 で、右に 1 マスしかない
  place(w, defChest, 1, 0, 'N');        // 右隣を埋める
  eq(rotateAt(w, reg, 0, 0), null, '重なるのに回ってしまった');
  eq(w.at(0, 0).dir, 'N', '元の向きに戻っていない');
  eq(w.count, 2);
});
test('マウスの道は上下左右だけでつながる（飛んだマスも埋める）', () => {
  eq(pathCells({ x: 0, y: 0 }, { x: 3, y: 0 }), [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }]);
  eq(pathCells({ x: 0, y: 0 }, { x: 1, y: 1 }), [{ x: 1, y: 0 }, { x: 1, y: 1 }]);
  eq(pathCells({ x: 2, y: 2 }, { x: 2, y: 2 }), []);
  const p = pathCells({ x: 0, y: 0 }, { x: -3, y: 5 });
  eq(p[p.length - 1], { x: -3, y: 5 });
  let prev = { x: 0, y: 0 };
  for (const c of p) { eq(Math.abs(c.x - prev.x) + Math.abs(c.y - prev.y), 1, '隣り合っていない'); prev = c; }
});
const defBox = { id: 'box', name: '箱', size: SIZE_1, directional: false };
const pathReg = { building: id => ({ belt: defBelt, box: defBox }[id]) };
test('ドラッグは通った道どおりに置き、ベルトは曲がり角で進む向きに回る', () => {
  const w = new World({ width: 10, height: 10 });
  const pp = new PathPlacer(w, pathReg, defBelt, 'N');
  pp.start(1, 1);
  pp.extend(pathCells({ x: 1, y: 1 }, { x: 3, y: 1 }));   // 右へ
  pp.extend(pathCells({ x: 3, y: 1 }, { x: 3, y: 3 }));   // 下へ曲がる
  const dirs = [[1, 1], [2, 1], [3, 1], [3, 2], [3, 3]].map(([x, y]) => w.at(x, y) && w.at(x, y).dir);
  eq(dirs, ['E', 'E', 'S', 'S', 'S']);
  eq(w.count, 5);
});
test('ドラッグは前からある建物を上書きも回しもしない・戻っても回さない', () => {
  const w = new World({ width: 10, height: 10 });
  const old = place(w, defBelt, 3, 1, 'N');
  const pp = new PathPlacer(w, pathReg, defBelt, 'N');
  pp.start(1, 1);
  const r = pp.extend(pathCells({ x: 1, y: 1 }, { x: 4, y: 1 }));
  eq([r.placed, r.reason], [2, 'すでに何か置いてあります']);
  eq(w.at(3, 1).id, old.id);
  eq(w.at(3, 1).dir, 'N', '前からあったベルトが回った');
  eq(w.at(4, 1).dir, 'E');
  pp.extend([{ x: 3, y: 1 }]);                            // 左へ戻る
  eq(w.at(4, 1).dir, 'E', '戻っただけで回った');
});
test('向きのない建物は道どおりに並ぶだけ', () => {
  const w = new World({ width: 10, height: 10 });
  const pp = new PathPlacer(w, pathReg, defBox, 'N');
  pp.start(0, 0);
  pp.extend(pathCells({ x: 0, y: 0 }, { x: 2, y: 2 }));
  eq(w.count, 5);
});

/* ---- sim（Phase 2: ベルト / アーム / 床） ---- */
// data/ に依存しない小さな定義で確かめる
const simDefs = {
  belt: { id: 'belt', size: SIZE_1, directional: true, belt: { tilesPerSecond: 1, onBlocked: 'drop' } },
  stopBelt: { id: 'stopBelt', size: SIZE_1, directional: true, belt: { tilesPerSecond: 1, onBlocked: 'stop' } },
  inserter: { id: 'inserter', size: SIZE_1, directional: true, inserter: { periodSeconds: 1, amount: 'stack' } },
  chest: { id: 'chest', size: SIZE_1, directional: false, container: { slots: 2 } },
  furnace: defFurnace,
  smelter: { id: 'smelter', size: SIZE_2, directional: false, machine: {} },
  gen: { id: 'gen', size: SIZE_1, directional: false, power: { source: 3 } },
  wire: { id: 'wire', size: SIZE_1, directional: false, layer: 'floor', power: { conducts: true } },
  pArm: { id: 'pArm', size: SIZE_1, directional: true, inserter: { periodSeconds: 1, amount: 'stack' },
          power: { needs: true, conducts: true } },
  pMiner: { id: 'pMiner', size: SIZE_1, directional: true, miner: { periodSeconds: 2, amount: 1 },
            power: { needs: true, conducts: true } },
  miner: { id: 'miner', size: SIZE_1, directional: true, miner: { periodSeconds: 2, amount: 1 } },
  splitter: { id: 'splitter', size: SIZE_1, directional: true, splitter: { tilesPerSecond: 1 } },
  proc: { id: 'proc', size: SIZE_1, directional: true, machine: { outputFront: true } },
};
const simReg = {
  building: id => simDefs[id],
  item: id => ({ ore: { id: 'ore', stackSize: 10, resource: true }, plate: { id: 'plate', stackSize: 10 } }[id]),
  recipes: new Map([['plate', { id: 'plate', inputs: { ore: 1 }, outputs: { plate: 1 }, craftTime: 1, machines: ['smelter', 'proc'] }]]),
};
function simWorld(w = 10, h = 3) { return new World({ width: w, height: h }); }
function put(w, id, x, y, dir = 'N') { return place(w, simDefs[id], x, y, dir); }
const total = list => (list || []).reduce((a, s) => a + s.count, 0);
const run = (sim, sec) => { for (let i = 0; i < sec; i++) sim.stepSecond(); };

test('1秒は20tick', () => {
  eq(TICK_HZ, 20);
  const sim = new Sim(simWorld(), simReg);
  eq(sim.stepSecond(), 20);
});
test('まっすぐ並んだベルトは1本の線になる', () => {
  const w = simWorld();
  const a = put(w, 'belt', 0, 0, 'E'), b = put(w, 'belt', 1, 0, 'E'), c = put(w, 'belt', 2, 0, 'E');
  const lines = buildBeltLines(w, simReg);
  eq(lines.length, 1);
  eq(lines[0].ids, [a.id, b.id, c.id]);
  eq(lines[0].ring, false);
});
test('ベルトは1秒に1マス運ぶ', () => {
  const w = simWorld();
  put(w, 'belt', 0, 0, 'E'); put(w, 'belt', 1, 0, 'E'); put(w, 'belt', 2, 0, 'E');
  const sim = new Sim(w, simReg);
  sim.addItems(0, 0, 'ore', 5);
  for (let i = 0; i < 19; i++) sim.step();
  eq(total(sim.contentsAt(0, 0).belt), 5, '1秒たたないうちに動いた');
  sim.step();
  eq(total(sim.contentsAt(1, 0).belt), 5, '1秒で1マス進んでいない');
  run(sim, 1);
  eq(total(sim.contentsAt(2, 0).belt), 5);
});
test('ベルトの先に何も無ければ床に落ちる', () => {
  const w = simWorld();
  put(w, 'belt', 0, 0, 'E');
  const sim = new Sim(w, simReg);
  sim.addItems(0, 0, 'ore', 3);
  run(sim, 1);
  eq(total(sim.contentsAt(0, 0).belt), 0);
  eq(total(sim.contentsAt(1, 0).ground), 3);
});
test('ベルトの先が保管箱でも中には入らず、そのマスの床に落ちる', () => {
  const w = simWorld();
  put(w, 'belt', 0, 0, 'E'); put(w, 'chest', 1, 0);
  const sim = new Sim(w, simReg);
  sim.addItems(0, 0, 'ore', 3);
  run(sim, 1);
  const c = sim.contentsAt(1, 0);
  eq(total(c.container.slots.filter(Boolean)), 0, '箱に入ってしまった');
  eq(total(c.ground), 3);
});
test('床では同じ種類が1つの山にまとまる', () => {
  const w = simWorld();
  put(w, 'belt', 0, 0, 'E');
  const sim = new Sim(w, simReg);
  sim.addItems(0, 0, 'ore', 3); run(sim, 1);
  sim.addItems(0, 0, 'ore', 4); run(sim, 1);
  eq(sim.contentsAt(1, 0).ground, [{ item: 'ore', count: 7 }]);
});
test('ベルトの上ではスタックが合体しない', () => {
  const w = simWorld();
  put(w, 'belt', 0, 0, 'E'); put(w, 'belt', 1, 0, 'E');
  const sim = new Sim(w, simReg);
  sim.addItems(0, 0, 'ore', 3); sim.addItems(0, 0, 'ore', 4);
  run(sim, 1);
  eq(sim.contentsAt(1, 0).belt, [{ item: 'ore', count: 3 }, { item: 'ore', count: 4 }]);
});
test('onBlocked が stop のベルトは先で止まって溜まる', () => {
  const w = simWorld();
  put(w, 'stopBelt', 0, 0, 'E'); put(w, 'stopBelt', 1, 0, 'E');
  const sim = new Sim(w, simReg);
  sim.addItems(0, 0, 'ore', 2); run(sim, 1);
  sim.addItems(0, 0, 'ore', 3); run(sim, 3);
  eq(total(sim.contentsAt(1, 0).belt), 5);
  eq(sim.contentsAt(2, 0).ground, []);
});
test('盤面の外へは送らない', () => {
  const w = simWorld(2, 1);
  put(w, 'belt', 1, 0, 'E');
  const sim = new Sim(w, simReg);
  sim.addItems(1, 0, 'ore', 2); run(sim, 2);
  eq(total(sim.contentsAt(1, 0).belt), 2);
});
test('横から合流したベルトの物も先へ流れる', () => {
  const w = simWorld(5, 5);
  put(w, 'belt', 0, 2, 'E'); put(w, 'belt', 1, 2, 'E'); put(w, 'belt', 2, 2, 'E');
  put(w, 'belt', 1, 1, 'S');                     // (1,1) から下の (1,2) へ合流
  const sim = new Sim(w, simReg);
  eq(sim.beltLines.length, 3, '合流点で線が切れていない');
  sim.addItems(0, 2, 'ore', 1); sim.addItems(1, 1, 'plate', 1);
  run(sim, 1);
  eq(total(sim.contentsAt(1, 2).belt), 2);
  run(sim, 1);
  eq(total(sim.contentsAt(2, 2).belt), 2);
});
test('輪になったベルトは回り続ける', () => {
  const w = simWorld(2, 2);
  put(w, 'belt', 0, 0, 'E'); put(w, 'belt', 1, 0, 'S'); put(w, 'belt', 1, 1, 'W'); put(w, 'belt', 0, 1, 'N');
  const sim = new Sim(w, simReg);
  eq(sim.beltLines.length, 1); eq(sim.beltLines[0].ring, true);
  sim.addItems(0, 0, 'ore', 1);
  run(sim, 1); eq(total(sim.contentsAt(1, 0).belt), 1);
  run(sim, 3); eq(total(sim.contentsAt(0, 0).belt), 1, '一周して戻っていない');
});
test('アームは正面から1スタック取り、背面へ置く', () => {
  const w = simWorld();
  put(w, 'chest', 0, 0); put(w, 'inserter', 1, 0, 'W'); put(w, 'chest', 2, 0);
  const sim = new Sim(w, simReg);
  sim.addItems(0, 0, 'ore', 15);                 // 10 + 5 の2スタック
  run(sim, 1);
  eq(total(sim.contentsAt(2, 0).container.slots.filter(Boolean)), 10, '1スタック丸ごと運んでいない');
  run(sim, 1);
  eq(total(sim.contentsAt(2, 0).container.slots.filter(Boolean)), 15);
});
test('アームは置き先に入りきらない分を置き先の床に落とす', () => {
  const w = simWorld();
  put(w, 'chest', 0, 0); put(w, 'inserter', 1, 0, 'W'); put(w, 'chest', 2, 0);
  const sim = new Sim(w, simReg);
  sim.addItems(2, 0, 'plate', 10); sim.addItems(2, 0, 'plate', 8);   // 置き先: 2枠のうち 10 と 8
  sim.addItems(0, 0, 'ore', 6);
  run(sim, 1);
  eq(sim.contentsAt(2, 0).ground, [{ item: 'ore', count: 6 }]);
});
test('アームは床の物も拾う', () => {
  const w = simWorld();
  put(w, 'inserter', 1, 0, 'W'); put(w, 'chest', 2, 0);
  const sim = new Sim(w, simReg);
  sim.addItems(0, 0, 'ore', 4);                  // (0,0) は空きマス → 床
  run(sim, 1);
  eq(sim.contentsAt(0, 0).ground, []);
  eq(total(sim.contentsAt(2, 0).container.slots.filter(Boolean)), 4);
});
test('箱 → アーム → ベルト → 床 → アーム → 箱 で全部運べる', () => {
  const w = simWorld();
  put(w, 'chest', 0, 0); put(w, 'inserter', 1, 0, 'W');
  put(w, 'belt', 2, 0, 'E'); put(w, 'belt', 3, 0, 'E');   // (4,0) の床へ落ちる
  put(w, 'inserter', 5, 0, 'W'); put(w, 'chest', 6, 0);
  const sim = new Sim(w, simReg);
  sim.addItems(0, 0, 'ore', 20);
  run(sim, 10);
  const t = sim.totals();
  eq(total(sim.contentsAt(6, 0).container.slots.filter(Boolean)), 20, `途中に残っている ${JSON.stringify(t)}`);
  eq(t.onBelts + t.onGround, 0);
});
test('ベルトを撤去すると載っていた物はそのマスの床に落ちる', () => {
  const w = simWorld();
  put(w, 'belt', 0, 0, 'E');
  const sim = new Sim(w, simReg);
  sim.addItems(0, 0, 'ore', 3);
  removeAt(w, 0, 0);
  eq(total(sim.contentsAt(0, 0).ground), 3);
});
test('床に落ちた物の上にベルトを敷くと、ベルトに載って流れる', () => {
  const w = simWorld();
  put(w, 'belt', 0, 0, 'E');                     // 行き止まり → (1,0) の床へ落ちる
  const sim = new Sim(w, simReg);
  sim.addItems(0, 0, 'ore', 3);
  run(sim, 1);
  eq(total(sim.contentsAt(1, 0).ground), 3);
  put(w, 'belt', 1, 0, 'E'); put(w, 'belt', 2, 0, 'E');
  eq(sim.contentsAt(1, 0).ground, [], '床に残っている');
  eq(total(sim.contentsAt(1, 0).belt), 3);
  run(sim, 1);
  eq(total(sim.contentsAt(2, 0).belt), 3, '流れていない');
  eq(sim.totals().onGround, 0);
});
test('ベルトを別の種類に置き換えても、落ちた中身は新しいベルトに載る', () => {
  const w = simWorld();
  put(w, 'belt', 0, 0, 'E');
  const sim = new Sim(w, simReg);
  sim.addItems(0, 0, 'ore', 3);
  removeAt(w, 0, 0); put(w, 'stopBelt', 0, 0, 'E');  // 同じ sync の中で撤去と設置
  eq(sim.contentsAt(0, 0).ground, []);
  eq(total(sim.contentsAt(0, 0).belt), 3);
});
test('保存データでベルトの下に残っていた床の物も、読み込むとベルトに載る', () => {
  const w = simWorld();
  put(w, 'belt', 1, 0, 'E');
  const sim = new Sim(w, simReg);
  const saved = JSON.parse(JSON.stringify({ world: w, sim }));
  saved.sim.ground = [{ x: 1, y: 0, stacks: [{ item: 'ore', count: 2 }] }];
  const back = Sim.fromJSON(saved.sim, World.fromJSON(saved.world, simReg), simReg);
  eq(back.contentsAt(1, 0).ground, []);
  eq(total(back.contentsAt(1, 0).belt), 2);
});
test('回しても中身は消えない', () => {
  const w = simWorld();
  put(w, 'belt', 0, 0, 'E');
  const sim = new Sim(w, simReg);
  sim.addItems(0, 0, 'ore', 3);
  rotateAt(w, simReg, 0, 0);
  eq(total(sim.contentsAt(0, 0).belt), 3);
  eq(sim.contentsAt(0, 0).ground, []);
});
test('中身ごと保存して読み戻せる', () => {
  const w = simWorld();
  put(w, 'chest', 0, 0); put(w, 'belt', 2, 0, 'E');
  const sim = new Sim(w, simReg);
  sim.addItems(0, 0, 'ore', 12); sim.addItems(2, 0, 'plate', 3); sim.addItems(5, 1, 'ore', 2);
  run(sim, 1);
  const saved = JSON.parse(JSON.stringify({ world: w, sim }));
  const w2 = World.fromJSON(saved.world, simReg);
  const back = Sim.fromJSON(saved.sim, w2, simReg);
  eq(back.tick, 20);
  eq(back.totals(), sim.totals());
  eq(back.contentsAt(0, 0).container.slots, sim.contentsAt(0, 0).container.slots);
  eq(back.contentsAt(5, 1).ground, [{ item: 'ore', count: 2 }]);
});

/* ---- 加工機（Phase 3） ---- */
const machineAt = (sim, x, y) => sim.contentsAt(x, y).machine;
test('炉は原料を1つずつ製品に変える', () => {
  const w = simWorld(6, 3);
  put(w, 'smelter', 1, 0);
  const sim = new Sim(w, simReg);
  sim.addItems(1, 0, 'ore', 3);
  eq(machineAt(sim, 1, 0).state, '原料待ち', '置いた直後の状態');
  for (let i = 0; i < 19; i++) sim.step();
  eq(machineAt(sim, 1, 0).output, null, '1秒たたないうちにできた');
  sim.step();
  eq(machineAt(sim, 1, 0).output, { item: 'plate', count: 1 });
  eq(machineAt(sim, 1, 0).input, { item: 'ore', count: 2 });
  run(sim, 2);
  eq(machineAt(sim, 1, 0).output, { item: 'plate', count: 3 });
  eq(machineAt(sim, 1, 0).input, null);
  eq(machineAt(sim, 1, 0).state, '原料待ち');
  eq(sim.totals().produced, { plate: 3 });
});
test('出力が満杯なら止まる', () => {
  const w = simWorld(6, 3);
  put(w, 'smelter', 1, 0);
  const sim = new Sim(w, simReg);
  sim.addItems(1, 0, 'ore', 10); run(sim, 10);           // 出力 10 = 上限
  sim.addItems(1, 0, 'ore', 2); run(sim, 3);
  const m = machineAt(sim, 1, 0);
  eq(m.state, '出力が満杯');
  eq(m.output.count, 10);
  eq(m.input.count, 2);
});
test('炉が扱えない物は入らず、置いたマスの床に落ちる', () => {
  const w2 = new World({ width: 6, height: 4 });
  put(w2, 'chest', 0, 0); put(w2, 'inserter', 0, 1, 'N'); put(w2, 'smelter', 0, 2);
  const s2 = new Sim(w2, simReg);
  s2.addItems(0, 0, 'plate', 4);                           // 板は炉の原料ではない
  run(s2, 1);
  eq(machineAt(s2, 0, 2).input, null, '扱えない物が入った');
  eq(s2.contentsAt(0, 2).ground, [{ item: 'plate', count: 4 }]);
});
test('入力と違う種類の物は入らない', () => {
  const reg2 = { ...simReg, recipes: new Map([...simReg.recipes,
    ['plate2', { id: 'plate2', inputs: { plate: 1 }, outputs: { ore: 1 }, craftTime: 1, machines: ['smelter'] }]]) };
  const w = simWorld(6, 3);
  put(w, 'smelter', 1, 0);
  const sim = new Sim(w, reg2);
  sim.addItems(1, 0, 'ore', 2);
  eq(sim.addItems(1, 0, 'plate', 2), 'ground');
  eq(machineAt(sim, 1, 0).input, { item: 'ore', count: 2 });
});
test('アームは炉の出力だけを取る', () => {
  const w = new World({ width: 3, height: 5 });
  put(w, 'smelter', 0, 0); put(w, 'inserter', 0, 2, 'N'); put(w, 'chest', 0, 3);
  const sim = new Sim(w, simReg);
  sim.addItems(0, 0, 'ore', 5);
  run(sim, 1);                                              // まだ製品が無い → 原料は取らない
  eq(machineAt(sim, 0, 0).input.count >= 4, true, '原料を持っていかれた');
  run(sim, 6);
  eq(machineAt(sim, 0, 0).input, null);
  eq(total(sim.contentsAt(0, 3).container.slots.filter(Boolean)), 5);
});
test('箱 → アーム → 炉 → アーム → 箱 で原料が全部製品になる', () => {
  const w = new World({ width: 3, height: 7 });
  put(w, 'chest', 0, 0); put(w, 'inserter', 0, 1, 'N');
  put(w, 'smelter', 0, 2);                                  // (0..1, 2..3)
  put(w, 'inserter', 0, 4, 'N'); put(w, 'chest', 0, 5);
  const sim = new Sim(w, simReg);
  sim.addItems(0, 0, 'ore', 8);
  run(sim, 12);
  eq(sim.contentsAt(0, 5).container.slots.filter(Boolean), [{ item: 'plate', count: 8 }]);
  eq(sim.totals().onGround, 0);
});
test('炉を撤去すると中身は床に落ち、保存すると中身も残る', () => {
  const w = simWorld(6, 3);
  put(w, 'smelter', 1, 0);
  const sim = new Sim(w, simReg);
  sim.addItems(1, 0, 'ore', 3); run(sim, 1); sim.step();
  const saved = JSON.parse(JSON.stringify({ world: w, sim }));
  const back = Sim.fromJSON(saved.sim, World.fromJSON(saved.world, simReg), simReg);
  eq(machineAt(back, 1, 0), machineAt(sim, 1, 0));
  removeAt(w, 2, 1);
  eq(sim.contentsAt(1, 0).ground, [{ item: 'ore', count: 2 }, { item: 'plate', count: 1 }]);
});

/* ---- 鉱脈と採掘機（Phase 3） ---- */
test('鉱脈は置けて、消せて、保存できる', () => {
  const w = simWorld(4, 4);
  const r0 = w.revision;
  w.setResource(1, 1, 'ore');
  eq(w.resourceAt(1, 1), 'ore');
  ok(w.revision > r0, '鉱脈を置いても revision が増えない');
  w.setResource(2, 1, 'ore');
  w.setResource(2, 1, null);
  eq(w.resourceAt(2, 1), null);
  const back = World.fromJSON(JSON.parse(JSON.stringify(w)), simReg);
  eq(back.resourceAt(1, 1), 'ore');
  eq(back.resources.size, 1);
});
test('採掘機は正面の鉱脈を2秒に1個掘って、背面（向きの逆）のマスの床に出す', () => {
  const w = simWorld(6, 6);
  w.setResource(3, 2, 'ore');                    // 採掘機の正面
  put(w, 'miner', 2, 2, 'E');                    // 右向き → 出し先は左の (1, 2)
  const sim = new Sim(w, simReg);
  run(sim, 1);
  eq(sim.contentsAt(1, 2).ground, [], '2秒たたないうちに出た');
  run(sim, 1);
  eq(sim.contentsAt(1, 2).ground, [{ item: 'ore', count: 1 }]);
  run(sim, 4);
  eq(sim.contentsAt(1, 2).ground, [{ item: 'ore', count: 3 }]);
  eq(sim.contentsAt(3, 2).ground, [], '正面に出てしまった');
  eq(sim.contentsAt(2, 2).miner.state, '採掘中');
});
test('掘るのは正面、出し先は向きの逆', () => {
  const w = simWorld(6, 6);
  for (const [dir, cell, front] of [['N', [2, 3], [2, 1]], ['E', [1, 2], [3, 2]],
                                    ['S', [2, 1], [2, 3]], ['W', [3, 2], [1, 2]]]) {
    w.resources.clear();
    w.setResource(...front, 'ore');
    const b = put(w, 'miner', 2, 2, dir);
    const sim = new Sim(w, simReg);
    run(sim, 2);
    eq(total(sim.contentsAt(...cell).ground), 1, `${dir} 向きの出し先が違う`);
    w.remove(b);
  }
});
test('採掘機の出し先がベルトならベルトに載る', () => {
  const w = simWorld(8, 4);
  w.setResource(0, 1, 'ore');
  put(w, 'miner', 1, 1, 'W'); put(w, 'belt', 2, 1, 'E'); put(w, 'belt', 3, 1, 'E');
  const sim = new Sim(w, simReg);
  run(sim, 2);
  eq(total(sim.contentsAt(2, 1).belt), 1);
});
test('鉱脈が正面に無ければ掘らない（真下にあっても掘らない）', () => {
  const w = simWorld(6, 6);
  w.setResource(2, 2, 'ore');
  put(w, 'miner', 2, 2, 'E');
  const sim = new Sim(w, simReg);
  run(sim, 4);
  eq(sim.totals().onGround, 0);
  eq(sim.contentsAt(2, 2).miner.state, '鉱脈なし');
});
test('大きな採掘機は正面の列の何種類かを順番に掘る', () => {
  const big = { ...simReg, building: id => (id === 'bigMiner'
    ? { id, size: SIZE_2, directional: true, miner: { periodSeconds: 2, amount: 1 } } : simDefs[id]) };
  const w = simWorld(6, 6);
  w.setResource(1, 2, 'ore'); w.setResource(1, 3, 'plate');   // 左向きの正面の列
  place(w, big.building('bigMiner'), 2, 2, 'W');   // 2x2、出し先は右の (4, 2)
  const sim = new Sim(w, big);
  run(sim, 4);
  eq(sim.contentsAt(4, 2).ground, [{ item: 'ore', count: 1 }, { item: 'plate', count: 1 }]);
});
test('鉱脈 → 採掘機 → ベルト → 床 → アーム → 炉 → アーム → 箱 で製品ができる', () => {
  const w = new World({ width: 12, height: 6 });
  w.setResource(0, 0, 'ore');
  put(w, 'miner', 1, 0, 'W');                    // 正面 (0,0) を掘り、背面 (2,0) へ
  put(w, 'belt', 2, 0, 'E'); put(w, 'belt', 3, 0, 'E');   // (4,0) の床へ
  put(w, 'inserter', 5, 0, 'W');                 // (4,0) から取り (6,0) へ
  put(w, 'smelter', 6, 0);                       // (6..7, 0..1)
  put(w, 'inserter', 8, 0, 'W');                 // 炉の (7,0) から取り (9,0) へ
  put(w, 'chest', 9, 0);
  const sim = new Sim(w, simReg);
  run(sim, 30);
  const plates = sim.contentsAt(9, 0).container.slots.filter(Boolean).reduce((a, s) => a + s.count, 0);
  ok(plates >= 10, `30秒で板が ${plates} 個しかできていない ${JSON.stringify(sim.totals())}`);
  eq(sim.totals().produced.ore, 15);
});

/* ---- 電力（Phase 4） ---- */
test('電線は機械と同じマスに置けるが、電線どうしは重ねられない', () => {
  const w = simWorld();
  ok(put(w, 'chest', 1, 0), '箱が置けない');
  ok(put(w, 'wire', 1, 0), '箱の下に電線が置けない');
  eq(put(w, 'wire', 1, 0), null, '電線が重なった');
  eq(w.at(1, 0).type, 'chest'); eq(w.floorAt(1, 0).type, 'wire');
  removeAt(w, 1, 0);
  eq(w.at(1, 0), null, '右クリックで先に設置物が消えていない');
  ok(w.floorAt(1, 0), '電線まで消えた');
  removeAt(w, 1, 0);
  eq(w.floorAt(1, 0), null);
});
test('電気は電線をたどって1マスごとに弱まる', () => {
  const w = simWorld(10, 3);
  put(w, 'gen', 0, 0);                            // 強さ 3 → 隣 3, 2, 1
  for (let x = 1; x <= 5; x++) put(w, 'wire', x, 0);
  const sim = new Sim(w, simReg);
  eq([1, 2, 3, 4].map(x => sim.power.get(key(x, 0)) || 0), [3, 2, 1, 0]);
});
test('電気が届かないアームは動かない', () => {
  const w = simWorld(10, 3);
  put(w, 'chest', 0, 0); put(w, 'pArm', 1, 0, 'W'); put(w, 'chest', 2, 0);
  const sim = new Sim(w, simReg);
  sim.addItems(0, 0, 'ore', 5);
  run(sim, 2);
  eq(total(sim.contentsAt(2, 0).container.slots.filter(Boolean)), 0, '電気なしで動いた');
  ok(sim.unpowered.has(w.at(1, 0).id), '電気なしの印が付いていない');
  put(w, 'gen', 1, 1);                            // アームの下隣に発電機
  run(sim, 1);
  eq(total(sim.contentsAt(2, 0).container.slots.filter(Boolean)), 5);
});
test('電線の先の採掘機は動き、電線を外すと止まる', () => {
  const w = simWorld(10, 3);
  put(w, 'gen', 0, 1); put(w, 'wire', 1, 1); put(w, 'wire', 2, 1);
  w.setResource(3, 0, 'ore');
  put(w, 'pMiner', 3, 1, 'N');                    // 正面 (3,0)、背面 (3,2)
  const sim = new Sim(w, simReg);
  run(sim, 2);
  eq(total(sim.contentsAt(3, 2).ground), 1, '届いているのに掘らない');
  removeAt(w, 2, 1);
  run(sim, 4);
  eq(total(sim.contentsAt(3, 2).ground), 1, '電線を外しても掘った');
  eq(sim.contentsAt(3, 1).miner.state, '電力なし');
});
test('電気を使う機械も電気を通す', () => {
  const w = simWorld(10, 3);
  put(w, 'gen', 0, 0); put(w, 'pArm', 1, 0, 'S'); put(w, 'pArm', 2, 0, 'S');
  const sim = new Sim(w, simReg);
  eq(sim.unpowered.size, 0);
});
test('電線は保存して読み戻せる', () => {
  const w = simWorld();
  put(w, 'chest', 1, 0); put(w, 'wire', 1, 0);
  const back = World.fromJSON(JSON.parse(JSON.stringify(w)), simReg);
  eq(back.at(1, 0).type, 'chest'); eq(back.floorAt(1, 0).type, 'wire');
});

/* ---- チャンクと差分の計算（Phase 5） ---- */
test('マスの鍵は数値で、負の座標も元に戻せる', () => {
  for (const [x, y] of [[0, 0], [5, 7], [-1, 0], [0, -1], [-300, 1200], [8191, -8192]]) {
    eq(typeof key(x, y), 'number');
    eq(parseKey(key(x, y)), { x, y });
  }
  eq(new Set([key(-1, 0), key(0, -1), key(1, 0), key(0, 1), key(0, 0)]).size, 5, '鍵が重なった');
});
test('チャンクの層: 区画をまたいで置ける・範囲で引ける・空の区画は捨てる', () => {
  const L = new ChunkLayer();
  L.set(CHUNK - 1, 0, 'a'); L.set(CHUNK, 0, 'b'); L.set(3, CHUNK * 2 + 1, 'c'); L.set(-1, -1, 'd');
  eq(L.size, 4);
  eq(L.chunks.size, 4);
  eq([L.get(CHUNK - 1, 0), L.get(CHUNK, 0), L.get(-1, -1), L.get(0, 0)], ['a', 'b', 'd', undefined]);
  const got = [];
  L.forEachIn(CHUNK - 1, 0, CHUNK, 0, (x, y, v) => got.push(v));
  eq(got, ['a', 'b']);
  L.set(CHUNK, 0, 'b2');
  eq(L.size, 4, '上書きで数が増えた');
  ok(L.delete(CHUNK, 0));
  ok(!L.delete(CHUNK, 0), '2回消せた');
  eq(L.chunks.size, 3, '空の区画が残った');
});
test('画面の範囲にかかる建物だけを引ける（2x2 は端が入れば含む）', () => {
  const w = simWorld(200, 200);
  put(w, 'belt', 1, 1); put(w, 'smelter', 99, 99); put(w, 'wire', 150, 150); put(w, 'belt', 150, 150);
  eq(w.buildingsIn(100, 100, 120, 120).map(b => b.type), ['smelter']);
  eq(w.buildingsIn(140, 140, 160, 160).map(b => b.type), ['wire', 'belt'], '床の層が先でない');
  eq(w.buildingsIn(0, 0, 10, 10).length, 1);
});
test('変更の記録: 古すぎると null（全部を計算し直す合図）', () => {
  const w = simWorld(10, 10);
  const r0 = w.revision;
  const b = put(w, 'belt', 1, 1);
  eq(w.changesSince(r0).map(c => c.op), ['add']);
  w.remove(b);
  eq(w.changesSince(r0).map(c => c.op), ['add', 'remove']);
  eq(w.changesSince(w.revision), []);
  for (let i = 0; i < 10000; i++) w.setResource(0, 0, i % 2 ? null : 'ore');
  eq(w.changesSince(r0), null);
});

/** 差分で追いついた Sim と、毎回全部を計算し直した Sim が同じになるか比べる。 */
function sameAsFull(a, b, msg) {
  const lines = s => s.beltLines.map(l => `${l.ring ? 'R' : ''}${l.ids.join('>')}`);
  eq(lines(a), lines(b), `${msg}: ベルトの線が違う`);
  const pw = s => [...s.power].filter(([, v]) => v > 0).sort((p, q) => p[0] - q[0]);
  eq(pw(a), pw(b), `${msg}: 電力が違う`);
  eq([...a.unpowered].sort((p, q) => p - q), [...b.unpowered].sort((p, q) => p - q), `${msg}: 電気の届かない建物が違う`);
  eq(a.inserters.map(x => x.id), b.inserters.map(x => x.id), `${msg}: アームの順が違う`);
  eq(a.toJSON(), b.toJSON(), `${msg}: 中身が違う`);
}
test('置く・消す・回すを繰り返しても、差分の計算は全部の計算し直しと同じ結果になる', () => {
  let seed = 12345;
  const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor(seed / 65536) % n; };
  const w = simWorld(14, 10);
  for (let i = 0; i < 20; i++) w.setResource(rnd(14), rnd(10), 'ore');
  const inc = new Sim(w, simReg), full = new Sim(w, simReg);
  const seen = { lines: 0, power: 0, unpowered: 0 };     // 試した盤面が空っぽでなかったか
  const kinds = ['belt', 'belt', 'belt', 'stopBelt', 'inserter', 'chest', 'gen', 'wire', 'wire', 'pArm', 'pMiner', 'miner'];
  for (let round = 0; round < 150; round++) {
    for (let k = 0, n = 1 + rnd(4); k < n; k++) {
      const x = rnd(14), y = rnd(10), op = rnd(10);
      if (op < 6) put(w, kinds[rnd(kinds.length)], x, y, ['N', 'E', 'S', 'W'][rnd(4)]);
      else if (op < 8) removeAt(w, x, y);
      else rotateAt(w, simReg, x, y);
    }
    if (rnd(3) === 0) {
      const [x, y, n] = [rnd(14), rnd(10), 1 + rnd(5)];
      inc.addItems(x, y, 'ore', n);
      full.rev = -1;                                // こちらは毎回全部を計算し直す
      full.addItems(x, y, 'ore', n);
    }
    for (let t = 0; t < 7; t++) {
      inc.step();
      full.rev = -1;
      full.step();
    }
    sameAsFull(inc, full, `${round} 回目`);
    seen.lines = Math.max(seen.lines, inc.beltLines.length);
    seen.power = Math.max(seen.power, inc.power.size);
    seen.unpowered = Math.max(seen.unpowered, inc.unpowered.size);
  }
  ok(seen.lines > 3 && seen.power > 3 && seen.unpowered > 0, `試した盤面が簡単すぎた ${JSON.stringify(seen)}`);
});

/* ---- Web Worker との受け渡し（Phase 5b） ---- */
function busyWorld() {
  const w = simWorld(40, 20);
  w.setResource(2, 2, 'ore');
  put(w, 'pMiner', 3, 2, 'W');
  for (let x = 4; x <= 8; x++) put(w, 'belt', x, 2, 'E');
  put(w, 'gen', 3, 3);
  for (let x = 4; x <= 9; x++) put(w, 'wire', x, 3);
  put(w, 'pArm', 9, 2, 'W'); put(w, 'chest', 10, 2); put(w, 'smelter', 30, 10);
  put(w, 'pArm', 20, 15, 'E');                      // 電気が届かない
  return w;
}
test('写しは範囲の中だけを持ち、戻すと元の World / Sim と同じに読める', () => {
  const w = busyWorld();
  const sim = new Sim(w, simReg);
  sim.addItems(15, 5, 'ore', 4);
  run(sim, 6);
  const rect = { x0: 0, y0: 0, x1: 22, y1: 16 };
  const snap = JSON.parse(JSON.stringify(makeSnapshot(w, sim, rect)));   // postMessage で送れる形か
  const vw = new ViewWorld(snap), vs = new ViewSim(snap);
  ok(!snap.buildings.some(b => b.type === 'smelter'), '範囲の外の建物が入った');
  eq(vw.count, w.count);
  eq(vs.tick, sim.tick);
  for (let y = 0; y <= 16; y++) {
    for (let x = 0; x <= 22; x++) {
      const k = key(x, y);
      eq(vw.at(x, y) && vw.at(x, y).id, w.at(x, y) && w.at(x, y).id, `(${x}, ${y}) の建物`);
      eq(vw.floorAt(x, y) && vw.floorAt(x, y).id, w.floorAt(x, y) && w.floorAt(x, y).id, `(${x}, ${y}) の床`);
      eq(vw.resourceAt(x, y), w.resourceAt(x, y));
      eq(vs.power.get(k) || 0, sim.power.get(k) || 0, `(${x}, ${y}) の電力`);
      eq(vs.ground.get(k) || [], sim.ground.get(k) && sim.ground.get(k).length ? sim.ground.get(k) : []);
    }
  }
  for (const b of vw.buildingsIn(0, 0, 22, 16)) {
    eq(vs.belts.get(b.id) || null, sim.belts.get(b.id) || null);
    eq(vs.unpowered.has(b.id), sim.unpowered.has(b.id));
  }
  ok(vs.unpowered.has(w.at(20, 15).id), '電気の届かないアームが写しに無い');
});
test('エンジン: 命令で置く・回す・撤去・進めるができ、画面が描き終えるまで次の写しを送らない', () => {
  const sent = [];
  const eng = new Engine(simReg, m => sent.push(m), { width: 20, height: 10 });
  eng.handle({ id: 1, op: 'view', rect: { x0: 0, y0: 0, x1: 19, y1: 9 } });
  eq(sent.filter(m => m.type === 'view').length, 1);
  eng.handle({ id: 2, op: 'place', type: 'belt', cells: [{ x: 1, y: 1, dir: 'E' }, { x: 2, y: 1, dir: 'E' }, { x: 1, y: 1, dir: 'E' }] });
  const placed = sent.find(m => m.re === 2).result;
  eq([placed.placed, placed.reason], [2, 'すでに何か置いてあります']);
  eq(sent.filter(m => m.type === 'view').length, 1, '描き終える前に次の写しを送った');
  eng.handle({ op: 'ack' });
  eq(sent.filter(m => m.type === 'view').length, 2);
  eq(sent.filter(m => m.type === 'view')[1].snap.count, 2);
  eng.handle({ id: 3, op: 'items', x: 1, y: 1, item: 'ore', count: 3 });
  eq(sent.find(m => m.re === 3).result.where, 'belt');
  eng.handle({ id: 4, op: 'rotate', x: 2, y: 1 });
  eq(sent.find(m => m.re === 4).result.dir, 'S');
  eng.handle({ id: 5, op: 'step', ticks: TICK_HZ });
  eng.handle({ id: 6, op: 'inspect', x: 2, y: 1 });
  eq(total(sent.find(m => m.re === 6).result.belt), 3, '回したベルトへ流れていない');
  eng.handle({ id: 7, op: 'remove', x: 2, y: 1 });
  eq(sent.find(m => m.re === 7).result.type, 'belt');
  eng.handle({ id: 8, op: 'inspect', x: 2, y: 1 });
  eq(total(sent.find(m => m.re === 8).result.ground), 3, '撤去したベルトの中身が床に落ちていない');
  eng.handle({ id: 9, op: 'nothing' });
  ok(sent.find(m => m.re === 9).error, '知らない命令でエラーにならない');
  eng.handle({ id: 10, op: 'clear' });
  eng.handle({ op: 'ack' });
  eq(sent.filter(m => m.type === 'view').pop().snap.count, 0);
});

test('電線の色: 届いていないと灰色、強いほど明るい', () => {
  const lum = c => { const n = parseInt(c.slice(1), 16); return (n >> 16) + ((n >> 8) & 255) + (n & 255); };
  eq(wireColors(0, 24).line, '#4b5563');
  eq(wireColors(24, 24).line, '#facc15');
  let last = -1;
  for (let lv = 1; lv <= 24; lv++) {
    const l = lum(wireColors(lv, 24).line);
    ok(l > last, `強さ ${lv} が ${lv - 1} より明るくない`);
    last = l;
  }
});

/* ---- 範囲選択・設計図 ---- */
test('設計図: 範囲に全部入っている建物だけを、左上からの位置で写す（中身は写さない）', () => {
  const w = simWorld(20, 10);
  put(w, 'belt', 3, 2, 'E'); put(w, 'chest', 5, 4); put(w, 'wire', 3, 2); put(w, 'smelter', 6, 3);   // 2x2 は (6..7, 3..4)
  put(w, 'belt', 12, 2, 'E');                         // 範囲の外
  const rect = rectFrom({ x: 6, y: 4 }, { x: 3, y: 2 });
  eq(rect, { x0: 3, y0: 2, x1: 6, y1: 4 });
  const bp = captureBlueprint(w, rect, 'テスト');
  eq([bp.width, bp.height, bp.name], [4, 3, 'テスト']);
  eq(bp.buildings, [{ type: 'belt', x: 0, y: 0, dir: 'E' }, { type: 'wire', x: 0, y: 0, dir: 'N' },
                    { type: 'chest', x: 2, y: 2, dir: 'N' }], '端で切れた 2x2 か範囲の外が入った');
  eq(checkBlueprint(bp), null);
  eq(checkBlueprint({ format: 'industry-sim' }), 'このアプリの設計図ではありません');
});
test('設計図: 貼ると同じ並びになり、重なる・盤面の外の建物は飛ばす', () => {
  const w = simWorld(20, 10);
  put(w, 'belt', 1, 1, 'E'); put(w, 'belt', 2, 1, 'E'); put(w, 'inserter', 2, 2, 'S');
  const bp = captureBlueprint(w, { x0: 1, y0: 1, x1: 2, y1: 2 });
  eq(pasteBlueprint(w, simReg, bp, 10, 5), { placed: 3, skipped: 0, replaced: 0, same: 0 });
  eq([w.at(10, 5).dir, w.at(11, 5).type, w.at(11, 6).type], ['E', 'belt', 'inserter']);
  const pv = previewBlueprint(w, simReg, bp, 10, 5);
  ok(pv.every(p => !p.ok), '重なるのに置けると出た');
  eq(pasteBlueprint(w, simReg, bp, 19, 5), { placed: 1, skipped: 2, replaced: 0, same: 0 }, '盤面の外を飛ばしていない');
});
test('設計図: 回すと時計回りに90度回り、4回で元に戻る（2x2 も）', () => {
  const w = simWorld(20, 10);
  put(w, 'belt', 0, 0, 'E'); put(w, 'smelter', 1, 0); put(w, 'inserter', 3, 1, 'N');   // 4x2 の範囲
  const bp = captureBlueprint(w, { x0: 0, y0: 0, x1: 3, y1: 1 });
  const r1 = rotateBlueprint(bp, simReg);
  eq([r1.width, r1.height], [2, 4]);
  // (0,0) の E 向きベルトは、回すと右上 (1,0) で S 向き。(3,1) の N 向きアームは (0,3) で E 向き
  ok(r1.buildings.some(b => b.type === 'belt' && b.x === 1 && b.y === 0 && b.dir === 'S'), JSON.stringify(r1.buildings));
  ok(r1.buildings.some(b => b.type === 'inserter' && b.x === 0 && b.y === 3 && b.dir === 'E'), JSON.stringify(r1.buildings));
  ok(r1.buildings.some(b => b.type === 'smelter' && b.x === 0 && b.y === 1), '2x2 の位置が違う');
  const w2 = simWorld(20, 10);
  eq(pasteBlueprint(w2, simReg, r1, 0, 0).skipped, 0, '回した設計図が重なった');
  let r = bp;
  for (let i = 0; i < 4; i++) r = rotateBlueprint(r, simReg);
  eq(r.buildings.map(b => ({ ...b, dir: b.type === 'smelter' ? 'N' : b.dir })), bp.buildings);
});
test('エンジン: 範囲をコピーして貼り、範囲を削除する', () => {
  const sent = [];
  const eng = new Engine(simReg, m => sent.push(m), { width: 20, height: 10 });
  const res = id => sent.find(m => m.re === id);
  eng.handle({ id: 1, op: 'place', type: 'belt', cells: [{ x: 1, y: 1, dir: 'E' }, { x: 2, y: 1, dir: 'E' }] });
  eng.handle({ id: 2, op: 'copy', rect: { x0: 0, y0: 0, x1: 3, y1: 2 } });
  const bp = res(2).result;
  eq(bp.buildings.length, 2);
  eng.handle({ id: 3, op: 'paste', blueprint: bp, x: 10, y: 5 });
  eq(res(3).result, { placed: 2, skipped: 0, replaced: 0, same: 0 });
  eq(eng.world.count, 4);
  eng.handle({ id: 4, op: 'paste', blueprint: { format: 'x' }, x: 0, y: 0 });
  ok(res(4).error, '設計図でないのにエラーにならない');
  eng.handle({ id: 5, op: 'removeArea', rect: { x0: 9, y0: 4, x1: 12, y1: 6 } });
  eq([res(5).result.removed, eng.world.count], [2, 2]);
});

test('設計図: 左右反転・上下反転で位置と向きが鏡に映り、2回で元に戻る（2x2 も）', () => {
  const w = simWorld(20, 10);
  put(w, 'belt', 0, 0, 'E'); put(w, 'smelter', 1, 0); put(w, 'inserter', 3, 1, 'N');   // 4x2 の範囲
  const bp = captureBlueprint(w, { x0: 0, y0: 0, x1: 3, y1: 1 });
  const h = flipBlueprint(bp, simReg, 'h');
  eq([h.width, h.height], [4, 2]);
  ok(h.buildings.some(b => b.type === 'belt' && b.x === 3 && b.y === 0 && b.dir === 'W'), JSON.stringify(h.buildings));
  ok(h.buildings.some(b => b.type === 'inserter' && b.x === 0 && b.y === 1 && b.dir === 'N'), JSON.stringify(h.buildings));
  ok(h.buildings.some(b => b.type === 'smelter' && b.x === 1 && b.y === 0), '2x2 の位置が違う');
  const v = flipBlueprint(bp, simReg, 'v');
  ok(v.buildings.some(b => b.type === 'belt' && b.x === 0 && b.y === 1 && b.dir === 'E'), JSON.stringify(v.buildings));
  ok(v.buildings.some(b => b.type === 'inserter' && b.x === 3 && b.y === 0 && b.dir === 'S'), JSON.stringify(v.buildings));
  eq(flipBlueprint(h, simReg, 'h').buildings, bp.buildings);
  eq(flipBlueprint(v, simReg, 'v').buildings, bp.buildings);
  eq(pasteBlueprint(simWorld(20, 10), simReg, h, 0, 0).skipped, 0, '反転した設計図が重なった');
});
test('設計図: 上書きで貼ると重なる建物を撤去して置き、同じ物はそのまま残す', () => {
  const w = simWorld(20, 10);
  put(w, 'belt', 1, 1, 'E'); put(w, 'belt', 2, 1, 'E');
  const bp = captureBlueprint(w, { x0: 1, y0: 1, x1: 2, y1: 1 });
  const keep = w.at(5, 1) || put(w, 'belt', 5, 1, 'E');     // 同じ物（残る）
  put(w, 'chest', 6, 1);                                  // 重なる別の物（上書きで消える）
  const pv = previewBlueprint(w, simReg, bp, 5, 1, { overwrite: true });
  eq(pv.map(p => p.state), ['same', 'replace']);
  eq(pv[1].hit.map(b => b.type), ['chest']);
  eq(previewBlueprint(w, simReg, bp, 5, 1).map(p => p.state), ['same', 'blocked'], '上書きしないのに置ける');
  eq(pasteBlueprint(w, simReg, bp, 5, 1), { placed: 0, skipped: 1, replaced: 0, same: 1 });
  eq(pasteBlueprint(w, simReg, bp, 5, 1, { overwrite: true }), { placed: 1, skipped: 0, replaced: 1, same: 1 });
  eq([w.at(5, 1).id, w.at(6, 1).type, w.at(6, 1).dir], [keep.id, 'belt', 'E']);
});
test('まとめて移動: 中身ごと動き、置けない所があれば何も動かさない（上書きなら動く）', () => {
  const w = simWorld(20, 10);
  put(w, 'belt', 1, 1, 'E'); put(w, 'chest', 2, 1);
  put(w, 'chest', 8, 1);                                   // 行き先の邪魔
  const sim = new Sim(w, simReg);
  sim.addItems(1, 1, 'ore', 3); sim.addItems(2, 1, 'plate', 4);
  const rect = { x0: 1, y0: 1, x1: 2, y1: 1 };
  const no = moveArea(w, simReg, rect, [], 7, 1);
  eq([no.moved, no.blocked], [0, 1]);
  eq([w.at(1, 1).type, w.at(2, 1).type, w.count], ['belt', 'chest', 3], '置けないのに動いた');
  // 少しだけずらす（元の場所と重なる移動）
  const r = moveArea(w, simReg, rect, [], 2, 1);
  for (const [a, b] of r.moves) sim.moved.set(a, b);
  eq([r.moved, w.at(1, 1), w.at(2, 1).type, w.at(3, 1).type], [2, null, 'belt', 'chest']);
  sim.sync();
  eq(total(sim.contentsAt(2, 1).belt), 3, 'ベルトの上の物が付いてこない');
  eq(total(sim.contentsAt(3, 1).container.slots.filter(Boolean)), 4, '箱の中身が付いてこない');
  eq(total(sim.contentsAt(1, 1).ground) + total(sim.contentsAt(2, 1).ground), 0, '床に落ちた');
  // 上書き: 左右反転して (7,1) へ。邪魔な箱 (8,1) は撤去される
  const o = moveArea(w, simReg, { x0: 2, y0: 1, x1: 3, y1: 1 }, ['h'], 7, 1, { overwrite: true });
  for (const [a, b] of o.moves) sim.moved.set(a, b);
  eq([o.moved, o.replaced, w.at(7, 1).type, w.at(8, 1).type, w.at(8, 1).dir], [2, 1, 'chest', 'belt', 'W']);
  sim.sync();
  eq([total(sim.contentsAt(8, 1).belt), total(sim.contentsAt(7, 1).container.slots.filter(Boolean))], [3, 4]);
});
test('エンジン: まとめて移動（中身も）と、上書きの貼り付け', () => {
  const sent = [];
  const eng = new Engine(simReg, m => sent.push(m), { width: 20, height: 10 });
  const res = id => sent.find(m => m.re === id);
  eng.handle({ id: 1, op: 'place', type: 'belt', cells: [{ x: 1, y: 1, dir: 'E' }, { x: 2, y: 1, dir: 'E' }] });
  eng.sim.sync();
  eng.sim.addItems(1, 1, 'ore', 2);
  eng.handle({ id: 2, op: 'move', rect: { x0: 1, y0: 1, x1: 2, y1: 1 }, transforms: ['r'], x: 5, y: 5 });
  eq(res(2).result, { moved: 2, replaced: 0, blocked: 0, width: 1, height: 2 });
  eq([eng.world.at(5, 5).dir, eng.world.at(5, 6).type, eng.world.at(1, 1)], ['S', 'belt', null]);
  eng.sim.sync();
  eq(total(eng.sim.contentsAt(5, 5).belt), 2, 'ベルトの上の物が付いてこない');
  eng.handle({ id: 3, op: 'copy', rect: { x0: 5, y0: 5, x1: 5, y1: 6 } });
  eng.handle({ id: 4, op: 'place', type: 'chest', cells: [{ x: 9, y: 9 }] });
  eng.handle({ id: 5, op: 'paste', blueprint: res(3).result, x: 9, y: 8, overwrite: true });
  eq(res(5).result, { placed: 2, skipped: 0, replaced: 1, same: 0 });
  eq(eng.world.at(9, 9).type, 'belt');
});

/* ---- 元に戻す / やり直す ---- */
function undoEngine() {
  const sent = [];
  const eng = new Engine(simReg, m => sent.push(m), { width: 20, height: 10 });
  let id = 100;
  const call = (op, args = {}) => {
    const n = ++id;
    eng.handle({ id: n, op, ...args });
    const r = sent.find(m => m.re === n);
    if (r.error) throw new Error(r.error);
    return r.result;
  };
  return { eng, call };
}
test('元に戻す: ドラッグで置いた分は1回で戻り、やり直すとまた置かれる', () => {
  const { eng, call } = undoEngine();
  call('dragStart', { type: 'belt', x: 1, y: 1, dir: 'E' });
  call('dragTo', { cells: [{ x: 2, y: 1 }, { x: 3, y: 1 }] });
  call('dragTo', { cells: [{ x: 3, y: 2 }] });
  call('place', { type: 'chest', cells: [{ x: 8, y: 8 }] });
  eq(eng.world.count, 5);
  eq(call('undo').label, '設置');
  eq(eng.world.count, 4, '箱だけ戻っていない');
  const r = call('undo');
  eq([r.done, eng.world.count, r.undo, r.redo], [true, 0, 0, 2], 'ドラッグが1回で戻っていない');
  eq(call('undo').done, false);
  call('redo');
  eq([eng.world.count, eng.world.at(3, 1).dir, eng.world.at(3, 2).dir], [4, 'S', 'S'], '曲がり角の向きが戻っていない');
  call('remove', { x: 1, y: 1 });
  eq(call('redo').done, false, '新しい操作の後もやり直せる');
});
test('元に戻す: 撤去・回転・鉱脈を戻す（撤去した箱は空で戻り、中身は床のまま）', () => {
  const { eng, call } = undoEngine();
  call('place', { type: 'chest', cells: [{ x: 2, y: 2 }] });
  call('place', { type: 'belt', cells: [{ x: 4, y: 2, dir: 'E' }] });
  eng.sim.addItems(2, 2, 'ore', 5);
  call('remove', { x: 2, y: 2 });
  call('rotate', { x: 4, y: 2 });
  call('resource', { item: 'ore', cells: [{ x: 6, y: 6 }] });
  call('resource', { item: 'ore', cells: [{ x: 7, y: 6 }], group: true });
  eq([eng.world.resourceAt(6, 6), eng.world.resourceAt(7, 6)], ['ore', 'ore']);
  eq(call('undo').label, '鉱脈');
  eq([eng.world.resourceAt(6, 6), eng.world.resourceAt(7, 6)], [null, null], '塗った鉱脈が1回で戻っていない');
  call('undo');
  eq(eng.world.at(4, 2).dir, 'E', '回転が戻っていない');
  call('undo');
  eq(eng.world.at(2, 2).type, 'chest', '撤去が戻っていない');
  eng.sim.sync();
  eq([total(eng.sim.contentsAt(2, 2).container.slots.filter(Boolean)), total(eng.sim.contentsAt(2, 2).ground)], [0, 5]);
});
test('元に戻す: まとめて移動を戻すと中身も元の場所へ戻る', () => {
  const { eng, call } = undoEngine();
  call('place', { type: 'chest', cells: [{ x: 1, y: 1 }] });
  eng.sim.addItems(1, 1, 'plate', 7);
  call('move', { rect: { x0: 1, y0: 1, x1: 1, y1: 1 }, x: 5, y: 5 });
  eq(eng.world.at(5, 5).type, 'chest');
  eq(call('undo').label, '移動');
  eq([eng.world.at(5, 5), eng.world.at(1, 1).type], [null, 'chest']);
  eng.sim.sync();
  eq(total(eng.sim.contentsAt(1, 1).container.slots.filter(Boolean)), 7, '中身が戻っていない');
  call('redo');
  eng.sim.sync();
  eq(total(eng.sim.contentsAt(5, 5).container.slots.filter(Boolean)), 7, 'やり直しで中身が付いてこない');
});
test('元に戻す: 全消去と読み込みは、中身ごと前の盤面へ戻る', () => {
  const { eng, call } = undoEngine();
  call('place', { type: 'chest', cells: [{ x: 1, y: 1 }] });
  eng.sim.addItems(1, 1, 'ore', 3);
  const save = call('save');
  call('clear');
  eq(eng.world.count, 0);
  eq(call('undo').label, '全消去');
  eq(total(eng.sim.contentsAt(1, 1).container.slots.filter(Boolean)), 3, '全消去の前の中身が戻っていない');
  call('redo');
  eq(eng.world.count, 0, 'やり直しで消えない');
  call('load', { data: save });
  eq(eng.world.count, 1);
  eq(call('undo').label, '読み込み');
  eq(eng.world.count, 0, '読み込みの前に戻っていない');
  call('load', { data: save, record: false });
  eq(call('undo').done, false, '起動時の読み込みが記録に残った');
});
test('元に戻す: 貼り付け・切り取りも1回ずつ戻る', () => {
  const { eng, call } = undoEngine();
  call('place', { type: 'belt', cells: [{ x: 1, y: 1, dir: 'E' }, { x: 2, y: 1, dir: 'E' }] });
  const bp = call('copy', { rect: { x0: 1, y0: 1, x1: 2, y1: 1 } });
  call('paste', { blueprint: bp, x: 5, y: 5 });
  call('removeArea', { rect: { x0: 1, y0: 1, x1: 2, y1: 1 }, label: '切り取り' });
  eq(eng.world.count, 2);
  eq(call('undo').label, '切り取り');
  eq(eng.world.count, 4);
  eq(call('undo').label, '貼り付け');
  eq([eng.world.count, eng.world.at(5, 5)], [2, null]);
});

/* ---- 送り出し加工機 ---- */
test('送り出し加工機: できた製品を正面へ送り出す（ベルトなら上へ、それ以外は床へ）', () => {
  const w = simWorld(10, 5);
  put(w, 'proc', 2, 2, 'E');            // 正面は (3,2)
  put(w, 'belt', 3, 2, 'E');
  const sim = new Sim(w, simReg);
  eq(sim.addItems(2, 2, 'ore', 2), 'machine');
  run(sim, 1);                            // craftTime 1秒で1個
  const m = sim.contentsAt(2, 2).machine;
  ok(!m.output, '出力に残っている');
  eq(total(sim.contentsAt(3, 2).belt) + total(sim.contentsAt(4, 2).ground), 1, '正面に出ていない');
  run(sim, 3);
  eq(total(sim.contentsAt(4, 2).ground), 2, 'ベルトの先に流れていない');
  eq(sim.produced.plate, 2);
});
test('送り出し加工機: 正面が空きマスなら床へ、盤面の外なら出力に溜まる', () => {
  const w = simWorld(10, 5);
  put(w, 'proc', 2, 2, 'N');            // 正面 (2,1) は空き
  put(w, 'proc', 9, 2, 'E');            // 正面は盤面の外
  const sim = new Sim(w, simReg);
  sim.addItems(2, 2, 'ore', 1); sim.addItems(9, 2, 'ore', 1);
  run(sim, 2);
  eq(sim.contentsAt(2, 1).ground, [{ item: 'plate', count: 1 }]);
  eq(sim.contentsAt(9, 2).machine.output, { item: 'plate', count: 1 });
});
test('送り出し加工機: 出したばかりの物は同じ tick に進まない', () => {
  const w = simWorld(10, 5);
  put(w, 'proc', 2, 2, 'E'); put(w, 'belt', 3, 2, 'E'); put(w, 'belt', 4, 2, 'E');
  const sim = new Sim(w, simReg);
  sim.addItems(2, 2, 'ore', 1);
  for (let i = 0; i < 25; i++) {
    sim.step();
    if (total(sim.contentsAt(3, 2).belt) + total(sim.contentsAt(4, 2).belt)) break;
  }
  eq(total(sim.contentsAt(3, 2).belt), 1, '正面のベルトを飛ばした');
});

/* ---- スプリッター（Phase 7） ---- */
test('スプリッター: 半分に分け、半端は多い方を背面→正面→背面…と交互に', () => {
  const st = { next: 'back' };
  eq(splitStack(10, st), { back: 5, front: 5 });
  eq(st.next, 'back', '割り切れたのに順番が進んだ');
  eq(splitStack(5, st), { back: 3, front: 2 });
  eq(splitStack(5, st), { back: 2, front: 3 });
  eq(splitStack(1, st), { back: 1, front: 0 });
  eq(splitStack(1, st), { back: 0, front: 1 });
});
test('スプリッター: 横からだけ受け取る', () => {
  const w = simWorld(10, 5);
  const s = put(w, 'splitter', 3, 2, 'N');
  ok(splitterAccepts(simReg, s, 2, 2) && splitterAccepts(simReg, s, 4, 2), '横から入らない');
  ok(!splitterAccepts(simReg, s, 3, 1) && !splitterAccepts(simReg, s, 3, 3), '正面・背面から入った');
  ok(!splitterAccepts(simReg, s, 1, 2), '離れたマスから入った');
});
test('スプリッター: 横から入ったベルトの物を、正面と背面へ半分ずつ送る（先がベルトなら載る）', () => {
  const w = simWorld(10, 5);
  put(w, 'belt', 2, 2, 'E');          // 横から入る
  put(w, 'splitter', 3, 2, 'N');      // 正面 (3,1)、背面 (3,3)
  put(w, 'belt', 3, 1, 'E');          // 正面の先はベルト → 右へ流れて (4,1) の床へ
  const sim = new Sim(w, simReg);
  sim.addItems(2, 2, 'ore', 7);
  run(sim, 1);
  eq(total(sim.contentsAt(3, 2).belt), 7, 'スプリッターに入っていない');
  run(sim, 1);
  eq(total(sim.contentsAt(3, 3).ground), 4, '背面（多い方）');
  eq(total(sim.contentsAt(3, 1).belt), 3, '正面のベルト');
  run(sim, 1);
  eq(total(sim.contentsAt(4, 1).ground), 3, '正面のベルトの先');
  eq(sim.totals().onBelts, 0);
});
test('スプリッター: 正面・背面から向かってくるベルトは入らず、行き止まりと同じく床に落ちる', () => {
  const w = simWorld(10, 5);
  put(w, 'belt', 3, 3, 'N');          // 背面から向かう
  put(w, 'splitter', 3, 2, 'N');
  const sim = new Sim(w, simReg);
  sim.addItems(3, 3, 'ore', 4);
  run(sim, 1);
  eq(total(sim.contentsAt(3, 2).ground), 4);
  eq(total(sim.contentsAt(3, 2).belt), 0, '入ってしまった');
});
test('スプリッター: アームは入れられ、撤去で中身は床へ、回しても順番と中身は残り、保存できる', () => {
  const w = simWorld(10, 5);
  put(w, 'chest', 1, 2); put(w, 'inserter', 2, 2, 'W'); put(w, 'splitter', 3, 2, 'N');
  const sim = new Sim(w, simReg);
  sim.addItems(1, 2, 'ore', 3);
  run(sim, 1);
  eq(total(sim.contentsAt(3, 2).belt), 3, 'アームが入れられない');
  run(sim, 1);                        // 3 → 背面 2・正面 1。次は正面が多い方
  eq([total(sim.contentsAt(3, 3).ground), total(sim.contentsAt(3, 1).ground)], [2, 1]);
  eq(sim.splitState.get(w.at(3, 2).id).next, 'front');
  const saved = JSON.parse(JSON.stringify({ world: w, sim }));
  const back = Sim.fromJSON(saved.sim, World.fromJSON(saved.world, simReg), simReg);
  eq(back.splitState.get(back.world.at(3, 2).id).next, 'front', '順番が保存されていない');
  sim.addItems(3, 2, 'plate', 2);
  rotateAt(w, simReg, 3, 2);
  eq(total(sim.contentsAt(3, 2).belt), 2, '回したら中身が消えた');
  eq(sim.splitState.get(w.at(3, 2).id).next, 'front', '回したら順番が戻った');
  removeAt(w, 3, 2);
  eq(total(sim.contentsAt(3, 2).ground), 2);
});

/* ---- 保存・読込（Phase 6） ---- */
test('セーブデータで盤面も中身も時間も採掘機の進み具合も元に戻る', () => {
  const w = busyWorld();
  const sim = new Sim(w, simReg);
  sim.addItems(15, 5, 'ore', 4);
  run(sim, 5);
  for (let i = 0; i < 7; i++) sim.step();
  const data = JSON.parse(JSON.stringify(makeSave(w, sim, new Date('2026-10-05T00:00:00Z'))));
  eq([data.format, data.version, data.savedAt], ['industry-sim', 1, '2026-10-05T00:00:00.000Z']);
  const back = loadSave(data, simReg);
  eq(back.skipped, 0);
  eq(back.world.count, w.count);
  eq(back.sim.toJSON(), sim.toJSON());
  ok(data.sim.miners.length > 0, '採掘機の進み具合が保存されていない');
  // 続きを同じだけ進めても同じになる
  run(sim, 3); run(back.sim, 3);
  eq(back.sim.toJSON(), sim.toJSON(), '読み込んだ後の動きが違う');
});
test('セーブデータ: 違う形・新しすぎる形はエラー、知らない建物と重なる建物は飛ばす', () => {
  let msg = '';
  try { loadSave({ hello: 1 }, simReg); } catch (e) { msg = e.message; }
  eq(msg, 'このアプリのセーブデータではありません');
  try { loadSave({ format: 'industry-sim', version: 99, world: { width: 5, height: 5 } }, simReg); } catch (e) { msg = e.message; }
  ok(msg.includes('新しい形式'), msg);
  const r = loadSave({ format: 'industry-sim', version: 1, world: { width: 5, height: 5, buildings: [
    { type: 'belt', x: 1, y: 1, dir: 'E' }, { type: 'nothing', x: 2, y: 2 }, { type: 'chest', x: 1, y: 1 },
    { type: 'belt', x: 9, y: 9 }], resources: [{ x: 0, y: 0, item: 'ore' }, { x: 0, y: 1, item: 'nothing' }] }, sim: {} }, simReg);
  eq([r.world.count, r.skipped, r.world.resources.size], [1, 3, 1]);
});
test('エンジン: 保存して、全消去して、読み込むと元に戻る。読めないデータでは今の盤面のまま', () => {
  const sent = [];
  const eng = new Engine(simReg, m => sent.push(m), { width: 20, height: 10 });
  const res = id => sent.find(m => m.re === id);
  eng.handle({ id: 1, op: 'place', type: 'belt', cells: [{ x: 1, y: 1, dir: 'E' }, { x: 2, y: 1, dir: 'E' }] });
  eng.handle({ id: 2, op: 'items', x: 1, y: 1, item: 'ore', count: 3 });
  const v0 = eng.version;
  eng.handle({ id: 3, op: 'save' });
  eq(eng.version, v0, '保存しただけで version が増えた');
  const data = JSON.parse(JSON.stringify(res(3).result));
  eng.handle({ id: 4, op: 'clear' });
  eq(eng.world.count, 0);
  eng.handle({ id: 5, op: 'load', data });
  eq([res(5).result.count, res(5).result.skipped], [2, 0]);
  eq(total(eng.sim.contentsAt(1, 1).belt), 3);
  eng.handle({ id: 6, op: 'load', data: { format: 'other' } });
  ok(res(6).error, '読めないデータでエラーにならない');
  eq(eng.world.count, 2, '読めなかったのに盤面が変わった');
});

/* ---- 盤面の大きさ ---- */
test('盤面を広げても、建物・中身・鉱脈・床の物・時間はそのまま', () => {
  const w = simWorld(10, 10);
  put(w, 'belt', 1, 1, 'E'); put(w, 'chest', 5, 5);
  w.setResource(2, 2, 'ore');
  const sim = new Sim(w, simReg);
  sim.addItems(1, 1, 'ore', 3); sim.addItems(5, 5, 'plate', 4); sim.addItems(8, 8, 'ore', 2);
  for (let i = 0; i < 7; i++) sim.step();
  const r = resizeSave(w, sim, simReg, 30, 20);
  eq([r.world.width, r.world.height, r.world.count, r.skipped], [30, 20, 2, 0]);
  eq(r.sim.toJSON(), sim.toJSON());
  eq(r.world.resourceAt(2, 2), 'ore');
  ok(canPlace(r.world, simDefs.chest, 29, 19).ok, '広げた所に置けない');
  eq([w.width, w.height], [10, 10], '元の World が変わった');
});
test('盤面を縮めると、はみ出す建物は中身ごと、はみ出す鉱脈・床の物も消える', () => {
  const w = simWorld(20, 20);
  put(w, 'belt', 1, 1, 'E'); put(w, 'chest', 18, 1); put(w, 'smelter', 9, 4);   // 2x2 は (9..10, 4..5)
  w.setResource(2, 2, 'ore'); w.setResource(19, 19, 'ore');
  const sim = new Sim(w, simReg);
  sim.addItems(18, 1, 'plate', 4); sim.addItems(1, 3, 'ore', 2); sim.addItems(15, 7, 'ore', 5);
  eq(countOutside(w, 10, 20), 2, '箱と、半分はみ出す 2x2 を数えていない');
  eq(countOutside(w, 11, 11), 1);
  const r = resizeSave(w, sim, simReg, 10, 20);
  eq([r.world.count, r.skipped], [1, 2]);
  eq(r.world.resourceAt(2, 2), 'ore');
  eq(r.world.resourceAt(19, 19) || null, null);
  eq(r.sim.totals().onGround, 2, '外の床の物が残った / 中の床の物が消えた');
  eq(r.sim.totals().inContainers, 0);
});
test('盤面の大きさは 8〜1024 の整数だけ', () => {
  eq(checkSize(8, 1024), null);
  ok(checkSize(7, 10), '小さすぎるのに通った');
  ok(checkSize(10, 1025), '大きすぎるのに通った');
  ok(checkSize(10.5, 10), '整数でないのに通った');
  ok(checkSize('20', 10), '文字なのに通った');
});
test('エンジン: 下見では変えず、変えた後の全消去も新しい大きさのまま', () => {
  const sent = [];
  const eng = new Engine(simReg, m => sent.push(m), { width: 20, height: 10 });
  const res = id => sent.find(m => m.re === id);
  eng.handle({ id: 1, op: 'place', type: 'belt', cells: [{ x: 1, y: 1, dir: 'E' }, { x: 15, y: 1, dir: 'E' }] });
  const v0 = eng.version;
  eng.handle({ id: 2, op: 'resize', width: 10, height: 10, dryRun: true });
  eq(res(2).result, { lost: 1 });
  eq([eng.world.width, eng.world.count, eng.version], [20, 2, v0], '下見なのに変わった');
  eng.handle({ id: 3, op: 'resize', width: 10, height: 12 });
  eq(res(3).result, { width: 10, height: 12, lost: 1, count: 1 });
  eng.handle({ id: 4, op: 'resize', width: 3, height: 12 });
  ok(res(4).error, '小さすぎるのにエラーにならない');
  eq(eng.world.width, 10);
  eng.handle({ id: 5, op: 'clear' });
  eq([eng.world.width, eng.world.height], [10, 12], '全消去で元の大きさに戻った');
  eng.handle({ op: 'ack' });
  const snap = sent.filter(m => m.type === 'view').pop().snap;
  eq([snap.width, snap.height], [10, 12]);
});

test('元に戻す: 盤面の大きさの変更を戻すと、消えた建物も中身ごと戻る', () => {
  const { eng, call } = undoEngine();
  call('place', { type: 'chest', cells: [{ x: 15, y: 5 }] });
  eng.sim.addItems(15, 5, 'plate', 6);
  call('resize', { width: 10, height: 10 });
  eq(eng.world.count, 0);
  eq(call('undo').label, '大きさの変更');
  eq([eng.world.width, eng.world.count], [20, 1]);
  eq(total(eng.sim.contentsAt(15, 5).container.slots.filter(Boolean)), 6);
  call('redo');
  eq([eng.world.width, eng.world.count], [10, 0]);
});

/* ---- registry（データを実際に読む） ---- */
const reg = await Registry.load('data');
test('data/ を読める', () => {
  ok(reg.items.size > 0, 'アイテムが読めていない');
  ok(reg.buildings.size > 0, '建物が読めていない');
  ok(reg.building('furnace'), 'furnace が無い');
});
test('データの整合が取れている', () => {
  eq(reg.problems, [], `データに問題: ${reg.problems.join(' / ')}`);
});
test('ベルト・アーム・保管箱の挙動が data に書いてある', () => {
  ok(reg.building('belt').belt, 'belt に belt の定義が無い');
  ok(reg.building('inserter').inserter, 'inserter に inserter の定義が無い');
  ok(reg.building('chest').container, 'chest に container の定義が無い');
  ok(reg.building('furnace').machine, 'furnace に machine の定義が無い');
  ok(reg.building('miner').miner, 'miner に miner の定義が無い');
  ok(reg.item('iron-ore').resource, '鉄鉱石が鉱脈になれない');
  for (const id of ['miner', 'furnace', 'generator']) eq(reg.building(id).size, { width: 1, height: 1 }, `${id} が 1x1 でない`);
  for (const r of reg.recipes.values()) eq(r.craftTime, 10, `${r.id} の加工時間が10秒でない`);
  eq(reg.building('generator').power.source, 24);
  ok(reg.building('wire') && reg.building('wire').layer === 'floor', '電線が床の層にない');
  ok(reg.building('inserter').power.needs && reg.building('miner').power.needs, 'アーム・採掘機が電気を要らない');
  ok(!reg.building('belt').power && !reg.building('furnace').power, 'ベルト・炉が電気を要る');
});
test('ゲームの設定（data/game.json）: 1スタックの上限は Core Keeper に合わせて 9999。アイテムに書けばそちらが優先', () => {
  eq([reg.game.id, reg.game.defaults.stackSize], ['core-keeper', 9999]);
  eq(stackLimit(reg, 'iron-ore'), 9999);
  const r2 = { item: () => ({ id: 'x', stackSize: 50 }), game: reg.game };
  eq(stackLimit(r2, 'x'), 50, 'アイテムの値が優先されない');
  eq(stackLimit({ item: () => ({ id: 'y' }) }, 'y'), 100, 'game.json が無いときの既定値');
});
test('製材機（data を足しただけの機械）: 電気が届けば木材を板にし、炉では木材を扱えない', () => {
  const saw = reg.building('table-saw');
  ok(saw && saw.machine && saw.power.needs, '製材機が無い・電気を要らない');
  const w = new World({ width: 6, height: 3 });
  place(w, reg.building('generator'), 0, 0, 'N');
  place(w, saw, 1, 0, 'N');                        // 発電機の隣
  place(w, saw, 4, 2, 'N');                        // 電気が届かない
  place(w, reg.building('furnace'), 3, 0, 'N');
  const sim = new Sim(w, reg);
  sim.addItems(1, 0, 'wood', 2); sim.addItems(4, 2, 'wood', 2); sim.addItems(3, 0, 'wood', 1);
  for (let i = 0; i < 20 * TICK_HZ; i++) sim.step();
  eq(sim.contentsAt(1, 0).machine.output, { item: 'plank', count: 2 });
  eq(sim.contentsAt(4, 2).machine.output, null, '電気が無いのに動いた');
  eq(sim.contentsAt(3, 0).machine.input, null, '炉に木材が入った');
  eq(sim.contentsAt(3, 0).ground, [{ item: 'wood', count: 1 }]);
});
test('回収機: 正面5x5の床の物を、1秒ごとに背面へまとめて移す。範囲の外・電気が無いときは動かない', () => {
  const w = new World({ width: 12, height: 12 });
  place(w, reg.building('generator'), 4, 8, 'N');      // 回収機の左隣
  place(w, reg.building('collector'), 5, 8, 'N');       // 正面は上。範囲は x 3..7, y 3..7、背面は (5,9)
  place(w, reg.building('chest'), 5, 9, 'N');
  const sim = new Sim(w, reg);
  sim.addItems(3, 3, 'iron-ore', 5); sim.addItems(7, 7, 'coal', 2); sim.addItems(5, 2, 'coal', 9);   // (5,2) は範囲の外
  sim.stepSecond();
  eq(sim.contentsAt(3, 3).ground, []);
  eq(sim.contentsAt(5, 2).ground, [{ item: 'coal', count: 9 }], '範囲の外を取った');
  const got = sim.contentsAt(5, 9).container.slots.filter(Boolean);
  eq(got.reduce((a, s) => a + s.count, 0), 7);
  eq(sim.contentsAt(5, 8).collector.state, '稼働中');
  // 電気が無い回収機
  const w2 = new World({ width: 8, height: 8 });
  place(w2, reg.building('collector'), 3, 6, 'N');
  const s2 = new Sim(w2, reg);
  s2.addItems(3, 4, 'coal', 1); s2.stepSecond();
  eq(s2.contentsAt(3, 4).ground, [{ item: 'coal', count: 1 }]);
  eq(s2.contentsAt(3, 6).collector.state, '電力なし');
});
test('焼却炉: どんな物でも入り、炉と同じく10秒に1個消す。出力は無い', () => {
  const w = new World({ width: 6, height: 3 });
  place(w, reg.building('generator'), 0, 0, 'N');
  place(w, reg.building('incinerator'), 1, 0, 'N');
  const sim = new Sim(w, reg);
  eq(sim.addItems(1, 0, 'coal', 3), 'machine');
  eq(sim.addItems(1, 0, 'iron-plate', 1), 'ground', '違う種類が入った');
  for (let i = 0; i < 20; i++) sim.stepSecond();
  const m = sim.contentsAt(1, 0).machine;
  eq([m.input, m.output], [{ item: 'coal', count: 1 }, null]);
  eq(sim.destroyed, { coal: 2 });
  for (let i = 0; i < 10; i++) sim.stepSecond();
  eq(sim.contentsAt(1, 0).machine.input, null);
  eq(sim.contentsAt(1, 0).machine.state, '原料待ち');
});
test('粉砕機: スクラップ用アイテム1個を10秒で2〜3種類にして正面へ送り出す。扱えない物は入らない', () => {
  const w = new World({ width: 8, height: 4 });
  place(w, reg.building('generator'), 0, 1, 'N');
  place(w, reg.building('shredder'), 1, 1, 'E');           // 正面は (2,1)
  place(w, reg.building('belt'), 2, 1, 'E');
  place(w, reg.building('shredder'), 1, 2, 'S');           // 正面は (1,3) の床。発電機とは (1,1) の粉砕機を通じてつながる
  const sim = new Sim(w, reg);
  eq(sim.addItems(1, 1, 'scrap-a', 2), 'machine');
  eq(sim.addItems(1, 2, 'scrap-b', 1), 'machine');
  eq(sim.addItems(1, 1, 'iron-ore', 1), 'ground', '扱えない物が入った');
  for (let i = 0; i < 10; i++) sim.stepSecond();
  const kinds = l => Object.fromEntries(l.map(s => [s.item, s.count]));
  const onBelt = [...sim.contentsAt(2, 1).belt, ...sim.contentsAt(3, 1).ground];
  eq(kinds(onBelt), { 'iron-plate': 2, 'copper-plate': 1, 'scrap-part': 1 }, 'A は3種類');
  eq(kinds(sim.contentsAt(1, 3).ground), { 'copper-plate': 1, 'scrap-part': 2 }, 'B は2種類');
  eq(sim.contentsAt(1, 1).machine.input, { item: 'scrap-a', count: 1 });
  eq(sim.contentsAt(1, 1).machine.output, null, '出力に溜まった');
  // 正面が盤面の外なら加工しない
  const w2 = new World({ width: 3, height: 3 });
  place(w2, reg.building('generator'), 1, 1, 'N');
  place(w2, reg.building('shredder'), 2, 1, 'E');
  const s2 = new Sim(w2, reg);
  s2.addItems(2, 1, 'scrap-a', 1); for (let i = 0; i < 12; i++) s2.stepSecond();
  eq(s2.contentsAt(2, 1).machine.state, '出し先が盤面の外');
  eq(s2.contentsAt(2, 1).machine.input, { item: 'scrap-a', count: 1 });
});
/* ---- レバー・感圧板・回路（signal.js） ---- */
const sigBoard = (w, list) => { for (const [type, x, y, dir = 'N'] of list) ok(place(w, reg.building(type), x, y, dir), `${type} を (${x},${y}) に置けない`); };
const poweredAt = (sim, x, y) => { sim.sync(); return !sim.unpowered.has(sim.world.at(x, y).id); };
test('レバー: 入っているときだけ電気を通す。置いた直後は切れている。保存しても入り切りが残る', () => {
  const w = new World({ width: 8, height: 3 });
  sigBoard(w, [['generator', 0, 1], ['lever', 1, 1], ['wire', 2, 1], ['miner', 3, 1, 'W']]);
  const sim = new Sim(w, reg);
  eq(poweredAt(sim, 3, 1), false, '切れているのに届いた');
  eq(toggleLever(sim, 1, 1), true);
  eq(poweredAt(sim, 3, 1), true, '入れたのに届かない');
  const saved = JSON.parse(JSON.stringify({ world: w, sim }));
  const w2 = World.fromJSON(saved.world, reg);
  const back = Sim.fromJSON(saved.sim, w2, reg);
  eq(poweredAt(back, 3, 1), true, '読み込むとレバーが切れた');
  eq(toggleLever(sim, 1, 1), false);
  eq(poweredAt(sim, 3, 1), false);
  eq(toggleLever(sim, 2, 1), null, '電線を入り切りできた');
});
test('交差回路: 縦と横がつながらず、来た向きのまままっすぐ通す', () => {
  const w = new World({ width: 9, height: 9 });
  sigBoard(w, [['generator', 1, 4], ['wire', 2, 4], ['wire', 3, 4], ['cross-circuit', 4, 4], ['wire', 5, 4], ['miner', 6, 4, 'W'],
               ['wire', 4, 2], ['wire', 4, 3], ['wire', 4, 5], ['miner', 4, 1, 'S'], ['miner', 4, 6, 'N']]);
  const sim = new Sim(w, reg);
  eq(poweredAt(sim, 6, 4), true, '横に通らない');
  eq([poweredAt(sim, 4, 1), poweredAt(sim, 4, 6)], [false, false], '横から縦へ漏れた');
});
test('論理回路: 左・右・背面のうちちょうど2つに電気が来ると、正面へ出す', () => {
  const w = new World({ width: 11, height: 10 });
  sigBoard(w, [['logic-circuit', 5, 5, 'N'], ['wire', 5, 4], ['miner', 5, 3, 'S'],
               ['generator', 1, 5], ['lever', 2, 5], ['wire', 3, 5], ['wire', 4, 5],      // 左
               ['generator', 9, 5], ['lever', 8, 5], ['wire', 7, 5], ['wire', 6, 5],      // 右
               ['generator', 5, 9], ['lever', 5, 8], ['wire', 5, 7], ['wire', 5, 6]]);    // 背面
  const sim = new Sim(w, reg);
  const out = () => poweredAt(sim, 5, 3);
  eq(out(), false, '0つで出た');
  toggleLever(sim, 2, 5); eq(out(), false, '1つで出た');
  toggleLever(sim, 8, 5); eq(out(), true, '2つで出ない');
  toggleLever(sim, 5, 8); eq(out(), false, '3つで出た');
  toggleLever(sim, 2, 5); eq(out(), true, '右と背面の2つで出ない');
});
test('遅延回路: 背面から入った電気を1秒遅れて正面へ出す', () => {
  const w = new World({ width: 8, height: 3 });
  sigBoard(w, [['generator', 0, 1], ['lever', 1, 1], ['wire', 2, 1], ['delay-circuit', 3, 1, 'E'], ['wire', 4, 1], ['miner', 5, 1, 'W']]);
  const sim = new Sim(w, reg);
  sim.step();
  toggleLever(sim, 1, 1);
  for (let i = 0; i < 10; i++) sim.step();
  eq(poweredAt(sim, 5, 1), false, '0.5秒で出た');
  for (let i = 0; i < 12; i++) sim.step();
  eq(poweredAt(sim, 5, 1), true, '1秒たっても出ない');
  toggleLever(sim, 1, 1);
  for (let i = 0; i < 10; i++) sim.step();
  eq(poweredAt(sim, 5, 1), true, '切って0.5秒で止まった');
  for (let i = 0; i < 12; i++) sim.step();
  eq(poweredAt(sim, 5, 1), false, '切って1秒たっても止まらない');
});
test('感圧板: そのマスの床に物があるあいだ弱い電気を出す', () => {
  const w = new World({ width: 10, height: 3 });
  sigBoard(w, [['pressure-plate', 1, 1], ['wire', 2, 1], ['miner', 3, 1, 'W'], ['wire', 4, 1], ['wire', 5, 1], ['wire', 6, 1], ['miner', 7, 1, 'W']]);
  const sim = new Sim(w, reg);
  eq(poweredAt(sim, 3, 1), false, '何も無いのに出た');
  sim.addItems(1, 1, 'coal', 1);
  sim.step();
  eq(poweredAt(sim, 3, 1), true, '物があるのに出ない');
  eq(poweredAt(sim, 7, 1), false, '弱い電気（5）なのに6マス先まで届いた');
});
test('簡易ドリル: 採掘機の半分の速さ（4秒に1個）で掘る', () => {
  const w = new World({ width: 6, height: 3 });
  sigBoard(w, [['generator', 1, 0], ['crude-drill', 1, 1, 'W'], ['miner', 1, 2, 'W']]);
  w.setResource(0, 1, 'iron-ore'); w.setResource(0, 2, 'iron-ore');
  const sim = new Sim(w, reg);
  for (let i = 0; i < 8; i++) sim.stepSecond();
  eq(sim.contentsAt(2, 1).ground, [{ item: 'iron-ore', count: 2 }]);
  eq(sim.contentsAt(2, 2).ground, [{ item: 'iron-ore', count: 4 }]);
});
test('回路の自動生成: 条件どおりに動く配置だけを、面積の小さい順・同じなら数の少ない順に並べる', () => {
  const cases = [
    [1, [true, false]],                               // A でない
    [2, [false, false, false, true]],                 // A かつ B
    [2, [false, true, true, false]],                  // どちらか一方だけ
    [2, [false, true, true, true]],                   // A または B
    [3, [false, false, false, true, false, true, true, false]],   // ちょうど2つ
  ];
  for (const [n, table] of cases) {
    const res = generateCircuits(reg, n, table);
    ok(res.candidates.length > 0, `${table.map(Number).join('')} の回路ができない`);
    for (let i = 1; i < res.candidates.length; i++) {
      const a = res.candidates[i - 1], b = res.candidates[i];
      ok(a.area < b.area || (a.area === b.area && a.count <= b.count), '並び順が違う');
    }
    const c = res.candidates[0];
    const levers = c.blueprint.buildings.filter(b => b.type === 'lever');
    eq(levers.length, n);
    // 設計図を盤面に貼って、全部の組み合わせを確かめ直す
    const w = new World({ width: c.width + 2, height: c.height + 2 });
    pasteBlueprint(w, reg, c.blueprint, 1, 1);
    const sim = new Sim(w, reg);
    const on = c.input.map(() => false);
    for (let r = 0; r < 1 << n; r++) {
      c.input.forEach((p, i) => { const want = ((r >> (n - 1 - i)) & 1) === 1; if (on[i] !== want) { toggleLever(sim, p.x + 1, p.y + 1); on[i] = want; } });
      sim.sync();
      eq((sim.power.get(key(c.output.x + 1, c.output.y + 1)) || 0) >= 1, table[r], `${table.map(Number).join('')} の ${r} 行目`);
    }
  }
  eq(generateCircuits(reg, 2, [false, false, false, false]).candidates, [], 'いつも出さない回路ができた');
});
test('回路の自動生成: 「どちらか一方だけ」は論理回路1つ（入力2つ＋発電機）で組む', () => {
  const c = generateCircuits(reg, 2, [false, true, true, false]).candidates[0];
  eq(c.blueprint.buildings.filter(b => b.type === 'logic-circuit').length, 1);
});
test('レシピの材料と製品が実在する', () => {
  for (const r of reg.recipes.values()) {
    for (const id of Object.keys(r.inputs)) ok(reg.item(id), `${r.id} の材料 ${id} が無い`);
    for (const id of Object.keys(r.outputs)) ok(reg.item(id), `${r.id} の製品 ${id} が無い`);
  }
});

/* ---- 結果を出す ---- */
const passed = results.filter(r => r.ok).length;
const failed = results.length - passed;
const box = document.getElementById('out');
box.innerHTML = results.map(r =>
  `<div class="${r.ok ? 'ok' : 'ng'}">${r.ok ? '✓' : '✗'} ${r.name}`
  + `${r.ok ? '' : `<div class="msg">${r.message}</div>`}</div>`).join('');
document.getElementById('sum').textContent = `${passed} 件成功 / ${failed} 件失敗`;
document.getElementById('sum').className = failed ? 'ng' : 'ok';
console.log(`tests: ${passed} passed, ${failed} failed`);
window.__testResult = { passed, failed, results };
