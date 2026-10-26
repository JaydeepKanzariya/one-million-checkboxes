import { useState } from 'react';
import { useEngine } from '../useEngine.js';

// Shared by the desktop popover and the phone menu.
export function GotoForm({ id, autoFocus = false, onDone }) {
  const engine = useEngine();
  const [value, setValue] = useState('');
  const [error, setError] = useState(false);

  function submit(e) {
    e.preventDefault();
    const raw = value.trim().replace(/^#/, '').replace(/,/g, '');
    const idx = Number(raw);
    if (raw === '' || !Number.isInteger(idx) || idx < 0 || idx >= 1_000_000) {
      setError(true);
      return;
    }
    onDone?.();
    engine.jumpTo(idx);
  }

  return (
    <form className="goto-form" onSubmit={submit} noValidate>
      <label htmlFor={id} className="goto-label">
        Go to box
      </label>
      <div className="goto-row">
        <input
          id={id}
          className="goto-input"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          placeholder="Box number, 0 to 999,999"
          value={value}
          autoFocus={autoFocus}
          aria-invalid={error}
          onChange={(e) => {
            setValue(e.target.value);
            setError(false);
          }}
        />
        <button type="submit" className="btn btn-primary">
          Go
        </button>
      </div>
      {error && <p className="goto-error">Enter a number from 0 to 999,999.</p>}
    </form>
  );
}
