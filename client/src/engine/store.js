// Minimal external store for React's useSyncExternalStore.
// State is replaced (never mutated) so React can compare snapshots by reference.

export function createStore(initial) {
  let state = initial;
  const listeners = new Set();

  return {
    get: () => state,
    set(partial) {
      const next = typeof partial === 'function' ? partial(state) : partial;
      let changed = false;
      for (const key in next) {
        if (!Object.is(state[key], next[key])) {
          changed = true;
          break;
        }
      }
      if (!changed) return;
      state = { ...state, ...next };
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
