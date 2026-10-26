import EventEmitter from 'node:events';
import net from 'node:net';
import { BOARD_BYTE_LENGTH } from '../../server/redis/board.js';
import { closeRedis, connectRedis, redis, subscriber } from '../../server/redis/client.js';

const POPCOUNT = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let n = i;
  let c = 0;
  while (n) {
    n &= n - 1;
    c++;
  }
  POPCOUNT[i] = c;
}

async function isPortOpen(port = 6379, host = '127.0.0.1', timeoutMs = 400) {
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

class InMemoryStore {
  constructor() {
    this.kv = new Map();
    this.hashes = new Map();
    this.zsets = new Map();
    this.streams = new Map();
    this.expiries = new Map();
    this.bus = new EventEmitter();
  }

  checkExpiry(key, now = Date.now()) {
    const exp = this.expiries.get(key);
    if (exp !== undefined && now >= exp) {
      this.del(key);
    }
  }

  del(...keysToDelete) {
    let removed = 0;
    for (const k of keysToDelete) {
      if (
        this.kv.delete(k) ||
        this.hashes.delete(k) ||
        this.zsets.delete(k) ||
        this.streams.delete(k)
      ) {
        removed++;
      }
      this.expiries.delete(k);
    }
    return removed;
  }

  flushdb() {
    this.kv.clear();
    this.hashes.clear();
    this.zsets.clear();
    this.streams.clear();
    this.expiries.clear();
  }

  pttl(key, now = Date.now()) {
    this.checkExpiry(key, now);
    if (
      !this.kv.has(key) &&
      !this.hashes.has(key) &&
      !this.zsets.has(key) &&
      !this.streams.has(key)
    ) {
      return -2;
    }
    const exp = this.expiries.get(key);
    if (exp === undefined) return -1;
    return Math.max(1, exp - now);
  }
}

export async function setupTestRedis() {
  const url = new URL(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
  const reachable = await isPortOpen(Number(url.port || 6379), url.hostname || '127.0.0.1');

  if (reachable) {
    await connectRedis();
    return {
      mode: 'real',
      async flush() {
        const keys = await redis.keys('omc*');
        if (keys.length > 0) await redis.del(...keys);
      },
      async teardown() {
        await closeRedis();
      },
    };
  }

  // Fallback in-memory Redis + Lua shim when no local Redis daemon is running
  const store = new InMemoryStore();

  Object.defineProperty(redis, 'status', { value: 'ready', configurable: true });
  Object.defineProperty(subscriber, 'status', { value: 'ready', configurable: true });

  redis.ping = async () => 'PONG';
  redis.get = async (k) => {
    store.checkExpiry(k);
    const v = store.kv.get(k);
    if (v === undefined) return null;
    return Buffer.isBuffer(v) ? v.toString('utf8') : String(v);
  };
  redis.getBuffer = async (k) => {
    store.checkExpiry(k);
    const v = store.kv.get(k);
    if (v === undefined) return null;
    return Buffer.isBuffer(v) ? Buffer.from(v) : Buffer.from(String(v));
  };
  redis.mget = async (...args) => {
    const list = Array.isArray(args[0]) ? args[0] : args;
    return Promise.all(list.map((k) => redis.get(k)));
  };
  redis.set = async (k, v, mode, ttl) => {
    store.kv.set(k, Buffer.isBuffer(v) ? Buffer.from(v) : String(v));
    if (mode === 'EX' && ttl) {
      store.expiries.set(k, Date.now() + Number(ttl) * 1000);
    }
    return 'OK';
  };
  redis.setnx = async (k, v) => {
    store.checkExpiry(k);
    if (store.kv.has(k)) return 0;
    store.kv.set(k, String(v));
    return 1;
  };
  redis.strlen = async (k) => {
    const v = store.kv.get(k);
    if (!v) return 0;
    return Buffer.isBuffer(v) ? v.length : Buffer.byteLength(String(v));
  };
  redis.getbit = async (k, idx) => {
    const buf = store.kv.get(k);
    if (!Buffer.isBuffer(buf)) return 0;
    const byteIdx = idx >> 3;
    if (byteIdx >= buf.length) return 0;
    return (buf[byteIdx] >> (7 - (idx & 7))) & 1;
  };
  redis.setbit = async (k, idx, val) => {
    const byteIdx = idx >> 3;
    let buf = store.kv.get(k);
    if (!Buffer.isBuffer(buf)) {
      buf = Buffer.alloc(Math.max(BOARD_BYTE_LENGTH, byteIdx + 1), 0);
      store.kv.set(k, buf);
    } else if (byteIdx >= buf.length) {
      const next = Buffer.alloc(byteIdx + 1, 0);
      buf.copy(next);
      buf = next;
      store.kv.set(k, buf);
    }
    const mask = 1 << (7 - (idx & 7));
    const old = (buf[byteIdx] & mask) !== 0 ? 1 : 0;
    if (val) buf[byteIdx] |= mask;
    else buf[byteIdx] &= ~mask;
    return old;
  };
  redis.bitcount = async (k) => {
    const buf = store.kv.get(k);
    if (!Buffer.isBuffer(buf)) return 0;
    let total = 0;
    for (let i = 0; i < buf.length; i++) total += POPCOUNT[buf[i]];
    return total;
  };
  redis.incr = async (k) => redis.incrby(k, 1);
  redis.decr = async (k) => redis.incrby(k, -1);
  redis.incrby = async (k, delta) => {
    store.checkExpiry(k);
    const next = Number(store.kv.get(k) || 0) + Number(delta);
    store.kv.set(k, String(next));
    return next;
  };
  redis.expire = async (k, secs) => {
    store.expiries.set(k, Date.now() + Number(secs) * 1000);
    return 1;
  };
  redis.pexpire = async (k, ms) => {
    store.expiries.set(k, Date.now() + Number(ms));
    return 1;
  };
  redis.pttl = async (k) => store.pttl(k);
  redis.del = async (...ks) => store.del(...ks);
  redis.keys = async (pattern) => {
    const prefix = pattern.replace(/\*$/, '');
    const all = new Set([...store.kv.keys(), ...store.hashes.keys(), ...store.zsets.keys()]);
    return [...all].filter((k) => k.startsWith(prefix));
  };
  redis.hset = async (k, fieldOrObj, val) => {
    const h = store.hashes.get(k) || {};
    if (typeof fieldOrObj === 'object') {
      Object.assign(h, fieldOrObj);
    } else {
      h[fieldOrObj] = String(val);
    }
    store.hashes.set(k, h);
    return 1;
  };
  redis.hget = async (k, field) => {
    store.checkExpiry(k);
    const h = store.hashes.get(k);
    return h && field in h ? h[field] : null;
  };
  redis.hgetall = async (k) => {
    store.checkExpiry(k);
    return { ...(store.hashes.get(k) || {}) };
  };
  redis.hincrby = async (k, field, delta) => {
    const h = store.hashes.get(k) || {};
    const next = Number(h[field] || 0) + Number(delta);
    h[field] = String(next);
    store.hashes.set(k, h);
    return next;
  };
  redis.zadd = async (k, ...args) => {
    const z = store.zsets.get(k) || new Map();
    for (let i = 0; i < args.length; i += 2) {
      z.set(String(args[i + 1]), Number(args[i]));
    }
    store.zsets.set(k, z);
    return 1;
  };
  redis.zrem = async (k, ...members) => {
    const z = store.zsets.get(k);
    if (!z) return 0;
    let c = 0;
    for (const m of members) if (z.delete(String(m))) c++;
    return c;
  };
  redis.zremrangebyscore = async (k, min, max) => {
    const z = store.zsets.get(k);
    if (!z) return 0;
    for (const [m, score] of z.entries()) {
      if (score >= Number(min) && score <= Number(max)) z.delete(m);
    }
    return 1;
  };
  redis.zcard = async (k) => {
    store.checkExpiry(k);
    const z = store.zsets.get(k);
    return z ? z.size : 0;
  };
  redis.xrevrange = async (k, _max, _min, _countWord, count) => {
    const s = store.streams.get(k) || [];
    return s.slice(-count).reverse();
  };
  redis.publish = async (ch, msg) => {
    store.bus.emit('message', ch, String(msg));
    return 1;
  };
  redis.multi = () => {
    const ops = [];
    const chain = {
      getBuffer: (k) => (ops.push(() => redis.getBuffer(k)), chain),
      get: (k) => (ops.push(() => redis.get(k)), chain),
      set: (...a) => (ops.push(() => redis.set(...a)), chain),
      del: (...a) => (ops.push(() => redis.del(...a)), chain),
      hset: (...a) => (ops.push(() => redis.hset(...a)), chain),
      hgetall: (k) => (ops.push(() => redis.hgetall(k)), chain),
      expire: (...a) => (ops.push(() => redis.expire(...a)), chain),
      zadd: (...a) => (ops.push(() => redis.zadd(...a)), chain),
      zrem: (...a) => (ops.push(() => redis.zrem(...a)), chain),
      zremrangebyscore: (...a) => (ops.push(() => redis.zremrangebyscore(...a)), chain),
      zcard: (k) => (ops.push(() => redis.zcard(k)), chain),
      async exec() {
        const out = [];
        for (const fn of ops) {
          out.push([null, await fn()]);
        }
        return out;
      },
    };
    return chain;
  };

  // Lua commands
  redis.toggleBitLua = async (
    boardKey,
    seqKey,
    countKey,
    logKey,
    userStatsKey,
    index,
    bit,
    channel,
    maxLogLen,
    nowMs,
  ) => {
    const idx = Number(index);
    const val = Number(bit);
    const old = await redis.setbit(boardKey, idx, val);
    if (old === val) {
      const seq = Number((await redis.get(seqKey)) || 0);
      const count = Number((await redis.get(countKey)) || 0);
      return [0, seq, count];
    }
    const delta = val === 1 ? 1 : -1;
    let count = await redis.incrby(countKey, delta);
    if (count < 0) {
      await redis.set(countKey, '0');
      count = 0;
    }
    const seq = await redis.incr(seqKey);
    if (Number(maxLogLen) > 0) {
      const s = store.streams.get(logKey) || [];
      s.push([`${seq}-0`, ['s', String(seq), 'i', String(idx), 'v', String(val)]]);
      store.streams.set(logKey, s.slice(-Number(maxLogLen)));
    }
    if (userStatsKey) {
      await redis.hincrby(userStatsKey, 'toggles', 1);
      await redis.hset(userStatsKey, { lastSeen: String(nowMs) });
    }
    await redis.publish(channel, `${seq}:${idx}:${val}`);
    return [1, seq, count];
  };

  redis.httpLimitLua = async (key, limit, ttlSeconds) => {
    const current = await redis.incr(key);
    if (current === 1) {
      await redis.expire(key, ttlSeconds);
    }
    let ttlMs = await redis.pttl(key);
    if (ttlMs < 0) ttlMs = Number(ttlSeconds) * 1000;
    const allowed = current <= Number(limit) ? 1 : 0;
    return [allowed, current, ttlMs];
  };

  redis.wsLimitLua = async (
    zKey,
    strikesKey,
    blockKey,
    blockCountKey,
    nowMsRaw,
    windowMsRaw,
    limitRaw,
    member,
    strikesToBlockRaw,
    strikeWindowSRaw,
    blockSecondsRaw,
  ) => {
    const nowMs = Number(nowMsRaw);
    const windowMs = Number(windowMsRaw);
    const limit = Number(limitRaw);
    const strikesToBlock = Number(strikesToBlockRaw);
    const strikeWindowS = Number(strikeWindowSRaw);
    const blockSeconds = Number(blockSecondsRaw);

    const blockTtl = store.pttl(blockKey, nowMs);
    if (blockTtl > 0) {
      const blocks = Number((await redis.get(blockCountKey)) || 1);
      return [0, 2, blockTtl, 0, blocks];
    }

    await redis.zremrangebyscore(zKey, 0, nowMs - windowMs);
    const z = store.zsets.get(zKey) || new Map();
    const count = z.size;

    if (count >= limit) {
      const strikes = await redis.incr(strikesKey);
      if (strikes === 1) {
        store.expiries.set(strikesKey, nowMs + strikeWindowS * 1000);
      }
      if (strikes >= strikesToBlock) {
        store.kv.set(blockKey, '1');
        store.expiries.set(blockKey, nowMs + blockSeconds * 1000);
        store.del(strikesKey);
        const blocks = await redis.incr(blockCountKey);
        store.expiries.set(blockCountKey, nowMs + blockSeconds * 10_000);
        return [0, 2, blockSeconds * 1000, strikes, blocks];
      }
      const scores = [...z.values()].sort((a, b) => a - b);
      const oldestScore = scores[0] ?? nowMs;
      const retryAfterMs = Math.max(1, oldestScore + windowMs - nowMs);
      const blocks = Number((await redis.get(blockCountKey)) || 0);
      return [0, 1, retryAfterMs, strikes, blocks];
    }

    await redis.zadd(zKey, nowMs, member);
    store.expiries.set(zKey, nowMs + windowMs * 2);
    return [1, 0, limit - count - 1, 0, 0];
  };

  subscriber.subscribe = async () => 1;
  subscriber.unsubscribe = async () => 1;
  store.bus.on('message', (ch, msg) => subscriber.emit('message', ch, msg));

  return {
    mode: 'memory',
    async flush() {
      store.flushdb();
    },
    async teardown() {},
  };
}

