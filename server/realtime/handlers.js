import { config } from '../config.js';
import { logger } from '../logger.js';
import { checkWsUserLimit, recordUserStrike } from '../ratelimit/wsLimiter.js';
import { getBoardStats, getReplaySince, setBit } from '../redis/board.js';
import {
   OP,
  REJECT_CODE,
  decodeClientFrame,
  encodeAck,
  encodeBatch,
  encodeJson,
  encodePong,
  encodeReject,
} from './protocol.js';

function sendBinary(ws, buf) {
  if (ws.readyState === 1) {
    ws.send(buf, { binary: true });
  }
}

function sendJson(ws, obj) {
  if (ws.readyState === 1) {
    ws.send(encodeJson(obj));
  }
}

export async function handleSocketMessage(ws, rawData, isBinary) {
  let decoded;
  if (!isBinary && typeof rawData === 'string') {
    decoded = decodeClientFrame(rawData, config.board.size);
  } else if (!isBinary && Buffer.isBuffer(rawData) && rawData[0] === OP.JSON) {
    decoded = decodeClientFrame(rawData, config.board.size);
  } else {
    decoded = decodeClientFrame(rawData, config.board.size);
  }

  if (decoded.type === 'ping') {
    sendBinary(ws, encodePong());
    return;
  }

  if (decoded.type === 'json') {
    await handleJsonControl(ws, decoded.message);
    return;
  }

  if (decoded.type === 'range') {
    sendBinary(ws, encodeReject(decoded.index, REJECT_CODE.RANGE));
    if (ws.user?.userId) {
      await recordUserStrike(ws.user.userId);
    }
    return;
  }

  if (decoded.type === 'invalid') {
    ws.invalidStrikes = (ws.invalidStrikes || 0) + 1;
    if (ws.user?.userId) {
      const strikeRes = await recordUserStrike(ws.user.userId);
      if (strikeRes.shouldClose) {
        ws.close(1008, 'Repeated rate limit violations');
        return;
      }
    }
    if (ws.invalidStrikes >= 5) {
      ws.close(1008, 'Malformed protocol frames');
    }
    return;
  }

  if (decoded.type === 'set') {
    await handleSetFrame(ws, decoded.index, decoded.value);
  }
}

async function handleJsonControl(ws, msg) {
  if (msg.t === 'hello') {
    const lastSeq = Number(msg.lastSeq);
    if (!Number.isInteger(lastSeq) || lastSeq <= 0) return;

    const { seq: currentSeq } = await getBoardStats();
    if (currentSeq <= lastSeq) return;

    const updates = await getReplaySince(lastSeq, currentSeq);
    if (updates === null) {
      sendJson(ws, { t: 'resync', seq: currentSeq });
    } else if (updates.length > 0) {
      sendBinary(ws, encodeBatch(updates[0].seq, updates));
    }
    return;
  }

  if (msg.t === 'ping') {
    sendBinary(ws, encodePong());
  }
}

async function handleSetFrame(ws, index, value) {
  // 1. Auth check
  if (!ws.user || ws.readOnly) {
    sendBinary(ws, encodeReject(index, REJECT_CODE.AUTH));
    return;
  }

  const userId = ws.user.userId;
  const now = Date.now();

  // Check cached block timer first before touching Redis
  if (ws.blockedUntil && now < ws.blockedUntil) {
    const retryAfterMs = ws.blockedUntil - now;
    sendBinary(ws, encodeReject(index, REJECT_CODE.BLOCKED));
    sendJson(ws, { t: 'limit', reason: 'blocked', retryAfterMs });
    return;
  }

  // 2. Per-socket in-memory token bucket
  const bucketRes = ws.bucket.consume(1, now);
  if (!bucketRes.allowed) {
    const strikeRes = await recordUserStrike(userId);
    if (strikeRes.blocked) {
      ws.blockedUntil = Date.now() + strikeRes.retryAfterMs;
      sendBinary(ws, encodeReject(index, REJECT_CODE.BLOCKED));
      sendJson(ws, { t: 'limit', reason: 'blocked', retryAfterMs: strikeRes.retryAfterMs });
      if (strikeRes.shouldClose) {
        ws.close(1008, 'Repeated rate limit blocks');
      }
      return;
    }
    sendBinary(ws, encodeReject(index, REJECT_CODE.RATE));
    sendJson(ws, { t: 'limit', reason: 'rate', retryAfterMs: bucketRes.retryAfterMs });
    return;
  }

  // 3. Per-user sliding window log in Redis
  const rlRes = await checkWsUserLimit(userId, now);
  if (!rlRes.allowed) {
    const code = rlRes.reason === 'blocked' ? REJECT_CODE.BLOCKED : REJECT_CODE.RATE;
    if (rlRes.reason === 'blocked') {
      ws.blockedUntil = Date.now() + rlRes.retryAfterMs;
    }
    sendBinary(ws, encodeReject(index, code));
    sendJson(ws, {
      t: 'limit',
      reason: rlRes.reason,
      retryAfterMs: rlRes.retryAfterMs,
    });
    if (rlRes.shouldClose) {
      logger.warn({ userId, socketId: ws.id }, 'closing socket after repeated blocks');
      ws.close(1008, 'Repeated rate limit blocks');
    }
    return;
  }

  // 4. Atomic toggle in Redis via toggle.lua
  const result = await setBit(index, value, userId);
  sendBinary(ws, encodeAck(index, value, result.seq));
}

