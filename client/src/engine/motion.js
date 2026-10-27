// Shared motion timings and easing helpers mirroring public/styles/tokens.css.

export const DUR = Object.freeze({
  instant: 80,
  fast: 120,
  base: 220,
  slow: 420,
});

// Approximates cubic-bezier(0.2, 0.7, 0.2, 1)
export function easeOut(t) {
  const clamped = Math.max(0, Math.min(1, t));
  return 1 - Math.pow(1 - clamped, 3);
}

// Smooth cubic ease-in-out
export function easeInOut(t) {
  const clamped = Math.max(0, Math.min(1, t));
  return clamped < 0.5
    ? 4 * clamped * clamped * clamped
    : 1 - Math.pow(-2 * clamped + 2, 3) / 2;
}

export function prefersReducedMotion() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

