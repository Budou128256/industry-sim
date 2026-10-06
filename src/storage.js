/* ブラウザの中への保存（Phase 6）。IndexedDB に、名前をつけてセーブデータを置く。
 *
 * 保存はそのブラウザの中だけ（別の PC・別のブラウザ・Codespaces とは共有されない）。
 * プライベートウィンドウなどで使えないときは、エラーにせず「使えない」と返す。
 */

const DB_NAME = 'industry-sim';
const STORE = 'saves';

let opening = null;

function open() {
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    if (!('indexedDB' in self)) { reject(new Error('このブラウザでは使えません')); return; }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('開けません'));
  });
  opening.catch(() => { opening = null; });
  return opening;
}

function run(mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error || new Error('保存できません'));
    tx.onabort = () => reject(tx.error || new Error('保存できません'));
  }));
}

/** 名前 name のセーブデータ。無ければ null。 */
export function loadLocal(name) {
  return run('readonly', s => s.get(name)).then(v => v || null);
}

export function saveLocal(name, data) {
  return run('readwrite', s => s.put(data, name));
}

/** 名前が prefix で始まるものの名前の一覧。 */
export function listLocal(prefix = '') {
  return run('readonly', s => s.getAllKeys()).then(keys => keys.filter(k => typeof k === 'string' && k.startsWith(prefix)).sort());
}

export function removeLocal(name) {
  return run('readwrite', s => s.delete(name));
}
