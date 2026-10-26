import { useEffect, useRef, useState } from 'react';
import { DUR, prefersReducedMotion } from '../engine/motion.js';
import { formatNum } from '../engine/boardEngine.js';
import { openSignIn, useBoard, useEngine } from '../useEngine.js';
import { GotoForm } from './GotoForm.jsx';
import { BrandMark, MenuIcon, SearchIcon } from './icons.jsx';

function Counter() {
  const checked = useBoard((s) => s.checked);
  const prev = useRef(null);
  const tickTimer = useRef(null);
  const [ticking, setTicking] = useState(false);

  // When the total rises, the number briefly gains weight, then settles.
  // The timer lives in a ref so a burst of updates can't cancel the settle step.
  useEffect(() => {
    const rose = prev.current !== null && checked > prev.current;
    prev.current = checked;
    if (!rose || tickTimer.current || prefersReducedMotion()) return;
    setTicking(true);
    tickTimer.current = setTimeout(() => {
      tickTimer.current = null;
      setTicking(false);
    }, DUR.slow);
  }, [checked]);

  const pct = Math.min(100, (checked / 1_000_000) * 100);

  return (
    <div className="counter">
      <div className="counter-line">
        <span className={`counter-value${ticking ? ' ticking' : ''}`}>{formatNum(checked)}</span>
        <span className="counter-suffix">of 1,000,000 checked</span>
      </div>
      <div className="progress" aria-hidden="true">
        <div className="progress-fill" style={{ width: `${pct}%`, minWidth: checked > 0 ? 2 : 0 }} />
      </div>
    </div>
  );
}

function Presence() {
  const online = useBoard((s) => s.online);
  const connection = useBoard((s) => s.connection);
  const instanceId = useBoard((s) => s.instanceId);
  const debug = useBoard((s) => s.debug);

  return (
    <div className="presence" title="People on the board right now">
      <span className={`status-dot ${connection}`} aria-hidden="true" />
      <span className="mono">{formatNum(online)}</span>
      <span className="presence-label">here now</span>
      {debug && instanceId && <span className="instance-badge mono">{instanceId}</span>}
    </div>
  );
}

function GotoPopover() {
  const engine = useEngine();
  const open = useBoard((s) => s.gotoOpen);
  const anchorRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (!anchorRef.current?.contains(e.target)) engine.store.set({ gotoOpen: false });
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open, engine]);

  return (
    <div className="popover-anchor desktop-only" ref={anchorRef}>
      <button
        type="button"
        className="btn btn-icon"
        aria-label="Go to box"
        aria-expanded={open}
        title="Go to box (/)"
        onClick={() => engine.store.set({ gotoOpen: !open })}
      >
        <SearchIcon />
      </button>
      {open && (
        <div className="popover" role="dialog" aria-label="Go to box">
          <GotoForm id="gotoInput" autoFocus onDone={() => engine.store.set({ gotoOpen: false })} />
        </div>
      )}
    </div>
  );
}

function AuthArea() {
  const engine = useEngine();
  const auth = useBoard((s) => s.auth);

  if (!auth.authenticated || !auth.user) {
    return (
      <button type="button" className="btn btn-primary desktop-only" onClick={() => openSignIn(engine)}>
        Sign in
      </button>
    );
  }

  const { user } = auth;
  return (
    <div className="user-chip desktop-only">
      <span className="avatar" aria-hidden="true">
        {user.picture ? <img src={user.picture} alt="" referrerPolicy="no-referrer" /> : (user.name || 'U')[0]}
      </span>
      <span className="user-name">{user.name}</span>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => engine.logout()}>
        Sign out
      </button>
    </div>
  );
}

export function Header() {
  const engine = useEngine();
  const menuOpen = useBoard((s) => s.menuOpen);

  return (
    <header className="topbar">
      <a
        href="#"
        className="brand"
        title="Back to box 0"
        onClick={(e) => {
          e.preventDefault();
          engine.resetView();
        }}
      >
        <BrandMark />
        <span className="brand-title">One Million Checkboxes</span>
      </a>

      <div className="metrics">
        <Counter />
        <Presence />
      </div>

      <div className="controls">
        <GotoPopover />
        <AuthArea />
        <button
          type="button"
          className="btn btn-icon mobile-only"
          data-menu-toggle
          aria-label="Open menu"
          aria-expanded={menuOpen}
          onClick={(e) => {
            e.stopPropagation();
            engine.store.set({ menuOpen: !menuOpen });
          }}
        >
          <MenuIcon />
        </button>
      </div>
    </header>
  );
}
