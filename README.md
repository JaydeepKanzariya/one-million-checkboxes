# One Million Checkboxes

A real-time, multi-user grid of **1,000,000 checkboxes** (`1,000 × 1,000`). Every toggle is stored atomically in a 125 KB Redis bitmap via Lua, fanned out across stateless server instances with Redis Pub/Sub, batched into compact binary frames every 50 ms, and pushed to every connected browser over raw WebSockets. Authentication uses **OIDC Authorization Code + PKCE**, and three-layer rate limiting is built from scratch on Redis and in-memory token buckets.

- **Live Deployment:** `https://<your-production-domain>` *(placeholder — update after deployment)*
- **YouTube Demo Video:** `https://youtu.be/<your-demo-video-id>` *(placeholder — ~4 min walkthrough)*

<!-- TODO before submitting: save a screenshot as docs/screenshot.png and replace this comment with:
![One Million Checkboxes — Engineering Ledger UI](./docs/screenshot.png) -->
- **Screenshot:** *(placeholder — add `docs/screenshot.png` before submitting)*

---

## 1. Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 20 LTS (ESM) | Native `fetch`, `crypto.randomUUID`, stable ES modules |
| HTTP | Express 4 + Helmet | Minimal HTTP surface (`/api/*`, `/auth/*`, `/healthz`) with CSP and security headers |
| WebSocket | `ws` (`noServer: true`) | Raw WebSockets, binary frames, manual upgrade auth, heartbeat and fan-out |
| Redis Client | `ioredis` | Atomic Lua scripts (`defineCommand`), binary `getBuffer`, dedicated subscriber connection |
| Auth | `openid-client` v5 | Certified OIDC relying party: discovery, S256 PKCE, `state`, `nonce`, ID-token verification |
| Sessions | Custom Redis Hash | Opaque 32-byte `base64url` session ID in an `HttpOnly; SameSite=Lax` cookie |
| Rate Limiting | Custom (Lua + TokenBucket) | Fixed-window HTTP, IP connection cap, per-socket token bucket, per-user sliding window + strikes |
| Logging | `pino` | Structured JSON logging with `instance` attribution |
| Frontend | React 19 + Vite 8 | React renders the controls; the board is one `<canvas>` drawn by a framework-free engine (dirty-rect redraws, 200×200 minimap) |
| Tests | Vitest + Supertest | Unit and integration tests against real Redis (`redis:7-alpine`) |
| Local Infra | Docker Compose | `redis` (AOF enabled), `app1`, `app2`, and `nginx` load balancer |

**Intentionally not used:** `express-rate-limit`, `rate-limiter-flexible`, `socket.io` (or its Redis adapter), `express-session`, `passport`. Every core mechanism is written directly in this repository.

---

## 2. Features Implemented

- [x] **1,000,000 checkboxes in 125,000 bytes:** Redis bitmap (`SETBIT`/`GETBIT`) paired with a client-side `Uint8Array(125_000)` MSB-first bitset.
- [x] **60 fps Canvas Grid + 3 Zoom Levels:**
  - `< 4 px`: full-board 1000×1000 `ImageData` overview rendered in ~2 ms
  - `4–15 px`: ruled engineering ledger grid with ink fills
  - `16–36 px`: individual checkbox outlines, vector checkmarks, and keyboard focus ring
- [x] **Multi-instance real-time fan-out:** Toggles on `app1` (:3001) appear on `app2` (:3002) and behind `nginx` (:8080) in under 150 ms via Redis Pub/Sub + 50 ms binary batching.
- [x] **Strict client sequencer & optimistic overlay:** `Sequencer` applies server updates strictly in `seq` order, buffers out-of-order gaps, triggers snapshot resync on gap timeout, and overlays in-flight optimistic clicks cleanly over authoritative server bits.
- [x] **OIDC Authorization Code + PKCE:** Single-use `state` (`HGETALL` + `DEL`), `nonce`, `code_verifier`, Redis sessions, session-scoped logout across instances, and live read-only mode for anonymous visitors.
- [x] **3-Layer Custom Rate Limiting:** HTTP fixed window, WebSocket IP connection cap, per-socket token bucket, per-user Redis sliding-window log, and atomic strike → 120 s cooldown block escalation.
- [x] **Accessibility & Mobile Support:** `role="grid"`, roving arrow-key/PageUp/PageDown/Home/End focus, `aria-live` announcements, `prefers-reduced-motion`, dark/light themes, and two-finger pinch-to-zoom.

