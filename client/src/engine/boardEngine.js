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
const FEED_LIMIT = 12;

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

function sanitizeUser(user) {
  if (!user) return null;
  return {
    userId: user.userId,
    name: user.name || 'User',
    picture: user.picture || '',
  };
}

export function createBoardEngine() {
  // serverBits is the server's truth; bitset is what is drawn (truth + optimistic overlay).
  const serverBits = new BitSet(TOTAL);
  const bitset = new BitSet(TOTAL);
  // Optimistic overlay: Map<index, { desired: 0|1, inFlight: number, lastAckSeq: number }>
  const pendingToggles = new Map();
  const preSnapshotBuffer = [];
  const recentRemoteUpdates = []; // { index, ts } for Find activity
  const ownWriteTimestamps = []; // timestamps (ms) of own writes in last 1000ms
  const budget = new ClickBudget({ capacity: 10, refillPerSec: 5 });

  let renderer = null;
  let minimap = null;
  let snapshotLoaded = false;
  let firstBoardZoomDone = false;
  let snapshotPromise = null;
  let activityShownAt = 0;
  let activityPending = null;
  let activityTimer = null;
  let activityHideTimer = null;
  let toastTimer = null;
  let toastSeq = 0;
  let announceSeq = 0;
  let shakeSeq = 0;
  let started = false;

  const store = createStore({
    checked: 0,
    writes: 0,
    feed: [], // Array<{ index, value, at, mine }>, newest first, max 12
    online: 1,
    instances: 1,
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
    signInOpen: false,
  });

  // ---- UI reporting helpers -------------------------------------------------

  function setChecked() {
    store.set({ checked: bitset.checkedCount });
  }

  function pushFeed({ index, value, at = Date.now(), mine = false }) {
    const prev = store.get().feed;
    const entry = { index, value: value ? 1 : 0, at, mine: Boolean(mine) };
    const next = [entry, ...prev].slice(0, FEED_LIMIT);
    store.set({ feed: next });
  }

  function updateWrites(seq) {
    if (typeof seq !== 'number' || !Number.isFinite(seq)) return;
    if (seq > store.get().writes) {
      store.set({ writes: seq });
    }
  }

  function getRecentOwnWrites(now = Date.now()) {
    const cutoff = now - 1000;
    while (ownWriteTimestamps.length > 0 && ownWriteTimestamps[0] <= cutoff) {
      ownWriteTimestamps.shift();
    }
    return ownWriteTimestamps.length;
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
    pushFeed({ index, value, at: now, mine: false });
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
    if (!renderer) return;
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
          renderer?.markCellUpdated(idx, null);
          setChecked();
          minimap?.markDirty();
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
            renderer?.markCellUpdated(index, 'live');
            setChecked();
            minimap?.markDirty();
          }
        } else {
          bitset.set(index, pending.desired);
        }
      } else if (bitset.set(index, value)) {
        renderer?.markCellUpdated(index, 'live');
        setChecked();
        minimap?.markDirty();
        recordRemoteUpdate(index, value);
      }
      reconcilePendingAfterSeqAdvance();
      updateWrites(sequencer.appliedSeq);
    },
    onGap(appliedSeq) {
      // Ask for a cheap replay from the server's Redis Stream; the timeout falls back to a snapshot.
      socket.sendHello(appliedSeq);
    },
    onGapTimeout() {
      loadSnapshot();
    },
  });

  function maybeRunOpeningZoom() {
    if (firstBoardZoomDone || !renderer || !snapshotLoaded) return;
    firstBoardZoomDone = true;
    const hashIdx = parseHashIndex();
    const targetIdx = hashIdx ?? 0;
    renderer.focusedIndex = targetIdx;
    setBox(targetIdx);
    // The board's one orchestrated moment: zoom from the whole sheet into the starting spot.
    renderer.animateTo(
      {
        cellSize: renderer.defaultCellSize,
        centerX: (targetIdx % COLS) + 0.5,
        centerY: Math.floor(targetIdx / COLS) + 0.5,
      },
      900,
    );
    if (hashIdx !== null && !prefersReducedMotion()) {
      renderer.markCellUpdated(hashIdx, 'own');
    }
  }

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
      updateWrites(snap.seq);

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
      renderer?.markSnapshotLoaded();
      minimap?.forceRebuild();
      maybeRunOpeningZoom();
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
      updateWrites(seq);
      const entry = pendingToggles.get(index);
      if (!entry) return;
      entry.inFlight = Math.max(0, entry.inFlight - 1);
      if (seq > entry.lastAckSeq) entry.lastAckSeq = seq;
      if (entry.inFlight === 0 && sequencer.appliedSeq >= entry.lastAckSeq) {
        pendingToggles.delete(index);
        if (bitset.set(index, serverBits.get(index))) {
          renderer?.markCellUpdated(index, null);
          setChecked();
          minimap?.markDirty();
        }
      }
    },

    onBatch({ fromSeq, items }) {
      for (let i = 0; i < items.length; i++) {
        const { index, value } = items[i];
        const seq = fromSeq + i;
        if (!snapshotLoaded) preSnapshotBuffer.push({ seq, index, value });
        else sequencer.push(seq, index, value);
      }
    },

    onReject({ index, code }) {
      const entry = pendingToggles.get(index);
      if (entry) {
        entry.inFlight = Math.max(0, entry.inFlight - 1);
        if (entry.inFlight === 0) {
          pendingToggles.delete(index);
          bitset.set(index, serverBits.get(index));
          renderer?.markCellUpdated(index, null);
          setChecked();
          minimap?.markDirty();
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
        if (typeof msg.seq === 'number') next.writes = Math.max(store.get().writes, msg.seq);
        if (typeof msg.checked === 'number' && snapshotLoaded && pendingToggles.size === 0) {
          next.checked = msg.checked;
        }
        if (msg.user) next.auth = { ...store.get().auth, authenticated: true, user: sanitizeUser(msg.user) };
        store.set(next);
        if (msg.limits) {
          budget.configure({ capacity: msg.limits.bucketCapacity, refillPerSec: msg.limits.bucketRefillPerS });
        }
      } else if (msg.t === 'stats') {
        const next = {};
        if (typeof msg.online === 'number') next.online = Math.max(1, msg.online);
        if (typeof msg.seq === 'number') next.writes = Math.max(store.get().writes, msg.seq);
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

    const now = Date.now();
    const desired = bitset.get(index) ? 0 : 1;
    const entry = pendingToggles.get(index) || { desired, inFlight: 0, lastAckSeq: sequencer.appliedSeq };
    entry.desired = desired;
    entry.inFlight += 1;
    pendingToggles.set(index, entry);

    bitset.set(index, desired); // optimistic
    renderer?.markCellUpdated(index, 'own');
    setChecked();
    minimap?.markDirty();

    if (!socket.sendSet(index, desired)) {
      entry.inFlight = Math.max(0, entry.inFlight - 1);
      if (entry.inFlight === 0) {
        pendingToggles.delete(index);
        bitset.set(index, serverBits.get(index));
      }
      renderer?.markCellUpdated(index, null);
      setChecked();
      toast('Connection lost. Reconnecting…', { alert: true });
      return;
    }

    ownWriteTimestamps.push(now);
    getRecentOwnWrites(now);
    pushFeed({ index, value: desired, at: now, mine: true });
    announce(`Box ${formatNum(index)} ${desired ? 'checked' : 'unchecked'}`);
  }

  // ---- Public API ------------------------------------------------------------------

  function jumpTo(index) {
    const safeIdx = Math.max(0, Math.min(TOTAL - 1, Math.floor(Number(index) || 0)));
    renderer?.centerOnIndex(safeIdx, { focus: true, pulse: true, animate: true });
    setBox(safeIdx);
    const basePath = window.location.pathname === '/grid' ? '/grid' : window.location.pathname;
    history.replaceState(null, '', `${basePath}#${safeIdx}`);
  }

  async function refreshMe() {
    try {
      const me = await fetchMe();
      store.set({
        instanceId: me.instanceId || store.get().instanceId,
        auth: {
          authenticated: Boolean(me.authenticated),
          user: sanitizeUser(me.user),
          oidcEnabled: Boolean(me.oidcEnabled),
          devLoginEnabled: Boolean(me.devLoginEnabled),
        },
      });
    } catch {
      // Stays signed out; the socket's welcome message can still report the user.
    }
  }

  async function refreshStats() {
    try {
      const res = await fetch('/api/stats', { credentials: 'same-origin' });
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.instances) && data.instances.length > 0) {
        store.set({ instances: data.instances.length });
      }
      if (typeof data.seq === 'number') {
        updateWrites(data.seq);
      }
    } catch {
      // Optional metadata; ignore network failures.
    }
  }

  // 1. start(): connects socket, loads /api/me and snapshot, starts timers. Idempotent, called once from main.jsx.
  function start() {
    if (started) return;
    started = true;

    const onHashChange = () => {
      const idx = parseHashIndex();
      if (idx !== null) {
        renderer?.centerOnIndex(idx, { focus: true, pulse: true, animate: true });
        setBox(idx);
      }
    };
    window.addEventListener('hashchange', onHashChange);

    setInterval(() => {
      pruneRecentUpdates();
      store.set({ findAvailable: recentRemoteUpdates.length > 0 });
    }, 5_000);

    setBox(parseHashIndex() ?? 0);
    socket.connect();
    refreshMe();
    refreshStats();
    loadSnapshot();
  }

  // 2. attachBoard(canvas, minimapCanvas): creates renderer, minimap and input handlers, and returns a cleanup.
  function attachBoard(canvas, minimapCanvas) {
    if (!canvas || !minimapCanvas) return () => {};
    if (!started) start();

    const localRenderer = new BoardRenderer(canvas, bitset, {
      onViewportChange(bounds) {
        store.set({ rows: [bounds.rowStart, bounds.rowEnd] });
        minimap?.updateViewport(bounds);
      },
    });
    const localMinimap = new Minimap(minimapCanvas, bitset, localRenderer, { onNavigate: dismissHint });

    renderer = localRenderer;
    minimap = localMinimap;

    localRenderer.resize();

    if (!firstBoardZoomDone) {
      localRenderer.fitToScreen({ animate: false });
      if (snapshotLoaded) {
        localRenderer.markSnapshotLoaded();
        localMinimap.forceRebuild();
        maybeRunOpeningZoom();
      }
    } else {
      const targetIdx = parseHashIndex() ?? store.get().box ?? 0;
      localRenderer.centerOnIndex(targetIdx, { focus: true, animate: false });
      if (snapshotLoaded) {
        localRenderer.markSnapshotLoaded();
        localMinimap.forceRebuild();
      }
    }

    const onResize = () => localRenderer.resize();
    window.addEventListener('resize', onResize);

    attachBoardInput(canvas, localRenderer, {
      onToggleCell: toggleCell,
      onCellFocus: setBox,
      onUserInteraction: dismissHint,
      onOpenGoto: () => store.set({ gotoOpen: true }),
      onEscape: () => store.set({ gotoOpen: false }),
    });

    return () => {
      window.removeEventListener('resize', onResize);
      if (localRenderer.rafId !== null) {
        cancelAnimationFrame(localRenderer.rafId);
        localRenderer.rafId = null;
      }
      if (localMinimap.blipRafId !== null) {
        cancelAnimationFrame(localMinimap.blipRafId);
        localMinimap.blipRafId = null;
      }
      if (renderer === localRenderer) renderer = null;
      if (minimap === localMinimap) minimap = null;
    };
  }

  return {
    store,
    budget,
    start,
    attachBoard,
    jumpTo,
    findActivity,
    dismissHint,
    getRecentOwnWrites,
    resizeBoard: () => renderer?.resize(),
    retry: () => loadSnapshot(),
    zoomIn() {
      dismissHint();
      if (!renderer) return;
      renderer.animateTo({ cellSize: renderer.cellSize < 4 ? 4 : renderer.cellSize * 1.25 }, DUR.fast);
    },
    zoomOut() {
      dismissHint();
      if (!renderer) return;
      const next =
        renderer.cellSize <= 4 ? renderer.fitCellSize : Math.max(renderer.fitCellSize, renderer.cellSize / 1.25);
      renderer.animateTo({ cellSize: next }, DUR.fast);
    },
    fit() {
      dismissHint();
      renderer?.fitToScreen({ animate: true });
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
