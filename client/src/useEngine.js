import { createContext, useContext, useSyncExternalStore } from 'react';

export const EngineContext = createContext(null);

export function useEngine() {
  return useContext(EngineContext);
}

// Subscribe to one slice of engine state. Selectors must return a stored value
// (a primitive or an object kept in state), never a freshly built object.
export function useBoard(selector) {
  const { store } = useEngine();
  return useSyncExternalStore(store.subscribe, () => selector(store.get()));
}

// Dev login opens a name dialog; otherwise go straight to the OIDC provider.
export function openSignIn(engine) {
  const { auth } = engine.store.get();
  engine.store.set({ menuOpen: false });
  if (auth.devLoginEnabled) {
    engine.store.set({ signInOpen: true });
    return;
  }
  const returnTo = `${window.location.pathname}${window.location.hash || ''}`;
  window.location.href = `/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
}
