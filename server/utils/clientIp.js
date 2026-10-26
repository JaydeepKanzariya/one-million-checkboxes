import { config } from '../config.js';

// Extracts client IP matching Express "trust proxy = N" hop counting from the right.
export function extractClientIp(req, trustProxy = config.trustProxy) {
  const remoteAddress = req.socket?.remoteAddress || '127.0.0.1';
  if (!trustProxy || trustProxy <= 0) {
    return remoteAddress;
  }

  const xff = req.headers?.['x-forwarded-for'];
  if (typeof xff !== 'string' || !xff.trim()) {
    return remoteAddress;
  }

  const parts = xff
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    return remoteAddress;
  }

  const index = Math.max(0, parts.length - trustProxy);
  return parts[index];
}

