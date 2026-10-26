import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { authRouter } from './auth/routes.js';
import { config } from './config.js';
import { apiRouter } from './routes/api.js';
import { healthRouter } from './routes/health.js';
import { errorHandler, notFound } from './utils/errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../public');

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

  app.use(
    express.static(publicDir, {
      etag: true,
      maxAge: config.isProd ? '1h' : 0,
    }),
  );

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

