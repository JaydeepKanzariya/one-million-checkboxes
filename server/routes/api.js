import zlib from 'node:zlib';
import { Router } from 'express';
import { attachUser } from '../auth/middleware.js';
import { getUserToggles } from '../auth/sessions.js';
import { config } from '../config.js';
import { apiLimiter } from '../ratelimit/httpLimiter.js';
import { getActiveInstances, getOnlineCount } from '../realtime/presence.js';
import { getBoardStats, getSnapshot } from '../redis/board.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const apiRouter = Router();

apiRouter.use(apiLimiter);

apiRouter.get(
  '/me',
  attachUser,
  asyncHandler(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!req.user) {
      return res.json({
        authenticated: false,
        user: null,
        instanceId: config.instanceId,
        oidcEnabled: config.oidc.enabled,
        devLoginEnabled: config.devLogin && !config.isProd,
      });
    }

    const toggles = await getUserToggles(req.user.userId);
    return res.json({
      authenticated: true,
      user: {
        userId: req.user.userId,
        name: req.user.name,
        email: req.user.email,
        picture: req.user.picture,
        toggles,
      },
      instanceId: config.instanceId,
      oidcEnabled: config.oidc.enabled,
      devLoginEnabled: config.devLogin && !config.isProd,
    });
  }),
);

apiRouter.get(
  '/board',
  asyncHandler(async (req, res) => {
    const { buffer, seq, checked } = await getSnapshot();
    const etag = `"${seq}"`;

    res.setHeader('ETag', etag);
    res.setHeader('X-Board-Seq', String(seq));
    res.setHeader('X-Board-Checked', String(checked));
    res.setHeader('X-Instance-Id', config.instanceId);
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Vary', 'Accept-Encoding');

    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }

    res.setHeader('Content-Type', 'application/octet-stream');

    const acceptEncoding = String(req.headers['accept-encoding'] || '');
    // Only gzip when client explicitly asks and doesn't pass ?raw=1
    if (acceptEncoding.includes('gzip') && req.query.raw !== '1') {
      const compressed = zlib.gzipSync(buffer, { level: zlib.constants.Z_BEST_SPEED });
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Length', String(compressed.length));
      return res.status(200).end(compressed);
    }

    res.setHeader('Content-Length', String(buffer.length));
    return res.status(200).end(buffer);
  }),
);

apiRouter.get(
  '/stats',
  asyncHandler(async (_req, res) => {
    const [board, online, instances] = await Promise.all([
      getBoardStats(),
      getOnlineCount(),
      getActiveInstances(),
    ]);

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      checked: board.checked,
      seq: board.seq,
      online,
      instance: config.instanceId,
      instances,
    });
  }),
);

