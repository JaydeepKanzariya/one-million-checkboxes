import crypto from 'node:crypto';
import { Router } from 'express';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { authLimiter } from '../ratelimit/httpLimiter.js';
import { redis } from '../redis/client.js';
import { keys } from '../redis/keys.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../utils/errors.js';
import { attachUser } from './middleware.js';
import { beginOidcLogin, completeOidcLogin, sanitizeReturnTo } from './oidc.js';
import {
  clearSessionCookie,
  createSession,
  destroySession,
  hashSessionId,
  setSessionCookie,
} from './sessions.js';

export const authRouter = Router();

authRouter.use(authLimiter);

authRouter.get(
  '/login',
  asyncHandler(async (req, res) => {
    const returnTo = sanitizeReturnTo(req.query.returnTo || '/');
    if (!config.oidc.enabled && config.devLogin && !config.isProd) {
      const name = String(req.query.name || 'Engineer').slice(0, 32);
      return res.redirect(`/auth/dev-login?name=${encodeURIComponent(name)}&returnTo=${encodeURIComponent(returnTo)}`);
    }
    const { authUrl } = await beginOidcLogin(returnTo);
    res.redirect(302, authUrl);
  }),
);

authRouter.get(
  '/callback',
  asyncHandler(async (req, res) => {
    const { user, returnTo } = await completeOidcLogin(req);
    const { sid } = await createSession(user);
    setSessionCookie(res, sid);
    res.redirect(302, returnTo);
  }),
);

if (config.devLogin && !config.isProd) {
  authRouter.get(
    '/dev-login',
    asyncHandler(async (req, res) => {
      const rawName = String(req.query.name || 'Ledger Guest').trim().slice(0, 32) || 'Ledger Guest';
      const slug = rawName.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'guest';
      const suffix = crypto.createHash('sha1').update(rawName).digest('hex').slice(0, 6);
      const userId = `dev:${slug}:${suffix}`;
      const returnTo = sanitizeReturnTo(req.query.returnTo || '/');

      const { sid } = await createSession({
        userId,
        name: rawName,
        email: `${slug}@local.dev`,
        picture: '',
      });
      logger.warn({ userId, name: rawName, ip: req.ip }, 'dev-login session created');
      setSessionCookie(res, sid);
      res.redirect(302, returnTo);
    }),
  );
} else {
  authRouter.get('/dev-login', (_req, _res, next) => {
    next(new AppError(404, 'NOT_FOUND', 'Dev login is disabled.'));
  });
}

authRouter.post(
  '/logout',
  attachUser,
  asyncHandler(async (req, res) => {
    const sidHash = req.sessionId ? hashSessionId(req.sessionId) : null;
    if (req.sessionId) {
      await destroySession(req.sessionId);
    }
    clearSessionCookie(res);

    if (sidHash) {
      await redis.publish(
        keys.chControl,
        JSON.stringify({ t: 'logout', sidHash }),
      );
    }

    res.status(204).end();
  }),
);

