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
import { optionalVar, rawOptionalVar, requirePresent, requirePresentIn } from './schema-helpers';
import {
  STRIPE_REQUIRED_VARS,
  narrowStripeConfig,
  type StripeEnvConfig,
} from './stripe-shape';

// requiredVar/`nonEmpty` is intentionally NOT used here: the root server schema is
// SHAPE-ONLY (every field optional). Required-ness is enforced by the boot asserts
// (assertCoreAppConfig / getServerDbConfig / the subsystem accessors), never the
// root parse — so getServerConfig() is safe to call from worker-run shared code
// that lacks the Next public vars.
const opt = optionalVar;
// Raw passthrough for MIGRATED reads whose call site does its own normalization
// (?.trim() / !value / Boolean / raw SDK arg). Preserves ''/'   '/unset exactly
// like the old process.env.X (convention #7). Do NOT use the collapsing `opt` for
// these — it would change whitespace edge cases.
const rawOpt = rawOptionalVar;

// Build the Stripe price fields (optional in the root) from the single owner list.
const stripePriceShape = Object.fromEntries(
  STRIPE_PRICE_ENV_VARS.map((name) => [name, opt]),
) as Record<(typeof STRIPE_PRICE_ENV_VARS)[number], typeof opt>;

const serverSchema = z.object({
  // ── core-app vars (Supabase URL/anon, app URL) ──
  // SHAPE-ONLY in the root parse (rawOptionalVar), NOT required here. Their
  // required-ness lives in the boot assert assertCoreAppConfig() (Next server
  // register()), which stays the SOLE enforcer. Making them required in the root
  // parse broke getServerConfig() when called from worker-run shared code (e.g.
  // getStripe(), the email modules) — the worker env doesn't carry NEXT_PUBLIC_*,
  // so the root parse threw a ZodError BEFORE the subsystem's own assert. Per the
  // Stage-2 principle ("root schema is shape-only; required-ness at the lane
  // assert"), getServerConfig() must never throw on absent core vars.
  NEXT_PUBLIC_SUPABASE_URL: rawOpt,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: rawOpt,
  NEXT_PUBLIC_APP_URL: rawOpt,
  // ── server-DB subsystem (optional in root; asserted by getServerDbConfig) ──
  SUPABASE_URL: opt,
  SUPABASE_SERVICE_KEY: opt,
  DATABASE_POOL_URL: opt,
  // ── subsystem secrets (optional) ──
  // Migrated raw read: stripe-client.ts getStripe() does `if (!key) throw` on the
  // RAW value, so rawOptionalVar (not the collapsing opt) keeps '   ' truthy →
  // new Stripe('   ') exactly as the old process.env.STRIPE_SECRET_KEY did (#7).
  // getStripeConfig/narrowStripeConfig still treat whitespace as absent (they
  // assert via requirePresentIn), so the asserting accessor is unaffected.
  STRIPE_SECRET_KEY: rawOpt,
  STRIPE_WEBHOOK_SECRET: opt,
  ...stripePriceShape,
  RESEND_API_KEY: rawOpt, // migrated raw read (client.ts Resend(...), contact-notify emailConfigured) — #7
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
  CONTACT_NOTIFY_TO: rawOpt, // migrated raw read (contact-notify resolveContactNotifyTo ?.trim()) — #7
  WORKER_PUBLIC_URL: opt,
  DB_POOL_MAX: opt,
  // ── email subsystem (migrated raw reads — rawOptionalVar preserves ''/'   '
  //    exactly; call sites own their own ?.trim()/!value/Boolean/SDK-arg) — #7 ──
  RESEND_FROM_EMAIL: rawOpt,
  EMAIL_SEND_TIMEOUT_MS: rawOpt,
  LIST_UNSUBSCRIBE_URL: rawOpt,
  LIST_UNSUBSCRIBE_EMAIL: rawOpt,
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

// Stage-2 foundation: the per-subsystem accessors/asserts below are still
// deliberately unwired — Stage 3 migrates the ~990 raw process.env reads onto
// them in batches (wiring a subsystem assert before its subsystem uses
// getXConfig() would be premature). Suppress the "unused-export" finding on those
// until their batch consumes them. getServerConfig itself IS now consumed (Stage-3
// email pilot: email/client.ts, email/send-email.ts), so it carries no suppression.

/** Lazy, memoized parse. NEVER at import time. */
export function getServerConfig(): ServerConfig {
  if (!memo) memo = serverSchema.parse(process.env);
  return memo;
}

/**
 * Core-app boot assert — the minimum every Next server process needs.
 *
 * STATIC refs only. Next inlines a public env var at build time ONLY for
 * statically-written `process.env.<LITERAL_NAME>` references; a dynamic
 * `process.env[name]` lookup reads the raw runtime env instead and can
 * false-throw on a deploy where the inlined app actually works. So this checks
 * the three vars by their literal names below. The prebuild `assertClientConfig`
 * is the canonical BUILD-time gate; this is the runtime backstop.
 * (CORE_APP_REQUIRED_VARS stays the declared list the coverage audit reads.)
 */
export function assertCoreAppConfig(): void {
  const missing: string[] = [];
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()) missing.push('NEXT_PUBLIC_SUPABASE_URL');
  if (!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim()) missing.push('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  if (!process.env.NEXT_PUBLIC_APP_URL?.trim()) missing.push('NEXT_PUBLIC_APP_URL');
  if (missing.length > 0) {
    throw new Error(`[config] core-app requires: ${missing.join(', ')}`);
  }
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
  const cfg = getServerConfig();
  requirePresentIn(cfg, SERVER_DB_REQUIRED_VARS, 'server-db');
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
  return narrowStripeConfig(getServerConfig(), 'stripe (server)');
}

// fallow-ignore-next-line unused-export
export function assertResendConfig(): void {
  requirePresent(['RESEND_API_KEY'], 'resend (server)');
}
export function getResendConfig(): { RESEND_API_KEY: string } {
  const cfg = getServerConfig();
  requirePresentIn(cfg, ['RESEND_API_KEY'], 'resend (server)');
  return { RESEND_API_KEY: cfg.RESEND_API_KEY! };
}

// fallow-ignore-next-line unused-export
export function assertSerpapiConfig(): void {
  requirePresent(['SERPAPI_API_KEY'], 'serpapi (server)');
}
// fallow-ignore-next-line unused-export
export function getSerpapiConfig(): { SERPAPI_API_KEY: string } {
  const cfg = getServerConfig();
  requirePresentIn(cfg, ['SERPAPI_API_KEY'], 'serpapi (server)');
  return { SERPAPI_API_KEY: cfg.SERPAPI_API_KEY! };
}

// fallow-ignore-next-line unused-export
export function assertOpenAiConfig(): void {
  requirePresent(['OPENAI_API_KEY'], 'openai (server)');
}
// fallow-ignore-next-line unused-export
export function getOpenAiConfig(): { OPENAI_API_KEY: string } {
  const cfg = getServerConfig();
  requirePresentIn(cfg, ['OPENAI_API_KEY'], 'openai (server)');
  return { OPENAI_API_KEY: cfg.OPENAI_API_KEY! };
}

// fallow-ignore-next-line unused-export
export function assertGoogleMapsConfig(): void {
  requirePresent(['NEXT_PUBLIC_GOOGLE_MAPS_API_KEY'], 'google-maps (server)');
}
// fallow-ignore-next-line unused-export
export function getGoogleMapsConfig(): { NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: string } {
  const cfg = getServerConfig();
  requirePresentIn(cfg, ['NEXT_PUBLIC_GOOGLE_MAPS_API_KEY'], 'google-maps (server)');
  return { NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: cfg.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY! };
}
