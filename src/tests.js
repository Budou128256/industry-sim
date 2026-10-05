/* core の自動テスト。
 *
 * この環境には Node が無いので、ブラウザで走らせる（tests.html を開く）。
 * core は DOM を知らないので、ここでは描画も入力も使わない。
 */

import { DELTA, footprint, neighbors, rotateCW, rotatedSize } from './core/grid.js';
import { World } from './core/world.js';
import { canPlace, dragDirection, lineCells, place, removeAt, rotateAt } from './core/placement.js';
import { Registry } from './core/registry.js';

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
