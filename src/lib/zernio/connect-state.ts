import { randomBytes } from 'node:crypto';

// ─── Shared Lua scripts ─────────────────────────────────────────────────

export const luaTokenCAS = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end`;

// Step E (connect/start): replace the placeholder marker JSON with the full
// oauth_in_progress marker, ONLY if the stored value still byte-matches the
// placeholder we wrote in Step C. Prevents clobbering a newer flow that
// raced in via cancel+restart while Step D's Zernio calls were in flight.
export const luaCASUpdate = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("set", KEYS[1], ARGV[2], "EX", ARGV[3])
  else
    return false
  end`;

// Step F (connect/start failure cleanup): delete the marker only if it's
// still byte-equal to the placeholder we wrote. If a newer flow has
// overwritten it, leave it alone.
export const luaCASDel = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end`;

export const luaCASToFinalizing = `
  local raw = redis.call("get", KEYS[1])
  if not raw then return -1 end
  local ok, p = pcall(cjson.decode, raw)
  if not ok then return -2 end
  if p.flowId ~= ARGV[1] then return 0 end
  if p.status ~= "oauth_in_progress" then return -3 end
  p.status = "finalizing"
  return redis.call("set", KEYS[1], cjson.encode(p), "EX", ARGV[2])
`;

export const luaCASRevertToOauth = `
  local raw = redis.call("get", KEYS[1])
  if not raw then return -1 end
  local ok, p = pcall(cjson.decode, raw)
  if not ok then return -2 end
  if p.flowId ~= ARGV[1] then return 0 end
  if p.status ~= "finalizing" then return -3 end
  p.status = "oauth_in_progress"
  return redis.call("set", KEYS[1], cjson.encode(p), "EX", ARGV[2])
`;

export const luaCASToFinalizeUnknown = `
  local raw = redis.call("get", KEYS[1])
  if not raw then return -1 end
  local ok, p = pcall(cjson.decode, raw)
  if not ok then return -2 end
  if p.flowId ~= ARGV[1] then return 0 end
  if p.status ~= "finalizing" then return -3 end
  p.status = "finalize_unknown"
  p.finalize_unknown_at = ARGV[3]
  return redis.call("set", KEYS[1], cjson.encode(p), "EX", ARGV[2])
`;

export const luaDeletePendingByFlowIdAnyStatus = `
  local raw = redis.call("get", KEYS[1])
  if not raw then return 0 end
  local ok, p = pcall(cjson.decode, raw)
  if not ok then return 0 end
  if p.flowId == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

export const luaCASCancel = `
  local raw = redis.call("get", KEYS[1])
  if not raw then return 0 end
  local ok, p = pcall(cjson.decode, raw)
  if not ok then return 0 end
  if p.flowId ~= ARGV[1] then return 0 end
  if p.status == "finalizing" then return -1 end
  if p.status == "finalize_unknown" then return -2 end
  return redis.call("del", KEYS[1])
`;

// ─── Key helpers ────────────────────────────────────────────────────────

export const pendingKey = (businessId: string) => `connect_pending:${businessId}`;
export const stateKey = (state: string) => `connect_state:${state}`;
export const locationsKey = (sessionId: string) => `connect_locations:${sessionId}`;
export const lockKey = (businessId: string) => `connect_lock:${businessId}`;
export const finalizeLockKey = (sessionId: string) => `connect_finalize:${sessionId}`;

export const generateFlowId = () => randomBytes(16).toString('hex');
export const generateState = () => randomBytes(32).toString('hex');
export const generateLockToken = () => randomBytes(16).toString('hex');
export const generateSessionId = () => randomBytes(16).toString('hex');
