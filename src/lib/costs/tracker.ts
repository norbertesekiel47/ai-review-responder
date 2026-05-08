import { getCacheRedis } from '@/lib/db/redis-cache';

// ── Error classes ────────────────────────────────────────────────────

export class CostLimitExceededError extends Error {
  constructor(public readonly businessId: string) {
    super(`Daily cost limit exceeded for business ${businessId}`);
    this.name = 'CostLimitExceededError';
  }
}

export class GlobalCostLimitExceededError extends Error {
  constructor() {
    super('Global daily cost limit exceeded');
    this.name = 'GlobalCostLimitExceededError';
  }
}

export class ConcurrencyLimitExceededError extends Error {
  constructor(public readonly businessId: string) {
    super(`Concurrency limit exceeded for business ${businessId}`);
    this.name = 'ConcurrencyLimitExceededError';
  }
}

export class RegenBudgetExceededError extends Error {
  constructor(public readonly reviewId: string) {
    super(`Regeneration budget exceeded for review ${reviewId}`);
    this.name = 'RegenBudgetExceededError';
  }
}

// ── Constants ────────────────────────────────────────────────────────

const PESSIMISTIC_ESTIMATE_CENTS = 15;
const MAX_CONCURRENCY_PER_BUSINESS = 3;
const MAX_REGEN_PER_REVIEW_PER_DAY = 3;
const CACHE_TTL_SECONDS = 86_400;
const CONCURRENCY_TTL_SECONDS = 300; // 5-minute safety net

const DEFAULT_TIER_LIMITS_CENTS: Record<string, number> = {
  founders: 500,
  standard: 1_000,
  premium: 2_000,
  // Legacy alias — DB may still contain 'founding' in some rows until
  // the sweep is complete. Once all rows are 'founders', remove this.
  founding: 500,
};

/**
 * Maps subscription tier values to their env-var suffixes.
 * The application-level tier is 'founders' (per SubscriptionTier.FOUNDERS),
 * but the historical env-var convention uses 'FOUNDING' as the suffix.
 */
const TIER_ENV_SUFFIX: Record<string, string> = {
  founders: 'FOUNDING',
  founding: 'FOUNDING',
  standard: 'STANDARD',
  premium: 'PREMIUM',
};

// ── Redis key helpers ────────────────────────────────────────────────

function todayDateStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function dailyBusinessKey(businessId: string, dateStr: string): string {
  return `cost:daily:${businessId}:${dateStr}`;
}

function dailyGlobalKey(dateStr: string): string {
  return `cost:global:${dateStr}`;
}

function concurrencyKey(businessId: string): string {
  return `gen:active:${businessId}`;
}

function idempotentCacheKey(reviewId: string, version: number): string {
  return `gen:${reviewId}:v${version}`;
}

function regenBudgetKey(reviewId: string): string {
  return `regen:${reviewId}:${todayDateStr()}`;
}

// ── Tier limit resolution ────────────────────────────────────────────

/**
 * Strict non-negative integer parse for cost-limit env vars.
 *
 * parseInt is too permissive: it accepts prefixes (`'1000abc'` → 1000),
 * truncates decimals (`'12.5'` → 12), and parses `'10_000'` as 10. Any of
 * those would silently apply the WRONG budget — someone copying a
 * JS-style numeric literal into `.env` could unknowingly cap limits at
 * an order of magnitude smaller than intended.
 *
 * This parser requires the value to be:
 *   - only decimal digits after trimming (no letters, dots, underscores)
 *   - a safe integer (fits in a JS number without precision loss)
 *   - non-negative
 * Any deviation falls back to the default and logs a warning so the
 * misconfiguration is visible in worker logs.
 */
