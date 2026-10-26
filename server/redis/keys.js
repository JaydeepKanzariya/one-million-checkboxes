import { config } from '../config.js';

const p = config.redisPrefix;

export const keys = Object.freeze({
  board: `${p}:board`,
  boardSeq: `${p}:board:seq`,
  boardCount: `${p}:board:count`,
  boardLog: `${p}:board:log`,

  chUpdates: `${p}:ch:updates`,
  chControl: `${p}:ch:control`,

  session: (sid) => `${p}:sess:${sid}`,
  oidcState: (state) => `${p}:oidc:${state}`,
  userStats: (sub) => `${p}:user:${sub}:stats`,

  rlHttp: (scope, ip, windowId) => `${p}:rl:http:${scope}:${ip}:${windowId}`,
  rlWsUser: (userId) => `${p}:rl:ws:user:${userId}`,
  rlStrikes: (userId) => `${p}:rl:strikes:${userId}`,
  rlBlock: (userId) => `${p}:rl:block:${userId}`,
  rlBlockCount: (userId) => `${p}:rl:blockcount:${userId}`,
  rlConnIp: (ip) => `${p}:rl:conn:${ip}`,
  rlConnRate: (ip, windowId) => `${p}:rl:connrate:${ip}:${windowId}`,

  presence: `${p}:presence`,
  instances: `${p}:instances`,
  instance: (id) => `${p}:instance:${id}`,
});

