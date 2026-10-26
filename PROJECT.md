# One Million Checkboxes — Project Plan

A real-time, multi-user grid of 1,000,000 checkboxes. Every toggle is stored in Redis, fanned out across server instances with Redis Pub/Sub, and pushed to every connected browser over WebSockets. Login is through OIDC. Rate limiting is written from scratch.

This document is the build spec. It covers what to build and why, plus the order to build it in. The README is written from it at the end.

---

## 1. Goals and non-goals

**Goals**

- 1,000,000 checkboxes that load in under a second and scroll smoothly on a mid-range laptop and a phone.
- A toggle in one browser shows up in every other browser in under 150 ms on the same network.
- Correct across **multiple backend instances** (demonstrated with 2 Node processes behind a proxy).
- Only signed-in users can write. Anonymous visitors get a live, read-only view.
- Rate limiting built by hand on Redis, applied to HTTP, WebSocket connects and WebSocket messages.
- A codebase an evaluator can read in 15 minutes: small modules, one job each.

**Non-goals**

- No frontend framework or bundler. Vanilla HTML/CSS/JS with ES modules, as the brief asks.
- No database other than Redis. The board is the only durable state; Redis persistence (AOF) covers it.
- No per-checkbox history or undo.

---

## 2. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 20 LTS | Required; native `fetch`, `crypto.randomUUID`, stable ESM |
| HTTP | Express 4 | Required |
| WebSocket | `ws` | Raw WebSockets, binary frames, no hidden adapter. Socket IDs, rooms and fan-out are written by us, so they can be explained |
| Redis client | `ioredis` | Lua scripts (`defineCommand`), auto-reconnect, separate subscriber connection |
| Auth | `openid-client` v5 | Certified OIDC relying party: discovery, PKCE, ID-token validation |
| Sessions | Our own, in Redis | Opaque session ID in an httpOnly cookie, so a session store package isn't needed |
| Security headers | `helmet` | CSP and the usual headers |
| Config | `dotenv` + a validation module | Fail fast at boot on a missing variable |
| Logging | `pino` | Structured, cheap |
| Tests | `vitest` + `supertest` | Unit tests for limiter and codec, integration tests for routes |
| Load test | Custom `scripts/loadtest.js` using `ws` | Opens N sockets, spams toggles, checks limiter and fan-out |
| Local infra | Docker Compose: `redis`, `app1`, `app2`, `nginx` | One command shows the multi-instance setup |

**Not used, on purpose:** `express-rate-limit`, `rate-limiter-flexible`, `socket.io` (and its Redis adapter), `express-session`, `passport`. Each of these would hide something the evaluation asks us to show.

---

## 3. System architecture

```
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
                                          │  pub/sub  omc:ch:updates     │
                                          │  sessions omc:sess:<id>      │
                                          │  limits   omc:rl:*           │
                                          │  presence omc:presence       │
                                          └──────────────────────────────┘
```

### Write path for one toggle

1. Browser A clicks cell `523417`. The UI flips it right away (optimistic) and sends a 6-byte binary frame `[op=0x01][index u32][value u8]`.
2. `app1` checks, in order: the socket is authenticated, the per-socket in-memory bucket, the per-user Redis limiter, and that the index is in range.
3. `app1` runs the `toggle.lua` script **atomically** in Redis:
   - `SETBIT omc:board 523417 1` returns the old bit.
   - If the old bit equals the new one, it returns `{changed=0}`. No publish, so no-op clicks never reach anyone.
   - Otherwise `INCR omc:board:seq` → `seq`, `PUBLISH omc:ch:updates <seq,index,value>`, then return `{changed=1, seq}`.
4. `app1` acks to Browser A: `[op=0x81][index][value][seq]`.
5. **Every** instance (app1 and app2) receives the Pub/Sub message, appends it to an in-memory batch, and every **50 ms** sends one binary frame with all buffered updates to each of its local sockets.
6. Browsers B and C apply the batch to their bitset and redraw only the dirty cells.

### Why Redis is needed (the answer for the viva)

