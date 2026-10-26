import { DUR, prefersReducedMotion } from './motion.js';

const COLS = 1000;
const TOTAL = 1_000_000;
const DRAG_THRESHOLD_PX = 5;
const VELOCITY_WINDOW_MS = 80;

export function attachBoardInput(
  canvas,
  renderer,
  { onToggleCell, onCellFocus, onUserInteraction, onOpenGoto, onEscape } = {},
) {
  const pointers = new Map();
  let dragStart = null;
  let isDragging = false;
  let lastPinchDist = 0;

  // Momentum tracking: recent pointer positions within last ~80ms
  const moveSamples = [];
  let momentumRafId = null;
  let vx = 0;
  let vy = 0;

  function stopMomentum() {
    if (momentumRafId !== null) {
      cancelAnimationFrame(momentumRafId);
      momentumRafId = null;
    }
    vx = 0;
    vy = 0;
  }

  function startMomentum() {
    if (prefersReducedMotion()) return;
    const now = performance.now();
    const recent = moveSamples.filter((s) => now - s.t <= VELOCITY_WINDOW_MS);
    if (recent.length < 2) return;

    const first = recent[0];
    const last = recent[recent.length - 1];
    const dt = Math.max(1, last.t - first.t);

    // Camera delta is opposite pointer movement; scale to 16ms frame
    vx = ((first.x - last.x) / dt) * 16;
    vy = ((first.y - last.y) / dt) * 16;

    if (Math.hypot(vx, vy) < 0.5) return;

    let lastFrameMs = now;
    const step = (frameMs) => {
      const elapsed = Math.min(64, Math.max(1, frameMs - lastFrameMs));
      lastFrameMs = frameMs;
      const frames = elapsed / 16;

      renderer.panBy(vx * frames, vy * frames);
      const decay = Math.pow(0.92, frames);
      vx *= decay;
      vy *= decay;

      if (Math.hypot(vx, vy) >= 0.2) {
        momentumRafId = requestAnimationFrame(step);
      } else {
        momentumRafId = null;
      }
    };

    momentumRafId = requestAnimationFrame(step);
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    stopMomentum();
    renderer.cancelAnimation();

    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 1) {
      dragStart = { x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY };
      isDragging = false;
      moveSamples.length = 0;
      moveSamples.push({ x: e.clientX, y: e.clientY, t: performance.now() });
    } else if (pointers.size === 2) {
      isDragging = true;
      moveSamples.length = 0;
      const pts = [...pointers.values()];
      lastPinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) {
      const hovered = renderer.hitTest(e.clientX, e.clientY);
      renderer.setHoveredIndex(hovered);
      if (hovered >= 0) {
        onCellFocus?.(hovered);
      }
      return;
    }

    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 2) {
      const pts = [...pointers.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const rect = canvas.getBoundingClientRect();
      const midX = (pts[0].x + pts[1].x) / 2 - rect.left;
      const midY = (pts[0].y + pts[1].y) / 2 - rect.top;

      if (lastPinchDist > 10) {
        const scale = dist / lastPinchDist;
        renderer.setZoomAt(renderer.cellSize * scale, midX, midY, {
          animate: false,
        });
        onUserInteraction?.();
      }
      lastPinchDist = dist;
      return;
    }

    if (pointers.size === 1 && dragStart) {
      const totalMoved = Math.hypot(e.clientX - dragStart.x, e.clientY - dragStart.y);
      if (!isDragging && totalMoved > DRAG_THRESHOLD_PX) {
        isDragging = true;
        canvas.classList.add('panning');
        renderer.setHoveredIndex(-1);
        onUserInteraction?.();
      }

      if (isDragging) {
        const now = performance.now();
        const dx = dragStart.lastX - e.clientX;
        const dy = dragStart.lastY - e.clientY;
        dragStart.lastX = e.clientX;
        dragStart.lastY = e.clientY;
        renderer.panBy(dx, dy);

        moveSamples.push({ x: e.clientX, y: e.clientY, t: now });
        while (moveSamples.length > 0 && now - moveSamples[0].t > VELOCITY_WINDOW_MS) {
          moveSamples.shift();
        }
      }
    }
  });

  canvas.addEventListener('pointerleave', () => {
    if (pointers.size === 0) {
      renderer.setHoveredIndex(-1);
    }
  });

  const endPointer = (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);

    if (pointers.size === 0) {
      canvas.classList.remove('panning');
      if (!isDragging && dragStart) {
        const idx = renderer.hitTest(e.clientX, e.clientY);
        if (idx >= 0) {
          onUserInteraction?.();
          renderer.setFocusedIndex(idx);
          onCellFocus?.(idx);

          // D4.6: Clicks in the overview (<4px) zoom in to 20px centered on clicked cell
          if (renderer.cellSize < 4) {
            const row = Math.floor(idx / COLS);
            const col = idx % COLS;
            renderer.animateTo(
              { cellSize: 20, centerX: col + 0.5, centerY: row + 0.5 },
              DUR.base,
            );
          } else {
            onToggleCell?.(idx);
          }
        }
      } else if (isDragging) {
        startMomentum();
      }
      dragStart = null;
      isDragging = false;
      lastPinchDist = 0;
      moveSamples.length = 0;
    }
  };

  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      stopMomentum();
      onUserInteraction?.();

      const rect = canvas.getBoundingClientRect();
      const localX = e.clientX - rect.left;
      const localY = e.clientY - rect.top;

      if (e.ctrlKey || e.metaKey) {
        const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
        const baseSize =
          renderer.camAnim?.kind === 'anchor'
            ? Math.exp(renderer.camAnim.toLogSize)
            : renderer.cellSize;
        renderer.setZoomAt(baseSize * factor, localX, localY, {
          animate: true,
          durationMs: DUR.fast,
        });
      } else {
        renderer.cancelAnimation();
        renderer.panBy(e.deltaX, e.deltaY);
      }
    },
    { passive: false },
  );

  // Global keyboard handler for '/' and 'Escape'
  window.addEventListener('keydown', (e) => {
    const tag = document.activeElement?.tagName;
    const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable;

    if (e.key === 'Escape') {
      onEscape?.();
      return;
    }

    if (!isInput && e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      onOpenGoto?.();
    }
  });

  canvas.addEventListener('keydown', (e) => {
    stopMomentum();
    let next = renderer.focusedIndex;

    switch (e.key) {
      case 'ArrowRight':
        next = Math.min(TOTAL - 1, next + 1);
        break;
      case 'ArrowLeft':
        next = Math.max(0, next - 1);
        break;
      case 'ArrowDown':
        next = Math.min(TOTAL - 1, next + COLS);
        break;
      case 'ArrowUp':
        next = Math.max(0, next - COLS);
        break;
      case 'PageDown':
        next = Math.min(TOTAL - 1, next + COLS * 20);
        break;
      case 'PageUp':
        next = Math.max(0, next - COLS * 20);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = TOTAL - 1;
        break;
      case ' ':
      case 'Enter':
        e.preventDefault();
        onUserInteraction?.();
        if (renderer.cellSize < 4) {
          const row = Math.floor(renderer.focusedIndex / COLS);
          const col = renderer.focusedIndex % COLS;
          renderer.animateTo({ cellSize: 20, centerX: col + 0.5, centerY: row + 0.5 }, DUR.base);
        } else {
          onToggleCell?.(renderer.focusedIndex);
        }
        return;
      case '0':
        e.preventDefault();
        onUserInteraction?.();
        renderer.fitToScreen({ animate: true });
        return;
      case '+':
      case '=': {
        e.preventDefault();
        onUserInteraction?.();
        const step = renderer.cellSize < 4 ? 2 : 4;
        renderer.setZoomAt(renderer.cellSize + step, renderer.width / 2, renderer.height / 2, {
          animate: true,
          durationMs: DUR.fast,
        });
        return;
      }
      case '-':
      case '_': {
        e.preventDefault();
        onUserInteraction?.();
        const step = renderer.cellSize <= 4 ? 1.5 : 4;
        renderer.setZoomAt(renderer.cellSize - step, renderer.width / 2, renderer.height / 2, {
          animate: true,
          durationMs: DUR.fast,
        });
        return;
      }
      default:
        return;
    }

    e.preventDefault();
    onUserInteraction?.();
    renderer.setFocusedIndex(next);
    renderer.ensureIndexVisible(next);
    onCellFocus?.(next);
  });
}
