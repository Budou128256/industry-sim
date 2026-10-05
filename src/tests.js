/* core の自動テスト。
 *
 * この環境には Node が無いので、ブラウザで走らせる（tests.html を開く）。
 * core は DOM を知らないので、ここでは描画も入力も使わない。
 */

import { DELTA, footprint, neighbors, rotateCW, rotatedSize } from './core/grid.js';
import { World } from './core/world.js';
import { canPlace, dragDirection, lineCells, place, removeAt, rotateAt } from './core/placement.js';
import { Registry } from './core/registry.js';
import { Sim, TICK_HZ } from './core/sim.js';
import { buildBeltLines } from './core/belt.js';

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
test('ドラッグは直線になる（斜めにしない）', () => {
  eq(lineCells({ x: 0, y: 0 }, { x: 3, y: 1 }).length, 4);
  eq(lineCells({ x: 0, y: 0 }, { x: 3, y: 1 })[3], { x: 3, y: 0 });
  eq(lineCells({ x: 2, y: 2 }, { x: 2, y: 2 }), [{ x: 2, y: 2 }]);
});
test('ドラッグの向きが取れる', () => {
  eq(dragDirection({ x: 0, y: 0 }, { x: 5, y: 1 }), 'E');
  eq(dragDirection({ x: 0, y: 0 }, { x: 0, y: -3 }), 'N');
  eq(dragDirection({ x: 1, y: 1 }, { x: 1, y: 1 }), null);
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
  miner: { id: 'miner', size: SIZE_2, directional: true, miner: { periodSeconds: 2, amount: 1 } },
};
const simReg = {
  building: id => simDefs[id],
  item: id => ({ ore: { id: 'ore', stackSize: 10 }, plate: { id: 'plate', stackSize: 10 } }[id]),
  recipes: new Map([['plate', { id: 'plate', inputs: { ore: 1 }, outputs: { plate: 1 }, craftTime: 1, machines: ['smelter'] }]]),
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
test('採掘機は2秒に1個掘って、正面の左前のマスの床に出す', () => {
  const w = simWorld(6, 6);
  for (const [x, y] of [[2, 2], [3, 2], [2, 3], [3, 3]]) w.setResource(x, y, 'ore');
  put(w, 'miner', 2, 2, 'E');                    // 右向き → 出し先は (4, 2)
  const sim = new Sim(w, simReg);
  run(sim, 1);
  eq(sim.contentsAt(4, 2).ground, [], '2秒たたないうちに出た');
  run(sim, 1);
  eq(sim.contentsAt(4, 2).ground, [{ item: 'ore', count: 1 }]);
  run(sim, 4);
  eq(sim.contentsAt(4, 2).ground, [{ item: 'ore', count: 3 }]);
  eq(sim.contentsAt(2, 2).miner.state, '採掘中');
});
test('出し先の向きは回すと変わる', () => {
  const w = simWorld(6, 6);
  w.setResource(2, 2, 'ore');
  for (const [dir, cell] of [['N', [2, 1]], ['E', [4, 2]], ['S', [3, 4]], ['W', [1, 3]]]) {
    const b = put(w, 'miner', 2, 2, dir);
    const sim = new Sim(w, simReg);
    run(sim, 2);
    eq(total(sim.contentsAt(...cell).ground), 1, `${dir} 向きの出し先が違う`);
    w.remove(b);
  }
});
test('採掘機の出し先がベルトならベルトに載る', () => {
  const w = simWorld(8, 4);
  w.setResource(0, 0, 'ore');
  put(w, 'miner', 0, 0, 'E'); put(w, 'belt', 2, 0, 'E'); put(w, 'belt', 3, 0, 'E');
  const sim = new Sim(w, simReg);
  run(sim, 2);
  eq(total(sim.contentsAt(2, 0).belt), 1);
});
test('鉱脈が無ければ掘らない', () => {
  const w = simWorld(6, 6);
  put(w, 'miner', 2, 2, 'E');
  const sim = new Sim(w, simReg);
  run(sim, 4);
  eq(sim.totals().onGround, 0);
  eq(sim.contentsAt(2, 2).miner.state, '鉱脈なし');
});
test('下に何種類かあれば順番に掘る', () => {
  const w = simWorld(6, 6);
  w.setResource(2, 2, 'ore'); w.setResource(3, 3, 'plate');
  put(w, 'miner', 2, 2, 'E');
  const sim = new Sim(w, simReg);
  run(sim, 4);
  eq(sim.contentsAt(4, 2).ground, [{ item: 'ore', count: 1 }, { item: 'plate', count: 1 }]);
});
test('鉱脈 → 採掘機 → ベルト → 床 → アーム → 炉 → アーム → 箱 で製品ができる', () => {
  const w = new World({ width: 12, height: 6 });
  for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]]) w.setResource(x, y, 'ore');
  put(w, 'miner', 0, 0, 'E');                    // 出し先 (2,0)
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
