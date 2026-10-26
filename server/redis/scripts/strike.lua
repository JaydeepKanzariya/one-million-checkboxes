-- Atomic strike counter + block escalation in Redis.
-- KEYS[1] = strike counter key (omc:rl:strikes:<userId>)
-- KEYS[2] = active block key (omc:rl:block:<userId>)
-- KEYS[3] = cumulative block count key (omc:rl:blockcount:<userId>)
-- ARGV[1] = strikesToBlock
-- ARGV[2] = strikeWindowS
-- ARGV[3] = blockSeconds
--
-- Returns: { blocked (0|1), strikes, blocks, retryAfterMs }

local strikesToBlock = tonumber(ARGV[1])
local strikeWindowS = tonumber(ARGV[2])
local blockSeconds = tonumber(ARGV[3])

local blockTtl = redis.call('PTTL', KEYS[2])
if blockTtl > 0 then
  local blocks = tonumber(redis.call('GET', KEYS[3]) or '1')
  return { 1, 0, blocks, blockTtl }
end

local strikes = redis.call('INCR', KEYS[1])
if strikes == 1 then
  redis.call('EXPIRE', KEYS[1], strikeWindowS)
end

if strikes >= strikesToBlock then
  redis.call('SET', KEYS[2], '1', 'EX', blockSeconds)
  redis.call('DEL', KEYS[1])
  local blocks = redis.call('INCR', KEYS[3])
  redis.call('EXPIRE', KEYS[3], blockSeconds * 10)
  return { 1, strikes, blocks, blockSeconds * 1000 }
end

local blocks = tonumber(redis.call('GET', KEYS[3]) or '0')
return { 0, strikes, blocks, 1000 }

