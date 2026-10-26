import { fetchBoardSnapshot, fetchMe, postLogout } from './api.js';
import { BitSet } from './bitset.js';
import { attachBoardInput } from './input.js';
import { Minimap } from './minimap.js';
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
const preSnapshotBuffer = []; // buffered { seq, index, value } while snapshot is loading

let minimap = null;

const ui = new UIController({
  onThemeChange() {
    renderer.refreshTheme();
    minimap?.forceRebuild();
  },
  async onLogout() {
    await postLogout();
    ui.setAuthState({ authenticated: false, user: null });
    ui.showToast('Signed out. Viewing in read-only mode.');
  },
  onJumpTo(index) {
    renderer.centerOnIndex(index, { focus: true, pulse: true });
    ui.updateCellReadout(index);
    history.replaceState(null, '', `#${index}`);
  },
});

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
      ui.showToast('Back online. Board is up to date.', { durationMs: 2500 });
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
      ui.showToast("You're viewing live. Sign in to check boxes.", {
        actionLabel: 'Sign in',
        onAction: () => ui.openSignInFlow(),
      });
    } else if (code === REJECT_CODE.RANGE) {
      ui.showToast('Checkbox index is out of range.', { alert: true });
    }
  },

  onJson(msg) {
    if (msg.t === 'welcome') {
      if (msg.instanceId) ui.setInstanceId(msg.instanceId);
      if (typeof msg.online === 'number') ui.setOnlineCount(msg.online);
      if (typeof msg.checked === 'number' && snapshotLoaded && pendingToggles.size === 0) {
        ui.setCheckedCount(msg.checked);
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
      const secs = Math.max(1, Math.ceil((msg.retryAfterMs || 1000) / 1000));
      if (msg.reason === 'blocked') {
        ui.startCooldown(msg.retryAfterMs || 120_000, 'blocked');
        ui.showToast('Paused for 2 minutes after too many rapid clicks.', { alert: true });
      } else {
        ui.startCooldown(msg.retryAfterMs || 1000, 'rate');
        ui.showToast(`Slow down — you can check more boxes in ${secs}s.`, { alert: true });
      }
    } else if (msg.t === 'session_expired') {
      ui.setAuthState({ authenticated: false, user: null });
      ui.showToast('Your session ended. Sign in again to keep checking.', {
        alert: true,
        actionLabel: 'Sign in',
        onAction: () => ui.openSignInFlow(),
      });
    }
  },
});

function handleToggleCell(index) {
  if (!ui.authState.authenticated) {
    ui.showToast("You're viewing live. Sign in to check boxes.", {
      actionLabel: 'Sign in',
      onAction: () => ui.openSignInFlow(),
    });
    return;
  }

  if (ui.cooldownUntilMs > Date.now()) {
    const secs = Math.max(1, Math.ceil((ui.cooldownUntilMs - Date.now()) / 1000));
    ui.showToast(`Slow down — you can check more boxes in ${secs}s.`, { alert: true });
    return;
  }

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

  ui.announce(`Checkbox ${formatNum(index)} ${desired ? 'checked' : 'unchecked'}`);
}

function initZoomButtons() {
  document.getElementById('zoomInBtn')?.addEventListener('click', () => {
    const step = renderer.cellSize < 4 ? 2 : 4;
    renderer.setZoomAt(renderer.cellSize + step);
  });
  document.getElementById('zoomOutBtn')?.addEventListener('click', () => {
    const step = renderer.cellSize <= 4 ? 1.5 : 4;
    renderer.setZoomAt(renderer.cellSize - step);
  });
  document.getElementById('zoomResetBtn')?.addEventListener('click', () => {
    renderer.setZoomAt(20);
  });
  document.getElementById('brandReset')?.addEventListener('click', (e) => {
    e.preventDefault();
    renderer.centerOnIndex(0, { focus: true });
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
  window.addEventListener('resize', () => renderer.resize());

  initZoomButtons();
  attachBoardInput(canvas, renderer, {
    onToggleCell: handleToggleCell,
    onCellFocus: (idx) => ui.updateCellReadout(idx),
  });

  const hashIdx = parseHashIndex();
  if (hashIdx !== null) {
    renderer.centerOnIndex(hashIdx, { focus: true });
    ui.updateCellReadout(hashIdx);
  } else {
    ui.updateCellReadout(0);
  }

  window.addEventListener('hashchange', () => {
    const idx = parseHashIndex();
    if (idx !== null) {
      renderer.centerOnIndex(idx, { focus: true, pulse: true });
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
