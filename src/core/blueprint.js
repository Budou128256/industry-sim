/* 設計図。盤面の一部（建物の並び）を切り出して、別の場所に貼れる形にする。
 *
 * 形:
 *   { format: 'industry-sim-blueprint', version: 1, name, width, height,
 *     buildings: [{ type, x, y, dir }] }      x, y は範囲の左上からの位置
 *
 * 写すのは建物（床の層の電線も）と向き、アームのフィルタ（filter）だけ。中身（ベルトの上の物など）と鉱脈は写さない。
 * ただし機械の自動配置（linegen.js）が作る設計図は、ドリルが掘る鉱脈を resources: [{ x, y, item }] に持つ
 * （無くてもよい。貼ると鉱脈も置く。回す・反転にも付いてくる）。
 * 範囲に全部が入っている建物だけを写す（2x2 の建物が範囲の端で切れているときは写さない）。
 * **描画も DOM も知らない。**
 */

import { footprint, inBounds, rotateCW, rotatedSize } from './grid.js';
import { place } from './placement.js';

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
    .map(b => ({ type: b.type, x: b.x - rect.x0, y: b.y - rect.y0, dir: b.dir, ...(b.filter ? { filter: b.filter } : {}) }))
    .sort((a, b) => (a.y - b.y) || (a.x - b.x) || (a.type < b.type ? -1 : 1));
  return {
    format: BLUEPRINT_FORMAT, version: BLUEPRINT_VERSION, name,
    width: rect.x1 - rect.x0 + 1, height: rect.y1 - rect.y0 + 1, buildings,
  };
}

const byPos = (a, b) => (a.y - b.y) || (a.x - b.x) || (a.type < b.type ? -1 : 1);
const sizeOf = (registry, b) => rotatedSize((registry.building(b.type) || {}).size || { width: 1, height: 1 }, b.dir || 'N');

/** 設計図を時計回りに90度回したもの（元は変えない）。建物に付いている他の値（移動用の id など）はそのまま。 */
export function rotateBlueprint(bp, registry) {
  const H = bp.height;
  const buildings = bp.buildings.map(b => {
    const { height: h } = sizeOf(registry, b);
    // 占めていた矩形 [x..x+w-1] x [y..y+h-1] は、回すと左上が (H - y - h, x) になる
    return { ...b, x: H - b.y - h, y: b.x, dir: rotateCW(b.dir || 'N') };
  }).sort(byPos);
  const out = { ...bp, width: bp.height, height: bp.width, buildings };
  if (bp.resources) out.resources = bp.resources.map(r => ({ ...r, x: H - r.y - 1, y: r.x }));
  return out;
}

const MIRROR = { h: { E: 'W', W: 'E', N: 'N', S: 'S' }, v: { N: 'S', S: 'N', E: 'E', W: 'W' } };

/**
 * 設計図を反転したもの（元は変えない）。axis: 'h' 左右反転 / 'v' 上下反転。
 * 向きのある建物は向きも鏡に映す（東向き → 西向き）。向きのない建物は向きを変えない。
 */
export function flipBlueprint(bp, registry, axis = 'h') {
  const buildings = bp.buildings.map(b => {
    const def = registry.building(b.type);
    const { width: w, height: h } = sizeOf(registry, b);
    const dir = def && def.directional ? MIRROR[axis][b.dir || 'N'] : (b.dir || 'N');
    return axis === 'h'
      ? { ...b, x: bp.width - b.x - w, dir }
      : { ...b, y: bp.height - b.y - h, dir };
  }).sort(byPos);
  const out = { ...bp, buildings };
  if (bp.resources) out.resources = bp.resources.map(r => (axis === 'h' ? { ...r, x: bp.width - r.x - 1 } : { ...r, y: bp.height - r.y - 1 }));
  return out;
}

/** 回す・反転を順に行う。list は 'r'（右回り）/ 'h'（左右反転）/ 'v'（上下反転）の並び。 */
export function transformBlueprint(bp, registry, list = []) {
  for (const t of list) bp = t === 'r' ? rotateBlueprint(bp, registry) : flipBlueprint(bp, registry, t);
  return bp;
}

/** 設計図として読めるか。だめなら日本語の理由を返す。 */
export function checkBlueprint(bp) {
  if (!bp || typeof bp !== 'object' || bp.format !== BLUEPRINT_FORMAT) return 'このアプリの設計図ではありません';
  if (bp.version > BLUEPRINT_VERSION) return `新しい形式の設計図です（形式 ${bp.version}）`;
  if (!(bp.width > 0 && bp.height > 0) || !Array.isArray(bp.buildings)) return '設計図の形が読めません';
  return null;
}

/**
 * 設計図の建物 def を (x, y, dir) に置こうとしたときの様子。
 *   'ok'      空いている
 *   'same'    同じ種類・同じ位置・同じ向きの建物がもうある（貼っても何も変わらない）
 *   'replace' 何かと重なるが、上書きするので置ける（重なる建物は hit）
 *   'blocked' 重なる（上書きしない）・盤面の外・知らない種類
 * opts.overwrite: 重なる建物を撤去して置く（Ctrl+クリック）
 * opts.ignore:    無いものとして扱う建物の id（移動するとき、動かす建物自身）
 * opts.same:      false なら 'same' を使わず、普通の重なりとして扱う（移動用）
 */
