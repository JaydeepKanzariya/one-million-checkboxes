// Applies server updates strictly in sequence order.
// appliedSeq is the highest sequence number whose effect is contiguously applied from the snapshot.

export class Sequencer {
  constructor({ apply, onGapTimeout, gapTimeoutMs = 2000, maxBuffer = 20_000 } = {}) {
    this.apply = apply;
    this.onGapTimeout = onGapTimeout;
    this.gapTimeoutMs = gapTimeoutMs;
    this.maxBuffer = maxBuffer;

    this._appliedSeq = 0;
    this.buffer = new Map(); // seq -> { index, value }
    this.gapTimer = null;
  }

  get appliedSeq() {
    return this._appliedSeq;
  }

  reset(snapshotSeq = 0) {
    this._appliedSeq = Number(snapshotSeq) || 0;
    this.buffer.clear();
    this.clearGapTimer();
  }

  push(seq, index, value) {
    if (!Number.isInteger(seq) || seq <= this._appliedSeq) {
      return false;
    }

    if (seq === this._appliedSeq + 1) {
      this._appliedSeq = seq;
      this.apply?.(index, value, seq);
      this.drain();
      return true;
    }

    // seq > appliedSeq + 1: out-of-order gap
    if (!this.buffer.has(seq)) {
      this.buffer.set(seq, { index, value });
    }

    if (this.buffer.size > this.maxBuffer) {
      this.buffer.clear();
      this.clearGapTimer();
      this.onGapTimeout?.();
      return false;
    }

    this.startGapTimer();
    return false;
  }

  drain() {
    while (this.buffer.has(this._appliedSeq + 1)) {
      const nextSeq = this._appliedSeq + 1;
      const item = this.buffer.get(nextSeq);
      this.buffer.delete(nextSeq);
      this._appliedSeq = nextSeq;
      this.apply?.(item.index, item.value, nextSeq);
    }

    if (this.buffer.size === 0) {
      this.clearGapTimer();
    } else {
      this.startGapTimer();
    }
  }

  startGapTimer() {
    if (this.gapTimer !== null) return;
    this.gapTimer = setTimeout(() => {
      this.gapTimer = null;
      if (this.buffer.size > 0) {
        this.buffer.clear();
        this.onGapTimeout?.();
      }
    }, this.gapTimeoutMs);
  }

  clearGapTimer() {
    if (this.gapTimer !== null) {
      clearTimeout(this.gapTimer);
      this.gapTimer = null;
    }
  }
}

