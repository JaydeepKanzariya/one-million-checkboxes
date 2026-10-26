import { prefersReducedMotion } from './motion.js';

const COLS = 1000;
const SIZE = 200;
const BLOCK = COLS / SIZE; // 5x5 cells per minimap pixel
const BLIP_DURATION_MS = 1500;
const MAX_BLIPS = 300;

function parseHexRgb(hex) {
  const clean = hex.trim().replace('#', '');
  const n = parseInt(clean, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export class Minimap {
  constructor(canvas, bitset, renderer, { onNavigate } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.bitset = bitset;
    this.renderer = renderer;
    this.onNavigate = onNavigate;

    this.offscreen = document.createElement('canvas');
    this.offscreen.width = SIZE;
    this.offscreen.height = SIZE;
    this.offCtx = this.offscreen.getContext('2d');
    this.imageData = this.offCtx.createImageData(SIZE, SIZE);

    this.bitmapDirty = true;
    this.lastBitmapRebuildMs = 0;
    this.bounds = { colStart: 0, rowStart: 0, colEnd: 50, rowEnd: 50 };
    this.dragging = false;

    // Ring buffer of remote activity blips: Array<{ x: number, y: number, startMs: number }>
    this.blips = [];
    this.blipRafId = null;

    this.bindEvents();
  }

  bindEvents() {
    const jumpFromEvent = (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const nx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const ny = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
      const col = Math.floor(nx * COLS);
      const row = Math.floor(ny * COLS);
      this.renderer.cancelAnimation();
      this.renderer.camX = col * this.renderer.cellSize - this.renderer.width / 2;
      this.renderer.camY = row * this.renderer.cellSize - this.renderer.height / 2;
      this.renderer.clampCamera();
      this.renderer.requestFullRedraw();
      this.onNavigate?.();
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

  addBlip(index, nowMs = performance.now()) {
    if (index < 0 || index >= 1_000_000) return;
    const row = Math.floor(index / COLS);
    const col = index % COLS;
    const x = (col / COLS) * SIZE;
    const y = (row / COLS) * SIZE;

    if (this.blips.length >= MAX_BLIPS) {
      this.blips.shift();
    }
    this.blips.push({ x, y, startMs: nowMs });
    this.scheduleBlipFrame();
  }

  scheduleBlipFrame() {
    if (this.blipRafId !== null) return;
    this.blipRafId = requestAnimationFrame((nowMs) => {
      this.blipRafId = null;
      this.drawOverlay(nowMs);
      if (this.blips.length > 0) {
        this.scheduleBlipFrame();
      }
    });
  }

  markDirty() {
    this.bitmapDirty = true;
    const now = performance.now();
    if (now - this.lastBitmapRebuildMs >= 1000) {
      this.rebuildBitmap();
      this.drawOverlay(now);
    }
  }

  forceRebuild() {
    this.rebuildBitmap();
    this.drawOverlay(performance.now());
  }

  updateViewport(bounds) {
    this.bounds = bounds;
    const now = performance.now();
    if (this.bitmapDirty && now - this.lastBitmapRebuildMs >= 1000) {
      this.rebuildBitmap();
    }
    this.drawOverlay(now);
  }

  rebuildBitmap() {
    const styles = getComputedStyle(document.documentElement);
    const paperRgb = parseHexRgb(styles.getPropertyValue('--paper').trim() || '#EDF2EA');
    const inkRgb = parseHexRgb(styles.getPropertyValue('--ink').trim() || '#1C2740');
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

  drawOverlay(nowMs = performance.now()) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.drawImage(this.offscreen, 0, 0);

    const styles = getComputedStyle(document.documentElement);
    const signal = styles.getPropertyValue('--signal').trim() || '#E0A100';
    const liveHex = styles.getPropertyValue('--live').trim() || '#2F6FD0';
    const [lr, lg, lb] = parseHexRgb(liveHex);

    // Draw fading remote activity blips (3px dots in --live fading over 1.5s)
    if (this.blips.length > 0) {
      const reduced = prefersReducedMotion();
      let writeIdx = 0;
      for (let i = 0; i < this.blips.length; i++) {
        const blip = this.blips[i];
        const age = nowMs - blip.startMs;
        if (age >= BLIP_DURATION_MS) continue;
        this.blips[writeIdx++] = blip;
        const alpha = reduced ? 0.9 : Math.max(0, 1 - age / BLIP_DURATION_MS);
        ctx.fillStyle = `rgba(${lr}, ${lg}, ${lb}, ${alpha.toFixed(3)})`;
        ctx.fillRect(Math.round(blip.x) - 1, Math.round(blip.y) - 1, 3, 3);
      }
      this.blips.length = writeIdx;
    }

    const { colStart, rowStart, colEnd, rowEnd } = this.bounds;
    const x = (colStart / COLS) * SIZE;
    const y = (rowStart / COLS) * SIZE;
    const w = Math.max(4, ((colEnd - colStart + 1) / COLS) * SIZE);
    const h = Math.max(4, ((rowEnd - rowStart + 1) / COLS) * SIZE);

    ctx.strokeStyle = signal;
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, Math.min(SIZE - 2, w), Math.min(SIZE - 2, h));
  }
}