- **Shared state:** two Node processes can't share memory. The board must live outside them.
- **Atomicity:** Redis runs commands one at a time, and the Lua script makes the read, write, sequence and publish one unit. Two users clicking the same box at the same time are serialised, with no lost update and no double broadcast.
- **Compact storage:** a Redis bitmap stores 1,000,000 booleans in **125,000 bytes**. `SETBIT`/`GETBIT` are O(1). `BITCOUNT` gives the "checked" total.
- **Fan-out across instances:** Pub/Sub delivers each change to every instance, which then delivers it to that instance's own sockets.
- **Shared limits and sessions:** a user can't dodge the rate limit by reconnecting to the other instance, and a session made on app1 is valid on app2.

### Concurrency rule

Clients send the **desired value** (`set to 1`), not "flip". Setting is idempotent, so retries and duplicate frames are harmless. When two users race, Redis order decides and the last write wins. Every client converges because the authoritative `(seq, index, value)` is broadcast to all of them, including the sender.

---

## 4. Data model: Redis keys

All keys are prefixed `omc:` (one million checkboxes) and named `omc:<domain>:<id>`.

| Key | Type | TTL | Purpose |
|---|---|---|---|
| `omc:board` | String (bitmap, 125 KB) | none | Checkbox state. Bit *i* = checkbox *i* |
| `omc:board:seq` | String (int) | none | Monotonic version, incremented on every real change |
| `omc:board:count` | String (int) | none | Checked count, kept up to date by the Lua script (`INCRBY ±1`) so `BITCOUNT` isn't run per request |
| `omc:ch:updates` | Pub/Sub channel | — | Change events, payload `seq:index:value` |
| `omc:ch:control` | Pub/Sub channel | — | Admin and system events (for example `resync`) |
| `omc:sess:<sid>` | Hash | 7 days, sliding | `userId, name, email, picture, createdAt` |
| `omc:oidc:<state>` | Hash | 10 min | PKCE `code_verifier`, `nonce`, `returnTo` during login |
| `omc:user:<sub>:stats` | Hash | none | `toggles`, `lastSeen`, for the profile chip |
| `omc:rl:http:<ip>:<window>` | String (int) | window + 1s | HTTP fixed-window counter |
| `omc:rl:ws:user:<userId>` | Sorted set | 2 × window | WS sliding-window log |
| `omc:rl:conn:<ip>` | String (int) | none (decremented) | Concurrent socket count per IP |
| `omc:rl:block:<userId>` | String | cooldown | Temporary ban after repeated abuse |
| `omc:presence` | Sorted set | — | `member=socketId`, `score=lastHeartbeat`. Stale members are pruned |
| `omc:instance:<id>` | String | 15 s heartbeat | Which instances are alive (shown in the debug panel) |

### Storage choice: bitmap vs alternatives

| Option | Size for 1M | Notes |
|---|---|---|
| One key per checkbox | ~60–80 MB | 1M keys, slow snapshot. Rejected |
| Hash `HSET board i 1` | ~10–40 MB | Better, still large, snapshot is an `HGETALL` |
| JSON array in one key | ~2–6 MB | Read-modify-write races. Rejected |
| **Bitmap (`SETBIT`)** | **125 KB** | O(1) writes, the whole board is one `GET`. **Chosen** |

---

## 5. Authentication: OIDC Authorization Code + PKCE

The provider is configurable through discovery (`OIDC_ISSUER`). Google is the default; Keycloak, Auth0 or Okta work by changing env vars only.

```
Browser                 app                         Redis              Google
  │ GET /auth/login      │                            │                   │
  │─────────────────────►│ make state, nonce,         │                   │
  │                      │ code_verifier              │                   │
  │                      │── SET omc:oidc:<state> ───►│ (10 min TTL)      │
  │◄── 302 to authorize URL (code_challenge=S256) ────┼───────────────────│
  │──────────────────────────────── user signs in ───────────────────────►│
  │◄─────────────────────────── 302 /auth/callback?code&state ────────────│
  │ GET /auth/callback   │── GETDEL omc:oidc:<state> ►│                   │
  │─────────────────────►│── token exchange (code + verifier) ───────────►│
  │                      │◄── id_token, access_token ─────────────────────│
  │                      │ validate id_token (iss, aud, exp, nonce, sig)  │
  │                      │── HSET omc:sess:<sid> ────►│ (7 d TTL)         │
  │◄── Set-Cookie: omc_sid=<sid>; HttpOnly; Secure; SameSite=Lax; 302 / ──│
```

**Rules**

