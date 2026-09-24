// src/lib/dashboard/subscription-gate.ts
//
// The GET /api/dashboard read (#1368): scope resolution, the IDOR/archived
// preflight, the subscription-gating ladder and the payload fetch, extracted
// from the route so the route only parses, calls `readGatedDashboard`, and
// serializes. Returns a plain `{ status, body }` — the route turns it into a
// no-store JSON response — so these rules are tested without route ceremony.
//
// The ladder (`classifySubscriptionGate`) is written ONCE for both scopes;
// before #1368 the per-location and aggregate paths each spelled it by hand.
// The two scopes still differ at the last rung on purpose (pre-#1368
// behavior, preserved byte-for-byte): aggregate answers `no_access` with the
// bare status, per-location has no such rung and renders the payload.
//
// Takes `sql` as a parameter (invariant #15); statements run sequentially
// (`ci:pool-fanout`).

import type { Sql } from 'postgres';
import {
  SubscriptionStatus,
  subscriptionGrantsFullAccess,
} from '@/lib/shared/subscription-status';
import {
  getActiveDashboardData,
  BusinessNotFoundError,
} from '@/lib/dashboard/service';
import { getAggregateDashboardData } from '@/lib/dashboard/aggregate-service';
import { isValidUuid } from '@/lib/shared/ids';
import {
  computePastDueRecoveryState,
  type AccountFlagsInput,
} from '@/lib/shared/past-due-recovery';
import { resolveCancellationGraceState } from '@/lib/shared/cancellation-grace';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import type { DashboardWindow } from '@/lib/kpi/types';
import { onboardingDemoEnabled } from '@/lib/onboarding/flags';
import { resolveFunnelEntry } from '@/lib/onboarding/funnel-entry';

/** The resolved `?scope=` (the route's `DashboardScopePolicy` aliases this). */
export type DashboardReadScope =
  | { mode: 'aggregate' }
  | { mode: 'location'; locationId: string | null };

/** A JSON body and its HTTP status; errors are `{ error: <message> }`. */
export interface DashboardReadResult {
  status: number;
  body: Record<string, unknown>;
}

function ok(body: Record<string, unknown>): DashboardReadResult {
  return { status: 200, body };
}

function fail(message: string, status: number): DashboardReadResult {
  return { status, body: { error: message } };
}

export type SubscriptionGateRung =
  | typeof SubscriptionStatus.PENDING_PAYMENT
  | typeof SubscriptionStatus.CANCELLED
  | typeof SubscriptionStatus.PAST_DUE
  | 'full_access'
  | 'no_access';

/**
 * The subscription-gating ladder, in precedence order. `past_due` is branched
 * on before `subscriptionGrantsFullAccess` is consulted (that predicate's own
 * contract); `no_access` is an off-vocabulary status.
 */
export function classifySubscriptionGate(subscriptionStatus: string): SubscriptionGateRung {
  if (subscriptionStatus === SubscriptionStatus.PENDING_PAYMENT) return SubscriptionStatus.PENDING_PAYMENT;
  if (subscriptionStatus === SubscriptionStatus.CANCELLED) return SubscriptionStatus.CANCELLED;
  if (subscriptionStatus === SubscriptionStatus.PAST_DUE) return SubscriptionStatus.PAST_DUE;
  return subscriptionGrantsFullAccess(subscriptionStatus) ? 'full_access' : 'no_access';
}

/**
 * The single per-location preflight row: business + account columns for the
 * IDOR/archived checks and subscription gates, PLUS every DashboardBusinessRow
 * field so the row can be passed straight into getActiveDashboardData
 * (skipping its internal business query). One round trip instead of three
 * (getLocationById + subRow + service business query).
 */
interface LocationAccountRow {
  account_id: string;
  name: string;
  subscription_status: string;
  subscription_tier: string;
  owner_email: string | null;
  place_id_verified: boolean;
  google_maps_url: string | null;
  onboarding_wizard_completed_at: Date | null;
  archived_at: Date | null;
  past_due_at: Date | string | null;
  trial_ends_at: Date | string | null;
  flags: AccountFlagsInput;
  stripe_customer_id: string | null;
  created_at: Date;
  initial_review_count: number | null;
  initial_responded_count: number | null;
  baseline_captured_at: Date | string | null;
  tone: string | null;
  products_services: string | null;
  avoid_facts: unknown;
  sample_responses: unknown;
  owner_phone: string | null;
  weekly_summary_enabled: boolean | null;
  monthly_impact_enabled: boolean | null;
  category: string | null;
  google_place_id: string | null;
}

