import EventEmitter from 'node:events';
import http from 'node:http';
import net from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createApp } from '../server/app.js';
import { createSession } from '../server/auth/sessions.js';
import { config } from '../server/config.js';
import { TokenBucket } from '../server/ratelimit/tokenBucket.js';
import { Broadcaster } from '../server/realtime/broadcaster.js';
import { handleSocketMessage } from '../server/realtime/handlers.js';
import {
  REJECT_CODE,
  decodeServerFrame,
  encodeSet,
} from '../server/realtime/protocol.js';
import { buildWelcomePayload, createRealtimeServer } from '../server/realtime/wsServer.js';
import { BOARD_BYTE_LENGTH, ensureBoardInitialized } from '../server/redis/board.js';
import { setupTestRedis } from './helpers/redisHarness.js';

async function canConnectLoopback() {
  const srv = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', resolve);
    });
    const { port } = srv.address();
    const ok = await new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1', () => {
        s.destroy();
        resolve(true);
      });
      s.once('error', () => resolve(false));
    });
    return ok;
  } catch {
    return false;
  } finally {
    try {
      srv.close();
    } catch {
      // Ignore
    }
  }
}

// Helper to invoke an Express app in-memory when TCP loopback is blocked by OS sandbox
async function invokeApp(app, { method = 'GET', url = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = new http.IncomingMessage(new EventEmitter());
    req.method = method;
    req.url = url;
    req.headers = Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
    );
    req.socket = { remoteAddress: '127.0.0.1' };
    req.connection = req.socket;

    const resHeaders = {};
    const chunks = [];
    const res = {
      statusCode: 200,
      headersSent: false,
      setHeader(k, v) {
        resHeaders[k.toLowerCase()] = String(v);
      },
      getHeader(k) {
        return resHeaders[k.toLowerCase()];
      },
      removeHeader(k) {
        delete resHeaders[k.toLowerCase()];
      },
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(obj) {
        this.setHeader('content-type', 'application/json');
        this.end(Buffer.from(JSON.stringify(obj)));
        return this;
      },
      end(data) {
        this.headersSent = true;
        if (data) {
          chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
        }
        const raw = Buffer.concat(chunks);
        let body = raw;
        if ((resHeaders['content-type'] || '').includes('application/json') && raw.length > 0) {
          try {
            body = JSON.parse(raw.toString('utf8'));
          } catch {
            // Keep buffer
          }
        }
        resolve({ status: this.statusCode, headers: resHeaders, body });
      },
    };

    try {
      app.handle(req, res, (err) => {
        if (err) reject(err);
        else res.end();
      });
    } catch (err) {
      reject(err);
    }
  });
}

