const COLS = 1000;
const ROWS = 1000;
const TOTAL = COLS * ROWS;

const LIVE_PULSE_MS = 800;
const OWN_PULSE_MS = 500;

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

export class BoardRenderer {
  constructor(canvas, bitset, { onViewportChange } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.bitset = bitset;
    this.onViewportChange = onViewportChange;

    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = 1;
    this.height = 1;

    // Camera state: top-left world coordinate in pixels, and cell size in CSS px
    this.cellSize = window.innerWidth <= 640 ? 24 : 20;
    this.minCellSize = 1;
    this.maxCellSize = 36;
    this.camX = 0;
    this.camY = 0;

    this.focusedIndex = 0;
    this.hoveredIndex = -1;

    this.fullDirty = true;
    this.dirtyCells = new Set();
    // Map<index, { kind: 'live'|'own', startMs: number }>
    this.pulses = new Map();
    this.rafId = null;

    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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
    const paper = styles.getPropertyValue('--paper').trim() || '#EEF2F5';
    const paperElevated = styles.getPropertyValue('--paper-elevated').trim() || '#F7F9FB';
    const rule = styles.getPropertyValue('--rule').trim() || '#C9D3DC';
    const ruleStrong = styles.getPropertyValue('--rule-strong').trim() || '#AAB8C6';
    const ink = styles.getPropertyValue('--ink').trim() || '#1F2E4A';
    const inkOnFill = styles.getPropertyValue('--ink-on-fill').trim() || '#F7F9FB';
    const signal = styles.getPropertyValue('--signal').trim() || '#E2A400';
    const live = styles.getPropertyValue('--live').trim() || '#3D7DD8';

    return {
      paper,
      paperElevated,
      rule,
      ruleStrong,
      ink,
      inkOnFill,
      signal,
      live,
      paperRgb: parseHexRgb(paper),
      inkRgb: parseHexRgb(ink),
      liveRgb: parseHexRgb(live),
      signalRgb: parseHexRgb(signal),
    };
  }

  refreshTheme() {
    this.palette = this.readThemePalette();
    this.overviewDirty = true;
    this.requestFullRedraw();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = Math.max(1, Math.floor(rect.width));
    this.height = Math.max(1, Math.floor(rect.height));
    this.canvas.width = Math.floor(this.width * this.dpr);
    this.canvas.height = Math.floor(this.height * this.dpr);
    this.clampCamera();
    this.requestFullRedraw();
  }

  clampCamera() {
    const worldW = COLS * this.cellSize;
    const worldH = ROWS * this.cellSize;
    if (worldW <= this.width) {
      this.camX = -(this.width - worldW) / 2;
    } else {
      this.camX = Math.max(0, Math.min(worldW - this.width, this.camX));
    }
    if (worldH <= this.height) {
      this.camY = -(this.height - worldH) / 2;
    } else {
      this.camY = Math.max(0, Math.min(worldH - this.height, this.camY));
    }
  }

  panBy(dx, dy) {
    this.camX += dx;
    this.camY += dy;
    this.clampCamera();
    this.requestFullRedraw();
  }

  setZoomAt(newCellSize, screenX = this.width / 2, screenY = this.height / 2) {
    const clamped = Math.max(this.minCellSize, Math.min(this.maxCellSize, newCellSize));
    if (Math.abs(clamped - this.cellSize) < 0.01) return;

    const worldCol = (this.camX + screenX) / this.cellSize;
    const worldRow = (this.camY + screenY) / this.cellSize;

    this.cellSize = clamped >= 4 ? Math.round(clamped) : Number(clamped.toFixed(2));
    this.camX = worldCol * this.cellSize - screenX;
    this.camY = worldRow * this.cellSize - screenY;
    this.clampCamera();
    this.requestFullRedraw();
  }

  centerOnIndex(index, { focus = true, pulse = false } = {}) {
    const safeIdx = Math.max(0, Math.min(TOTAL - 1, Math.floor(index)));
    const row = Math.floor(safeIdx / COLS);
    const col = safeIdx % COLS;

    if (this.cellSize < 16) {
      this.cellSize = 20;
    }

    this.camX = (col + 0.5) * this.cellSize - this.width / 2;
    this.camY = (row + 0.5) * this.cellSize - this.height / 2;
    this.clampCamera();

    if (focus) {
      this.focusedIndex = safeIdx;
    }
    if (pulse) {
      this.markCellUpdated(safeIdx, 'own');
    }
    this.requestFullRedraw();
  }

