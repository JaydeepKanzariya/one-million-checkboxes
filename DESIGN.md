# Design spec: One Million Checkboxes UI

This is a UI/UX redesign of the frontend in `public/`. The backend gets **one** small change (D8): the server tells the client its rate limits.

Each change has an ID (D1, D2, …), the files involved, the exact change, and how to check it is done. Build them in order, one commit per ID (`D3: inset boxes and ledger rules`).

## Rules for whoever implements this

- **Vanilla HTML/CSS/JS with ES modules only.** No frameworks, no bundler, no new npm packages, and no animation libraries (no GSAP, no Three.js). The assignment brief requires this.
- **No glass blur.** Don't use `backdrop-filter` anywhere. Panels sit over a canvas that redraws 60 times a second, so a blur would be recomputed every frame. Use solid panels with a shadow.
- **Keep the renderer fast.** Only visible cells are drawn, at most one draw per animation frame, and only dirty cells are redrawn when the view hasn't moved. Don't add per-cell allocations inside draw loops.
- **Respect reduced motion.** Every animation listed here becomes instant under `prefers-reduced-motion: reduce`.
- **Don't break anything that exists:** keyboard navigation, `aria-live` announcements, URL `#index` links, the live pulse, the optimistic toggle overlay (`pendingToggles`), or the sequencer.
- `npm test` must stay green after every commit.
- Box numbers stay **0-based** everywhere (they match the `#523417` URL hash and the API). Don't switch to 1-based.

---

## Design direction

The board is a **sheet of accounting ledger paper**: pale green paper, ruled lines, a red double margin line on the left, ink for checked boxes, a yellow pencil for your own marks and blue ink for other people's.

Spend the boldness in two places:
1. **The sheet itself:** it reads as a real physical page.
2. **The live counter:** it's the one expressive type moment.

Everything else stays quiet.

---

## D1. Design tokens: palette, type, motion

**Files:** [public/styles/tokens.css](public/styles/tokens.css), [public/index.html](public/index.html) (font link), new `public/js/motion.js`

### Palette

Keep the existing variable names, because [renderer.js](public/js/renderer.js) `readThemePalette()` reads them. Change the values, and add the three new tokens (`--desk`, `--margin`, `--box`).

| Token | Light | Dark | Use |
|---|---|---|---|
| `--desk` (new) | `#DCE5D7` | `#0A110E` | Background around the sheet |
| `--paper` | `#EDF2EA` | `#101915` | The sheet |
| `--paper-elevated` | `#F6F9F4` | `#17221D` | Panels, header, footer, inside of empty boxes |
| `--paper-subtle` | `#E2EADE` | `#1C2923` | Hover fills, subtle inputs |
| `--rule` | `#C9D8C4` | `#1F2E27` | Ledger ruled lines |
| `--rule-strong` | `#A9BFA3` | `#2E4339` | Every 10th rule, panel borders |
| `--box` (new) | `#6F8C78` | `#56735F` | Empty box outline. Must be ≥ 3:1 against `--paper`. |
| `--ink` | `#1C2740` | `#E4ECE2` | Checked boxes, main text |
| `--ink-muted` | `#4F5F55` | `#9DB0A3` | Secondary text. Must be ≥ 4.5:1 against `--paper-elevated`. |
| `--ink-on-fill` | `#F6F9F4` | `#101915` | Check mark inside a filled box |
| `--margin` (new) | `#C0392B` | `#E5604F` | Red margin line |
| `--alert` | `#B03224` | `#EF6A58` | Errors, paused state. Text must be ≥ 4.5:1. |
| `--signal` | `#E0A100` | `#F2B630` | Your own clicks (yellow pencil), focus ring |
| `--live` | `#2F6FD0` | `#6FA8FF` | Other people's clicks (pulse, then fade to ink) |
| `--online` | `#2E8A50` | `#4CC77E` | Connected dot |

Define the dark values under both `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {…} }` and `:root[data-theme="dark"] {…}`, the way the existing file does.

### Type

Use **one family: Bricolage Grotesque.** Remove Inter Tight completely.

- **Font link:** load the full weight range and the optical-size axis:
  `https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,300..800&display=swap`
