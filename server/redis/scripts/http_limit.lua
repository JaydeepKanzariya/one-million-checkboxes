-- Fixed-window HTTP rate limiter.
-- KEYS[1] = window counter key
-- ARGV[1] = max requests allowed in window
-- ARGV[2] = expiry in seconds (window + 1)
-- Returns: { allowed (0|1), currentCount, ttlMs }

local limit = tonumber(ARGV[1])
local ttlSeconds = tonumber(ARGV[2])

local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ttlSeconds)
end

local ttlMs = redis.call('PTTL', KEYS[1])
if ttlMs < 0 then
  ttlMs = ttlSeconds * 1000
end

local allowed = (current <= limit) and 1 or 0
return { allowed, current, ttlMs }

