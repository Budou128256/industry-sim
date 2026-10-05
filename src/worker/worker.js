/* Web Worker の入口。ここで World と Sim を動かし、画面のスレッドを止めないようにする（Phase 5b）。
 * 最初の命令 { op: 'init', dataUrl, width, height } で data/ を読み、Engine を作る。 */

import { Registry } from '../core/registry.js';
import { Engine } from './engine.js';

let engine = null;
const queue = [];   // data/ を読み終える前に来た命令

self.onmessage = async e => {
  const msg = e.data;
  if (msg.op === 'init') {
    try {
      const registry = await Registry.load(msg.dataUrl);
      engine = new Engine(registry, m => self.postMessage(m), { width: msg.width, height: msg.height });
      self.postMessage({ re: msg.id, result: { problems: registry.problems } });
      for (const m of queue.splice(0)) engine.handle(m);
    } catch (err) {
      self.postMessage({ re: msg.id, error: err.message });
    }
    return;
  }
  if (!engine) { queue.push(msg); return; }
  engine.handle(msg);
};
