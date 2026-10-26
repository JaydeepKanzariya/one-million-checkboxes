const COLS = 1000;
const TOTAL = 1_000_000;
const DRAG_THRESHOLD_PX = 5;

export function attachBoardInput(canvas, renderer, { onToggleCell, onCellFocus } = {}) {
  const pointers = new Map();
  let dragStart = null;
  let isDragging = false;
  let lastPinchDist = 0;

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 1) {
      dragStart = { x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY };
      isDragging = false;
    } else if (pointers.size === 2) {
      isDragging = true;
      const pts = [...pointers.values()];
      lastPinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) {
      const hovered = renderer.hitTest(e.clientX, e.clientY);
      if (hovered >= 0 && hovered !== renderer.hoveredIndex) {
        renderer.hoveredIndex = hovered;
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
        renderer.setZoomAt(renderer.cellSize * scale, midX, midY);
      }
      lastPinchDist = dist;
      return;
    }

    if (pointers.size === 1 && dragStart) {
      const totalMoved = Math.hypot(e.clientX - dragStart.x, e.clientY - dragStart.y);
      if (!isDragging && totalMoved > DRAG_THRESHOLD_PX) {
        isDragging = true;
        canvas.classList.add('panning');
      }

      if (isDragging) {
        const dx = dragStart.lastX - e.clientX;
        const dy = dragStart.lastY - e.clientY;
        dragStart.lastX = e.clientX;
        dragStart.lastY = e.clientY;
        renderer.panBy(dx, dy);
      }
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
          renderer.setFocusedIndex(idx);
          onCellFocus?.(idx);
          onToggleCell?.(idx);
        }
      }
      dragStart = null;
      isDragging = false;
      lastPinchDist = 0;
    }
  };

  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const localX = e.clientX - rect.left;
      const localY = e.clientY - rect.top;

      if (e.ctrlKey || e.metaKey) {
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        renderer.setZoomAt(renderer.cellSize * factor, localX, localY);
      } else {
        renderer.panBy(e.deltaX, e.deltaY);
      }
    },
    { passive: false },
  );

  canvas.addEventListener('keydown', (e) => {
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
        onToggleCell?.(renderer.focusedIndex);
        return;
      case '+':
      case '=':
        e.preventDefault();
        renderer.setZoomAt(renderer.cellSize + 4);
        return;
      case '-':
      case '_':
        e.preventDefault();
        renderer.setZoomAt(renderer.cellSize - 4);
        return;
      default:
        return;
    }

    e.preventDefault();
    renderer.setFocusedIndex(next);
    renderer.ensureIndexVisible(next);
    onCellFocus?.(next);
  });
}

