import { fetchBoardSnapshot, fetchMe, postLogout } from './api.js';
import { BitSet } from './bitset.js';
import { attachBoardInput } from './input.js';
import { Minimap } from './minimap.js';
import { REJECT_CODE } from './protocol.js';
import { BoardRenderer } from './renderer.js';
import { RealtimeSocket } from './socket.js';
import { UIController, formatNum } from './ui.js';

const bitset = new BitSet(1_000_000);
const canvas = document.getElementById('boardCanvas');
const minimapCanvas = document.getElementById('minimapCanvas');

// Optimistic toggle tracking: Map<index, previousValue>
const pendingToggles = new Map();

let snapshotLoaded = false;
let snapshotSeq = 0;
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

function applyRemoteUpdate(seq, index, value) {
  if (!snapshotLoaded) {
    preSnapshotBuffer.push({ seq, index, value });
    return;
  }
  if (seq > 0 && seq <= snapshotSeq) {
    return;
  }
  // If user has an unacknowledged optimistic toggle on this exact cell, keep track
  const changed = bitset.set(index, value);
  if (changed) {
    renderer.markCellUpdated(index, 'live');
    ui.setCheckedCount(bitset.checkedCount);
    minimap.markDirty();
  }
}

async function loadSnapshot() {
  try {
    snapshotLoaded = false;
    const snap = await fetchBoardSnapshot();
    snapshotSeq = snap.seq;
    bitset.loadSnapshot(snap.bytes);

    if (snap.instanceId) {
      ui.setInstanceId(snap.instanceId);
    }

    // Apply any buffered WebSocket updates that occurred after snapshotSeq
    for (const item of preSnapshotBuffer) {
      if (item.seq > snapshotSeq) {
        bitset.set(item.index, item.value);
      }
    }
    preSnapshotBuffer.length = 0;
    snapshotLoaded = true;

    socket.setLastSeq(snapshotSeq);
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

  onAck({ index, value, seq }) {
    pendingToggles.delete(index);
    const changed = bitset.set(index, value);
    if (changed) {
      renderer.markCellUpdated(index, 'own');
      ui.setCheckedCount(bitset.checkedCount);
      minimap.markDirty();
    }
    if (seq > snapshotSeq) snapshotSeq = seq;
  },

  onBatch({ fromSeq, items }) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const seq = fromSeq + i;
      applyRemoteUpdate(seq, item.index, item.value);
    }
  },

  onReject({ index, code }) {
    if (pendingToggles.has(index)) {
      const prev = pendingToggles.get(index);
      pendingToggles.delete(index);
      bitset.set(index, prev);
      renderer.markCellUpdated(index, null);
      ui.setCheckedCount(bitset.checkedCount);
      minimap.markDirty();
    }

    if (code === REJECT_CODE.AUTH) {
      ui.setAuthState({ authenticated: false, user: null });
      ui.showToast("You're viewing live. Sign in to check boxes.", {
        actionLabel: 'Sign in',
        onAction: () => ui.openSignInFlow(),
      });
    } else if (code === REJECT_CODE.RATE) {
      ui.showToast('Slow down — you can check more boxes in 1s.', { alert: true });
    } else if (code === REJECT_CODE.BLOCKED) {
      ui.showToast('Paused for 2 minutes after too many rapid clicks.', { alert: true });
    } else if (code === REJECT_CODE.RANGE) {
      ui.showToast('Checkbox index is out of range.', { alert: true });
    }
  },

  onJson(msg) {
    if (msg.t === 'welcome') {
      if (msg.instanceId) ui.setInstanceId(msg.instanceId);
      if (typeof msg.online === 'number') ui.setOnlineCount(msg.online);
      if (typeof msg.checked === 'number' && snapshotLoaded) {
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

  if (!pendingToggles.has(index)) {
    pendingToggles.set(index, current);
  }

  // Optimistic flip
  bitset.set(index, desired);
  renderer.markCellUpdated(index, 'own');
  ui.setCheckedCount(bitset.checkedCount);
  minimap.markDirty();

  const sent = socket.sendSet(index, desired);
  if (!sent) {
    const prev = pendingToggles.get(index);
    pendingToggles.delete(index);
    bitset.set(index, prev);
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

  // Connect WebSocket and fetch initial state in parallel
  socket.connect();

  const [meResult] = await Promise.allSettled([fetchMe(), loadSnapshot()]);
  if (meResult.status === 'fulfilled') {
    ui.setAuthState(meResult.value);
  }
}

boot();