export function judgePlacement(world, def, x, y, dir, { overwrite = false, ignore = null, same = true } = {}) {
  if (!def) return { state: 'blocked', hit: [] };
  const hit = new Map();
  for (const c of footprint(x, y, def.size, dir)) {
    if (!inBounds(c.x, c.y, world.width, world.height)) return { state: 'blocked', hit: [], out: true };
    const o = def.layer === 'floor' ? world.floorAt(c.x, c.y) : world.at(c.x, c.y);
    if (o && !(ignore && ignore.has(o.id))) hit.set(o.id, o);
  }
  if (!hit.size) return { state: 'ok', hit: [] };
  const list = [...hit.values()];
  const o = list[0];
  if (same && list.length === 1 && o.type === def.id && o.x === x && o.y === y && (o.dir || 'N') === dir) {
    return { state: 'same', hit: [] };
  }
  return { state: overwrite ? 'replace' : 'blocked', hit: list };
}

/** 左上を (x, y) にしたとき、各建物がどうなるか（下見用）。ok は「貼るとその建物が置かれる」。 */
export function previewBlueprint(world, registry, bp, x, y, opts = {}) {
  return bp.buildings.map(b => {
    const def = registry.building(b.type);
    const at = { x: x + b.x, y: y + b.y, dir: b.dir || 'N' };
    const j = judgePlacement(world, def, at.x, at.y, at.dir, opts);
    return { def, ...at, state: j.state, hit: j.hit, ok: j.state === 'ok' || j.state === 'replace' };
  });
}

/**
 * 左上を (x, y) にして貼る。
 *   上書きしないとき: 重なる・盤面の外・知らない種類の建物は飛ばす（skipped）。同じ物がもうあれば same
 *   上書きするとき（opts.overwrite）: 重なる建物を撤去してから置く（撤去した建物の中身は床に落ちる）
 * 同じ物がもうある所は、上書きでも置き直さない（中身を残すため）。
 */
export function pasteBlueprint(world, registry, bp, x, y, { overwrite = false } = {}) {
  let placed = 0, skipped = 0, replaced = 0, same = 0;
  for (const b of bp.buildings) {
    const def = registry.building(b.type);
    const at = { x: x + b.x, y: y + b.y, dir: b.dir || 'N' };
    const j = judgePlacement(world, def, at.x, at.y, at.dir, { overwrite });
    if (j.state === 'same') { same++; continue; }
    if (j.state === 'blocked') { skipped++; continue; }
    for (const h of j.hit) if (world.remove(h)) replaced++;
    if (place(world, def, at.x, at.y, at.dir, { filter: b.filter })) placed++;
    else skipped++;
  }
  let ores = 0;
  for (const r of bp.resources || []) {
    const rx = x + r.x, ry = y + r.y;
    if (!inBounds(rx, ry, world.width, world.height) || !(registry.item(r.item) || {}).resource) continue;
    if (world.resourceAt(rx, ry) !== r.item) { world.setResource(rx, ry, r.item); ores++; }
  }
  return bp.resources ? { placed, skipped, replaced, same, ores } : { placed, skipped, replaced, same };
}

/**
 * 範囲 rect の建物をまとめて動かす。transforms で回す・反転してから、左上 (x, y) に置く。
 * 1つでも置けない建物があれば、何も動かさない（blocked に数を返す）。
 * 上書き（opts.overwrite）のときは、行き先で重なる建物を撤去する。
 * 戻り値の moves は「元の id → 新しい id」。Sim はこれを見て中身（ベルトの上の物など）を引き継ぐ。
 */
export function moveArea(world, registry, rect, transforms, x, y, { overwrite = false } = {}) {
  const originals = buildingsInside(world, rect);
  const empty = { moved: 0, replaced: 0, blocked: 0, moves: [] };
  if (!originals.length) return empty;
  const src = {
    width: rect.x1 - rect.x0 + 1, height: rect.y1 - rect.y0 + 1,
    buildings: originals.map(b => ({ id: b.id, type: b.type, x: b.x - rect.x0, y: b.y - rect.y0, dir: b.dir, filter: b.filter })),
  };
  const bp = transformBlueprint(src, registry, transforms);
  const ignore = new Set(originals.map(b => b.id));
  const plan = previewBlueprint(world, registry, bp, x, y, { overwrite, ignore, same: false });
  const blocked = plan.filter(p => !p.ok).length;
  if (blocked) return { ...empty, blocked };

  let replaced = 0;
  for (const b of originals) world.remove(b);
  for (const p of plan) for (const h of p.hit) if (world.remove(h)) replaced++;
  const moves = [];
  bp.buildings.forEach((b, i) => {
    const p = plan[i];
    const nb = place(world, p.def, p.x, p.y, p.dir, { filter: b.filter });
    if (nb) moves.push([b.id, nb.id]);
  });
  return { moved: moves.length, replaced, blocked: 0, moves, width: bp.width, height: bp.height };
}
