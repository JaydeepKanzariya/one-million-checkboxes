import { describe, expect, it } from 'vitest';
import { TokenBucket } from '../server/ratelimit/tokenBucket.js';

describe('In-memory per-socket TokenBucket', () => {
  it('allows bursts up to capacity and rejects when empty', () => {
    const t0 = 1_000_000;
    const bucket = new TokenBucket(10, 5, t0);

    for (let i = 0; i < 10; i++) {
      const res = bucket.consume(1, t0);
      expect(res.allowed).toBe(true);
      expect(res.remaining).toBe(9 - i);
    }

    const rejected = bucket.consume(1, t0);
    expect(rejected.allowed).toBe(false);
    expect(rejected.retryAfterMs).toBe(200);
  });

  it('refills tokens proportionally over time and clamps at capacity', () => {
    const t0 = 1_000_000;
    const bucket = new TokenBucket(10, 5, t0);

    // Drain all 10 tokens
    for (let i = 0; i < 10; i++) bucket.consume(1, t0);
    expect(bucket.consume(1, t0).allowed).toBe(false);

    // 400ms later -> +2 tokens (at 5/sec)
    expect(bucket.consume(1, t0 + 400).allowed).toBe(true);
    expect(bucket.consume(1, t0 + 400).allowed).toBe(true);
    expect(bucket.consume(1, t0 + 400).allowed).toBe(false);

    // 10 seconds later -> capped at capacity (10)
    const afterLongIdle = bucket.consume(1, t0 + 10_400);
    expect(afterLongIdle.allowed).toBe(true);
    expect(afterLongIdle.remaining).toBe(9);
  });
});

