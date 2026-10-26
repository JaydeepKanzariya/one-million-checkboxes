import { config } from '../config.js';
import { logger } from '../logger.js';

export class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
  }
}

export function notFound(req, res, next) {
  next(new AppError(404, 'NOT_FOUND', `No route for ${req.method} ${req.path}`));
}

// Central error middleware: every error leaves as {error:{code,message}}.
// Stack traces are only included outside production.
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  const code = err.code && status < 500 ? err.code : status >= 500 ? 'INTERNAL' : 'ERROR';
  const message = status >= 500 ? 'Something went wrong on our side.' : err.message;

  if (status >= 500) logger.error({ err, path: req.path, method: req.method }, 'request failed');
  else logger.debug({ code, path: req.path }, err.message);

  const body = { error: { code, message } };
  if (!config.isProd && status >= 500) body.error.stack = err.stack;
  res.status(status).json(body);
}
