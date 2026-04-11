import Redis from 'ioredis';
import type { RedisOptions } from 'ioredis';
import { v7 as uuidv7 } from 'uuid';
import { sql } from '@/lib/db/server';

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

// ── Model pricing ────────────────────────────────────────────────────

interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  'gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.60 },
  'claude-haiku-4-5-20251001': { inputPer1M: 0.80, outputPer1M: 4.00 },
};

export function calculateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) throw new Error(`Unknown model for pricing: ${model}`);

  const cost =
    (inputTokens / 1_000_000) * pricing.inputPer1M +
    (outputTokens / 1_000_000) * pricing.outputPer1M;

  return Math.round(cost * 1_000_000) / 1_000_000;
}

// ── Redis client (cache instance, NOT queue) ─────────────────────────
// Supports: redis://localhost:6379/0, rediss://host:6379, https://host.upstash.io

function getCacheRedisOptions(): RedisOptions {
  const url = process.env.REDIS_CACHE_URL!;
  const token = process.env.REDIS_CACHE_TOKEN;

  // Upstash REST URL → extract host and use Redis protocol over TLS
  if (url.startsWith('https://')) {
    return {
      host: new URL(url).hostname,
      port: 6379,
      password: token,
      tls: {},
      maxRetriesPerRequest: null,
    };
  }

  // Standard redis:// or rediss:// URL (local, Railway, or any Redis)
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port || '6379', 10),
    password: parsed.password || token || undefined,
    db: parsed.pathname ? parseInt(parsed.pathname.slice(1), 10) || 0 : 0,
    tls: parsed.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null,
  };
}

let _redis: Redis | null = null;

export function getCacheRedis(): Redis {
  if (!_redis) {
    _redis = new Redis(getCacheRedisOptions());
  }
  return _redis;
}

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

function getTierLimitCents(tier: string): number {
  const envKey = `DAILY_COST_LIMIT_CENTS_${tier.toUpperCase()}`;
  const envVal = process.env[envKey];
  if (envVal) return parseInt(envVal, 10);
  return DEFAULT_TIER_LIMITS_CENTS[tier] ?? DEFAULT_TIER_LIMITS_CENTS.standard!;
}

function getGlobalLimitCents(): number {
  return parseInt(process.env.GLOBAL_DAILY_COST_LIMIT_CENTS ?? '10000', 10);
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

// ── Audit trail ──────────────────────────────────────────────────────

/**
 * Inserts an api_costs audit row. Returns the row's UUID so the worker
 * can later call linkApiCostToResponse() after inserting the response row.
 */
export async function recordApiCost(params: {
  businessId: string;
  provider: string;
  endpoint: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  responseId: string | null;
}): Promise<string> {
  const id = uuidv7();
  await sql`
    INSERT INTO api_costs (id, business_id, provider, endpoint, input_tokens, output_tokens, cost_usd, response_id)
    VALUES (
      ${id},
      ${params.businessId},
      ${params.provider},
      ${params.endpoint},
      ${params.inputTokens},
      ${params.outputTokens},
      ${params.costUsd},
      ${params.responseId}
    )
  `;
  return id;
}

/**
 * Links an api_costs row to a response after the response row is inserted.
 * Called by the worker after generating + inserting the response in the same transaction.
 */
export async function linkApiCostToResponse(
  apiCostId: string,
  responseId: string,
): Promise<void> {
  await sql`
    UPDATE api_costs SET response_id = ${responseId} WHERE id = ${apiCostId}
  `;
}
