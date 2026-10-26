import { config } from '../config.js';
import { redis } from '../redis/client.js';
import { keys } from '../redis/keys.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../utils/errors.js';

export function createHttpLimiter({ scope, limit, windowSeconds }) {
  return asyncHandler(async (req, res, next) => {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const nowSec = Math.floor(Date.now() / 1000);
    const windowId = Math.floor(nowSec / windowSeconds);
    const key = keys.rlHttp(scope, ip, windowId);

    const [allowedRaw, currentRaw, ttlMsRaw] = await redis.httpLimitLua(
      key,
      limit,
      windowSeconds + 1,
    );

    const allowed = Number(allowedRaw) === 1;
    const current = Number(currentRaw);
    const ttlMs = Math.max(0, Number(ttlMsRaw));
    const remaining = Math.max(0, limit - current);
    const resetEpochSeconds = Math.ceil((Date.now() + ttlMs) / 1000);

    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(resetEpochSeconds));

    if (!allowed) {
      const retryAfterSec = Math.max(1, Math.ceil(ttlMs / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      throw new AppError(
        429,
        'RATE_LIMITED',
        `Too many requests. Please try again in ${retryAfterSec}s.`,
      );
    }

    next();
  });
}

export const apiLimiter = createHttpLimiter({
  scope: 'api',
  limit: config.rl.httpApiLimit,
  windowSeconds: config.rl.httpApiWindowS,
});

export const authLimiter = createHttpLimiter({
  scope: 'auth',
  limit: config.rl.httpAuthLimit,
  windowSeconds: config.rl.httpAuthWindowS,
});

