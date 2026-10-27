import { useSyncExternalStore } from 'react';
import { prefersReducedMotion } from './engine/motion.js';
import { parseHashIndex } from './engine/boardEngine.js';

const listeners = new Set();

function notify() {
  for (const fn of listeners) fn();
}

if (typeof window !== 'undefined') {
  // Redirect /#523417 numeric box links to /grid#523417 on initial load
  if (window.location.pathname !== '/grid' && parseHashIndex() !== null) {
    window.history.replaceState(null, '', `/grid${window.location.hash}`);
  }

  window.addEventListener('popstate', () => {
    notify();
  });
}

function getPathname() {
  if (typeof window === 'undefined') return '/';
  return window.location.pathname === '/grid' ? '/grid' : '/';
}

function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function navigate(to, { replace = false } = {}) {
  if (typeof window === 'undefined') return;

  const url = new URL(to, window.location.origin);
  const nextFull = `${url.pathname}${url.search}${url.hash}`;
  const curFull = `${window.location.pathname}${window.location.search}${window.location.hash}`;

  if (nextFull !== curFull) {
    if (replace) {
      window.history.replaceState(null, '', nextFull);
    } else {
      window.history.pushState(null, '', nextFull);
    }
  }

  notify();

  if (url.hash && url.pathname !== '/grid') {
    const id = url.hash.replace(/^#/, '');
    requestAnimationFrame(() => {
      const el = document.getElementById(id);
      if (el) {
        el.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      }
    });
  } else {
    window.scrollTo({ top: 0, behavior: 'auto' });
  }
}

export function useRoute() {
  return useSyncExternalStore(subscribe, getPathname, () => '/');
}