function safeParseLimitCents(envVal: string | undefined, fallback: number): number {
  if (envVal === undefined || envVal === null) return fallback;
  const trimmed = envVal.trim();
  if (trimmed === '') return fallback;
  if (!/^\d+$/.test(trimmed)) {
    console.warn(
      `[cost-tracker] Invalid cost limit env var "${envVal}" (must be a non-negative integer) — falling back to ${fallback}`,
    );
    return fallback;
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    console.warn(
      `[cost-tracker] Cost limit env var "${envVal}" out of safe-integer range — falling back to ${fallback}`,
    );
    return fallback;
  }
  return parsed;
}

function getTierLimitCents(tier: string): number {
  const envSuffix = TIER_ENV_SUFFIX[tier] ?? tier.toUpperCase();
  const envKey = `DAILY_COST_LIMIT_CENTS_${envSuffix}`;
  const fallback = DEFAULT_TIER_LIMITS_CENTS[tier] ?? DEFAULT_TIER_LIMITS_CENTS.standard!;
  return safeParseLimitCents(process.env[envKey], fallback);
}

function getGlobalLimitCents(): number {
  return safeParseLimitCents(process.env.GLOBAL_DAILY_COST_LIMIT_CENTS, 10_000);
}

// ── Phase 1: Reservation ─────────────────────────────────────────────

export async function checkIdempotentCache(
  reviewId: string,
  version: number,
): Promise<string | null> {
  const redis = getCacheRedis();
  return redis.get(idempotentCacheKey(reviewId, version));
}

// INCR + limit check + TTL + rollback collapsed into one atomic Lua script.
// Separate commands (pipeline or not) left a crash window between INCRBY and
// EXPIRE that could leave daily budget keys TTL-less forever.
// Return shape: { status: 'ok' | 'biz_exceeded' | 'global_exceeded', biz, global }
const RESERVE_COST_LUA = `
local estimate = tonumber(ARGV[1])
local bizLimit = tonumber(ARGV[2])
local globalLimit = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])

local biz = redis.call('INCRBY', KEYS[1], estimate)
local glob = redis.call('INCRBY', KEYS[2], estimate)

if biz > bizLimit then
  redis.call('DECRBY', KEYS[1], estimate)
  redis.call('DECRBY', KEYS[2], estimate)
  return {'biz_exceeded', biz, glob}
end

if glob > globalLimit then
  redis.call('DECRBY', KEYS[1], estimate)
  redis.call('DECRBY', KEYS[2], estimate)
  return {'global_exceeded', biz, glob}
end

redis.call('EXPIRE', KEYS[1], ttl)
redis.call('EXPIRE', KEYS[2], ttl)
return {'ok', biz, glob}
`;

/**
 * Reserves pessimistic cost against daily budgets.
 * Returns the date string used for the keys — callers MUST pass this
 * same date to finalizeCost/releaseCost to avoid midnight boundary bugs.
 */
export async function reserveCost(
  businessId: string,
  subscriptionTier: string,
): Promise<string> {
  const redis = getCacheRedis();
  const dateStr = todayDateStr();
  const bizKey = dailyBusinessKey(businessId, dateStr);
  const globalKey = dailyGlobalKey(dateStr);
  const bizLimit = getTierLimitCents(subscriptionTier);
  const globalLimit = getGlobalLimitCents();

  const raw = (await redis.eval(
    RESERVE_COST_LUA,
    2,
    bizKey,
    globalKey,
    String(PESSIMISTIC_ESTIMATE_CENTS),
    String(bizLimit),
    String(globalLimit),
    String(CACHE_TTL_SECONDS),
  )) as [string, number, number];

  const status = raw[0];
  if (status === 'biz_exceeded') throw new CostLimitExceededError(businessId);
  if (status === 'global_exceeded') throw new GlobalCostLimitExceededError();

  return dateStr;
}

// INCR + limit check + TTL + rollback collapsed into one atomic Lua script.
// Same rationale as RESERVE_COST_LUA — prevents concurrency-slot keys
// from leaking past their TTL window after a mid-sequence crash.
const ACQUIRE_CONCURRENCY_LUA = `
local limit = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local cur = redis.call('INCR', KEYS[1])
if cur > limit then
  redis.call('DECR', KEYS[1])
  return {'exceeded', cur}
end
redis.call('EXPIRE', KEYS[1], ttl)
return {'ok', cur}
`;

