// Launches both app1 (:3001) and app2 (:3002) against an existing Redis instance.

import { spawn } from 'node:child_process';
import net from 'node:net';
import { config } from '../server/config.js';
import { normalizedRedisUrl } from '../server/redis/client.js';

async function isRedisReachable() {
  const parsed = new URL(normalizedRedisUrl);
  const host = parsed.hostname || '127.0.0.1';
  const port = Number(parsed.port || 6379);

  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(800);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });
}

async function main() {
  const ok = await isRedisReachable();
  if (!ok) {
    console.error(
      `Cannot reach Redis at ${config.redisUrl}. Start it with: docker run -d -p 6379:6379 redis:7-alpine`,
    );
    process.exit(1);
  }

  const children = [];
  function spawnNode(label, script, envOverrides = {}) {
    const child = spawn(process.execPath, [script], {
      stdio: 'inherit',
      env: { ...process.env, DEV_LOGIN: 'true', ...envOverrides },
    });
    children.push(child);
    child.on('exit', (code) => {
      if (code && code !== 0) {
        console.error(`[${label}] exited with code ${code}`);
      }
    });
    return child;
  }

  await new Promise((resolve) => {
    const seed = spawn(process.execPath, ['scripts/seed.js'], {
      stdio: 'inherit',
      env: { ...process.env },
    });
    seed.on('exit', () => resolve());
  });

  console.log('\nStarting multi-instance cluster:');
  console.log('  -> Instance 1 (app1): http://localhost:3001');
  console.log('  -> Instance 2 (app2): http://localhost:3002\n');

  spawnNode('app1', 'server/index.js', {
    PORT: '3001',
    INSTANCE_ID: 'app1',
    PUBLIC_URL: 'http://localhost:3001',
  });

  spawnNode('app2', 'server/index.js', {
    PORT: '3002',
    INSTANCE_ID: 'app2',
    PUBLIC_URL: 'http://localhost:3002',
  });

  const shutdown = () => {
    for (const c of children) {
      try {
        c.kill('SIGTERM');
      } catch {
        // Ignore
      }
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
