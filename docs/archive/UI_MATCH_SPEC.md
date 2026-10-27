# UI match spec: "million/boxes" look

**Goal:** make the React client in `client/` look like the reference site at **https://upset-toes-hammer.freebuff.dev**: a green phosphor-terminal landing page at `/` and a dashboard-style grid page at `/grid`.

Keep this app's engine and all its features. Only the look and layout change, plus the two small engine changes in U3.

- **Reference:** https://upset-toes-hammer.freebuff.dev (landing) and https://upset-toes-hammer.freebuff.dev/grid (grid).
  - First, open both in the browser at 1440×900 and 390×844 and take screenshots.
  - Scroll the landing page slowly: its sections fade in on scroll, so a single full-page screenshot shows empty space.
  - If the site doesn't load (it may be behind a Freebuff gate), use the values in this file. They were measured from the live site.
- **Branch:** create `freebuff-ui` from `react-vite`. Don't change `main` or `react-vite`.
- **One commit per ID** (`U4: landing page`).

## Rules

1. **Change the presentation only.** Leave these files alone:
   - `client/src/engine/` (except the two changes in U3)
   - `server/`
   - `tests/`

   That way all sync, rate-limit and correctness behaviour stays as it is.
2. **Don't copy the reference's source code.** Rebuild the look with this app's own components and CSS.
3. **Never show anyone's email address**, not even masked. The reference's feed shows `r*****@protonmail.com`; that's a privacy leak. Feeds show box numbers, times and "you".
4. **No new UI libraries:** no Tailwind, shadcn, Framer Motion, GSAP or React Router. Plain CSS and React only.
5. **Keep these features**, which the reference doesn't have:
   - zoom, Fit and the minimap
   - check marks in lit boxes (it's a checkbox app)
   - keyboard navigation, `aria-live` announcements and `prefers-reduced-motion` support
6. **Quality bar:**
   - `npm test` passes (28 tests).
   - `npm run build` succeeds.
   - No console errors.
   - No horizontal scroll at 390 px.

---

## U1. Design tokens

**File:** replace `client/src/styles/tokens.css`. Keep the variable names the renderer reads (`--desk`, `--paper`, `--paper-elevated`, `--paper-subtle`, `--rule`, `--rule-strong`, `--box`, `--ink`, `--ink-muted`, `--ink-on-fill`, `--cell-on`, `--glow`, `--margin`, `--signal`, `--live`).

| Token | Value | Use |
|---|---|---|
| `--bg` / `--desk` | `#060c08` | Page background, desk around the sheet |
| `--paper` | `#0a110c` | Inside the board panel |
| `--card` / `--paper-elevated` | `#0d1410` | Cards, panels, terminal window |
| `--paper-subtle` | `#161d19` | Hover fills, stat tiles |
| `--border` / `--rule-strong` | `#28342c` | All borders (cards use it at 70% opacity) |
| `--rule` | `#141c17` | Faint board rules, grid-paper lines |
| `--box` | `#2f3d34` | Empty box outline (subtle, like the reference) |
| `--ink` | `#dfece1` | Main text, big numbers |
| `--ink-muted` | `#8b9e8f` | Body text, captions (the most-used text colour) |
| `--primary` / `--cell-on` | `#62eb80` | Neon green: lit boxes, primary buttons, accents |
| `--primary-ink` / `--ink-on-fill` | `#031108` | Text on green buttons, check mark inside lit boxes |
| `--primary-soft` | `rgba(98, 235, 128, 0.12)` | Icon tiles, live pill background |
| `--glow` | `rgba(98, 235, 128, 0.18)` | Halo behind lit boxes |
| `--ring` | `#3b9555` | Focus rings |
| `--signal` | `#eab532` | Your own clicks and the focus box on the board |
| `--live` | `#62eb80` | Other people's clicks |
| `--margin` | `#28342c` | The sheet margin line (no colour accent in this theme) |
| `--alert` | `#f54748` | Errors, paused budget |
| Terminal dots | `#e5484d`, `#eab532`, `#46c463` | The three window buttons on the terminal card |

**Type:**
- `--font-mono: 'JetBrains Mono', 'SFMono-Regular', ui-monospace, Menlo, monospace` (already loaded in `client/index.html`).
- `--font-sans: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif`.
- Remove Bricolage Grotesque from the font link.

**Radius:** 6px for cards and panels, 4px for buttons and inputs, 999px for pills.

**Shadows:** almost none. The reference is flat; depth comes from borders and the green glow.

---

## U2. Shared look

**File:** rewrite `client/src/styles/app.css` (keep the class names the components use, or rename them in the components at the same time).

- **Labels (the reference's signature):** monospace, 11–12px, `text-transform: uppercase`, `letter-spacing: 0.18em`, colour `--ink-muted`. Examples: `GRID`, `LIVE · READ-ONLY`, `SCROLL TO EXPLORE`.
- **Eyebrows above section titles:** `// WHAT IT ACTUALLY DOES`. Mono 11px, uppercase, `letter-spacing: 0.2em`, colour `--primary`.
- **Headings:** sans, bold, `letter-spacing: -0.02em`. h1 on the grid page 30px. Section h2 30px.
- **Body text:** sans 15–17px, `line-height: 1.6`, `--ink-muted`.
- **Primary button:**
  - mono 12px, uppercase, `letter-spacing: 0.12em`
  - background `--primary`, text `--primary-ink`
  - height 40px, padding 0 16px, radius 4px, trailing `→` arrow icon
  - hover: `box-shadow: 0 0 24px -4px rgba(98,235,128,.6)`
- **Secondary button:** same type, transparent background, 1px `--border` border, text `--ink`. Hover: border `rgba(98,235,128,.4)`.
- **Card:**
  - background `rgba(13,20,16,.3)` (`--card` at 30%)
  - border 1px `rgba(40,52,44,.7)`, radius 6px, padding 20px
- **Icon tile:** 36×36, radius 4px, background `--primary-soft`, 16px green stroke icon (inline SVG, Lucide-style paths).
- **Grid-paper background:** two `linear-gradient`s of `rgba(40,52,44,.6)` 1px lines every 32px. Used behind the hero and the architecture section.
- **Hero glow:** `radial-gradient(ellipse at 60% 30%, rgba(98,235,128,.10), transparent 60%)`.
- **Live pill:** `● LIVE` in a 999px pill, 1px green border at 40%, background `--primary-soft`, green text, mono 11px uppercase.

### Measured on the live site (1440×900); use these exact values

| Element | Font | Size / weight | Letter spacing | Other |
|---|---|---|---|---|
| Header bar | — | 57px tall | — | background `--bg` at 85% with backdrop blur not required (use solid), 1px bottom border |
| Logo text `million/boxes` | mono | 14px / 700 | -0.35px | — |
| Nav link (GRID…) | mono uppercase | 12px / 400 | 0.6px | padding 6px 12px, radius 4px, colour `--ink-muted` |
| `Sign in` link | mono | 12px / 500 | normal | 32px tall, padding 0 12px |
| `Open grid →` button | mono | 12px / 500 | normal | 32px tall, padding 0 10px, radius 4px, green |
| Cohort badge | mono uppercase | 10px / 500 | 1.8px | pill, padding 2px 8px, 1px border green at 40% |
| h1 | mono | 60px / 700, line-height 63px | -1.5px | width 559px |
| Hero paragraph | sans | 16px / 400, line-height 26px | normal | `--ink-muted` |
| `ENTER THE GRID →` / `SIGN IN TO WRITE` | mono uppercase | 12px / 500 | 0.6px | 40px tall, padding 0 16px, radius 4px, 12px gap between them |
| Footnote under buttons | mono uppercase | 10px / 400 | 0.5px | `--ink-muted` |
| Terminal card | — | 505 × 293px | — | `--card` at 60%, 1px border at 70%, radius 6px |
| Terminal title `GRID-BROADCAST --FOLLOW` | mono uppercase | 10px / 400 | 1.5px | — |
| Terminal lines | mono | 11px / 400, line-height 16.5px | normal | — |
| Ticker items | mono uppercase | 10px / 400 | 2px | — |
| Eyebrow `// …` | mono uppercase | 11px / 400 | 2.2px | green |
| Section h2 | sans | 30px / 700, line-height 36px | -0.75px | — |
| Section intro | sans | 14px / 400, line-height 22.75px | normal | max width 672px, muted |
| Feature card | — | 357 × 189px, padding 20px | — | `--card` at 30%, 1px border at 70%, radius 6px; 3 columns, 16px gap |
| Feature title | sans | 16px / 600 | -0.4px | — |
| Feature text | sans | 13px / 400, line-height 21px | normal | muted |
| Closing CTA heading | mono | 30px / 700 | -0.75px | see U4 |
| Footer | — | 80px tall | — | `--card` at 20%, 1px top border |

Content column: **1104px** wide, starting at x=160 on a 1440px screen.

---

## U3. Engine: live data without a board, and two new values

**Files:** `client/src/engine/boardEngine.js`, `client/src/App.jsx`

The landing page shows live numbers and a live feed but has no canvas. So split `mount(canvas, minimapCanvas)` in two:

1. **`start()`** connects the socket, loads `/api/me` and the snapshot, and starts the timers. It's idempotent and called once from `main.jsx`.
2. **`attachBoard(canvas, minimapCanvas)`** creates the renderer, minimap and input handlers, and returns a cleanup that detaches them. It must work when you go to `/grid`, back to `/`, and to `/grid` again.
   - Every place the engine calls `renderer.` or `minimap.` must be guarded so it no-ops while no board is attached. The bitsets and sequencer must keep updating anyway.
   - Move the first-snapshot "zoom from the whole sheet into the target" so it runs the first time a board attaches, not on snapshot load.

**New store values:**
- `writes`: the server's `seq`, taken from `welcome` and `stats` messages.
- `feed`: the last 12 changes, `{ index, value, at, mine }`. Remote changes come from the sequencer `apply` path; your own from `toggleCell`.
- Never put a user name or email into `feed`.

Add a test in `tests/` only if the change is pure logic; otherwise check it manually (see Final check).

---

## U4. Landing page (`/`)

**New file:** `client/src/pages/Landing.jsx`

Content width is **1104px**, centred, with a 16px side gutter on phones. From top to bottom:

```
┌ nav (sticky, 57px, bottom border) ─────────────────────────────────────────┐
│ [▣] million/boxes          GRID   ARCHITECTURE   FEATURES     Sign in  [Open grid →] │
└────────────────────────────────────────────────────────────────────────────┘
  ┌ badge pill ┐
  │ ✳ WEB DEV COHORT 2026 · FULL STACK │          ┌ terminal card ──────────────────┐
  one million                                   │ ● ● ●  GRID-BROADCAST --FOLLOW   │
  checkboxes_   ← line 2 green, "_" blinks      │ $ subscribing to realtime channel… │
  A real-time grid of 1,000,000 toggles…        │ $ 183 lit · 189 writes · 0.0183% … │
  [ENTER THE GRID →] [🔑 SIGN IN TO WRITE]      │ [x] box #3,035              3:34 │
  GUESTS WATCH LIVE · SIGN IN TO WRITE          │ [ ] box #9,037              3:36 │
                                                │ $ █                               │
                                                └──────────────────────────────────┘
──── ticker (full width, borders top and bottom, scrolls left forever) ──────
 ● LIT 183   ● WRITES 189   ● EXPLORED 0.0183%   ● STORAGE 125,000 B   ● TRANSPORT WEBSOCKET …
──────────────────────────────────────────────────────────────────────────────
  // WHAT IT ACTUALLY DOES
  One grid, six engineering problems
  [card][card][card]
  [card][card][card]      ← 3×2 grid, 16px gaps, each: icon tile, title, 2–3 line text
  // ARCHITECTURE  (grid-paper background behind this section)
  From click to every other window
  [01 BROWSER][02 GATEWAY][03 STATE]   ← header row: icon tile + mono label + number right
  ┌ closing CTA card (centred, bordered) ───────────────┐
  │        999,817 boxes still dark                      │  ← live: 1,000,000 − checked
  │   short line of muted text            [ENTER THE GRID →] │
  └──────────────────────────────────────────────────────┘
  footer: MILLION/BOXES · REALTIME CHECKBOX GRID          ∿ 189 WRITES  grid  console
```

Specifics:
- **Logo:** a 28px square with a 1.5px `--ink` border and a small "+–" glyph, then `million/boxes` in mono bold 14px.
- **Nav links** are uppercase mono labels. They scroll to `#architecture` and `#features`, or go to `/grid`.
- **h1:** mono, 60px (40px on phones), weight 700, line-height 63px, letter-spacing -1.5px.
  - Line 1 is `--ink`; line 2 `checkboxes` is `--primary`.
  - The `_` cursor blinks with `steps(1)` at 1.1s and stays solid under reduced motion.
  - Green text gets `text-shadow: 0 0 24px rgba(98,235,128,.35)`.
- **Terminal card:**
  - 500px wide, `--card` background, `--border` border, radius 6px, three coloured dots in the title bar.
  - Its lines are mono 12px and come from `store.feed`: `[x]` for checked, `[ ]` for unchecked, `box #N` in `--ink`, time right-aligned in `--ink-muted`.
  - The second line shows live `lit · writes · explored%` from the store.
  - Ends with a blinking block cursor.
- **Ticker:**
  - Duplicate the item list twice and translate it `-50%` in a 40s linear infinite animation. Pause on hover; static under reduced motion.
  - Items: green dot, uppercase mono label in `--ink-muted`, bold value in `--ink`.
  - Values: lit, writes, explored %, storage `125,000 B`, transport `WEBSOCKET`, instances (from `/api/stats`).
- **Feature cards** (write the copy for this app, plainly):
  1. Real-time by default
  2. Canvas rendering, zoom to the whole sheet
  3. One Redis bitmap, 125 KB
  4. Custom rate limiting (token bucket + sliding window)
  5. OIDC sign-in, guests watch live
  6. Multi-instance via Redis Pub/Sub
- **Architecture cards:**
  - 01 BROWSER: canvas, sequencer, optimistic overlay
  - 02 SERVER: Express + ws, auth, rate limits
  - 03 REDIS: Lua toggle, Pub/Sub, Streams

  Each card has 3 `›` bullet lines in mono 12px.
- **Scroll reveal:** sections fade and rise 12px once when they enter the viewport (IntersectionObserver). Run it once; under reduced motion, everything is visible from the start.

---

## U5. Grid page (`/grid`)

**New file:** `client/src/pages/GridPage.jsx`. Reuse `Toolbar`, `MapPanel` and the existing overlays inside the board panel.

```
nav (same as landing)
LIVE GRID · 1000 × 1000                                  [jump to index…] [◎ Go] [⤮ Random]
The Grid
183 of 1,000,000 boxes lit — every write is broadcast to all connected windows in real time.
┌ read-only notice (only when signed out) ───────────────────────────────────────────┐
│ [🔒] You're watching in read-only mode                          [Sign in to write →] │
│      Every change streams in live. Sign in to check boxes.                          │
└────────────────────────────────────────────────────────────────────────────────────┘
(● LIVE) READ-ONLY                         SCROLL TO EXPLORE  │ ┌ LIVE SIGNAL ────────┐
┌ board panel: border, radius 6px ──────────────────────────┐ │ │ [◎ LIT ] [↻ WRITES ]│
│  <canvas> fills the panel, height clamp(420px, 62vh, 720px)│ │ │  183      189       │
│  toolbar bottom-left, map bottom-right (existing comps)    │ │ │ [👥 ONLINE][▦ STORE]│
└────────────────────────────────────────────────────────────┘ │ ├ YOUR WRITE BUDGET ──┤
caption: canvas · only visible boxes are drawn · 1,000,000     │ │ BURST · PER CLICK 3/10│
states in one 125 KB Redis bitmap                              │ │ ▓▓▓░░░░░░░           │
                                                               │ │ PER USER · 1s  3/20  │
                                                               │ ├ CONNECTIONS ────────┤
                                                               │ │ ● you (Priya)        │
                                                               │ │ + 4 others           │
                                                               │ ├ BROADCAST FEED ─────┤
                                                               │ │ [x] box #3,035  3:34 │
                                                               └─└─────────────────────┘
```

- **Layout:** two columns, `minmax(0,1fr) 320px` with a 20px gap. Below 900px it becomes one column, with the sidebar under the board.
- **Board panel:** the canvas goes inside a bordered panel, not full-bleed. `renderer.resize()` already reads the canvas's size; call it on a `ResizeObserver` of the panel.
- **Board look:**
  - Lit boxes are solid `--cell-on` green squares with the dark check mark.
  - Empty boxes are the faint `--box` outline.
  - Keep the ledger rules subtle (`--rule`).
  - No margin colour.
- **Go:** reuse `GotoForm` logic (0–999,999).
- **Random:** `engine.jumpTo(Math.floor(Math.random() * 1_000_000))`.
- **Stat tiles:**
  - LIT = `checked`, caption `X% explored`
  - WRITES = `writes`, caption `accepted toggles`
  - ONLINE = `online`, caption `live sessions`
  - STORAGE = `125 KB`, caption `one Redis bitmap`
  - Each tile: icon + uppercase mono label, big mono number 20px `--ink`, caption mono 11px muted.
- **Write budget:**
  - Two 6px bars, fill `--primary`, track `--paper-subtle`.
  - **Burst:** used tokens of the per-socket bucket (`capacity - floor(level)` of `engine.budget`, live via rAF).
  - **Per user · 1s window:** count of your own sends in the last 1000 ms, out of 20.
  - Under them, one short mono line explaining the server limits.
  - When paused, the bars turn `--alert` and show `Paused 1:52`.
- **Connections:** `● you (display name)` or `● you (guest)`, then `+ N others` from `online - 1`. No other names (the server doesn't send them, and must not).
- **Broadcast feed:** the same rows as the landing terminal, newest first, max 12. Clicking a row jumps to that box.
- Drop the old full-width header, footer and activity line on this page; the sidebar replaces them. Keep the `Toast`, `HintCard`, `Announcer` and `SignInDialog` components.

---

## U6. Routing and server fallback

**Files:** new `client/src/router.js`, `client/src/App.jsx`, `server/app.js`

- **Tiny router (no library):** read `location.pathname`. A `navigate(path)` function calls `history.pushState` and re-renders; listen to `popstate`. `/` shows Landing, `/grid` shows GridPage, anything else shows Landing.
- **Express:** after the static middleware, serve `client/dist/index.html` for `GET /grid` (an SPA fallback for that route only), so refreshing on `/grid` works. Keep `/api`, `/auth`, `/ws` and `/healthz` untouched.
- **Keep links working:**
  - `#523417` box links → `/grid#523417`.
  - Dev login's `returnTo` must keep the path, e.g. `/grid#523417`.

---

## Final check (run all of it before handing back)

1. `npm test`: 28/28 pass.
2. `npm run build` succeeds.
3. Run `npm run dev:multi` and `npm run dev:client`, then check:
   - **Landing at 1440×900:** the hero, terminal feed updating live, ticker moving, cards revealed on scroll.
   - **`/grid` at 1440×900:** sidebar stats live; Go and Random work; budget bars react to clicks; the feed updates when another window clicks.
   - **Both pages at 390×844:** no horizontal scroll; the board comes right after the title block and notice.
   - **Navigation:** refreshing on `/grid` works; back and forward between `/` and `/grid` works; going to the grid twice doesn't double the socket or input handlers (only one WebSocket in DevTools → Network → WS).
   - **No email** appears anywhere in the UI.
   - **Reduced motion** (emulate it): the ticker is static, the cursor stops blinking, there are no reveals.
4. Save screenshots to `docs/design/match-landing.png`, `match-grid.png` and `match-grid-phone.png`.
5. Add a "UI match (U1–U6)" section to `CHANGES.md`: each ID marked done, skipped or changed, with a reason.
