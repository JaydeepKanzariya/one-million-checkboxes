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
import { UIController, formatNum } from './ui.js';

// serverBits holds authoritative server state; bitset holds displayed state (serverBits + optimistic overlay)
const serverBits = new BitSet(1_000_000);
const bitset = new BitSet(1_000_000);
const canvas = document.getElementById('boardCanvas');
const minimapCanvas = document.getElementById('minimapCanvas');

// Optimistic overlay: Map<index, { desired: 0|1, inFlight: number, lastAckSeq: number }>
const pendingToggles = new Map();

let snapshotLoaded = false;
let firstSnapshotDone = false;
const preSnapshotBuffer = []; // buffered { seq, index, value } while snapshot is loading

// Rolling buffer of the last 500 remote updates { index, ts } for Find activity
const recentRemoteUpdates = [];

const budget = new ClickBudget({ capacity: 10, refillPerSec: 5 });

let minimap = null;

function pruneRecentUpdates(now = Date.now()) {
  const cutoff = now - 60_000;
  while (recentRemoteUpdates.length > 0 && recentRemoteUpdates[0].ts < cutoff) {
    recentRemoteUpdates.shift();
  }
}

function recordRemoteUpdate(index) {
  const now = Date.now();
  recentRemoteUpdates.push({ index, ts: now });
  if (recentRemoteUpdates.length > 500) {
    recentRemoteUpdates.shift();
  }
  pruneRecentUpdates(now);
  ui.setFindActivityAvailable(recentRemoteUpdates.length > 0);
  minimap?.addBlip(index);
}

function findActivity() {
  const now = Date.now();
  pruneRecentUpdates(now);
  if (recentRemoteUpdates.length === 0) {
    ui.setFindActivityAvailable(false);
    return;
  }

  const blockCounts = new Map();
  let bestKey = null;
  let bestCount = 0;

  for (let i = 0; i < recentRemoteUpdates.length; i++) {
    const idx = recentRemoteUpdates[i].index;
    const row = Math.floor(idx / 1000);
    const col = idx % 1000;
    const bRow = Math.floor(row / 50);
    const bCol = Math.floor(col / 50);
    const key = bRow * 20 + bCol;
    const nextCount = (blockCounts.get(key) || 0) + 1;
    blockCounts.set(key, nextCount);
    if (nextCount >= bestCount) {
      bestCount = nextCount;
      bestKey = key;
    }
  }

  if (bestKey === null) return;
  const bestRow = Math.floor(bestKey / 20);
  const bestCol = bestKey % 20;
  const centerX = bestCol * 50 + 25;
  const centerY = bestRow * 50 + 25;
  const focusIdx = Math.min(999, centerY) * 1000 + Math.min(999, centerX);

  renderer.focusedIndex = focusIdx;
  ui.updateCellReadout(focusIdx);
  renderer.animateTo(
    {
      cellSize: Math.max(renderer.cellSize, 20),
      centerX,
      centerY,
    },
    DUR.base
  );
}

const ui = new UIController({
  budget,
  onThemeChange() {
    renderer.refreshTheme();
    minimap?.forceRebuild();
  },
  async onLogout() {
    await postLogout();
    ui.setAuthState({ authenticated: false, user: null });
    ui.showToast('Signed out. Watching live.');
  },
  onJumpTo(index) {
    renderer.centerOnIndex(index, { focus: true, pulse: true, animate: true });
    ui.updateCellReadout(index);
    history.replaceState(null, '', `#${index}`);
  },
  onFindActivity() {
    findActivity();
  },
});

setInterval(() => {
  pruneRecentUpdates();
  ui.setFindActivityAvailable(recentRemoteUpdates.length > 0);
}, 5_000);

const renderer = new BoardRenderer(canvas, bitset, {
  onViewportChange(bounds, cellSize) {
    ui.updateViewportStatus(bounds, cellSize);
    minimap?.updateViewport(bounds);
  },
});

minimap = new Minimap(minimapCanvas, bitset, renderer);

function reconcilePendingAfterSeqAdvance() {
  for (const [idx, entry] of pendingToggles.entries()) {
    if (entry.inFlight === 0 && sequencer.appliedSeq >= entry.lastAckSeq) {
      pendingToggles.delete(idx);
      const truth = serverBits.get(idx);
      if (bitset.set(idx, truth)) {
        renderer.markCellUpdated(idx, null);
        ui.setCheckedCount(bitset.checkedCount);
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
        const changed = bitset.set(index, value);
        if (changed) {
          renderer.markCellUpdated(index, 'live');
          ui.setCheckedCount(bitset.checkedCount);
          minimap.markDirty();
        }
      } else {
        bitset.set(index, pending.desired);
      }
    } else {
      const changed = bitset.set(index, value);
      if (changed) {
        renderer.markCellUpdated(index, 'live');
        ui.setCheckedCount(bitset.checkedCount);
        minimap.markDirty();
        recordRemoteUpdate(index);
      }
    }
    reconcilePendingAfterSeqAdvance();
  },
  onGap(appliedSeq) {
    // Try a cheap replay from the server's Redis Stream first; the timeout falls back to a full snapshot.
    socket.sendHello(appliedSeq);
  },
  onGapTimeout() {
    loadSnapshot();
  },
});

