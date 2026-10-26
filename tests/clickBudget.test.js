import { describe, expect, it } from 'vitest';
import { ClickBudget } from '../client/src/engine/clickBudget.js';

describe('ClickBudget (client token bucket)', () => {
  it('allows 10 consumes and fails on the 11th', () => {
    const t0 = 100_000;
    const budget = new ClickBudget({ capacity: 10, refillPerSec: 5, nowMs: t0 });

    for (let i = 0; i < 10; i++) {
      expect(budget.consume(t0)).toBe(true);
    }
    expect(budget.consume(t0)).toBe(false);
    expect(budget.level(t0)).toBe(0);
  });

  it('refills 1 token after 200 ms at 5 tokens/sec', () => {
    const t0 = 100_000;
    const budget = new ClickBudget({ capacity: 10, refillPerSec: 5, nowMs: t0 });
    for (let i = 0; i < 10; i++) budget.consume(t0);

    expect(budget.consume(t0 + 199)).toBe(false);
    expect(budget.consume(t0 + 200)).toBe(true);
    expect(budget.consume(t0 + 200)).toBe(false);
  });

  it('never exceeds capacity after long idle time', () => {
    const t0 = 100_000;
    const budget = new ClickBudget({ capacity: 10, refillPerSec: 5, nowMs: t0 });
    budget.consume(t0);
    expect(budget.level(t0)).toBe(9);
    expect(budget.level(t0 + 60_000)).toBe(10);
  });

  it('drain() sets the level to 0', () => {
    const t0 = 100_000;
    const budget = new ClickBudget({ capacity: 10, refillPerSec: 5, nowMs: t0 });
    expect(budget.level(t0)).toBe(10);

    budget.drain(t0 + 50);
    expect(budget.level(t0 + 50)).toBe(0);
    expect(budget.consume(t0 + 50)).toBe(false);
  });
});

