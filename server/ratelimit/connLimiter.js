import { config } from '../config.js';
import { redis } from '../redis/client.js';
import { keys } from '../redis/keys.js';

export async function acquireConnectionSlot(ip) {
  const safeIp = ip || 'unknown';
  const windowId = Math.floor(Date.now() / 60_000);
  const rateKey = keys.rlConnRate(safeIp, windowId);
  const connKey = keys.rlConnIp(safeIp);

  const [rateAllowedRaw] = await redis.httpLimitLua(rateKey, config.rl.connPerMinute, 61);
  if (Number(rateAllowedRaw) !== 1) {
    return { allowed: false, reason: 'conn_rate' };
  }

  const active = await redis.incr(connKey);
  // Safety TTL in case an instance crashes without running close handlers
  await redis.expire(connKey, 3600);

  if (active > config.rl.maxConnPerIp) {
    await redis.decr(connKey);
    return { allowed: false, reason: 'max_conn' };
  }

  return { allowed: true, active };
}

export async function releaseConnectionSlot(ip) {
  const safeIp = ip || 'unknown';
  const connKey = keys.rlConnIp(safeIp);
  try {
    const remaining = await redis.decr(connKey);
    if (remaining <= 0) {
      await redis.del(connKey);
    }
  } catch {
    // Ignore errors during shutdown
  }
}

