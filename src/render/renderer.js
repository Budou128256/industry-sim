/* Canvas への描画。World を**読むだけ**で、書き換えない。
 *
 * 画面の見た目に関する判断（色・大きさ・カメラ）はここに閉じる。
 * 盤面を DOM 要素で作らない（建物が増えても重くならないように）。
 */

import { DELTA, footprint, key, rotatedSize } from '../core/grid.js';
import { minerOutput, minerTargets } from '../core/miner.js';
import { craftTicks, machineDef, machineOutputCell, recipeFor } from '../core/machine.js';
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
    this.showPower = true;          // 電気の届く範囲を塗るか
    this.selection = null;          // 選んでいる範囲 { x0, y0, x1, y1 }（両端を含む）
    this.pasteGhost = null;         // 貼ろうとしている設計図の下見 [{ def, x, y, dir, ok }]
    /** 一番強い電源の強さ（電線の明るさ・塗りの濃さの基準）。data の power.source から */
    this.maxPower = 1;
    for (const b of registry.buildings.values()) {
      if (b.power && b.power.source > this.maxPower) this.maxPower = b.power.source;
    }
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

  /** 画面の真ん中を中心に拡大縮小する。 */
  zoomCenter(factor) {
    const r = this.canvas.getBoundingClientRect();
    this.zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
  }

  /** 盤面全体（幅 x 高さ マス）が画面に収まるようにする。 */
  fitTo(width, height) {
    const { width: vw, height: vh } = this.viewport;
    this.tile = Math.max(8, Math.min(64, Math.min(vw / width, vh / height)));
    this.origin.x = (width - vw / this.tile) / 2;
    this.origin.y = (height - vh / this.tile) / 2;
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.viewport = { width: r.width, height: r.height };
  }

  /** 画面に映っているマスの範囲（両端を含む）。盤面の外も含む。 */
  visibleRect() {
    const { width: vw, height: vh } = this.viewport, t = this.tile;
    return {
      x0: Math.floor(this.origin.x), y0: Math.floor(this.origin.y),
      x1: Math.ceil(this.origin.x + vw / t), y1: Math.ceil(this.origin.y + vh / t),
    };
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

    // ここから下は、画面に映っているチャンクだけを見る（Phase 5。盤面が大きくても描く量は画面の広さで決まる）
    // 鉱脈（地面の層。建物の下）
    world.resources.forEachIn(x0, y0, x1, y1, (x, y, item) => this.drawResource(x, y, item));

    // 電気の届いているマス（薄い黄色。強いほど濃い）
    if (sim && this.showPower && sim.power.size) {
      ctx.fillStyle = '#facc15';
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const lv = sim.power.get(key(x, y));
          if (!(lv >= 1)) continue;
          const { px, py } = this.toScreen(x, y);
          ctx.globalAlpha = 0.06 + 0.12 * Math.min(1, lv / this.maxPower);
          ctx.fillRect(px, py, t, t);
        }
      }
      ctx.globalAlpha = 1;
    }

    // 床の層（電線）を先に、その上に設置物
    const shown = world.buildingsIn(x0, y0, x1, y1);
    for (const bld of shown) if (bld.layer === 'floor') this.drawWire(world, bld, sim);
    for (const bld of shown) {
      if (bld.layer !== 'floor') this.drawBuilding(bld, rotatedSize(bld.size, bld.dir), sim);
    }

    if (sim) this.drawItems(sim, shown, { x0, y0, x1, y1 });

    if (this.ghost) this.drawGhost(this.ghost);
    if (this.pasteGhost) this.drawPasteGhost(this.pasteGhost);
    if (this.selection) this.drawSelection(this.selection);
    if (this.hover) this.drawHover(this.hover);
  }

  /**
   * 電線: 隣の電線へ向かって線を引く。
   * 明るさはそのマスの電気の強さで変わる（Core Keeper と同じく、発電機から遠いほど暗い）。
   * 電気が届いていなければ暗い灰色。
   */
  drawWire(world, bld, sim) {
    const ctx = this.ctx, t = this.tile;
    const { px, py } = this.toScreen(bld.x, bld.y);
    const cx = px + t / 2, cy = py + t / 2;
    const lv = (sim && sim.power.get(key(bld.x, bld.y))) || 0;
    const { line, dot } = wireColors(lv, this.maxPower);
    ctx.strokeStyle = line;
    ctx.lineWidth = Math.max(2, t * 0.1);
    ctx.lineCap = 'round';
    ctx.beginPath();
    let any = false;
    for (const d of ['N', 'E', 'S', 'W']) {
      const n = world.floorAt(bld.x + DELTA[d].x, bld.y + DELTA[d].y);
      if (!n || n.type !== bld.type) continue;
      any = true;
      ctx.moveTo(cx, cy); ctx.lineTo(cx + DELTA[d].x * t / 2, cy + DELTA[d].y * t / 2);
    }
    if (!any) { ctx.moveTo(cx - t * 0.25, cy); ctx.lineTo(cx + t * 0.25, cy); }
    ctx.stroke();
    ctx.fillStyle = dot;
    ctx.beginPath(); ctx.arc(cx, cy, t * 0.1, 0, 7); ctx.fill();
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
      // スプリッターは背面にも出すので、背面にも印（横から入る）
      if (def.splitter) {
        ctx.beginPath();
        ctx.arc(px + w / 2 - d.x * w * 0.33, py + h / 2 - d.y * h * 0.33, Math.max(2, t * 0.09), 0, 7);
        ctx.fill();
      }
    }
    // 名前の頭文字（アイコンは後の段階で）
    if (t >= 18 && def.name) {
      ctx.fillStyle = '#0b0e15';
      ctx.font = `700 ${Math.round(t * 0.4)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(def.name[0], px + w / 2, py + h / 2 + 1);
    }
    // 電気が要るのに届いていない: 右上に赤い ×
    if (sim && sim.unpowered.has(bld.id)) {
      ctx.strokeStyle = '#f87171';
      ctx.lineWidth = Math.max(2, t * 0.07);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(px + w - t * 0.3, py + t * 0.1); ctx.lineTo(px + w - t * 0.1, py + t * 0.3);
      ctx.moveTo(px + w - t * 0.1, py + t * 0.1); ctx.lineTo(px + w - t * 0.3, py + t * 0.3);
      ctx.stroke();
    }
  }

  /** ベルトの上・箱の中・床のアイテムを描く。1マスにつき先頭の種類の色と合計数。shown は画面に映っている建物。 */
  drawItems(sim, shown, { x0, y0, x1, y1 }) {
    for (const b of shown) {
      const list = sim.belts.get(b.id);
      if (list && list.length) this.drawStack(b.x, b.y, list, 'belt');
      const ch = sim.containers.get(b.id);
      if (ch) {
        const items = ch.slots.filter(Boolean);
        if (items.length) this.drawStack(b.x, b.y, items, 'container');
      }
      const m = sim.machines.get(b.id);
      if (m) this.drawMachine(b, m);
      if (sim.miners.has(b.id)) this.drawMinerOutput(b);
      if (m && (machineDef(this.registry, b) || {}).outputFront) this.markCell(machineOutputCell(b), 'rgba(250,204,21,0.75)');
    }
    if (!sim.ground.size) return;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const list = sim.ground.get(key(x, y));
        if (list && list.length) this.drawStack(x, y, list, 'ground');
      }
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
    for (const c of minerTargets(b)) this.markCell(c, 'rgba(56,189,248,0.75)');
    this.markCell(minerOutput(b), 'rgba(250,204,21,0.75)');
  }

  /** マスを点線の枠で囲む（採掘機の掘る所・出し先、送り出し加工機の出し先）。 */
  markCell(c, color) {
    const ctx = this.ctx, t = this.tile;
    const { px, py } = this.toScreen(c.x, c.y);
    ctx.strokeStyle = color;
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(px + 3, py + 3, t - 6, t - 6);
    ctx.setLineDash([]);
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

  /** 設計図の下見。建物ごとに置ける（緑）・置けない（赤）。向きの印も描く。 */
  drawPasteGhost(list) {
    const ctx = this.ctx, t = this.tile;
    for (const g of list) {
      const cells = g.def ? footprint(g.x, g.y, g.def.size, g.dir) : [{ x: g.x, y: g.y }];
      this.drawGhost({ cells, ok: g.ok });
      if (g.def && g.def.directional) {
        const d = DELTA[g.dir], { px, py } = this.toScreen(g.x, g.y);
        const { width: w, height: h } = rotatedSize(g.def.size, g.dir);
        ctx.fillStyle = 'rgba(11,14,21,0.8)';
        ctx.beginPath();
        ctx.arc(px + w * t / 2 + d.x * w * t * 0.33, py + h * t / 2 + d.y * h * t * 0.33, Math.max(2, t * 0.09), 0, 7);
        ctx.fill();
      }
    }
  }

  /** 選んでいる範囲（水色の点線）。 */
  drawSelection(s) {
    const ctx = this.ctx, t = this.tile;
    const { px, py } = this.toScreen(s.x0, s.y0);
    const w = (s.x1 - s.x0 + 1) * t, h = (s.y1 - s.y0 + 1) * t;
    ctx.fillStyle = 'rgba(56,189,248,0.08)';
    ctx.fillRect(px, py, w, h);
    ctx.strokeStyle = 'rgba(56,189,248,0.95)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(px + 1, py + 1, w - 2, h - 2);
    ctx.setLineDash([]);
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

/**
 * 電線の色。強さ 0（届いていない）は暗い灰色、1 は暗い黄色、最大で明るい黄色。
 * 間は強さに比例して混ぜる。テストから呼べるように外に出してある。
 */
export function wireColors(level, max) {
  if (!(level >= 1)) return { line: '#4b5563', dot: '#6b7280' };
  const f = Math.min(1, (level - 1) / Math.max(1, max - 1));
  return { line: mix([0x6b, 0x5a, 0x12], [0xfa, 0xcc, 0x15], f), dot: mix([0x7c, 0x6a, 0x1c], [0xfe, 0xf0, 0x8a], f) };
}

function mix(a, b, f) {
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * f));
  return `#${c.map(v => v.toString(16).padStart(2, '0')).join('')}`;
}
