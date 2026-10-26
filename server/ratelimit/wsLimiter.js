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
  if (!userId) return { blocked: false, blocks: 0, retryAfterMs: 0 };
  const strikesKey = keys.rlStrikes(userId);
  const blockKey = keys.rlBlock(userId);
  const blockCountKey = keys.rlBlockCount(userId);

  const strikes = await redis.incr(strikesKey);
  if (strikes === 1) {
    await redis.expire(strikesKey, config.rl.wsStrikeWindowS);
  }

  if (strikes >= config.rl.wsStrikesToBlock) {
    await redis.set(blockKey, '1', 'EX', config.rl.wsBlockSeconds);
    await redis.del(strikesKey);
    const blocks = await redis.incr(blockCountKey);
    await redis.expire(blockCountKey, config.rl.wsBlockSeconds * 10);
    return {
      blocked: true,
      blocks,
      retryAfterMs: config.rl.wsBlockSeconds * 1000,
      shouldClose: blocks >= config.rl.wsBlocksToClose,
    };
  }

  return { blocked: false, strikes, blocks: 0, retryAfterMs: 1000, shouldClose: false };
}

