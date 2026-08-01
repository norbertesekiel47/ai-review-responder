import { getCacheRedis } from '@/lib/db/redis-cache';
import { getServerConfig } from '@/lib/config/server';
import { CostInfraUnavailableError } from './errors';
import type { SubscriptionTierValue } from '@/lib/accounts/tier-config';
import {
  optionalNonnegativeCostLimitCents,
  tierDailyCostLimitCents,
} from './tier-cost-limits';

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

export class RegenBudgetExceededError extends Error {
  /** The budgeted subject — a reviewId (reply door) or askId (ask door). */
  constructor(public readonly subjectId: string) {
    super(`Regeneration budget exceeded for ${subjectId}`);
    this.name = 'RegenBudgetExceededError';
  }
}

// ── Constants ────────────────────────────────────────────────────────

const PESSIMISTIC_ESTIMATE_CENTS = 15;
const MAX_REGEN_PER_SUBJECT_PER_DAY = 3;
const CACHE_TTL_SECONDS = 86_400;

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

function idempotentCacheKey(reviewId: string, version: number): string {
  return `gen:${reviewId}:v${version}`;
}

function regenBudgetKey(reviewId: string): string {
  return `regen:${reviewId}:${todayDateStr()}`;
}

/**
 * Per-logical-request charge marker for the ask regen door. Deliberately NOT
 * date-scoped: a retry that crosses UTC midnight is still the same paid
 * request.
 */
function askRegenChargeKey(askId: string, outboxId: string): string {
  return `regen:ask:${askId}:charge:${outboxId}`;
}

function askRegenBudgetKey(askId: string): string {
  return `regen:ask:${askId}:${todayDateStr()}`;
}

// ── Tier limit resolution ────────────────────────────────────────────

/**
 * Resolve the existing optional global ceiling. Missing or malformed values
 * retain its established fallback; this is deliberately distinct from the
 * required positive Copilot/Autopilot ceilings, which fail worker/server config
 * validation instead of inventing an amount.
 */
function getGlobalLimitCents(): number {
  return optionalNonnegativeCostLimitCents(
    getServerConfig().GLOBAL_DAILY_COST_LIMIT_CENTS,
    10_000,
  );
}

// ── Phase 1: Reservation ─────────────────────────────────────────────

