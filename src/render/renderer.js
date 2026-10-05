/* Canvas への描画。World を**読むだけ**で、書き換えない。
 *
 * 画面の見た目に関する判断（色・大きさ・カメラ）はここに閉じる。
 * 盤面を DOM 要素で作らない（建物が増えても重くならないように）。
 */

import { DELTA, footprint, rotatedSize } from '../core/grid.js';
import { minerOutput, minerTargets } from '../core/miner.js';
import { craftTicks, recipeFor } from '../core/machine.js';
import { TICK_HZ } from '../core/sim.js';

export class Renderer {
  constructor(canvas, registry) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.registry = registry;
    /** カメラ: 1マスの画面上の大きさと、左上がどのマスか */
    this.tile = 28;
    this.origin = { x: 0, y: 0 };   // マス単位
    this.hover = null;              // { x, y }
    this.ghost = null;              // { cells, ok, def, dir }
  }

  /** 画面の座標 → マスの座標。 */
  toCell(px, py) {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: Math.floor((px - r.left) / this.tile + this.origin.x),
      y: Math.floor((py - r.top) / this.tile + this.origin.y),
    };
  }

  /** マスの座標 → 画面の座標（左上）。 */
  toScreen(x, y) {
    return { px: (x - this.origin.x) * this.tile, py: (y - this.origin.y) * this.tile };
  }

  zoomAt(px, py, factor) {
    const before = this.toCell(px, py);
    this.tile = Math.max(8, Math.min(64, this.tile * factor));
    const after = this.toCell(px, py);
    this.origin.x += before.x - after.x;
    this.origin.y += before.y - after.y;
  }

  pan(dxCells, dyCells) {
    this.origin.x += dxCells;
    this.origin.y += dyCells;
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.viewport = { width: r.width, height: r.height };
  }

  /** sim を渡すと、ベルト・箱・床の中身も描く（読むだけ）。 */
  draw(world, sim = null) {
    const ctx = this.ctx;
    const { width: vw, height: vh } = this.viewport;
    ctx.clearRect(0, 0, vw, vh);

    // 地面
    ctx.fillStyle = '#10131a';
    ctx.fillRect(0, 0, vw, vh);

    const t = this.tile;
    const x0 = Math.max(0, Math.floor(this.origin.x));
    const y0 = Math.max(0, Math.floor(this.origin.y));
    const x1 = Math.min(world.width, Math.ceil(this.origin.x + vw / t));
    const y1 = Math.min(world.height, Math.ceil(this.origin.y + vh / t));

    // 盤面の内側だけ明るくする
    const a = this.toScreen(x0, y0), b = this.toScreen(x1, y1);
    ctx.fillStyle = '#161a23';
    ctx.fillRect(a.px, a.py, b.px - a.px, b.py - a.py);

    // 升目
    ctx.strokeStyle = '#242a36';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = x0; x <= x1; x++) {
      const { px } = this.toScreen(x, 0);
      ctx.moveTo(px + 0.5, a.py); ctx.lineTo(px + 0.5, b.py);
    }
    for (let y = y0; y <= y1; y++) {
      const { py } = this.toScreen(0, y);
      ctx.moveTo(a.px, py + 0.5); ctx.lineTo(b.px, py + 0.5);
    }
    ctx.stroke();

    // 鉱脈（地面の層。建物の下）
    for (const [k, item] of world.resources) {
      const [x, y] = k.split(',').map(Number);
      if (x < x0 - 1 || x > x1 || y < y0 - 1 || y > y1) continue;
      this.drawResource(x, y, item);
    }

    // 建物（見えている範囲だけ描く）
    world.forEach(bld => {
      const size = rotatedSize(bld.size, bld.dir);
      if (bld.x + size.width < x0 || bld.x > x1 || bld.y + size.height < y0 || bld.y > y1) return;
      this.drawBuilding(bld, size, sim);
    });

    if (sim) this.drawItems(world, sim, { x0, y0, x1, y1 });

    if (this.ghost) this.drawGhost(this.ghost);
    if (this.hover) this.drawHover(this.hover);
  }

  drawBuilding(bld, size, sim) {
    const ctx = this.ctx, t = this.tile;
    const def = this.registry.building(bld.type) || {};
    const { px, py } = this.toScreen(bld.x, bld.y);
    const w = size.width * t, h = size.height * t;

    ctx.fillStyle = def.color || '#64748b';
    ctx.fillRect(px + 1, py + 1, w - 2, h - 2);
    const busy = sim && sim.busy.has(bld.id);       // このtickに動いたアーム
    ctx.strokeStyle = busy ? '#fbbf24' : 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 2;
    ctx.strokeRect(px + 1, py + 1, w - 2, h - 2);

    // 向きの印
    if (def.directional && bld.dir) {
      const d = DELTA[bld.dir];
      ctx.fillStyle = '#0b0e15';
      ctx.beginPath();
      ctx.arc(px + w / 2 + d.x * w * 0.33, py + h / 2 + d.y * h * 0.33, Math.max(2, t * 0.09), 0, 7);
      ctx.fill();
    }
    // 名前の頭文字（アイコンは後の段階で）
    if (t >= 18 && def.name) {
      ctx.fillStyle = '#0b0e15';
      ctx.font = `700 ${Math.round(t * 0.4)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(def.name[0], px + w / 2, py + h / 2 + 1);
    }
  }

  /** ベルトの上・箱の中・床のアイテムを描く。1マスにつき先頭の種類の色と合計数。 */
  drawItems(world, sim, { x0, y0, x1, y1 }) {
    const visible = (x, y) => x >= x0 - 1 && x <= x1 && y >= y0 - 1 && y <= y1;
    for (const [id, list] of sim.belts) {
      const b = world.buildings.get(id);
      if (!b || !list.length || !visible(b.x, b.y)) continue;
      this.drawStack(b.x, b.y, list, 'belt');
    }
    for (const [id, ch] of sim.containers) {
      const b = world.buildings.get(id);
      const list = ch.slots.filter(Boolean);
      if (!b || !list.length || !visible(b.x, b.y)) continue;
      this.drawStack(b.x, b.y, list, 'container');
    }
    for (const [id, m] of sim.machines) {
      const b = world.buildings.get(id);
      if (b && visible(b.x, b.y)) this.drawMachine(b, m);
    }
    for (const id of sim.miners.keys()) {
      const b = world.buildings.get(id);
      if (b && visible(b.x, b.y)) this.drawMinerOutput(b);
    }
    for (const [k, list] of sim.ground) {
      if (!list.length) continue;
      const [x, y] = k.split(',').map(Number);
      if (!visible(x, y)) continue;
      this.drawStack(x, y, list, 'ground');
    }
  }

  drawResource(x, y, item) {
    const ctx = this.ctx, t = this.tile;
    const { px, py } = this.toScreen(x, y);
    const def = this.registry.item(item) || {};
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = def.color || '#94a3b8';
    ctx.fillRect(px + 1, py + 1, t - 2, t - 2);
    ctx.globalAlpha = 0.9;
    for (const [fx, fy] of [[0.28, 0.3], [0.68, 0.42], [0.42, 0.72]]) {   // 鉱石の粒
      ctx.beginPath();
      ctx.arc(px + t * fx, py + t * fy, Math.max(1.5, t * 0.08), 0, 7);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /** 加工機: 入力（左下）・出力（右下）・進み具合（下の帯）。 */
  drawMachine(b, m) {
    const ctx = this.ctx, t = this.tile;
    const size = rotatedSize(b.size, b.dir);
    const { px, py } = this.toScreen(b.x, b.y);
    const w = size.width * t, h = size.height * t;
    if (m.input) this.drawStack(b.x, b.y + size.height - 1, [m.input], 'ground-like');
    if (m.output) this.drawStack(b.x + size.width - 1, b.y + size.height - 1, [m.output], 'container');
    const recipe = m.input && recipeFor(this.registry, b.type, m.input.item);
    const pct = recipe ? m.progress / craftTicks(recipe, TICK_HZ) : 0;
    ctx.fillStyle = '#0b0e15';
    ctx.fillRect(px + 4, py + h - 7, w - 8, 4);
    ctx.fillStyle = m.state === '出力が満杯' ? '#f87171' : '#4ade80';
    ctx.fillRect(px + 4, py + h - 7, (w - 8) * Math.min(1, pct), 4);
  }

  /** 採掘機の掘るマス（水色の点線）と出し先のマス（黄色の点線）。 */
  drawMinerOutput(b) {
    const ctx = this.ctx, t = this.tile;
    const mark = (c, color) => {
      const { px, py } = this.toScreen(c.x, c.y);
      ctx.strokeStyle = color;
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1.5;
      ctx.strokeRect(px + 3, py + 3, t - 6, t - 6);
      ctx.setLineDash([]);
    };
    for (const c of minerTargets(b)) mark(c, 'rgba(56,189,248,0.75)');
    mark(minerOutput(b), 'rgba(250,204,21,0.75)');
  }

  drawStack(x, y, list, where) {
    const ctx = this.ctx, t = this.tile;
    const { px, py } = this.toScreen(x, y);
    const item = this.registry.item(list[0].item) || {};
    const n = list.reduce((a, s) => a + s.count, 0);
    const r = t * 0.2;
    // 床は左下、ベルトは中央、箱は右下に小さく
    const left = where === 'ground' || where === 'ground-like';
    const cx = left ? px + t * 0.28 : where === 'container' ? px + t * 0.72 : px + t / 2;
    const cy = where === 'belt' ? py + t / 2 : py + t * 0.72;
    ctx.fillStyle = item.color || '#e5e7eb';
    ctx.strokeStyle = where === 'ground' ? '#f87171' : '#0b0e15';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (where === 'ground') ctx.arc(cx, cy, r, 0, 7);
    else ctx.rect(cx - r, cy - r, r * 2, r * 2);
    ctx.fill(); ctx.stroke();
    if (t >= 18) {
      ctx.fillStyle = '#ffffff';
      ctx.font = `700 ${Math.round(t * 0.3)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.lineWidth = 3; ctx.strokeStyle = '#0b0e15';
      ctx.strokeText(String(n), cx, cy - r + 1);
      ctx.fillText(String(n), cx, cy - r + 1);
    }
  }

  drawGhost({ cells, ok }) {
    const ctx = this.ctx, t = this.tile;
    ctx.fillStyle = ok ? 'rgba(74,222,128,0.25)' : 'rgba(248,113,113,0.3)';
    ctx.strokeStyle = ok ? 'rgba(74,222,128,0.9)' : 'rgba(248,113,113,0.9)';
    ctx.lineWidth = 2;
    for (const c of cells) {
      const { px, py } = this.toScreen(c.x, c.y);
      ctx.fillRect(px, py, t, t);
      ctx.strokeRect(px + 1, py + 1, t - 2, t - 2);
    }
  }

  drawHover({ x, y }) {
    const ctx = this.ctx, t = this.tile;
    const { px, py } = this.toScreen(x, y);
    ctx.strokeStyle = 'rgba(148,163,184,0.8)';
    ctx.lineWidth = 1;
    ctx.strokeRect(px + 0.5, py + 0.5, t - 1, t - 1);
  }

  /** 置こうとしている場所の下見を作る（置けるかどうかで色が変わる）。 */
  setGhost(def, x, y, dir, ok) {
    this.ghost = def ? { cells: footprint(x, y, def.size, dir), ok, def, dir } : null;
  }
}