  ensureIndexVisible(index) {
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
    if (!this.reducedMotion && kind) {
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
      // Redraw only dirty and pulsing cells
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

    if (this.pulses.size > 0) {
      this.scheduleFrame();
    }
  }

  renderOverviewMode(ctx) {
    if (this.overviewDirty) {
      this.rebuildOverviewImage();
    }
    ctx.fillStyle = this.palette.paper;
    ctx.fillRect(0, 0, this.width, this.height);

    ctx.imageSmoothingEnabled = false;
    const destX = -this.camX;
    const destY = -this.camY;
    const destW = COLS * this.cellSize;
    const destH = ROWS * this.cellSize;
    ctx.drawImage(this.overviewCanvas, destX, destY, destW, destH);
  }

  renderFullViewport(ctx, bounds, nowMs) {
    const cs = this.cellSize;
    const { paper, rule } = this.palette;

    ctx.fillStyle = paper;
    ctx.fillRect(0, 0, this.width, this.height);

    // Draw ruled ledger grid lines
    ctx.strokeStyle = rule;
    ctx.lineWidth = 1;
    ctx.beginPath();

    for (let c = bounds.colStart; c <= bounds.colEnd + 1; c++) {
      const x = Math.floor(c * cs - this.camX) + 0.5;
      ctx.moveTo(x, Math.max(0, bounds.rowStart * cs - this.camY));
      ctx.lineTo(x, Math.min(this.height, (bounds.rowEnd + 1) * cs - this.camY));
    }
    for (let r = bounds.rowStart; r <= bounds.rowEnd + 1; r++) {
      const y = Math.floor(r * cs - this.camY) + 0.5;
      ctx.moveTo(Math.max(0, bounds.colStart * cs - this.camX), y);
      ctx.lineTo(Math.min(this.width, (bounds.colEnd + 1) * cs - this.camX), y);
    }
    ctx.stroke();

    // Draw visible cells
    for (let r = bounds.rowStart; r <= bounds.rowEnd; r++) {
      const rowOffset = r * COLS;
      for (let c = bounds.colStart; c <= bounds.colEnd; c++) {
        const idx = rowOffset + c;
        const checked = this.bitset.get(idx);
        const hasPulse = this.pulses.has(idx);
        const isFocused = idx === this.focusedIndex;

        if (cs >= 16 || checked || hasPulse || isFocused) {
          this.drawCellInterior(ctx, r, c, idx, checked, nowMs);
        }
      }
    }
  }

  drawSingleCell(ctx, row, col, idx, nowMs) {
    const cs = this.cellSize;
    const x = Math.floor(col * cs - this.camX);
    const y = Math.floor(row * cs - this.camY);

    ctx.fillStyle = this.palette.paper;
    ctx.fillRect(x, y, cs, cs);

    ctx.strokeStyle = this.palette.rule;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, cs, cs);

    const checked = this.bitset.get(idx);
    this.drawCellInterior(ctx, row, col, idx, checked, nowMs);
  }

  drawCellInterior(ctx, row, col, idx, checked, nowMs) {
    const cs = this.cellSize;
    const x = Math.floor(col * cs - this.camX);
    const y = Math.floor(row * cs - this.camY);

    let fillColor = checked ? this.palette.ink : null;
    const pulse = this.pulses.get(idx);
    if (pulse) {
      const duration = pulse.kind === 'own' ? OWN_PULSE_MS : LIVE_PULSE_MS;
      const t = (nowMs - pulse.startMs) / duration;
      if (t >= 1) {
        this.pulses.delete(idx);
      } else {
        const startRgb = pulse.kind === 'own' ? this.palette.signalRgb : this.palette.liveRgb;
        const endRgb = checked ? this.palette.inkRgb : this.palette.paperRgb;
        fillColor = lerpColor(startRgb, endRgb, t);
      }
    }

    if (cs < 16) {
      if (fillColor) {
        ctx.fillStyle = fillColor;
        ctx.fillRect(x + 1, y + 1, Math.max(1, cs - 1), Math.max(1, cs - 1));
      }
    } else {
      const pad = Math.max(2, Math.floor(cs * 0.16));
      const boxX = x + pad;
      const boxY = y + pad;
      const boxS = cs - pad * 2;

      if (fillColor) {
        ctx.fillStyle = fillColor;
        ctx.fillRect(boxX, boxY, boxS, boxS);
      } else {
        ctx.fillStyle = this.palette.paperElevated;
        ctx.fillRect(boxX, boxY, boxS, boxS);
        ctx.strokeStyle = this.palette.ruleStrong;
        ctx.lineWidth = 1.25;
        ctx.strokeRect(boxX + 0.5, boxY + 0.5, boxS - 1, boxS - 1);
      }

      if (checked) {
        ctx.strokeStyle = this.palette.inkOnFill;
        ctx.lineWidth = Math.max(1.6, cs * 0.09);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(boxX + boxS * 0.23, boxY + boxS * 0.52);
        ctx.lineTo(boxX + boxS * 0.43, boxY + boxS * 0.72);
        ctx.lineTo(boxX + boxS * 0.78, boxY + boxS * 0.28);
        ctx.stroke();
      }
    }

    if (idx === this.focusedIndex) {
      ctx.strokeStyle = this.palette.signal;
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 1.5, y + 1.5, cs - 2, cs - 2);
    }
  }
}