// Only one snapshot load runs at a time, so an older response can never rewind the sequencer.
let snapshotPromise = null;

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

    if (snap.instanceId) {
      ui.setInstanceId(snap.instanceId);
    }

    sequencer.reset(snap.seq);
    snapshotLoaded = true;

    for (const item of preSnapshotBuffer) {
      sequencer.push(item.seq, item.index, item.value);
    }
    preSnapshotBuffer.length = 0;

    // Re-apply any still in-flight optimistic toggles on top of the snapshot
    for (const [idx, entry] of pendingToggles.entries()) {
      if (entry.inFlight > 0) {
        bitset.set(idx, entry.desired);
      } else if (sequencer.appliedSeq >= entry.lastAckSeq) {
        pendingToggles.delete(idx);
      }
    }

    ui.setCheckedCount(bitset.checkedCount);
    renderer.markSnapshotLoaded();
    minimap.forceRebuild();

    if (!firstSnapshotDone) {
      firstSnapshotDone = true;
      const hashIdx = parseHashIndex();
      const targetIdx = hashIdx !== null ? hashIdx : 0;
      const targetRow = Math.floor(targetIdx / 1000);
      const targetCol = targetIdx % 1000;
      renderer.focusedIndex = targetIdx;
      ui.updateCellReadout(targetIdx);
      renderer.animateTo(
        {
          cellSize: renderer.defaultCellSize,
          centerX: targetCol + 0.5,
          centerY: targetRow + 0.5,
        },
        900
      );
      if (hashIdx !== null && !prefersReducedMotion()) {
        renderer.markCellUpdated(hashIdx, 'own');
      }
    }
  } catch (err) {
    console.error('Snapshot load error:', err);
    ui.showToast("Couldn't load the board.", {
      alert: true,
      durationMs: 0,
      actionLabel: 'Retry',
      onAction: () => loadSnapshot(),
    });
  }
}

const socket = new RealtimeSocket({
  getLastSeq() {
    return sequencer.appliedSeq;
  },

  onOpen({ wasReconnect }) {
    ui.setConnectionState('online');
    if (wasReconnect) {
      ui.showToast('Back online.', { durationMs: 2500 });
    }
  },

  onClose() {
    ui.setConnectionState('reconnecting');
    ui.showToast('Connection lost. Reconnecting…', { alert: true, durationMs: 4000 });
  },

  onAck({ index, seq }) {
    const entry = pendingToggles.get(index);
    if (!entry) return;
    entry.inFlight = Math.max(0, entry.inFlight - 1);
    if (seq > entry.lastAckSeq) {
      entry.lastAckSeq = seq;
    }
    if (entry.inFlight === 0 && sequencer.appliedSeq >= entry.lastAckSeq) {
      pendingToggles.delete(index);
      const truth = serverBits.get(index);
      if (bitset.set(index, truth)) {
        renderer.markCellUpdated(index, null);
        ui.setCheckedCount(bitset.checkedCount);
        minimap.markDirty();
      }
    }
  },

  onBatch({ fromSeq, items }) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const seq = fromSeq + i;
      if (!snapshotLoaded) {
        preSnapshotBuffer.push({ seq, index: item.index, value: item.value });
      } else {
        sequencer.push(seq, item.index, item.value);
      }
    }
  },

  onReject({ index, code }) {
    const entry = pendingToggles.get(index);
    if (entry) {
      entry.inFlight = Math.max(0, entry.inFlight - 1);
      if (entry.inFlight === 0) {
        pendingToggles.delete(index);
        const truth = serverBits.get(index);
        bitset.set(index, truth);
        renderer.markCellUpdated(index, null);
        ui.setCheckedCount(bitset.checkedCount);
        minimap.markDirty();
      }
    }

    if (code === REJECT_CODE.AUTH) {
      ui.setAuthState({ authenticated: false, user: null });
      ui.showToast("You're watching live. Sign in to check boxes.", {
        actionLabel: 'Sign in',
        onAction: () => ui.openSignInFlow(),
      });
    } else if (code === REJECT_CODE.RATE) {
      budget.drain();
      ui.syncBudget();
      ui.shakeBudget();
      ui.announce('Slow down. Clicks refill in a moment.');
    } else if (code === REJECT_CODE.BLOCKED) {
      ui.startCooldown(120_000, 'blocked');
    }
  },

  onJson(msg) {
    if (msg.t === 'welcome') {
      if (msg.instanceId) ui.setInstanceId(msg.instanceId);
      if (typeof msg.online === 'number') ui.setOnlineCount(msg.online);
      if (typeof msg.checked === 'number' && snapshotLoaded && pendingToggles.size === 0) {
        ui.setCheckedCount(msg.checked);
      }
      if (msg.limits) {
        budget.configure({
          capacity: msg.limits.bucketCapacity,
          refillPerSec: msg.limits.bucketRefillPerS,
        });
        ui.syncBudget();
      }
      if (msg.user) {
        ui.setAuthState({ authenticated: true, user: msg.user });
      }
    } else if (msg.t === 'stats') {
      if (typeof msg.online === 'number') ui.setOnlineCount(msg.online);
      if (typeof msg.checked === 'number' && pendingToggles.size === 0 && snapshotLoaded) {
        ui.setCheckedCount(msg.checked);
      }
    } else if (msg.t === 'resync') {
      loadSnapshot();
    } else if (msg.t === 'limit') {
      if (msg.reason === 'blocked') {
        ui.startCooldown(msg.retryAfterMs || 120_000, 'blocked');
      } else {
        budget.drain();
        ui.syncBudget();
        ui.shakeBudget();
        ui.announce('Slow down. Clicks refill in a moment.');
      }
    } else if (msg.t === 'session_expired') {
      ui.setAuthState({ authenticated: false, user: null });
      ui.showToast('Session ended. Sign in again.', {
        alert: true,
        actionLabel: 'Sign in',
        onAction: () => ui.openSignInFlow(),
      });
    }
  },
});

