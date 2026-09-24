// src/lib/onboarding/start.ts
//
// The POST /api/onboarding/start flow after the session is established
// (#1368): the owner/primary-business read, the pending_payment gate, the
// idempotent redirect, the outer and demo rate limits, the demo cost
// reservation, and the activation transaction. The route keeps the flag,
// same-origin, Supabase session and BotID gates, then calls
// `startOnboarding` once.
//
// The body is read through `readJsonBody` rather than passed in parsed: the
// pre-#1368 order read it only AFTER the subscription gate, the idempotent
// redirect and the outer rate limit, so a rate-limited or already-started
// request never reaches the parse. Keeping that order is why the route hands
// over a reader, not a value.
//
// Takes `sql` as a parameter (invariant #15); JSONB goes through `tx.json`
// (byte-identical to the composition-root `jsonb()` helper).

import type { Sql, TransactionSql } from 'postgres';
import type { z } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import { OnboardingStartSchema } from '@/lib/shared/schemas';
import { extractPlaceId } from '@/lib/reviews/url-parser';
import type { ValidatePlaceIdPayload } from '@/lib/shared/worker-types';
import { reserveOnboardingDemoBudget, CostCeilingExceeded } from '@/lib/costs/onboarding-demo-cost-guard';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import { PLACEHOLDER_BUSINESS_NAME } from '@/lib/onboarding/create-business';
import { enqueueValidatePlaceId } from '@/lib/shared/job-outbox-helpers';
import { reportCaughtError } from '@/lib/shared/report-caught-error';

type OnboardingStartInput = ReturnType<typeof OnboardingStartSchema.parse>;

const REPORT_CONTEXT = 'api/onboarding/start';

export interface OnboardingStartRequest {
  /** Supabase auth user id of the established session. */
  authId: string;
  /** First `x-forwarded-for` hop, or `'unknown'` — the per-IP demo limit key. */
  clientIp: string;
  /** Reads the raw JSON body; throws on malformed JSON. Called at most once. */
  readJsonBody: () => Promise<unknown>;
}

/**
 * `json` → the route answers `body` at `status`. `invalid_body` → the body
 * failed `OnboardingStartSchema`; the route answers the single #1373 shape via
 * `invalidBodyResponse`.
 */
export type OnboardingStartOutcome =
  | { kind: 'json'; status: number; body: Record<string, unknown> }
  | { kind: 'invalid_body'; error: z.ZodError };

function json(status: number, body: Record<string, unknown>): OnboardingStartOutcome {
  return { kind: 'json', status, body };
}

interface BizRow {
  id: string;
  account_id: string;
  user_id: string;
  subscription_status: string;
  place_id_verified: boolean;
  google_maps_url: string | null;
}

// Subset of BizRow for the FOR UPDATE re-read inside the transaction.
// subscription_status is NOT re-checked inside the tx — the outer query
// already gates on it.
interface ForUpdateRow {
  id: string;
  place_id_verified: boolean;
  google_maps_url: string | null;
}

// Resolve the place id from the validated body. A direct googlePlaceId is
// trusted (verified); a Maps URL is parsed and queued for async validation.
function resolvePlaceId(
  data: OnboardingStartInput,
  bizId: string,
  correlationId: string,
): {
  resolvedPlaceId: string | null;
  placeIdVerified: boolean;
  validatePayload: ValidatePlaceIdPayload | null;
} {
  if (data.googlePlaceId) {
    return { resolvedPlaceId: data.googlePlaceId, placeIdVerified: true, validatePayload: null };
  }
  const mapsUrl = data.googleMapsUrl!;
  return {
    resolvedPlaceId: extractPlaceId(mapsUrl),
    placeIdVerified: false,
    validatePayload: {
      business_id: bizId,
      google_maps_url: mapsUrl,
      correlation_id: correlationId,
    },
  };
}

interface OnboardingStartTxParams {
  bizRow: BizRow;
  data: OnboardingStartInput;
  resolvedPlaceId: string | null;
  placeIdVerified: boolean;
  validatePayload: ValidatePlaceIdPayload | null;
  demoBlocked: boolean;
  reservationDate: string | null;
  correlationId: string;
}

