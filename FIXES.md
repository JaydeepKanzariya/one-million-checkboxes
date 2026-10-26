# Fix list: One Million Checkboxes

This is a review of the whole codebase against `PROJECT.md`. Each fix has an ID (F1, F2, …), the files involved, what is wrong, what to change, and how to check it is done.

**Rules for whoever applies these fixes**

- Work through the fixes in the order below. Put the fix ID in each commit message (`F3: client sequencer`).
- Don't change behaviour that isn't listed here. Keep the existing code style: ES modules, small modules, the same comment density.
- Line numbers are from the review snapshot and will drift. Find code by the function name given.
- After each group of fixes, run `npm test` against a **real** Redis (see F2).

---

## F0. Put the project under git first (do this before anything else)

There is no git repository yet. Without one, the changes can't be reviewed as a diff.

```bash
git init
git add -A
git commit -m "Baseline before review fixes"
```

Check that `.env` is **not** in the commit (it's listed in `.gitignore`). Then make one commit per fix ID.

---

## Must fix

### F1. Tests interfere with each other when run in parallel

**Files:** new `vitest.config.js`, [tests/helpers/redisHarness.js](tests/helpers/redisHarness.js)

**Problem:** Every test file calls `harness.flush()`, which deletes all `omc*` keys on the same Redis. Vitest runs the files in parallel, so one file wipes another file's data partway through. `tests/board.test.js` passes on its own but fails in the full run.

**Fix:** Add `vitest.config.js`:

```js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    env: { NODE_ENV: 'test', REDIS_PREFIX: 'omctest' },
  },
});
```

Then change `flush()` in the harness to delete only `${config.redisPrefix}:*` keys, never `omc*`. That way running the tests can't wipe a dev board.

**Done when:** `npm test` passes several runs in a row.

---

### F2. Remove the fake Redis (both copies)

**Files:**

- [server/redis/client.js](server/redis/client.js): the import on line 6 and the auto-start block in `connectRedis()` (lines 78–93), plus `isPortReachable`
- [scripts/dev-redis.js](scripts/dev-redis.js): delete the file
- [scripts/dev-multi.js](scripts/dev-multi.js)
- [tests/helpers/redisHarness.js](tests/helpers/redisHarness.js): the `InMemoryStore` fallback
- `package.json`, `.gitignore`, `.redis-local-aof.json`, `README.md`

**Problem:**

- `server/redis/client.js` imports `scripts/dev-redis.js`. Outside production, if port 6379 is free, the server quietly starts a 750-line JS imitation of Redis that reports itself as `redis_version:7.2.0`.
- That imitation doesn't run the Lua scripts. It checks the script text (`s.includes('SETBIT')`) and runs a hand-written JS copy instead. That copy behaves differently from real Redis: `ws_limit` sets expiry using the absolute client clock, which is why `tests/wsLimiter.test.js` fails.
- The test harness monkeypatches `redis.*` with a second fake when Redis isn't reachable.
- So none of the tests that claim to test the Lua scripts actually test them. The project's main "Redis + Lua atomicity" claim rests on code that never runs.

**Fix:**

1. Delete `scripts/dev-redis.js` and `.redis-local-aof.json`. Remove the `.redis-local-aof.json` line from `.gitignore`.
2. In `server/redis/client.js`, drop the import, the `embeddedRedis` variable, `isPortReachable`, and the auto-start branch. `connectRedis()` just connects. If Redis is down, startup fails with a clear log message: `Cannot reach Redis at <url>. Start it with: docker run -d -p 6379:6379 redis:7-alpine`.
3. Keep the `localhost` → `127.0.0.1` normalisation (it's a real Windows IPv6 workaround).
4. In `scripts/dev-multi.js`, don't start Redis. Fail with the same message if 6379 isn't reachable.
5. In `package.json`:
   - Remove `redis:local`.
   - Add `"redis": "docker run -d --name omc-redis -p 6379:6379 redis:7-alpine --appendonly yes"`.
   - Remove the misleading `start:app1` script (it actually runs `dev-multi`).
6. In `tests/helpers/redisHarness.js`, delete `InMemoryStore` and the whole monkeypatch fallback. If Redis isn't reachable, throw `Integration tests need a real Redis on REDIS_URL`. Don't skip silently.
7. In the README, under "without Docker" for Windows, list Docker Desktop, WSL (`sudo apt install redis-server`) or Memurai.

**Done when:**

- `grep -r "dev-redis\|InMemoryStore" server tests scripts` returns nothing.
- `npm test` is fully green against `redis:7-alpine`, and that includes `wsLimiter.test.js`.

> Before testing, the user needs to stop the Node process currently listening on port 6379. That's the old fake.

---

### F3. Client sequence handling: lost updates, wrong `lastSeq`, out-of-order replay

**Files:** [public/js/main.js](public/js/main.js), [public/js/socket.js](public/js/socket.js), new `public/js/sequencer.js`, new `tests/sequencer.test.js`

**Problems:** These three bugs together break the "every client converges" guarantee.

1. **Lost updates.** `onAck` raises `snapshotSeq` to the ACK's seq (main.js:122). `applyRemoteUpdate` then drops every update with `seq <= snapshotSeq` (main.js:54). ACKs arrive straight away, but batches arrive up to 50 ms later. So other users' changes with a lower seq than your own ACK are thrown away, and an active clicker's board drifts out of sync.
2. **`lastSeq` runs ahead of the data.** `socket.js:55` copies `seq` from **every** JSON message (`welcome`, `stats`), and `socket.js:45` copies it from ACKs. Those numbers are Redis's current seq, not what this client has applied. On reconnect, `hello{lastSeq}` then skips updates the client never got.
3. **Out-of-order replay.** After a reconnect, the server replies to `hello` asynchronously ([handlers.js](server/realtime/handlers.js) `handleJsonControl`). Live batches with higher seqs can arrive first, and the replay (older values) then overwrites newer state.

(Related: rapid double clicks on one cell lose the rollback state, because `pendingToggles` keeps only one entry per cell and the first ACK deletes it.)

**Fix:** Add one sequencer that owns `appliedSeq`. Make it a pure module with no DOM access, so vitest can test it.

`public/js/sequencer.js`, roughly:

```js
// Applies server updates strictly in seq order.
// appliedSeq = the highest seq whose effect is in the bitset (contiguous from the snapshot).
export class Sequencer {
  constructor({ apply, onGapTimeout, gapTimeoutMs = 2000 }) { ... }
  reset(snapshotSeq)        // after a snapshot load: appliedSeq = snapshotSeq, clear the buffer
  push(seq, index, value)   // seq <= appliedSeq: drop
                            // seq === appliedSeq + 1: apply, advance, then drain buffered seqs in order
                            // seq > appliedSeq + 1: buffer in a Map<seq, {index, value}>; start the gap timer
  get appliedSeq()
}
```

- If the gap timer fires before the gap fills, call `onGapTimeout()`. `main.js` then calls `loadSnapshot()` (a full resync).
- Cap the buffer (for example 20,000 entries). If it overflows, resync too.

Changes in `main.js`:

- **Batches:** both live batches and the replay batch go through `sequencer.push(fromSeq + i, ...)`. Nothing else writes remote state into the bitset.
- **Snapshot loading:** while the snapshot loads, keep buffering. Then call `sequencer.reset(snapshot.seq)` and push the buffered items through the sequencer (the buffer handles anything at or below `snapshotSeq`).
- **ACK no longer touches seq state.** The sender also receives its own change in a batch, so the batch is the source of truth.
- **Optimistic overlay:** replace `pendingToggles: Map<index, prev>` with `Map<index, { desired, inFlight, lastAckSeq }>`.
  - **On click:** `inFlight++` and `desired = newValue`; draw `desired`.
  - **On a batch for a pending index:** `apply` writes the server value to the bitset, then redraws `desired` on top while `inFlight > 0`. Simplest version: keep a separate `serverBits` BitSet for the truth, and have the renderer read through the overlay.
  - **On ACK:** `inFlight--` and `lastAckSeq = seq`.
  - **Remove the entry** when `inFlight === 0 && appliedSeq >= lastAckSeq`. The cell then shows the server value.
  - **On REJECT:** `inFlight--`. If the entry is now empty, remove it and show the server value (no stored "prev" needed).

Changes in `socket.js`:

- Remove `lastSeq` and `setLastSeq` completely.
- Take a `getLastSeq` callback in the constructor and send `hello{lastSeq: getLastSeq()}` on open whenever the value is > 0.
- `welcome` and `stats` must never change any seq.

**Tests to add (`tests/sequencer.test.js`):**

- In-order updates apply.
- Duplicates and old seqs are ignored.
- A gap buffers, then drains when it's filled.
- A replay that arrives after newer live updates doesn't overwrite them.
- The gap timeout calls `onGapTimeout` (use fake timers).

**Done when:** these tests pass, and in a manual test (two windows, one clicking fast while the other also clicks) both boards are byte-identical after 30 s. Compare with `bitset.bytes` in the console against `/api/board`.

---

### F4. Clients can fake their IP (gets around the connection limits)

**Files:** [server/realtime/wsServer.js](server/realtime/wsServer.js) `extractClientIp`, [docker-compose.yml](docker-compose.yml), new `tests/clientIp.test.js`

**Problem:**

- `extractClientIp` returns the **leftmost** `X-Forwarded-For` entry. The client controls that value; nginx appends the real IP at the right-hand end. Sending a random `X-Forwarded-For` on every connection gets around `RL_MAX_CONN_PER_IP` and `RL_CONN_PER_MINUTE`.
- Compose also publishes app1 and app2 on 3001/3002 with `TRUST_PROXY=1`. Requests sent straight to those ports have no real proxy in front, so the HTTP limiter (`req.ip`) can be spoofed as well.

**Fix:**

1. Move IP extraction into `server/utils/clientIp.js` and export it. Match Express `trust proxy = N` semantics: split the header, trim, and take the entry `trustProxy` positions from the right (`parts[parts.length - trustProxy]`). If there are fewer entries than that, use the leftmost one. If `trustProxy === 0` or the header is missing, use `req.socket.remoteAddress`.
2. In compose, bind the direct ports to localhost only: `"127.0.0.1:3001:3000"` and `"127.0.0.1:3002:3000"`. The demo still works, and nobody outside the machine can reach them.

**Tests:**

- `XFF: "1.1.1.1, 9.9.9.9"` with `trustProxy=1` gives `9.9.9.9`.
- `trustProxy=0` ignores the header.

**Done when:** sending a forged `X-Forwarded-For` through nginx no longer changes the `omc:rl:conn:<ip>` key that gets incremented.

---

### F5. Running compose with defaults turns off real login

**Files:** [docker-compose.yml](docker-compose.yml), new `docker-compose.override.yml`, [server/auth/routes.js](server/auth/routes.js)

**Problem:**

- Compose defaults to `DEV_LOGIN=true` and `NODE_ENV=development`.
- Dev login builds the user ID from the name in the query string, so anyone can sign in as any user by typing their name.
- Deploying with "Option A: VPS + compose" exactly as the plan describes means no real authentication.

**Fix:**

1. In `docker-compose.yml`, set the defaults to `DEV_LOGIN: ${DEV_LOGIN:-false}`.
2. Move the dev-only settings (`DEV_LOGIN: "true"`, the 127.0.0.1 port bindings from F4) into `docker-compose.override.yml`. Compose loads that file automatically for local runs.
3. Document in the README that production uses `docker compose -f docker-compose.yml up -d` (no override), with `NODE_ENV=production`, `COOKIE_SECURE=true` and `OIDC_*` set.
4. In `/auth/dev-login`, add a `logger.warn` on every use, so it's obvious in the logs.

**Done when:** `docker compose -f docker-compose.yml config` shows `DEV_LOGIN: "false"`.

---

## Should fix

### F6. Replace `KEYS` in a public endpoint

**Files:** [server/realtime/presence.js](server/realtime/presence.js) `getActiveInstances` and `refreshPresenceAndInstance`, [server/redis/keys.js](server/redis/keys.js)

**Problem:** `GET /api/stats` runs `KEYS omc:instance:*`. `KEYS` is O(N) and blocks Redis, and evaluators look for this.

**Fix:**

- Add `instances: \`${p}:instances\`` (a set) to `keys.js` and remove `instancePattern`.
- In the heartbeat, run `SADD instances <id>` in the same MULTI as the `SET ... EX 15`.
- In `getActiveInstances`, use `SMEMBERS`, then `MGET` the instance keys. `SREM` any id whose key has expired (returned `null`).
- In `removeInstanceHeartbeat`, also `SREM`.

**Done when:** `grep -rn "\.keys(" server` returns nothing.

---

### F7. Slow clients go out of sync and nothing notices

**File:** [server/realtime/broadcaster.js](server/realtime/broadcaster.js) `flushBatch`

**Problem:** When `ws.bufferedAmount >= 1 MB`, the batch is skipped and the client is never told. F3's gap detection would eventually catch it, but the server shouldn't drop data without saying anything.

**Fix:** In that case, call `ws.terminate()` and log a warning with `socketId`. The client reconnects and replays from `lastSeq`, or does a full resync. Remove the silent skip.

---

### F8. `/api/board` compresses on every request and blocks the event loop

**Files:** [server/routes/api.js](server/routes/api.js), [public/js/api.js](public/js/api.js)

**Problem:**

- `zlib.gzipSync` runs on 125 KB for every request, on the main thread.
- The ETag/304 path never triggers, because the client fetches with `cache: 'no-store'`.

**Fix:**

1. Keep a module-level cache `{ seq, gz }`. If `seq` matches, reuse `gz`. Otherwise use async `zlib.gzip` (promisified). Share one in-flight promise so concurrent requests compress only once.
2. Handle `If-None-Match` before reading the bitmap: do `GET omc:board:seq` first and return `304` if it matches. Only fetch the bitmap on a miss.
3. In the client, change `cache: 'no-store'` to `cache: 'no-cache'` so the browser revalidates with the ETag.

**Done when:** `curl -H 'If-None-Match: "<seq>"' /api/board` returns 304, and loadtest snapshot fetches don't spike event-loop lag.

---

### F9. Connection slots leak when an upgrade fails

**File:** [server/realtime/wsServer.js](server/realtime/wsServer.js), the `upgrade` handler

**Problem:** After `acquireConnectionSlot(ip)` succeeds, any failure leaves `omc:rl:conn:<ip>` incremented forever (until the 1 h TTL). That covers both a throw from `getSessionFromCookieHeader` and a socket that closes before `handleUpgrade` calls back. After 10 such failures, that IP can't connect at all.

**Fix:**

- Track `let slotHeld = false`. Set it to `true` after acquiring the slot.
- In `catch`, `if (slotHeld) releaseConnectionSlot(ip)`.
- Before `handleUpgrade`, add `socket.once('close', ...)` that releases the slot if the `ws` was never created. Use a flag that the `handleUpgrade` callback sets.

---

### F10. Logout on one device locks out every other device

**Files:** [server/auth/routes.js](server/auth/routes.js) `/logout`, [server/realtime/broadcaster.js](server/realtime/broadcaster.js) `downgradeUserSockets`

**Problem:** Logout publishes `{t:'logout', userId}`, which downgrades **all** of that user's sockets. That includes other devices whose sessions are still valid.

**Fix:**

- Publish `{t:'logout', sidHash}`, where `sidHash = sha256(sid).slice(0,16)`, so the raw session ID never goes over Pub/Sub.
- Store `ws.sidHash` when the socket upgrades.
- Rename the function to `downgradeSessionSockets(sidHash)` and match on it.

---

### F11. Rate-limit strikes are too harsh on real users, and the code isn't atomic

**Files:** [server/realtime/handlers.js](server/realtime/handlers.js) `handleSetFrame`, [server/ratelimit/wsLimiter.js](server/ratelimit/wsLimiter.js) `recordUserStrike`, new `server/redis/scripts/strike.lua`, [public/js/main.js](public/js/main.js) `onReject`

**Problems:**

1. Every token-bucket rejection is a strike. The bucket allows bursts of 10 and refills at 5/s, so a fast human clicker collects 10 strikes in about a second and gets a 2-minute block.
2. `recordUserStrike` makes 3–5 separate Redis calls (INCR, EXPIRE, SET, DEL, INCR, EXPIRE). That's not atomic, which contradicts the README ("all Redis logic runs in Lua").
3. Every rate rejection shows two toasts: one from `REJECT` and one from the `limit` JSON message.

**Fix:**

1. Count at most **one** bucket strike per socket per second: `if (now - ws.lastBucketStrikeMs >= 1000) { recordUserStrike; ws.lastBucketStrikeMs = now }`. A sustained flood still escalates (about 10 s to a block), but a short burst doesn't.
2. Move the strike → block → block-count logic into `strike.lua` (the same logic as the rejection branch of `ws_limit.lua`). Register it in `client.js` with `defineCommand` and call it from `recordUserStrike`.
3. In `main.js` `onReject`, only roll back the cell for `RATE` and `BLOCKED`. Leave the toast to the `limit` JSON handler.
4. In the README's rate-limiting section, explain why the per-socket bucket (5/s) is stricter than the per-user window (20/s): the per-user limit is what stops users with many tabs open.

---

### F12. Board size is configurable on the server but hard-coded in the client

**Files:** [server/config.js](server/config.js), `.env.example`, `README.md`, [public/js/main.js](public/js/main.js), [public/js/input.js](public/js/input.js), [public/js/renderer.js](public/js/renderer.js)

**Problem:** `BOARD_SIZE` and `BOARD_COLS` are read from the environment and validated, but the frontend hard-codes `1_000_000` and `1000`. Changing the env var breaks the app.

**Fix (recommended, the simpler option):**

- Remove `BOARD_SIZE` and `BOARD_COLS` from the env. In `config.js`, make them constants (`size: 1_000_000, cols: 1000`) with the comment `// fixed by the brief; the client assumes the same`.
- Remove both from `.env.example` and the README env table.

(The alternative is to send the dimensions in `/api/me` and parameterise every client module. That's more work for no benefit here.)

---

### F13. Smaller cleanups

| File | Change |
|---|---|
| [server/realtime/handlers.js](server/realtime/handlers.js) `handleSocketMessage` | All three `if/else` branches call the same `decodeClientFrame`. Collapse them into one call. |
| [server/index.js](server/index.js) `shutdown` | Call `realtime.stop()` **before** `httpServer.close()`. Sockets then get `1001` and the batch is flushed before the HTTP server waits on its connections, which matches the order in PROJECT.md §9. |
| [Dockerfile](Dockerfile) | Use `npm ci --omit=dev` instead of `npm install`. Add `HEALTHCHECK` or rely on compose. Stop copying `scripts/` if nothing at runtime needs it after F2. |
| [public/js/main.js](public/js/main.js) `onReject` (RATE) | The hard-coded "in 1s" text goes away with F11's single-toast change. |

---

## Missing for grading

### F14. README: the sections PROJECT.md §16 requires

These are missing from [README.md](README.md):

- **Auth flow:** the sequence diagram from PROJECT.md §5, the rules (opaque session ID, single-use state, no tokens stored), and how WebSocket upgrade auth works.
- **Rate-limiting logic** (worth 15 points). Cover each layer: the key, the window, the counter, the expiry, and why that algorithm. Include the fixed-window edge-burst weakness and the strike/block escalation, with numbers.
- **Project structure:** the tree from PROJECT.md §10, updated to match the real files after these fixes.
- **Top of the page:** a screenshot or GIF, the live URL, and the YouTube demo link (placeholders are fine until they exist).
- **Scaling notes:** add "client sequencer + gap detection" (F3) and "slow consumers are disconnected and replay" (F7).
- **Windows Redis setup** from F2.

---

## Final check (run before handing back for review)

1. `npm test`: all green against real `redis:7-alpine`, with no fake anywhere.
2. `docker compose up --build`, then open `http://localhost:8080` in two browsers. Toggles sync, and a refresh keeps the state.
3. `node scripts/loadtest.js --verify --urlA=http://localhost:3001 --urlB=http://localhost:3002` prints PASS.
4. `node scripts/loadtest.js`: p95 is under 150 ms, and the limiter rejections show up.
5. `grep -rn "dev-redis\|InMemoryStore\|\.keys(" server tests scripts`: no matches.
6. Write `CHANGES.md` (or one commit per ID) listing each F-number as done, skipped (with a reason), or changed approach (with a reason).