- The session ID is 32 random bytes, base64url. The cookie never holds a token or a user ID.
- Provider tokens are **not** stored or sent to the browser. We only need the identity in the ID token.
- `state` is single-use (`GETDEL`), which blocks replay and login CSRF.
- `POST /auth/logout` deletes the Redis session, clears the cookie, and closes that user's open sockets on every instance (via `omc:ch:control`).
- `GET /api/me` → `{ authenticated, user? }`. The frontend uses it to choose edit mode or read-only mode.

### Authenticating the WebSocket

- The WS server runs with `noServer: true`. On the HTTP `upgrade` event we:
  1. check the `Origin` header against `ALLOWED_ORIGINS`, to stop cross-site WebSocket hijacking;
  2. check the per-IP connection limit;
  3. parse the `omc_sid` cookie and load the session from Redis;
  4. complete the upgrade with `ws.user = session | null` and `ws.id = randomUUID()`.
- Anonymous sockets are accepted but flagged `readOnly`. A write frame from them gets `ERR_AUTH_REQUIRED` and is dropped.
- Sessions are checked again every 60 s on long-lived sockets. If the session is gone (logout elsewhere, expiry), the socket is downgraded to read-only and the client is told.

---

## 6. WebSocket protocol

Binary frames for hot paths, JSON for rare control messages. The first byte is the opcode, so the server can tell them apart without parsing JSON.

### Client → server

| Op | Name | Layout | Notes |
|---|---|---|---|
| `0x01` | `SET` | `u8 op · u32 index · u8 value` (6 B) | Requires auth |
| `0x02` | `PING` | `u8 op` | App-level heartbeat every 25 s |
| `0x7B` (`{`) | JSON control | `{"t":"hello","lastSeq":1234}` | Sent on (re)connect |

### Server → client

| Op | Name | Layout |
|---|---|---|
| `0x81` | `ACK` | `u8 op · u32 index · u8 value · u32 seq` |
| `0x82` | `BATCH` | `u8 op · u32 fromSeq · u16 count · count × (u32 index · u8 value)` |
| `0x83` | `REJECT` | `u8 op · u32 index · u8 code` (`1=auth, 2=rate, 3=range, 4=blocked`) |
| `0x84` | `PONG` | `u8 op` |
| `{` JSON | `welcome` | `{"t":"welcome","socketId","user","seq","online","checked"}` |
| `{` JSON | `stats` | `{"t":"stats","online","checked"}` every 2 s, only when changed |
| `{` JSON | `resync` | `{"t":"resync"}`, which tells the client to refetch the snapshot |
| `{` JSON | `limit` | `{"t":"limit","retryAfterMs"}` |

A 50 ms batch of 200 updates is ~1 KB in binary versus ~8 KB as JSON.

### Connection lifecycle

- **Connect:** register in the local `Map<socketId, ws>`, `ZADD omc:presence`, send `welcome`.
- **Heartbeat:** the server uses `ws.ping()` every 30 s. A socket that misses one pong is `terminate()`d, which cleans up half-open TCP.
- **Disconnect:** remove from the map, `ZREM` presence, decrement `omc:rl:conn:<ip>`, log with socketId and userId.
- **Reconnect (client):** exponential backoff 0.5 s → 1 → 2 → 4 → max 10 s with jitter. It sends `hello{lastSeq}`. If the server's seq minus lastSeq exceeds `RESYNC_GAP` (500), or the subscriber reconnected in between, the client refetches the snapshot. Otherwise it simply continues.

### Refresh behaviour

On refresh the page fetches `GET /api/board` (the 125 KB bitmap as `application/octet-stream`, gzip, `ETag: <seq>`), then opens the socket. Updates that arrive **before** the snapshot finishes are buffered and applied only where `seq > snapshotSeq`, so nothing is lost and nothing is applied twice.

### Pub/Sub delivery gap

Redis Pub/Sub is fire-and-forget. If an instance's subscriber connection drops, that instance misses messages. Mitigation: on subscriber `ready` after a reconnect, the instance broadcasts `resync` to its own sockets. (Stretch goal: use a Redis Stream with `XADD MAXLEN ~10000` so clients can replay from `lastSeq` instead of a full refetch.)

---

## 7. Custom rate limiting

Three layers, cheapest first. All Redis logic runs in Lua, so each check is atomic and takes a single round trip.

### Layer 1: HTTP, fixed window per IP

