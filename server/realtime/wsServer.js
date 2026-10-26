import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { getSession, getSessionFromCookieHeader, hashSessionId } from '../auth/sessions.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { acquireConnectionSlot, releaseConnectionSlot } from '../ratelimit/connLimiter.js';
import { TokenBucket } from '../ratelimit/tokenBucket.js';
import { Broadcaster, getInitialWelcomeState } from './broadcaster.js';
import { handleSocketMessage } from './handlers.js';
import {
  registerPresence,
  removeInstanceHeartbeat,
  unregisterPresence,
} from './presence.js';
import { encodeJson } from './protocol.js';
import { extractClientIp } from '../utils/clientIp.js';

const HEARTBEAT_INTERVAL_MS = 30_000;
const SESSION_RECHECK_INTERVAL_MS = 60_000;

function isOriginAllowed(originHeader) {
  if (!originHeader) {
    // Allow non-browser / CLI / loadtest clients when not in production, or when empty
    return !config.isProd;
  }
  try {
    const normalized = new URL(originHeader).origin;
    return config.allowedOrigins.includes(normalized);
  } catch {
    return false;
  }
}

function rejectUpgrade(socket, status, message) {
  const body = JSON.stringify({ error: { message } });
  const response = [
    `HTTP/1.1 ${status}`,
    'Content-Type: application/json; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
    'Connection: close',
    '',
    body,
  ].join('\r\n');
  try {
    socket.write(response);
  } finally {
    socket.destroy();
  }
}

export function buildWelcomePayload(ws, welcomeState) {
  return {
    t: 'welcome',
    socketId: ws.id,
    instanceId: config.instanceId,
    user: ws.user
      ? {
          userId: ws.user.userId,
          name: ws.user.name,
          picture: ws.user.picture,
        }
      : null,
    seq: welcomeState.seq,
    online: Math.max(1, welcomeState.online),
    checked: welcomeState.checked,
    limits: {
      bucketCapacity: config.rl.wsBucketCapacity,
      bucketRefillPerS: config.rl.wsBucketRefillPerS,
    },
  };
}

export function createRealtimeServer(httpServer) {
  const sockets = new Map();
  const broadcaster = new Broadcaster(sockets);

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 1024,
    perMessageDeflate: false,
  });

  httpServer.on('upgrade', async (req, socket, head) => {
    const ip = extractClientIp(req);
    let slotHeld = false;
    let upgraded = false;

    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (url.pathname !== '/ws' && url.pathname !== '/') {
        return rejectUpgrade(socket, '404 Not Found', 'Invalid WebSocket path');
      }

      if (!isOriginAllowed(req.headers.origin)) {
        logger.warn({ origin: req.headers.origin }, 'rejected ws upgrade due to origin');
        return rejectUpgrade(socket, '403 Forbidden', 'Origin not allowed');
      }

      const slot = await acquireConnectionSlot(ip);
      if (!slot.allowed) {
        return rejectUpgrade(socket, '429 Too Many Requests', 'Connection limit exceeded');
      }
      slotHeld = true;

      socket.once('close', () => {
        if (!upgraded && slotHeld) {
          slotHeld = false;
          releaseConnectionSlot(ip);
        }
      });

      const { sid, user } = await getSessionFromCookieHeader(req.headers.cookie, { touch: true });

      wss.handleUpgrade(req, socket, head, (ws) => {
        upgraded = true;
        ws.id = crypto.randomUUID();
        ws.ip = ip;
        ws.sessionId = sid;
        ws.sidHash = sid ? hashSessionId(sid) : null;
        ws.user = user;
        ws.readOnly = !user;
        ws.isAlive = true;
        ws.bucket = new TokenBucket();
        ws.blockedUntil = 0;
        ws.invalidStrikes = 0;

        wss.emit('connection', ws, req);
      });
    } catch (err) {
      if (slotHeld && !upgraded) {
        slotHeld = false;
        releaseConnectionSlot(ip);
      }
      logger.error({ err }, 'ws upgrade failed');
      rejectUpgrade(socket, '500 Internal Server Error', 'Upgrade failed');
    }
  });

  wss.on('connection', async (ws) => {
    sockets.set(ws.id, ws);

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (data, isBinary) => {
      ws.isAlive = true;
      handleSocketMessage(ws, data, isBinary).catch((err) => {
        logger.error({ err: err.message, socketId: ws.id }, 'ws message error');
      });
    });

    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      sockets.delete(ws.id);
      unregisterPresence(ws.id);
      releaseConnectionSlot(ws.ip);
      logger.debug({ socketId: ws.id, userId: ws.user?.userId || null }, 'socket disconnected');
    };

    ws.on('close', cleanup);
    ws.on('error', (err) => {
      logger.debug({ socketId: ws.id, err: err.message }, 'socket error');
      cleanup();
    });

    try {
      await registerPresence(ws.id);
      const welcomeState = await getInitialWelcomeState();
      if (ws.readyState === 1) {
        ws.send(encodeJson(buildWelcomePayload(ws, welcomeState)));
      }
      logger.debug({ socketId: ws.id, userId: ws.user?.userId || null }, 'socket connected');
    } catch (err) {
      logger.error({ err: err.message, socketId: ws.id }, 'failed welcome initialization');
    }
  });

  // 30s Ping/Pong heartbeat
  const heartbeatTimer = setInterval(() => {
    for (const ws of sockets.values()) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  // 60s Session re-validation for long-lived authenticated sockets
  const sessionTimer = setInterval(async () => {
    for (const ws of sockets.values()) {
      if (!ws.sessionId || ws.readOnly) continue;
      try {
        const session = await getSession(ws.sessionId, { touch: true });
        if (!session) {
          ws.user = null;
          ws.sessionId = null;
          ws.readOnly = true;
          if (ws.readyState === 1) {
            ws.send(encodeJson({ t: 'session_expired' }));
          }
        }
      } catch {
        // Ignore transient Redis error during session recheck
      }
    }
  }, SESSION_RECHECK_INTERVAL_MS);
  sessionTimer.unref?.();

  return {
    wss,
    sockets,
    broadcaster,
    async start() {
      await broadcaster.start();
    },
    async stop() {
      clearInterval(heartbeatTimer);
      clearInterval(sessionTimer);
      const ids = Array.from(sockets, ([id]) => id);
      await broadcaster.stop();
      for (const ws of sockets.values()) {
        try {
          ws.close(1001, 'Server shutting down');
        } catch {
          // Ignore
        }
      }
      await removeInstanceHeartbeat(ids);
      await new Promise((resolve) => wss.close(() => resolve()));
    },
  };
}

