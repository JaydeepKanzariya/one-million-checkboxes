const COLS = 1000;
const SIZE = 200;
const BLOCK = COLS / SIZE; // 5x5 cells per minimap pixel

function parseHexRgb(hex) {
  const clean = hex.trim().replace('#', '');
  const n = parseInt(clean, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export class Minimap {
  constructor(canvas, bitset, renderer) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.bitset = bitset;
    this.renderer = renderer;

    this.offscreen = document.createElement('canvas');
    this.offscreen.width = SIZE;
    this.offscreen.height = SIZE;
    this.offCtx = this.offscreen.getContext('2d');
    this.imageData = this.offCtx.createImageData(SIZE, SIZE);

    this.bitmapDirty = true;
    this.lastBitmapRebuildMs = 0;
    this.bounds = { colStart: 0, rowStart: 0, colEnd: 50, rowEnd: 50 };
    this.dragging = false;

    this.bindEvents();
  }

  bindEvents() {
    const jumpFromEvent = (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const nx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const ny = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
      const col = Math.floor(nx * COLS);
      const row = Math.floor(ny * COLS);
      this.renderer.camX = col * this.renderer.cellSize - this.renderer.width / 2;
      this.renderer.camY = row * this.renderer.cellSize - this.renderer.height / 2;
      this.renderer.clampCamera();
      this.renderer.requestFullRedraw();
    };

    this.canvas.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.canvas.setPointerCapture(e.pointerId);
      jumpFromEvent(e);
    });

    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      jumpFromEvent(e);
    });

    const stopDrag = () => {
      this.dragging = false;
    };
    this.canvas.addEventListener('pointerup', stopDrag);
    this.canvas.addEventListener('pointercancel', stopDrag);
  }

  markDirty() {
    this.bitmapDirty = true;
    const now = performance.now();
    if (now - this.lastBitmapRebuildMs >= 1000) {
      this.rebuildBitmap();
      this.drawOverlay();
    }
  }

  forceRebuild() {
    this.rebuildBitmap();
    this.drawOverlay();
  }

  updateViewport(bounds) {
    this.bounds = bounds;
    const now = performance.now();
    if (this.bitmapDirty && now - this.lastBitmapRebuildMs >= 1000) {
      this.rebuildBitmap();
    }
    this.drawOverlay();
  }

  rebuildBitmap() {
    const styles = getComputedStyle(document.documentElement);
    const paperRgb = parseHexRgb(styles.getPropertyValue('--paper').trim() || '#EEF2F5');
    const inkRgb = parseHexRgb(styles.getPropertyValue('--ink').trim() || '#1F2E4A');
    const data = this.imageData.data;

    let ptr = 0;
    for (let my = 0; my < SIZE; my++) {
      const r0 = my * BLOCK;
      for (let mx = 0; mx < SIZE; mx++) {
        const c0 = mx * BLOCK;
        let setBits = 0;
        for (let dr = 0; dr < BLOCK; dr++) {
          const base = (r0 + dr) * COLS + c0;
          for (let dc = 0; dc < BLOCK; dc++) {
            if (this.bitset.get(base + dc)) setBits++;
          }
        }
        // Boost visibility of sparse checked cells in the 5x5 block
        const ratio = setBits === 0 ? 0 : Math.min(1, 0.35 + (setBits / 25) * 0.65);
        data[ptr] = Math.round(paperRgb[0] + (inkRgb[0] - paperRgb[0]) * ratio);
        data[ptr + 1] = Math.round(paperRgb[1] + (inkRgb[1] - paperRgb[1]) * ratio);
        data[ptr + 2] = Math.round(paperRgb[2] + (inkRgb[2] - paperRgb[2]) * ratio);
        data[ptr + 3] = 255;
        ptr += 4;
      }
    }

    this.offCtx.putImageData(this.imageData, 0, 0);
    this.bitmapDirty = false;
    this.lastBitmapRebuildMs = performance.now();
  }

  drawOverlay() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.drawImage(this.offscreen, 0, 0);

    const { colStart, rowStart, colEnd, rowEnd } = this.bounds;
    const x = (colStart / COLS) * SIZE;
    const y = (rowStart / COLS) * SIZE;
    const w = Math.max(4, ((colEnd - colStart + 1) / COLS) * SIZE);
    const h = Math.max(4, ((rowEnd - rowStart + 1) / COLS) * SIZE);

    const styles = getComputedStyle(document.documentElement);
    const signal = styles.getPropertyValue('--signal').trim() || '#E2A400';

    ctx.strokeStyle = signal;
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, Math.min(SIZE - 2, w), Math.min(SIZE - 2, h));
  }
}

