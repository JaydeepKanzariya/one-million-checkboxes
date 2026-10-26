import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../utils/errors.js';
import { getSessionFromCookieHeader } from './sessions.js';

export const attachUser = asyncHandler(async (req, _res, next) => {
  const { sid, user } = await getSessionFromCookieHeader(req.headers.cookie, { touch: true });
  req.sessionId = sid;
  req.user = user;
  next();
});

export function requireUser(req, _res, next) {
  if (!req.user) {
    return next(new AppError(401, 'AUTH_REQUIRED', 'Please sign in to continue.'));
  }
  return next();
}

