import { decodeServerFrame, encodeJson, encodePing, encodeSet } from './protocol.js';

export class RealtimeSocket {
  constructor(handlers) {
    this.handlers = handlers;
    this.ws = null;
    this.lastSeq = 0;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.hasConnectedOnce = false;
    this.closedIntentionally = false;
  }

  connect() {
    this.closedIntentionally = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${window.location.host}/ws`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.addEventListener('open', () => {
      const wasReconnect = this.hasConnectedOnce;
      this.hasConnectedOnce = true;
      this.reconnectAttempts = 0;

      if (this.lastSeq > 0) {
        ws.send(encodeJson({ t: 'hello', lastSeq: this.lastSeq }));
      }

      this.startHeartbeat();
      this.handlers.onOpen?.({ wasReconnect });
    });

    ws.addEventListener('message', (event) => {
      try {
        const frame = decodeServerFrame(event.data);
        if (frame.type === 'ack') {
          if (frame.seq > this.lastSeq) this.lastSeq = frame.seq;
          this.handlers.onAck?.(frame);
        } else if (frame.type === 'batch') {
          const endSeq = frame.fromSeq + frame.items.length - 1;
          if (endSeq > this.lastSeq) this.lastSeq = endSeq;
          this.handlers.onBatch?.(frame);
        } else if (frame.type === 'reject') {
          this.handlers.onReject?.(frame);
        } else if (frame.type === 'json') {
          const msg = frame.message;
          if (typeof msg.seq === 'number' && msg.seq > this.lastSeq) {
            this.lastSeq = msg.seq;
          }
          this.handlers.onJson?.(msg);
        }
      } catch (err) {
        console.error('Failed to decode frame', err);
      }
    });

    ws.addEventListener('close', (event) => {
      this.stopHeartbeat();
      this.handlers.onClose?.(event);
      if (!this.closedIntentionally) {
        this.scheduleReconnect();
      }
    });

    ws.addEventListener('error', () => {
      // Close handler will trigger backoff reconnect
    });
  }

  sendSet(index, value) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.ws.send(encodeSet(index, value));
    return true;
  }

  setLastSeq(seq) {
    if (seq > this.lastSeq) {
      this.lastSeq = seq;
    }
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(encodePing());
      }
    }, 25_000);
  }

  stopHeartbeat() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    // 0.5s -> 1s -> 2s -> 4s -> max 10s with jitter
    const baseMs = Math.min(10_000, 500 * Math.pow(2, this.reconnectAttempts));
    const jitterMs = Math.floor(Math.random() * 250);
    const delayMs = Math.min(10_000, baseMs + jitterMs);
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }

  close() {
    this.closedIntentionally = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

