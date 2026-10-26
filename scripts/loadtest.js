// WebSocket load & cross-instance fan-out verification script.
// Usage:
//   node scripts/loadtest.js --url=http://localhost:8080 --clients=20 --rate=5 --duration=10
//   node scripts/loadtest.js --verify --urlA=http://localhost:3001 --urlB=http://localhost:3002

import WebSocket from 'ws';
import { decodeServerFrame, encodeSet } from '../server/realtime/protocol.js';

function parseArgs() {
  const out = {
    url: process.env.LOADTEST_URL || 'http://localhost:3000',
    urlA: process.env.LOADTEST_URL_A || 'http://localhost:3001',
    urlB: process.env.LOADTEST_URL_B || 'http://localhost:3002',
    clients: 10,
    rate: 4,
    duration: 8,
    verify: false,
  };
  for (const arg of process.argv.slice(2)) {
    if (arg === '--verify') out.verify = true;
    else if (arg.startsWith('--url=')) out.url = arg.split('=')[1];
    else if (arg.startsWith('--urlA=')) out.urlA = arg.split('=')[1];
    else if (arg.startsWith('--urlB=')) out.urlB = arg.split('=')[1];
    else if (arg.startsWith('--clients=')) out.clients = Number(arg.split('=')[1]);
    else if (arg.startsWith('--rate=')) out.rate = Number(arg.split('=')[1]);
    else if (arg.startsWith('--duration=')) out.duration = Number(arg.split('=')[1]);
  }
  return out;
}

function toWsUrl(httpUrl) {
  return httpUrl.replace(/^http/, 'ws').replace(/\/+$/, '') + '/ws';
}

async function getDevCookie(baseUrl, name) {
  try {
    const res = await fetch(
      `${baseUrl.replace(/\/+$/, '')}/auth/dev-login?name=${encodeURIComponent(name)}`,
      { redirect: 'manual' },
    );
    const setCookie = res.headers.get('set-cookie');
    if (!setCookie) return '';
    return setCookie.split(';')[0];
  } catch {
    return '';
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function verifyCrossInstance(urlA, urlB) {
  console.log(`Verifying cross-instance fan-out: ${urlA} -> ${urlB}`);
  const cookie = await getDevCookie(urlA, 'Verifier');
  if (!cookie) {
    throw new Error('Could not obtain session cookie from /auth/dev-login (ensure DEV_LOGIN=true)');
  }

  const wsA = new WebSocket(toWsUrl(urlA), { headers: { Cookie: cookie, Origin: urlA } });
  const wsB = new WebSocket(toWsUrl(urlB), { headers: { Origin: urlB } });

  await Promise.all([
    new Promise((resolve, reject) => {
      wsA.once('open', resolve);
      wsA.once('error', reject);
    }),
    new Promise((resolve, reject) => {
      wsB.once('open', resolve);
      wsB.once('error', reject);
    }),
  ]);

  const targetIndex = Math.floor(Math.random() * 900_000) + 50_000;
  const startMs = performance.now();

  const receivedPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for BATCH on instance B')), 3000);
    wsB.on('message', (data, isBinary) => {
      const frame = decodeServerFrame(isBinary ? data : data.toString());
      if (frame.type === 'batch') {
        const match = frame.items.find((it) => it.index === targetIndex);
        if (match) {
          clearTimeout(timer);
          resolve(performance.now() - startMs);
        }
      }
    });
  });

  // Flip to 1 then 0 so at least one is guaranteed to be a state change
  wsA.send(encodeSet(targetIndex, 1));
  setTimeout(() => wsA.send(encodeSet(targetIndex, 0)), 25);

  const latencyMs = await receivedPromise;
  console.log(`PASS: Cross-instance update received on instance B in ${latencyMs.toFixed(1)} ms`);

  wsA.close();
  wsB.close();
}

async function runLoadTest(opts) {
  console.log(
    `Starting load test against ${opts.url} (${opts.clients} sockets, ${opts.rate} toggles/s each, ${opts.duration}s)...`,
  );

  const sockets = [];
  const sentTimes = new Map(); // index -> timestamp
  const latencies = [];
  let acks = 0;
  let batches = 0;
  let rejectsRate = 0;
  let rejectsAuth = 0;
  let rejectsBlocked = 0;

  for (let i = 0; i < opts.clients; i++) {
    const cookie = await getDevCookie(opts.url, `LoadUser-${i}`);
    const headers = { Origin: opts.url };
    if (cookie) headers.Cookie = cookie;

    const ws = new WebSocket(toWsUrl(opts.url), { headers });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    ws.on('message', (data, isBinary) => {
      const frame = decodeServerFrame(isBinary ? data : data.toString());
      if (frame.type === 'ack') {
        acks++;
      } else if (frame.type === 'batch') {
        batches++;
        const now = performance.now();
        for (const item of frame.items) {
          const t0 = sentTimes.get(item.index);
          if (t0 !== undefined) {
            latencies.push(now - t0);
            sentTimes.delete(item.index);
          }
        }
      } else if (frame.type === 'reject') {
        if (frame.code === 1) rejectsAuth++;
        else if (frame.code === 2) rejectsRate++;
        else if (frame.code === 4) rejectsBlocked++;
      }
    });

    sockets.push(ws);
  }

  const intervalMs = Math.max(10, Math.floor(1000 / opts.rate));
  let nextToggleVal = 1;

  const timer = setInterval(() => {
    for (let i = 0; i < sockets.length; i++) {
      const ws = sockets[i];
      if (ws.readyState !== WebSocket.OPEN) continue;
      const idx = (i * 50_000 + Math.floor(Math.random() * 49_999)) % 1_000_000;
      sentTimes.set(idx, performance.now());
      ws.send(encodeSet(idx, nextToggleVal));
    }
    nextToggleVal ^= 1;
  }, intervalMs);

  await new Promise((resolve) => setTimeout(resolve, opts.duration * 1000));
  clearInterval(timer);

  await new Promise((resolve) => setTimeout(resolve, 250));
  for (const ws of sockets) {
    ws.close();
  }

  latencies.sort((a, b) => a - b);
  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);

  console.log('--- Load Test Summary ---');
  console.log(`Sockets connected : ${sockets.length}`);
  console.log(`ACKs received     : ${acks}`);
  console.log(`BATCH frames      : ${batches}`);
  console.log(`Rejected (rate)   : ${rejectsRate}`);
  console.log(`Rejected (blocked): ${rejectsBlocked}`);
  console.log(`Rejected (auth)   : ${rejectsAuth}`);
  console.log(`Fan-out p50       : ${p50.toFixed(1)} ms`);
  console.log(`Fan-out p95       : ${p95.toFixed(1)} ms (target < 150 ms)`);
}

const opts = parseArgs();
if (opts.verify) {
  verifyCrossInstance(opts.urlA, opts.urlB).catch((err) => {
    console.error('Verification failed:', err.message);
    process.exit(1);
  });
} else {
  runLoadTest(opts).catch((err) => {
    console.error('Load test failed:', err.message);
    process.exit(1);
  });
}