// Business + account updates and the optional place-id validation outbox —
// the part of activation that runs whether or not the demo is blocked.
async function applyActivationUpdates(tx: TransactionSql, p: OnboardingStartTxParams): Promise<void> {
  await tx`
    UPDATE businesses
    SET
      name = ${p.data.businessName},
      category = ${p.data.prefilledCategory ?? null},
      google_place_id = ${p.resolvedPlaceId},
      place_id_verified = ${p.placeIdVerified},
      google_maps_url = ${p.data.googleMapsUrl ?? null},
      website = ${p.data.prefilledWebsite ?? null},
      updated_at = NOW()
    WHERE id = ${p.bizRow.id}::uuid
  `;

  // Keep the Account's display_name in step with the Business name while the
  // account is still pre-activation. The placeholder-only predicate was correct
  // when EVERY account was born with `(pending setup)`; an admin-invited account
  // is born with the real business name the admin typed, so that predicate would
  // never fire and an owner renaming the business at /onboarding/start would
  // leave Account and Business divergent. Post-activation renames stay out of
  // scope (deliberate — see plan step 5).
  await tx`
    UPDATE accounts
    SET display_name = ${p.data.businessName}, updated_at = NOW()
    WHERE id = ${p.bizRow.account_id}::uuid
      AND (
        subscription_status = 'pending_payment'  -- enum: SubscriptionStatus.PENDING_PAYMENT
        OR display_name = ${PLACEHOLDER_BUSINESS_NAME}
      )
  `;

  if (p.validatePayload) {
    await enqueueValidatePlaceId(tx, {
      businessId: p.bizRow.id,
      googleMapsUrl: p.validatePayload.google_maps_url,
      correlationId: p.validatePayload.correlation_id,
    });
  }
}

// The demo row and its `onboarding_demo_response` outbox row (raw INSERT: the
// topic has no typed helper).
async function insertDemoWithOutbox(tx: TransactionSql, p: OnboardingStartTxParams): Promise<void> {
  const demoId = uuidv7();
  const outboxId = uuidv7();

  await tx`
    INSERT INTO onboarding_demos (
      id, user_id, business_id, business_name, category,
      google_place_id, google_maps_url, generation_status,
      correlation_id, created_at, updated_at
    ) VALUES (
      ${demoId}, ${p.bizRow.user_id}::uuid, ${p.bizRow.id}::uuid,
      ${p.data.businessName}, ${p.data.prefilledCategory ?? null},
      ${p.resolvedPlaceId}, ${p.data.googleMapsUrl ?? null},
      'queued', ${p.correlationId}, NOW(), NOW()
    )
  `;

  await tx`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    VALUES (
      ${outboxId}, ${QUEUE_NAMES.ONBOARDING_DEMO_RESPONSE}, 'onboarding_demo', ${demoId}::uuid,
      ${tx.json({
        demoId,
        googlePlaceId: p.resolvedPlaceId,
        businessName: p.data.businessName,
        category: p.data.prefilledCategory ?? undefined,
        googleMapsUrl: p.data.googleMapsUrl ?? undefined,
        correlation_id: p.correlationId,
        outbox_id: outboxId,
        cost_reservation_date: p.reservationDate ?? undefined,
      } as never)},
      'pending'
    )
  `;
}

// The activation transaction: advisory-lock + FOR UPDATE idempotency re-read,
// then the business/account updates, the optional place-id validation outbox,
// and (unless the demo is blocked) the demo row + its outbox.
//
// Returns whether the demo row was actually inserted. The caller relies on this
// to release the cost reservation on the idempotency-loser / vanished-row path
// so we never leak a reservation for a demo that wasn't queued.
async function persistOnboardingStart(tx: TransactionSql, p: OnboardingStartTxParams): Promise<boolean> {
  await tx`SELECT pg_advisory_xact_lock(hashtext(${p.bizRow.id + ':activation'}))`;

  const [forUpdateRow] = await tx<ForUpdateRow[]>`
    SELECT id, place_id_verified, google_maps_url
    FROM businesses
    WHERE id = ${p.bizRow.id}::uuid
    FOR UPDATE
  `;
  if (!forUpdateRow) return false;
  if (forUpdateRow.place_id_verified || forUpdateRow.google_maps_url) return false;

  await applyActivationUpdates(tx, p);

  if (p.demoBlocked) return false;

  await insertDemoWithOutbox(tx, p);
  return true;
}

