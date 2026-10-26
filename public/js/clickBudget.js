// Pure client-side token bucket mirroring server/ratelimit/tokenBucket.js.

export class ClickBudget {
  constructor({ capacity = 10, refillPerSec = 5, nowMs = Date.now() } = {}) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.tokens = capacity;
    this.lastRefillMs = nowMs;
  }

  configure({ capacity, refillPerSec } = {}, nowMs = Date.now()) {
    this._refill(nowMs);
    if (Number.isFinite(capacity) && capacity > 0) {
      this.capacity = capacity;
      this.tokens = Math.min(this.capacity, this.tokens);
    }
    if (Number.isFinite(refillPerSec) && refillPerSec > 0) {
      this.refillPerSec = refillPerSec;
    }
  }

  _refill(nowMs = Date.now()) {
    const elapsedSec = Math.max(0, (nowMs - this.lastRefillMs) / 1000);
    if (elapsedSec > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
      this.lastRefillMs = nowMs;
    }
  }

  level(nowMs = Date.now()) {
    this._refill(nowMs);
    return this.tokens;
  }

  consume(nowMs = Date.now()) {
    this._refill(nowMs);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  drain(nowMs = Date.now()) {
    this.tokens = 0;
    this.lastRefillMs = nowMs;
  }
}

