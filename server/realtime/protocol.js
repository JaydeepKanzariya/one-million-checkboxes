// Binary + JSON hybrid WebSocket wire protocol.
// Shared constants and layout with public/js/protocol.js.

export const OP = Object.freeze({
  SET: 0x01,
  PING: 0x02,
  JSON: 0x7b, // '{'

  ACK: 0x81,
  BATCH: 0x82,
  REJECT: 0x83,
  PONG: 0x84,
});

export const REJECT_CODE = Object.freeze({
  AUTH: 1,
  RATE: 2,
  RANGE: 3,
  BLOCKED: 4,
});

function toUint8Array(input) {
  if (input instanceof Uint8Array) return input;
  if ( input instanceof ArrayBuffer ) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (typeof input === 'string') {
    return new TextEncoder().encode(input);
  }
  throw new TypeError('Unsupported frame buffer type');
}

// Client -> Server encoders
export function encodeSet(index, value) {
  const buf = new Uint8Array(6);
  const view = new DataView(buf.buffer);
  view.setUint8(0, OP.SET);
  view.setUint32(1, index >>> 0, false);
  view.setUint8(5, value ? 1 : 0);
  return buf;
}

export function encodePing() {
  return new Uint8Array([OP.PING]);
}

// Server -> Client encoders
export function encodeAck(index, value, seq) {
  const buf = new Uint8Array(10);
  const view = new DataView(buf.buffer);
  view.setUint8(0, OP.ACK);
  view.setUint32(1, index >>> 0, false);
  view.setUint8(5, value ? 1 : 0);
  view.setUint32(6, seq >>> 0, false);
  return buf;
}

export function encodeBatch(fromSeq, items) {
  const count = Math.min(0xffff, items.length);
  const buf = new Uint8Array(7 + count * 5);
  const view = new DataView(buf.buffer);
  view.setUint8(0, OP.BATCH);
  view.setUint32(1, fromSeq >>> 0, false);
  view.setUint16(5, count, false);
  let offset = 7;
  for (let i = 0; i < count; i++) {
    const item = items[i];
    view.setUint32(offset, item.index >>> 0, false);
    view.setUint8(offset + 4, item.value ? 1 : 0);
    offset += 5;
  }
  return buf;
}

export function encodeReject(index, code) {
  const buf = new Uint8Array(6);
  const view = new DataView(buf.buffer);
  view.setUint8(0, OP.REJECT);
  view.setUint32(1, index >>> 0, false);
  view.setUint8(5, code & 0xff);
  return buf;
}

export function encodePong() {
  return new Uint8Array([OP.PONG]);
}

export function encodeJson(obj) {
  return JSON.stringify(obj);
}

// Decodes a Client -> Server frame.
// Returns { type: 'set'|'ping'|'json'|'invalid', ... }
export function decodeClientFrame(raw, boardSize = 1_000_000) {
  const bytes = toUint8Array(raw);
  if (bytes.byteLength === 0) {
    return { type: 'invalid', reason: 'empty_frame' };
  }

  const op = bytes[0];

  if (op === OP.SET) {
    if (bytes.byteLength !== 6) {
      return { type: 'invalid', reason: 'bad_set_length' };
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const index = view.getUint32(1, false);
    const value = view.getUint8(5);
    if (value !== 0 && value !== 1) {
      return { type: 'invalid', reason: 'bad_value', index };
    }
    if (index >= boardSize) {
      return { type: 'range', index, value };
    }
    return { type: 'set', index, value };
  }

  if (op === OP.PING) {
    if (bytes.byteLength !== 1) {
      return { type: 'invalid', reason: 'bad_ping_length' };
    }
    return { type: 'ping' };
  }

  if (op === OP.JSON) {
    try {
      const text = new TextDecoder().decode(bytes);
      const data = JSON.parse(text);
      if (!data || typeof data !== 'object' || typeof data.t !== 'string') {
        return { type: 'invalid', reason: 'bad_json_shape' };
      }
      return { type: 'json', message: data };
    } catch {
      return { type: 'invalid', reason: 'malformed_json' };
    }
  }

  return { type: 'invalid', reason: 'unknown_opcode', op };
}

// Decodes a Server -> Client frame (used by client and tests).
export function decodeServerFrame(raw) {
  if (typeof raw === 'string') {
    const data = JSON.parse(raw);
    return { type: 'json', message: data };
  }
  const bytes = toUint8Array(raw);
  if (bytes.byteLength === 0) {
    return { type: 'invalid', reason: 'empty_frame' };
  }

  const op = bytes[0];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (op === OP.ACK) {
    if (bytes.byteLength !== 10) return { type: 'invalid', reason: 'bad_ack_length' };
    return {
      type: 'ack',
      index: view.getUint32(1, false),
      value: view.getUint8(5),
      seq: view.getUint32(6, false),
    };
  }

  if (op === OP.BATCH) {
    if (bytes.byteLength < 7) return { type: 'invalid', reason: 'bad_batch_header' };
    const fromSeq = view.getUint32(1, false);
    const count = view.getUint16(5, false);
    if (bytes.byteLength !== 7 + count * 5) {
      return { type: 'invalid', reason: 'bad_batch_length' };
    }
    const items = new Array(count);
    let offset = 7;
    for (let i = 0; i < count; i++) {
      items[i] = {
        index: view.getUint32(offset, false),
        value: view.getUint8(offset + 4),
      };
      offset += 5;
    }
    return { type: 'batch', fromSeq, items };
  }

  if (op === OP.REJECT) {
    if (bytes.byteLength !== 6) return { type: 'invalid', reason: 'bad_reject_length' };
    return {
      type: 'reject',
      index: view.getUint32(1, false),
      code: view.getUint8(5),
    };
  }

  if (op === OP.PONG) {
    if (bytes.byteLength !== 1) return { type: 'invalid', reason: 'bad_pong_length' };
    return { type: 'pong' };
  }

  if (op === OP.JSON) {
    const text = new TextDecoder().decode(bytes);
    return { type: 'json', message: JSON.parse(text) };
  }

  return { type: 'invalid', reason: 'unknown_opcode', op };
}

