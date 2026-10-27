import { useEffect, useRef, useState } from 'react';
import { formatNum } from '../engine/boardEngine.js';
import { openSignIn, useBoard, useEngine } from '../useEngine.js';
import { Header } from '../components/Header.jsx';
import {
  ActivityIcon,
  ArrowRightIcon,
  DatabaseIcon,
  LockIcon,
  ShuffleIcon,
  TargetIcon,
  UsersIcon,
} from '../components/icons.jsx';
import { MapPanel } from '../components/MapPanel.jsx';
import { Announcer, HintCard, Toast } from '../components/Overlays.jsx';
import { Toolbar } from '../components/Toolbar.jsx';
import { formatFeedTime } from './Landing.jsx';

function JumpToolbar() {
  const engine = useEngine();
  const gotoOpen = useBoard((s) => s.gotoOpen);
  const inputRef = useRef(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState(false);

  useEffect(() => {
    if (gotoOpen) {
      inputRef.current?.focus();
      inputRef.current?.select();
      engine.store.set({ gotoOpen: false });
    }
  }, [gotoOpen, engine]);

  function onSubmit(e) {
    e.preventDefault();
    const raw = value.trim().replace(/^#/, '').replace(/,/g, '');
    const idx = Number(raw);
    if (raw === '' || !Number.isInteger(idx) || idx < 0 || idx >= 1_000_000) {
      setError(true);
      return;
    }
    setError(false);
    engine.jumpTo(idx);
  }

  function onRandom() {
    setError(false);
    const randomIdx = Math.floor(Math.random() * 1_000_000);
    setValue(String(randomIdx));
    engine.jumpTo(randomIdx);
  }

  return (
    <div className="grid-jump-wrap">
      <form className="grid-jump-form" onSubmit={onSubmit} noValidate>
        <input
          ref={inputRef}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          className="grid-jump-input"
          placeholder="jump to index… (0–999,999)"
          aria-label="Jump to box index"
          aria-invalid={error}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(false);
          }}
        />
        <button type="submit" className="btn-secondary-sm" title="Go to box (/)">
          <TargetIcon size={14} />
          <span>Go</span>
        </button>
        <button type="button" className="btn-secondary-sm" onClick={onRandom} title="Jump to a random box">
          <ShuffleIcon size={14} />
          <span>Random</span>
        </button>
      </form>
      {error && <p className="goto-error">Enter a number from 0 to 999,999.</p>}
    </div>
  );
}

function LiveSignalCard() {
  const checked = useBoard((s) => s.checked);
  const writes = useBoard((s) => s.writes);
  const online = useBoard((s) => s.online);
  const exploredPct = ((checked / 1_000_000) * 100).toFixed(4);

  return (
    <section className="sidebar-card" aria-label="Live signal statistics">
      <div className="sidebar-card-title">LIVE SIGNAL</div>
      <div className="stat-tiles-grid">
        <div className="stat-tile">
          <div className="stat-tile-head">
            <TargetIcon size={13} />
            <span>LIT</span>
          </div>
          <div className="stat-tile-value">{formatNum(checked)}</div>
          <div className="stat-tile-caption">{exploredPct}% explored</div>
        </div>

        <div className="stat-tile">
          <div className="stat-tile-head">
            <ActivityIcon size={13} />
            <span>WRITES</span>
          </div>
          <div className="stat-tile-value">{formatNum(writes)}</div>
          <div className="stat-tile-caption">accepted toggles</div>
        </div>

        <div className="stat-tile">
          <div className="stat-tile-head">
            <UsersIcon size={13} />
            <span>ONLINE</span>
          </div>
          <div className="stat-tile-value">{formatNum(online)}</div>
          <div className="stat-tile-caption">live sessions</div>
        </div>

        <div className="stat-tile">
          <div className="stat-tile-head">
            <DatabaseIcon size={13} />
            <span>STORAGE</span>
          </div>
          <div className="stat-tile-value">125 KB</div>
          <div className="stat-tile-caption">one Redis bitmap</div>
        </div>
      </div>
    </section>
  );
}

