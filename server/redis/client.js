import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Redis from 'ioredis';
import { startLocalRedisServer } from '../../scripts/dev-redis.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = path.join(__dirname, 'scripts');

const toggleScript = fs.readFileSync(path.join(scriptsDir, 'toggle.lua'), 'utf8');
const httpLimitScript = fs.readFileSync(path.join(scriptsDir, 'http_limit.lua'), 'utf8');
const wsLimitScript = fs.readFileSync(path.join(scriptsDir, 'ws_limit.lua'), 'utf8');

// Normalize localhost -> 127.0.0.1 on Windows so Node v24 doesn't fail on IPv6 ::1
const normalizedRedisUrl = config.redisUrl.replace('://localhost:', '://127.0.0.1:');

function createClient(name) {
  const client = new Redis(normalizedRedisUrl, {
    lazyConnect: true,
    family: 4,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    connectionName: `${config.redisPrefix}:${config.instanceId}:${name}`,
    retryStrategy(times) {
      return Math.min(times * 200, 3000);
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

let embeddedRedis = null;

async function isPortReachable(port, host = '127.0.0.1', timeoutMs = 300) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });
}

export async function connectRedis() {
  if (!config.isProd) {
    try {
      const parsed = new URL(normalizedRedisUrl);
      const host = parsed.hostname || '127.0.0.1';
      const port = Number(parsed.port || 6379);
      if ((host === '127.0.0.1' || host === 'localhost') && port === 6379) {
        const up = await isPortReachable(port, '127.0.0.1');
        if (!up && !embeddedRedis) {
          embeddedRedis = await startLocalRedisServer();
        }
      }
    } catch {
      // Ignore URL parse error
    }
  }

  if (redis.status === 'wait') await redis.connect();
  if (subscriber.status === 'wait') await subscriber.connect();
}

export function isRedisReady() {
  return redis.status === 'ready' && subscriber.status === 'ready';
}

export async function closeRedis() {
  await Promise.allSettled([
    subscriber.status !== 'end' ? subscriber.quit() : Promise.resolve(),
    redis.status !== 'end' ? redis.quit() : Promise.resolve(),
  ]);
  if (embeddedRedis) {
    await embeddedRedis.close();
    embeddedRedis = null;
  }
}
