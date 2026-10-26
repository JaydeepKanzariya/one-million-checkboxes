import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Redis from 'ioredis';
import { config } from '../config.js';
import { logger } from '../logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = path.join(__dirname, 'scripts');

const toggleScript = fs.readFileSync(path.join(scriptsDir, 'toggle.lua'), 'utf8');
const httpLimitScript = fs.readFileSync(path.join(scriptsDir, 'http_limit.lua'), 'utf8');
const wsLimitScript = fs.readFileSync(path.join(scriptsDir, 'ws_limit.lua'), 'utf8');
const strikeScript = fs.readFileSync(path.join(scriptsDir, 'strike.lua'), 'utf8');

// Normalize localhost -> 127.0.0.1 on Windows so Node v24 doesn't fail on IPv6 ::1
export const normalizedRedisUrl = config.redisUrl.replace('://localhost:', '://127.0.0.1:');

function createClient(name) {
  const client = new Redis(normalizedRedisUrl, {
    lazyConnect: true,
    family: 4,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    connectionName: `${config.redisPrefix}:${config.instanceId}:${name}`,
    retryStrategy(times) {
      if (times > 5) return null;
      return Math.min(times * 200, 2000);
    },
  });

  client.on('connect', () => logger.debug({ redis: name }, 'redis connecting'));
  client.on('ready', () => logger.info({ redis: name }, 'redis ready'));
  client.on('error', (err) => logger.error({ redis: name, err: err.message }, 'redis error'));
  client.on('close', () => logger.warn({ redis: name }, 'redis connection closed'));

  return client;
}

export const redis = createClient('main');
export const subscriber = createClient('sub');

redis.defineCommand('toggleBitLua', {
  numberOfKeys: 5,
  lua: toggleScript,
});

redis.defineCommand('httpLimitLua', {
  numberOfKeys: 1,
  lua: httpLimitScript,
});

redis.defineCommand('wsLimitLua', {
  numberOfKeys: 4,
  lua: wsLimitScript,
});

redis.defineCommand('strikeLua', {
  numberOfKeys: 3,
  lua: strikeScript,
});

export async function connectRedis() {
  try {
    if (redis.status === 'wait') await redis.connect();
    if (subscriber.status === 'wait') await subscriber.connect();
  } catch (err) {
    logger.fatal(
      { url: config.redisUrl, err: err.message },
      `Cannot reach Redis at ${config.redisUrl}. Start it with: docker run -d -p 6379:6379 redis:7-alpine`,
    );
    throw new Error(
      `Cannot reach Redis at ${config.redisUrl}. Start it with: docker run -d -p 6379:6379 redis:7-alpine`,
    );
  }
}

export function isRedisReady() {
  return redis.status === 'ready' && subscriber.status === 'ready';
}

export async function closeRedis() {
  await Promise.allSettled([
    subscriber.status !== 'end' ? subscriber.quit() : Promise.resolve(),
    redis.status !== 'end' ? redis.quit() : Promise.resolve(),
  ]);
}
