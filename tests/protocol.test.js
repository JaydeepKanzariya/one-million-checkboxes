import { describe, expect, it } from 'vitest';
import * as clientProto from '../client/src/engine/protocol.js';
import { BitSet } from '../client/src/engine/bitset.js';
import * as serverProto from '../server/realtime/protocol.js';

describe('WebSocket binary + JSON protocol', () => {
  it('keeps client and server opcodes and reject codes identical', () => {
    expect(clientProto.OP).toEqual(serverProto.OP);
    expect(clientProto.REJECT_CODE).toEqual(serverProto.REJECT_CODE);
  });

  it('round-trips SET frames and validates range/value', () => {
    const frame = clientProto.encodeSet(523417, 1);
    expect(frame.byteLength).toBe(6);

    const decoded = serverProto.decodeClientFrame(frame, 1_000_000);
    expect(decoded).toEqual({ type: 'set', index: 523417, value: 1 });

    const outOfRange = clientProto.encodeSet(1_000_000, 1);
    expect(serverProto.decodeClientFrame(outOfRange, 1_000_000)).toEqual({
      type: 'range',
      index: 1_000_000,
      value: 1,
    });

    const badValue = new Uint8Array([serverProto.OP.SET, 0, 0, 0, 5, 2]);
    expect(serverProto.decodeClientFrame(badValue, 1_000_000).type).toBe('invalid');
  });

  it('round-trips PING and PONG frames', () => {
    const ping = clientProto.encodePing();
    expect(serverProto.decodeClientFrame(ping)).toEqual({ type: 'ping' });

    const pong = serverProto.encodePong();
    expect(clientProto.decodeServerFrame(pong)).toEqual({ type: 'pong' });
  });

  it('round-trips ACK, REJECT and BATCH frames', () => {
    const ack = serverProto.encodeAck(999_999, 1, 42);
    expect(clientProto.decodeServerFrame(ack)).toEqual({
      type: 'ack',
      index: 999_999,
      value: 1,
      seq: 42,
    });

    const reject = serverProto.encodeReject(123, serverProto.REJECT_CODE.RATE);
    expect(clientProto.decodeServerFrame(reject)).toEqual({
      type: 'reject',
      index: 123,
      code: serverProto.REJECT_CODE.RATE,
    });

    const items = [
      { index: 0, value: 1 },
      { index: 523417, value: 1 },
      { index: 999999, value: 0 },
    ];
    const batch = serverProto.encodeBatch(100, items);
    expect(batch.byteLength).toBe(7 + 3 * 5);
    expect(clientProto.decodeServerFrame(batch)).toEqual({
      type: 'batch',
      fromSeq: 100,
      items,
    });
  });

  it('rejects malformed frames and unknown opcodes', () => {
    expect(serverProto.decodeClientFrame(new Uint8Array([])).type).toBe('invalid');
    expect(serverProto.decodeClientFrame(new Uint8Array([0x01, 0x00])).type).toBe('invalid');
    expect(serverProto.decodeClientFrame(new Uint8Array([0xff, 0x01])).type).toBe('invalid');
    expect(serverProto.decodeClientFrame('{not json').type).toBe('invalid');
  });

  it('matches Redis MSB-first bit ordering in BitSet', () => {
    const bs = new BitSet(16);
    expect(bs.set(0, 1)).toBe(true);
    expect(bs.bytes[0]).toBe(0b10000000);
    expect(bs.get(0)).toBe(1);
    expect(bs.checkedCount).toBe(1);

    expect(bs.set(7, 1)).toBe(true);
    expect(bs.bytes[0]).toBe(0b10000001);
    expect(bs.checkedCount).toBe(2);

    // Setting same value is a no-op
    expect(bs.set(7, 1)).toBe(false);
    expect(bs.checkedCount).toBe(2);

    expect(bs.set(0, 0)).toBe(true);
    expect(bs.checkedCount).toBe(1);
  });
});

