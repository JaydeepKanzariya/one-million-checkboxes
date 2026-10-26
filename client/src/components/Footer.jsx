import { useEffect, useState } from 'react';
import { formatNum } from '../engine/boardEngine.js';
import { openSignIn, useBoard, useEngine } from '../useEngine.js';

// Ten tally marks in two groups of five: the client-side mirror of the server's token bucket.
function Tally() {
  const engine = useEngine();
  const cooldownUntil = useBoard((s) => s.cooldownUntil);
  const shakeKey = useBoard((s) => s.shakeKey);
  // Start from the real level: the shake re-mounts this component, and a full row would flash.
  const [filled, setFilled] = useState(() =>
    Math.round((Math.floor(engine.budget.level()) / Math.max(1, engine.budget.capacity || 10)) * 10),
  );
  const [pausedLabel, setPausedLabel] = useState('');

  useEffect(() => {
    let raf = 0;
    const step = () => {
      const now = Date.now();
      if (cooldownUntil > now) {
        const rem = Math.max(1, Math.ceil((cooldownUntil - now) / 1000));
        setPausedLabel(`Paused ${Math.floor(rem / 60)}:${String(rem % 60).padStart(2, '0')}`);
        setFilled(10);
      } else {
        setPausedLabel('');
        const cap = Math.max(1, engine.budget.capacity || 10);
        setFilled(Math.round((Math.floor(engine.budget.level(now)) / cap) * 10));
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [engine, cooldownUntil]);

  return (
    <div
      key={shakeKey}
      className={`tally${pausedLabel ? ' paused' : ''}${shakeKey ? ' shaking' : ''}`}
      title="Click budget (refills automatically)"
      aria-label="Click budget"
    >
      {[0, 1].map((g) => (
        <span className="tally-group" key={g}>
          {[0, 1, 2, 3, 4].map((m) => (
            <span key={m} className={`tally-mark${g * 5 + m >= filled ? ' empty' : ''}`} />
          ))}
        </span>
      ))}
      {pausedLabel && <span className="tally-label mono">{pausedLabel}</span>}
    </div>
  );
}

function ActivityLine() {
  const engine = useEngine();
  const activity = useBoard((s) => s.activity);
  if (!activity) return null;
  const label = formatNum(activity.index);
  return (
    <button
      key={activity.key}
      type="button"
      className="activity"
      aria-label={`Go to box ${label}`}
      onClick={() => engine.jumpTo(activity.index)}
    >
      <span className="activity-dot" aria-hidden="true" />
      <span className="activity-text">
        Box <span className="mono">{label}</span> just {activity.value ? 'checked' : 'unchecked'}
      </span>
    </button>
  );
}

export function Footer() {
  const engine = useEngine();
  const rows = useBoard((s) => s.rows);
  const box = useBoard((s) => s.box);
  const authenticated = useBoard((s) => s.auth.authenticated);

  return (
    <footer className="statusbar">
      <div className="status-left">
        <span>
          Rows <span className="mono">{formatNum(rows[0])}–{formatNum(rows[1])}</span>
        </span>
        <span className="status-box">
          Box <span className="mono">{formatNum(box)}</span>
        </span>
      </div>
      <ActivityLine />
      <div className="status-right">
        {authenticated ? (
          <Tally />
        ) : (
          <>
            <span className="status-note desktop-only">You're watching live. Sign in to check boxes.</span>
            <span className="status-note mobile-only">You're watching live.</span>
            <button type="button" className="btn btn-primary btn-sm mobile-only" onClick={() => openSignIn(engine)}>
              Sign in
            </button>
          </>
        )}
      </div>
    </footer>
  );
}
