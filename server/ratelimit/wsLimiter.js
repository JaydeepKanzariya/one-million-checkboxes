import crypto from 'node:crypto';
import { config } from '../config.js';
import { redis } from '../redis/client.js';
import { keys } from '../redis/keys.js';

let seqCounter = 0;

export async function checkWsUserLimit(userId, nowMs = Date.now()) {
  const member = `${nowMs}:${(seqCounter = (seqCounter + 1) & 0xfffff)}:${crypto.randomBytes(2).toString('hex')}`;
  const [allowedRaw, reasonRaw, valueRaw, strikesRaw, blocksRaw] = await redis.wsLimitLua(
    keys.rlWsUser(userId),
    keys.rlStrikes(userId),
    keys.rlBlock(userId),
    keys.rlBlockCount(userId),
    nowMs,
    config.rl.wsUserWindowMs,
    config.rl.wsUserLimit,
    member,
    config.rl.wsStrikesToBlock,
    config.rl.wsStrikeWindowS,
    config.rl.wsBlockSeconds,
  );

  const allowed = Number(allowedRaw) === 1;
  const reasonCode = Number(reasonRaw); // 0 = ok, 1 = rate, 2 = blocked
  const value = Number(valueRaw);
  const strikes = Number(strikesRaw);
  const blocks = Number(blocksRaw);

  if (allowed) {
    return {
      allowed: true,
      reason: 'ok',
      remaining: value,
      retryAfterMs: 0,
      strikes: 0,
      blocks: 0,
      shouldClose: false,
    };
  }

  return {
    allowed: false,
    reason: reasonCode === 2 ? 'blocked' : 'rate',
    remaining: 0,
    retryAfterMs: Math.max(1, value),
    strikes,
    blocks,
    shouldClose: blocks >= config.rl.wsBlocksToClose,
  };
}

export async function recordUserStrike(userId) {
  if (!userId) return { blocked: false, strikes: 0, blocks: 0, retryAfterMs: 0, shouldClose: false };

  const [blockedRaw, strikesRaw, blocksRaw, retryAfterMsRaw] = await redis.strikeLua(
    keys.rlStrikes(userId),
    keys.rlBlock(userId),
    keys.rlBlockCount(userId),
    config.rl.wsStrikesToBlock,
    config.rl.wsStrikeWindowS,
    config.rl.wsBlockSeconds,
  );

  const blocked = Number(blockedRaw) === 1;
  const strikes = Number(strikesRaw);
  const blocks = Number(blocksRaw);
  const retryAfterMs = Number(retryAfterMsRaw);

  return {
    blocked,
    strikes,
    blocks,
    retryAfterMs,
    shouldClose: blocked && blocks >= config.rl.wsBlocksToClose,
  };
}
