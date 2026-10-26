import { useEffect, useState } from 'react';
import { openSignIn, useBoard, useEngine } from '../useEngine.js';

export function Toast() {
  const engine = useEngine();
  const toast = useBoard((s) => s.toast);
  if (!toast) return null;

  const action =
    toast.action === 'signin'
      ? { label: 'Sign in', run: () => openSignIn(engine) }
      : toast.action === 'retry'
        ? { label: 'Retry', run: () => engine.retry() }
        : null;

  return (
    <div className="toast-region">
      <div key={toast.key} className={`toast${toast.alert ? ' alert' : ''}`} role="status">
        <span>{toast.message}</span>
        {action && (
          <button
            type="button"
            className="btn btn-sm toast-action"
            onClick={() => {
              engine.dismissToast();
              action.run();
            }}
          >
            {action.label}
          </button>
        )}
      </div>
    </div>
  );
}

export function HintCard() {
  const engine = useEngine();
  const visible = useBoard((s) => s.hintVisible);
  if (!visible) return null;

  const touch = window.matchMedia('(pointer: coarse)').matches;
  return (
    <div className="hint" role="status">
      <div className="hint-body">
        <strong className="hint-title">One sheet, a million boxes, everyone at once.</strong>
        <span className="hint-text">
          {touch
            ? 'Drag to move. Pinch to zoom. Tap a box to check it.'
            : 'Drag to move. Ctrl + scroll or pinch to zoom. Click a box to check it.'}
        </span>
      </div>
      <button type="button" className="btn btn-primary btn-sm" onClick={engine.dismissHint}>
        Got it
      </button>
    </div>
  );
}

// Screen-reader announcements. Clearing first makes repeated messages announce again.
export function Announcer() {
  const announcement = useBoard((s) => s.announcement);
  const [text, setText] = useState('');

  useEffect(() => {
    if (!announcement) return undefined;
    setText('');
    const t = setTimeout(() => setText(announcement.text), 20);
    return () => clearTimeout(t);
  }, [announcement]);

  return (
    <div className="sr-only" aria-live="polite" aria-atomic="true">
      {text}
    </div>
  );
}