---

## 3. System Architecture & Write Path

```text
                         ┌──────────────────────────────┐
                         │  OIDC provider (Google)      │
                         └──────────────▲───────────────┘
                                        │ auth code + PKCE
  Browser A ──┐                         │
  Browser B ──┼──► nginx (sticky-free) ─┼──► app1 (Express + ws) ──┐
  Browser C ──┘        :8080            └──► app2 (Express + ws) ──┤
                                                                   │
                                          ┌────────────────────────▼─────┐
                                          │ Redis                        │
                                          │  bitmap   omc:board          │
                                          │  counter  omc:board:seq      │
                                          │  counter  omc:board:count    │
                                          │  stream   omc:board:log      │
                                          │  pub/sub  omc:ch:updates     │
                                          │  sessions omc:sess:<id>      │
                                          │  limits   omc:rl:*           │
                                          │  presence omc:presence       │
                                          └──────────────────────────────┘
```

### Write Path for One Toggle (6 Steps)

1. **Optimistic UI & Binary Frame:** Browser A clicks cell `#523,417`. The UI records the optimistic overlay in `pendingToggles`, flips the cell immediately on the canvas, and sends a 6-byte binary frame `[op=0x01][index u32][value u8]`.
2. **Auth, Bucket & Limiter Checks:** `app1` checks in order: the socket has an authenticated session (`ws.user`), the per-socket in-memory `TokenBucket` has tokens, the per-user Redis sliding-window limiter (`ws_limit.lua`) allows the write, and `0 <= index < 1,000,000`.
3. **Atomic Lua Toggle (`toggle.lua`):**
   - `SETBIT omc:board 523417 1` returns the old bit.
   - If `old == value`, it returns `{changed=0, seq, count}` without publishing — no-op clicks never fan out.
   - Otherwise it updates `omc:board:count` (`INCRBY ±1`), increments `omc:board:seq` → `seq`, appends to the replay stream `omc:board:log` (`XADD MAXLEN ~ 10000`), updates user stats, and `PUBLISH`es `seq:index:value` to `omc:ch:updates`.
4. **Sender ACK:** `app1` sends a 10-byte binary `ACK` (`[op=0x81][index u32][value u8][seq u32]`) to Browser A, which decrements `inFlight` and records `lastAckSeq = seq`.
5. **Cross-Instance 50 ms Batch Fan-out:** Every instance (`app1` and `app2`) receives the Pub/Sub message, appends it to its in-memory batch buffer, and every **50 ms** sends one binary `BATCH` frame (`[op=0x82][fromSeq u32][count u16][count × 5B]`) to each of its local sockets.
6. **Ordered Sequencer & Dirty Redraw:** Connected browsers pass each batch item through `Sequencer.push(seq, index, value)`, update `serverBits` and `bitset` strictly in sequence order, and redraw only dirty cells on the next `requestAnimationFrame`.

---

## 4. How to Run Locally

### Option A: With Docker Compose (Redis + `app1` + `app2` + Nginx)

```bash
cp .env.example .env
# Optional: fill in OIDC_CLIENT_ID and OIDC_CLIENT_SECRET in .env
# Local runs automatically load docker-compose.override.yml (DEV_LOGIN=true, 127.0.0.1:3001 & 3002)
docker compose up --build
```

- Load-balanced app (Nginx): `http://localhost:8080`
- Direct instance 1 (`app1`): `http://localhost:3001`
- Direct instance 2 (`app2`): `http://localhost:3002`

**Production Docker Compose (disables `docker-compose.override.yml` and requires real OIDC):**

