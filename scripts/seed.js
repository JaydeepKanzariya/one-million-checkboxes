// Seeds the board with a pattern or random bits for demos.
// Usage:
//   node scripts/seed.js            # seeds ~2,500 random bits + a ledger header pattern
//   node scripts/seed.js --clear    # resets the board to all zeros
//   node scripts/seed.js --count=5000

import { config } from '../server/config.js';
import { BOARD_BYTE_LENGTH, ensureBoardInitialized } from '../server/redis/board.js';
import { closeRedis, connectRedis, redis } from '../server/redis/client.js';
import { keys } from '../server/redis/keys.js';

function setBitInBuffer(buf, index, value) {
  if (index < 0 || index >= config.board.size) return;
  const byteIdx = index >> 3;
  const mask = 1 << (7 - (index & 7));
  if (value) buf[byteIdx] |= mask;
  else buf[byteIdx] &= ~mask;
}

async function run() {
  const args = process.argv.slice(2);
  const clear = args.includes('--clear');
  const countArg = args.find((a) => a.startsWith('--count='));
  const targetRandom = countArg ? Number(countArg.split('=')[1]) : 2500;

  await connectRedis();
  await ensureBoardInitialized();

  const buf = Buffer.alloc(BOARD_BYTE_LENGTH, 0);

  if (!clear) {
    // Draw a neat diagonal + border frame in the top-left 40x40 region
    for (let i = 0; i < 32; i++) {
      setBitInBuffer(buf, 2 * 1000 + (2 + i), 1);
      setBitInBuffer(buf, 33 * 1000 + (2 + i), 1);
      setBitInBuffer(buf, (2 + i) * 1000 + 2, 1);
      setBitInBuffer(buf, (2 + i) * 1000 + 33, 1);
      setBitInBuffer(buf, (2 + i) * 1000 + (2 + i), 1);
    }

    for (let i = 0; i < targetRandom; i++) {
      const idx = Math.floor(Math.random() * config.board.size);
      setBitInBuffer(buf, idx, 1);
    }
  }

  await redis.set(keys.board, buf);
  const bitcount = await redis.bitcount(keys.board);
  const seq = await redis.incr(keys.boardSeq);
  await redis.set(keys.boardCount, String(bitcount));
  await redis.del(keys.boardLog);
  await redis.publish(keys.chControl, JSON.stringify({ t: 'resync', seq }));

  console.log(
    clear
      ? `Cleared board (seq=${seq}, checked=0)`
      : `Seeded board (seq=${seq}, checked=${bitcount})`,
  );

  await closeRedis();
}

run().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});

