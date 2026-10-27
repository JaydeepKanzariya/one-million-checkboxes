import { DUR, easeInOut, easeOut, prefersReducedMotion } from './motion.js';

const COLS = 1000;
const ROWS = 1000;
const TOTAL = COLS * ROWS;

const GUTTER_LEFT_PX = 44;
const DESK_PAD_PX = 20;

const LIVE_PULSE_MS = 800;
const OWN_PULSE_MS = 500;

// Own-click press: share of the pulse spent dipping before springing back.
const PRESS_DOWN = 0.3;
// The check mark's short stroke is ~0.28 of the box and the long one ~0.56, so it is ~1/3 of the path.
const CHECK_SHORT_STROKE = 0.335;

function parseHexRgb(hex) {
  const clean = hex.trim().replace('#', '');
  const n = parseInt(clean, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function lerpColor(rgbA, rgbB, t) {
  const r = Math.round(rgbA[0] + (rgbB[0] - rgbA[0]) * t);
  const g = Math.round(rgbA[1] + (rgbB[1] - rgbA[1]) * t);
  const b = Math.round(rgbA[2] + (rgbB[2] - rgbA[2]) * t);
  return `rgb(${r}, ${g}, ${b})`;
}

function roundedBoxPath(ctx, x, y, w, h, radius) {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function' && radius > 0) {
    ctx.roundRect(x, y, w, h, radius);
  } else {
    ctx.rect(x, y, w, h);
  }
}

export class BoardRenderer {
  constructor(canvas, bitset, { onViewportChange } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.bitset = bitset;
    this.onViewportChange = onViewportChange;

    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = 1;
    this.height = 1;

    this.defaultCellSize = window.innerWidth <= 640 ? 24 : 20;
    this.fitCellSize = 0.5;
    this.minCellSize = 0.5;
    this.maxCellSize = 36;
    this.cellSize = this.defaultCellSize;
    this.camX = -GUTTER_LEFT_PX;
    this.camY = -DESK_PAD_PX;

    this.focusedIndex = 0;
    this.hoveredIndex = -1;

    this.fullDirty = true;
    this.dirtyCells = new Set();
    // Map<index, { kind: 'live'|'own', startMs: number }>
    this.pulses = new Map();
    this.rafId = null;

    // Active camera animation state
    this.camAnim = null;

    // Offscreen 1000x1000 bitmap for <4px overview mode
    this.overviewCanvas = document.createElement('canvas');
    this.overviewCanvas.width = COLS;
    this.overviewCanvas.height = ROWS;
    this.overviewCtx = this.overviewCanvas.getContext('2d');
    this.overviewImage = this.overviewCtx.createImageData(COLS, ROWS);
    this.overviewDirty = true;

    this.palette = this.readThemePalette();
  }

  readThemePalette() {
    const styles = getComputedStyle(document.documentElement);
    const desk = styles.getPropertyValue('--desk').trim() || '#DCE5D7';
    const paper = styles.getPropertyValue('--paper').trim() || '#EDF2EA';
    const paperElevated = styles.getPropertyValue('--paper-elevated').trim() || '#F6F9F4';
    const paperSubtle = styles.getPropertyValue('--paper-subtle').trim() || '#E2EADE';
    const rule = styles.getPropertyValue('--rule').trim() || '#C9D8C4';
    const ruleStrong = styles.getPropertyValue('--rule-strong').trim() || '#A9BFA3';
    const box = styles.getPropertyValue('--box').trim() || '#6F8C78';
    // Checked boxes use --cell-on when a theme separates it from text ink (e.g. a neon accent).
    const ink =
      styles.getPropertyValue('--cell-on').trim() || styles.getPropertyValue('--ink').trim() || '#1C2740';
    // Optional halo drawn behind lit boxes; empty means no glow.
    const glow = styles.getPropertyValue('--glow').trim() || null;
    const inkMuted = styles.getPropertyValue('--ink-muted').trim() || '#4F5F55';
    const inkOnFill = styles.getPropertyValue('--ink-on-fill').trim() || '#F6F9F4';
    const margin = styles.getPropertyValue('--margin').trim() || '#C0392B';
    const signal = styles.getPropertyValue('--signal').trim() || '#E0A100';
    const live = styles.getPropertyValue('--live').trim() || '#2F6FD0';

    const paperRgb = parseHexRgb(paper);
    const isDark = paperRgb[0] + paperRgb[1] + paperRgb[2] < 380;

    return {
      desk,
      paper,
      paperElevated,
      paperSubtle,
      rule,
      ruleStrong,
      box,
      ink,
      inkMuted,
      inkOnFill,
      margin,
      signal,
      live,
      glow,
      isDark,
      shadowColor: isDark ? 'rgba(0, 0, 0, 0.5)' : 'rgba(0, 0, 0, 0.12)',
      paperRgb,
      inkRgb: parseHexRgb(ink),
      liveRgb: parseHexRgb(live),
      signalRgb: parseHexRgb(signal),
    };
  }

  refreshTheme({ immediate = false } = {}) {
    this.palette = this.readThemePalette();
    this.overviewDirty = true;
    this.requestFullRedraw();
    if (immediate) {
      // Paint now instead of next frame, so a theme cross-fade captures the new colors.
      if (this.rafId !== null) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
      this.render(performance.now());
    }
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = Math.max(1, Math.floor(rect.width));
    this.height = Math.max(1, Math.floor(rect.height));
    this.canvas.width = Math.floor(this.width * this.dpr);
    this.canvas.height = Math.floor(this.height * this.dpr);

    this.fitCellSize = Math.max(0.15, Math.min(this.width - 88, this.height - 48) / COLS);
    this.minCellSize = this.fitCellSize;
    if (this.cellSize < this.minCellSize) {
      this.cellSize = this.minCellSize;
    }

    this.clampCamera();
    this.requestFullRedraw();
  }

  clampCamera() {
    const worldW = COLS * this.cellSize;
    const worldH = ROWS * this.cellSize;
    const minX = -GUTTER_LEFT_PX;
    const maxX = worldW - this.width + DESK_PAD_PX;

    if (worldW + GUTTER_LEFT_PX + DESK_PAD_PX <= this.width) {
      this.camX = -((this.width - worldW - GUTTER_LEFT_PX + DESK_PAD_PX) / 2 + GUTTER_LEFT_PX);
    } else {
      this.camX = Math.max(minX, Math.min(maxX, this.camX));
    }

    const minY = -DESK_PAD_PX;
    const maxY = worldH - this.height + DESK_PAD_PX;
    if (worldH + DESK_PAD_PX * 2 <= this.height) {
      this.camY = -(this.height - worldH) / 2;
    } else {
      this.camY = Math.max(minY, Math.min(maxY, this.camY));
    }
  }

  cancelAnimation() {
    this.camAnim = null;
  }

  panBy(dx, dy) {
    this.camX += dx;
    this.camY += dy;
    this.clampCamera();
    this.requestFullRedraw();
  }

  getViewportCenterCell() {
    return {
      centerX: (this.camX + this.width / 2) / this.cellSize,
      centerY: (this.camY + this.height / 2) / this.cellSize,
    };
  }

  applyCameraForCenter(cellSize, centerX, centerY) {
    this.cellSize = Math.max(this.minCellSize, Math.min(this.maxCellSize, cellSize));
    this.camX = centerX * this.cellSize - this.width / 2;
    this.camY = centerY * this.cellSize - this.height / 2;
    this.clampCamera();
  }

  animateTo(
    { cellSize = this.cellSize, centerX, centerY } = {},
    durationMs = DUR.base,
  ) {
    const targetSize = Math.max(this.minCellSize, Math.min(this.maxCellSize, cellSize));
    const curCenter = this.getViewportCenterCell();
    const toCenterX = centerX !== undefined ? centerX : curCenter.centerX;
    const toCenterY = centerY !== undefined ? centerY : curCenter.centerY;

    if (prefersReducedMotion() || durationMs <= 0) {
      this.cancelAnimation();
      this.applyCameraForCenter(targetSize, toCenterX, toCenterY);
      this.requestFullRedraw();
      return;
    }

    this.camAnim = {
      kind: 'center',
      startMs: performance.now(),
      durationMs,
      fromLogSize: Math.log(this.cellSize),
      toLogSize: Math.log(targetSize),
      fromCenterX: curCenter.centerX,
      fromCenterY: curCenter.centerY,
      toCenterX,
      toCenterY,
    };
    this.scheduleFrame();
  }

  fitToScreen({ animate = true } = {}) {
    if (!animate || prefersReducedMotion()) {
      this.cancelAnimation();
      this.applyCameraForCenter(this.fitCellSize, COLS / 2, ROWS / 2);
      this.requestFullRedraw();
      return;
    }
    this.animateTo(
      { cellSize: this.fitCellSize, centerX: COLS / 2, centerY: ROWS / 2 },
      DUR.base,
    );
  }

  setZoomAt(
    newCellSize,
    screenX = this.width / 2,
    screenY = this.height / 2,
    { animate = false, durationMs = DUR.fast } = {},
  ) {
    const clamped = Math.max(this.minCellSize, Math.min(this.maxCellSize, newCellSize));
    if (Math.abs(clamped - this.cellSize) < 0.005 && !this.camAnim) return;

    const worldCol = (this.camX + screenX) / this.cellSize;
    const worldRow = (this.camY + screenY) / this.cellSize;

    if (!animate || prefersReducedMotion() || durationMs <= 0) {
      this.cancelAnimation();
      this.cellSize = clamped;
      this.camX = worldCol * this.cellSize - screenX;
      this.camY = worldRow * this.cellSize - screenY;
      this.clampCamera();
      this.requestFullRedraw();
      return;
    }

    const baseTarget = this.camAnim?.kind === 'anchor' ? Math.exp(this.camAnim.toLogSize) : this.cellSize;
    const target = Math.max(
      this.minCellSize,
      Math.min(this.maxCellSize, newCellSize),
    );
    void baseTarget;

    this.camAnim = {
      kind: 'anchor',
      startMs: performance.now(),
      durationMs,
      fromLogSize: Math.log(this.cellSize),
      toLogSize: Math.log(target),
      worldCol,
      worldRow,
      screenX,
      screenY,
    };
    this.scheduleFrame();
  }

  centerOnIndex(index, { focus = true, pulse = false, animate = true, durationMs = DUR.base } = {}) {
    const safeIdx = Math.max(0, Math.min(TOTAL - 1, Math.floor(index)));
    const row = Math.floor(safeIdx / COLS);
    const col = safeIdx % COLS;
    const targetCellSize = this.cellSize < 16 ? this.defaultCellSize : this.cellSize;

    if (focus) {
      this.focusedIndex = safeIdx;
    }
    if (pulse && !prefersReducedMotion()) {
      this.markCellUpdated(safeIdx, 'own');
    }

    if (animate && !prefersReducedMotion() && durationMs > 0) {
      this.animateTo(
        {
          cellSize: targetCellSize,
          centerX: col + 0.5,
          centerY: row + 0.5,
        },
        durationMs,
      );
    } else {
      this.cancelAnimation();
      this.applyCameraForCenter(targetCellSize, col + 0.5, row + 0.5);
      this.requestFullRedraw();
    }
  }

  ensureIndexVisible(index) {
    this.cancelAnimation();
    const row = Math.floor(index / COLS);
    const col = index % COLS;
    const x = col * this.cellSize;
    const y = row * this.cellSize;
    const margin = this.cellSize * 2;

    if (x < this.camX + margin) this.camX = x - margin;
    else if (x + this.cellSize > this.camX + this.width - margin) {
      this.camX = x + this.cellSize - this.width + margin;
    }

    if (y < this.camY + margin) this.camY = y - margin;
    else if (y + this.cellSize > this.camY + this.height - margin) {
      this.camY = y + this.cellSize - this.height + margin;
    }

    this.clampCamera();
    this.requestFullRedraw();
  }

  hitTest(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left + this.camX;
    const y = clientY - rect.top + this.camY;
    const col = Math.floor(x / this.cellSize);
    const row = Math.floor(y / this.cellSize);
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) {
      return -1;
    }
    return row * COLS + col;
  }

  getVisibleBounds() {
    const colStart = Math.max(0, Math.floor(this.camX / this.cellSize));
    const rowStart = Math.max(0, Math.floor(this.camY / this.cellSize));
    const colEnd = Math.min(COLS - 1, Math.floor((this.camX + this.width - 1) / this.cellSize));
    const rowEnd = Math.min(ROWS - 1, Math.floor((this.camY + this.height - 1) / this.cellSize));
    const firstIndex = rowStart * COLS + colStart;
    const lastIndex = rowEnd * COLS + colEnd;
    return { colStart, rowStart, colEnd, rowEnd, firstIndex, lastIndex };
  }

  markSnapshotLoaded() {
    this.overviewDirty = true;
    this.requestFullRedraw();
  }

  markCellUpdated(index, kind = 'live') {
    this.updateOverviewPixel(index);
    if (!prefersReducedMotion() && kind) {
      this.pulses.set(index, { kind, startMs: performance.now() });
    }
    this.dirtyCells.add(index);
    this.scheduleFrame();
  }

  setFocusedIndex(index) {
    const prev = this.focusedIndex;
    this.focusedIndex = Math.max(0, Math.min(TOTAL - 1, index));
    if (prev !== this.focusedIndex) {
      this.dirtyCells.add(prev);
      this.dirtyCells.add(this.focusedIndex);
      this.scheduleFrame();
    }
  }

  setHoveredIndex(index) {
    const next = index >= 0 && index < TOTAL ? index : -1;
    if (next === this.hoveredIndex) return;
    const prev = this.hoveredIndex;
    this.hoveredIndex = next;
    if (prev >= 0) this.dirtyCells.add(prev);
    if (next >= 0) this.dirtyCells.add(next);
    this.scheduleFrame();
  }

  requestFullRedraw() {
    this.fullDirty = true;
    this.scheduleFrame();
  }

  scheduleFrame() {
    if (this.rafId !== null) return;
    this.rafId = requestAnimationFrame((nowMs) => {
      this.rafId = null;
      this.render(nowMs);
    });
  }

  stepCameraAnimation(nowMs) {
    if (!this.camAnim) return;
    const anim = this.camAnim;
    const rawT = (nowMs - anim.startMs) / anim.durationMs;
    const done = rawT >= 1;
    const t = anim.kind === 'anchor' ? easeOut(rawT) : easeInOut(rawT);

    const logSize = anim.fromLogSize + (anim.toLogSize - anim.fromLogSize) * t;
    const nextSize = Math.exp(logSize);

    if (anim.kind === 'anchor') {
      this.cellSize = nextSize;
      this.camX = anim.worldCol * this.cellSize - anim.screenX;
      this.camY = anim.worldRow * this.cellSize - anim.screenY;
      this.clampCamera();
    } else {
      const cx = anim.fromCenterX + (anim.toCenterX - anim.fromCenterX) * t;
      const cy = anim.fromCenterY + (anim.toCenterY - anim.fromCenterY) * t;
      this.applyCameraForCenter(nextSize, cx, cy);
    }

    if (done) {
      if (this.cellSize >= 4) {
        this.cellSize = Math.round(this.cellSize * 100) / 100;
      }
      this.camAnim = null;
    }
    this.fullDirty = true;
  }

  rebuildOverviewImage() {
    const data = this.overviewImage.data;
    const [pr, pg, pb] = this.palette.paperRgb;
    const [ir, ig, ib] = this.palette.inkRgb;
    const bytes = this.bitset.bytes;

    let p = 0;
    for (let byteIdx = 0; byteIdx < bytes.length; byteIdx++) {
      const b = bytes[byteIdx];
      for (let bit = 7; bit >= 0; bit--) {
        const checked = (b >> bit) & 1;
        if (checked) {
          data[p] = ir;
          data[p + 1] = ig;
          data[p + 2] = ib;
          data[p + 3] = 255;
        } else {
          data[p] = pr;
          data[p + 1] = pg;
          data[p + 2] = pb;
          data[p + 3] = 255;
        }
        p += 4;
      }
    }
    this.overviewCtx.putImageData(this.overviewImage, 0, 0);
    this.overviewDirty = false;
  }

  updateOverviewPixel(index) {
    if (this.overviewDirty || index < 0 || index >= TOTAL) return;
    const checked = this.bitset.get(index);
    const [r, g, b] = checked ? this.palette.inkRgb : this.palette.paperRgb;
    const p = index * 4;
    const data = this.overviewImage.data;
    data[p] = r;
    data[p + 1] = g;
    data[p + 2] = b;
    data[p + 3] = 255;
    const row = Math.floor(index / COLS);
    const col = index % COLS;
    this.overviewCtx.putImageData(this.overviewImage, 0, 0, col, row, 1, 1);
  }

  render(nowMs = performance.now()) {
    if (this.camAnim) {
      this.stepCameraAnimation(nowMs);
    }

    const ctx = this.ctx;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);

    const bounds = this.getVisibleBounds();

    if (this.cellSize < 4) {
      this.renderOverviewMode(ctx);
      this.fullDirty = false;
      this.dirtyCells.clear();
    } else if (this.fullDirty) {
      this.renderFullViewport(ctx, bounds, nowMs);
      this.fullDirty = false;
      this.dirtyCells.clear();
    } else {
      for (const idx of this.pulses.keys()) {
        this.dirtyCells.add(idx);
      }
      for (const idx of this.dirtyCells) {
        const row = Math.floor(idx / COLS);
        const col = idx % COLS;
        if (
          col >= bounds.colStart &&
          col <= bounds.colEnd &&
          row >= bounds.rowStart &&
          row <= bounds.rowEnd
        ) {
          this.drawSingleCell(ctx, row, col, idx, nowMs);
        }
      }
      this.dirtyCells.clear();
    }

    ctx.restore();

    if (this.onViewportChange) {
      this.onViewportChange(bounds, this.cellSize);
    }

    if (this.pulses.size > 0 || this.camAnim) {
      this.scheduleFrame();
    }
  }

  drawDeskAndSheet(ctx) {
    const cs = this.cellSize;
    const sheetX = -this.camX;
    const sheetY = -this.camY;
    const sheetW = COLS * cs;
    const sheetH = ROWS * cs;

    // 1. Desk surface outside the sheet
    ctx.fillStyle = this.palette.desk;
    ctx.fillRect(0, 0, this.width, this.height);

    // 2. Physical paper sheet with soft drop shadow
    ctx.save();
    ctx.shadowColor = this.palette.shadowColor;
    ctx.shadowBlur = 24;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 4;
    ctx.fillStyle = this.palette.paper;
    ctx.fillRect(
      Math.max(-30, sheetX),
      Math.max(-30, sheetY),
      Math.min(this.width + 60, sheetW),
      Math.min(this.height + 60, sheetH),
    );
    ctx.restore();

    // 3. Red double margin line: two 1px --margin lines, 3px apart, 6px left of sheet's left edge
    const line1X = Math.floor(sheetX - 6) + 0.5;
    const line2X = Math.floor(sheetX - 9) + 0.5;
    const topY = Math.max(0, sheetY);
    const botY = Math.min(this.height, sheetY + sheetH);

    if (line1X >= -10 && line2X <= this.width + 10 && botY > topY) {
      ctx.strokeStyle = this.palette.margin;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(line1X, topY);
      ctx.lineTo(line1X, botY);
      ctx.moveTo(line2X, topY);
      ctx.lineTo(line2X, botY);
      ctx.stroke();
    }
  }

  drawRowNumbers(ctx, bounds) {
    const cs = this.cellSize;
    if (cs < 4) return;

    const sheetX = -this.camX;
    const labelX = Math.floor(sheetX - 13);
    if (labelX < 4 || labelX > this.width + 40) return;

    const step = cs >= 16 ? 1 : 10;
    const startRow = Math.ceil(bounds.rowStart / step) * step;

    ctx.fillStyle = this.palette.inkMuted;
    ctx.font = '400 11px "JetBrains Mono", ui-monospace, Menlo, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    for (let r = startRow; r <= bounds.rowEnd; r += step) {
      const centerY = (r + 0.5) * cs - this.camY;
      if (centerY >= -10 && centerY <= this.height + 10) {
        ctx.fillText(String(r), labelX, centerY);
      }
    }
  }

  renderOverviewMode(ctx) {
    if (this.overviewDirty) {
      this.rebuildOverviewImage();
    }
    this.drawDeskAndSheet(ctx);

    ctx.imageSmoothingEnabled = false;
    const destX = -this.camX;
    const destY = -this.camY;
    const destW = COLS * this.cellSize;
    const destH = ROWS * this.cellSize;
    ctx.drawImage(this.overviewCanvas, destX, destY, destW, destH);
  }

  renderFullViewport(ctx, bounds, nowMs) {
    const cs = this.cellSize;
    this.drawDeskAndSheet(ctx);

    const sheetLeft = Math.max(0, -this.camX);
    const sheetRight = Math.min(this.width, COLS * cs - this.camX);
    const sheetTop = Math.max(0, -this.camY);
    const sheetBottom = Math.min(this.height, ROWS * cs - this.camY);

    // Ledger rules (only when cellSize >= 8):
    // - Horizontal rules on every row in --rule, and every 10th row in --rule-strong
    // - Faint vertical rule only every 10 columns in --rule
    if (cs >= 8) {
      ctx.lineWidth = 1;

      // Normal horizontal rules + 10th-column vertical rules in --rule
      ctx.strokeStyle = this.palette.rule;
      ctx.beginPath();
      for (let r = bounds.rowStart; r <= bounds.rowEnd + 1; r++) {
        if (r % 10 === 0) continue;
        const y = Math.floor(r * cs - this.camY) + 0.5;
        ctx.moveTo(sheetLeft, y);
        ctx.lineTo(sheetRight, y);
      }
      const firstTenthCol = Math.ceil(bounds.colStart / 10) * 10;
      for (let c = firstTenthCol; c <= bounds.colEnd + 1; c += 10) {
        const x = Math.floor(c * cs - this.camX) + 0.5;
        ctx.moveTo(x, sheetTop);
        ctx.lineTo(x, sheetBottom);
      }
      ctx.stroke();

      // Every 10th horizontal rule in --rule-strong
      ctx.strokeStyle = this.palette.ruleStrong;
      ctx.beginPath();
      const firstTenthRow = Math.ceil(bounds.rowStart / 10) * 10;
      for (let r = firstTenthRow; r <= bounds.rowEnd + 1; r += 10) {
        const y = Math.floor(r * cs - this.camY) + 0.5;
        ctx.moveTo(sheetLeft, y);
        ctx.lineTo(sheetRight, y);
      }
      ctx.stroke();
    }

    // Draw visible cells
    for (let r = bounds.rowStart; r <= bounds.rowEnd; r++) {
      const rowOffset = r * COLS;
      for (let c = bounds.colStart; c <= bounds.colEnd; c++) {
        const idx = rowOffset + c;
        const checked = this.bitset.get(idx);
        const hasPulse = this.pulses.has(idx);
        const isFocused = idx === this.focusedIndex;
        const isHovered = idx === this.hoveredIndex;

        if (cs >= 16 || checked || hasPulse || isFocused || isHovered) {
          this.drawCellInterior(ctx, r, c, idx, checked, nowMs);
        }
      }
    }

    this.drawRowNumbers(ctx, bounds);
  }

  drawSingleCell(ctx, row, col, idx, nowMs) {
    const cs = this.cellSize;
    const x = Math.floor(col * cs - this.camX);
    const y = Math.floor(row * cs - this.camY);
    const w = Math.ceil(cs);
    const h = Math.ceil(cs);

    ctx.fillStyle = this.palette.paper;
    ctx.fillRect(x, y, w, h);

    if (cs >= 8) {
      // Restore top and bottom horizontal ledger rules for this cell
      ctx.lineWidth = 1;
      ctx.strokeStyle = row % 10 === 0 ? this.palette.ruleStrong : this.palette.rule;
      ctx.beginPath();
      ctx.moveTo(x, Math.floor(row * cs - this.camY) + 0.5);
      ctx.lineTo(x + w, Math.floor(row * cs - this.camY) + 0.5);
      ctx.stroke();

      const nextRow = row + 1;
      ctx.strokeStyle = nextRow % 10 === 0 ? this.palette.ruleStrong : this.palette.rule;
      ctx.beginPath();
      ctx.moveTo(x, Math.floor(nextRow * cs - this.camY) + 0.5);
      ctx.lineTo(x + w, Math.floor(nextRow * cs - this.camY) + 0.5);
      ctx.stroke();

      if (col % 10 === 0) {
        ctx.strokeStyle = this.palette.rule;
        ctx.beginPath();
        ctx.moveTo(Math.floor(col * cs - this.camX) + 0.5, y);
        ctx.lineTo(Math.floor(col * cs - this.camX) + 0.5, y + h);
        ctx.stroke();
      }
    }

    const checked = this.bitset.get(idx);
    this.drawCellInterior(ctx, row, col, idx, checked, nowMs);
  }

  drawCellInterior(ctx, row, col, idx, checked, nowMs) {
    const cs = this.cellSize;
    const x = Math.floor(col * cs - this.camX);
    const y = Math.floor(row * cs - this.camY);

    if (idx === this.hoveredIndex) {
      ctx.fillStyle = this.palette.paperSubtle;
      ctx.fillRect(x + 1, y + 1, Math.max(1, Math.floor(cs) - 1), Math.max(1, Math.floor(cs) - 1));
    }

    let fillColor = checked ? this.palette.ink : null;
    let ownT = -1; // progress of your own click's press animation, or -1
    const pulse = this.pulses.get(idx);
    if (pulse) {
      const duration = pulse.kind === 'own' ? OWN_PULSE_MS : LIVE_PULSE_MS;
      const t = (nowMs - pulse.startMs) / duration;
      if (t >= 1 || prefersReducedMotion()) {
        this.pulses.delete(idx);
      } else {
        const startRgb = pulse.kind === 'own' ? this.palette.signalRgb : this.palette.liveRgb;
        const endRgb = checked ? this.palette.inkRgb : this.palette.paperRgb;
        fillColor = lerpColor(startRgb, endRgb, t);
        if (pulse.kind === 'own') ownT = t;
      }
    }

    if (cs < 16) {
      if (fillColor) {
        const pad = cs >= 8 ? 1 : 0;
        ctx.fillStyle = fillColor;
        ctx.fillRect(
          x + pad,
          y + pad,
          Math.max(1, Math.floor(cs) - pad * 2),
          Math.max(1, Math.floor(cs) - pad * 2),
        );
      }
    } else {
      // D3: Inset box is 62% of the cell: pad = Math.round(cs * 0.19)
      const pad = Math.round(cs * 0.19);
      const baseS = Math.max(4, Math.round(cs) - pad * 2);
      // Your own click: the box dips to 88% then springs back, like a key press.
      const press = ownT < 0 ? 1 : ownT < PRESS_DOWN ? 1 - 0.12 * (ownT / PRESS_DOWN) : 0.88 + 0.12 * easeOut((ownT - PRESS_DOWN) / (1 - PRESS_DOWN));
      const boxS = Math.max(4, Math.round(baseS * press));
      const boxX = x + pad + (baseS - boxS) / 2;
      const boxY = y + pad + (baseS - boxS) / 2;
      const radius = Math.min(3, cs * 0.12);

      if (fillColor) {
        if (this.palette.glow) {
          // Two translucent rings stay inside the cell padding, so dirty-cell redraws clear them.
          const g = Math.min(pad - 1, Math.max(2, Math.round(cs * 0.08)));
          ctx.fillStyle = this.palette.glow;
          roundedBoxPath(ctx, boxX - g, boxY - g, boxS + g * 2, boxS + g * 2, radius + g);
          ctx.fill();
          roundedBoxPath(ctx, boxX - g / 2, boxY - g / 2, boxS + g, boxS + g, radius + g / 2);
          ctx.fill();
        }
        ctx.fillStyle = fillColor;
        roundedBoxPath(ctx, boxX, boxY, boxS, boxS, radius);
        ctx.fill();
      } else {
        ctx.fillStyle = this.palette.paperElevated;
        roundedBoxPath(ctx, boxX, boxY, boxS, boxS, radius);
        ctx.fill();

        ctx.strokeStyle = this.palette.box;
        ctx.lineWidth = 1;
        roundedBoxPath(ctx, boxX + 0.5, boxY + 0.5, boxS - 1, boxS - 1, radius);
        ctx.stroke();
      }

      if (checked) {
        ctx.strokeStyle = this.palette.inkOnFill;
        ctx.lineWidth = Math.max(1.5, cs * 0.085);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        // Your own check mark draws itself in, short stroke first, over the first 60% of the pulse.
        const drawn = ownT < 0 ? 1 : easeOut(Math.min(1, ownT / 0.6));
        const p0x = boxX + boxS * 0.23, p0y = boxY + boxS * 0.52;
        const p1x = boxX + boxS * 0.43, p1y = boxY + boxS * 0.72;
        const p2x = boxX + boxS * 0.78, p2y = boxY + boxS * 0.28;
        const split = CHECK_SHORT_STROKE; // share of the total path length taken by the short stroke
        ctx.beginPath();
        ctx.moveTo(p0x, p0y);
        if (drawn <= split) {
          const k = drawn / split;
          ctx.lineTo(p0x + (p1x - p0x) * k, p0y + (p1y - p0y) * k);
        } else {
          const k = (drawn - split) / (1 - split);
          ctx.lineTo(p1x, p1y);
          ctx.lineTo(p1x + (p2x - p1x) * k, p1y + (p2y - p1y) * k);
        }
        ctx.stroke();
      }
    }

    if (idx === this.focusedIndex && cs >= 4) {
      ctx.strokeStyle = this.palette.signal;
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 1.5, y + 1.5, Math.round(cs) - 3, Math.round(cs) - 3);
    }
  }
}
