/* 設計図。盤面の一部（建物の並び）を切り出して、別の場所に貼れる形にする。
 *
 * 形:
 *   { format: 'industry-sim-blueprint', version: 1, name, width, height,
 *     buildings: [{ type, x, y, dir }] }      x, y は範囲の左上からの位置
 *
 * 写すのは建物（床の層の電線も）と向きだけ。中身（ベルトの上の物など）と鉱脈は写さない。
 * 範囲に全部が入っている建物だけを写す（2x2 の建物が範囲の端で切れているときは写さない）。
 * **描画も DOM も知らない。**
 */

import { footprint, rotateCW, rotatedSize } from './grid.js';
import { canPlace, place } from './placement.js';

export const BLUEPRINT_FORMAT = 'industry-sim-blueprint';
export const BLUEPRINT_VERSION = 1;

/** 2つのマスから、両端を含む矩形 { x0, y0, x1, y1 } を作る。 */
export function rectFrom(a, b) {
  return { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
}

/** 範囲に全部が入っている建物。 */
export function buildingsInside(world, rect) {
  const inside = c => c.x >= rect.x0 && c.x <= rect.x1 && c.y >= rect.y0 && c.y <= rect.y1;
  return world.buildingsIn(rect.x0, rect.y0, rect.x1, rect.y1)
    .filter(b => footprint(b.x, b.y, b.size, b.dir).every(inside));
}

/** 範囲を設計図にする。 */
export function captureBlueprint(world, rect, name = '') {
  const buildings = buildingsInside(world, rect)
    .map(b => ({ type: b.type, x: b.x - rect.x0, y: b.y - rect.y0, dir: b.dir }))
    .sort((a, b) => (a.y - b.y) || (a.x - b.x) || (a.type < b.type ? -1 : 1));
  return {
    format: BLUEPRINT_FORMAT, version: BLUEPRINT_VERSION, name,
    width: rect.x1 - rect.x0 + 1, height: rect.y1 - rect.y0 + 1, buildings,
  };
}

/** 設計図を時計回りに90度回したもの（元は変えない）。 */
export function rotateBlueprint(bp, registry) {
  const H = bp.height;
  const buildings = bp.buildings.map(b => {
    const def = registry.building(b.type);
    const { height: h } = rotatedSize(def ? def.size : { width: 1, height: 1 }, b.dir);
    // 占めていた矩形 [x..x+w-1] x [y..y+h-1] は、回すと左上が (H - y - h, x) になる
    return { type: b.type, x: H - b.y - h, y: b.x, dir: rotateCW(b.dir || 'N') };
  }).sort((a, b) => (a.y - b.y) || (a.x - b.x) || (a.type < b.type ? -1 : 1));
  return { ...bp, width: bp.height, height: bp.width, buildings };
}

/** 設計図として読めるか。だめなら日本語の理由を返す。 */
export function checkBlueprint(bp) {
  if (!bp || typeof bp !== 'object' || bp.format !== BLUEPRINT_FORMAT) return 'このアプリの設計図ではありません';
  if (bp.version > BLUEPRINT_VERSION) return `新しい形式の設計図です（形式 ${bp.version}）`;
  if (!(bp.width > 0 && bp.height > 0) || !Array.isArray(bp.buildings)) return '設計図の形が読めません';
  return null;
}

/** 左上を (x, y) にしたとき、各建物を置けるか（下見用）。 */
export function previewBlueprint(world, registry, bp, x, y) {
  return bp.buildings.map(b => {
    const def = registry.building(b.type);
    const at = { x: x + b.x, y: y + b.y, dir: b.dir || 'N' };
    return { def, ...at, ok: !!def && canPlace(world, def, at.x, at.y, at.dir).ok };
  });
}

/** 左上を (x, y) にして貼る。置けない建物（重なる・盤面の外・知らない種類）は飛ばす。 */
export function pasteBlueprint(world, registry, bp, x, y) {
  let placed = 0, skipped = 0;
  for (const b of bp.buildings) {
    const def = registry.building(b.type);
    if (def && place(world, def, x + b.x, y + b.y, b.dir || 'N')) placed++;
    else skipped++;
  }
  return { placed, skipped };
}