/** Either a value to continue with, or the outcome to answer now. */
type Step<T> = { ok: true; value: T } | { ok: false; outcome: OnboardingStartOutcome };

/**
 * The owner/primary-business read plus the gates that answer before the body
 * is read: no row → 404, not pending_payment → 409, place already captured →
 * the idempotent 200 redirect.
 */
async function readStartableBusiness(sql: Sql, authId: string): Promise<Step<BizRow>> {
  const [bizRow] = await sql<BizRow[]>`
    SELECT b.id, a.id AS account_id, u.id AS user_id, a.subscription_status, b.place_id_verified, b.google_maps_url
    FROM users u
    JOIN accounts a ON a.id = u.account_id
    JOIN businesses b ON b.account_id = a.id AND b.is_primary = TRUE
    WHERE u.auth_id = ${authId}
      AND u.role = 'owner'
    LIMIT 1
  `;
  if (!bizRow) {
    return { ok: false, outcome: json(404, { error: 'account_incomplete' }) };
  }

  if (bizRow.subscription_status !== SubscriptionStatus.PENDING_PAYMENT) {
    return {
      ok: false,
      outcome: json(409, { error: 'subscription_inactive', subscriptionStatus: bizRow.subscription_status }),
    };
  }

  // Idempotent: redirect to demo page if already started
  if (bizRow.place_id_verified || bizRow.google_maps_url) {
    return { ok: false, outcome: json(200, { redirectTo: '/onboarding/demo', demoQueued: false }) };
  }
  return { ok: true, value: bizRow };
}

/** Outer rate limit: 10/auth-id/hour, strict (a limiter fault is a 503). */
async function outerRateLimitRefusal(authId: string): Promise<OnboardingStartOutcome | null> {
  try {
    const rl = await checkRateLimit(`onboarding-start:auth:${authId}`, 10, 3600, { strict: true });
    if (!rl.allowed) {
      return json(429, { error: 'rate_limited' });
    }
  } catch (err) {
    reportCaughtError(REPORT_CONTEXT, err, { reason: 'rate_limit_strict_failure' });
    return json(503, { error: 'rate_limit_unavailable' });
  }
  return null;
}

/** Reads and validates the body: malformed JSON → 400, schema failure → `invalid_body`. */
async function readStartBody(readJsonBody: () => Promise<unknown>): Promise<Step<OnboardingStartInput>> {
  let body: unknown;
  try {
    body = await readJsonBody();
  } catch {
    return { ok: false, outcome: json(400, { error: 'invalid_json' }) };
  }
  const parsed = OnboardingStartSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, outcome: { kind: 'invalid_body', error: parsed.error } };
  }
  return { ok: true, value: parsed.data };
}

interface DemoGate {
  demoBlocked: boolean;
  blockReason: 'cost_ceiling' | 'rate_limit' | null;
  cleanupReservation: (() => Promise<void>) | null;
  reservationDate: string | null;
}

/**
 * Demo-specific rate limits (per user, per IP, global — strict), then the
 * demo cost reservation. A tripped limit or the cost ceiling blocks only the
 * demo; a limiter or Redis fault answers 503.
 */
