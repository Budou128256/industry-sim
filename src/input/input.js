/* 入力を「コマンド」に変える層。
 *
 * ここは World を直接書き換えない。「何をしたいか」だけを外へ渡す。
 * こうしておくと、あとで取り消し（undo）・記録・リプレイ・通信を足しやすい。
 *
 * 出すコマンド:
 *   { type:'place',  x, y, dir }      置く
 *   { type:'remove', x, y }           撤去
 *   { type:'rotate', x, y }           回す
 *   { type:'drag',   from, to }       連続設置（前のマス → 今のマス。マウスの通った道どおりに置く）
 *   { type:'inspect', x, y }          中身を見る
 */

export class Input {
  constructor(canvas, renderer, emit) {
    this.canvas = canvas;
    this.renderer = renderer;
    this.emit = emit;
    this.dragStart = null;
    this.panning = null;
    this.bind();
  }

  bind() {
    const cv = this.canvas, r = this.renderer;

    cv.addEventListener('contextmenu', e => e.preventDefault());

    cv.addEventListener('mousedown', e => {
      const cell = r.toCell(e.clientX, e.clientY);
      if (e.button === 1 || e.shiftKey) {              // 中ボタン / Shift で画面を動かす
        this.panning = { px: e.clientX, py: e.clientY };
        return;
      }
      if (e.button === 2) { this.emit({ type: 'remove', ...cell }); return; }
      if (e.button === 0) { this.dragStart = cell; this.dragLast = cell; this.emit({ type: 'place', ...cell }); }
    });

    cv.addEventListener('mousemove', e => {
      const cell = r.toCell(e.clientX, e.clientY);
      r.hover = cell;
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
        this.emit({ type: 'drag', from: last, to: cell });
      } else {
        this.emit({ type: 'hover', ...cell });
      }
    });

    window.addEventListener('mouseup', () => { this.dragStart = null; this.panning = null; });

    cv.addEventListener('wheel', e => {
      e.preventDefault();
      r.zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
      this.emit({ type: 'redraw' });
    }, { passive: false });

    window.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === 'r' || e.key === 'R') {
        const c = r.hover;
        if (c) this.emit({ type: 'rotate', ...c });
      }
      if (e.key === 'Escape') this.emit({ type: 'cancel' });
    });
  }
}
