import { useEffect, useRef, useState } from 'react';
import { useBoard, useEngine } from '../useEngine.js';

// Local development sign-in: pick a display name. Shown only when the server has DEV_LOGIN on.
export function SignInDialog() {
  const engine = useEngine();
  const open = useBoard((s) => s.signInOpen);
  const oidcEnabled = useBoard((s) => s.auth.oidcEnabled);
  const dialogRef = useRef(null);
  const [name, setName] = useState('');

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const returnTo = `${window.location.pathname}${window.location.hash || ''}`;

  return (
    <dialog
      ref={dialogRef}
      className="dialog"
      aria-labelledby="signInTitle"
      onClose={() => engine.store.set({ signInOpen: false })}
    >
      <form
        className="dialog-form"
        onSubmit={(e) => {
          e.preventDefault();
          const display = name.trim() || 'Engineer';
          window.location.href = `/auth/dev-login?name=${encodeURIComponent(display)}&returnTo=${encodeURIComponent(returnTo)}`;
        }}
      >
        <h2 id="signInTitle">Sign in to check boxes</h2>
        <p className="dialog-desc">Pick a display name for this local session.</p>
        {oidcEnabled && (
          <>
            <a href={`/auth/login?returnTo=${encodeURIComponent(returnTo)}`} className="btn btn-primary btn-block">
              Continue with single sign-on
            </a>
            <div className="divider">
              <span>or a local session</span>
            </div>
          </>
        )}
        <label className="field">
          <span>Display name</span>
          <input
            type="text"
            maxLength={32}
            placeholder="e.g. Ada Lovelace"
            required
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={() => engine.store.set({ signInOpen: false })}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary">
            Sign in
          </button>
        </div>
      </form>
    </dialog>
  );
}
