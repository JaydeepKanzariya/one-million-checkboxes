# One Million Checkboxes

A real-time, multi-user grid of **1,000,000 checkboxes** (`1,000 × 1,000`). Every toggle is stored atomically in a 125 KB Redis bitmap via Lua, fanned out across stateless server instances with Redis Pub/Sub, batched into compact binary frames every 50 ms, and pushed to every connected browser over raw WebSockets. Authentication uses **OIDC Authorization Code + PKCE**, and three-layer rate limiting is implemented from scratch on Redis and in-memory token buckets.

---

## 1. Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 20+ (ESM) | Native `fetch`, `crypto.randomUUID`, `DataView`/`Uint8Array` |
| HTTP | Express 4 + Helmet | Minimal HTTP surface (`/api/*`, `/auth/*`, `/healthz`) with strict CSP |
| WebSocket | `ws` (`noServer: true`) | Raw binary + JSON WebSockets; manual upgrade auth, heartbeat & fan-out |
| Redis | `ioredis` | Atomic Lua scripts (`defineCommand`), binary `getBuffer`, dedicated Pub/Sub connection |
| Auth | `openid-client` v5 | Certified OIDC relying party: discovery, S256 PKCE, `state`, `nonce` & ID-token verification |
| Sessions | Custom Redis Hash | Opaque 32-byte `base64url` session ID in `HttpOnly; SameSite=Lax` cookie |
| Rate Limiting | Custom (Lua + TokenBucket) | Fixed-window HTTP, IP connection cap, per-socket token bucket & per-user sliding window |
| Frontend | Vanilla HTML / CSS / ES Modules | Zero framework/bundler overhead; single `<canvas>` + 200×200 minimap |
| Testing | Vitest + Supertest | Protocol, token bucket, sliding-window limiter, board Lua & HTTP/WS integration tests |
| Local Infra | Docker Compose | `redis` (AOF enabled), `app1`, `app2`, and `nginx` load balancer |

---

## 2. Features Implemented

- [x] **1,000,000 checkboxes in 125,000 bytes:** Redis bitmap (`SETBIT`/`GETBIT`) paired with a client-side `Uint8Array(125_000)` MSB-first bitset.
- [x] **60 fps Canvas Grid + 3 Zoom Tiers:**
  - `< 4 px`: full-board 1000×1000 `ImageData` overview rendered in ~2 ms
  - `4–15 px`: ruled engineering ledger grid with ink fills
  - `16–36 px`: individual checkbox outlines with vector checkmarks and focus ring
- [x] **Multi-instance real-time sync:** Toggles on `app1` (:3001) appear on `app2` (:3002) and behind `nginx` (:8080) via Redis Pub/Sub + 50 ms binary batching.
- [x] **Gapless refresh & reconnect:** Snapshot `GET /api/board` + `X-Board-Seq` buffers early WS frames during page load and replays missed updates from a bounded Redis Stream (`omc:board:log`) on reconnect.
- [x] **OIDC Authorization Code + PKCE:** Single-use `state` (`HGETALL` + `DEL`), `nonce`, `code_verifier`, Redis sessions, and read-only mode for anonymous visitors.
- [x] **3-Layer Custom Rate Limiting:**
  1. HTTP fixed-window per IP (`/api/*` 120/60s, `/auth/*` 20/60s) with `X-RateLimit-*` and `Retry-After` headers
  2. WebSocket concurrent connections per IP (`MAX_CONN_PER_IP=10`) + connection rate (`30/min`)
  3. Per-socket in-memory token bucket (`cap=10, refill=5/s`) + per-user Redis sliding-window log (`20/1s`) + strike escalation (`10 strikes → 120s block`, `3 blocks → 1008 close`)
- [x] **Accessibility & Mobile Support:** Keyboard navigation (`Arrow` keys, `PageUp`/`PageDown`, `Home`/`End`, `Space`/`Enter`), `aria-live` announcements, `prefers-reduced-motion`, dark/light ledger themes, and two-finger pinch-to-zoom.

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

### Write Path for One Toggle

1. **Optimistic UI + Binary Frame:** Browser A clicks checkbox `#523,417`. The UI flips the bit immediately in its `Uint8Array(125_000)`, records the previous value in `pendingToggles`, and sends a 6-byte binary frame `[op=0x01][index u32][value u8]`.
2. **Validation & Rate Limiting:** `app1` verifies that `ws.user` is present, checks the socket's in-memory `TokenBucket`, runs `ws_limit.lua` in Redis for the user's sliding window, and checks `0 <= index < 1,000,000`.
3. **Atomic Lua Toggle (`toggle.lua`):**
   - `SETBIT omc:board 523417 1` returns the old bit.
   - If `old == value`, it returns `{0, seq, count}` without publishing (no-op clicks never waste bandwidth).
   - Otherwise it updates `omc:board:count` (`INCRBY ±1`), increments `omc:board:seq`, appends to `omc:board:log` (`XADD MAXLEN ~ 10000`), updates user stats, and `PUBLISH`es `seq:index:value` to `omc:ch:updates`.