export async function acquireConcurrencySlot(
  businessId: string,
): Promise<void> {
  const redis = getCacheRedis();
  const key = concurrencyKey(businessId);

  const raw = (await redis.eval(
    ACQUIRE_CONCURRENCY_LUA,
    1,
    key,
    String(MAX_CONCURRENCY_PER_BUSINESS),
    String(CONCURRENCY_TTL_SECONDS),
  )) as [string, number];

  if (raw[0] === 'exceeded') {
    throw new ConcurrencyLimitExceededError(businessId);
  }
}

// ── Phase 2: Finalization ────────────────────────────────────────────

// Paired INCRBYs in a Lua script so a crash cannot drift the per-business
// counter out of sync with the global counter. INCRBY accepts negative
// adjustments, so the same script handles both overshoot-refund and
// undershoot-topup paths.
const ADJUST_COST_LUA = `
local adjustment = tonumber(ARGV[1])
redis.call('INCRBY', KEYS[1], adjustment)
redis.call('INCRBY', KEYS[2], adjustment)
return 'ok'
`;

export async function finalizeCost(
  businessId: string,
  actualCostCents: number,
  reservationDate: string,
): Promise<void> {
  const redis = getCacheRedis();
  const adjustment = actualCostCents - PESSIMISTIC_ESTIMATE_CENTS;

  await redis.eval(
    ADJUST_COST_LUA,
    2,
    dailyBusinessKey(businessId, reservationDate),
    dailyGlobalKey(reservationDate),
    String(adjustment),
  );
}

export async function setCachedGeneration(
  reviewId: string,
  version: number,
  data: string,
): Promise<void> {
  const redis = getCacheRedis();
  await redis.set(
    idempotentCacheKey(reviewId, version),
    data,
    'EX',
    CACHE_TTL_SECONDS,
  );
}

export async function clearCachedGeneration(
  reviewId: string,
  version: number,
): Promise<void> {
  const redis = getCacheRedis();
  await redis.del(idempotentCacheKey(reviewId, version));
}

// ── Failure path ─────────────────────────────────────────────────────

export async function releaseCost(
  businessId: string,
  reservationDate: string,
): Promise<void> {
  const redis = getCacheRedis();
  // Release = negative adjustment equal to the pessimistic reservation,
  // routed through the same atomic Lua script as finalizeCost.
  await redis.eval(
    ADJUST_COST_LUA,
    2,
    dailyBusinessKey(businessId, reservationDate),
    dailyGlobalKey(reservationDate),
    String(-PESSIMISTIC_ESTIMATE_CENTS),
  );
}

export async function releaseConcurrencySlot(
  businessId: string,
): Promise<void> {
  const redis = getCacheRedis();
  const result = await redis.decr(concurrencyKey(businessId));
  if (result < 0) {
    await redis.set(concurrencyKey(businessId), '0');
  }
}

// ── Regeneration budget ──────────────────────────────────────────────

const REGEN_BUDGET_LUA = `
local limit = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local cur = redis.call('INCR', KEYS[1])
if cur == 1 then
  redis.call('EXPIRE', KEYS[1], ttl)
end
if cur > limit then
  redis.call('DECR', KEYS[1])
  return {'exceeded', cur}
end
return {'ok', cur}
`;

export async function checkRegenBudget(reviewId: string): Promise<void> {
  const redis = getCacheRedis();
  const key = regenBudgetKey(reviewId);
  const raw = (await redis.eval(
    REGEN_BUDGET_LUA,
    1,
    key,
    String(MAX_REGEN_PER_REVIEW_PER_DAY),
    String(CACHE_TTL_SECONDS),
  )) as [string, number];

  if (raw[0] === 'exceeded') {
    throw new RegenBudgetExceededError(reviewId);
  }
}
