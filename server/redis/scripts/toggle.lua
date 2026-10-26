-- Atomic checkbox toggle + sequence increment + checked counter + Pub/Sub fan-out.
-- KEYS[1] = board bitmap key
-- KEYS[2] = sequence counter key
-- KEYS[3] = checked count key
-- KEYS[4] = replay stream key
-- KEYS[5] = user stats hash key (optional, may be '')
-- ARGV[1] = bit index (0 .. BOARD_SIZE-1)
-- ARGV[2] = desired bit value (0 or 1)
-- ARGV[3] = pub/sub updates channel
-- ARGV[4] = max replay stream length (0 disables XADD)
-- ARGV[5] = current timestamp in ms

local idx = tonumber(ARGV[1])
local val = tonumber(ARGV[2])
local channel = ARGV[3]
local maxLogLen = tonumber(ARGV[4]) or 0
local nowMs = ARGV[5]

local old = redis.call('SETBIT', KEYS[1], idx, val)
if old == val then
  local seq = tonumber(redis.call('GET', KEYS[2]) or '0')
  local count = tonumber(redis.call('GET', KEYS[3]) or '0')
  return { 0, seq, count }
end

local delta = (val == 1) and 1 or -1
local count = redis.call('INCRBY', KEYS[3], delta)
if count < 0 then
  redis.call('SET', KEYS[3], 0)
  count = 0
end

local seq = redis.call('INCR', KEYS[2])
local payload = tostring(seq) .. ':' .. tostring(idx) .. ':' .. tostring(val)

if maxLogLen > 0 then
  redis.call('XADD', KEYS[4], 'MAXLEN', '~', maxLogLen, '*', 's', seq, 'i', idx, 'v', val)
end

if KEYS[5] and KEYS[5] ~= '' then
  redis.call('HINCRBY', KEYS[5], 'toggles', 1)
  redis.call('HSET', KEYS[5], 'lastSeen', nowMs)
end

redis.call('PUBLISH', channel, payload)
return { 1, seq, count }

