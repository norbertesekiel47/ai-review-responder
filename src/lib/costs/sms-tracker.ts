// src/lib/costs/sms-tracker.ts
//
// SMS cost guard. Per-business + global daily cents counters in Redis.
// Mirrors the LLM tracker pattern in ./tracker.ts (same Redis helper,
// same env-parse strictness, same INCRBY/DECRBY pipeline).
//
// reserveSmsCost returns the YYYY-MM-DD date used for the counters.
// Callers MUST pass that same date back to refundSmsCost to avoid
// midnight-boundary wrong-key refunds.

import { getCacheRedis } from '@/lib/db/redis-cache';

// ── Error classes ────────────────────────────────────────────────────

export class DailySmsLimitExceededError extends Error {
  constructor(public readonly scope: 'per_business' | 'global') {
    super(`sms_cap:${scope}`);
    this.name = 'DailySmsLimitExceededError';
  }
}

// ── Constants ────────────────────────────────────────────────────────

const SMS_SEND_COST_CENTS = 1;
const TTL_SECONDS = 86_400;

const DEFAULT_PER_BUSINESS_CAP_CENTS = 10;
const DEFAULT_GLOBAL_CAP_CENTS = 500;

// ── Redis key helpers ────────────────────────────────────────────────

function todayDateStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function perBusinessKey(businessId: string, dateStr: string): string {
  return `cost:sms:${businessId}:${dateStr}`;
}

function globalKey(dateStr: string): string {
  return `cost:sms:global:${dateStr}`;
}

// ── Env parsing (mirror of tracker.ts safeParseLimitCents) ───────────

function parseCentsEnv(envName: string, fallback: number): number {
  const raw = process.env[envName];
  if (raw === undefined || raw === null) return fallback;
  const trimmed = raw.trim();
  if (trimmed === '') return fallback;
  if (!/^\d+$/.test(trimmed)) {
    console.warn(
      `[sms-tracker] Invalid env ${envName}="${raw}" (must be a non-negative integer) — falling back to ${fallback}`,
    );
    return fallback;
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    console.warn(
      `[sms-tracker] Env ${envName}="${raw}" out of safe-integer range — falling back to ${fallback}`,
    );
    return fallback;
  }
  return parsed;
}

function getPerBusinessCapCents(): number {
  return parseCentsEnv('SMS_DAILY_LIMIT_CENTS_PER_BUSINESS', DEFAULT_PER_BUSINESS_CAP_CENTS);
}

function getGlobalCapCents(): number {
  return parseCentsEnv('SMS_DAILY_LIMIT_CENTS_GLOBAL', DEFAULT_GLOBAL_CAP_CENTS);
}

// ── Public API ───────────────────────────────────────────────────────

// INCRBY + cap check + TTL + rollback collapsed into one atomic Lua script,
// mirroring the RESERVE_COST_LUA pattern in ./tracker.ts. The separate-
// pipeline approach left a crash window between the INCRBYs and the EXPIRE
// that would leave fresh daily keys without a TTL until the next reserve.
// Return shape: { 'ok' | 'per_business' | 'global', bizTotal, globalTotal }
const RESERVE_SMS_LUA = `
local cost = tonumber(ARGV[1])
local bizCap = tonumber(ARGV[2])
local globalCap = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])

local bizTotal = redis.call('INCRBY', KEYS[1], cost)
local globalTotal = redis.call('INCRBY', KEYS[2], cost)

if bizTotal > bizCap then
  redis.call('DECRBY', KEYS[1], cost)
  redis.call('DECRBY', KEYS[2], cost)
  return {'per_business', bizTotal, globalTotal}
end

if globalTotal > globalCap then
  redis.call('DECRBY', KEYS[1], cost)
  redis.call('DECRBY', KEYS[2], cost)
  return {'global', bizTotal, globalTotal}
end

redis.call('EXPIRE', KEYS[1], ttl)
redis.call('EXPIRE', KEYS[2], ttl)
return {'ok', bizTotal, globalTotal}
`;

/**
 * Reserves 1¢ against both the per-business and global daily SMS budgets.
 * Returns the YYYY-MM-DD date string used for the keys — callers MUST pass
 * this same date to refundSmsCost to avoid midnight-boundary wrong-key refunds.
 *
 * On cap breach, both counters are atomically rolled back to their prior
 * values and a DailySmsLimitExceededError is thrown.
 */
export async function reserveSmsCost(businessId: string): Promise<string> {
  const redis = getCacheRedis();
  const dateStr = todayDateStr();
  const bKey = perBusinessKey(businessId, dateStr);
  const gKey = globalKey(dateStr);

  const perBizCap = getPerBusinessCapCents();
  const globalCap = getGlobalCapCents();

  const raw = (await redis.eval(
    RESERVE_SMS_LUA,
    2,
    bKey,
    gKey,
    String(SMS_SEND_COST_CENTS),
    String(perBizCap),
    String(globalCap),
    String(TTL_SECONDS),
  )) as [string, number, number];

  const status = raw[0];
  if (status === 'per_business') {
    throw new DailySmsLimitExceededError('per_business');
  }
  if (status === 'global') {
    throw new DailySmsLimitExceededError('global');
  }

  return dateStr;
}

/**
 * Refunds a previously reserved SMS cost. The caller MUST pass the date
 * string returned from the matching reserveSmsCost call; using today's
 * date instead would wrong-key the refund on midnight-boundary retries.
 */
export async function refundSmsCost(
  businessId: string,
  reservationDate: string,
): Promise<void> {
  const redis = getCacheRedis();
  await redis
    .pipeline()
    .decrby(perBusinessKey(businessId, reservationDate), SMS_SEND_COST_CENTS)
    .decrby(globalKey(reservationDate), SMS_SEND_COST_CENTS)
    .exec();
}