function handleToggleCell(index) {
  ui.dismissHint();

  if (!ui.authState.authenticated) {
    ui.showToast("You're watching live. Sign in to check boxes.", {
      actionLabel: 'Sign in',
      onAction: () => ui.openSignInFlow(),
    });
    return;
  }

  if (ui.cooldownUntilMs > Date.now()) {
    ui.shakeBudget();
    return;
  }

  if (!budget.consume()) {
    ui.syncBudget();
    ui.shakeBudget();
    ui.announce('Slow down. Clicks refill in a moment.');
    return;
  }
  ui.syncBudget();

  const current = bitset.get(index);
  const desired = current ? 0 : 1;

  const entry = pendingToggles.get(index) || {
    desired,
    inFlight: 0,
    lastAckSeq: sequencer.appliedSeq,
  };
  entry.desired = desired;
  entry.inFlight += 1;
  pendingToggles.set(index, entry);

  // Optimistic flip
  bitset.set(index, desired);
  renderer.markCellUpdated(index, 'own');
  ui.setCheckedCount(bitset.checkedCount);
  minimap.markDirty();

  const sent = socket.sendSet(index, desired);
  if (!sent) {
    entry.inFlight = Math.max(0, entry.inFlight - 1);
    if (entry.inFlight === 0) {
      pendingToggles.delete(index);
      bitset.set(index, serverBits.get(index));
    }
    renderer.markCellUpdated(index, null);
    ui.setCheckedCount(bitset.checkedCount);
    ui.showToast('Connection lost. Reconnecting…', { alert: true });
    return;
  }

  ui.announce(`Box ${formatNum(index)} ${desired ? 'checked' : 'unchecked'}`);
}

function initZoomButtons() {
  document.getElementById('zoomInBtn')?.addEventListener('click', () => {
    ui.dismissHint();
    const next = renderer.cellSize < 4 ? 4 : renderer.cellSize * 1.25;
    renderer.animateTo({ cellSize: next }, DUR.fast);
  });
  document.getElementById('zoomOutBtn')?.addEventListener('click', () => {
    ui.dismissHint();
    const next =
      renderer.cellSize <= 4
        ? renderer.fitCellSize
        : Math.max(renderer.fitCellSize, renderer.cellSize / 1.25);
    renderer.animateTo({ cellSize: next }, DUR.fast);
  });
  document.getElementById('zoomFitBtn')?.addEventListener('click', () => {
    ui.dismissHint();
    renderer.fitToScreen({ animate: true });
  });
  document.getElementById('brandReset')?.addEventListener('click', (e) => {
    e.preventDefault();
    ui.dismissHint();
    renderer.centerOnIndex(0, { focus: true, animate: true });
    ui.updateCellReadout(0);
    history.replaceState(null, '', window.location.pathname);
  });
}

function parseHashIndex() {
  const raw = window.location.hash.replace(/^#/, '').trim();
  if (!raw) return null;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 0 && n < 1_000_000) return n;
  return null;
}

async function boot() {
  renderer.resize();
  renderer.fitToScreen({ animate: false });
  window.addEventListener('resize', () => renderer.resize());

  initZoomButtons();
  attachBoardInput(canvas, renderer, {
    onToggleCell: handleToggleCell,
    onCellFocus: (idx) => ui.updateCellReadout(idx),
    onFirstInteract: () => ui.dismissHint(),
    onOpenGoto: () => ui.openGotoPopover(),
    onEscape: () => ui.closeAllPopovers(),
  });

  const hashIdx = parseHashIndex();
  ui.updateCellReadout(hashIdx !== null ? hashIdx : 0);

  window.addEventListener('hashchange', () => {
    const idx = parseHashIndex();
    if (idx !== null) {
      renderer.centerOnIndex(idx, { focus: true, pulse: true, animate: true });
      ui.updateCellReadout(idx);
    }
  });

  socket.connect();

  const [meResult] = await Promise.allSettled([fetchMe(), loadSnapshot()]);
  if (meResult.status === 'fulfilled') {
    ui.setAuthState(meResult.value);
  }
}

boot();
