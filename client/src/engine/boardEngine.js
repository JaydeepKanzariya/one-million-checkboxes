// Board engine: everything that keeps the board correct and live.
// It owns the bitsets, sequencer, socket, renderer and minimap, and reports what the UI
// needs through a store. React components only read the store and call engine methods.

import { fetchBoardSnapshot, fetchMe, postLogout } from './api.js';
import { BitSet } from './bitset.js';
import { ClickBudget } from './clickBudget.js';
import { attachBoardInput } from './input.js';
import { Minimap } from './minimap.js';
import { DUR, prefersReducedMotion } from './motion.js';
import { REJECT_CODE } from './protocol.js';
import { BoardRenderer } from './renderer.js';
import { Sequencer } from './sequencer.js';
import { RealtimeSocket } from './socket.js';
import { createStore } from './store.js';

const TOTAL = 1_000_000;
const COLS = 1000;
const ACTIVITY_MIN_GAP_MS = 1200;
const ACTIVITY_VISIBLE_MS = 8000;

const numFmt = new Intl.NumberFormat('en-US');
export const formatNum = (n) => numFmt.format(Number(n) || 0);

export function parseHashIndex() {
  const raw = window.location.hash.replace(/^#/, '').trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n < TOTAL ? n : null;
}

function readHintSeen() {
  try {
    return localStorage.getItem('omc:hintSeen') === '1';
  } catch {
    return false;
  }
}

export function createBoardEngine() {
  // serverBits is the server's truth; bitset is what is drawn (truth + optimistic overlay).
  const serverBits = new BitSet(TOTAL);
  const bitset = new BitSet(TOTAL);
  // Optimistic overlay: Map<index, { desired: 0|1, inFlight: number, lastAckSeq: number }>
  const pendingToggles = new Map();
  const preSnapshotBuffer = [];
  const recentRemoteUpdates = []; // { index, ts } for Find activity
  const budget = new ClickBudget({ capacity: 10, refillPerSec: 5 });

  let renderer = null;
  let minimap = null;
  let snapshotLoaded = false;
  let firstSnapshotDone = false;
  let snapshotPromise = null;
  let activityShownAt = 0;
  let activityPending = null;
  let activityTimer = null;
  let activityHideTimer = null;
  let toastTimer = null;
  let toastSeq = 0;
  let announceSeq = 0;
  let shakeSeq = 0;
  let mounted = false;
  const cleanups = [];

  const store = createStore({
    checked: 0,
    online: 1,
    connection: 'connecting', // 'online' | 'reconnecting' | 'connecting'
    instanceId: '',
    debug: new URLSearchParams(window.location.search).get('debug') === '1',
    auth: { authenticated: false, user: null, oidcEnabled: false, devLoginEnabled: false },
    rows: [0, 0],
    box: 0,
    findAvailable: false,
    activity: null, // { index, value, key }
    toast: null, // { message, alert, action: 'signin' | 'retry' | null, key }
    announcement: null, // { text, key }
    cooldownUntil: 0,
    shakeKey: 0,
    hintVisible: !readHintSeen(),
    gotoOpen: false,
    menuOpen: false,
    signInOpen: false,
  });

  // ---- UI reporting helpers -------------------------------------------------

  function setChecked() {
    store.set({ checked: bitset.checkedCount });
  }

  function toast(message, { alert = false, action = null, durationMs = 3500 } = {}) {
    clearTimeout(toastTimer);
    store.set({ toast: { message, alert, action, key: ++toastSeq } });
    if (durationMs > 0) {
      toastTimer = setTimeout(() => store.set({ toast: null }), durationMs);
    }
  }

  function announce(text) {
    store.set({ announcement: { text, key: ++announceSeq } });
  }

  function shakeBudget() {
    if (!prefersReducedMotion()) store.set({ shakeKey: ++shakeSeq });
  }

  function slowDown() {
    budget.drain();
    shakeBudget();
    announce('Slow down. Clicks refill in a moment.');
  }

  function dismissHint() {
    if (!store.get().hintVisible) return;
    store.set({ hintVisible: false });
    try {
      localStorage.setItem('omc:hintSeen', '1');
    } catch {
      // Storage can be blocked; the hint simply shows again next visit.
    }
  }

  function setBox(index) {
    if (index >= 0) store.set({ box: index });
  }

  // ---- Activity --------------------------------------------------------------

  function pruneRecentUpdates(now = Date.now()) {
    const cutoff = now - 60_000;
    while (recentRemoteUpdates.length > 0 && recentRemoteUpdates[0].ts < cutoff) {
      recentRemoteUpdates.shift();
    }
  }

  function recordRemoteUpdate(index, value) {
    const now = Date.now();
    recentRemoteUpdates.push({ index, ts: now });
    if (recentRemoteUpdates.length > 500) recentRemoteUpdates.shift();
    pruneRecentUpdates(now);
    store.set({ findAvailable: recentRemoteUpdates.length > 0 });
    minimap?.addBlip(index);
    showActivity(index, value);
  }

  // The footer shows at most one remote change per ACTIVITY_MIN_GAP_MS so it stays readable.
  function showActivity(index, value) {
    const wait = ACTIVITY_MIN_GAP_MS - (Date.now() - activityShownAt);
    if (wait > 0) {
      activityPending = { index, value };
      if (!activityTimer) {
        activityTimer = setTimeout(() => {
          activityTimer = null;
          const next = activityPending;
          activityPending = null;
          if (next) showActivity(next.index, next.value);
        }, wait);
      }
      return;
    }
    activityShownAt = Date.now();
    store.set({ activity: { index, value, key: activityShownAt } });
    clearTimeout(activityHideTimer);
    activityHideTimer = setTimeout(() => store.set({ activity: null }), ACTIVITY_VISIBLE_MS);
  }

  function findActivity() {
    pruneRecentUpdates();
    if (recentRemoteUpdates.length === 0) {
      store.set({ findAvailable: false });
      return;
    }
    // Busiest 50x50 block of the last minute.
    const blockCounts = new Map();
    let bestKey = null;
    let bestCount = 0;
    for (const { index } of recentRemoteUpdates) {
      const key = Math.floor(Math.floor(index / COLS) / 50) * 20 + Math.floor((index % COLS) / 50);
      const count = (blockCounts.get(key) || 0) + 1;
      blockCounts.set(key, count);
      if (count >= bestCount) {
        bestCount = count;
        bestKey = key;
      }
    }
    const centerX = (bestKey % 20) * 50 + 25;
    const centerY = Math.floor(bestKey / 20) * 50 + 25;
    const focusIdx = Math.min(999, centerY) * COLS + Math.min(999, centerX);
    renderer.focusedIndex = focusIdx;
    setBox(focusIdx);
    renderer.animateTo({ cellSize: Math.max(renderer.cellSize, 20), centerX, centerY }, DUR.base);
  }

  // ---- Sequencing and optimistic overlay ---------------------------------------

  function reconcilePendingAfterSeqAdvance() {
    for (const [idx, entry] of pendingToggles.entries()) {
      if (entry.inFlight === 0 && sequencer.appliedSeq >= entry.lastAckSeq) {
        pendingToggles.delete(idx);
        if (bitset.set(idx, serverBits.get(idx))) {
          renderer.markCellUpdated(idx, null);
          setChecked();
          minimap.markDirty();
        }
      }
    }
  }

  const sequencer = new Sequencer({
    apply(index, value) {
      serverBits.set(index, value);
      const pending = pendingToggles.get(index);
      if (pending) {
        if (pending.inFlight === 0 && sequencer.appliedSeq >= pending.lastAckSeq) {
          pendingToggles.delete(index);
          if (bitset.set(index, value)) {
            renderer.markCellUpdated(index, 'live');
            setChecked();
            minimap.markDirty();
          }
        } else {
          bitset.set(index, pending.desired);
        }
      } else if (bitset.set(index, value)) {
        renderer.markCellUpdated(index, 'live');
        setChecked();
        minimap.markDirty();
        recordRemoteUpdate(index, value);
      }
      reconcilePendingAfterSeqAdvance();
    },
    onGap(appliedSeq) {
      // Ask for a cheap replay from the server's Redis Stream; the timeout falls back to a snapshot.
      socket.sendHello(appliedSeq);
    },
    onGapTimeout() {
      loadSnapshot();
    },
  });

  // Only one snapshot load runs at a time, so an older response can never rewind the sequencer.
  function loadSnapshot() {
    if (!snapshotPromise) {
      snapshotPromise = fetchAndApplySnapshot().finally(() => {
        snapshotPromise = null;
      });
    }
    return snapshotPromise;
  }

  async function fetchAndApplySnapshot() {
    try {
      snapshotLoaded = false;
      const snap = await fetchBoardSnapshot();
      serverBits.loadSnapshot(snap.bytes);
      bitset.loadSnapshot(snap.bytes);
      if (snap.instanceId) store.set({ instanceId: snap.instanceId });

      sequencer.reset(snap.seq);
      snapshotLoaded = true;
      for (const item of preSnapshotBuffer) sequencer.push(item.seq, item.index, item.value);
      preSnapshotBuffer.length = 0;

      // Re-apply still in-flight optimistic toggles on top of the snapshot.
      for (const [idx, entry] of pendingToggles.entries()) {
        if (entry.inFlight > 0) bitset.set(idx, entry.desired);
        else if (sequencer.appliedSeq >= entry.lastAckSeq) pendingToggles.delete(idx);
      }

      setChecked();
      renderer.markSnapshotLoaded();
      minimap.forceRebuild();

      if (!firstSnapshotDone) {
        firstSnapshotDone = true;
        const hashIdx = parseHashIndex();
        const targetIdx = hashIdx ?? 0;
        renderer.focusedIndex = targetIdx;
        setBox(targetIdx);
        // The page's one orchestrated moment: zoom from the whole sheet into the starting spot.
        renderer.animateTo(
          {
            cellSize: renderer.defaultCellSize,
            centerX: (targetIdx % COLS) + 0.5,
            centerY: Math.floor(targetIdx / COLS) + 0.5,
          },
          900,
        );
        if (hashIdx !== null && !prefersReducedMotion()) renderer.markCellUpdated(hashIdx, 'own');
      }
    } catch (err) {
      console.error('Snapshot load error:', err);
      toast("Couldn't load the board.", { alert: true, action: 'retry', durationMs: 0 });
    }
  }

  // ---- Socket ------------------------------------------------------------------

  function signedOut(message, alert = false) {
    store.set({ auth: { ...store.get().auth, authenticated: false, user: null } });
    toast(message, { alert, action: 'signin' });
  }

  const socket = new RealtimeSocket({
    getLastSeq: () => sequencer.appliedSeq,

    onOpen({ wasReconnect }) {
      store.set({ connection: 'online' });
      if (wasReconnect) toast('Back online.', { durationMs: 2500 });
    },

    onClose() {
      store.set({ connection: 'reconnecting' });
      toast('Connection lost. Reconnecting…', { alert: true, durationMs: 4000 });
    },

    onAck({ index, seq }) {
      const entry = pendingToggles.get(index);
      if (!entry) return;
      entry.inFlight = Math.max(0, entry.inFlight - 1);
      if (seq > entry.lastAckSeq) entry.lastAckSeq = seq;
      if (entry.inFlight === 0 && sequencer.appliedSeq >= entry.lastAckSeq) {
        pendingToggles.delete(index);
        if (bitset.set(index, serverBits.get(index))) {
          renderer.markCellUpdated(index, null);
          setChecked();
          minimap.markDirty();
        }
      }
    },

    onBatch({ fromSeq, items }) {
      for (let i = 0; i < items.length; i++) {
        const { index, value } = items[i];
        if (!snapshotLoaded) preSnapshotBuffer.push({ seq: fromSeq + i, index, value });
        else sequencer.push(fromSeq + i, index, value);
      }
    },

    onReject({ index, code }) {
      const entry = pendingToggles.get(index);
      if (entry) {
        entry.inFlight = Math.max(0, entry.inFlight - 1);
        if (entry.inFlight === 0) {
          pendingToggles.delete(index);
          bitset.set(index, serverBits.get(index));
          renderer.markCellUpdated(index, null);
          setChecked();
          minimap.markDirty();
        }
      }
      if (code === REJECT_CODE.AUTH) signedOut("You're watching live. Sign in to check boxes.");
      else if (code === REJECT_CODE.RATE) slowDown();
      else if (code === REJECT_CODE.BLOCKED) startCooldown(120_000);
    },

    onJson(msg) {
      if (msg.t === 'welcome') {
        const next = {};
        if (msg.instanceId) next.instanceId = msg.instanceId;
        if (typeof msg.online === 'number') next.online = Math.max(1, msg.online);
        if (typeof msg.checked === 'number' && snapshotLoaded && pendingToggles.size === 0) {
          next.checked = msg.checked;
        }
        if (msg.user) next.auth = { ...store.get().auth, authenticated: true, user: msg.user };
        store.set(next);
        if (msg.limits) {
          budget.configure({ capacity: msg.limits.bucketCapacity, refillPerSec: msg.limits.bucketRefillPerS });
        }
      } else if (msg.t === 'stats') {
        const next = {};
        if (typeof msg.online === 'number') next.online = Math.max(1, msg.online);
        if (typeof msg.checked === 'number' && pendingToggles.size === 0 && snapshotLoaded) {
          next.checked = msg.checked;
        }
        store.set(next);
      } else if (msg.t === 'resync') {
        loadSnapshot();
      } else if (msg.t === 'limit') {
        if (msg.reason === 'blocked') startCooldown(msg.retryAfterMs || 120_000);
        else slowDown();
      } else if (msg.t === 'session_expired') {
        signedOut('Session ended. Sign in again.', true);
      }
    },
  });

  function startCooldown(retryAfterMs) {
    const until = Date.now() + Math.max(1000, retryAfterMs);
    if (until > store.get().cooldownUntil) store.set({ cooldownUntil: until });
  }

  // ---- Clicking a box ------------------------------------------------------------

  function toggleCell(index) {
    dismissHint();
    const { auth, cooldownUntil } = store.get();
    if (!auth.authenticated) {
      toast("You're watching live. Sign in to check boxes.", { action: 'signin' });
      return;
    }
    if (cooldownUntil > Date.now()) {
      shakeBudget();
      return;
    }
    if (!budget.consume()) {
      shakeBudget();
      announce('Slow down. Clicks refill in a moment.');
      return;
    }

    const desired = bitset.get(index) ? 0 : 1;
    const entry = pendingToggles.get(index) || { desired, inFlight: 0, lastAckSeq: sequencer.appliedSeq };
    entry.desired = desired;
    entry.inFlight += 1;
    pendingToggles.set(index, entry);

    bitset.set(index, desired); // optimistic
    renderer.markCellUpdated(index, 'own');
    setChecked();
    minimap.markDirty();

    if (!socket.sendSet(index, desired)) {
      entry.inFlight = Math.max(0, entry.inFlight - 1);
      if (entry.inFlight === 0) {
        pendingToggles.delete(index);
        bitset.set(index, serverBits.get(index));
      }
      renderer.markCellUpdated(index, null);
      setChecked();
      toast('Connection lost. Reconnecting…', { alert: true });
      return;
    }
    announce(`Box ${formatNum(index)} ${desired ? 'checked' : 'unchecked'}`);
  }

  // ---- Public API ------------------------------------------------------------------

  function jumpTo(index) {
    renderer.centerOnIndex(index, { focus: true, pulse: true, animate: true });
    setBox(index);
    history.replaceState(null, '', `#${index}`);
  }

  async function refreshMe() {
    try {
      const me = await fetchMe();
      store.set({
        instanceId: me.instanceId || store.get().instanceId,
        auth: {
          authenticated: Boolean(me.authenticated),
          user: me.user || null,
          oidcEnabled: Boolean(me.oidcEnabled),
          devLoginEnabled: Boolean(me.devLoginEnabled),
        },
      });
    } catch {
      // Stays signed out; the socket's welcome message can still report the user.
    }
  }

  // Attach to the two canvases React rendered. Safe to call once per page.
  function mount(canvas, minimapCanvas) {
    if (mounted) return () => {};
    mounted = true;

    renderer = new BoardRenderer(canvas, bitset, {
      onViewportChange(bounds) {
        store.set({ rows: [bounds.rowStart, bounds.rowEnd] });
        minimap?.updateViewport(bounds);
      },
    });
    minimap = new Minimap(minimapCanvas, bitset, renderer, { onNavigate: dismissHint });

    renderer.resize();
    renderer.fitToScreen({ animate: false });
    const onResize = () => renderer.resize();
    window.addEventListener('resize', onResize);
    cleanups.push(() => window.removeEventListener('resize', onResize));

    attachBoardInput(canvas, renderer, {
      onToggleCell: toggleCell,
      onCellFocus: setBox,
      onUserInteraction: dismissHint,
      onOpenGoto: () => store.set({ gotoOpen: true }),
      onEscape: () => store.set({ gotoOpen: false, menuOpen: false }),
    });

    const onHashChange = () => {
      const idx = parseHashIndex();
      if (idx !== null) {
        renderer.centerOnIndex(idx, { focus: true, pulse: true, animate: true });
        setBox(idx);
      }
    };
    window.addEventListener('hashchange', onHashChange);
    cleanups.push(() => window.removeEventListener('hashchange', onHashChange));

    const pruneTimer = setInterval(() => {
      pruneRecentUpdates();
      store.set({ findAvailable: recentRemoteUpdates.length > 0 });
    }, 5_000);
    cleanups.push(() => clearInterval(pruneTimer));

    setBox(parseHashIndex() ?? 0);
    socket.connect();
    refreshMe();
    loadSnapshot();

    return () => {
      for (const fn of cleanups.splice(0)) fn();
      socket.close();
    };
  }

  return {
    store,
    budget,
    mount,
    jumpTo,
    findActivity,
    dismissHint,
    retry: () => loadSnapshot(),
    zoomIn() {
      dismissHint();
      renderer.animateTo({ cellSize: renderer.cellSize < 4 ? 4 : renderer.cellSize * 1.25 }, DUR.fast);
    },
    zoomOut() {
      dismissHint();
      const next =
        renderer.cellSize <= 4 ? renderer.fitCellSize : Math.max(renderer.fitCellSize, renderer.cellSize / 1.25);
      renderer.animateTo({ cellSize: next }, DUR.fast);
    },
    fit() {
      dismissHint();
      renderer.fitToScreen({ animate: true });
    },
    resetView() {
      dismissHint();
      renderer.centerOnIndex(0, { focus: true, animate: true });
      setBox(0);
      history.replaceState(null, '', window.location.pathname);
    },
    async logout() {
      await postLogout();
      store.set({ auth: { ...store.get().auth, authenticated: false, user: null } });
      toast('Signed out. Watching live.');
    },
    dismissToast() {
      clearTimeout(toastTimer);
      store.set({ toast: null });
    },
  };
}
