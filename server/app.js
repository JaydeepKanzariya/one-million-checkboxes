import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { authRouter } from './auth/routes.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { apiRouter } from './routes/api.js';
import { healthRouter } from './routes/health.js';
import { errorHandler, notFound } from './utils/errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The React client, built by `npm run build`. In development use `npm run dev:client` instead.
const clientDir = path.resolve(__dirname, '../client/dist');
const clientBuilt = fs.existsSync(path.join(clientDir, 'index.html'));

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  if (config.trustProxy > 0) {
    app.set('trust proxy', config.trustProxy);
  }

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com'],
          imgSrc: ["'self'", 'data:', 'https:'],
          connectSrc: ["'self'", 'ws:', 'wss:'],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          frameAncestors: ["'none'"],
          ...(config.isProd ? { upgradeInsecureRequests: [] } : {}),
        },
      },
      crossOriginEmbedderPolicy: false,
      crossOriginOpenerPolicy: false,
      originAgentCluster: false,
    }),
  );

  app.use((req, res, next) => {
    res.setHeader('X-Instance-Id', config.instanceId);
    next();
  });

  app.use(express.json({ limit: '16kb' }));
  app.use(express.urlencoded({ extended: false, limit: '16kb' }));

  app.use(healthRouter);
  app.use('/auth', authRouter);
  app.use('/api', apiRouter);

  if (clientBuilt) {
    // Hashed asset files never change, so they can be cached for a long time; index.html cannot.
    app.use(
      '/assets',
      express.static(path.join(clientDir, 'assets'), { immutable: true, maxAge: config.isProd ? '1y' : 0 }),
    );
    app.use(express.static(clientDir, { etag: true, maxAge: 0 }));
  } else if (!config.isTest) {
    logger.warn('client/dist not found: run `npm run build`, or `npm run dev:client` for development');
    app.get('/', (_req, res) => {
      res
        .status(503)
        .type('text/plain')
        .send('The web client is not built. Run `npm run build`, or `npm run dev:client` and open http://localhost:5173.');
    });
  }

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

