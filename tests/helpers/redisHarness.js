import net from 'node:net';
import { config } from '../../server/config.js';
import {
  closeRedis,
  connectRedis,
  normalizedRedisUrl,
  redis,
} from '../../server/redis/client.js';

async function isPortOpen(port = 6379, host = '127.0.0.1', timeoutMs = 800) {
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

export async function setupTestRedis() {
  const url = new URL(normalizedRedisUrl);
  const reachable = await isPortOpen(Number(url.port || 6379), url.hostname || '127.0.0.1');

  if (!reachable) {
    throw new Error(
      `Integration tests need a real Redis on REDIS_URL (${config.redisUrl}). Start it with: docker run -d -p 6379:6379 redis:7-alpine`,
    );
  }

  await connectRedis();
  return {
    mode: 'real',
    async flush() {
      const keys = await redis.keys(`${config.redisPrefix}:*`);
      if (keys.length > 0) await redis.del(...keys);
    },
    async teardown() {
      await closeRedis();
    },
  };
}
