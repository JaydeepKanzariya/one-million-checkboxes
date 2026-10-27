import { useEffect, useRef } from 'react';
import { formatNum } from '../engine/boardEngine.js';
import { prefersReducedMotion } from '../engine/motion.js';
import { navigate } from '../router.js';
import { openSignIn, useBoard, useEngine } from '../useEngine.js';
import { Header } from '../components/Header.jsx';
import {
  ActivityIcon,
  ArrowRightIcon,
  DatabaseIcon,
  FitIcon,
  KeyIcon,
  MonitorIcon,
  ServerIcon,
  ShareIcon,
  ShieldIcon,
  UsersIcon,
  ZapIcon,
} from '../components/icons.jsx';

export function formatFeedTime(ts) {
  const d = new Date(ts);
  const hh = d.getHours();
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function useScrollReveal() {
  const containerRef = useRef(null);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return undefined;
    const targets = root.querySelectorAll('.reveal-section');
    if (prefersReducedMotion() || typeof IntersectionObserver === 'undefined') {
      targets.forEach((el) => el.classList.add('is-visible'));
      return undefined;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            observer.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -32px 0px' },
    );

    targets.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  return containerRef;
}

const FEATURES = [
  {
    Icon: ZapIcon,
    title: 'Real-time by default',
    text: 'Every toggle is packed into a 5-byte binary frame, batched every 25 ms, and broadcast across all open browser tabs with monotonic sequence tracking.',
  },
  {
    Icon: FitIcon,
    title: 'Canvas rendering, zoom to the whole sheet',
    text: 'Only visible boxes are drawn each frame. Smoothly zoom from crisp inset checkboxes with animated check marks out to the full 1,000 × 1,000 sheet.',
  },
  {
    Icon: DatabaseIcon,
    title: 'One Redis bitmap, 125 KB',
    text: 'All one million checkbox states live inside a single 125,000-byte Redis key, served gzip-compressed with ETag conditional requests on load.',
  },
  {
    Icon: ShieldIcon,
    title: 'Custom rate limiting (token bucket + sliding window)',
    text: 'Three protective layers guard the board: per-IP connection caps, a per-socket token bucket for bursts, and a Redis Lua per-user window with strike cooldowns.',
  },
  {
    Icon: UsersIcon,
    title: 'OIDC sign-in, guests watch live',
    text: 'Anyone can watch the live grid and inspect activity immediately. Signing in via OIDC or a local session unlocks writing without dropping your view.',
  },
  {
    Icon: ShareIcon,
    title: 'Multi-instance via Redis Pub/Sub',
    text: 'Stateless Node.js servers coordinate through Redis Pub/Sub and capped Streams, fanning out updates and presence counts across every instance.',
  },
];

const ARCH_STEPS = [
  {
    num: '01',
    label: 'BROWSER',
    title: 'Canvas, sequencer & optimistic overlay',
    Icon: MonitorIcon,
    bullets: [
      'Optimistic bitset flips immediately while tracking in-flight acks',
      'Gap-detecting sequencer buffers out-of-order frames and requests stream replay',
      'Offscreen ImageData overview and dirty-cell redraws keep panning at 60 fps',
    ],
  },
  {
    num: '02',
    label: 'SERVER',
    title: 'Express + ws, auth & rate limits',
    Icon: ServerIcon,
    bullets: [
      'Compact 5-byte binary set/ack frames and 25 ms batched broadcast ticks',
      'Per-socket token bucket and Redis strike counter pause abusive bursts',
      'Gzip-cached snapshot endpoint with If-None-Match 304 fast path',
    ],
  },
  {
    num: '03',
    label: 'REDIS',
    title: 'Lua toggle, Pub/Sub & Streams',
    Icon: DatabaseIcon,
    bullets: [
      'Atomic toggle.lua runs SETBIT, updates checked total, and increments seq',
      'Appends every accepted write to a capped Redis Stream for reconnect replay',
      'Publishes seq:index:val to omc:ch:updates across all gateway instances',
    ],
  },
];

function TerminalCard() {
  const checked = useBoard((s) => s.checked);
  const writes = useBoard((s) => s.writes);
  const feed = useBoard((s) => s.feed);
  const exploredPct = ((checked / 1_000_000) * 100).toFixed(4);
  const rows = feed.slice(0, 7);

  return (
    <div className="terminal-card" aria-label="Live broadcast terminal">
      <div className="terminal-header">
        <div className="terminal-dots" aria-hidden="true">
          <span className="terminal-dot red" />
          <span className="terminal-dot amber" />
          <span className="terminal-dot green" />
        </div>
        <span className="terminal-title">GRID-BROADCAST --FOLLOW</span>
        <span className="live-pill">
          <span className="live-dot" aria-hidden="true" />
          LIVE
        </span>
      </div>

      <div className="terminal-body">
        <div className="terminal-line muted">$ subscribing to realtime channel…</div>
        <div className="terminal-line stats">
          $ <span className="ink">{formatNum(checked)}</span> lit ·{' '}
          <span className="ink">{formatNum(writes)}</span> writes ·{' '}
          <span className="primary">{exploredPct}%</span> explored
        </div>

        <div className="terminal-feed">
          {rows.length === 0 ? (
            <div className="terminal-line muted">$ listening for live toggles on the grid…</div>
          ) : (
            rows.map((item, idx) => (
              <button
                key={`${item.index}-${item.at}-${idx}`}
                type="button"
                className="terminal-feed-row"
                onClick={() => navigate(`/grid#${item.index}`)}
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
            ))
          )}
        </div>

        <div className="terminal-line prompt">
          <span>$ </span>
          <span className="terminal-cursor" aria-hidden="true">
            █
          </span>
        </div>
      </div>
    </div>
  );
}

function Ticker() {
  const checked = useBoard((s) => s.checked);
  const writes = useBoard((s) => s.writes);
  const online = useBoard((s) => s.online);
  const instances = useBoard((s) => s.instances);
  const exploredPct = ((checked / 1_000_000) * 100).toFixed(4);

  const items = [
    { label: 'LIT', value: formatNum(checked) },
    { label: 'WRITES', value: formatNum(writes) },
    { label: 'EXPLORED', value: `${exploredPct}%` },
    { label: 'ONLINE', value: formatNum(online) },
    { label: 'STORAGE', value: '125,000 B' },
    { label: 'TRANSPORT', value: 'WEBSOCKET' },
    { label: 'INSTANCES', value: String(instances) },
  ];

  return (
    <div className="ticker-wrap" aria-label="Live system metrics">
      <div className="ticker-track">
        {[0, 1].map((dup) => (
          <div className="ticker-group" key={dup} aria-hidden={dup === 1}>
            {items.map((item) => (
              <span className="ticker-item" key={`${dup}-${item.label}`}>
                <span className="ticker-dot" aria-hidden="true" />
                <span className="ticker-label">{item.label}</span>
                <strong className="ticker-val">{item.value}</strong>
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function Landing() {
  const engine = useEngine();
  const checked = useBoard((s) => s.checked);
  const writes = useBoard((s) => s.writes);
  const auth = useBoard((s) => s.auth);
  const online = useBoard((s) => s.online);
  const pageRef = useScrollReveal();

  const stillDark = Math.max(0, 1_000_000 - checked);

  return (
    <div className="landing-page" id="top" ref={pageRef}>
      <Header />

      <section className="hero-section grid-paper-bg">
        <div className="hero-glow" aria-hidden="true" />
        <div className="container hero-grid">
          <div className="hero-copy">
            <div className="live-badge">
              <span className="live-dot" aria-hidden="true" />
              <span>
                Live now · {formatNum(online)} {online === 1 ? 'person' : 'people'} on the grid
              </span>
            </div>

            <h1 className="hero-h1">
              <span className="hero-h1-top">one million</span>
              <span className="hero-h1-bottom">
                checkboxes<span className="hero-cursor" aria-hidden="true">_</span>
              </span>
            </h1>

            <p className="hero-p">
              A real-time grid of 1,000,000 toggles shared across every open window. Backed by a
              single 125 KB Redis bitmap and binary WebSocket frames.
            </p>

            <div className="hero-actions">
              <button
                type="button"
                className="btn-cta-primary"
                onClick={() => navigate('/grid')}
              >
                <span>ENTER THE GRID</span>
                <ArrowRightIcon />
              </button>

              {auth.authenticated ? (
                <button
                  type="button"
                  className="btn-cta-secondary"
                  onClick={() => navigate('/grid')}
                >
                  <KeyIcon />
                  <span>SIGNED IN · WRITE NOW</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="btn-cta-secondary"
                  onClick={() => openSignIn(engine)}
                >
                  <KeyIcon />
                  <span>SIGN IN TO WRITE</span>
                </button>
              )}
            </div>

            <p className="hero-footnote">GUESTS WATCH LIVE · SIGN IN TO WRITE</p>
          </div>

          <div className="hero-terminal-col">
            <TerminalCard />
          </div>
        </div>
      </section>

      <Ticker />

      <section className="landing-section reveal-section" id="features">
        <div className="container">
          <div className="section-eyebrow">// WHAT IT ACTUALLY DOES</div>
          <h2 className="section-h2">One grid, six engineering problems</h2>
          <p className="section-intro">
            Every toggle on the sheet looks simple from the outside, but keeping a million states
            synchronized across browsers at 60 fps takes careful plumbing.
          </p>

          <div className="features-grid">
            {FEATURES.map(({ Icon, title, text }) => (
              <article className="feature-card" key={title}>
                <div className="icon-tile">
                  <Icon />
                </div>
                <h3 className="feature-title">{title}</h3>
                <p className="feature-text">{text}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="landing-section grid-paper-bg arch-section reveal-section" id="architecture">
        <div className="container">
          <div className="section-eyebrow">// ARCHITECTURE</div>
          <h2 className="section-h2">From click to every other window</h2>
          <p className="section-intro">
            How a single checkbox toggle travels from your pointer to Redis and back out to every
            connected browser.
          </p>

          <div className="arch-grid">
            {ARCH_STEPS.map(({ num, label, title, Icon, bullets }) => (
              <article className="arch-card" key={num}>
                <div className="arch-card-head">
                  <div className="arch-head-left">
                    <div className="icon-tile">
                      <Icon />
                    </div>
                    <span className="arch-label">{label}</span>
                  </div>
                  <span className="arch-num">{num}</span>
                </div>
                <h3 className="feature-title">{title}</h3>
                <ul className="arch-bullets">
                  {bullets.map((line) => (
                    <li key={line}>
                      <span className="arch-chevron" aria-hidden="true">
                        ›
                      </span>
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="landing-section reveal-section">
        <div className="container">
          <div className="closing-cta-card">
            <h2 className="closing-cta-h2">{formatNum(stillDark)} boxes still dark</h2>
            <div className="closing-cta-row">
              <p className="closing-cta-text">
                Pan across the live 1,000 × 1,000 sheet, jump to any box index, or sign in to flip
                switches in real time.
              </p>
              <button
                type="button"
                className="btn-cta-primary"
                onClick={() => navigate('/grid')}
              >
                <span>ENTER THE GRID</span>
                <ArrowRightIcon />
              </button>
            </div>
          </div>
        </div>
      </section>

      <footer className="landing-footer" role="contentinfo">
        <div className="container landing-footer-inner">
          <span className="footer-brand-label">MILLION/BOXES · REALTIME CHECKBOX GRID</span>
          <div className="footer-right-links">
            <span className="footer-writes">
              <ActivityIcon size={13} />
              <span>{formatNum(writes)} WRITES</span>
            </span>
            <a
              href="/grid"
              className="footer-link"
              onClick={(e) => {
                e.preventDefault();
                navigate('/grid');
              }}
            >
              grid
            </a>
            <a
              href="#top"
              className="footer-link"
              onClick={(e) => {
                e.preventDefault();
                window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
              }}
            >
              console
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