```bash
NODE_ENV=production COOKIE_SECURE=true docker compose -f docker-compose.yml up -d --build
```

### Option B: Without Docker (Local Node.js + Real Redis)

Start a real Redis 7 instance on `127.0.0.1:6379` using any of the following on Windows / macOS / Linux:

- **Docker container for Redis only:**
  ```bash
  npm run redis
  # equivalent to: docker run -d --name omc-redis -p 6379:6379 redis:7-alpine --appendonly yes
  ```
- **WSL2 (Windows Subsystem for Linux):**
  ```bash
  wsl sudo apt-get update && wsl sudo apt-get install -y redis-server
  wsl sudo service redis-server start
  ```
- **Memurai Developer (native Windows Redis service):**
  ```powershell
  winget install Memurai.MemuraiDeveloper
  ```

Then install dependencies, build the web client, seed the board, and start the server:

```bash
cp .env.example .env
npm install
npm run build      # builds the React client into client/dist, which Express serves
npm run seed
npm run dev
```

Open `http://localhost:3000` (or run `npm run dev:multi` to launch `app1` on `:3001` and `app2` on `:3002`).

### Working on the web client (React + Vite)

The browser client is a React app in [client/](client/), built with Vite. React renders the header, toolbar, map, footer and dialogs; the board itself is still one `<canvas>` drawn by the engine in [client/src/engine/](client/src/engine/) (renderer, sequencer, socket, protocol), which React never re-renders.

```bash
npm run dev:multi    # terminal 1: app1 on :3001 and app2 on :3002
npm run dev:client   # terminal 2: Vite on http://localhost:5173 with hot reload
```

Vite proxies `/api`, `/auth` and the `/ws` WebSocket to `app1` (set `OMC_BACKEND=http://localhost:3002` to point it at `app2`). Run `npm run build` before `npm start` or `docker compose up`, so Express has a fresh `client/dist` to serve; the Docker image builds it automatically.

---

## 5. Environment Variables

| Variable | Default | Description |
|---|---|---|
| `NODE_ENV` | `development` | `development`, `production`, or `test` |
| `PORT` | `3000` | HTTP and WebSocket listen port |
| `INSTANCE_ID` | `app1` / hostname | Instance identifier shown in `/healthz`, `X-Instance-Id`, logs, and UI badge |
| `PUBLIC_URL` | `http://localhost:8080` | Public base URL used to construct the OIDC redirect URI |
| `ALLOWED_ORIGINS` | `http://localhost:8080,...` | Comma-separated origins allowed during WebSocket upgrade |
| `TRUST_PROXY` | `1` | Number of reverse-proxy hops trusted when reading `X-Forwarded-For` (`0` when direct) |
| `LOG_LEVEL` | `info` | Pino log level (`fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`) |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Redis connection URL |
| `REDIS_PREFIX` | `omc` | Key and channel namespace prefix (`omctest` in tests) |
| `OIDC_ISSUER` | `https://accounts.google.com` | OIDC discovery issuer URL |
| `OIDC_CLIENT_ID` | `""` | OIDC client ID (required when `NODE_ENV=production`) |
| `OIDC_CLIENT_SECRET` | `""` | OIDC client secret |
| `OIDC_REDIRECT_PATH` | `/auth/callback` | OIDC redirect callback path |
| `OIDC_SCOPES` | `openid profile email` | OIDC scopes requested during login |
| `DEV_LOGIN` | `false` | Enables local `/auth/dev-login` shortcut; refused at boot in production |
| `SESSION_COOKIE_NAME` | `omc_sid` | Session cookie name |
| `SESSION_TTL_SECONDS` | `604800` | Sliding session TTL in seconds (7 days) |
| `COOKIE_SECURE` | `false` (`true` in prod) | Sets `Secure` flag on session cookie; required in production |
| `BROADCAST_INTERVAL_MS` | `50` | Pub/Sub batch flush interval in milliseconds |
| `RESYNC_GAP` | `500` | Max sequence gap replayed from Redis Stream before full snapshot resync |
| `BOARD_LOG_LENGTH` | `10000` | Max entries kept in `omc:board:log` stream |
| `RL_HTTP_API_LIMIT` | `120` | `/api/*` requests per window per IP |
| `RL_HTTP_API_WINDOW_S` | `60` | `/api/*` rate-limit window in seconds |
| `RL_HTTP_AUTH_LIMIT` | `20` | `/auth/*` requests per window per IP |
| `RL_HTTP_AUTH_WINDOW_S` | `60` | `/auth/*` rate-limit window in seconds |
| `RL_WS_BUCKET_CAPACITY` | `10` | Per-socket in-memory token bucket burst capacity |
| `RL_WS_BUCKET_REFILL_PER_S` | `5` | Per-socket token bucket refill rate per second |
| `RL_WS_USER_LIMIT` | `20` | Per-user sliding-window toggle limit |
| `RL_WS_USER_WINDOW_MS` | `1000` | Per-user sliding window duration in milliseconds |
| `RL_WS_STRIKES_TO_BLOCK` | `10` | Strikes within `RL_WS_STRIKE_WINDOW_S` before temporary block |
| `RL_WS_STRIKE_WINDOW_S` | `60` | Strike accumulation window in seconds |
| `RL_WS_BLOCK_SECONDS` | `120` | Cooldown block duration in seconds |
| `RL_WS_BLOCKS_TO_CLOSE` | `3` | Cumulative blocks before closing the socket with `1008` |
| `RL_MAX_CONN_PER_IP` | `10` | Maximum concurrent WebSocket connections per IP |
| `RL_CONN_PER_MINUTE` | `30` | Maximum new WebSocket connections per minute per IP |

