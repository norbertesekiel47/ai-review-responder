// src/lib/config/server.ts
//
// SERVER lane — Next.js server-process env. Root schema is SHAPE-ONLY: the three
// core-app vars (Supabase URL/anon, app URL — asserted at instrumentation
// register()) are required; every subsystem secret (incl. the server DB creds) is
// .optional() so an innocent getServerConfig() in a UI-only preview never throws.
// A subsystem's secrets are asserted + narrowed to non-null ONLY by that
// subsystem's accessor. No top-level z.parse — getServerConfig is lazy + memoized.
import { z } from 'zod';
import { STRIPE_PRICE_ENV_VARS } from '@/lib/payments/price-tier-map';
import { optionalVar, requirePresent, requiredVar } from './schema-helpers';
import {
  STRIPE_REQUIRED_VARS,
  narrowStripeConfig,
  type StripeEnvConfig,
} from './stripe-shape';

const nonEmpty = requiredVar;
const opt = optionalVar;

// Build the Stripe price fields (optional in the root) from the single owner list.
const stripePriceShape = Object.fromEntries(
  STRIPE_PRICE_ENV_VARS.map((name) => [name, opt]),
) as Record<(typeof STRIPE_PRICE_ENV_VARS)[number], typeof opt>;

const serverSchema = z.object({
  // ── core-app required (Supabase URL/anon, app URL) ──
  NEXT_PUBLIC_SUPABASE_URL: nonEmpty,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: nonEmpty,
  NEXT_PUBLIC_APP_URL: nonEmpty,
  // ── server-DB subsystem (optional in root; asserted by getServerDbConfig) ──
  SUPABASE_URL: opt,
  SUPABASE_SERVICE_KEY: opt,
  DATABASE_POOL_URL: opt,
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
] as const;

// Server DB credentials — needed by every DB-backed route but NOT by a static /
// marketing render, so they are a server subsystem (asserted at DB-use in Stage 3
// via getServerDbConfig), NOT part of the global register() boot gate. A UI-only
// preview lacking them still boots. On the worker they ARE unconditional
// core-infra (assertWorkerConfig).
const SERVER_DB_REQUIRED_VARS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'DATABASE_POOL_URL',
] as const;

let memo: ServerConfig | undefined;

// Stage-2 foundation: getServerConfig + the per-subsystem accessors/asserts below
// have no production consumer YET — Stage 3 migrates the ~990 raw process.env
// reads onto them. They are unit-tested and deliberately unwired (wiring a
// subsystem assert before its subsystem uses getXConfig() would be premature).
// Suppress the "unused-export" finding until Stage 3 consumes them.

/** Lazy, memoized parse. NEVER at import time. */
// fallow-ignore-next-line unused-export
export function getServerConfig(): ServerConfig {
  if (!memo) memo = serverSchema.parse(process.env);
  return memo;
}

/** Core-app boot assert — the minimum every Next server process needs. */
export function assertCoreAppConfig(): void {
  requirePresent(CORE_APP_REQUIRED_VARS, 'core-app');
}

// Server-DB subsystem: asserted at the first DB-backed entry in Stage 3, not at
// boot, so static/marketing renders and UI-only previews aren't forced to carry
// the service key.
// fallow-ignore-next-line unused-export
export function assertServerDbConfig(): void {
  requirePresent(SERVER_DB_REQUIRED_VARS, 'server-db');
}
export function getServerDbConfig(): {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  DATABASE_POOL_URL: string;
} {
  assertServerDbConfig();
  const cfg = getServerConfig();
  return {
    SUPABASE_URL: cfg.SUPABASE_URL!,
    SUPABASE_SERVICE_KEY: cfg.SUPABASE_SERVICE_KEY!,
    DATABASE_POOL_URL: cfg.DATABASE_POOL_URL!,
  };
}

// ── Subsystem accessors: assert presence, return non-null-narrowed view ──

export type StripeServerConfig = StripeEnvConfig;

// fallow-ignore-next-line unused-export
export function assertStripeConfig(): void {
  requirePresent(STRIPE_REQUIRED_VARS, 'stripe (server)');
}

export function getStripeConfig(): StripeServerConfig {
  assertStripeConfig();
  return narrowStripeConfig(getServerConfig());
}

// fallow-ignore-next-line unused-export
export function assertResendConfig(): void {
  requirePresent(['RESEND_API_KEY'], 'resend (server)');
}
export function getResendConfig(): { RESEND_API_KEY: string } {
  assertResendConfig();
  return { RESEND_API_KEY: getServerConfig().RESEND_API_KEY! };
}

// fallow-ignore-next-line unused-export
export function assertSerpapiConfig(): void {
  requirePresent(['SERPAPI_API_KEY'], 'serpapi (server)');
}
// fallow-ignore-next-line unused-export
export function getSerpapiConfig(): { SERPAPI_API_KEY: string } {
  assertSerpapiConfig();
  return { SERPAPI_API_KEY: getServerConfig().SERPAPI_API_KEY! };
}

// fallow-ignore-next-line unused-export
export function assertOpenAiConfig(): void {
  requirePresent(['OPENAI_API_KEY'], 'openai (server)');
}
// fallow-ignore-next-line unused-export
export function getOpenAiConfig(): { OPENAI_API_KEY: string } {
  assertOpenAiConfig();
  return { OPENAI_API_KEY: getServerConfig().OPENAI_API_KEY! };
}

// fallow-ignore-next-line unused-export
export function assertGoogleMapsConfig(): void {
  requirePresent(['NEXT_PUBLIC_GOOGLE_MAPS_API_KEY'], 'google-maps (server)');
}
// fallow-ignore-next-line unused-export
export function getGoogleMapsConfig(): { NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: string } {
  assertGoogleMapsConfig();
  return { NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: getServerConfig().NEXT_PUBLIC_GOOGLE_MAPS_API_KEY! };
}
