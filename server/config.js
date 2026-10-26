// Environment parsing and validation. Every setting is read once, here.
// Any invalid value is collected and the process refuses to start (fail fast).
import 'dotenv/config';
import os from 'node:os';

const errors = [];
const env = process.env;

function read(name) {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

function str(name, fallback) {
  return read(name) ?? fallback;
}

function int(name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = read(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    errors.push(`${name} must be an integer between ${min} and ${max} (got "${raw}")`);
    return fallback;
  }
  return n;
}

function bool(name, fallback) {
  const raw = read(name);
  if (raw === undefined) return fallback;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  errors.push(`${name} must be true or false (got "${raw}")`);
  return fallback;
}

function origin(name, value) {
  try {
    return new URL(value).origin;
  } catch {
    errors.push(`${name} contains an invalid URL: "${value}"`);
    return null;
  }
}

const nodeEnv = str('NODE_ENV', 'development');
if (!['development', 'production', 'test'].includes(nodeEnv)) {
  errors.push(`NODE_ENV must be development, production or test (got "${nodeEnv}")`);
}
const isProd = nodeEnv === 'production';
const isTest = nodeEnv === 'test';

const port = int('PORT', 3000, { min: 0, max: 65535 });
const publicUrl = (origin('PUBLIC_URL', str('PUBLIC_URL', `http://localhost:${port}`)) ?? '').replace(/\/+$/, '');

const allowedOrigins = [
  ...new Set(
    [publicUrl, ...str('ALLOWED_ORIGINS', '').split(',')]
      .map((o) => o.trim())
      .filter(Boolean)
      .map((o) => origin('ALLOWED_ORIGINS', o))
      .filter(Boolean),
  ),
];

const redisPrefix = str('REDIS_PREFIX', 'omc');
if (!/^[a-z0-9_-]+$/i.test(redisPrefix)) errors.push('REDIS_PREFIX may only contain letters, digits, _ and -');

const oidcClientId = str('OIDC_CLIENT_ID', '');
const oidcRedirectPath = str('OIDC_REDIRECT_PATH', '/auth/callback');
if (!oidcRedirectPath.startsWith('/')) errors.push('OIDC_REDIRECT_PATH must start with /');

const devLogin = bool('DEV_LOGIN', false);
const cookieSecure = bool('COOKIE_SECURE', isProd);

if (isProd) {
  if (!cookieSecure) errors.push('COOKIE_SECURE must be true in production');
  if (!oidcClientId) errors.push('OIDC_CLIENT_ID is required in production');
  if (devLogin) errors.push('DEV_LOGIN must be false in production');
}

const logLevel = str('LOG_LEVEL', isTest ? 'silent' : 'info');
if (!['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'].includes(logLevel)) {
  errors.push(`LOG_LEVEL is not a pino level (got "${logLevel}")`);
}

export const config = Object.freeze({
  env: nodeEnv,
  isProd,
  isTest,
  port,
  instanceId: str('INSTANCE_ID', os.hostname()),
  publicUrl,
  allowedOrigins,
  trustProxy: int('TRUST_PROXY', 0, { min: 0, max: 10 }),
  logLevel,
  logPretty: bool('LOG_PRETTY', !isProd && !isTest && Boolean(process.stdout.isTTY)),

  redisUrl: str('REDIS_URL', 'redis://127.0.0.1:6379'),
  redisPrefix,

  oidc: Object.freeze({
    issuer: str('OIDC_ISSUER', 'https://accounts.google.com'),
    clientId: oidcClientId,
    clientSecret: str('OIDC_CLIENT_SECRET', ''),
    redirectPath: oidcRedirectPath,
    scopes: str('OIDC_SCOPES', 'openid profile email'),
    enabled: Boolean(oidcClientId),
  }),
  devLogin,

  session: Object.freeze({
    cookieName: str('SESSION_COOKIE_NAME', 'omc_sid'),
    ttlSeconds: int('SESSION_TTL_SECONDS', 604_800, { min: 60 }),
    cookieSecure,
  }),

  board: Object.freeze({
    // fixed by the brief; the client assumes the same
    size: 1_000_000,
    cols: 1000,
    broadcastIntervalMs: int('BROADCAST_INTERVAL_MS', 50, { min: 5, max: 5000 }),
    resyncGap: int('RESYNC_GAP', 500, { min: 0 }),
    logLength: int('BOARD_LOG_LENGTH', 10_000, { min: 0 }),
  }),

  rl: Object.freeze({
    httpApiLimit: int('RL_HTTP_API_LIMIT', 120, { min: 1 }),
    httpApiWindowS: int('RL_HTTP_API_WINDOW_S', 60, { min: 1 }),
    httpAuthLimit: int('RL_HTTP_AUTH_LIMIT', 20, { min: 1 }),
    httpAuthWindowS: int('RL_HTTP_AUTH_WINDOW_S', 60, { min: 1 }),
    wsBucketCapacity: int('RL_WS_BUCKET_CAPACITY', 10, { min: 1 }),
    wsBucketRefillPerS: int('RL_WS_BUCKET_REFILL_PER_S', 5, { min: 1 }),
    wsUserLimit: int('RL_WS_USER_LIMIT', 20, { min: 1 }),
    wsUserWindowMs: int('RL_WS_USER_WINDOW_MS', 1000, { min: 100 }),
    wsStrikesToBlock: int('RL_WS_STRIKES_TO_BLOCK', 10, { min: 1 }),
    wsStrikeWindowS: int('RL_WS_STRIKE_WINDOW_S', 60, { min: 1 }),
    wsBlockSeconds: int('RL_WS_BLOCK_SECONDS', 120, { min: 1 }),
    wsBlocksToClose: int('RL_WS_BLOCKS_TO_CLOSE', 3, { min: 1 }),
    maxConnPerIp: int('RL_MAX_CONN_PER_IP', 10, { min: 1 }),
    connPerMinute: int('RL_CONN_PER_MINUTE', 30, { min: 1 }),
  }),
});

if (errors.length > 0) {
  throw new Error(`Invalid configuration:\n  - ${errors.join('\n  - ')}`);
}