---

## 6. Redis Key Design & Why Redis

### Why Redis is Needed

- **Shared state across stateless processes:** `app1` and `app2` share no memory; the board, sessions, presence, and rate limits live in Redis so any instance can serve any request without sticky sessions.
- **Single-threaded Lua atomicity:** `toggle.lua` makes `SETBIT`, `INCRBY` on the checked counter, `INCR` on the monotonic sequence number, `XADD` to the replay log, and `PUBLISH` a single atomic operation. Concurrent clicks on the same checkbox are serialized with zero lost updates and no duplicate broadcasts on no-op writes.
- **Compact O(1) bitmap storage:** 1,000,000 booleans fit in **125,000 bytes** (`SETBIT`/`GETBIT` are O(1), and the entire snapshot is fetched in one `GETBuffer`).
- **Real-time cross-instance fan-out:** Redis Pub/Sub delivers every state change to all running instances, which coalesce updates into 50 ms binary batches.

### Redis Key Table

| Key | Type | TTL | Purpose |
|---|---|---|---|
| `omc:board` | String (bitmap, 125 KB) | none | Checkbox state; bit *i* = checkbox *i* (MSB-first) |
| `omc:board:seq` | String (int) | none | Monotonic sequence number incremented on every real bit change |
| `omc:board:count` | String (int) | none | Checked total maintained atomically by `toggle.lua` |
| `omc:board:log` | Stream (`MAXLEN ~ 10000`) | none | Recent `(seq, index, value)` entries for reconnect replay |
| `omc:ch:updates` | Pub/Sub channel | — | Change events (`seq:index:value`) |
| `omc:ch:control` | Pub/Sub channel | — | Control events (`resync`, session-scoped `logout`) |
| `omc:sess:<sid>` | Hash | 7 days (sliding) | `userId, name, email, picture, createdAt` |
| `omc:oidc:<state>` | Hash | 10 min | Single-use PKCE `codeVerifier`, `nonce`, `returnTo` |
| `omc:user:<sub>:stats` | Hash | none | Per-user `toggles` count and `lastSeen` timestamp |
| `omc:rl:http:<scope>:<ip>:<w>` | String (int) | window + 1s | HTTP fixed-window counter (`http_limit.lua`) |
| `omc:rl:ws:user:<userId>` | Sorted Set | 2 × window | WS sliding-window timestamp log (`ws_limit.lua`) |
| `omc:rl:strikes:<userId>` | String (int) | 60 s | Rate-limit strike counter (`strike.lua` / `ws_limit.lua`) |
| `omc:rl:block:<userId>` | String | 120 s | Active cooldown block flag |
| `omc:rl:blockcount:<userId>` | String (int) | 1200 s | Cumulative block count (closes socket at 3 blocks) |
| `omc:rl:conn:<ip>` | String (int) | 1 h safety | Concurrent WebSocket connections per IP |
| `omc:rl:connrate:<ip>:<w>` | String (int) | 61 s | New WebSocket connections per minute per IP |
| `omc:presence` | Sorted Set | pruned >65s | Connected `socketId`s scored by last heartbeat timestamp |
| `omc:instances` | Set | none | Active backend instance IDs (avoids `KEYS` in `/api/stats`) |
| `omc:instance:<id>` | String (JSON) | 15 s | Instance heartbeat payload (`{id, sockets, updatedAt}`) |

