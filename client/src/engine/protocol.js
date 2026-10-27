// Binary + JSON hybrid WebSocket wire protocol (browser ES module).
// Must stay in lockstep with server/realtime/protocol.js.

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
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (typeof input === 'string') {
    return new TextEncoder().encode(input);
  }
  throw new TypeError('Unsupported frame buffer type');
}

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

export function encodeJson(obj) {
  return JSON.stringify(obj);
}

export function decodeServerFrame(raw) {
  if (typeof raw === 'string') {
    return { type: 'json', message: JSON.parse(raw) };
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

