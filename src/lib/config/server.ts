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
const exactOptionalBoolean = z.enum(['true', 'false']).optional();

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
  // WS8 launch config. The deadline parser deliberately handles malformed
  // input as a fail-closed operational condition; the Autopilot sale flag is
  // exact and therefore rejects any configured value except true/false.
  FOUNDING_DEADLINE: rawOpt,
  AUTOPILOT_PURCHASABLE: exactOptionalBoolean,
  RESEND_API_KEY: rawOpt, // migrated raw read (client.ts Resend(...), contact-notify emailConfigured) — #7
  // Migrated raw read (Stage-3 serpapi-redis batch): serpapi-prefill.ts does
  // `const apiKey = getServerConfig().SERPAPI_API_KEY; if (!apiKey)` on the RAW
  // value (#7); place-id-resolver passes it straight to the SerpAPI SDK. So
  // rawOptionalVar (not the collapsing opt) keeps a whitespace `'   '` truthy
  // exactly like the old raw process.env.SERPAPI_API_KEY. getSerpapiConfig/
  // assertSerpapiConfig still treat whitespace as absent via requirePresentIn/
  // requirePresent, so the asserting accessor is unaffected.
  SERPAPI_API_KEY: rawOpt,
  OPENAI_API_KEY: opt,
  NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: opt,
  // ── shape-only optionals (not asserted this Stage) ──
  DATABASE_URL: opt,
  // Migrated raw read (Stage-3 serpapi-redis batch): the SerpAPI+Redis cluster's
  // presence gates do `if (!getServerConfig().REDIS_CACHE_URL)` (serpapi-prefill
  // readCache/writeCache, rate-limit), so rawOptionalVar keeps a whitespace `'   '`
  // TRUTHY exactly like the old raw process.env.REDIS_CACHE_URL — the collapsing
  // opt would map it to undefined and FLIP the gate (skip cache / wrongly
  // fail-closed). REDIS_CACHE_URL was shape-only/unconsumed before this batch, so
  // the switch has no other consumer. The db/redis-cache.ts constructor still reads
  // process.env directly (allowlisted).
  REDIS_CACHE_URL: rawOpt,
  // Migrated raw read (Stage-3 serpapi-redis batch): serpapi-prefill computes
  // `cfg.SERPAPI_TIMEOUT_MS ? Math.max(1, parseInt(cfg.SERPAPI_TIMEOUT_MS, 10)) :
  // 2_000`, so rawOptionalVar preserves ''/'   '/unset byte-for-byte (#7).
  SERPAPI_TIMEOUT_MS: rawOpt,
  SENTRY_DSN: opt,
  NEXT_PUBLIC_SENTRY_DSN: opt,
  NEXT_PUBLIC_DOCS_BASE_URL: opt,
  // ── HMAC/cookie secrets (Stage-3 src-lib batch) — migrated raw reads ──
  // Each accessor (getSessionCookieSecret / feedback-hmac getSecret /
  // impersonation getSecret) does `if (!secret) throw` then a RAW check on the
  // value (Buffer.byteLength >= 32 / HMAC update / .length < 32). rawOptionalVar
  // keeps a whitespace `'   '` truthy so it reaches the length check exactly as
  // the old raw process.env.X did (#7) — the collapsing `opt` would map it to
  // undefined and FLIP the throw branch. requirePresent-based asserts (if any
  // wire up later) still treat whitespace as absent, independent of the field.
  SESSION_COOKIE_SECRET: rawOpt,
  // The OUTGOING signing key during a SESSION_COOKIE_SECRET rollover (#644).
  // Optional and empty in the steady state; set to the previous value in the SAME
  // deploy that sets the new SESSION_COOKIE_SECRET, then cleared once every
  // already-delivered unsubscribe link has outlived CAN-SPAM's ≥30-day operating
  // window. Verification-only — nothing is ever minted under it. rawOptionalVar
  // for the same reason as its sibling above: the reader
  // (src/lib/solicitation/unsubscribe.ts) does `if (!secret)` then a RAW
  // Buffer.byteLength >= 32 check, so a whitespace '   ' must stay truthy and
  // reach the length check rather than collapsing to undefined and silently
  // reading as "not rotating". Server lane only, exactly like
  // SESSION_COOKIE_SECRET: getSessionCookieSecret() and the previous-key reader
  // both go through getServerConfig() on BOTH surfaces, so a worker-lane copy
  // would be a second declaration with no reader. No NEXT_PUBLIC_* companion
  // (invariant #13).
  SESSION_COOKIE_SECRET_PREVIOUS: rawOpt,
  CSRF_SECRET: rawOpt,
  IMPERSONATION_COOKIE_SECRET: rawOpt,
  CONTACT_NOTIFY_TO: rawOpt, // migrated raw read (contact-notify resolveContactNotifyTo ?.trim()) — #7
  // Migrated raw read: getWorkerPublicUrl() does `if (!raw) throw; new URL(raw)`
  // on the raw value, so rawOptionalVar preserves '   '/'' verbatim (#7).
  WORKER_PUBLIC_URL: rawOpt,
  // Shared secret the admin jobs route (/api/admin/jobs) sends as a bearer token
  // when fetching the worker's GET /internal/queue-health endpoint (#408). NEW
  // optional config that intentionally treats empty/whitespace as "unset" → the
  // collapsing `opt`: when absent the route skips the worker call and surfaces
  // queueHealth:{unavailable:true}. Server-only (NOT NEXT_PUBLIC). Never logged.
  WORKER_INTERNAL_SECRET: opt,
  // Migrated raw reads (Stage-3 zernio-transport batch): the Zernio transport does
  // `options.X ?? getServerConfig().X ?? <fallback>` inside requestWithOptions
  // (read AFTER the MOCK_EXTERNAL_APIS short-circuit). rawOptionalVar preserves
  // ''/'   '/unset byte-for-byte (#7), so the `?? 'https://zernio.com/api'` and
  // `?? ''` fallbacks stay behavior-identical to the old raw process.env reads.
  // Dual-runtime: the zernio client surface is reached from BOTH Next connect
  // OAuth routes (ADR-0001 exception) and the worker (publishing/ingest/teardown),
  // so getServerConfig() (#4). No asserting accessor — the fallbacks tolerate
  // absence (#5). MOCK_ZERNIO_LOCATION_COUNT is NOT here: it is a mock-fixture knob
  // (read only in mock mode), exempt in the process-env audit, never prod config.
  ZERNIO_API_BASE: rawOpt,
  ZERNIO_API_KEY: rawOpt,
  // Migrated raw read (Stage-3 trial-period-days batch): create-checkout-session
  // resolveTrialPeriodDays() does `if (!raw) return DEFAULT; parseInt(raw, 10)` on
  // the raw value, so rawOptionalVar preserves ''/'   '/unset byte-for-byte (#7) —
  // an empty string must stay falsy → default 30, exactly like the old read.
  // Next-only (billing-checkout + onboarding select-plan routes); read in-fn.
  TRIAL_PERIOD_DAYS: rawOpt,
  // Spend-safety ceilings. Copilot and Autopilot values are required positive
  // decimal integers enforced by the owning worker/admin gates; rawOpt preserves
  // the original text so their shared strict parser can reject blanks, decimals,
  // zero, and unsafe integers. The global ceiling remains optional with its
  // established fallback.
  GLOBAL_DAILY_COST_LIMIT_CENTS: rawOpt,
  DAILY_COST_LIMIT_CENTS_COPILOT: rawOpt,
  DAILY_COST_LIMIT_CENTS_AUTOPILOT: rawOpt,
  DB_POOL_MAX: opt,
  // Read-pool size (src/lib/db/server.ts sqlRead). Optional, same shape as
  // DB_POOL_MAX — declared here for schema/inventory parity (codex #9); the
  // client still reads process.env.DB_READ_POOL_MAX directly (readReadPoolMax),
  // which validates + CLAMPS it to the reviewed [WEDGE_SAFE_READ_MIN,
  // READ_POOL_MAX_CEILING] range (both 8) and warn-logs out-of-range values.
  DB_READ_POOL_MAX: opt,
  // ── Stage-3 src-lib batch (server/shared secrets + small config) ──────────
  // All migrated raw reads (each call site owns its own ?.trim()/!value/Boolean/
  // parseInt guard or passes the value straight to its SDK), so rawOptionalVar
  // preserves ''/'   '/unset byte-for-byte (#7). All read via getServerConfig()
  // INSIDE a function (never at import) — these modules run in both the worker
  // and Next-server lanes (convention #4 runtime-invocation constraint).
  POSTHOG_API_KEY: rawOpt,
  POSTHOG_HOST: rawOpt,
  ONBOARDING_DEMO_DAILY_CENTS: rawOpt,
  OWNER_LEADS_GOOGLE_SHEET_ID: rawOpt,
  GOOGLE_SHEETS_CLIENT_EMAIL: rawOpt,
  GOOGLE_SHEETS_PRIVATE_KEY: rawOpt,
  OWNER_LEADS_GOOGLE_SHEET_RANGE: rawOpt,
  // ── email subsystem (migrated raw reads — rawOptionalVar preserves ''/'   '
  //    exactly; call sites own their own ?.trim()/!value/Boolean/SDK-arg) — #7 ──
  RESEND_FROM_EMAIL: rawOpt,
  EMAIL_SEND_TIMEOUT_MS: rawOpt,
  LIST_UNSUBSCRIBE_URL: rawOpt,
  LIST_UNSUBSCRIBE_EMAIL: rawOpt,
  // #644 §5.4: the mailto: opt-out address the Neutral page advertises so a
  // recipient whose link no longer works never dead-ends. NEW optional config,
  // so the COLLAPSING `opt`: an address that is empty or whitespace is not an
  // address, and "unset" must reach the page as undefined — it renders the line
  // only when there is a real mailbox behind it, because a dead `mailto:` turns
  // "no alternative offered" into "an alternative that silently fails".
  // Server-only, NO NEXT_PUBLIC_ companion (invariant #13). Distinct from
  // LIST_UNSUBSCRIBE_EMAIL above (different sender, different §7.2 servicing
  // obligation) — do not collapse them.
  SOLICITATION_UNSUBSCRIBE_MAILTO: opt,
  // ── Stage-3 out-of-guard batch (scattered src/app server-side route config) ──
  // Migrated raw reads from server-side process.env reads in src/app/** (Next route
  // handlers + one landing Server Component) that live OUTSIDE the process-env
  // audit's scope (the audit scans only src/lib/** + worker/**). So the baseline is
  // UNCHANGED by this batch — the value is Q4 config-ownership, not audit
  // enforcement. Each call site owns its own guard (`?? 'fallback'`, `!value`,
  // `?.trim() || …`), so rawOptionalVar preserves ''/'   '/unset byte-for-byte (#7)
  // — the collapsing `opt` would flip whitespace edge cases. Server lane
  // (getServerConfig is shape-only, never throws); these are Next server reads,
  // NONE NEXT_PUBLIC_*, so no build-inlining concern.
  //  - ZERNIO_PROFILE_ID_PREFIX: zernio/connect/start `?? 'repworth-prod-'`.
  //  - TWILIO_WHATSAPP_NUMBER: admin+dashboard whatsapp/start `!`.replace(...) — also
  //    declared in worker.ts (worker WhatsApp batch); a var may live in BOTH schemas
  //    (like RESEND_FROM_EMAIL), which is fine — both lanes read the same env.
  //  - TELEGRAM_BOT_USERNAME: admin `?? 'RepWorthBot'`, dashboard `?.trim() || 'RepWorthBot'`.
  //  - REDIS_QUEUE_URL / REDIS_QUEUE_TOKEN: admin/jobs queue-health probe (`if (!url)`
  //    gate + ioredis `password`). (REDIS_CACHE_URL — admin/demos/generate gate — and
  //    TRIAL_PERIOD_DAYS — (public)/page.tsx — are REUSED from prior batches.)
  ZERNIO_PROFILE_ID_PREFIX: rawOpt,
  TWILIO_WHATSAPP_NUMBER: rawOpt,
  TELEGRAM_BOT_USERNAME: rawOpt,
  REDIS_QUEUE_URL: rawOpt,
  REDIS_QUEUE_TOKEN: rawOpt,
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
 * Test-only: clear the memo so the NEXT getServerConfig() re-parses the current
 * process.env. Mirrors resetWorkerConfigForTests(). Most server-lane tests use
 * the set→vi.resetModules()→re-import pattern (which re-evaluates this module and
 * clears the memo), but a WORKER-lane test that statically imports a handler which
 * transitively reads a SHARED src/lib module on getServerConfig() (e.g.
 * session-cookie-secret via tokens) can't re-import the handler cheaply — it calls
 * this seam in beforeEach instead, exactly like it already calls
 * resetWorkerConfigForTests(). Production env is immutable, so this seam never runs
 * in prod (a memoized snapshot equals a live read).
 */
export function resetServerConfigForTests(): void {
  memo = undefined;
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