---

## 7. Authentication Flow (OIDC + PKCE)

```text
Browser                 app                         Redis              Google
  │ GET /auth/login      │                            │                   │
  │─────────────────────►│ make state, nonce,         │                   │
  │                      │ code_verifier              │                   │
  │                      │── HSET omc:oidc:<state> ──►│ (10 min TTL)      │
  │◄── 302 to authorize URL (code_challenge=S256) ────┼───────────────────│
  │──────────────────────────────── user signs in ───────────────────────►│
  │◄─────────────────────────── 302 /auth/callback?code&state ────────────│
  │ GET /auth/callback   │── HGETALL+DEL <state> ────►│ (single-use)      │
  │─────────────────────►│── token exchange (code + verifier) ───────────►│
  │                      │◄── id_token, access_token ─────────────────────│
  │                      │ validate id_token (iss, aud, exp, nonce, sig)  │
  │                      │── HSET omc:sess:<sid> ────►│ (7 d TTL)         │
  │◄── Set-Cookie: omc_sid=<sid>; HttpOnly; Secure; SameSite=Lax; 302 / ──│
```

### Security Rules

- **Opaque session cookie:** `omc_sid` is 32 cryptographically random bytes encoded as `base64url`. The cookie never contains a raw JWT or user ID.
- **No provider tokens stored:** Provider `id_token` and `access_token` are verified in memory during `/auth/callback` to extract `{ sub, name, email, picture }` and are immediately discarded.
- **Single-use `state`:** `omc:oidc:<state>` is consumed atomically with `MULTI` (`HGETALL` + `DEL`), preventing login CSRF and authorization code replay.
- **Session-scoped logout:** `POST /auth/logout` deletes `omc:sess:<sid>`, clears the cookie, and publishes `{"t":"logout","sidHash":"<sha256(sid).slice(0,16)>"}` on `omc:ch:control`. Every instance downgrades only sockets matching `ws.sidHash` to read-only without locking out the user's other signed-in devices.
- **WebSocket upgrade authentication:**
  1. `wsServer.js` runs with `noServer: true` and intercepts HTTP `upgrade`.
  2. Verifies the `Origin` header against `ALLOWED_ORIGINS`.
  3. Extracts the client IP using `extractClientIp` (`trustProxy` hops from the right of `X-Forwarded-For`) and acquires a slot in `omc:rl:conn:<ip>` (releasing the slot automatically if the upgrade throws or the socket closes early).
  3. Parses `omc_sid` and loads the session from Redis. Anonymous sockets are accepted with `ws.readOnly = true` (any `SET` frame from them receives `REJECT code=1`).
  4. Re-validates active sessions every 60 s; if expired or logged out, downgrades the socket to `readOnly` and sends `{"t":"session_expired"}`.

---

## 8. WebSocket Protocol & Client Sequencing

### Client → Server