describe('HTTP API + WebSocket integration', () => {
  let harness;
  let app;
  let loopbackAllowed = false;
  let httpServer;
  let realtime;
  let wsUrl;

  beforeAll(async () => {
    harness = await setupTestRedis();
    await ensureBoardInitialized();
    app = createApp();
    loopbackAllowed = await canConnectLoopback();

    if (loopbackAllowed) {
      httpServer = http.createServer(app);
      realtime = createRealtimeServer(httpServer);
      await realtime.start();
      await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
      const { port } = httpServer.address();
      wsUrl = `ws://127.0.0.1:${port}/ws`;
    }
  });

  beforeEach(async () => {
    await harness.flush();
    await ensureBoardInitialized();
  });

  afterAll(async () => {
    if (realtime) await realtime.stop();
    if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
    await harness.teardown();
  });

  it('GET /healthz returns 200 ok', async () => {
    const res = loopbackAllowed
      ? await request(app).get('/healthz')
      : await invokeApp(app, { url: '/healthz' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('GET /api/board returns 125,000 bytes, X-Board-Seq and rate limit headers', async () => {
    const res = loopbackAllowed
      ? await request(app)
          .get('/api/board?raw=1')
          .set('Accept-Encoding', 'identity')
          .buffer(true)
          .parse((r, cb) => {
            const chunks = [];
            r.on('data', (c) => chunks.push(c));
            r.on('end', () => cb(null, Buffer.concat(chunks)));
          })
      : await invokeApp(app, {
          url: '/api/board?raw=1',
          headers: { 'Accept-Encoding': 'identity' },
        });

    expect(res.status).toBe(200);
    expect(res.headers['x-board-seq']).toBe('0');
    expect(res.headers['x-ratelimit-limit']).toBe(String(config.rl.httpApiLimit));
    expect(res.body.length).toBe(BOARD_BYTE_LENGTH);
  });

  it('GET /api/me reflects anonymous vs authenticated session cookie', async () => {
    const anon = loopbackAllowed
      ? await request(app).get('/api/me')
      : await invokeApp(app, { url: '/api/me' });
    expect(anon.status).toBe(200);
    expect(anon.body.authenticated).toBe(false);

    const { sid } = await createSession({
      userId: 'google:123',
      name: 'Grace Hopper',
      email: 'grace@navy.mil',
    });

    const cookieHeader = `${config.session.cookieName}=${sid}`;
    const authed = loopbackAllowed
      ? await request(app).get('/api/me').set('Cookie', cookieHeader)
      : await invokeApp(app, { url: '/api/me', headers: { Cookie: cookieHeader } });

    expect(authed.status).toBe(200);
    expect(authed.body.authenticated).toBe(true);
    expect(authed.body.user.name).toBe('Grace Hopper');
  });

  it('rejects unauthenticated WebSocket SET with REJECT code=1 (AUTH)', async () => {
    if (loopbackAllowed) {
      const ws = new WebSocket(wsUrl);
      const welcomePromise = new Promise((resolve) => {
        ws.on('message', (data, isBinary) => {
          const decoded = decodeServerFrame(isBinary ? data : data.toString());
          if (decoded.type === 'json' && decoded.message.t === 'welcome') {
            resolve(decoded.message);
          }
        });
      });

      const rejectFramePromise = new Promise((resolve) => {
        ws.on('message', (data, isBinary) => {
          const decoded = decodeServerFrame(isBinary ? data : data.toString());
          if (decoded.type === 'reject') resolve(decoded);
        });
      });

      await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });

      const welcome = await welcomePromise;
      expect(welcome.limits.bucketCapacity).toBe(config.rl.wsBucketCapacity);
      expect(welcome.limits.bucketRefillPerS).toBe(config.rl.wsBucketRefillPerS);

      ws.send(encodeSet(42, 1));
      const rejected = await rejectFramePromise;
      expect(rejected).toEqual({
        type: 'reject',
        index: 42,
        code: REJECT_CODE.AUTH,
      });
      ws.close();
      return;
    }

    const sent = [];
    const fakeWs = {
      id: 'sock-anon',
      readyState: 1,
      user: null,
      readOnly: true,
      bucket: new TokenBucket(),
      send(buf) {
        sent.push(decodeServerFrame(buf));
      },
    };
    const welcome = buildWelcomePayload(fakeWs, { seq: 0, online: 1, checked: 0 });
    expect(welcome.limits.bucketCapacity).toBe(config.rl.wsBucketCapacity);
    expect(welcome.limits.bucketRefillPerS).toBe(config.rl.wsBucketRefillPerS);

    await handleSocketMessage(fakeWs, encodeSet(42, 1), true);
    expect(sent[0]).toEqual({ type: 'reject', index: 42, code: REJECT_CODE.AUTH });
  });

  it('accepts authenticated WebSocket SET, sends ACK and broadcasts BATCH to watchers', async () => {
    const { sid, session } = await createSession({
      userId: 'user-writer',
      name: 'Writer',
    });

    if (loopbackAllowed) {
      const writer = new WebSocket(wsUrl, {
        headers: { Cookie: `${config.session.cookieName}=${sid}` },
      });
      const watcher = new WebSocket(wsUrl);

      await Promise.all([
        new Promise((resolve) => writer.once('open', resolve)),
        new Promise((resolve) => watcher.once('open', resolve)),
      ]);

      const ackPromise = new Promise((resolve) => {
        writer.on('message', (data, isBinary) => {
          const frame = decodeServerFrame(isBinary ? data : data.toString());
          if (frame.type === 'ack') resolve(frame);
        });
      });

      const batchPromise = new Promise((resolve) => {
        watcher.on('message', (data, isBinary) => {
          const frame = decodeServerFrame(isBinary ? data : data.toString());
          if (frame.type === 'batch') resolve(frame);
        });
      });

      writer.send(encodeSet(123456, 1));
      const [ack, batch] = await Promise.all([ackPromise, batchPromise]);
      expect(ack).toEqual({ type: 'ack', index: 123456, value: 1, seq: 1 });
      expect(batch.fromSeq).toBe(1);
      expect(batch.items).toContainEqual({ index: 123456, value: 1 });

      writer.close();
      watcher.close();
      return;
    }

    const sockets = new Map();
    const broadcaster = new Broadcaster(sockets);
    await broadcaster.start();

    const writerFrames = [];
    const watcherFrames = [];
    const writerWs = {
      id: 'sock-writer',
      readyState: 1,
      bufferedAmount: 0,
      user: session,
      readOnly: false,
      bucket: new TokenBucket(),
      send(buf) {
        writerFrames.push(decodeServerFrame(buf));
      },
    };
    const watcherWs = {
      id: 'sock-watcher',
      readyState: 1,
      bufferedAmount: 0,
      user: null,
      readOnly: true,
      bucket: new TokenBucket(),
      send(buf) {
        watcherFrames.push(decodeServerFrame(buf));
      },
    };
    sockets.set(writerWs.id, writerWs);
    sockets.set(watcherWs.id, watcherWs);

    await handleSocketMessage(writerWs, encodeSet(123456, 1), true);
    broadcaster.flushBatch();
    await broadcaster.stop();

    const ack = writerFrames.find((f) => f.type === 'ack');
    const batch = watcherFrames.find((f) => f.type === 'batch');
    expect(ack).toEqual({ type: 'ack', index: 123456, value: 1, seq: 1 });
    expect(batch.fromSeq).toBe(1);
    expect(batch.items).toContainEqual({ index: 123456, value: 1 });
  });
});
