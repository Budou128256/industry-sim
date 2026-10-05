/* セーブデータ（Phase 6）。World と Sim をまとめて1つの素のデータにし、そこから元に戻す。
 *
 * 形:
 *   { format: 'industry-sim', version: 1, savedAt: ISO 文字列, world: World.toJSON(), sim: Sim.toJSON() }
 *
 * 置き場所（ブラウザの中・ファイル）は storage.js と app.js の仕事。ここは形だけを決める。
 * **描画も DOM も知らない。**
 */

import { World } from './world.js';
import { Sim } from './sim.js';
import { canPlace, place } from './placement.js';

export const SAVE_FORMAT = 'industry-sim';
export const SAVE_VERSION = 1;

export function makeSave(world, sim, now = new Date()) {
  return {
    format: SAVE_FORMAT,
    version: SAVE_VERSION,
    savedAt: now.toISOString(),
    world: world.toJSON(),
    sim: sim.toJSON(),
  };
}

/**
 * セーブデータから World と Sim を作る。形が違えばエラー（日本語の理由つき）。
 * 知らない建物（data/ から消えた等）・重なる建物・盤面の外の建物は飛ばし、その数を skipped で返す。
 */
export function loadSave(data, registry) {
  if (!data || typeof data !== 'object' || data.format !== SAVE_FORMAT) {
    throw new Error('このアプリのセーブデータではありません');
  }
  if (data.version > SAVE_VERSION) {
    throw new Error(`新しい形式のセーブデータです（形式 ${data.version}）。アプリを新しくしてください`);
  }
  const wd = data.world || {};
  if (!(wd.width > 0 && wd.height > 0)) throw new Error('盤面の大きさが読めません');
  const world = new World({ width: wd.width, height: wd.height });
  let skipped = 0;
  for (const b of wd.buildings || []) {
    const def = registry.building(b.type);
    if (!def || !canPlace(world, def, b.x, b.y, b.dir || 'N').ok) { skipped++; continue; }
    place(world, def, b.x, b.y, b.dir || 'N');
  }
  for (const r of wd.resources || []) {
    if (r.x >= 0 && r.y >= 0 && r.x < world.width && r.y < world.height && registry.item(r.item)) {
      world.setResource(r.x, r.y, r.item);
    }
  }
  const sim = Sim.fromJSON(data.sim || {}, world, registry);
  return { world, sim, skipped, savedAt: data.savedAt || null };
}
