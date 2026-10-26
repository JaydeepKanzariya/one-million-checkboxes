-- Sliding-window log WebSocket rate limiter with strike + temporary block escalation.
-- KEYS[1] = sorted set for user's sliding window (omc:rl:ws:user:<userId>)
-- KEYS[2] = strike counter key (omc:rl:strikes:<userId>)
-- KEYS[3] = active block key (omc:rl:block:<userId>)
-- KEYS[4] = cumulative block count key (omc:rl:blockcount:<userId>)
-- ARGV[1] = nowMs
-- ARGV[2] = windowMs
-- ARGV[3] = limit
-- ARGV[4] = unique member for ZADD
-- ARGV[5] = strikesToBlock
-- ARGV[6] = strikeWindowS
-- ARGV[7] = blockSeconds
--
-- Returns: { allowed (0|1), reason (0=ok, 1=rate, 2=blocked), value (remaining or retryAfterMs), strikes, blocks }

local nowMs = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]
local strikesToBlock = tonumber(ARGV[5])
local strikeWindowS = tonumber(ARGV[6])
local blockSeconds = tonumber(ARGV[7])

local blockTtl = redis.call('PTTL', KEYS[3])
if blockTtl > 0 then
  local blocks = tonumber(redis.call('GET', KEYS[4]) or '1')
  return { 0, 2, blockTtl, 0, blocks }
end

local minScore = nowMs - windowMs
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, minScore)
local count = redis.call('ZCARD', KEYS[1])

if count >= limit then
  local strikes = redis.call('INCR', KEYS[2])
  if strikes == 1 then
    redis.call('EXPIRE', KEYS[2], strikeWindowS)
  end

  if strikes >= strikesToBlock then
    redis.call('SET', KEYS[3], '1', 'EX', blockSeconds)
    redis.call('DEL', KEYS[2])
    local blocks = redis.call('INCR', KEYS[4])
    redis.call('EXPIRE', KEYS[4], blockSeconds * 10)
    return { 0, 2, blockSeconds * 1000, strikes, blocks }
  end

  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  local oldestScore = tonumber(oldest[2] or nowMs)
  local retryAfterMs = math.max(1, (oldestScore + windowMs) - nowMs)
  local blocks = tonumber(redis.call('GET', KEYS[4]) or '0')
  return { 0, 1, retryAfterMs, strikes, blocks }
end

redis.call('ZADD', KEYS[1], nowMs, member)
redis.call('PEXPIRE', KEYS[1], windowMs * 2)
local remaining = limit - count - 1
return { 1, 0, remaining, 0, 0 }

