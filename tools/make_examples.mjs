/* 見本の盤面（examples/*.json）を作る。
 *
 * 見本は普通のセーブデータ（「読み込み」で開ける形）。鉱脈・箱の中身・電気も入るので、
 * 設計図（建物と向きだけ）ではなくセーブデータにしている。
 * アプリの画面からは「見本を開く」で選べる。
 *
 * 作り直すとき（Node が要る。無ければ examples/*.json をそのまま使えばよい）:
 *   node tools/make_examples.mjs          作る
 *   node tools/make_examples.mjs --check  作って、数十秒動かした結果も表示する
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Registry } from '../src/core/registry.js';
import { World } from '../src/core/world.js';
import { Sim } from '../src/core/sim.js';
import { place } from '../src/core/placement.js';
import { makeSave } from '../src/core/save.js';
import { toggleLever } from '../src/core/signal.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = p => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));

function loadRegistry() {
  const reg = new Registry();
  const index = readJson('data/index.json');
  if (fs.existsSync(path.join(root, 'data/game.json'))) reg.game = { ...reg.game, ...readJson('data/game.json') };
  for (const kind of ['items', 'buildings', 'recipes']) {
    for (const id of index[kind]) reg[kind].set(id, readJson(`data/${kind}/${id}.json`));
  }
  const problems = reg.validate();
  if (problems.length) throw new Error(problems.join('\n'));
  return reg;
}

/** 見本を作る道具。b.put('belt', x, y, 'E') など。 */
function board(reg, width, height) {
  const world = new World({ width, height });
  const items = [];
  const levers = [];
  const api = {
    world,
    put(type, x, y, dir = 'N') {
      if (!place(world, reg.building(type), x, y, dir)) throw new Error(`${type} を (${x}, ${y}) に置けない`);
      return api;
    },
    /** (x0, y) から (x1, y) まで（両端を含む）同じ物を並べる。縦は col。 */
    row(type, x0, x1, y, dir = 'N') { for (let x = x0; x <= x1; x++) api.put(type, x, y, dir); return api; },
    col(type, x, y0, y1, dir = 'N') {
      const step = y1 >= y0 ? 1 : -1;
      for (let y = y0; y !== y1 + step; y += step) api.put(type, x, y, dir);
      return api;
    },
    ore(item, ...cells) { for (const [x, y] of cells) world.setResource(x, y, item); return api; },
    items(x, y, item, count) { items.push({ x, y, item, count }); return api; },
    /** レバーを入れた状態で保存する。 */
    leverOn(x, y) { levers.push({ x, y }); return api; },
    sim() {
      const sim = new Sim(world, reg);
      for (const it of items) sim.addItems(it.x, it.y, it.item, it.count);
      for (const l of levers) if (toggleLever(sim, l.x, l.y) === null) throw new Error(`(${l.x}, ${l.y}) はレバーでない`);
      return sim;
    },
  };
  return api;
}