interface AggregateAccountRow {
  subscription_status: string;
  past_due_at: Date | string | null;
  trial_ends_at: Date | string | null;
  flags: AccountFlagsInput;
  stripe_customer_id: string | null;
  // Funnel-entry inputs (`resolveFunnelEntry`) for the pending_payment branch.
  // The place columns come from the account's PRIMARY business — an aggregate
  // scope has no single location, and the funnel is a per-account journey.
  // Null when the account somehow has no primary row; that reads as "no place",
  // which routes to the location-capture step.
  onboarding_wizard_completed_at: Date | null;
  place_id_verified: boolean | null;
  google_maps_url: string | null;
}

/** Normalize a Postgres.js timestamp (Date or string) to an ISO string or null. */
function toIsoOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** ISO trial-end, non-null only while trialing (trial_ends_at ⟺ status='trialing'). */
function trialEndsAtIso(
  subscriptionStatus: string,
  trialEndsAt: Date | string | null,
): string | null {
  return subscriptionStatus === SubscriptionStatus.TRIALING ? toIsoOrNull(trialEndsAt) : null;
}

/**
 * `funnelUrl` for the pending_payment rung, server-computed
 * (`resolveFunnelEntry`) rather than a hardcoded `/onboarding/pay`, so an
 * owner owed the pre-pay demo gets it instead of the paywall. Relative path —
 * same-origin by construction. Admin-invited owners walk the same funnel
 * (the old `pending_payment_admin_handoff` view-state is gone).
 */
function pendingPaymentFunnelUrl(row: {
  subscription_status: string;
  place_id_verified: boolean | null;
  google_maps_url: string | null;
  onboarding_wizard_completed_at: Date | null;
}): string {
  return resolveFunnelEntry({
    subscriptionStatus: row.subscription_status,
    demoEnabled: onboardingDemoEnabled(),
    hasPlace: (row.place_id_verified ?? false) || row.google_maps_url !== null,
    wizardCompleted: row.onboarding_wizard_completed_at !== null,
  });
}

/**
 * Past-due billing fields shared by both scopes (VAL-CROSS-012): the portal
 * link when a Stripe customer exists, plus the serialized recovery state.
 */
function pastDueBillingFields(row: {
  subscription_status: string;
  past_due_at: Date | string | null;
  flags: AccountFlagsInput;
  stripe_customer_id: string | null;
}) {
  const billingPortalUrl = row.stripe_customer_id ? `/api/billing/portal` : null;
  const recovery = computePastDueRecoveryState({
    subscriptionStatus: row.subscription_status,
    pastDueAt: row.past_due_at,
    accountFlags: row.flags,
  });
  return {
    billingPortalUrl,
    recovery: {
      pastDueAt: recovery.pastDueAt?.toISOString() ?? null,
      pastDueDeadline: recovery.deadline?.toISOString() ?? null,
      daysRemaining: recovery.daysRemaining,
      isReadOnly: recovery.isReadOnly,
    },
  };
}

/**
 * Cancelled-account grace-period body, shared by both scopes (VAL-CROSS-011).
 * Grace runs `CANCELLATION_GRACE_DAYS` from `cancelled_at` — the ONLY clock
 * (#1455); clock resolution and the NULL fail-safe (indefinite grace) live in
 * `resolveCancellationGraceState` (`src/lib/shared/cancellation-grace.ts`),
 * the owner CancellationGracePoller also reads (#1371).
 */
async function cancelledGraceBody(
  sql: Sql,
  accountId: string,
  businessName: string,
): Promise<DashboardReadResult> {
  const [cancelledRow] = await sql<{
    cancelled_at: Date | null;
  }[]>`
    SELECT cancelled_at FROM accounts WHERE id = ${accountId}::uuid
  `;
  const { gracePeriodEnd, readAccess } = resolveCancellationGraceState(
    cancelledRow?.cancelled_at ? new Date(cancelledRow.cancelled_at) : null,
  );
  return ok({
    subscriptionStatus: SubscriptionStatus.CANCELLED,
    businessName,
    gracePeriodEndDate: gracePeriodEnd?.toISOString() ?? null,
    readAccess,
  });
}

// ── Per-location scope ───────────────────────────────────────────────────

/**
 * Fetches the preflight row by location id ONLY (no account filter) so the
 * caller can distinguish not-found (fallback/404) from wrong-account (403).
 */
async function fetchLocationAccountRow(
  sql: Sql,
  locationId: string,
): Promise<LocationAccountRow | null> {
  const [row] = await sql<LocationAccountRow[]>`
    SELECT b.account_id, b.name, a.subscription_status, a.subscription_tier,
           b.owner_email,
           b.place_id_verified, b.google_maps_url,
           a.onboarding_wizard_completed_at,
           b.archived_at,
           a.past_due_at, a.trial_ends_at, a.flags, a.stripe_customer_id,
           b.created_at, b.initial_review_count, b.initial_responded_count,
           b.baseline_captured_at, b.tone, b.products_services, b.avoid_facts,
           b.sample_responses, b.owner_phone,
           a.weekly_summary_enabled, a.monthly_impact_enabled,
           b.category, b.google_place_id
    FROM businesses b
    JOIN accounts a ON a.id = b.account_id
    WHERE b.id = ${locationId}
  `;
  return row ?? null;
}

