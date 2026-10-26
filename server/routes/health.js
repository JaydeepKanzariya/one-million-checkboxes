import { Router } from 'express';
import { config } from '../config.js';
import { isRedisReady, redis } from '../redis/client.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const healthRouter = Router();

healthRouter.get(
  '/healthz',
  asyncHandler(async (_req, res) => {
    let pong = false;
    if (isRedisReady()) {
      try {
        pong = (await redis.ping()) === 'PONG';
      } catch {
        pong = false;
      }
    }

    const ok = pong && isRedisReady();
    res.status(ok ? 200 : 503).json({
      ok,
      redis: ok ? 'up' : 'down',
      instance: config.instanceId,
    });
  }),
);

