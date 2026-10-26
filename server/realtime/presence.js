import { config } from '../config.js';
import { redis } from '../redis/client.js';
import { keys } from '../redis/keys.js';

const PRESENCE_STALE_MS = 65_000;
const INSTANCE_TTL_S = 15;

export async function registerPresence(socketId) {
  const now = Date.now();
  await redis.zadd(keys.presence, now, socketId);
}

export async function unregisterPresence(socketId) {
  try {
    await redis.zrem(keys.presence, socketId);
  } catch {
    // Ignore on shutdown
  }
}

export async function refreshPresenceAndInstance(localSocketIds) {
  const now = Date.now();
  const multi = redis.multi();

  if (localSocketIds.length > 0) {
    const args = [];
    for (const id of localSocketIds) {
      args.push(now, id);
    }
    multi.zadd(keys.presence, ...args);
  }

  multi.zremrangebyscore(keys.presence, 0, now - PRESENCE_STALE_MS);
  multi.set(
    keys.instance(config.instanceId),
    JSON.stringify({
      id: config.instanceId,
      sockets: localSocketIds.length,
      updatedAt: now,
    }),
    'EX',
    INSTANCE_TTL_S,
  );
  multi.zcard(keys.presence);

  const res = await multi.exec();
  const zcardIdx = localSocketIds.length > 0 ? 3 : 2;
  return Number(res?.[zcardIdx]?.[1] ?? localSocketIds.length);
}

export async function removeInstanceHeartbeat(localSocketIds = []) {
  try {
    const multi = redis.multi();
    if (localSocketIds.length > 0) {
      multi.zrem(keys.presence, ...localSocketIds);
    }
    multi.del(keys.instance(config.instanceId));
    await multi.exec();
  } catch {
    // Ignore on shutdown
  }
}

export async function getOnlineCount() {
  const now = Date.now();
  await redis.zremrangebyscore(keys.presence, 0, now - PRESENCE_STALE_MS);
  const count = await redis.zcard(keys.presence);
  return Number(count ?? 0);
}

export async function getActiveInstances() {
  const instanceKeys = await redis.keys(keys.instancePattern);
  if (!instanceKeys || instanceKeys.length === 0) {
    return [{ id: config.instanceId, sockets: 0 }];
  }
  const rawList = await redis.mget(instanceKeys);
  const instances = [];
  for (const item of rawList) {
    if (!item) continue;
    try {
      instances.push(JSON.parse(item));
    } catch {
      // Ignore malformed entry
    }
  }
  instances.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return instances;
}

