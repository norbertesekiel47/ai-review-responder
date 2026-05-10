// src/app/api/admin/channels/sms/_shared.ts
//
// Shared helpers for the six admin SMS routes (verify, confirm, cancel,
// disable, delete, status). Each route applies the same auth + flag +
// subscription gates before doing its specific work.
//
// Tests: this file is exercised by tests in ../verify/__tests__, etc.
// (and the cross-route routes.test.ts Tasks 16-21 add).

import { NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';

// ── Flag gate ────────────────────────────────────────────────────────

/** Returns true if the CHANNELS_SMS_ENABLED env flag is on. */
export function isSmsEnabled(): boolean {
  return process.env.CHANNELS_SMS_ENABLED === 'true';
}

/** Response returned when the flag is off — hides the route's existence. */
export function flagOff(): NextResponse {
  return NextResponse.json({ error: 'not_found' }, { status: 404 });
}

/**
 * Returns a 503 NextResponse if CHANNELS_SMS_ENABLED=true but the required
 * Twilio env vars are missing. Returns null if env is ready (route should
 * proceed). Mirrors the worker-side startup assertion pattern.
 *
 * MOCK_EXTERNAL_APIS=true bypasses this check (local dev).
 */
export function assertSmsEnvReady(): NextResponse | null {
  if (process.env.MOCK_EXTERNAL_APIS === 'true') return null;
  const required = [
    'WORKER_PUBLIC_URL',
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_MESSAGING_SERVICE_SID',
    'TWILIO_VERIFY_SERVICE_SID',
  ];
  const missing = required.filter((k) => !process.env[k] || process.env[k]!.trim().length === 0);
  if (missing.length === 0) return null;
  console.error(`[sms-admin] CHANNELS_SMS_ENABLED=true but missing env vars: ${missing.join(', ')}`);
  return NextResponse.json({ ok: false, reason: 'sms_env_not_ready', missing }, { status: 503 });
}

// ── Subscription gate ────────────────────────────────────────────────

/** Loads the account subscription_status via the business's account_id. Returns null if the business doesn't exist. */
export async function loadBusinessSubscriptionStatus(businessId: string): Promise<string | null> {
  // After migration 034, subscription_status source of truth is accounts.
  const rows = await sql<{ subscription_status: string }[]>`
    SELECT a.subscription_status
    FROM accounts a
    JOIN businesses b ON b.account_id = a.id
    WHERE b.id = ${businessId}
  `;
  return rows[0]?.subscription_status ?? null;
}

/** Returns true when the business's account has an active subscription. */
export function isSubscriptionActive(status: string | null): status is typeof SubscriptionStatus.ACTIVE {
  return status === SubscriptionStatus.ACTIVE;
}

/** 403 response for business not in 'active' subscription state. */
export function subscriptionNotActive(): NextResponse {
  return NextResponse.json({ ok: false, reason: 'subscription_not_active' }, { status: 403 });
}

// ── Advisory lock ────────────────────────────────────────────────────

/**
 * Runs `fn` inside a transaction with a per-business mobile-enrollment advisory
 * lock. Serializes concurrent calls across all mobile channels (SMS, Telegram,
 * WhatsApp) so only one INSERT/UPDATE wins the migration 027 partial-unique race.
 *
 * Used by SMS verify/confirm/cancel/disable/delete routes; Telegram and WhatsApp
 * start routes acquire the same lock key inline so a concurrent SMS verify +
 * Telegram start cannot race past the SMS pre-check, send a Twilio Verify SMS,
 * and then fail with 23505.
 *
 * Matches the createApprovalLink per-(response_id, channel) lock pattern
 * shipped in commit d01d729.
 *
 * The callback receives the transaction handle as `tx` — all DB calls inside
 * MUST use `tx`, not `sql`, to stay inside the lock/transaction.
 */
export async function withMobileEnrollmentLock<T>(
  businessId: string,
  fn: (tx: typeof sql) => Promise<T>,
): Promise<T> {
  // sql.begin returns UnwrapPromiseArray<T> (postgres.js generic); our callback
  // always returns a plain Promise<T>, so the cast is safe. Keeping the public
  // signature as Promise<T> lets callers chain without re-declaring the type.
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`mobile_enroll:${businessId}`}, 0))`;
    return fn(tx as unknown as typeof sql);
  }) as Promise<T>;
}

// ── Error response shorthands ────────────────────────────────────────

/** 400 Bad Request — for client input errors (bad phone, missing fields). */
export function badRequest(reason: string): NextResponse {
  return NextResponse.json({ ok: false, reason }, { status: 400 });
}

/** 409 Conflict — for state conflicts (row not in expected state, race). */
export function conflict(reason: string): NextResponse {
  return NextResponse.json({ ok: false, reason }, { status: 409 });
}

/** 500 — used for Twilio upstream failures surfacing to the admin. */
export function twilioVerifyError(reason: string): NextResponse {
  return NextResponse.json({ ok: false, reason }, { status: 500 });
}
