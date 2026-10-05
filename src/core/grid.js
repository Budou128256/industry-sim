/* 座標まわりの決まりごと。
 *
 * 座標は (x, y)。x は右へ、y は下へ増える。向きは 'N' 'E' 'S' 'W'。
 * ここには**状態を持たない**。World や Placement から呼ばれる計算だけを置く。
 * 後で Chunk に広げるときも、この層の意味は変えない。
 */

export const DIRS = ['N', 'E', 'S', 'W'];

/** 向き → 進む方向。 */
export const DELTA = {
  N: { x: 0, y: -1 },
  E: { x: 1, y: 0 },
  S: { x: 0, y: 1 },
  W: { x: -1, y: 0 },
};

export const OPPOSITE = { N: 'S', S: 'N', E: 'W', W: 'E' };

/** 時計回りに1つ回す。 */
export function rotateCW(dir) {
  return DIRS[(DIRS.indexOf(dir) + 1) % 4];
}

/** マスの鍵。Map のキーに使う。 */
export function key(x, y) {
  return `${x},${y}`;
}

export function parseKey(k) {
  const [x, y] = k.split(',').map(Number);
  return { x, y };
}

/** 向きを考えた占有の大きさ。N/S はそのまま、E/W は縦横が入れ替わる。 */
export function rotatedSize(size, dir) {
  const w = size.width, h = size.height;
  return (dir === 'E' || dir === 'W') ? { width: h, height: w } : { width: w, height: h };
}

/** 左上を (x, y) に置いたときに占有するマスを列挙する。 */
export function footprint(x, y, size, dir = 'N') {
  const { width, height } = rotatedSize(size, dir);
  const cells = [];
  for (let dy = 0; dy < height; dy++) {
    for (let dx = 0; dx < width; dx++) cells.push({ x: x + dx, y: y + dy });
  }
  return cells;
}

/** 上下左右のマス。 */
export function neighbors(x, y) {
  return DIRS.map(d => ({ x: x + DELTA[d].x, y: y + DELTA[d].y, dir: d }));
}

/** 矩形の中に入っているか。 */
export function inBounds(x, y, width, height) {
  return x >= 0 && y >= 0 && x < width && y < height;
}
