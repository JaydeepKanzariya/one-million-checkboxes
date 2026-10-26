import crypto from 'node:crypto';
import { config } from '../config.js';
import { redis } from '../redis/client.js';
import { keys } from '../redis/keys.js';
import { parseCookies } from '../utils/cookies.js';

export async function createSession({ userId, name, email = '', picture = '' }) {
  const sid = crypto.randomBytes(32).toString('base64url');
  const session = {
    userId: String(userId),
    name: String(name || 'Anonymous'),
    email: String(email || ''),
    picture: String(picture || ''),
    createdAt: String(Date.now()),
  };

  const key = keys.session(sid);
  await redis
    .multi()
    .hset(key, session)
    .expire(key, config.session.ttlSeconds)
    .exec();

  return { sid, session: formatSession(session) };
}

export async function getSession(sid, { touch = true } = {}) {
  if (!sid || typeof sid !== 'string' || sid.length < 16 || sid.length > 128) {
    return null;
  }
  const key = keys.session(sid);
  const data = await redis.hgetall(key);
  if (!data || !data.userId) {
    return null;
  }
  if (touch) {
    await redis.expire(key, config.session.ttlSeconds);
  }
  return formatSession(data);
}

export async function getSessionFromCookieHeader(cookieHeader, options) {
  const cookies = parseCookies(cookieHeader);
  const sid = cookies[config.session.cookieName];
  if (!sid) return { sid: null, user: null };
  const user = await getSession(sid, options);
  return { sid: user ? sid : null, user };
}

export async function destroySession(sid) {
  if (!sid) return;
  await redis.del(keys.session(sid));
}

export async function getUserToggles(userId) {
  if (!userId) return 0;
  const val = await redis.hget(keys.userStats(userId), 'toggles');
  return Number(val ?? 0);
}

export function setSessionCookie(res, sid) {
  const parts = [
    `${config.session.cookieName}=${encodeURIComponent(sid)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${config.session.ttlSeconds}`,
  ];
  if (config.session.cookieSecure) {
    parts.push('Secure');
  }
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(res) {
  const parts = [
    `${config.session.cookieName}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (config.session.cookieSecure) {
    parts.push('Secure');
  }
  res.setHeader('Set-Cookie', parts.join('; '));
}

function formatSession(raw) {
  return {
    userId: raw.userId,
    name: raw.name,
    email: raw.email || '',
    picture: raw.picture || '',
    createdAt: Number(raw.createdAt || 0),
  };
}