- Key `omc:rl:http:<ip>:<floor(now/window)>`, `INCR`, and `EXPIRE` on the first hit.
- Limits: `/api/*` 120 requests per 60 s, `/auth/*` 20 requests per 60 s (stricter, since login is costly).
- The response sets `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`. Over the limit it returns `429` with `Retry-After`.
- Client IP comes from `req.ip` with `app.set('trust proxy', 1)`, since nginx sits in front.
- Known weakness, written in the README: up to 2× bursts are possible at window edges. That's acceptable for HTTP and is the reason WS uses a sliding window.

### Layer 2: WebSocket connections per IP

- `INCR omc:rl:conn:<ip>` on upgrade and `DECR` on close. Over `MAX_CONN_PER_IP` (10) the upgrade is refused with `429`.
- Also limit new connections to 30 per minute per IP (fixed window), which stops reconnect storms.

### Layer 3: WebSocket messages

**3a. In-memory token bucket per socket** (no Redis round trip):
- Capacity 10, refill 5 tokens/s. This absorbs a quick burst of real clicks and cuts off scripted floods before they cost Redis anything.

**3b. Sliding-window log per user in Redis** (`ws_limit.lua`):
```
ZREMRANGEBYSCORE key 0 (now - windowMs)
count = ZCARD key
if count >= limit → return {0, oldestScore + windowMs - now}
ZADD key now now..random
PEXPIRE key windowMs*2
return {1, limit - count - 1}
```
- Limit: 20 toggles per 1 s window per **userId**. Keying on the user rather than the socket means opening five tabs doesn't get five times the budget.

**3c. Escalation**
- Each rejection increments `omc:rl:strikes:<userId>` (TTL 60 s).
- After 10 strikes in 60 s: `SET omc:rl:block:<userId> 1 EX 120`. Every write gets `REJECT code=4` until it expires, and the UI shows a cooldown timer.
- After 3 blocks the socket is closed with code `1008` (policy violation).

### Payload validation (abuse that isn't volume)

- Reject a frame whose length doesn't match its opcode, an index ≥ 1,000,000, or a value not in {0,1}.
- `maxPayload: 1024` on the ws server, so oversized frames close the socket.
- Unknown opcode: increment strikes.

---

## 8. Frontend design

### Design direction: a punched ledger

The subject is a single, shared, enormous sheet that strangers mark together. The visual idea is **a sheet of engineering ledger paper**: a cool, slightly blue paper ground with a fine ruled grid, and checked cells filled in a deep ink blue, like pencil marks on an accountant's ledger. That keeps it out of both the neon-hacker look and the beige editorial look. The grid is the hero; the chrome stays quiet around it.

**Palette**

| Token | Hex | Use |
|---|---|---|
| `--paper` | `#EEF2F5` | Page and grid background |
| `--rule` | `#C9D3DC` | Grid lines, borders |
| `--ink` | `#1F2E4A` | Text, checked cells |
| `--signal` | `#E2A400` | Your own recent toggles (brief highlight), focus ring |
| `--live` | `#3D7DD8` | Cells changed by others in the last ~800 ms (fades to `--ink`) |
| `--alert` | `#C2412D` | Rate-limit and error states only |

Dark mode: `--paper #141B26`, `--rule #26324A`, `--ink #DCE6F2`. `--signal` and `--live` keep their hue and get re-checked for contrast. Dark mode is triggered by `prefers-color-scheme` and can be overridden with a toggle in the header.

**Type**

- **Bricolage Grotesque** (variable): wordmark and the big live counter. The counter is the one expressive type moment, set large with tabular numerals and tight tracking.
- **Inter Tight**: everything else (UI, body, buttons), 14/16 px base, scale 1.25.
- No monospace and no all-caps labels. Numbers use `font-variant-numeric: tabular-nums` so the counters don't jitter.

**Layout**

```
Desktop
┌───────────────────────────────────────────────────────────────┐
│ ▣ One Million Checkboxes        412,903 checked   ● 87 online │
│                                         [Go to #…]  (avatar ▾)│
├───────────────────────────────────────────────────────────────┤
│                                                               │
│                canvas grid (fills viewport)                   │
│                pan: drag / wheel     zoom: ctrl+wheel / pinch │
│                                                               │
│                                                    ┌────────┐ │
│                                                    │minimap │ │
│                                                    └────────┘ │
├───────────────────────────────────────────────────────────────┤
│ Viewing #503,200–#541,880 · Read-only: sign in to check boxes │
└───────────────────────────────────────────────────────────────┘

Mobile (≤ 640px)
┌─────────────────────┐
│ ▣ 412,903   ● 87  ☰ │
├─────────────────────┤
│                     │
│   canvas grid       │
│   (pinch / drag)    │
│                     │
├─────────────────────┤
│ [ Sign in to play ] │
└─────────────────────┘
```

