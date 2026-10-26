import http from 'node:http';
import { createApp } from './app.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { createRealtimeServer } from './realtime/wsServer.js';
import { ensureBoardInitialized } from './redis/board.js';
import { closeRedis, connectRedis } from './redis/client.js';

async function main() {
  await connectRedis();
  await ensureBoardInitialized();

  const app = createApp();
  const httpServer = http.createServer(app);
  const realtime = createRealtimeServer(httpServer);
  await realtime.start();

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.port, () => resolve());
  });

  logger.info(
    {
      port: config.port,
      instance: config.instanceId,
      env: config.env,
      oidcEnabled: config.oidc.enabled,
      devLogin: config.devLogin,
    },
    'One Million Checkboxes server listening',
  );

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'graceful shutdown initiated');

    const forceTimer = setTimeout(() => {
      logger.error('graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, 8000);
    forceTimer.unref?.();

    try {
      await realtime.stop();
      await new Promise((resolve) => httpServer.close(() => resolve()));
      await closeRedis();
      logger.info('graceful shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => {
    logger.fatal({ err }, 'unhandled promise rejection');
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    process.exit(1);
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to boot server');
  process.exit(1);
});

