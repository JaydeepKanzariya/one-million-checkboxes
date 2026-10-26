import { describe, expect, it, vi } from 'vitest';
import { Sequencer } from '../public/js/sequencer.js';

describe('Client Sequencer', () => {
  it('applies in-order updates and advances appliedSeq', () => {
    const applied = [];
    const seq = new Sequencer({
      apply: (index, value, s) => applied.push({ index, value, seq: s }),
    });
    seq.reset(10);

    expect(seq.push(11, 100, 1)).toBe(true);
    expect(seq.push(12, 200, 0)).toBe(true);
    expect(seq.appliedSeq).toBe(12);
    expect(applied).toEqual([
      { index: 100, value: 1, seq: 11 },
      { index: 200, value: 0, seq: 12 },
    ]);
  });

  it('ignores duplicate and old sequence numbers', () => {
    const applied = [];
    const seq = new Sequencer({
      apply: (index, value, s) => applied.push({ index, value, seq: s }),
    });
    seq.reset(5);

    expect(seq.push(4, 10, 1)).toBe(false);
    expect(seq.push(5, 10, 1)).toBe(false);
    expect(seq.push(6, 10, 1)).toBe(true);
    expect(seq.push(6, 10, 0)).toBe(false);
    expect(applied).toEqual([{ index: 10, value: 1, seq: 6 }]);
  });

  it('buffers across a gap and drains strictly in order once filled', () => {
    const applied = [];
    const seq = new Sequencer({
      apply: (index, value, s) => applied.push({ index, value, seq: s }),
    });
    seq.reset(0);

    // Arrive out of order: 3, 2, then 1
    expect(seq.push(3, 30, 1)).toBe(false);
    expect(seq.push(2, 20, 1)).toBe(false);
    expect(seq.appliedSeq).toBe(0);
    expect(applied).toEqual([]);

    expect(seq.push(1, 10, 1)).toBe(true);
    expect(seq.appliedSeq).toBe(3);
    expect(applied).toEqual([
      { index: 10, value: 1, seq: 1 },
      { index: 20, value: 1, seq: 2 },
      { index: 30, value: 1, seq: 3 },
    ]);
  });

  it('prevents an older replay batch from overwriting a newer live batch on the same cell', () => {
    const state = new Map();
    const seq = new Sequencer({
      apply: (index, value) => state.set(index, value),
    });
    seq.reset(10);

    // Live batch (seq 12) sets cell 42 to 0 BEFORE replay batch (seq 11) setting cell 42 to 1 arrives
    seq.push(12, 42, 0);
    expect(state.get(42)).toBeUndefined(); // buffered until 11 arrives

    seq.push(11, 42, 1);
    expect(seq.appliedSeq).toBe(12);
    // Because 11 applied first and 12 drained second, final value of cell 42 is 0
    expect(state.get(42)).toBe(0);
  });

  it('calls onGap once per gap with appliedSeq so the client can request a replay', () => {
    vi.useFakeTimers();
    try {
      const gaps = [];
      const seq = new Sequencer({
        apply: () => {},
        onGap: (appliedSeq) => gaps.push(appliedSeq),
        gapTimeoutMs: 500,
      });
      seq.reset(10);

      seq.push(13, 1, 1); // missing 11, 12
      seq.push(14, 2, 1); // same gap: no second request
      expect(gaps).toEqual([10]);

      seq.push(11, 3, 1); // still missing 12, gap stays open
      expect(gaps).toEqual([10]);

      seq.push(12, 4, 1); // gap filled and drained
      expect(seq.appliedSeq).toBe(14);

      seq.push(16, 5, 1); // a new gap opens
      expect(gaps).toEqual([10, 14]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('calls onGapTimeout when a gap remains unfilled past gapTimeoutMs', () => {
    vi.useFakeTimers();
    try {
      let timedOut = 0;
      const seq = new Sequencer({
        apply: () => {},
        onGapTimeout: () => {
          timedOut++;
        },
        gapTimeoutMs: 500,
      });
      seq.reset(10);

      seq.push(12, 99, 1); // missing 11
      vi.advanceTimersByTime(499);
      expect(timedOut).toBe(0);

      vi.advanceTimersByTime(2);
      expect(timedOut).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

