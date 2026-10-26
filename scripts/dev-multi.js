// Starts local Redis (if not already running on :6379), seeds the board,
// and launches both app1 (:3001) and app2 (:3002) in one terminal.

import { spawn } from 'node:child_process';
import { startLocalRedisServer } from './dev-redis.js';

async function main() {
  const redisSrv = await startLocalRedisServer();

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

  // Seed initial board if empty
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

  const shutdown = async () => {
    for (const c of children) {
      try {
        c.kill('SIGTERM');
      } catch {
        // Ignore
      }
    }
    await redisSrv.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

