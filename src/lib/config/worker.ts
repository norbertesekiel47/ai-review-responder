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
import { optionalVar, rawOptionalVar, requirePresent, requirePresentIn, requiredVar } from './schema-helpers';
import {
  STRIPE_REQUIRED_VARS,
  narrowStripeConfig,
  type StripeEnvConfig,
} from './stripe-shape';

const nonEmpty = requiredVar;
const opt = optionalVar;
// Raw passthrough for MIGRATED reads whose call site does its own normalization
// (!value / `envInterval ? parseInt`). Preserves ''/'   '/unset exactly like the
// old process.env.X (convention #7). Do NOT use the collapsing `opt` for these.
const rawOpt = rawOptionalVar;

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
  // Migrated raw read: worker/ingress/stripe.ts does `if (!webhookSecret)` on the
  // RAW value, so rawOptionalVar (not the collapsing opt) keeps the truthy check
  // byte-identical to the old process.env.STRIPE_WEBHOOK_SECRET (#7).
  // getWorkerStripeConfig/narrowStripeConfig still treat whitespace as absent.
  STRIPE_WEBHOOK_SECRET: rawOpt,
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
  // Migrated raw read: StripeLocationsReconcilePoller owns its own
  // `envInterval ? parseInt(envInterval, 10) : NaN` parse + default, so
  // rawOptionalVar preserves ''/'   '/unset exactly like the old raw read (#7).
  STRIPE_LOCATIONS_RECONCILE_INTERVAL_MS: rawOpt,
});

export type WorkerConfig = z.infer<typeof workerSchema>;

export const WORKER_REQUIRED_VARS = [
  'DATABASE_POOL_URL',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'REDIS_QUEUE_URL',
] as const;

let memo: WorkerConfig | undefined;

// Stage-2 foundation: the per-subsystem accessors/asserts below have no
// production consumer YET — Stage 3 migrates the raw worker process.env reads onto
// them in batches (wiring a subsystem assert before its subsystem uses
// getXConfig() would be premature). Suppress the "unused-export" finding until
// their batch consumes them. getWorkerConfig itself IS now consumed (Stage-3
// Stripe batch: worker/ingress/stripe.ts, StripeLocationsReconcilePoller.ts), so
// it carries no suppression.

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

/** Worker core-infra boot assert. Mirrors CORE_INFRA_REQUIRED_ENV. */
export function assertWorkerConfig(): void {
  ensureWorkerDotenvLoaded();
  if (mockSkip()) return;
  requirePresent(WORKER_REQUIRED_VARS, 'core-infra');
}

export type WorkerStripeConfig = StripeEnvConfig;

// fallow-ignore-next-line unused-export
export function assertWorkerStripeConfig(): void {
  requirePresent(STRIPE_REQUIRED_VARS, 'stripe');
}

export function getWorkerStripeConfig(): WorkerStripeConfig {
  return narrowStripeConfig(getWorkerConfig(), 'stripe');
}

// fallow-ignore-next-line unused-export
export function assertWorkerResendConfig(): void { requirePresent(['RESEND_API_KEY'], 'resend'); }
// fallow-ignore-next-line unused-export
export function getWorkerResendConfig(): { RESEND_API_KEY: string } {
  const cfg = getWorkerConfig();
  requirePresentIn(cfg, ['RESEND_API_KEY'], 'resend');
  return { RESEND_API_KEY: cfg.RESEND_API_KEY! };
}

// fallow-ignore-next-line unused-export
export function assertWorkerSerpapiConfig(): void { requirePresent(['SERPAPI_API_KEY'], 'serpapi'); }
// fallow-ignore-next-line unused-export
export function getWorkerSerpapiConfig(): { SERPAPI_API_KEY: string } {
  const cfg = getWorkerConfig();
  requirePresentIn(cfg, ['SERPAPI_API_KEY'], 'serpapi');
  return { SERPAPI_API_KEY: cfg.SERPAPI_API_KEY! };
}

// fallow-ignore-next-line unused-export
export function assertWorkerOpenAiConfig(): void { requirePresent(['OPENAI_API_KEY'], 'openai'); }
// fallow-ignore-next-line unused-export
export function getWorkerOpenAiConfig(): { OPENAI_API_KEY: string } {
  const cfg = getWorkerConfig();
  requirePresentIn(cfg, ['OPENAI_API_KEY'], 'openai');
  return { OPENAI_API_KEY: cfg.OPENAI_API_KEY! };
}

// fallow-ignore-next-line unused-export
export function assertWorkerAnthropicConfig(): void { requirePresent(['ANTHROPIC_API_KEY'], 'anthropic'); }
// fallow-ignore-next-line unused-export
export function getWorkerAnthropicConfig(): { ANTHROPIC_API_KEY: string } {
  const cfg = getWorkerConfig();
  requirePresentIn(cfg, ['ANTHROPIC_API_KEY'], 'anthropic');
  return { ANTHROPIC_API_KEY: cfg.ANTHROPIC_API_KEY! };
}