- **Tokens:** both `--font-display` and `--font-sans` become `'Bricolage Grotesque', system-ui, sans-serif`.
- **Optical size:** UI text uses `font-optical-sizing: auto` (the browser picks the small optical size at 13–15 px). The counter uses a large optical size.
- **Type scale (px):** 12, 13, 15, 19, 24, 30.
  - Body and UI: 13–15 px, weight 450.
  - Buttons: weight 550.
  - Counter: 30 px, weight 700.
- **Numbers:** keep `font-variant-numeric: tabular-nums` on every number.
- **No all-caps labels.** Use sentence case everywhere.

### Motion

Add these to `tokens.css`, and mirror them in `public/js/motion.js` so the canvas uses the same timings:

```css
--dur-instant: 80ms;   /* press feedback */
--dur-fast: 120ms;     /* hover, zoom steps */
--dur-base: 220ms;     /* panels, popovers, toasts */
--dur-slow: 420ms;     /* counter tick */
--ease-out: cubic-bezier(0.2, 0.7, 0.2, 1);
--ease-in-out: cubic-bezier(0.6, 0, 0.3, 1);
```

`motion.js` exports:
- `DUR` (the same values, in ms)
- `easeOut(t)` and `easeInOut(t)`
- `prefersReducedMotion()`, which reads `matchMedia` live, not once at startup.

**Done when:**
- No `Inter Tight` remains anywhere in `public/`.
- Both themes render with the new palette.
- The contrast pairs marked in the table meet their stated ratios. Check them in DevTools and list the measured ratios in the commit message.

---

## D2. Phone layout: fix overflow, one Sign in, simpler header

**Files:** [public/index.html](public/index.html), [public/styles/app.css](public/styles/app.css), [public/js/ui.js](public/js/ui.js)

**Problem:** at a 390 px width, `header.topbar`, `main#stage` and `canvas#boardCanvas` measure 456 px wide. The header Sign in button, the minimap and the footer Sign in are cut off. On top of that, there are two Sign in buttons on every screen.

**Changes:**

1. **Header layout** (all widths): `display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);`. Every grid child gets `min-width: 0`. Nothing in the header may have a fixed width larger than its content.
2. **Go to field** → a **Go to box** icon button (magnifier, drawn as inline SVG) that opens a small popover. The popover holds the number input and a **Go** button. The `/` key also opens it, and `Escape` closes it. Delete the always-visible input.
3. **Sign in appears once per breakpoint:**
   - **Desktop (> 640 px):** in the header only. Delete `#footerSignInBtn`.
   - **Phone (≤ 640 px):** in the bottom bar only. Hide the header one.
4. **Phone header:** the counter (compact), the presence pill, and a menu button (≡). The menu opens a sheet with: Go to box, theme toggle, Sign in or Sign out.
5. **Minimap on phones:** collapsed by default. Show a small "Map" button bottom-right that expands it.
6. Use `env(safe-area-inset-bottom)` padding on the bottom bar.

**Done when:** at **360, 390 and 430 px** widths, this returns `[]` in the console:

```js
[...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1)
```

Also, exactly one Sign in button is visible at each width.

---

## D3. The board: inset boxes, ledger rules, a visible sheet

**File:** [public/js/renderer.js](public/js/renderer.js) (`renderFullViewport`, `drawSingleCell`, `drawCellInterior`, `renderOverviewMode`, `readThemePalette`)

**Problem:** `renderFullViewport` strokes a full grid (every row **and** every column line), and `drawCellInterior` *also* outlines every empty box. That's two layers of lines on 30,000 cells, and it drowns out the marks that matter.

**Changes:**

1. **Remove the full vertical and horizontal grid.**
2. **Ledger rules:** draw **horizontal rules only**, one per row in `--rule`, and every 10th row in `--rule-strong`. For columns, draw a faint vertical rule only every 10 columns, in `--rule`. The grouping by tens tells you something; it isn't decoration. Hide all rules when `cellSize < 8`.
3. **Inset boxes** (when `cellSize >= 16`):
   - The box is 62% of the cell: `pad = Math.round(cs * 0.19)`.
   - Corner radius `Math.min(3, cs * 0.12)`. Use `ctx.roundRect` when it exists, and fall back to `rect`.
   - **Empty box:** fill `--paper-elevated`, 1 px outline in `--box`.
   - **Checked box:** fill `--ink`, with the existing check-mark path in `--ink-on-fill`.
