import { config } from '../config.js';
import { logger } from '../logger.js';
import { getBoardStats } from '../redis/board.js';
import { subscriber } from '../redis/client.js';
import { keys } from '../redis/keys.js';
import { getOnlineCount, refreshPresenceAndInstance } from './presence.js';
import { encodeBatch, encodeJson } from './protocol.js';

export class Broadcaster {
  constructor(socketsMap) {
    this.sockets = socketsMap; // Map<socketId, WebSocket>
    this.pending = [];
    this.fromSeq = 0;
    this.batchTimer = null;
    this.statsTimer = null;
    this.lastStats = { online: -1, checked: -1 };
    this.hasSubscribedOnce = false;
    this.onMessage = this.onMessage.bind(this);
    this.onReady = this.onReady.bind(this);
  }

  async start() {
    subscriber.on('message', this.onMessage);
    subscriber.on('ready', this.onReady);

    await subscriber.subscribe(keys.chUpdates, keys.chControl);
    this.hasSubscribedOnce = true;

    this.batchTimer = setInterval(() => {
      this.flushBatch();
    }, config.board.broadcastIntervalMs);
    this.batchTimer.unref?.();

    this.statsTimer = setInterval(() => {
      this.tickStatsAndPresence().catch((err) => {
        logger.debug({ err: err.message }, 'stats tick failed');
      });
    }, 2000);
    this.statsTimer.unref?.();

    await this.tickStatsAndPresence();
  }

  async stop() {
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = null;
    }
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    this.flushBatch();
    subscriber.off('message', this.onMessage);
    subscriber.off('ready', this.onReady);
    try {
      if (subscriber.status === 'ready') {
        await subscriber.unsubscribe(keys.chUpdates, keys.chControl);
      }
    } catch {
      // Ignore during shutdown
    }
  }

  onReady() {
    if (!this.hasSubscribedOnce) return;
    logger.warn('redis subscriber reconnected; broadcasting resync to local sockets');
    subscriber.subscribe(keys.chUpdates, keys.chControl).catch((err) => {
      logger.error({ err: err.message }, 'failed to resubscribe');
    });
    this.broadcastJson({ t: 'resync' });
  }

  onMessage(channel, message) {
    if (channel === keys.chUpdates) {
      const firstColon = message.indexOf(':');
      const secondColon = message.indexOf(':', firstColon + 1);
      if (firstColon < 0 || secondColon < 0) return;

      const seq = Number(message.slice(0, firstColon));
      const index = Number(message.slice(firstColon + 1, secondColon));
      const value = Number(message.slice(secondColon + 1));

      if (!Number.isInteger(seq) || !Number.isInteger(index)) return;
      if (this.pending.length === 0) {
        this.fromSeq = seq;
      }
      this.pending.push({ seq, index, value });
      if (this.pending.length >= 4096) {
        this.flushBatch();
      }
      return;
    }

    if (channel === keys.chControl) {
      try {
        const ctrl = JSON.parse(message);
        if (ctrl.t === 'resync') {
          this.broadcastJson({ t: 'resync' });
        } else if (ctrl.t === 'logout' && ctrl.userId) {
          this.downgradeUserSockets(ctrl.userId);
        }
      } catch {
        // Ignore malformed control payload
      }
    }
  }

  flushBatch() {
    if (this.pending.length === 0) return;
    const items = this.pending;
    const fromSeq = this.fromSeq;
    this.pending = [];
    this.fromSeq = 0;

    if (this.sockets.size === 0) return;

    const frame = encodeBatch(fromSeq, items);
    for (const ws of this.sockets.values()) {
      if (ws.readyState !== 1) continue;
      if (ws.bufferedAmount >= 1_048_576) {
        logger.warn({ socketId: ws.id, bufferedAmount: ws.bufferedAmount }, 'terminating slow ws client');
        ws.terminate();
        continue;
      }
      ws.send(frame, { binary: true });
    }
  }

  downgradeUserSockets(userId) {
    const payload = encodeJson({ t: 'session_expired' });
    for (const ws of this.sockets.values()) {
      if (ws.user && ws.user.userId === userId) {
        ws.user = null;
        ws.sessionId = null;
        ws.readOnly = true;
        if (ws.readyState === 1) {
          ws.send(payload);
        }
      }
    }
  }

  broadcastJson(obj) {
    if (this.sockets.size === 0) return;
    const payload = encodeJson(obj);
    for (const ws of this.sockets.values()) {
      if (ws.readyState === 1) {
        ws.send(payload);
      }
    }
  }

  async tickStatsAndPresence() {
    const localIds = [...this.sockets.keys()];
    const [online, boardStats] = await Promise.all([
      refreshPresenceAndInstance(localIds),
      getBoardStats(),
    ]);

    const checked = boardStats.checked;
    if (online !== this.lastStats.online || checked !== this.lastStats.checked) {
      this.lastStats = { online, checked };
      this.broadcastJson({
        t: 'stats',
        online,
        checked,
        seq: boardStats.seq,
      });
    }
  }
}

export async function getInitialWelcomeState() {
  const [online, boardStats] = await Promise.all([getOnlineCount(), getBoardStats()]);
  return {
    online,
    checked: boardStats.checked,
    seq: boardStats.seq,
  };
}