4. **Sender ACK:** `app1` sends a 10-byte `ACK` (`[0x81][index u32][value u8][seq u32]`) to Browser A.
5. **Cross-Instance Batch Fan-out:** Every instance (`app1` and `app2`) receives the Pub/Sub event, buffers updates for **50 ms**, and flushes a single binary `BATCH` frame (`[0x82][fromSeq u32][count u16][count × 5B]`) to all local sockets.
6. **Dirty-Rect Canvas Redraw:** Connected browsers apply the batch to their bitset, trigger an 800 ms `--live` pulse on modified cells, and redraw only dirty cells in the next `requestAnimationFrame`.

---

## 4. How to Run Locally

### Option A: Docker Compose (Recommended — runs Redis + 2 Node instances + Nginx)

```bash
cp .env.example .env
# Optional: add your Google OIDC_CLIENT_ID and OIDC_CLIENT_SECRET in .env
# (DEV_LOGIN=true is enabled by default in compose for instant local sign-in)
docker compose up --build
```

- Load-balanced app (Nginx): http://localhost:8080
- Direct instance 1 (`app1`): http://localhost:3001
- Direct instance 2 (`app2`): http://localhost:3002

### Option B: Without Docker (Local Node.js + Redis)

1. Start Redis on `localhost:6379` (e.g. `docker run -d -p 6379:6379 redis:7-alpine` or WSL/Memurai).
2. Install dependencies and start the dev server:

```bash
cp .env.example .env
npm install
DEV_LOGIN=true npm run dev
```

3. Open http://localhost:3000.

---

## 5. Environment Variables

| Variable | Default | Description |
|---|---|---|
| `NODE_ENV` | `development` | `development`, `production`, or `test` |
| `PORT` | `3000` | HTTP + WebSocket listen port |
| `INSTANCE_ID` | `app1` / hostname | Shown in `/healthz`, `X-Instance-Id`, logs, and header badge |
| `PUBLIC_URL` | `http://localhost:8080` | Base URL used to build the OIDC redirect URI |
| `ALLOWED_ORIGINS` | `http://localhost:8080,...` | Comma-separated origins checked on WebSocket upgrade |
| `TRUST_PROXY` | `1` | Number of reverse-proxy hops (`1` behind Nginx, `0` direct) |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |
| `REDIS_PREFIX` | `omc` | Prefix for all Redis keys and Pub/Sub channels |
| `OIDC_ISSUER` | `https://accounts.google.com` | OIDC discovery issuer URL |
| `OIDC_CLIENT_ID` | `""` | OIDC client ID (required in production) |
| `OIDC_CLIENT_SECRET` | `""` | OIDC client secret |
| `OIDC_REDIRECT_PATH` | `/auth/callback` | OIDC callback route |
| `DEV_LOGIN` | `false` | Enables `/auth/dev-login?name=...` outside production |
| `SESSION_COOKIE_NAME` | `omc_sid` | HttpOnly session cookie name |
| `SESSION_TTL_SECONDS` | `604800` | Sliding session TTL (7 days) |
| `COOKIE_SECURE` | `false` (`true` in prod) | Enforces `Secure` cookie attribute in production |
| `BOARD_SIZE` | `1000000` | Total checkboxes (`1000 × 1000`) |
| `BROADCAST_INTERVAL_MS` | `50` | Pub/Sub batching interval per instance |
| `RESYNC_GAP` | `500` | Max sequence gap replayed before full snapshot refetch |
| `RL_HTTP_API_LIMIT` | `120` | `/api/*` requests per `RL_HTTP_API_WINDOW_S` (60s) per IP |
| `RL_HTTP_AUTH_LIMIT` | `20` | `/auth/*` requests per `RL_HTTP_AUTH_WINDOW_S` (60s) per IP |
| `RL_WS_BUCKET_CAPACITY` | `10` | Per-socket in-memory token bucket capacity |
| `RL_WS_BUCKET_REFILL_PER_S` | `5` | Per-socket token bucket refill rate per second |
| `RL_WS_USER_LIMIT` | `20` | Per-user sliding window toggle limit per `RL_WS_USER_WINDOW_MS` (1000ms) |
| `RL_WS_STRIKES_TO_BLOCK` | `10` | Strikes within 60s before temporary block |
| `RL_WS_BLOCK_SECONDS` | `120` | Cooldown block duration in seconds |
| `RL_MAX_CONN_PER_IP` | `10` | Maximum concurrent WebSocket connections per IP |

---

## 6. Redis Key Design & Why Redis