/** Returns the primary (or first active) location ID for an account. */
async function getPrimaryLocationId(sql: Sql, accountId: string): Promise<string | null> {
  const [row] = await sql<{ id: string }[]>`
    SELECT id FROM businesses
    WHERE account_id = ${accountId}::uuid
      AND archived_at IS NULL
    ORDER BY is_primary DESC, created_at ASC
    LIMIT 1
  `;
  return row?.id ?? null;
}

type ScopeFallback = { scopeFallback: { reason: string; fallbackLocationId: string } };

/**
 * Renders per-location data from an already-fetched preflight row through the
 * ladder. Callers own the not-found / IDOR / archived checks on `subRow`.
 */
async function renderPerLocation(
  sql: Sql,
  subRow: LocationAccountRow,
  locationId: string,
  accountId: string,
  window: DashboardWindow,
  fallback?: ScopeFallback,
): Promise<DashboardReadResult> {
  const rung = classifySubscriptionGate(subRow.subscription_status);

  if (rung === SubscriptionStatus.PENDING_PAYMENT) {
    return ok({
      subscriptionStatus: SubscriptionStatus.PENDING_PAYMENT,
      locationId,
      businessName: subRow.name,
      funnelUrl: pendingPaymentFunnelUrl(subRow),
    });
  }

  // VAL-CROSS-011: Cancelled account — 30-day grace period for read access
  if (rung === SubscriptionStatus.CANCELLED) {
    return cancelledGraceBody(sql, accountId, subRow.name);
  }

  // The preflight row doubles as the service's business row; reputation
  // metrics are requested so DashboardContent renders the reputation hero.
  const activeData = () => getActiveDashboardData(sql, locationId, {
    includeReputationMetrics: true,
    window,
    business: subRow,
  });

  // VAL-CROSS-012: Past-due account — payment warning, features continue during grace
  if (rung === SubscriptionStatus.PAST_DUE) {
    const { billingPortalUrl, recovery } = pastDueBillingFields(subRow);
    const data = await activeData();
    return ok({
      ...data,
      subscriptionStatus: SubscriptionStatus.PAST_DUE,
      accountId,
      businessName: subRow.name,
      billingPortalUrl,
      ...recovery,
    });
  }

  // Active/trialing owner who skipped or never reached the /onboarding/business
  // wizard: a CTA-only screen instead of the empty-state dashboard.
  if (rung === 'full_access' && !subRow.place_id_verified && subRow.google_maps_url === null) {
    return ok({
      subscriptionStatus: 'active_pending_business',
      locationId,
      businessName: subRow.name,
    });
  }

  const data = await activeData();
  const trialEndsAt = trialEndsAtIso(subRow.subscription_status, subRow.trial_ends_at);

  // VAL-DASH-029: Attach scopeFallback indicator if a fallback occurred
  if (fallback) {
    return ok({ ...data, trialEndsAt, ...fallback });
  }
  return ok({ ...data, trialEndsAt });
}

/**
 * Resolve the account's primary location and serve its dashboard as a scope
 * fallback (VAL-DASH-029). Null when there is no usable primary, so the caller
 * returns its own not-available error.
 */
async function fallbackToPrimary(
  sql: Sql,
  accountId: string,
  window: DashboardWindow,
  reason: 'location_not_found' | 'location_archived',
  excludeLocationId?: string,
): Promise<DashboardReadResult | null> {
  const primary = await getPrimaryLocationId(sql, accountId);
  if (!primary || primary === excludeLocationId) return null;
  const subRow = await fetchLocationAccountRow(sql, primary);
  // getPrimaryLocationId already filtered to this account's active locations,
  // so a missing/archived row here is a sub-millisecond TOCTOU race — treat it
  // as "no usable primary" and let the caller return its own error.
  if (!subRow || subRow.account_id !== accountId || subRow.archived_at !== null) return null;
  return renderPerLocation(sql, subRow, primary, accountId, window, {
    scopeFallback: { reason, fallbackLocationId: primary },
  });
}

