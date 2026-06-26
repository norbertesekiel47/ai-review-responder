// src/lib/db/transient-error.ts
//
// Single responsibility: "is this a transient Postgres / db-infra error?"
//
// The db-infra-transient vocabulary, separate from the Stripe network vocabulary
// in src/lib/payments/stripe-error-inspect.ts (whose OS-socket set does NOT cover
// postgres.js connection-lifecycle codes or PG SQLSTATEs). The two concerns stay
// orthogonal so neither leaks into the other.
//
// Consumers:
//   - UpdateStripeOverageWorker: a transient postgres.js error raised while
//     opening its `sql.begin` tx or taking pg_advisory_xact_lock (connection
//     drop, failover, statement/lock-wait timeout) is INFRA, not a deterministic
//     Stripe failure — it must RETRY, never terminal-fail the overage sync.
//   - worker/index.ts crash-net: a transient DB rejection that surfaces as an
//     unhandledRejection (e.g. a boot-burst statement timeout from postgres.js'
//     connection layer, which escapes a poller's own try/catch) must NOT crash
//     the whole worker — the loop recovers on its next cycle.
//
// Scope: matches ONLY genuine transient DB shapes via `err.code`. A code-less
// generic error is NOT transient (so callers' "unknown error → terminal/fatal"
// defaults are preserved). Real OS socket codes (e.g. ECONNRESET) are
// deliberately NOT matched here — those are the Stripe network-code path's job;
// this predicate is the additive, non-overlapping db layer.

import { errorStringProperty } from '../payments/stripe-error-inspect';

// postgres.js connection-lifecycle codes + transient server SQLSTATEs.
//   57014           query_canceled (statement / lock-wait timeout)
//   57P01–57P03     operator intervention: admin_shutdown, crash_shutdown,
//                   cannot_connect_now
//   08xxx           connection_exception class (see CONNECTION_EXCEPTION_PREFIX)
const TRANSIENT_POSTGRES_ERROR_CODES: ReadonlySet<string> = new Set([
  // postgres.js client-side connection lifecycle (the exact codes postgres.js
  // v3.4.9 raises: CONNECTION_CLOSED/ENDED/DESTROYED + CONNECT_TIMEOUT)
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  'CONNECT_TIMEOUT',
  // server-side transient SQLSTATEs
  '57014',
  '57P01',
  '57P02',
  '57P03',
  // SQLSTATE class 08 — connection_exception (enumerated for exactness; the
  // prefix check below also catches any future 08-class code)
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '08P01',
]);

// SQLSTATE class 08 = connection_exception. Any 5-char code in this class is a
// connection failure and therefore transient.
const CONNECTION_EXCEPTION_PREFIX = '08';

export function isTransientPostgresError(err: unknown): boolean {
  const code = errorStringProperty(err, 'code');
  if (!code) return false;
  if (TRANSIENT_POSTGRES_ERROR_CODES.has(code)) return true;
  return code.length === 5 && code.startsWith(CONNECTION_EXCEPTION_PREFIX);
}

// Codes a billing-style idempotent+accounted retry tolerates, but whose
// UNHANDLED-rejection semantics are too broad to silently survive at the PROCESS
// level: their operation outcome is ambiguous or they signal a deeper fault.
//   08007  transaction_resolution_unknown — COMMIT outcome unknown; no owner to reconcile
//   08P01  protocol_violation — likely a deeper client/server fault, not a blip
const PROCESS_NON_RECOVERABLE_CODES: ReadonlySet<string> = new Set(['08007', '08P01']);

/**
 * Stricter subset of {@link isTransientPostgresError} for the worker's
 * process-level crash-net (worker/index.ts): a transient DB rejection it is safe
 * to RECOVER from (survive without exiting) because the operation provably did
 * not complete and the loop reconciles on its next cycle.
 *
 * Narrower than the billing predicate by design — it matches ONLY the explicit
 * transient set MINUS the ambiguous-state codes, and does NOT apply the
 * open-ended 08-class prefix fallback. Anything whose outcome is unknown (or any
 * future/unlisted 08-class code) still fails fast, so an unknown state gets a
 * clean restart rather than silent continuation.
 */
export function isCrashNetRecoverableDbError(err: unknown): boolean {
  const code = errorStringProperty(err, 'code');
  if (!code) return false;
  if (PROCESS_NON_RECOVERABLE_CODES.has(code)) return false;
  return TRANSIENT_POSTGRES_ERROR_CODES.has(code);
}