async function evaluateDemoGate(authId: string, clientIp: string): Promise<Step<DemoGate>> {
  const gate: DemoGate = { demoBlocked: false, blockReason: null, cleanupReservation: null, reservationDate: null };

  try {
    const userRl = await checkRateLimit(`onboarding-demo:user:${authId}`, 3, 86400, { strict: true });
    const ipRl = await checkRateLimit(`onboarding-demo:ip:${clientIp}`, 5, 86400, { strict: true });
    const globalRl = await checkRateLimit(`onboarding-demo:global`, 200, 3600, { strict: true });

    if (!userRl.allowed || !ipRl.allowed || !globalRl.allowed) {
      gate.demoBlocked = true;
      gate.blockReason = 'rate_limit';
    }
  } catch (err) {
    reportCaughtError(REPORT_CONTEXT, err, { reason: 'demo_rate_limit_check_failed' });
    return { ok: false, outcome: json(503, { error: 'rate_limit_unavailable' }) };
  }

  if (gate.demoBlocked) return { ok: true, value: gate };
  try {
    const reservation = await reserveOnboardingDemoBudget();
    gate.cleanupReservation = reservation.release;
    gate.reservationDate = reservation.date;
  } catch (err) {
    if (!(err instanceof CostCeilingExceeded)) {
      reportCaughtError(REPORT_CONTEXT, err, { reason: 'cost_guard_reservation_failed' });
      return { ok: false, outcome: json(503, { error: 'redis_unavailable' }) };
    }
    gate.demoBlocked = true;
    gate.blockReason = 'cost_ceiling';
  }
  return { ok: true, value: gate };
}

/** Best-effort reservation release; a release failure is ignored. */
async function releaseReservation(cleanupReservation: (() => Promise<void>) | null): Promise<void> {
  if (cleanupReservation) {
    try { await cleanupReservation(); } catch { /* ignore */ }
  }
}

/**
 * Runs the activation transaction and settles the reservation: released on a
 * failed transaction (reported 500) and on the idempotency-loser path.
 */
async function runActivation(
  sql: Sql,
  bizRow: BizRow,
  data: OnboardingStartInput,
  gate: DemoGate,
): Promise<OnboardingStartOutcome> {
  // Resolve place id
  const correlationId = uuidv7();
  const { resolvedPlaceId, placeIdVerified, validatePayload } = resolvePlaceId(
    data,
    bizRow.id,
    correlationId,
  );

  // Track whether the demo INSERT actually fired inside the tx. The outer
  // closure can't observe a return-from-callback no-op (idempotency loser
  // path or vanished business row), so without this flag we'd return
  // demoQueued:true and leak the 20¢ reservation. Only set to true on the
  // happy path where the demo + outbox row are written.
  let demoInserted = false;
  try {
    await sql.begin(async (tx) => {
      demoInserted = await persistOnboardingStart(tx, {
        bizRow,
        data,
        resolvedPlaceId,
        placeIdVerified,
        validatePayload,
        demoBlocked: gate.demoBlocked,
        reservationDate: gate.reservationDate,
        correlationId,
      });
    });
  } catch (err) {
    await releaseReservation(gate.cleanupReservation);
    reportCaughtError(REPORT_CONTEXT, err, { reason: 'transaction_failed', businessId: bizRow.id });
    return json(500, { error: 'internal_error' });
  }

  // Idempotency-loser path: tx committed without inserting a demo (another
  // /start submission won the FOR UPDATE race, OR the business row vanished).
  // Release the reservation we made earlier so we don't leak 20¢ per loser,
  // and report demoQueued:false so the client doesn't poll for a demo that
  // doesn't exist.
  if (!gate.demoBlocked && !demoInserted) {
    await releaseReservation(gate.cleanupReservation);
  }

  return json(200, {
    redirectTo: '/onboarding/demo',
    demoQueued: !gate.demoBlocked && demoInserted,
    reason: gate.blockReason,
  });
}

/**
 * Activates a pending_payment owner's primary business from the start form
 * and, budget and limits permitting, queues the pre-pay demo. Never throws for
 * an expected fault: limiter/reservation/transaction failures are reported
 * and mapped to their status. Step order is the pre-#1368 route's, exactly.
 */
export async function startOnboarding(
  sql: Sql,
  request: OnboardingStartRequest,
): Promise<OnboardingStartOutcome> {
  const business = await readStartableBusiness(sql, request.authId);
  if (!business.ok) return business.outcome;

  const outerRefusal = await outerRateLimitRefusal(request.authId);
  if (outerRefusal) return outerRefusal;

  const body = await readStartBody(request.readJsonBody);
  if (!body.ok) return body.outcome;

  const gate = await evaluateDemoGate(request.authId, request.clientIp);
  if (!gate.ok) return gate.outcome;

  return runActivation(sql, business.value, body.value, gate.value);
}
