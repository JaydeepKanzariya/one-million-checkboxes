import { config } from '../config.js';
import { redis } from './client.js';
import { keys } from './keys.js';

export const BOARD_BYTE_LENGTH = Math.ceil(config.board.size / 8);

export async function ensureBoardInitialized() {
  const [len, countRaw, seqRaw] = await Promise.all([
    redis.strlen(keys.board),
    redis.get(keys.boardCount),
    redis.get(keys.boardSeq),
  ]);

  if (len < BOARD_BYTE_LENGTH) {
    // Allocate the full bitmap up to the last bit without flipping existing bits.
    const lastBit = config.board.size - 1;
    const currentLast = await redis.getbit(keys.board, lastBit);
    await redis.setbit(keys.board, lastBit, currentLast);
  }

  if (countRaw === null) {
    const bitcount = await redis.bitcount(keys.board);
    await redis.setnx(keys.boardCount, String(bitcount));
  }

  if (seqRaw === null) {
    await redis.setnx(keys.boardSeq, '0');
  }
}

export async function getSnapshot() {
  const results = await redis
    .multi()
    .getBuffer(keys.board)
    .get(keys.boardSeq)
    .get(keys.boardCount)
    .exec();

  const rawBuf = results?.[0]?.[1];
  const seq = Number(results?.[1]?.[1] ?? 0);
  const checked = Number(results?.[2]?.[1] ?? 0);

  let buffer;
  if (!rawBuf) {
    buffer = Buffer.alloc(BOARD_BYTE_LENGTH, 0);
  } else if (rawBuf.length === BOARD_BYTE_LENGTH) {
    buffer = rawBuf;
  } else if (rawBuf.length < BOARD_BYTE_LENGTH) {
    buffer = Buffer.alloc(BOARD_BYTE_LENGTH, 0);
    rawBuf.copy(buffer, 0, 0, rawBuf.length);
  } else {
    buffer = rawBuf.subarray(0, BOARD_BYTE_LENGTH);
  }

  return { buffer, seq, checked };
}

export async function setBit(index, value, userSub = '') {
  if (!Number.isInteger(index) || index < 0 || index >= config.board.size) {
    throw new RangeError(`Checkbox index out of range: ${index}`);
  }
  const bit = value ? 1 : 0;
  const userStatsKey = userSub ? keys.userStats(userSub) : '';

  const [changed, seq, count] = await redis.toggleBitLua(
    keys.board,
    keys.boardSeq,
    keys.boardCount,
    keys.boardLog,
    userStatsKey,
    index,
    bit,
    keys.chUpdates,
    config.board.logLength,
    Date.now(),
  );

  return {
    changed: Number(changed) === 1,
    seq: Number(seq),
    checked: Number(count),
  };
}

export async function getBoardStats() {
  const [seqRaw, countRaw] = await redis.mget(keys.boardSeq, keys.boardCount);
  return {
    seq: Number(seqRaw ?? 0),
    checked: Number(countRaw ?? 0),
  };
}

// Reads missed updates since lastSeq from the bounded Redis Stream if available.
// Returns an array of { seq, index, value } if complete, or null if a full resync is required.
export async function getReplaySince(lastSeq, currentSeq) {
  if (!Number.isInteger(lastSeq) || lastSeq < 0 || lastSeq >= currentSeq) {
    return [];
  }
  const gap = currentSeq - lastSeq;
  if (gap > config.board.resyncGap || config.board.logLength <= 0) {
    return null;
  }

  const entries = await redis.xrevrange(keys.boardLog, '+', '-', 'COUNT', gap + 20);
  if (!entries || entries.length === 0) return null;

  const updates = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const fields = entries[i][1];
    let seq = 0;
    let index = 0;
    let value = 0;
    for (let j = 0; j < fields.length; j += 2) {
      const k = fields[j];
      const v = Number(fields[j + 1]);
      if (k === 's') seq = v;
      else if (k === 'i') index = v;
      else if (k === 'v') value = v;
    }
    if (seq > lastSeq) {
      updates.push({ seq, index, value });
    }
  }

  // Verify the replay log covers all the way back to lastSeq + 1
  if (updates.length === 0 || updates[0].seq > lastSeq + 1) {
    return null;
  }
  return updates;
}