| Opcode | Name | Layout | Notes |
|---|---|---|---|
| `0x01` | `SET` | `u8 op · u32 index · u8 value` (6 B, big-endian) | Requires authenticated session |
| `0x02` | `PING` | `u8 op` (1 B) | Sent every 25 s |
| `0x7B` (`{`) | `JSON` | `{"t":"hello","lastSeq":1234}` | Sent on reconnect with `sequencer.appliedSeq` |

### Server → Client

| Opcode | Name | Layout |
|---|---|---|
| `0x81` | `ACK` | `u8 op · u32 index · u8 value · u32 seq` (10 B) |
| `0x82` | `BATCH` | `u8 op · u32 fromSeq · u16 count · count × (u32 index · u8 value)` |
| `0x83` | `REJECT` | `u8 op · u32 index · u8 code` (`1=auth, 2=rate, 3=range, 4=blocked`) |
| `0x84` | `PONG` | `u8 op` (1 B) |
| `0x7B` (`{`) | `JSON` | `welcome`, `stats`, `resync`, `limit`, `session_expired` |

---

## 9. Custom Rate-Limiting Architecture

All rate limiting is written from scratch across three layers, ordered from cheapest to most specific:

### Layer 1: HTTP Fixed Window per IP (`http_limit.lua`)

- **Key:** `omc:rl:http:<scope>:<ip>:<floor(nowSec / windowS)>`
- **Window & Limits:**
  - `scope = api` (`/api/*`): **120 requests per 60 s**
  - `scope = auth` (`/auth/*`): **20 requests per 60 s**
- **Counter & Expiry:** Atomic Lua `INCR` + `EXPIRE (windowS + 1)` on first hit, returning `{allowed, current, pttlMs}`.
- **Headers:** Every response includes `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset`. Rejections return HTTP `429` with `Retry-After`.
- **Known trade-off (edge bursts):** Fixed windows allow up to `2 × limit` across a window boundary (e.g., 120 requests in the last second of window *N* and 120 in the first second of window *N+1*). This is cheap (1 string key per IP) and acceptable for HTTP reads, whereas WebSocket writes use a true sliding window.

### Layer 2: WebSocket Connections per IP (`connLimiter.js`)

- **Concurrent cap:** `INCR omc:rl:conn:<ip>` on upgrade (with a 1-hour safety TTL) and `DECR` (deleting at `<= 0`) on disconnect or failed upgrade. Refuses upgrades with `429` above `RL_MAX_CONN_PER_IP` (**10** concurrent sockets).
- **Connection rate:** `omc:rl:connrate:<ip>:<floor(nowMs / 60000)>` limits new WebSocket handshakes to **30 per minute per IP** to stop reconnect storms.

### Layer 3: WebSocket Toggles (Token Bucket + Sliding Window + Strikes)

- **3a. Per-Socket In-Memory Token Bucket (`TokenBucket`):**
  - **Parameters:** `capacity = 10`, `refill = 5 tokens/s`.
  - **Why stricter than the per-user limit:** A single browser tab is capped at 5 toggles/s sustained (after a 10-click burst) in local Node memory with **zero Redis round trips**. The higher per-user Redis limit (20/s) exists to cap total throughput when the same user opens multiple tabs or connects to both `app1` and `app2` simultaneously.
- **3b. Per-User Sliding-Window Log in Redis (`ws_limit.lua`):**
  - **Key:** `omc:rl:ws:user:<userId>` (Sorted Set where `score = timestampMs`, `member = timestampMs:seq:rand`).
  - **Window & Limit:** **20 toggles per 1,000 ms** across all sockets/instances for that `userId`.
  - **Algorithm & Expiry:** Atomically runs `ZREMRANGEBYSCORE key 0 (nowMs - 1000)`, checks `ZCARD key < 20`, inserts the event with `ZADD`, and sets `PEXPIRE key 2000` (`2 × windowMs`).