| Key | Type | TTL | Purpose |
|---|---|---|---|
| `omc:board` | String (bitmap, 125 KB) | none | Checkbox state; bit *i* = checkbox *i* (MSB-first) |
| `omc:board:seq` | String (int) | none | Monotonic sequence number incremented on every real bit change |
| `omc:board:count` | String (int) | none | Checked total maintained atomically by `toggle.lua` |
| `omc:board:log` | Stream (`MAXLEN ~ 10000`) | none | Recent `(seq, index, value)` entries for fast reconnect replay |
| `omc:ch:updates` | Pub/Sub channel | — | Real-time change events (`seq:index:value`) |
| `omc:ch:control` | Pub/Sub channel | — | System control events (`resync`, cross-instance `logout`) |
| `omc:sess:<sid>` | Hash | 7 days (sliding) | `userId, name, email, picture, createdAt` |
| `omc:oidc:<state>` | Hash | 10 min | Single-use PKCE `codeVerifier`, `nonce`, `returnTo` |
| `omc:user:<sub>:stats` | Hash | none | Per-user `toggles` count and `lastSeen` timestamp |
| `omc:rl:http:<scope>:<ip>:<w>` | String (int) | window + 1s | Fixed-window HTTP counter (`http_limit.lua`) |
| `omc:rl:ws:user:<userId>` | Sorted Set | 2 × window | Sliding-window timestamp log (`ws_limit.lua`) |
| `omc:rl:strikes:<userId>` | String (int) | 60 s | Rate-limit strike counter |
| `omc:rl:block:<userId>` | String | 120 s | Active cooldown block flag |
| `omc:rl:conn:<ip>` | String (int) | 1 h safety | Concurrent WebSocket connections per IP |
| `omc:presence` | Sorted Set | pruned >65s | Connected `socketId`s scored by last heartbeat |
| `omc:instance:<id>` | String (JSON) | 15 s | Active backend instance heartbeat & local socket count |

---

## 7. WebSocket Wire Protocol

Binary frames are used on the hot path; JSON is used for infrequent control messages.

### Client → Server

| Opcode | Name | Wire Layout | Notes |
|---|---|---|---|
| `0x01` | `SET` | `u8 op · u32 index · u8 value` (6 bytes, big-endian) | Requires authenticated session |
| `0x02` | `PING` | `u8 op` (1 byte) | Sent every 25 s |
| `0x7B` (`{`) | `JSON` | `{"t":"hello","lastSeq":1234}` | Sent on reconnect to replay missed updates |

### Server → Client

| Opcode | Name | Wire Layout |
|---|---|---|
| `0x81` | `ACK` | `u8 op · u32 index · u8 value · u32 seq` (10 bytes) |
| `0x82` | `BATCH` | `u8 op · u32 fromSeq · u16 count · count × (u32 index · u8 value)` |
| `0x83` | `REJECT` | `u8 op · u32 index · u8 code` (`1=auth, 2=rate, 3=range, 4=blocked`) |
| `0x84` | `PONG` | `u8 op` (1 byte) |
| `0x7B` (`{`) | `JSON` | `welcome`, `stats`, `resync`, `limit`, `session_expired` |

---

## 8. Testing & Load Testing

```bash
# Run unit and integration test suites
npm test

# Seed demo pattern on the board
npm run seed

# Verify cross-instance Pub/Sub fan-out between app1 (:3001) and app2 (:3002)
node scripts/loadtest.js --verify --urlA=http://localhost:3001 --urlB=http://localhost:3002

# Run load test (20 sockets, 5 toggles/s each for 10s)
npm run loadtest -- --url=http://localhost:8080 --clients=20 --rate=5 --duration=10
```

---

## 9. Scaling Notes & Trade-offs

- **Fixed-window HTTP edge bursts:** A client can send up to `2 × limit` across the boundary of two fixed HTTP windows. This is acceptable for `/api/*` reads, whereas WebSocket writes use a true **sliding-window log** (`ZREMRANGEBYSCORE` + `ZCARD`) in Redis.
- **Pub/Sub at-most-once delivery:** If an instance's Redis subscriber connection drops briefly, Pub/Sub messages during the disconnect are not queued by Redis. We mitigate this in two ways:
  1. `toggle.lua` writes every change to a capped Redis Stream (`omc:board:log`, `MAXLEN ~ 10000`) so reconnecting clients with a small gap (`<= 500`) receive an exact delta batch.
  2. When an instance's subscriber connection emits `ready` after a reconnect, it broadcasts `{"t":"resync"}` to its local sockets so they refetch `GET /api/board`.
- **Single-key hot spot at extreme scale:** Up to ~20,000 toggles/s, a single `omc:board` bitmap in Redis is well within single-core capacity. Beyond that, the board can be sharded into 16 bitmap stripes (`omc:board:0..15` by `index >> 16`) across a Redis Cluster.