Content is left aligned. The header is a single line. The status bar holds context ("Viewing #… to #…") and the single call to action for anonymous users.

**Signature moment:** when other people's toggles land in your viewport, those cells pulse once in `--live` blue and settle to ink. The board visibly breathes with other users' activity. This is the only ambient motion, and it is turned off under `prefers-reduced-motion` (cells change color instantly instead).

### Rendering 1M checkboxes without 1M DOM nodes

- **State:** one `Uint8Array(125_000)` bitset, the exact bytes from `/api/board`. `get(i) = (bits[i>>3] >> (7 - (i&7))) & 1` uses Redis bit order (MSB-first).
- **Rendering:** one `<canvas>`, sized with `devicePixelRatio`. Only visible cells are drawn: visible rows × cols at the current zoom is a few thousand at most.
- **Dirty drawing:** incoming batches mark cells dirty. One `requestAnimationFrame` loop redraws only dirty cells, or the full viewport after a pan or zoom. There is never more than one draw per frame.
- **Zoom levels:** at cell size 16–28 px, draw checkbox outlines plus a checkmark. At 4–15 px, draw filled squares. Below 4 px (an overview of the whole board), draw an `ImageData` from the bitset with one pixel per cell, which renders the full 1000×1000 board in about 2 ms.
- **Hit testing:** pixel → `(row, col)` → `index = row * 1000 + col`. No DOM per cell.
- **Minimap:** a 200×200 `ImageData` downsample, redrawn at most once a second, with a viewport rectangle you can drag.
- **Go to #:** jump to and center any index. The URL hash `#523417` is kept in sync, so a link can point at a specific checkbox.

### Accessibility (canvas needs extra work)

- The canvas is `role="grid"` with `aria-label`. A roving focus cell is navigable with arrow keys, toggled with Space or Enter, and the page/Home/End keys work.
- An `aria-live="polite"` region announces "Checkbox 523,417 checked" after your own toggle.
- The focused cell has a 2 px `--signal` focus ring that is always visible.
- Hit targets are at least 24 px at the default mobile zoom.
- All text meets WCAG AA in both themes.

### Client state flow

```
snapshot (HTTP) ─► bitset ◄─ BATCH frames (ws)
                     ▲
click ─► optimistic set ─► pending Map<index, prevValue> ─► SET frame
                     ▲                               │
                     └── ACK: delete pending ◄───────┤
                     └── REJECT: restore prev, toast ┘
```

### UI copy

| Situation | Copy |
|---|---|
| Anonymous status bar | "You're viewing live. Sign in to check boxes." + **Sign in** |
| Rate limited | "Slow down — you can check more boxes in 3s." |
| Blocked | "Paused for 2 minutes after too many rapid clicks." |
| Disconnected | "Connection lost. Reconnecting…" (amber dot) |
| Reconnected | "Back online. Board is up to date." (auto-dismiss) |
| Session expired | "Your session ended. Sign in again to keep checking." |
| Server error | "Couldn't load the board. Retry" |

Toasts appear bottom-center, one at a time, and are announced through `aria-live`.

---

## 9. HTTP API

| Method | Path | Auth | Limit | Response |
|---|---|---|---|---|
| GET | `/` | — | — | `index.html` (static) |
| GET | `/auth/login?returnTo=` | — | auth | 302 to provider |
| GET | `/auth/callback` | — | auth | Sets cookie, 302 |
| POST | `/auth/logout` | session | auth | 204 |
| GET | `/api/me` | optional | api | `{authenticated, user}` |
| GET | `/api/board` | — | api | `application/octet-stream`, 125 KB, `X-Board-Seq` |
| GET | `/api/stats` | — | api | `{checked, online, instances}` |
| GET | `/healthz` | — | — | `{ok, redis, instance}` for compose and the proxy |

Writes happen **only** over WebSocket. No HTTP toggle endpoint means one write path to protect.

