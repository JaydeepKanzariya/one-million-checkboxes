import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BOARD_BYTE_LENGTH,
  ensureBoardInitialized,
  getReplaySince,
  getSnapshot,
  setBit,
} from '../server/redis/board.js';
import { subscriber } from '../server/redis/client.js';
import { keys } from '../server/redis/keys.js';
import { setupTestRedis } from './helpers/redisHarness.js';

describe('Redis bitmap board + atomic toggle.lua', () => {
  let harness;

  beforeAll(async () => {
    harness = await setupTestRedis();
  });

  beforeEach(async () => {
    await harness.flush();
    await ensureBoardInitialized();
  });

  afterAll(async () => {
    await harness.teardown();
  });

  it('allocates a 125,000-byte bitmap and toggles bits atomically with Pub/Sub', async () => {
    const published = [];
    const onMsg = (ch, msg) => {
      if (ch === keys.chUpdates) published.push(msg);
    };
    subscriber.on('message', onMsg);
    await subscriber.subscribe(keys.chUpdates);

    try {
      const initial = await getSnapshot();
      expect(initial.buffer.length).toBe(BOARD_BYTE_LENGTH);
      expect(initial.seq).toBe(0);
      expect(initial.checked).toBe(0);

      // First toggle -> changes bit 0->1, increments seq & checked, publishes event
      const r1 = await setBit(523417, 1, 'user-1');
      expect(r1).toEqual({ changed: true, seq: 1, checked: 1 });

      // Wait briefly for Pub/Sub delivery if using real Redis
      await new Promise((r) => setTimeout(r, 25));
      expect(published).toContain('1:523417:1');

      // Setting the same value again -> no-op (changed=false, seq unchanged, no duplicate publish)
      const r2 = await setBit(523417, 1, 'user-1');
      expect(r2).toEqual({ changed: false, seq: 1, checked: 1 });
      await new Promise((r) => setTimeout(r, 25));
      expect(published.length).toBe(1);

      // Verify bit in snapshot MSB-first
      const snap = await getSnapshot();
      const byteIdx = 523417 >> 3;
      const bitMask = 1 << (7 - (523417 & 7));
      expect((snap.buffer[byteIdx] & bitMask) !== 0).toBe(true);

      // Replay stream returns missed updates since seq 0
      const replay = await getReplaySince(0, 1);
      expect(replay).toEqual([{ seq: 1, index: 523417, value: 1 }]);

      // Uncheck -> decrements checked count, increments seq
      const r3 = await setBit(523417, 0, 'user-1');
      expect(r3).toEqual({ changed: true, seq: 2, checked: 0 });
    } finally {
      subscriber.off('message', onMsg);
    }
  });
});