async function readPerLocation(
  sql: Sql,
  locationId: string,
  accountId: string,
  window: DashboardWindow,
): Promise<DashboardReadResult> {
  // Validate BEFORE the DB read so a malformed `?scope=` is a controlled 400,
  // not a Postgres `::uuid` cast error surfaced as a 500.
  if (!isValidUuid(locationId)) {
    return fail('Invalid scope: location must be a valid UUID', 400);
  }

  try {
    const subRow = await fetchLocationAccountRow(sql, locationId);

    if (!subRow) {
      const fallback = await fallbackToPrimary(sql, accountId, window, 'location_not_found');
      return fallback ?? fail('Business not found', 404);
    }

    // IDOR protection: the row was fetched via service-role SQL (bypasses
    // RLS), so account ownership must be checked before returning any data.
    if (subRow.account_id !== accountId) {
      return fail('Not authorized to access this location', 403);
    }

    if (subRow.archived_at !== null) {
      const fallback = await fallbackToPrimary(sql, accountId, window, 'location_archived', locationId);
      return fallback ?? fail('No active location available', 404);
    }

    // `return await`, not `return` (#1475): a bare returned promise rejects
    // outside this try, so a failed direct render (payload read,
    // cancelled-clock read) skipped the 404 mapping and the JSON 500 below.
    return await renderPerLocation(sql, subRow, locationId, accountId, window);
  } catch (error) {
    if (error instanceof BusinessNotFoundError) {
      return fail('Business not found', 404);
    }
    reportCaughtError('api/dashboard', error, { accountId, locationId });
    return fail('Failed to fetch dashboard data', 500);
  }
}

// ── Aggregate scope (scope=all) ──────────────────────────────────────────

async function readAggregate(
  sql: Sql,
  accountId: string,
  window: DashboardWindow,
): Promise<DashboardReadResult> {
  try {
    const [accountRow] = await sql<AggregateAccountRow[]>`
      SELECT a.subscription_status, a.past_due_at, a.trial_ends_at, a.flags,
             a.stripe_customer_id, a.onboarding_wizard_completed_at,
             b.place_id_verified, b.google_maps_url
      FROM accounts a
      -- archived_at IS NULL is NOT optional. Migration 034 enforces primary
      -- uniqueness with a PARTIAL index (businesses_account_primary_uniq,
      -- WHERE is_primary = TRUE AND archived_at IS NULL), so an account that
      -- archived its original primary legitimately holds SEVERAL
      -- is_primary = TRUE rows and exactly one live one. Without this
      -- predicate the join fans out and the single-row destructure below
      -- resolves funnelUrl, past_due_at, flags and stripe_customer_id from an
      -- arbitrary, possibly archived location. The primary-business subquery
      -- in plan-activation.ts spells the same concept correctly; keep the two
      -- in step.
      LEFT JOIN businesses b
        ON b.account_id = a.id
       AND b.is_primary = TRUE
       AND b.archived_at IS NULL
      WHERE a.id = ${accountId}::uuid
    `;
    if (!accountRow) {
      return fail('Account not found', 404);
    }

    const rung = classifySubscriptionGate(accountRow.subscription_status);

    if (rung === SubscriptionStatus.PENDING_PAYMENT) {
      return ok({
        subscriptionStatus: SubscriptionStatus.PENDING_PAYMENT,
        businessName: 'Account',
        funnelUrl: pendingPaymentFunnelUrl(accountRow),
      });
    }

    // VAL-CROSS-011: Cancelled account in aggregate mode
    if (rung === SubscriptionStatus.CANCELLED) {
      return await cancelledGraceBody(sql, accountId, 'Account');
    }

    // VAL-CROSS-012: Past-due account in aggregate mode
    if (rung === SubscriptionStatus.PAST_DUE) {
      const { billingPortalUrl, recovery } = pastDueBillingFields(accountRow);
      const data = await getAggregateDashboardData(sql, accountId, window);
      return ok({
        ...data,
        subscriptionStatus: SubscriptionStatus.PAST_DUE,
        businessName: 'Account',
        accountId,
        billingPortalUrl,
        ...recovery,
      });
    }

    if (rung === 'no_access') {
      return ok({ subscriptionStatus: accountRow.subscription_status });
    }

    const trialEndsAt = trialEndsAtIso(accountRow.subscription_status, accountRow.trial_ends_at);
    const data = await getAggregateDashboardData(sql, accountId, window);
    return ok({ ...data, trialEndsAt });
  } catch (error) {
    reportCaughtError('api/dashboard', error, { accountId, scope: 'aggregate' });
    return fail('Failed to fetch aggregate dashboard data', 500);
  }
}

/**
 * The whole GET /api/dashboard read for an authenticated owner: aggregate
 * (`scope=all`) or one location with IDOR ownership, archived/not-found
 * fallback to the primary, and the subscription ladder. Never throws for a
 * data fault — failures are reported and mapped to a 500 result.
 */
export async function readGatedDashboard(
  sql: Sql,
  input: { accountId: string; window: DashboardWindow; scope: DashboardReadScope },
): Promise<DashboardReadResult> {
  if (input.scope.mode === 'aggregate') {
    return readAggregate(sql, input.accountId, input.window);
  }
  const locationId = input.scope.locationId;
  if (!locationId) {
    return fail('No business associated with this account', 403);
  }
  return readPerLocation(sql, locationId, input.accountId, input.window);
}