**Error handling:** a central Express error middleware turns errors into `{error:{code,message}}` with the right status, and never leaks stack traces in production. Async route errors go through a small `asyncHandler` wrapper. `process.on('unhandledRejection')` logs and exits; Docker restarts the process. Graceful shutdown on `SIGTERM`: stop accepting connections, close sockets with code `1001`, flush the batch, `quit()` Redis.

---

## 10. Project structure

```
one-million-checkboxes/
├─ server/
│  ├─ index.js                 # boot: config → redis → http → ws → listen; graceful shutdown
│  ├─ app.js                   # express app: helmet, static, routes, error middleware
│  ├─ config.js                # env parsing + validation (fail fast)
│  ├─ logger.js
│  ├─ redis/
│  │  ├─ client.js             # main + subscriber connections
│  │  ├─ keys.js               # every key name, in one place
│  │  ├─ board.js              # getSnapshot, setBit (Lua), stats
│  │  └─ scripts/
│  │     ├─ toggle.lua
│  │     ├─ ws_limit.lua
│  │     └─ http_limit.lua
│  ├─ auth/
│  │  ├─ oidc.js               # discovery, client, PKCE helpers
│  │  ├─ sessions.js           # create/get/destroy/touch in Redis
│  │  ├─ routes.js             # /auth/login, /auth/callback, /auth/logout
│  │  └─ middleware.js         # attachUser, requireUser
│  ├─ ratelimit/
│  │  ├─ httpLimiter.js        # express middleware (fixed window)
│  │  ├─ tokenBucket.js        # in-memory, per socket
│  │  ├─ wsLimiter.js          # sliding window + strikes + block
│  │  └─ connLimiter.js
│  ├─ realtime/
│  │  ├─ wsServer.js           # upgrade handling, auth, lifecycle, heartbeat
│  │  ├─ protocol.js           # binary encode/decode, opcodes
│  │  ├─ handlers.js           # onSet, onHello, onPing
│  │  ├─ broadcaster.js        # pub/sub subscribe → 50 ms batch → local fan-out
│  │  └─ presence.js
│  ├─ routes/
│  │  ├─ api.js                # /api/me, /api/board, /api/stats
│  │  └─ health.js
│  └─ utils/
│     ├─ asyncHandler.js
│     └─ errors.js             # AppError + codes
├─ public/
│  ├─ index.html
│  ├─ styles/
│  │  ├─ tokens.css            # palette, type, spacing, dark mode
│  │  └─ app.css
│  └─ js/
│     ├─ main.js               # boot sequence
│     ├─ bitset.js
│     ├─ api.js                # fetch /api/me, /api/board
│     ├─ socket.js             # connect, reconnect/backoff, encode/decode
│     ├─ protocol.js           # same opcodes as the server
│     ├─ renderer.js           # canvas, viewport, zoom levels, dirty rects
│     ├─ input.js              # pointer, wheel, pinch, keyboard
│     ├─ minimap.js
│     └─ ui.js                 # header, status bar, toasts, auth chip
├─ tests/
│  ├─ protocol.test.js
│  ├─ tokenBucket.test.js
│  ├─ wsLimiter.test.js        # against a real Redis (compose service)
│  ├─ board.test.js
│  └─ api.test.js
├─ scripts/
│  ├─ loadtest.js              # N sockets × M toggles/s, reports p50/p95 fan-out latency
│  └─ seed.js                  # optional: random pattern for demo
├─ deploy/
│  └─ nginx.conf               # upstream app1/app2, ws upgrade headers
├─ docker-compose.yml          # redis (AOF on), app1, app2, nginx
├─ Dockerfile
├─ .env.example
├─ .gitignore
├─ package.json
├─ PROJECT.md                  # this file
└─ README.md
```

The client and server `protocol.js` define the same opcodes. A test checks that they match.

---

## 11. Environment variables (`.env.example`)

