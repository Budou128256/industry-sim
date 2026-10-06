/* データの読み込みと id 引き。
 *
 * 中身（アイテム・建物・レシピ）はコードに書かない。data/ の JSON を読むだけ。
 * 新しい鉱石や機械を足したいときは data/ にファイルを置き、data/index.json に id を足す。
 * ブラウザはフォルダの一覧を取れないので、index.json が目録の役をする。
 * data/game.json は「どのゲームに合わせた値か」と、ゲームごとの既定値（defaults。例: 1スタックの上限）。
 * 別のゲームに合わせるときは data/ をまるごと差し替える（game.json は無くてもよい）。
 */

/** 読み込んだ定義を id で引けるようにしたもの。 */
export class Registry {
  constructor() {
    this.items = new Map();
    this.buildings = new Map();
    this.recipes = new Map();
    this.game = { id: 'unknown', name: '（未設定）', defaults: {} };   // data/game.json
  }

  /** data/index.json を見て、全部の定義を読む。 */
  static async load(base = 'data') {
    const reg = new Registry();
    const index = await fetchJson(`${base}/index.json`);
    try { reg.game = { ...reg.game, ...(await fetchJson(`${base}/game.json`)) }; } catch { /* 無ければ既定のまま */ }
    for (const kind of ['items', 'buildings', 'recipes']) {
      const ids = index[kind] || [];
      const defs = await Promise.all(ids.map(id => fetchJson(`${base}/${kind}/${id}.json`)));
      for (const def of defs) reg[kind].set(def.id, Object.freeze(def));
    }
    reg.validate();
    return reg;
  }

  item(id) { return this.items.get(id); }
  building(id) { return this.buildings.get(id); }
  recipe(id) { return this.recipes.get(id); }

  /** 定義の取りこぼしを早めに見つける（レシピが知らないアイテムを指している等）。 */
  validate() {
    const problems = [];
    for (const r of this.recipes.values()) {
      for (const id of [...Object.keys(r.inputs || {}), ...Object.keys(r.outputs || {})]) {
        if (!this.items.has(id)) problems.push(`レシピ ${r.id}: 未定義のアイテム ${id}`);
      }
      for (const id of r.machines || []) {
        if (!this.buildings.has(id)) problems.push(`レシピ ${r.id}: 未定義の建物 ${id}`);
      }
    }
    for (const b of this.buildings.values()) {
      const s = b.size || {};
      if (!(s.width > 0 && s.height > 0)) problems.push(`建物 ${b.id}: size が不正`);
    }
    this.problems = problems;
    return problems;
  }
}

async function fetchJson(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path} を読めません (${res.status})`);
  return res.json();
}
