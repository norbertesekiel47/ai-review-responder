// worker/jobs/billing/postgres-transient-error.ts
//
// Single responsibility: "is this a transient Postgres / db-infra error?"
//
// UpdateStripeOverageWorker runs its account-scoped advisory lock inside a
// `sql.begin` that SHARES the Stripe try/catch. A transient postgres.js error
// raised while opening that tx or taking pg_advisory_xact_lock (connection
// drop, failover, statement/lock-wait timeout) is INFRA, not a deterministic
// Stripe failure — it must RETRY (BullMQ + the 1h outbox watchdog), never
// terminal-fail the overage sync.
//
// The Stripe error-inspection vocabulary lives in
// src/lib/payments/stripe-error-inspect.ts and is intentionally kept Stripe-only
// (its OS-socket RETRYABLE_NETWORK_ERROR_CODES set does NOT include postgres.js
// connection-lifecycle codes or PG SQLSTATEs). This module owns the orthogonal
// Postgres/db-infra vocabulary so the two concerns never leak into each other.
//
// Scope: matches ONLY genuine transient DB shapes via `err.code`. A code-less
// generic error is NOT transient (so the worker's existing "unknown error →
// terminal" default is preserved). Real OS socket codes (e.g. ECONNRESET) are
// deliberately NOT matched here — those are already handled by the Stripe
// network-code path; this predicate is the additive, non-overlapping db layer.

import { errorStringProperty } from '../../../src/lib/payments/stripe-error-inspect';

// postgres.js connection-lifecycle codes + transient server SQLSTATEs.
//   57014           query_canceled (statement / lock-wait timeout)
//   57P01–57P03     operator intervention: admin_shutdown, crash_shutdown,
//                   cannot_connect_now
//   08xxx           connection_exception class (see CONNECTION_EXCEPTION_PREFIX)
const TRANSIENT_POSTGRES_ERROR_CODES: ReadonlySet<string> = new Set([
  // postgres.js client-side connection lifecycle
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  'CONNECTION_CONNECT_TIMEOUT',
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
