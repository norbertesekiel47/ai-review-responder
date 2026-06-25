// src/lib/config/server.ts
//
// SERVER lane — Next.js server-process env. Root schema is SHAPE-ONLY: the six
// core-app vars (asserted at instrumentation register()) are required; every
// subsystem secret is .optional() so an innocent getServerConfig() in a UI-only
// preview never throws. A subsystem's secrets are asserted + narrowed to non-null
// ONLY by that subsystem's accessor. No top-level z.parse — getServerConfig is
// lazy + memoized.
import { z } from 'zod';
import { STRIPE_PRICE_ENV_VARS } from '@/lib/payments/price-tier-map';

const nonEmpty = z.string().min(1);
const opt = z.string().min(1).optional();

// Build the Stripe price fields (optional in the root) from the single owner list.
const stripePriceShape = Object.fromEntries(
  STRIPE_PRICE_ENV_VARS.map((name) => [name, opt]),
) as Record<(typeof STRIPE_PRICE_ENV_VARS)[number], typeof opt>;

const serverSchema = z.object({
  // ── core-app required ──
  NEXT_PUBLIC_SUPABASE_URL: nonEmpty,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: nonEmpty,
  NEXT_PUBLIC_APP_URL: nonEmpty,
  SUPABASE_URL: nonEmpty,
  SUPABASE_SERVICE_KEY: nonEmpty,
  DATABASE_POOL_URL: nonEmpty,
  // ── subsystem secrets (optional) ──
  STRIPE_SECRET_KEY: opt,
  STRIPE_WEBHOOK_SECRET: opt,
  ...stripePriceShape,
  RESEND_API_KEY: opt,
  SERPAPI_API_KEY: opt,
  OPENAI_API_KEY: opt,
  NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: opt,
  // ── shape-only optionals (not asserted this Stage) ──
  DATABASE_URL: opt,
  REDIS_CACHE_URL: opt,
  SENTRY_DSN: opt,
  NEXT_PUBLIC_SENTRY_DSN: opt,
  NEXT_PUBLIC_DOCS_BASE_URL: opt,
  SESSION_COOKIE_SECRET: opt,
  CSRF_SECRET: opt,
  IMPERSONATION_COOKIE_SECRET: opt,
  CONTACT_NOTIFY_TO: opt,
  WORKER_PUBLIC_URL: opt,
  DB_POOL_MAX: opt,
});

export type ServerConfig = z.infer<typeof serverSchema>;

export const CORE_APP_REQUIRED_VARS = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'NEXT_PUBLIC_APP_URL',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'DATABASE_POOL_URL',
] as const;

let memo: ServerConfig | undefined;

/** Lazy, memoized parse. NEVER at import time. */
export function getServerConfig(): ServerConfig {
  if (!memo) memo = serverSchema.parse(process.env);
  return memo;
}

function requirePresent(vars: readonly string[], subsystem: string): void {
  const missing = vars.filter((name) => {
    const value = process.env[name];
    return value === undefined || value.trim().length === 0;
  });
  if (missing.length > 0) {
    throw new Error(`[config] ${subsystem} requires: ${missing.join(', ')}`);
  }
}

/** Core-app boot assert — the minimum every Next server process needs. */
export function assertCoreAppConfig(): void {
  requirePresent(CORE_APP_REQUIRED_VARS, 'core-app');
}

// ── Subsystem accessors: assert presence, return non-null-narrowed view ──

const STRIPE_SERVER_VARS = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  ...STRIPE_PRICE_ENV_VARS,
] as const;

export interface StripeServerConfig {
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

export function assertStripeConfig(): void {
  requirePresent(STRIPE_SERVER_VARS, 'stripe (server)');
}

// Each `!` below is guarded by the preceding assertStripeConfig() throw — the
// value is provably non-null. This is the "required-ness at the accessor"
// pattern, not papering over `any`.
export function getStripeConfig(): StripeServerConfig {
  assertStripeConfig();
  const cfg = getServerConfig();
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

export function assertResendConfig(): void {
  requirePresent(['RESEND_API_KEY'], 'resend (server)');
}
export function getResendConfig(): { RESEND_API_KEY: string } {
  assertResendConfig();
  return { RESEND_API_KEY: getServerConfig().RESEND_API_KEY! };
}

export function assertSerpapiConfig(): void {
  requirePresent(['SERPAPI_API_KEY'], 'serpapi (server)');
}
export function getSerpapiConfig(): { SERPAPI_API_KEY: string } {
  assertSerpapiConfig();
  return { SERPAPI_API_KEY: getServerConfig().SERPAPI_API_KEY! };
}

export function assertOpenAiConfig(): void {
  requirePresent(['OPENAI_API_KEY'], 'openai (server)');
}
export function getOpenAiConfig(): { OPENAI_API_KEY: string } {
  assertOpenAiConfig();
  return { OPENAI_API_KEY: getServerConfig().OPENAI_API_KEY! };
}

export function assertGoogleMapsConfig(): void {
  requirePresent(['NEXT_PUBLIC_GOOGLE_MAPS_API_KEY'], 'google-maps (server)');
}
export function getGoogleMapsConfig(): { NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: string } {
  assertGoogleMapsConfig();
  return { NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: getServerConfig().NEXT_PUBLIC_GOOGLE_MAPS_API_KEY! };
}
