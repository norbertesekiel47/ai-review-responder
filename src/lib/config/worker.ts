// src/lib/config/worker.ts
//
// WORKER lane — Railway worker-process env. Self-loads .env.local before the
// first parse so a worker module imported outside worker/index.ts can't parse an
// empty env. Root schema is shape-only; getWorkerConfig is lazy + memoized.
// assertWorkerConfig mirrors worker/config/startup-assert.ts CORE_INFRA_REQUIRED_ENV
// (no more) so no env that boots today newly fails.
import { z } from 'zod';
import { STRIPE_PRICE_ENV_VARS } from '@/lib/payments/price-tier-map';
import { ensureWorkerDotenvLoaded } from './dotenv-load';
import { optionalVar, requiredVar } from './schema-helpers';

const nonEmpty = requiredVar;
const opt = optionalVar;

const stripePriceShape = Object.fromEntries(
  STRIPE_PRICE_ENV_VARS.map((name) => [name, opt]),
) as Record<(typeof STRIPE_PRICE_ENV_VARS)[number], typeof opt>;

const workerSchema = z.object({
  DATABASE_POOL_URL: nonEmpty,
  SUPABASE_URL: nonEmpty,
  SUPABASE_SERVICE_KEY: nonEmpty,
  REDIS_QUEUE_URL: nonEmpty,
  // subsystem secrets (optional)
  STRIPE_SECRET_KEY: opt,
  STRIPE_WEBHOOK_SECRET: opt,
  ...stripePriceShape,
  RESEND_API_KEY: opt,
  SERPAPI_API_KEY: opt,
  OPENAI_API_KEY: opt,
  ANTHROPIC_API_KEY: opt,
  // shape-only optionals (presence owned by startup-assert.ts this Stage)
  REDIS_CACHE_URL: opt,
  ADMIN_NOTIFICATION_EMAIL: opt,
  SENTRY_DSN: opt,
  WORKER_PUBLIC_URL: opt,
  DATABASE_URL: opt,
});

export type WorkerConfig = z.infer<typeof workerSchema>;

export const WORKER_REQUIRED_VARS = [
  'DATABASE_POOL_URL',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'REDIS_QUEUE_URL',
] as const;

let memo: WorkerConfig | undefined;

/** Lazy, memoized parse — self-loads dotenv first. NEVER at import time. */
export function getWorkerConfig(): WorkerConfig {
  if (!memo) {
    ensureWorkerDotenvLoaded();
    memo = workerSchema.parse(process.env);
  }
  return memo;
}

// Same carve-out as assertCoreInfraEnv: a no-op only in non-prod MOCK mode.
function mockSkip(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.MOCK_EXTERNAL_APIS === 'true';
}

function requirePresent(vars: readonly string[], subsystem: string): void {
  const missing = vars.filter((name) => {
    const value = process.env[name];
    return value === undefined || value.trim().length === 0;
  });
  if (missing.length > 0) {
    throw new Error(`[config] worker ${subsystem} requires: ${missing.join(', ')}`);
  }
}

/** Worker core-infra boot assert. Mirrors CORE_INFRA_REQUIRED_ENV. */
export function assertWorkerConfig(): void {
  ensureWorkerDotenvLoaded();
  if (mockSkip()) return;
  requirePresent(WORKER_REQUIRED_VARS, 'core-infra');
}

const STRIPE_WORKER_VARS = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  ...STRIPE_PRICE_ENV_VARS,
] as const;

export interface WorkerStripeConfig {
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_PRICE_BASIC: string;
  STRIPE_PRICE_FOUNDING: string;
  STRIPE_PRICE_STANDARD: string;
  STRIPE_PRICE_PREMIUM: string;
  STRIPE_PRICE_STANDARD_OVERAGE: string;
  STRIPE_PRICE_PREMIUM_OVERAGE: string;
  STRIPE_PRICE_FOUNDERS_OVERAGE: string;
}

export function assertWorkerStripeConfig(): void {
  requirePresent(STRIPE_WORKER_VARS, 'stripe');
}

// Each `!` is guarded by the preceding assertWorkerStripeConfig() throw.
export function getWorkerStripeConfig(): WorkerStripeConfig {
  assertWorkerStripeConfig();
  const cfg = getWorkerConfig();
  return {
    STRIPE_SECRET_KEY: cfg.STRIPE_SECRET_KEY!,
    STRIPE_WEBHOOK_SECRET: cfg.STRIPE_WEBHOOK_SECRET!,
    STRIPE_PRICE_BASIC: cfg.STRIPE_PRICE_BASIC!,
    STRIPE_PRICE_FOUNDING: cfg.STRIPE_PRICE_FOUNDING!,
    STRIPE_PRICE_STANDARD: cfg.STRIPE_PRICE_STANDARD!,
    STRIPE_PRICE_PREMIUM: cfg.STRIPE_PRICE_PREMIUM!,
    STRIPE_PRICE_STANDARD_OVERAGE: cfg.STRIPE_PRICE_STANDARD_OVERAGE!,
    STRIPE_PRICE_PREMIUM_OVERAGE: cfg.STRIPE_PRICE_PREMIUM_OVERAGE!,
    STRIPE_PRICE_FOUNDERS_OVERAGE: cfg.STRIPE_PRICE_FOUNDERS_OVERAGE!,
  };
}

export function assertWorkerResendConfig(): void { requirePresent(['RESEND_API_KEY'], 'resend'); }
export function getWorkerResendConfig(): { RESEND_API_KEY: string } {
  assertWorkerResendConfig();
  return { RESEND_API_KEY: getWorkerConfig().RESEND_API_KEY! };
}

export function assertWorkerSerpapiConfig(): void { requirePresent(['SERPAPI_API_KEY'], 'serpapi'); }
export function getWorkerSerpapiConfig(): { SERPAPI_API_KEY: string } {
  assertWorkerSerpapiConfig();
  return { SERPAPI_API_KEY: getWorkerConfig().SERPAPI_API_KEY! };
}

export function assertWorkerOpenAiConfig(): void { requirePresent(['OPENAI_API_KEY'], 'openai'); }
export function getWorkerOpenAiConfig(): { OPENAI_API_KEY: string } {
  assertWorkerOpenAiConfig();
  return { OPENAI_API_KEY: getWorkerConfig().OPENAI_API_KEY! };
}

export function assertWorkerAnthropicConfig(): void { requirePresent(['ANTHROPIC_API_KEY'], 'anthropic'); }
export function getWorkerAnthropicConfig(): { ANTHROPIC_API_KEY: string } {
  assertWorkerAnthropicConfig();
  return { ANTHROPIC_API_KEY: getWorkerConfig().ANTHROPIC_API_KEY! };
}
