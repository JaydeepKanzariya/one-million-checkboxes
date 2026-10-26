// Lightweight Redis RESP2 TCP server for local Windows development when Docker/Memurai is not installed.
// Supports all commands and Lua scripts (EVAL/EVALSHA) used by One Million Checkboxes,
// so multiple Node processes (app1 on :3001, app2 on :3002, seed, loadtest) can share state
// and Pub/Sub over redis://localhost:6379 out of the box.

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.REDIS_PORT || 6379);
const HOST = process.env.REDIS_HOST || '127.0.0.1';
const DUMP_PATH = path.resolve(process.cwd(), '.redis-local-aof.json');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = path.resolve(__dirname, '../server/redis/scripts');

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

// Shared state across all TCP client connections
const kv = new Map(); // key -> Buffer
const hashes = new Map(); // key -> Map<field, string>
const zsets = new Map(); // key -> Map<member, number>
const streams = new Map(); // key -> Array<{ id, fields: [k, v, ...] }>
const expiries = new Map(); // key -> timestamp ms
const scripts = new Map(); // sha1 -> script source
const subscribers = new Map(); // channel -> Set<net.Socket>

function loadDump() {
  try {
    for (const file of ['toggle.lua', 'http_limit.lua', 'ws_limit.lua']) {
      const src = fs.readFileSync(path.join(scriptsDir, file), 'utf8');
      const sha = crypto.createHash('sha1').update(src).digest('hex');
      scripts.set(sha, src);
    }
  } catch {
    // Ignore
  }
  try {
    if (!fs.existsSync(DUMP_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(DUMP_PATH, 'utf8'));
    if (raw.kv) {
      for (const [k, b64] of Object.entries(raw.kv)) {
        kv.set(k, Buffer.from(b64, 'base64'));
      }
    }
    if (raw.hashes) {
      for (const [k, obj] of Object.entries(raw.hashes)) {
        hashes.set(k, new Map(Object.entries(obj)));
      }
    }
  } catch {
    // Ignore corrupt dump
  }
}

function saveDump() {
  try {
    const kvOut = {};
    for (const [k, buf] of kv.entries()) {
      if (!expiries.has(k)) kvOut[k] = buf.toString('base64');
    }
    const hashOut = {};
    for (const [k, map] of hashes.entries()) {
      hashOut[k] = Object.fromEntries(map.entries());
    }
    fs.writeFileSync(DUMP_PATH, JSON.stringify({ kv: kvOut, hashes: hashOut }));
  } catch {
    // Ignore
  }
}

function checkExpiry(key, now = Date.now()) {
  const exp = expiries.get(key);
  if (exp !== undefined && now >= exp) {
    delKey(key);
  }
}

function delKey(key) {
  let existed = false;
  if (kv.delete(key)) existed = true;
  if (hashes.delete(key)) existed = true;
  if (zsets.delete(key)) existed = true;
  if (streams.delete(key)) existed = true;
  expiries.delete(key);
  return existed ? 1 : 0;
}

function pttl(key, now = Date.now()) {
  checkExpiry(key, now);
  if (!kv.has(key) && !hashes.has(key) && !zsets.has(key) && !streams.has(key)) {
    return -2;
  }
  const exp = expiries.get(key);
  if (exp === undefined) return -1;
  return Math.max(1, exp - now);
}

// RESP2 Encoder
function encodeResp(val) {
  if (val === null || val === undefined) {
    return Buffer.from('$-1\r\n');
  }
  if (typeof val === 'number') {
    return Buffer.from(`:${Math.trunc(val)}\r\n`);
  }
  if (typeof val === 'boolean') {
    return Buffer.from(`:${val ? 1 : 0}\r\n`);
  }
  if (val && typeof val === 'object' && val.simple) {
    return Buffer.from(`+${val.simple}\r\n`);
  }
  if (val && typeof val === 'object' && val.error) {
    return Buffer.from(`-${val.error}\r\n`);
  }
  if (Buffer.isBuffer(val)) {
    const head = Buffer.from(`$${val.length}\r\n`);
    return Buffer.concat([head, val, Buffer.from('\r\n')]);
  }
  if (typeof val === 'string') {
    const buf = Buffer.from(val, 'utf8');
    return Buffer.concat([Buffer.from(`$${buf.length}\r\n`), buf, Buffer.from('\r\n')]);
  }
  if (Array.isArray(val)) {
    const parts = [Buffer.from(`*${val.length}\r\n`)];
    for (const item of val) {
      parts.push(encodeResp(item));
    }
    return Buffer.concat(parts);
  }
  return encodeResp(String(val));
}

// RESP2 Stream Parser
class RespParser {
  constructor(onCommand) {
    this.buf = Buffer.alloc(0);
    this.onCommand = onCommand;
  }

  feed(chunk) {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    while (this.buf.length > 0) {
      const parsed = this.parseNext(0);
      if (!parsed) break;
      this.buf = this.buf.subarray(parsed.offset);
      this.onCommand(parsed.value);
    }
  }

  readLine(offset) {
    const idx = this.buf.indexOf('\r\n', offset);
    if (idx === -1) return null;
    return {
      line: this.buf.subarray(offset, idx).toString('utf8'),
      next: idx + 2,
    };
  }

  parseNext(offset) {
    if (offset >= this.buf.length) return null;
    const prefix = this.buf[offset];

    if (prefix === 42) {
      // '*'
      const header = this.readLine(offset + 1);
      if (!header) return null;
      const count = Number(header.line);
      let cur = header.next;
      const items = [];
      for (let i = 0; i < count; i++) {
        const elem = this.parseNext(cur);
        if (!elem) return null;
        items.push(elem.value);
        cur = elem.offset;
      }
      return { value: items, offset: cur };
    }

    if (prefix === 36) {
      // '$'
      const header = this.readLine(offset + 1);
      if (!header) return null;
      const len = Number(header.line);
      if (len < 0) return { value: null, offset: header.next };
      const end = header.next + len;
      if (this.buf.length < end + 2) return null;
      const slice = Buffer.from(this.buf.subarray(header.next, end));
      return { value: slice, offset: end + 2 };
    }

    // Inline command fallback
    const lineObj = this.readLine(offset);
    if (!lineObj) return null;
    const parts = lineObj.line
      .trim()
      .split(/\s+/)
      .map((s) => Buffer.from(s));
    return { value: parts, offset: lineObj.next };
  }
}

function publishToChannel(channel, message) {
  const subs = subscribers.get(channel);
  if (!subs || subs.size === 0) return 0;
  const payload = encodeResp(['message', channel, String(message)]);
  let delivered = 0;
  for (const sock of subs) {
    if (!sock.destroyed) {
      sock.write(payload);
      delivered++;
    }
  }
  return delivered;
}

function evalLuaScript(scriptText, keysArg, argvArg) {
  const s = scriptText;
  // 1. toggle.lua
  if (s.includes('SETBIT') && s.includes('PUBLISH')) {
    const [boardKey, seqKey, countKey, logKey, userStatsKey] = keysArg;
    const idx = Number(argvArg[0]);
    const val = Number(argvArg[1]);
    const channel = argvArg[2];
    const maxLogLen = Number(argvArg[3] || 0);
    const nowMs = argvArg[4];

    const old = execCommand(['SETBIT', boardKey, String(idx), String(val)]);
    if (old === val) {
      const seq = Number(execCommand(['GET', seqKey])?.toString() || '0');
      const count = Number(execCommand(['GET', countKey])?.toString() || '0');
      return [0, seq, count];
    }

    const delta = val === 1 ? 1 : -1;
    let count = execCommand(['INCRBY', countKey, String(delta)]);
    if (count < 0) {
      execCommand(['SET', countKey, '0']);
      count = 0;
    }
    const seq = execCommand(['INCR', seqKey]);

    if (maxLogLen > 0) {
      const stream = streams.get(logKey) || [];
      stream.push({
        id: `${seq}-0`,
        fields: ['s', String(seq), 'i', String(idx), 'v', String(val)],
      });
      if (stream.length > maxLogLen) stream.splice(0, stream.length - maxLogLen);
      streams.set(logKey, stream);
    }

    if (userStatsKey) {
      execCommand(['HINCRBY', userStatsKey, 'toggles', '1']);
      execCommand(['HSET', userStatsKey, 'lastSeen', String(nowMs)]);
    }

    publishToChannel(channel, `${seq}:${idx}:${val}`);
    return [1, seq, count];
  }

  // 2. ws_limit.lua
  if (s.includes('ZREMRANGEBYSCORE') && s.includes('ZCARD')) {
    const [zKey, strikesKey, blockKey, blockCountKey] = keysArg;
    const nowMs = Number(argvArg[0]);
    const windowMs = Number(argvArg[1]);
    const limit = Number(argvArg[2]);
    const member = argvArg[3];
    const strikesToBlock = Number(argvArg[4]);
    const strikeWindowS = Number(argvArg[5]);
    const blockSeconds = Number(argvArg[6]);

    const blockTtl = pttl(blockKey, nowMs);
    if (blockTtl > 0) {
      const blocks = Number(execCommand(['GET', blockCountKey])?.toString() || '1');
      return [0, 2, blockTtl, 0, blocks];
    }

    execCommand(['ZREMRANGEBYSCORE', zKey, '0', String(nowMs - windowMs)]);
    const count = execCommand(['ZCARD', zKey]);

    if (count >= limit) {
      const strikes = execCommand(['INCR', strikesKey]);
      if (strikes === 1) {
        expiries.set(strikesKey, nowMs + strikeWindowS * 1000);
      }
      if (strikes >= strikesToBlock) {
        execCommand(['SET', blockKey, '1', 'EX', String(blockSeconds)]);
        delKey(strikesKey);
        const blocks = execCommand(['INCR', blockCountKey]);
        expiries.set(blockCountKey, nowMs + blockSeconds * 10_000);
        return [0, 2, blockSeconds * 1000, strikes, blocks];
      }

      const z = zsets.get(zKey);
      const scores = z ? [...z.values()].sort((a, b) => a - b) : [nowMs];
      const oldestScore = scores[0] ?? nowMs;
      const retryAfterMs = Math.max(1, oldestScore + windowMs - nowMs);
      const blocks = Number(execCommand(['GET', blockCountKey])?.toString() || '0');
      return [0, 1, retryAfterMs, strikes, blocks];
    }

    execCommand(['ZADD', zKey, String(nowMs), member]);
    expiries.set(zKey, nowMs + windowMs * 2);
    return [1, 0, limit - count - 1, 0, 0];
  }

  // 3. http_limit.lua
  const key = keysArg[0];
  const limit = Number(argvArg[0]);
  const ttlSeconds = Number(argvArg[1]);
  const current = execCommand(['INCR', key]);
  if (current === 1) {
    execCommand(['EXPIRE', key, String(ttlSeconds)]);
  }
  let ttlMs = pttl(key);
  if (ttlMs < 0) ttlMs = ttlSeconds * 1000;
  const allowed = current <= limit ? 1 : 0;
  return [allowed, current, ttlMs];
}

function execCommand(rawArgs, sockState = null) {
  const args = rawArgs.map((a) => (Buffer.isBuffer(a) ? a.toString('utf8') : String(a)));
  const cmd = (args[0] || '').toUpperCase();

  switch (cmd) {
    case 'PING':
      return args[1] ? args[1] : { simple: 'PONG' };
    case 'INFO':
      return 'redis_version:7.2.0\r\nrole:master\r\n';
    case 'CLIENT':
    case 'CONFIG':
      return { simple: 'OK' };
    case 'QUIT':
      return { simple: 'OK' };

    case 'MULTI':
      if (sockState) sockState.queue = [];
      return { simple: 'OK' };

    case 'EXEC': {
      if (!sockState || !sockState.queue) return [];
      const q = sockState.queue;
      sockState.queue = null;
      return q.map((qArgs) => execCommand(qArgs, null));
    }

    case 'DISCARD':
      if (sockState) sockState.queue = null;
      return { simple: 'OK' };

    case 'SCRIPT': {
      const sub = (args[1] || '').toUpperCase();
      if (sub === 'LOAD') {
        const src = args[2] || '';
        const sha = crypto.createHash('sha1').update(src).digest('hex');
        scripts.set(sha, src);
        return sha;
      }
      return { simple: 'OK' };
    }

    case 'EVAL':
    case 'EVALSHA': {
      const keyOrScript = args[1] || '';
      let scriptText = cmd === 'EVALSHA' ? scripts.get(keyOrScript) : keyOrScript;
      if (cmd === 'EVAL' && keyOrScript) {
        const sha = crypto.createHash('sha1').update(keyOrScript).digest('hex');
        scripts.set(sha, keyOrScript);
        scriptText = keyOrScript;
      }
      if (!scriptText) {
        return { error: 'NOSCRIPT No matching script. Please use EVAL.' };
      }
      const numKeys = Number(args[2] || 0);
      const keysSlice = args.slice(3, 3 + numKeys);
      const argvSlice = args.slice(3 + numKeys);
      return evalLuaScript(scriptText, keysSlice, argvSlice);
    }

    case 'GET': {
      const k = args[1];
      checkExpiry(k);
      return kv.get(k) ?? null;
    }

    case 'MGET': {
      return args.slice(1).map((k) => {
        checkExpiry(k);
        return kv.get(k) ?? null;
      });
    }

    case 'SET': {
      const k = args[1];
      const valBuf = Buffer.isBuffer(rawArgs[2]) ? Buffer.from(rawArgs[2]) : Buffer.from(args[2] || '');
      kv.set(k, valBuf);
      expiries.delete(k);
      for (let i = 3; i < args.length; i++) {
        const opt = args[i].toUpperCase();
        if (opt === 'EX' && args[i + 1]) {
          expiries.set(k, Date.now() + Number(args[i + 1]) * 1000);
          i++;
        } else if (opt === 'PX' && args[i + 1]) {
          expiries.set(k, Date.now() + Number(args[i + 1]));
          i++;
        }
      }
      return { simple: 'OK' };
    }

    case 'SETNX': {
      const k = args[1];
      checkExpiry(k);
      if (kv.has(k)) return 0;
      kv.set(k, Buffer.from(args[2] || ''));
      return 1;
    }

    case 'STRLEN': {
      const k = args[1];
      checkExpiry(k);
      const v = kv.get(k);
      return v ? v.length : 0;
    }

    case 'GETBIT': {
      const k = args[1];
      const idx = Number(args[2]);
      checkExpiry(k);
      const buf = kv.get(k);
      if (!buf) return 0;
      const byteIdx = idx >> 3;
      if (byteIdx >= buf.length) return 0;
      return (buf[byteIdx] >> (7 - (idx & 7))) & 1;
    }

    case 'SETBIT': {
      const k = args[1];
      const idx = Number(args[2]);
      const val = Number(args[3]);
      checkExpiry(k);
      const byteIdx = idx >> 3;
      let buf = kv.get(k);
      if (!buf) {
        buf = Buffer.alloc(Math.max(125_000, byteIdx + 1), 0);
        kv.set(k, buf);
      } else if (byteIdx >= buf.length) {
        const next = Buffer.alloc(byteIdx + 1, 0);
        buf.copy(next);
        buf = next;
        kv.set(k, buf);
      }
      const mask = 1 << (7 - (idx & 7));
      const old = (buf[byteIdx] & mask) !== 0 ? 1 : 0;
      if (val) buf[byteIdx] |= mask;
      else buf[byteIdx] &= ~mask;
      return old;
    }

    case 'BITCOUNT': {
      const k = args[1];
      checkExpiry(k);
      const buf = kv.get(k);
      if (!buf) return 0;
      let total = 0;
      for (let i = 0; i < buf.length; i++) total += POPCOUNT[buf[i]];
      return total;
    }

    case 'INCR':
      return execCommand(['INCRBY', args[1], '1']);
    case 'DECR':
      return execCommand(['INCRBY', args[1], '-1']);
    case 'INCRBY': {
      const k = args[1];
      const delta = Number(args[2]);
      checkExpiry(k);
      const cur = Number(kv.get(k)?.toString('utf8') || '0');
      const next = cur + delta;
      kv.set(k, Buffer.from(String(next)));
      return next;
    }

    case 'DEL': {
      let count = 0;
      for (let i = 1; i < args.length; i++) count += delKey(args[i]);
      return count;
    }

    case 'EXPIRE': {
      const k = args[1];
      const secs = Number(args[2]);
      expiries.set(k, Date.now() + secs * 1000);
      return 1;
    }

    case 'PEXPIRE': {
      const k = args[1];
      const ms = Number(args[2]);
      expiries.set(k, Date.now() + ms);
      return 1;
    }

    case 'PTTL':
      return pttl(args[1]);

    case ' TTL':
    case 'TTL': {
      const ms = pttl(args[1]);
      return ms < 0 ? ms : Math.ceil(ms / 1000);
    }

    case 'KEYS': {
      const pattern = args[1] || '*';
      const prefix = pattern.replace(/\*$/, '');
      const all = new Set([...kv.keys(), ...hashes.keys(), ...zsets.keys(), ...streams.keys()]);
      const out = [];
      for (const k of all) {
        checkExpiry(k);
        if (kv.has(k) || hashes.has(k) || zsets.has(k) || streams.has(k)) {
          if (pattern === '*' || k.startsWith(prefix)) out.push(k);
        }
      }
      return out;
    }

    case 'HSET': {
      const k = args[1];
      checkExpiry(k);
      const h = hashes.get(k) || new Map();
      let added = 0;
      for (let i = 2; i < args.length; i += 2) {
        if (!h.has(args[i])) added++;
        h.set(args[i], args[i + 1] ?? '');
      }
      hashes.set(k, h);
      return added;
    }

    case 'HGET': {
      const k = args[1];
      checkExpiry(k);
      const h = hashes.get(k);
      return h && h.has(args[2]) ? h.get(args[2]) : null;
    }

    case 'HGETALL': {
      const k = args[1];
      checkExpiry(k);
      const h = hashes.get(k);
      if (!h) return [];
      const res = [];
      for (const [f, v] of h.entries()) {
        res.push(f, v);
      }
      return res;
    }

    case 'HINCRBY': {
      const k = args[1];
      const field = args[2];
      const delta = Number(args[3]);
      checkExpiry(k);
      const h = hashes.get(k) || new Map();
      const next = Number(h.get(field) || '0') + delta;
      h.set(field, String(next));
      hashes.set(k, h);
      return next;
    }

    case 'ZADD': {
      const k = args[1];
      checkExpiry(k);
      const z = zsets.get(k) || new Map();
      let added = 0;
      for (let i = 2; i < args.length; i += 2) {
        const score = Number(args[i]);
        const member = args[i + 1];
        if (!z.has(member)) added++;
        z.set(member, score);
      }
      zsets.set(k, z);
      return added;
    }

    case 'ZREM': {
      const k = args[1];
      const z = zsets.get(k);
      if (!z) return 0;
      let removed = 0;
      for (let i = 2; i < args.length; i++) {
        if (z.delete(args[i])) removed++;
      }
      return removed;
    }

    case 'ZREMRANGEBYSCORE': {
      const k = args[1];
      const min = Number(args[2]);
      const max = Number(args[3]);
      const z = zsets.get(k);
      if (!z) return 0;
      let removed = 0;
      for (const [m, score] of z.entries()) {
        if (score >= min && score <= max) {
          z.delete(m);
          removed++;
        }
      }
      return removed;
    }

    case 'ZCARD': {
      const k = args[1];
      checkExpiry(k);
      const z = zsets.get(k);
      return z ? z.size : 0;
    }

    case 'ZRANGE': {
      const k = args[1];
      const start = Number(args[2]);
      const stop = Number(args[3]);
      const withScores = (args[4] || '').toUpperCase() === 'WITHSCORES';
      const z = zsets.get(k);
      if (!z) return [];
      const sorted = [...z.entries()].sort((a, b) => a[1] - b[1]);
      const slice = sorted.slice(start, stop < 0 ? undefined : stop + 1);
      const out = [];
      for (const [m, sc] of slice) {
        out.push(m);
        if (withScores) out.push(String(sc));
      }
      return out;
    }

    case 'XREVRANGE': {
      const k = args[1];
      const countIdx = args.findIndex((a) => a.toUpperCase() === 'COUNT');
      const count = countIdx > 0 ? Number(args[countIdx + 1]) : 100;
      const s = streams.get(k) || [];
      return s
        .slice(-count)
        .reverse()
        .map((entry) => [entry.id, entry.fields]);
    }

    case 'PUBLISH': {
      const channel = args[1];
      const message = args[2] ?? '';
      return publishToChannel(channel, message);
    }

    default:
      return { simple: 'OK' };
  }
}

export async function startLocalRedisServer() {
  loadDump();

  const server = net.createServer((socket) => {
    const sockState = { queue: null, channels: new Set() };

    const parser = new RespParser((rawArgs) => {
      if (!Array.isArray(rawArgs) || rawArgs.length === 0) return;
      const cmd = rawArgs[0].toString('utf8').toUpperCase();

      if (cmd === 'SUBSCRIBE') {
        for (let i = 1; i < rawArgs.length; i++) {
          const ch = rawArgs[i].toString('utf8');
          sockState.channels.add(ch);
          if (!subscribers.has(ch)) subscribers.set(ch, new Set());
          subscribers.get(ch).add(socket);
          socket.write(encodeResp(['subscribe', ch, sockState.channels.size]));
        }
        return;
      }

      if (cmd === 'UNSUBSCRIBE') {
        const targets =
          rawArgs.length > 1
            ? rawArgs.slice(1).map((b) => b.toString('utf8'))
            : [...sockState.channels];
        for (const ch of targets) {
          sockState.channels.delete(ch);
          subscribers.get(ch)?.delete(socket);
          socket.write(encodeResp(['unsubscribe', ch, sockState.channels.size]));
        }
        return;
      }

      if (sockState.queue && cmd !== 'EXEC' && cmd !== 'DISCARD' && cmd !== 'MULTI') {
        sockState.queue.push(rawArgs);
        socket.write(encodeResp({ simple: 'QUEUED' }));
        return;
      }

      const result = execCommand(rawArgs, sockState);
      socket.write(encodeResp(result));
    });

    socket.on('data', (chunk) => parser.feed(chunk));
    socket.on('close', () => {
      for (const ch of sockState.channels) {
        subscribers.get(ch)?.delete(socket);
      }
    });
    socket.on('error', () => {});
  });

  const saveTimer = setInterval(saveDump, 10_000);
  saveTimer.unref?.();

  return new Promise((resolve) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`[redis] Existing Redis server detected on ${HOST}:${PORT}`);
        resolve({ external: true, close: async () => {} });
      } else {
        throw err;
      }
    });
    server.listen(PORT, HOST, () => {
      console.log(`[redis] Local RESP2 server listening on redis://${HOST}:${PORT}`);
      resolve({
        external: false,
        close: async () => {
          clearInterval(saveTimer);
          saveDump();
          await new Promise((r) => server.close(r));
        },
      });
    });
  });
}

// Run standalone if invoked directly
if (process.argv[1] && process.argv[1].endsWith('dev-redis.js')) {
  startLocalRedisServer();
}