```bash
# Server
NODE_ENV=development
PORT=3000
INSTANCE_ID=app1                       # shown in /healthz and logs
PUBLIC_URL=http://localhost:8080       # used for OIDC redirect URI
ALLOWED_ORIGINS=http://localhost:8080,http://localhost:3000
TRUST_PROXY=1

# Redis
REDIS_URL=redis://localhost:6379

# OIDC (Google by default — any OIDC issuer works)
OIDC_ISSUER=https://accounts.google.com
OIDC_CLIENT_ID=
OIDC_CLIENT_SECRET=
OIDC_REDIRECT_PATH=/auth/callback
OIDC_SCOPES=openid profile email

# Sessions
SESSION_COOKIE_NAME=omc_sid
SESSION_TTL_SECONDS=604800
COOKIE_SECURE=false                    # true in production (HTTPS)

# Board
BOARD_SIZE=1000000
BROADCAST_INTERVAL_MS=50
RESYNC_GAP=500

# Rate limits
RL_HTTP_API_LIMIT=120
RL_HTTP_API_WINDOW_S=60
RL_HTTP_AUTH_LIMIT=20
RL_WS_BUCKET_CAPACITY=10
RL_WS_BUCKET_REFILL_PER_S=5
RL_WS_USER_LIMIT=20
RL_WS_USER_WINDOW_MS=1000
RL_WS_STRIKES_TO_BLOCK=10
RL_WS_BLOCK_SECONDS=120
RL_MAX_CONN_PER_IP=10
```

`config.js` validates types and ranges at boot and refuses to start in production if `COOKIE_SECURE` is false.

---

## 12. Security checklist

- [ ] Session cookie: `HttpOnly`, `SameSite=Lax`, `Secure` in prod, opaque random ID
- [ ] PKCE (S256) + `state` (single-use) + `nonce` checked in the ID token
- [ ] `Origin` check on WS upgrade (`ALLOWED_ORIGINS`)
- [ ] `POST` for logout (no CSRF logout through `<img>`)
- [ ] Helmet CSP: `default-src 'self'`, `connect-src 'self' wss:`, fonts from Google allowed
- [ ] `ws` `maxPayload` limit; strict frame-length validation
- [ ] No secrets in the repo; `.env` git-ignored; `.env.example` complete
- [ ] Error responses without stack traces in production
- [ ] Redis not exposed publicly in compose (internal network only)

---

## 13. Testing and verification

| What | How |
|---|---|
| Protocol encode/decode round-trips, malformed frames rejected | Unit (vitest) |
| Token bucket refill math | Unit with fake timers |
| Sliding window: 20 allowed, 21st rejected, allowed again after the window | Integration against real Redis |
| Strikes lead to a block, which expires | Integration |
| Toggle Lua: no-op returns `changed=0` and doesn't publish; seq increments | Integration with a test subscriber |
| `/api/board` returns 125,000 bytes and `X-Board-Seq` | supertest |
| Unauthenticated `SET` → `REJECT code=1` | Integration with a ws client |
| Cross-instance fan-out: client on app1 toggles, client on app2 receives | `scripts/loadtest.js --verify` through compose |
| Load: 500 sockets, 2 toggles/s each | loadtest reports p95 latency (< 150 ms target) and limiter rejections |
| Frontend | Manual: two windows, refresh mid-stream, offline/online, mobile pinch, keyboard-only, reduced motion |

---

## 14. Build milestones

Each milestone ends in something that runs.

1. **Skeleton:** package.json, config validation, Express with static files and `/healthz`, Redis connection, Docker Compose with Redis. *Done when* `docker compose up` shows healthy.
2. **Board in Redis:** `keys.js`, `toggle.lua`, `GET /api/board`, `seed.js`. *Done when* curl returns 125,000 bytes.
3. **Canvas grid (read-only):** bitset, renderer with zoom levels, pan and zoom input, minimap, Go to #. *Done when* 1M cells scroll at 60 fps.
4. **WebSocket single instance:** protocol, ws server, SET → Lua → ACK, broadcaster batching, heartbeat, reconnect with backoff. *Done when* two windows sync.
5. **Multi-instance:** Pub/Sub broadcaster, app2 + nginx in compose, `resync` on subscriber reconnect. *Done when* a window on :3001 and a window on :3002 sync.
6. **Auth:** OIDC login, callback and logout, Redis sessions, `/api/me`, WS upgrade auth, read-only mode UI. *Done when* anonymous users can only watch.
7. **Rate limiting:** HTTP limiter, connection limiter, token bucket, sliding window, strikes and block, UI feedback. *Done when* loadtest shows rejections and the UI shows the cooldown.
8. **Polish:** dark mode, live-pulse moment, accessibility pass, mobile layout, empty, error and offline states.
9. **Tests and load test:** the suites in §13 pass.
10. **Ship:** deploy (Railway or Render for the app + Upstash/Redis Cloud, or a single VPS running compose), README, screenshots, demo video.

---

## 15. Deployment

