import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../server/config.js';
import { checkWsUserLimit } from '../server/ratelimit/wsLimiter.js';
import { setupTestRedis } from './helpers/redisHarness.js';

describe('Redis sliding-window WebSocket rate limiter + strike/block escalation', () => {
  let harness;

  beforeAll(async () => {
    harness = await setupTestRedis();
  });

  beforeEach(async () => {
    await harness.flush();
  });

  afterAll(async () => {
    await harness.teardown();
  });

  it('allows 20 toggles in 1s, rejects the 21st, and allows again after the window passes', async () => {
    const userId = 'user-sliding-test';
    const t0 = 10_000;

    for (let i = 0; i < config.rl.wsUserLimit; i++) {
      const res = await checkWsUserLimit(userId, t0 + i * 10);
      expect(res.allowed).toBe(true);
    }

    const rejected = await checkWsUserLimit(userId, t0 + 250);
    expect(rejected.allowed).toBe(false);
    expect(rejected.reason).toBe('rate');
    expect(rejected.retryAfterMs).toBeGreaterThan(0);

    // Advance past the 1000ms window from the earliest entries
    const afterWindow = await checkWsUserLimit(userId, t0 + config.rl.wsUserWindowMs + 20);
    expect(afterWindow.allowed).toBe(true);
  });

  it('escalates 10 rate-limit strikes into a temporary block', async () => {
    const userId = 'user-block-test';
    const t0 = Date.now();

    // Fill the 20-toggle sliding window
    for (let i = 0; i < config.rl.wsUserLimit; i++) {
      const ok = await checkWsUserLimit(userId, t0);
      expect(ok.allowed).toBe(true);
    }

    // Trigger 9 strikes -> still reason='rate'
    for (let s = 1; s < config.rl.wsStrikesToBlock; s++) {
      const res = await checkWsUserLimit(userId, t0 + 5);
      expect(res.allowed).toBe(false);
      expect(res.reason).toBe('rate');
      expect(res.strikes).toBe(s);
    }

    // 10th strike -> escalates to 'blocked'
    const tenth = await checkWsUserLimit(userId, t0 + 10);
    expect(tenth.allowed).toBe(false);
    expect(tenth.reason).toBe('blocked');
    expect(tenth.retryAfterMs).toBeGreaterThanOrEqual(1000);

    // Subsequent attempts while blocked immediately return reason='blocked'
    const whileBlocked = await checkWsUserLimit(userId, t0 + 2000);
    expect(whileBlocked.allowed).toBe(false);
    expect(whileBlocked.reason).toBe('blocked');
  });
});