export async function checkIdempotentCache(
  reviewId: string,
  version: number,
): Promise<string | null> {
  const redis = getCacheRedis();
  // A failed Redis round-trip here is infra, not a cache miss. Surfacing it as
  // a retryable CostInfraUnavailableError (rather than swallowing it as "no
  // cache, proceed") avoids a duplicate LLM call on the retry.
  try {
    return await redis.get(idempotentCacheKey(reviewId, version));
  } catch (err) {
    throw new CostInfraUnavailableError('checkIdempotentCache', { cause: err });
  }
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
 *
 * `estimateCents` (integer cents) defaults to the 15¢ reply-generation
 * pessimistic estimate; cheaper task lanes (e.g. solicitation asks, SPEC
 * 2026-07-28 §7.1) pass their own. Callers MUST pass the SAME estimate to
 * finalizeCost/releaseCost — a reserve/finalize mismatch silently leaks
 * daily budget (SPEC §7.2). withCostGuard carries it via its closure.
 */
export async function reserveCost(
  businessId: string,
  subscriptionTier: SubscriptionTierValue,
  estimateCents: number = PESSIMISTIC_ESTIMATE_CENTS,
): Promise<string> {
  const redis = getCacheRedis();
  const dateStr = todayDateStr();
  const bizKey = dailyBusinessKey(businessId, dateStr);
  const globalKey = dailyGlobalKey(dateStr);
  const bizLimit = tierDailyCostLimitCents(subscriptionTier);
  const globalLimit = getGlobalLimitCents();

  // Only the Redis round-trip is wrapped — a transport failure becomes a
  // retryable infra error. The biz/global budget checks below run AFTER a
  // successful eval and stay terminal (they are budget decisions, not infra).
  let raw: [string, number, number];
  try {
    raw = (await redis.eval(
      RESERVE_COST_LUA,
      2,
      bizKey,
      globalKey,
      String(estimateCents),
      String(bizLimit),
      String(globalLimit),
      String(CACHE_TTL_SECONDS),
    )) as [string, number, number];
  } catch (err) {
    throw new CostInfraUnavailableError('reserveCost', { cause: err });
  }

  const status = raw[0];
  if (status === 'biz_exceeded') throw new CostLimitExceededError(businessId);
  if (status === 'global_exceeded') throw new GlobalCostLimitExceededError();

  return dateStr;
}

// ── Phase 2: Finalization ────────────────────────────────────────────

// Paired INCRBYs in a Lua script so a crash cannot drift the per-business
// counter out of sync with the global counter. INCRBY accepts negative
// adjustments, so the same script handles both overshoot-refund and
// undershoot-topup paths.
const ADJUST_COST_LUA = `
local adjustment = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
redis.call('INCRBY', KEYS[1], adjustment)
redis.call('INCRBY', KEYS[2], adjustment)
redis.call('EXPIRE', KEYS[1], ttl)
redis.call('EXPIRE', KEYS[2], ttl)
return 'ok'
`;

export async function finalizeCost(
  businessId: string,
  actualCostCents: number,
  reservationDate: string,
  estimateCents: number = PESSIMISTIC_ESTIMATE_CENTS,
): Promise<void> {
  const redis = getCacheRedis();
  const adjustment = actualCostCents - estimateCents;

  await redis.eval(
    ADJUST_COST_LUA,
    2,
    dailyBusinessKey(businessId, reservationDate),
    dailyGlobalKey(reservationDate),
    String(adjustment),
    String(CACHE_TTL_SECONDS),
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
  estimateCents: number = PESSIMISTIC_ESTIMATE_CENTS,
): Promise<void> {
  const redis = getCacheRedis();
  // Release = negative adjustment equal to the reservation's estimate,
  // routed through the same atomic Lua script as finalizeCost.
  await redis.eval(
    ADJUST_COST_LUA,
    2,
    dailyBusinessKey(businessId, reservationDate),
    dailyGlobalKey(reservationDate),
    String(-estimateCents),
    String(CACHE_TTL_SECONDS),
  );
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

/**
 * Shared INCR-with-cap primitive behind both regen-budget doors. One
 * mechanism, two named entry points (the moderation/flags.ts precedent) —
 * the key alone decides which per-subject daily counter is charged.
 */
async function enforceRegenBudget(key: string, subjectId: string): Promise<void> {
  const redis = getCacheRedis();
  const raw = (await redis.eval(
    REGEN_BUDGET_LUA,
    1,
    key,
    String(MAX_REGEN_PER_SUBJECT_PER_DAY),
    String(CACHE_TTL_SECONDS),
  )) as [string, number];

  if (raw[0] === 'exceeded') {
    throw new RegenBudgetExceededError(subjectId);
  }
}

export async function checkRegenBudget(reviewId: string): Promise<void> {
  await enforceRegenBudget(regenBudgetKey(reviewId), reviewId);
}

/**
 * Per-ask daily regeneration cap for the solicitation ask lane (#628).
 * Same 3-per-day limit and terminal RegenBudgetExceededError as the review
 * door; the counter is keyed `regen:ask:{askId}:{date}` so review and ask
 * budgets never collide.
 *
 * Charged IDEMPOTENTLY per logical regeneration request: `outboxId` is the
 * request identity (BullMQ retries and watchdog re-drives replay the same
 * outbox row; a new owner-triggered regen is a new row), and a SET NX marker
 * makes every replay after the first free — N transient attempts consume one
 * unit, not N. The marker is claimed BEFORE the counter so two concurrent
 * processors of one outbox row cannot double-charge; the losing side of that
 * race (or a crash between marker and charge) undercharges by one, which is
 * the cost-guard's documented fail-open direction — never fail-closed.
 */
export async function checkAskRegenBudget(
  askId: string,
  outboxId: string,
): Promise<void> {
  const redis = getCacheRedis();
  const chargeKey = askRegenChargeKey(askId, outboxId);

  // Transport failures on either round-trip are RETRYABLE infrastructure
  // outages, not budget decisions: wrap as CostInfraUnavailableError so the
  // worker rethrows for BullMQ retry and the failed hook keeps the attempt
  // watchdog-eligible. Only RegenBudgetExceededError stays terminal (#255:
  // never reclassify a budget decision as infra, and vice versa).
  let claimed: string | null;
  try {
    claimed = await redis.set(chargeKey, '1', 'EX', CACHE_TTL_SECONDS, 'NX');
  } catch (err) {
    throw new CostInfraUnavailableError('checkAskRegenBudget', { cause: err });
  }
  if (claimed === null) return; // this logical regeneration already paid

  try {
    await enforceRegenBudget(askRegenBudgetKey(askId), askId);
  } catch (err) {
    if (err instanceof RegenBudgetExceededError) {
      // A refused claim must not stay marked as paid: release the marker so a
      // replay re-checks the budget instead of bypassing it. Best-effort — a
      // refusal completes the outbox row (no retry reads a stale marker) and
      // the marker ages out via TTL regardless.
      await redis.del(chargeKey).catch(() => undefined);
      throw err;
    }
    throw new CostInfraUnavailableError('checkAskRegenBudget', { cause: err });
  }
}

export interface RegenBudgetStatus {
  /** Regenerations already consumed for this review today (UTC). */
  used: number;
  /** Per-review daily cap (MAX_REGEN_PER_SUBJECT_PER_DAY). */
  limit: number;
  /** Regenerations still available today; 0 once the cap is reached. */
  remaining: number;
}

/**
 * Read-only snapshot of the per-review regeneration budget. Unlike
 * checkRegenBudget it does NOT increment the counter — it is a pure `GET`, so
 * surfacing "limit reached" to the owner consumes no budget and triggers no LLM
 * spend (issue #335). The authoritative gate stays worker-side in
 * checkRegenBudget; this is only for synchronous UX feedback before enqueueing.
 */
export async function peekRegenBudget(reviewId: string): Promise<RegenBudgetStatus> {
  const redis = getCacheRedis();
  const raw = await redis.get(regenBudgetKey(reviewId));
  const parsed = raw === null ? 0 : Number.parseInt(raw, 10);
  const used = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  const limit = MAX_REGEN_PER_SUBJECT_PER_DAY;
  return { used, limit, remaining: Math.max(0, limit - used) };
}
