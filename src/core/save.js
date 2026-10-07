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
import { footprint } from './grid.js';

export const SAVE_FORMAT = 'industry-sim';
export const SAVE_VERSION = 1;

/** 盤面の大きさの範囲（マス）。上限はマスの鍵（grid.js の key）が扱える範囲より十分小さく、速さを測った 512 の倍まで。 */
export const MIN_SIZE = 8;
export const MAX_SIZE = 1024;

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
    place(world, def, b.x, b.y, b.dir || 'N', { filter: b.filter });
  }
  for (const r of wd.resources || []) {
    if (r.x >= 0 && r.y >= 0 && r.x < world.width && r.y < world.height && registry.item(r.item)) {
      world.setResource(r.x, r.y, r.item);
    }
  }
  const inside = e => e.x >= 0 && e.y >= 0 && e.x < world.width && e.y < world.height;
  const simData = { ...(data.sim || {}), ground: ((data.sim || {}).ground || []).filter(inside) };
  const sim = Sim.fromJSON(simData, world, registry);
  return { world, sim, skipped, savedAt: data.savedAt || null };
}

/** 大きさ（幅・高さ）が範囲内の整数か。だめなら日本語の理由を返す。 */
export function checkSize(width, height) {
  for (const [name, v] of [['幅', width], ['高さ', height]]) {
    if (!Number.isInteger(v) || v < MIN_SIZE || v > MAX_SIZE) {
      return `${name}は ${MIN_SIZE}〜${MAX_SIZE} の整数にしてください`;
    }
  }
  return null;
}

/** 大きさを変えたら盤面の外にはみ出す建物の数（左上は動かさず、右と下を広げる・縮める）。 */
export function countOutside(world, width, height) {
  let n = 0;
  world.forEach(b => {
    if (footprint(b.x, b.y, b.size, b.dir).some(c => c.x >= width || c.y >= height)) n++;
  });
  return n;
}

/**
 * 盤面の大きさを変えた World と Sim を作る（元のものは変えない）。
 * 左上は動かさない。はみ出す建物は中身ごと、はみ出す鉱脈・床の物も消える。
 */
export function resizeSave(world, sim, registry, width, height) {
  const reason = checkSize(width, height);
  if (reason) throw new Error(reason);
  const data = makeSave(world, sim);
  data.world.width = width;
  data.world.height = height;
  return loadSave(data, registry);
}