- **Option A (simplest): one VPS** running `docker compose up -d` (nginx, 2 app replicas, Redis with AOF) plus Caddy or certbot for HTTPS. This shows multi-instance fan-out in production.
- **Option B: Render or Railway** with 2 web instances, managed Redis, and `REDIS_URL` set. Check that the platform supports WebSocket upgrades and that sticky sessions aren't needed (they aren't, because all state is in Redis).
- Register the production redirect URI `https://<domain>/auth/callback` with the OIDC provider.
- Production: `COOKIE_SECURE=true`, `NODE_ENV=production`, and `ALLOWED_ORIGINS` set to the real domain.

---

## 16. README outline (required sections)

1. Project overview + screenshot/GIF + live link + YouTube demo link
2. Tech stack
3. Features implemented (checklist)
4. Architecture diagram (§3) and the write path in 6 steps
5. How to run locally
   - With Docker: `cp .env.example .env` → fill in OIDC → `docker compose up` → open `http://localhost:8080`
   - Without Docker: Redis install (`docker run -p 6379:6379 redis:7` / WSL / Memurai on Windows), `npm i`, `npm run dev`
6. Environment variables (table from §11)
7. Redis setup + key design (§4) + "Why Redis"
8. Auth flow (§5 diagram)
9. WebSocket flow + protocol table (§6)
10. Rate limiting logic (§7) with the window/counter/expiry explanation
11. Scaling notes and known limits (Pub/Sub at-most-once, fixed-window edge bursts, single bitmap key hot spot, where it would go next: Redis Streams, sharded boards, Redis Cluster)
12. Running tests and load test
13. Project structure

---

## 17. Demo video script (~4 min, YouTube unlisted)

1. **0:00 Intro** (15 s): what it is; the architecture diagram on screen.
2. **0:15 Anonymous view** (20 s): open the site signed out, the grid loads, live counter, try clicking → "Sign in to check boxes".
3. **0:35 Login** (30 s): click Sign in → Google consent → back, avatar shown. Show the `omc_sid` cookie (HttpOnly) in DevTools.
4. **1:05 Grid** (30 s): zoom from the whole-board overview into individual checkboxes, minimap, Go to #523417.
5. **1:35 Real time** (45 s): two windows side by side, one through app1 (:3001) and one through app2 (:3002). Toggle in one; it appears in the other. Point out the `INSTANCE_ID` badge to prove it's two servers going through Redis Pub/Sub.
6. **2:20 Refresh** (15 s): refresh a window; the state persists.
7. **2:35 Rate limiting** (40 s): run `scripts/loadtest.js` or hold an auto-clicker. Show the toast, the cooldown and the server logs with rejections. Use `redis-cli` to `ZCARD omc:rl:ws:user:<id>` and `TTL omc:rl:block:<id>`.
8. **3:15 Redis tour** (25 s): `redis-cli`: `STRLEN omc:board` → 125000, `GETBIT`, `SUBSCRIBE omc:ch:updates` showing live events.
9. **3:40 Wrap** (20 s): repo structure and README.

---

## 18. Evaluation mapping

| Criterion | Where it's covered |
|---|---|
| Core functionality (20) | §3 write path, §6 refresh behaviour, §8 rendering |
| WebSocket (20) | §6 protocol, lifecycle, reconnect; `server/realtime/*` |
| Redis (20) | §4 key design, Lua atomicity, Pub/Sub broadcaster, "Why Redis" |
| Custom rate limiting (15) | §7 three layers, no packages, window/counter/expiry explained |
| OIDC auth (15) | §5 code + PKCE, Redis sessions, WS upgrade auth, read-only mode |
| Frontend quality (10) | §8 canvas, dirty redraw, responsive, a11y |
| Backend structure (10) | §10 layout, §9 error handling, §11 config validation |
| Demo video (10) | §17 script |
| README (10) | §16 outline, `.env.example` |
| System thinking (10) | §3 concurrency rule, §6 Pub/Sub gap, §7 escalation, §16 scaling notes |

---

## 19. Open decisions

- **OIDC provider:** Google (default, nothing to host) or a local Keycloak container (works offline, more setup). The plan uses Google; the code is issuer-agnostic.
- **Hosting:** VPS with compose (shows 2 instances) or a PaaS (less ops work).
- **Stretch goals:** Redis Stream replay, a per-user "boxes you've checked" count on the profile chip, a heatmap overview mode.