4. **Hover:** add a `hoveredIndex` redraw. The hovered cell gets a `--paper-subtle` cell background behind the box. The focus ring stays as it is.
5. **The sheet:**
   - Everything outside the 1000 × 1000 world is filled with `--desk`.
   - The world rectangle gets `--paper`, and a soft shadow drawn once per full redraw: `shadowBlur 24`, `rgba(0,0,0,.12)` in light mode and `.5` in dark mode.
6. **Red double margin line:** two 1 px `--margin` lines, 3 px apart, 6 px left of the sheet's left edge.
7. **Row numbers** in the margin gutter, right-aligned against the margin line, in `--ink-muted`, 11 px, tabular numbers:
   - every row when `cellSize >= 16`
   - every 10th row when `4 <= cellSize < 16`
   - none below 4.

   They are 0-based row numbers. The gutter is 44 px of desk space reserved left of the sheet, so `clampCamera` must allow the camera to show it.
8. **Overview mode** (`cellSize < 4`) draws the same desk, sheet and shadow around the bitmap.

**Done when:** at 20 px zoom, a screenshot shows mostly calm paper with clearly separated checked marks, and the sheet edge, margin line and row numbers are visible at the top-left.

---

## D4. Fit, smooth zoom, momentum panning, click-to-zoom in the overview

**Files:** [public/js/renderer.js](public/js/renderer.js), [public/js/input.js](public/js/input.js), [public/js/main.js](public/js/main.js), [public/index.html](public/index.html)

1. **Fit:**
   - `fitCellSize = Math.min(width - 88, height - 48) / 1000`, which is allowed to go below 1.
   - Set `minCellSize = fitCellSize`, and recompute it in `resize()`.
   - Add `renderer.fitToScreen({ animate })`.
2. **Zoom toolbar:** replace the "20px" readout with **[−] [Fit] [+]**. The `0` key also fits. Delete `zoomReadoutEl` updates in `ui.js`.
3. **Animated camera:** add `renderer.animateTo({ cellSize, centerX, centerY }, durationMs)`.
   - Interpolate `log(cellSize)` (so zoom speed feels even) and the centre point, with `easeInOut`, inside the existing `requestAnimationFrame` loop.
   - Each frame is a full redraw.
   - Any user input cancels the animation.
4. **Smooth wheel zoom:** Ctrl/Cmd + wheel and pinch set a target zoom. The camera eases to it over `DUR.fast` (120 ms), around the cursor position.
5. **Momentum panning:**
   - In `input.js`, keep the last ~80 ms of pointer moves to estimate velocity.
   - On `pointerup` after a drag, keep panning with that velocity, multiplying by 0.92 every 16 ms, until it drops below 0.2 px per frame.
   - A new `pointerdown` stops it.
   - Under reduced motion: no momentum.
6. **Clicks in the overview zoom in:** when `cellSize < 4`, a click doesn't toggle (you can't aim at a 1 px box). It calls `animateTo({ cellSize: 20, center: clicked cell })`.
7. **Opening move:**
   - On first load, render the whole sheet (Fit).
   - Once the snapshot arrives, `animateTo` the starting spot over 900 ms (`easeInOut`). The starting spot is the `#index` from the URL if there is one, otherwise box 0 at the default zoom.
   - This is the page's **only** automatic animation.
   - Under reduced motion, jump straight to the target.

**Done when:**
- Fit shows the entire sheet, with margin and row gutter, at 1440 × 900 and at 390 × 844.
- No animation drops below 50 fps in a DevTools Performance recording on desktop (record one and note the result in the commit).

---

## D5. Counter and presence in the header

**Files:** [public/index.html](public/index.html), [public/styles/app.css](public/styles/app.css), [public/js/ui.js](public/js/ui.js)

1. **Counter text:** `412,903 of 1,000,000 checked`.
   - The first number is 30 px, weight 700.
   - The rest is 13 px, `--ink-muted`.
   - On phones, show only the first number.
