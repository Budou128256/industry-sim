/* 入力を「コマンド」に変える層。
 *
 * ここは World を直接書き換えない。「何をしたいか」だけを外へ渡す。
 * こうしておくと、あとで取り消し（undo）・記録・リプレイ・通信を足しやすい。
 *
 * 出すコマンド:
 *   { type:'place',  x, y, ctrl }     置く（ctrl: Ctrl を押しながら。貼り付けで上書き）
 *   { type:'remove', x, y }           撤去
 *   { type:'rotate', x, y }           回す
 *   { type:'drag',   from, to }       連続設置（前のマス → 今のマス。マウスの通った道どおりに置く）
 *   { type:'release', ctrl }          左ボタンを離した（範囲選択の確定・ドラッグで移動の確定）
 *   { type:'hover', x, y, ctrl }      マウスが動いた（Ctrl を押した・離したときも出す）
 *   { type:'flip', axis }             V: 上下反転（axis 'v'）。左右反転（'h'）はボタンだけ（キーは無し。ユーザーの希望）
 *   { type:'move' }                   M: 選んだ範囲をまとめて動かす
 *   { type:'copy' | 'cut' | 'paste' | 'delete' }   Ctrl+C / Ctrl+X / Ctrl+V / Delete
 *   { type:'fit' }                    盤面全体を表示（F / Home）
 *   { type:'redraw' }                 画面を動かした（描き直す）
 *
 * 画面の移動（ここで直接カメラを動かす。World は触らない）:
 *   矢印キー / WASD（Shift で速く）、スペースを押しながら左ドラッグ、中ボタンドラッグ、Shift+ドラッグ、
 *   ホイールで拡大縮小、+ / - でも拡大縮小
 */

/** 押している間に動く速さ（マス/秒）。Shift で FAST 倍。 */
const PAN_SPEED = 16;
const FAST = 3;
const PAN_KEYS = {
  ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
  w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0],
};

export class Input {
  constructor(canvas, renderer, emit) {
    this.canvas = canvas;
    this.renderer = renderer;
    this.emit = emit;
    this.dragStart = null;
    this.panning = null;
    this.space = false;          // スペースを押している（左ドラッグで画面を動かす）
    this.held = new Set();       // 押している移動キー
    this.shift = false;
    this.ctrl = false;           // Ctrl（Mac は ⌘）を押している
    this.lastFrame = 0;
    this.bind();
  }

  bind() {
    const cv = this.canvas, r = this.renderer;

    cv.addEventListener('contextmenu', e => e.preventDefault());

    cv.addEventListener('mousedown', e => {
      const cell = r.toCell(e.clientX, e.clientY);
      if (e.button === 1 || e.shiftKey || (e.button === 0 && this.space)) {   // 中ボタン / Shift / スペースで画面を動かす
        e.preventDefault();
        this.panning = { px: e.clientX, py: e.clientY };
        return;
      }
      if (e.button === 2) { this.emit({ type: 'remove', ...cell }); return; }
      if (e.button === 0) {
        this.dragStart = cell; this.dragLast = cell;
        this.emit({ type: 'place', ...cell, ctrl: e.ctrlKey || e.metaKey });
      }
    });

    cv.addEventListener('mousemove', e => {
      const cell = r.toCell(e.clientX, e.clientY);
      r.hover = cell;
      this.ctrl = e.ctrlKey || e.metaKey;
      if (this.panning) {
        const dx = (e.clientX - this.panning.px) / r.tile;
        const dy = (e.clientY - this.panning.py) / r.tile;
        r.pan(-dx, -dy);
        this.panning = { px: e.clientX, py: e.clientY };
        this.emit({ type: 'redraw' });
        return;
      }
      if (this.dragStart) {
        const last = this.dragLast;
        if (last.x === cell.x && last.y === cell.y) return;    // 同じマスの中で動いただけ
        this.dragLast = cell;
        this.emit({ type: 'drag', from: last, to: cell, ctrl: this.ctrl });
      } else {
        this.emit({ type: 'hover', ...cell, ctrl: this.ctrl });
      }
    });

    window.addEventListener('mouseup', e => {
      if (this.dragStart) this.emit({ type: 'release', ctrl: e.ctrlKey || e.metaKey });
      this.dragStart = null; this.panning = null;
    });

    cv.addEventListener('wheel', e => {
      e.preventDefault();
      r.zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
      this.emit({ type: 'redraw' });
    }, { passive: false });

    const typing = e => ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName);
    window.addEventListener('keydown', e => {
      if (typing(e)) return;
      this.shift = e.shiftKey;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (k === 'Control' || k === 'Meta') { this.setCtrl(true); return; }
      if (e.ctrlKey || e.metaKey) {
        const cmd = { c: 'copy', x: 'cut', v: 'paste' }[k];
        if (cmd) { e.preventDefault(); this.emit({ type: cmd }); }
        return;
      }
      if (PAN_KEYS[k]) { e.preventDefault(); this.held.add(k); this.startPan(); return; }
      if (k === ' ') { e.preventDefault(); this.space = true; cv.style.cursor = 'grab'; return; }
      if (k === 'r') {
        const c = r.hover;
        if (c) this.emit({ type: 'rotate', ...c });
      }
      if (k === 'v') this.emit({ type: 'flip', axis: 'v' });
      if (k === 'm') this.emit({ type: 'move' });
      if (k === 'f' || k === 'Home') this.emit({ type: 'fit' });
      if (k === '+' || k === '=' || k === ';') { r.zoomCenter(1.25); this.emit({ type: 'redraw' }); }
      if (k === '-') { r.zoomCenter(1 / 1.25); this.emit({ type: 'redraw' }); }
      if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); this.emit({ type: 'delete' }); }
      if (k === 'Escape') this.emit({ type: 'cancel' });
    });
    window.addEventListener('keyup', e => {
      this.shift = e.shiftKey;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      this.held.delete(k);
      if (k === ' ') { this.space = false; cv.style.cursor = ''; }
      if (k === 'Control' || k === 'Meta') this.setCtrl(false);
    });
    window.addEventListener('blur', () => { this.held.clear(); this.space = false; cv.style.cursor = ''; this.setCtrl(false); });
  }

  /** Ctrl を押した・離した。貼り付けの下見（上書きするか）を描き直すため、今のマスで hover を出し直す。 */
  setCtrl(on) {
    if (this.ctrl === on) return;
    this.ctrl = on;
    const c = this.renderer.hover;
    if (c) this.emit({ type: 'hover', ...c, ctrl: on });
  }

  /** 移動キーを押している間、毎コマ少しずつ画面を動かす。 */
  startPan() {
    if (this.lastFrame) return;          // もう動いている
    const r = this.renderer;
    this.lastFrame = performance.now();
    const step = now => {
      if (!this.held.size) { this.lastFrame = 0; return; }
      const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
      this.lastFrame = now;
      let dx = 0, dy = 0;
      for (const k of this.held) { dx += PAN_KEYS[k][0]; dy += PAN_KEYS[k][1]; }
      const v = PAN_SPEED * (this.shift ? FAST : 1) * dt * (28 / r.tile);   // 縮小しているほど速く
      if (dx || dy) { r.pan(dx * v, dy * v); this.emit({ type: 'redraw' }); }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}