- **3c. Strike & Cooldown Block Escalation (`strike.lua` & `ws_limit.lua`):**
  - **Keys:** `omc:rl:strikes:<userId>` (TTL **60 s**), `omc:rl:block:<userId>` (TTL **120 s**), and `omc:rl:blockcount:<userId>` (TTL **1200 s**).
  - **Escalation rules:** Token-bucket rejections record at most **1 strike per second per socket** (so a fast human clicker isn't immediately penalized, while a sustained flood still escalates). Sliding-window rejections and malformed frames also increment `omc:rl:strikes:<userId>` atomically in Lua.
  - Reaching **10 strikes within 60 s** sets `omc:rl:block:<userId>` for **120 s** (`REJECT code=4` + UI cooldown timer).
  - Reaching **3 blocks** closes the WebSocket with code `1008` (Policy Violation).

---

## 10. Scaling Notes & Known Limits

1. **Client Sequencer & Gap Detection:** Out-of-order batches or async reconnect replays are ordered by `client/src/engine/sequencer.js`. If a sequence gap remains unfilled for > 2,000 ms (or exceeds 20,000 buffered items), the client automatically refetches `GET /api/board`.
2. **Slow Consumers:** In `broadcaster.js`, any WebSocket whose outgoing `bufferedAmount` reaches `1 MB` is terminated (`ws.terminate()`) with a warning log rather than silently dropping batches. Upon reconnecting, the client replays from `sequencer.appliedSeq` or refetches the snapshot.
3. **Pub/Sub Delivery Gap Mitigation:** Redis Pub/Sub is fire-and-forget. `toggle.lua` writes every mutation to a capped Redis Stream (`omc:board:log`, `MAXLEN ~ 10000`) for small reconnect gaps (`<= 500`), and if an instance's Redis subscriber connection drops and reconnects, it broadcasts `{"t":"resync"}` to all local clients.
4. **Sharding Path Beyond Single-Instance Redis:** A single Redis bitmap handles > 20,000 toggles/s. To scale further across a Redis Cluster, shard the bitmap into 16 keys (`omc:board:0..15` by `index >> 16`) with per-shard sequence numbers.

---

## 11. Running Tests & Load Test

```bash
# Start real Redis (if not already running)
npm run redis

# Run all unit and integration test suites (runs sequentially against omctest:* keys)
npm test

# Seed demo pattern on the board
npm run seed

# Verify cross-instance fan-out between app1 (:3001) and app2 (:3002)
node scripts/loadtest.js --verify --urlA=http://localhost:3001 --urlB=http://localhost:3002

# Run load test (reports p50/p95 fan-out latency and rate-limit rejections)
npm run loadtest -- --url=http://localhost:8080 --clients=20 --rate=5 --duration=10
```

---

## 12. Project Structure

```text
one-million-checkboxes/
├─ server/
│  ├─ index.js                 # boot: config → redis → http → ws → listen; graceful shutdown
│  ├─ app.js                   # express app: helmet, static, routes, error middleware
│  ├─ config.js                # env parsing + validation (fail fast)
│  ├─ logger.js                # pino logger with instance attribution
│  ├─ redis/
│  │  ├─ client.js             # main + subscriber ioredis connections & Lua registration
│  │  ├─ keys.js               # every Redis key and channel name in one place
│  │  ├─ board.js              # getSnapshot, setBit (toggle.lua), getBoardStats, getReplaySince
│  │  └─ scripts/
│  │     ├─ toggle.lua         # atomic SETBIT + INCRBY count + INCR seq + XADD + PUBLISH
│  │     ├─ ws_limit.lua       # sliding-window sorted set + strike/block escalation
│  │     ├─ strike.lua         # atomic strike counter + cooldown block escalation
│  │     └─ http_limit.lua     # fixed-window HTTP counter with EXPIRE + PTTL
│  ├─ auth/
│  │  ├─ oidc.js               # OIDC discovery, S256 PKCE, state/nonce validation
│  │  ├─ sessions.js           # create/get/destroy/touch + sidHash in Redis
│  │  ├─ routes.js             # /auth/login, /auth/callback, /auth/logout, /auth/dev-login
│  │  └─ middleware.js         # attachUser, requireUser
│  ├─ ratelimit/
│  │  ├─ httpLimiter.js        # express middleware (fixed window)
│  │  ├─ tokenBucket.js        # in-memory per-socket token bucket
│  │  ├─ wsLimiter.js          # Redis sliding window + atomic strikes
│  │  └─ connLimiter.js        # per-IP concurrent connection cap + connection rate
│  ├─ realtime/
│  │  ├─ wsServer.js           # upgrade handling, Origin check, auth, heartbeat
│  │  ├─ protocol.js           # binary encode/decode & opcodes
│  │  ├─ handlers.js           # onSet, onHello, onPing
│  │  ├─ broadcaster.js        # pub/sub subscribe → 50 ms batch → local fan-out
│  │  └─ presence.js           # ZSET socket presence + SET active instances
│  ├─ routes/
│  │  ├─ api.js                # /api/me, /api/board (async gzip cache + ETag), /api/stats
│  │  └─ health.js             # /healthz
│  └─ utils/
│     ├─ asyncHandler.js
│     ├─ clientIp.js           # right-to-left X-Forwarded-For hop extraction
│     ├─ cookies.js
│     └─ errors.js             # AppError + central errorHandler
├─ client/                     # React + Vite web client (built into client/dist)
│  ├─ index.html
│  ├─ vite.config.js           # dev server on :5173, proxies /api, /auth and /ws
│  └─ src/
│     ├─ main.jsx              # creates the one board engine, renders <App>
│     ├─ App.jsx               # layout: header, canvas stage, toolbar, map, footer
│     ├─ useEngine.js          # React hooks over the engine store
│     ├─ components/           # Header, Toolbar, MapPanel, Footer, Overlays, MobileSheet, SignInDialog
│     ├─ styles/
│     │  ├─ tokens.css         # Synthwave palette, type, motion, depth
│     │  └─ app.css            # component styles, scanlines, responsive rules
│     └─ engine/               # framework-free board engine (React never re-renders the canvas)
│        ├─ boardEngine.js     # boot sequence, optimistic overlay, sequencer wiring, store
│        ├─ store.js           # tiny external store for useSyncExternalStore
│        ├─ sequencer.js       # strict seq ordering, gap buffering & timeout resync
│        ├─ bitset.js          # 125 KB Uint8Array MSB-first bitset + popcount
│        ├─ api.js             # fetch /api/me, /api/board (cache: no-cache)
│        ├─ socket.js          # WebSocket client, backoff reconnect, heartbeat
│        ├─ protocol.js        # browser binary protocol (matches server/realtime/protocol.js)
│        ├─ renderer.js        # canvas, 3 zoom tiers, dirty rects, live pulse, glow
│        ├─ input.js           # pointer pan/click, wheel, pinch-to-zoom, keyboard a11y
│        ├─ minimap.js         # 200×200 downsample + draggable viewport box
│        ├─ clickBudget.js     # client mirror of the server token bucket
│        └─ motion.js          # shared durations and easing
├─ tests/
│  ├─ helpers/
│  │  ─ redisHarness.js       # real Redis test connection + isolated omctest:* flush
│  ├─ protocol.test.js
│  ├─ sequencer.test.js
│  ├─ clientIp.test.js
│  ├─ tokenBucket.test.js
│  ├─ wsLimiter.test.js
│  ├─ board.test.js
│  └─ api.test.js
├─ scripts/
│  ├─ dev-multi.js             # local launcher for app1 (:3001) + app2 (:3002)
│  ├─ loadtest.js              # N sockets × M toggles/s load & cross-instance verifier
│  └─ seed.js                  # board pattern seeder
├─ deploy/
│  └─ nginx.conf               # round-robin upstream app1/app2 + WebSocket upgrade
├─ docker-compose.yml          # production-safe base compose (DEV_LOGIN=false)
├─ docker-compose.override.yml # local dev overrides (DEV_LOGIN=true, 127.0.0.1:3001/3002)
├─ Dockerfile
├─ vitest.config.js            # fileParallelism: false, REDIS_PREFIX=omctest
├─ .env.example
├─ .gitignore
├─ package.json
├─ PROJECT.md
├─ FIXES.md
└─ README.md
```
