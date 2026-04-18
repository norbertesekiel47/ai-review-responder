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
  founding: 500,
  standard: 1_000,
  premium: 2_000,
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
 * parseInt can return NaN when the env var is malformed (e.g. set to "true"
 * or containing whitespace). Downstream comparisons like `total > NaN`
 * always return false — so a typo in an env var would SILENTLY DISABLE
 * the budget guardrail. Always validate and fall back to the default.
 */
function safeParseLimitCents(envVal: string | undefined, fallback: number): number {
  if (!envVal) return fallback;
  const parsed = parseInt(envVal, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(
      `[cost-tracker] Invalid cost limit env var "${envVal}" — falling back to ${fallback}`,
    );
    return fallback;
  }
  return parsed;
}

function getTierLimitCents(tier: string): number {
  const envKey = `DAILY_COST_LIMIT_CENTS_${tier.toUpperCase()}`;
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

  // Atomically increment both counters
  const pipeline = redis.pipeline();
  pipeline.incrby(bizKey, PESSIMISTIC_ESTIMATE_CENTS);
  pipeline.incrby(globalKey, PESSIMISTIC_ESTIMATE_CENTS);
  const results = await pipeline.exec();

  const bizTotal = results![0]![1] as number;
  const globalTotal = results![1]![1] as number;

  // Check per-business limit
  const bizLimit = getTierLimitCents(subscriptionTier);
  if (bizTotal > bizLimit) {
    await redis
      .pipeline()
      .decrby(bizKey, PESSIMISTIC_ESTIMATE_CENTS)
      .decrby(globalKey, PESSIMISTIC_ESTIMATE_CENTS)
      .exec();
    throw new CostLimitExceededError(businessId);
  }

  // Check global limit
  if (globalTotal > getGlobalLimitCents()) {
    await redis
      .pipeline()
      .decrby(bizKey, PESSIMISTIC_ESTIMATE_CENTS)
      .decrby(globalKey, PESSIMISTIC_ESTIMATE_CENTS)
      .exec();
    throw new GlobalCostLimitExceededError();
  }

  // Set TTL on both keys so they auto-expire at end of day
  await redis
    .pipeline()
    .expire(bizKey, CACHE_TTL_SECONDS)
    .expire(globalKey, CACHE_TTL_SECONDS)
    .exec();

  return dateStr;
}

export async function acquireConcurrencySlot(
  businessId: string,
): Promise<void> {
  const redis = getCacheRedis();
  const key = concurrencyKey(businessId);
  const current = await redis.incr(key);
  await redis.expire(key, CONCURRENCY_TTL_SECONDS);

  if (current > MAX_CONCURRENCY_PER_BUSINESS) {
    await redis.decr(key);
    throw new ConcurrencyLimitExceededError(businessId);
  }
}

// ── Phase 2: Finalization ────────────────────────────────────────────

export async function finalizeCost(
  businessId: string,
  actualCostCents: number,
  reservationDate: string,
): Promise<void> {
  const redis = getCacheRedis();
  const adjustment = actualCostCents - PESSIMISTIC_ESTIMATE_CENTS;

  await redis
    .pipeline()
    .incrby(dailyBusinessKey(businessId, reservationDate), adjustment)
    .incrby(dailyGlobalKey(reservationDate), adjustment)
    .exec();
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

// ── Failure path ─────────────────────────────────────────────────────

export async function releaseCost(
  businessId: string,
  reservationDate: string,
): Promise<void> {
  const redis = getCacheRedis();
  await redis
    .pipeline()
    .decrby(dailyBusinessKey(businessId, reservationDate), PESSIMISTIC_ESTIMATE_CENTS)
    .decrby(dailyGlobalKey(reservationDate), PESSIMISTIC_ESTIMATE_CENTS)
    .exec();
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

export async function checkRegenBudget(reviewId: string): Promise<void> {
  const redis = getCacheRedis();
  const key = regenBudgetKey(reviewId);
  const count = await redis.incr(key);
  await redis.expire(key, CACHE_TTL_SECONDS);

  if (count > MAX_REGEN_PER_REVIEW_PER_DAY) {
    await redis.decr(key);
    throw new RegenBudgetExceededError(reviewId);
  }
}