2. **Progress rule** under the counter: 2 px tall, `--rule` track, `--ink` fill, width = checked / 1,000,000.
   - Under 1% the fill looks empty, so give it a minimum visible width of 2 px whenever `checked > 0`.
3. **Counter tick:** when the number goes **up**, animate `font-weight` 700 → 800 → 700 over `DUR.slow`.
   - Bricolage Grotesque is a variable font, so the weight change is smooth.
   - Only restart the animation if the last one has finished, so a burst of updates doesn't flicker.
   - Under reduced motion: no animation.
4. **Presence:** `● 87 here now`. The dot uses `--online`, and turns `--signal` while reconnecting and `--alert` when offline (the existing states).
5. **Instance badge** (`app1`): show it **only** when the URL contains `?debug=1`. The demo video uses `?debug=1` to show two servers, and normal users never see it.
6. **Wordmark:** keep `One Million Checkboxes` in Bricolage at weight 700 and 19 px. Replace the `▣` glyph with a small inline SVG of a checked box drawn in `--ink`.

**Done when:** the counter doesn't shift the layout as it changes, and `app1` is only visible with `?debug=1`.

---

## D6. Footer: plain readouts

**Files:** [public/index.html](public/index.html), [public/js/ui.js](public/js/ui.js) (`updateViewportStatus`, `updateCellReadout`, `renderStatusRight`)

1. **Left side:**
   - `Rows 503–541` (0-based, the first and last visible rows), followed by the hovered or focused box: `Box 16,053`.
   - Separate the two with spacing, **not** a `·` character.
   - Remove the `(r16, c53)` form.
2. **Right side:**
   - **Signed out:** `You're watching live. Sign in to check boxes.` (the Sign in button lives in the header on desktop).
   - **Signed in:** the click budget from D7.

---

## D7. Click budget: show the rate limit before users hit it

**Files:** new `public/js/clickBudget.js`, new `tests/clickBudget.test.js`, [public/js/main.js](public/js/main.js), [public/js/ui.js](public/js/ui.js), [public/styles/app.css](public/styles/app.css)

**Idea:** show the per-socket token bucket (capacity 10, refilling at 5/s) as **10 tally marks in two groups of five**, like counting marks in a ledger. Each click uses one mark, and they refill visibly. Users see the limit coming instead of being surprised by it.

1. **`clickBudget.js`:** a pure class with no DOM access, mirroring [server/ratelimit/tokenBucket.js](server/ratelimit/tokenBucket.js):

   ```js
   new ClickBudget({ capacity, refillPerSec })
   ```

   - `.consume(now)` returns a boolean.
   - `.level(now)` returns the current fractional tokens.
   - `.drain()` sets the level to 0. Call it when the server sends `REJECT code=RATE`, so the client follows the server's state.
2. **Using it in `main.js`:**
   - `handleToggleCell` calls `budget.consume()`. If it returns false, don't send the frame. Instead give feedback: shake the tally marks once (`translateX` ±3 px, 3 cycles, `DUR.base`; no shake under reduced motion).
   - Announce "Slow down. Clicks refill in a moment." through `aria-live` only.
3. **Drawing the tally marks** (`ui.js`):
   - 10 spans, each a 2 × 14 px rounded bar in `--ink`. Empty marks use `--rule-strong`.
   - Group them 5 + 5 with a 6 px gap.
   - Update them in a `requestAnimationFrame` loop that runs only while the budget is below capacity.
4. **Paused (blocked) state:** the marks turn `--alert`, and the footer reads `Paused 1:52`, counting down from the server's `retryAfterMs`.
5. **Remove the rate-limit toasts:**
   - `main.js` currently toasts "Slow down…" from `onJson` for `t: 'limit'`. Remove those toasts.
   - The tally marks and the `aria-live` announcement replace them.
   - Keep `ui.startCooldown` as the logic behind the paused state.

**Tests** (`tests/clickBudget.test.js`, with fake timestamps):
- 10 consumes succeed and the 11th fails.
- After 200 ms, exactly 1 more consume succeeds.
- The level never goes above capacity.
- `drain()` sets the level to 0.

---

## D8. Server sends its limits (the only backend change)

