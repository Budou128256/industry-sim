/* 画面側から Engine（シミュレータ）を呼ぶための窓口（Phase 5b）。
 *
 * ふだんは Web Worker の中の Engine に postMessage で命令を送る。
 * Worker が作れないとき（古いブラウザ・file:// で開いた等）は、同じスレッドで Engine を動かす。
 * どちらでも call(op, args) が Promise で返事を返し、写しは onView に届く。
 */

import { Engine } from './worker/engine.js';

export class SimClient {
  constructor(onView) {
    this.onView = onView;
    this.nextId = 1;
    this.pending = new Map();   // id -> { resolve, reject }
    this.mode = null;           // 'worker' | 'main'
  }

  /** data/ を読み、Engine を用意する。registry は画面側でも読んだもの（Worker を使えないときに渡す）。 */
  async start(registry, { dataUrl, width, height, worker = true }) {
    try {
      if (!worker) throw new Error('Worker を使わない指定');
      this.worker = new Worker(new URL('./worker/worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = e => this.receive(e.data);
      this.worker.onerror = e => {          // モジュールが読めない等。待っている命令を全部失敗にする
        e.preventDefault();
        for (const p of this.pending.values()) p.reject(new Error(e.message || 'Worker のエラー'));
        this.pending.clear();
      };
      await this.withTimeout(this.call('init', { dataUrl, width, height }), 10000);
      this.mode = 'worker';
    } catch (err) {
      console.warn('Web Worker を使えないので、画面と同じスレッドで動かします:', err);
      if (this.worker) this.worker.terminate();
      this.worker = null;
      // 返事は少し後で返す（Worker のときと同じく、命令を送った後に届くようにする）
      this.engine = new Engine(registry, m => queueMicrotask(() => this.receive(m)), { width, height });
      this.mode = 'main';
    }
  }

  withTimeout(promise, ms) {
    return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('応答がない')), ms))]);
  }

  call(op, args = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, op, ...args });
    });
  }

  /** 返事のいらない命令。 */
  send(msg) {
    if (this.worker) this.worker.postMessage(msg);
    else if (this.engine) this.engine.handle(msg);
  }

  receive(m) {
    if (m.type === 'view') { this.onView(m.snap); return; }
    const p = this.pending.get(m.re);
    if (!p) return;
    this.pending.delete(m.re);
    if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result);
  }
}