function WriteBudgetCard() {
  const engine = useEngine();
  const cooldownUntil = useBoard((s) => s.cooldownUntil);
  const shakeKey = useBoard((s) => s.shakeKey);

  const [state, setState] = useState(() => {
    const cap = Math.max(1, engine.budget.capacity || 10);
    const used = Math.max(0, cap - Math.floor(engine.budget.level()));
    return {
      cap,
      burstUsed: used,
      userUsed: engine.getRecentOwnWrites(),
      pausedLabel: '',
    };
  });

  useEffect(() => {
    let raf = 0;
    const step = () => {
      const now = Date.now();
      const cap = Math.max(1, engine.budget.capacity || 10);
      if (cooldownUntil > now) {
        const rem = Math.max(1, Math.ceil((cooldownUntil - now) / 1000));
        const pausedLabel = `Paused ${Math.floor(rem / 60)}:${String(rem % 60).padStart(2, '0')}`;
        setState({
          cap,
          burstUsed: cap,
          userUsed: 20,
          pausedLabel,
        });
      } else {
        const lvl = engine.budget.level(now);
        const burstUsed = Math.max(0, Math.min(cap, cap - Math.floor(lvl)));
        const userUsed = Math.min(20, engine.getRecentOwnWrites(now));
        setState({
          cap,
          burstUsed,
          userUsed,
          pausedLabel: '',
        });
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [engine, cooldownUntil]);

  const burstPct = Math.min(100, (state.burstUsed / state.cap) * 100);
  const userPct = Math.min(100, (state.userUsed / 20) * 100);
  const isPaused = Boolean(state.pausedLabel);

  return (
    <section
      key={shakeKey}
      className={`sidebar-card budget-card${isPaused ? ' paused' : ''}${shakeKey ? ' shaking' : ''}`}
      aria-label="Your write budget"
    >
      <div className="sidebar-card-title">YOUR WRITE BUDGET</div>

      <div className="budget-meter">
        <div className="budget-row-label">
          <span>BURST · PER CLICK</span>
          <span className="mono">
            {state.burstUsed}/{state.cap}
          </span>
        </div>
        <div className="budget-track" aria-hidden="true">
          <div className="budget-fill" style={{ width: `${burstPct}%` }} />
        </div>
      </div>

      <div className="budget-meter">
        <div className="budget-row-label">
          <span>PER USER · 1s</span>
          <span className="mono">{state.userUsed}/20</span>
        </div>
        <div className="budget-track" aria-hidden="true">
          <div className="budget-fill" style={{ width: `${userPct}%` }} />
        </div>
      </div>

      {isPaused ? (
        <div className="budget-note alert mono">{state.pausedLabel}</div>
      ) : (
        <div className="budget-note mono">
          {state.cap}-click burst ({engine.budget.refillPerSec || 5}/s refill) · max 20/s per user
        </div>
      )}
    </section>
  );
}

function ConnectionsCard() {
  const auth = useBoard((s) => s.auth);
  const online = useBoard((s) => s.online);
  const connection = useBoard((s) => s.connection);

  const label = auth.authenticated && auth.user?.name ? auth.user.name : 'guest';
  const others = Math.max(0, online - 1);

  return (
    <section className="sidebar-card" aria-label="Connected sessions">
      <div className="sidebar-card-title">CONNECTIONS</div>
      <div className="connections-list">
        <div className="connection-self">
          <span className={`status-dot ${connection}`} aria-hidden="true" />
          <span className="mono">
            you (<span className="connection-name">{label}</span>)
          </span>
        </div>
        <div className="connection-others mono">
          + {formatNum(others)} {others === 1 ? 'other' : 'others'}
        </div>
      </div>
    </section>
  );
}

function BroadcastFeedCard() {
  const engine = useEngine();
  const feed = useBoard((s) => s.feed);

  return (
    <section className="sidebar-card feed-card" aria-label="Broadcast feed">
      <div className="sidebar-card-title">BROADCAST FEED</div>
      {feed.length === 0 ? (
        <div className="feed-empty mono">Waiting for live toggles…</div>
      ) : (
        <div className="sidebar-feed-list">
          {feed.map((item, idx) => (
            <button
              key={`${item.index}-${item.at}-${idx}`}
              type="button"
              className="terminal-feed-row"
              onClick={() => engine.jumpTo(item.index)}
            >
              <span className={`feed-state${item.value ? ' on' : ''}`}>
                {item.value ? '[x]' : '[ ]'}
              </span>
              <span className="feed-box">
                box #{formatNum(item.index)}
                {item.mine && <span className="feed-you"> (you)</span>}
              </span>
              <span className="feed-time">{formatFeedTime(item.at)}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

export function GridPage() {
  const engine = useEngine();
  const checked = useBoard((s) => s.checked);
  const auth = useBoard((s) => s.auth);
  const rows = useBoard((s) => s.rows);
  const box = useBoard((s) => s.box);

  const panelRef = useRef(null);
  const canvasRef = useRef(null);
  const minimapRef = useRef(null);

  useEffect(() => {
    const cleanup = engine.attachBoard(canvasRef.current, minimapRef.current);

    let ro = null;
    if (typeof ResizeObserver !== 'undefined' && panelRef.current) {
      ro = new ResizeObserver(() => {
        engine.resizeBoard();
      });
      ro.observe(panelRef.current);
    }

    return () => {
      ro?.disconnect();
      cleanup();
    };
  }, [engine]);

  return (
    <div className="grid-page">
      <Header />

      <main className="container grid-main">
        <div className="grid-title-row">
          <div className="grid-title-copy">
            <div className="label-caps">LIVE GRID · 1000 × 1000</div>
            <h1 className="grid-h1">The Grid</h1>
            <p className="grid-subtitle">
              <span className="mono ink">{formatNum(checked)}</span> of 1,000,000 boxes lit — every
              write is broadcast to all connected windows in real time.
            </p>
          </div>
          <JumpToolbar />
        </div>

        {!auth.authenticated && (
          <div className="readonly-banner" role="region" aria-label="Read-only mode notice">
            <div className="readonly-banner-left">
              <div className="icon-tile">
                <LockIcon />
              </div>
              <div>
                <div className="readonly-title">You&apos;re watching in read-only mode</div>
                <div className="readonly-desc">
                  Every change streams in live. Sign in to check boxes.
                </div>
              </div>
            </div>
            <button
              type="button"
              className="btn-cta-primary"
              onClick={() => openSignIn(engine)}
            >
              <span>Sign in to write</span>
              <ArrowRightIcon />
            </button>
          </div>
        )}

        <div className="grid-dashboard">
          <div className="board-column">
            <div className="board-meta-bar">
              <div className="board-meta-left">
                <span className="live-pill">
                  <span className="live-dot" aria-hidden="true" />
                  LIVE
                </span>
                <span className="label-caps">
                  {auth.authenticated ? 'WRITE ENABLED' : 'READ-ONLY'}
                </span>
              </div>
              <div className="board-meta-right label-caps">
                <span>
                  ROWS {formatNum(rows[0])}–{formatNum(rows[1])} · BOX #{formatNum(box)}
                </span>
                <span className="desktop-only"> · SCROLL TO EXPLORE</span>
              </div>
            </div>

            <div className="board-panel" ref={panelRef}>
              <canvas
                ref={canvasRef}
                className="board-canvas"
                role="grid"
                tabIndex={0}
                aria-label="One Million Checkboxes grid, 1,000 rows by 1,000 columns. Use arrow keys to move focus and Space or Enter to toggle."
              />
              <Toolbar />
              <MapPanel canvasRef={minimapRef} />
              <HintCard />
              <Toast />
              <Announcer />
            </div>

            <div className="board-caption mono">
              canvas · only visible boxes are drawn · 1,000,000 states in one 125 KB Redis bitmap
            </div>
          </div>

          <aside className="grid-sidebar" aria-label="Live board telemetry">
            <LiveSignalCard />
            <WriteBudgetCard />
            <ConnectionsCard />
            <BroadcastFeedCard />
          </aside>
        </div>
      </main>
    </div>
  );
}