**File:** [server/realtime/wsServer.js](server/realtime/wsServer.js), the `welcome` payload

Add this to the `welcome` JSON:

```js
limits: {
  bucketCapacity: config.rl.wsBucketCapacity,
  bucketRefillPerS: config.rl.wsBucketRefillPerS,
}
```

`main.js` builds the `ClickBudget` from these values, falling back to 10 and 5 if they're missing.

**Done when:** an extra assertion in [tests/api.test.js](tests/api.test.js) checks that `welcome.limits.bucketCapacity` exists.

---

## D9. Finding other people: live minimap and Find activity

**Files:** [public/js/minimap.js](public/js/minimap.js), [public/js/main.js](public/js/main.js), [public/index.html](public/index.html)

1. **Live blips:** every **remote** update applied by the sequencer adds a blip at that cell on the minimap.
   - A blip is a 3 px dot in `--live` that fades over 1.5 s.
   - Keep a ring buffer of at most 300 blips. Draw them on the overlay pass; don't rebuild the bitmap for them.
2. **Find activity:**
   - Keep the last 500 remote update indices with their timestamps.
   - The button (in the zoom toolbar and the phone menu) finds the 50 × 50 block with the most updates in the last 60 s, and calls `animateTo` its centre at 20 px zoom.
   - If there was no activity in the last 60 s, disable the button with the tooltip `No one has checked a box in the last minute`.
3. **Minimap title:** rename `Ledger overview` to `Map`.

**Done when:** in two browser windows, clicking in window A shows blips in window B's minimap, and **Find activity** in B jumps to where A is clicking.

---

## D10. First-visit hint

**Files:** [public/js/ui.js](public/js/ui.js), [public/styles/app.css](public/styles/app.css)

- A small card bottom-centre, shown once: `Drag to move. Ctrl + scroll or pinch to zoom. Click a box to check it.`
- On touch devices, the text is `Drag to move. Pinch to zoom. Tap a box to check it.`
- It dismisses on the first pan, zoom or click, or with its close button.
- Remember the dismissal in `localStorage` under `omc:hintSeen`. Wrap the access in `try/catch` and show the hint if storage fails.

---

## D11. Wording

Use these exact strings. Sentence case, active voice, no `·` or `—` used as separators.

| Where | Old | New |
|---|---|---|
| Footer, rows | `Viewing #0–#30,072` | `Rows 0–30` |
| Footer, box | `#16,053 (r16, c53)` | `Box 16,053` |
| Presence | `3 online` | `3 here now` |
| Rate limited | `Slow down — you can check more boxes in 3s.` (toast) | Tally marks plus the aria announcement `Slow down. Clicks refill in a moment.` |
| Blocked | `Paused for 2 minutes after too many rapid clicks.` | `Paused 1:52` (footer, counting down) |
| Signed out | `You're viewing live. Sign in to check boxes.` | `You're watching live. Sign in to check boxes.` |
| Minimap | `Ledger overview` | `Map` |
| Zoom | `20px` | `Fit` button |
| Go to placeholder | `Go to #…` | `Box number, 0 to 999,999` |
| Go to out of range | none | `Enter a number from 0 to 999,999.` (inline, under the field) |
| Connection lost | `Connection lost. Reconnecting…` | Keep it |

---

## Final check (before handing back for review)

1. `npm test` is green, including the new `clickBudget.test.js` and the `welcome.limits` assertion.
2. Screenshots, saved to `docs/design/`, in **both themes**:
   - 1440 × 900 at default zoom
   - 1440 × 900 at Fit
   - 390 × 844 at default zoom
   - 390 × 844 with the menu open
3. The D2 overflow check returns `[]` at 360, 390 and 430 px.
4. With `prefers-reduced-motion: reduce` emulated, the opening move, the counter tick, momentum and the shake are all instant or off.
5. Keyboard only: Tab reaches every control, the arrow keys move the focus ring, Space toggles, `/` opens Go to box, `0` fits.
6. Two windows (3001 and 3002): toggles sync, blips appear, and Find activity works.
7. Add a "Design" section to `CHANGES.md` listing D1–D11 as done, skipped (with a reason), or changed (with a reason).
