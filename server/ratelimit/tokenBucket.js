import { config } from '../config.js';

export class TokenBucket {
  constructor(
    capacity = config.rl.wsBucketCapacity,
    refillPerSec = config.rl.wsBucketRefillPerS,
    nowMs = Date.now(),
  ) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.tokens = capacity;
    this.lastRefillMs = nowMs;
  }

  consume(cost = 1, nowMs = Date.now()) {
    const elapsedSec = Math.max(0, (nowMs - this.lastRefillMs) / 1000);
    if (elapsedSec > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
      this.lastRefillMs = nowMs;
    }

    if (this.tokens >= cost) {
      this.tokens -= cost;
      return {
        allowed: true,
        remaining: Math.floor(this.tokens),
        retryAfterMs: 0,
      };
    }

    const deficit = cost - this.tokens;
    const retryAfterMs = Math.max(1, Math.ceil((deficit / this.refillPerSec) * 1000));
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs,
    };
  }
}