const EXAMPLES = [
  {
    id: 'mining-power',
    name: '1. 採掘機と電気',
    note: '発電機（左）から電線が右へ伸びる。電線は遠いほど暗く、24マスより先は灰色。'
      + '採掘機は正面（左）の鉄鉱石を2秒に1個掘り、背面（右）へ出す。'
      + '左の採掘機はベルトへ出し、ベルトの行き止まりで床に落ちる。中の採掘機は床へ直接出す。'
      + '右端の採掘機は電気が届かず止まっている（赤い ×）',
    build(reg) {
      const b = board(reg, 32, 10);
      b.put('generator', 1, 3).row('wire', 2, 29, 3);
      b.ore('iron-ore', [4, 4], [5, 4], [4, 5], [5, 5], [15, 4], [16, 4], [15, 5], [16, 5], [26, 4], [27, 4], [26, 5], [27, 5]);   // 鉱脈は 2x2
      b.put('miner', 6, 4, 'W').col('belt', 7, 4, 7, 'S');        // ベルトの先 (7,8) で床に落ちる
      b.put('miner', 17, 4, 'W');                                   // 背面 (18,4) の床へ
      b.put('miner', 28, 4, 'W');                                   // 電気が届かない
      return b;
    },
  },
  {
    id: 'furnace-processor',
    name: '2. 炉と送り出し加工機',
    note: '上の段: 箱の鉄鉱石をアームが炉へ入れ、できた鉄板を別のアームが右の箱へ移す。'
      + '中の段: 送り出し加工機（右向き）が銅板を正面のベルトへ自分で出し、ベルトの先で床に落ちる。'
      + '下の段: 送り出し加工機（下向き）は正面の床へ出す。加工は1個10秒。アームは電線で電気をもらう',
    build(reg) {
      const b = board(reg, 16, 12);
      b.put('generator', 1, 6).row('wire', 2, 6, 6).put('wire', 4, 8);
      // 上の段: 箱 → アーム → 炉 → アーム → 箱（アームは正面から取り、背面へ置く。左向きなら左から右へ運ぶ）
      b.put('chest', 3, 5).put('inserter', 4, 5, 'W').put('furnace', 5, 5).put('inserter', 6, 5, 'W').put('chest', 7, 5);
      b.items(3, 5, 'iron-ore', 30);
      // 中の段: 箱 → アーム → 送り出し加工機（右向き）→ ベルト → 床
      b.put('chest', 3, 7).put('inserter', 4, 7, 'W').put('processor', 5, 7, 'E').row('belt', 6, 8, 7, 'E');
      b.items(3, 7, 'copper-ore', 30);
      // 下の段: 箱 → アーム → 送り出し加工機（下向き）→ 床
      b.put('chest', 3, 9).put('inserter', 4, 9, 'W').put('processor', 5, 9, 'S');
      b.items(3, 9, 'iron-ore', 30);
      return b;
    },
  },
  {
    id: 'belt-splitter',
    name: '3. ベルトとスプリッター',
    note: 'アームが箱から鉄鉱石を1スタック（ここでは500個。上限は9999）丸ごとベルトへ載せる。'
      + 'スプリッターは横から入った物を半分ずつ正面（上）と背面（下）へ送り、どちらもベルトの先で床に落ちる。'
      + '右下: 床に置いてあった銅鉱石の上にベルトを敷いてあり、載って流れる（曲がり角も）',
    build(reg) {
      const b = board(reg, 20, 14);
      b.put('generator', 1, 4).row('wire', 2, 3, 4);
      b.put('chest', 2, 3).put('inserter', 3, 3, 'W').row('belt', 4, 8, 3, 'E');
      b.items(2, 3, 'iron-ore', 500);
      b.put('splitter', 9, 3, 'N').col('belt', 9, 2, 1, 'N').col('belt', 9, 4, 7, 'S');   // 上は (9,0)、下は (9,8) に落ちる
      // 床の物の上に敷いたベルト（曲がり角あり）
      b.items(12, 10, 'copper-ore', 20);
      b.row('belt', 12, 14, 10, 'E');
      b.world.remove(b.world.at(14, 10)); b.put('belt', 14, 10, 'S').put('belt', 14, 11, 'S').row('belt', 14, 16, 12, 'E');
      return b;
    },
  },
  {
    id: 'factory',
    name: '4. 全部つなげた小さな工場',
    note: '採掘機3台 → ベルト → 床 → アーム → 炉 → アーム → ベルト → スプリッター → 上下に分かれて床へ。'
      + '採掘機は発電機の隣から電気をもらい、隣どうしで電気を渡す。炉は10秒に1枚なので、鉱石は炉の中（入力）に溜まっていく',
    build(reg) {
      const b = board(reg, 24, 12);
      b.ore('iron-ore', [2, 7], [3, 7], [2, 8], [3, 8], [4, 7], [5, 7], [4, 8], [5, 8]);   // 鉱脈は 2x2 が2つ
      b.put('generator', 2, 6).row('miner', 3, 5, 6, 'S').row('wire', 6, 11, 6);
      b.row('belt', 3, 7, 5, 'E');                                  // (8,5) の床に落ちる
      b.put('inserter', 9, 5, 'W').put('furnace', 10, 5).put('inserter', 11, 5, 'W');
      b.row('belt', 12, 13, 5, 'E').put('splitter', 14, 5, 'N');
      b.col('belt', 14, 4, 3, 'N').col('belt', 14, 6, 7, 'S');      // 上は (14,2)、下は (14,8) に落ちる
      return b;
    },
  },
  {
    id: 'table-saw',
    name: '5. 製材機',
    note: '箱の木材をアームが製材機へ入れ、できた板を別のアームが右の箱へ移す。製材機は電気が要る（電線から）。'
      + '下の段はアームと製材機に電気が届かず止まっている（赤い ×）。加工は1枚10秒',
    build(reg) {
      const b = board(reg, 14, 10);
      b.put('generator', 1, 4).row('wire', 2, 7, 4);
      b.put('chest', 3, 3).put('inserter', 4, 3, 'W').put('table-saw', 5, 3).put('inserter', 6, 3, 'W').put('chest', 7, 3);
      b.items(3, 3, 'wood', 30);
      // 電気の届かない製材機（電線とつながっていない）
      b.put('chest', 3, 7).put('inserter', 4, 7, 'W').put('table-saw', 5, 7);
      b.items(3, 7, 'wood', 10);
      return b;
    },
  },
  {
    id: 'new-machines',
    name: '6. 新しい機械まとめ',
    note: '上の段（左から）: 製材機（木材→板）、焼却炉（石炭を10秒に1個消す）、粉砕機2台（スクラップ用アイテムA・Bをそれぞれ2種類の素材にして下へ送り出す）、'
      + '回収機（下向き。点線の5x5の床の物を、1秒ごとに背面の箱へ。点線の外の石炭は残る）、簡易ドリルと採掘機（簡易ドリルは半分の速さ）。'
      + '下の段の回路は、電気が届くとアーム（電気の印）の赤い × が消える。左上の丸が緑なら入っている。'
      + 'レバーは何も選んでいないときにクリックで入り切り。左から: レバー1つ、交差回路（横だけ通り縦には漏れない）、'
      + '論理回路（左・右・背面のレバーのうちちょうど2つ入ると上へ出す。最初は左と右が入っている）、'
      + '遅延回路（レバーを入れて1秒後に右へ出る）、感圧板（アームが石炭を載せると電気を出す）',
    build(reg) {
      const b = board(reg, 34, 22);
      // 電気の幹線（上）
      b.put('generator', 1, 1).row('wire', 2, 30, 1).put('generator', 31, 1);   // 電気は24マスまでなので両端に発電機
      // 製材機
      b.put('chest', 2, 2).put('inserter', 3, 2, 'W').put('table-saw', 4, 2).put('inserter', 5, 2, 'W').put('chest', 6, 2);
      b.items(2, 2, 'wood', 30);
      // 焼却炉
      b.put('chest', 8, 2).put('inserter', 9, 2, 'W').put('incinerator', 10, 2);
      b.items(8, 2, 'coal', 20);
      // 粉砕機: A はベルトで下へ（ベルトの先で床に落ちる）、B は正面の床へ
      b.put('chest', 12, 2).put('inserter', 13, 2, 'W').put('shredder', 14, 2, 'S').col('belt', 14, 3, 4, 'S');
      b.items(12, 2, 'scrap-a', 10);
      b.put('chest', 16, 2).put('inserter', 17, 2, 'W').put('shredder', 18, 2, 'S');
      b.items(16, 2, 'scrap-b', 10);
      // 回収機（下向き）。背面の箱は電線の上に置く（電線は床の層）
      b.put('collector', 22, 2, 'S').put('chest', 22, 1);
      b.items(20, 4, 'iron-ore', 5).items(23, 6, 'coal', 3).items(24, 7, 'copper-ore', 2).items(22, 9, 'coal', 4);   // (22,9) は範囲の外
      // 簡易ドリルと採掘機（左を掘り、右の床へ出す）
      b.ore('iron-ore', [26, 2], [27, 2], [26, 3], [27, 3]);   // 鉱脈は 2x2
      b.put('crude-drill', 28, 2, 'W').put('miner', 28, 3, 'W');

      // 回路（下の段）。アームは電気の印
      b.put('lever', 2, 11).row('wire', 3, 4, 11).put('inserter', 5, 11, 'E');
      b.put('generator', 1, 14).row('wire', 2, 3, 14).put('cross-circuit', 4, 14).put('wire', 5, 14).put('inserter', 6, 14, 'E');
      b.put('inserter', 4, 13, 'E').col('wire', 4, 15, 16).put('inserter', 4, 17, 'E');
      b.put('logic-circuit', 15, 15, 'N').put('wire', 15, 14).put('inserter', 15, 13, 'E');
      b.put('lever', 12, 15).row('wire', 13, 14, 15).leverOn(12, 15);
      b.put('lever', 18, 15).row('wire', 16, 17, 15).leverOn(18, 15);
      b.put('lever', 15, 18).col('wire', 15, 16, 17);
      b.put('lever', 23, 12).put('wire', 24, 12).put('delay-circuit', 25, 12, 'E').put('wire', 26, 12).put('inserter', 27, 12, 'E');
      b.put('chest', 22, 16).put('inserter', 23, 16, 'W').put('generator', 23, 17)
        .put('pressure-plate', 24, 16).row('wire', 25, 26, 16).put('inserter', 27, 16, 'E');
      b.items(22, 16, 'coal', 50);
      return b;
    },
  },
];

const reg = loadRegistry();
const check = process.argv.includes('--check');
const list = [];
for (const ex of EXAMPLES) {
  const b = ex.build(reg);
  const sim = b.sim();
  const save = { ...makeSave(b.world, sim, new Date('2026-10-06T00:00:00Z')), name: ex.name, note: ex.note };
  fs.writeFileSync(path.join(root, 'examples', `${ex.id}.json`), JSON.stringify(save, null, 1) + '\n');
  list.push({ id: ex.id, name: ex.name, note: ex.note, file: `examples/${ex.id}.json` });
  if (check) {
    for (let i = 0; i < 40; i++) sim.stepSecond();
    const t = sim.totals();
    console.log(`${ex.name}: 40秒後`, JSON.stringify({ ...t, produced: sim.produced, unpowered: sim.unpowered.size }));
    for (const [k, l] of sim.ground) console.log('   床', k, l.map(s => `${s.item}x${s.count}`).join(','));
  }
}
fs.writeFileSync(path.join(root, 'examples', 'index.json'), JSON.stringify({ examples: list }, null, 1) + '\n');
console.log(`examples/ に ${list.length} 個書きました`);
