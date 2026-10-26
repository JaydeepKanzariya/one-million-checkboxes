import { useEffect, useRef } from 'react';
import { openSignIn, useBoard, useEngine } from '../useEngine.js';
import { GotoForm } from './GotoForm.jsx';
import { CloseIcon } from './icons.jsx';

export function MobileSheet() {
  const engine = useEngine();
  const open = useBoard((s) => s.menuOpen);
  const findAvailable = useBoard((s) => s.findAvailable);
  const auth = useBoard((s) => s.auth);
  const sheetRef = useRef(null);
  const close = () => engine.store.set({ menuOpen: false });

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      // The menu button toggles the sheet itself; ignoring it here avoids close-then-reopen.
      if (!sheetRef.current?.contains(e.target) && !e.target.closest?.('[data-menu-toggle]')) close();
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  return (
    <div className="sheet" role="dialog" aria-label="Menu" ref={sheetRef}>
      <div className="sheet-header">
        <span className="sheet-title">One Million Checkboxes</span>
        <button type="button" className="btn btn-icon" aria-label="Close menu" onClick={close}>
          <CloseIcon />
        </button>
      </div>

      <GotoForm id="mobileGotoInput" onDone={close} />

      <div className="sheet-actions">
        <button
          type="button"
          className="btn btn-ghost btn-block"
          disabled={!findAvailable}
          onClick={() => {
            close();
            engine.findActivity();
          }}
        >
          Find activity
        </button>
        {auth.authenticated && auth.user ? (
          <button
            type="button"
            className="btn btn-ghost btn-block"
            onClick={() => {
              close();
              engine.logout();
            }}
          >
            Sign out ({auth.user.name})
          </button>
        ) : (
          <button type="button" className="btn btn-primary btn-block" onClick={() => openSignIn(engine)}>
            Sign in
          </button>
        )}
      </div>
    </div>
  );
}
