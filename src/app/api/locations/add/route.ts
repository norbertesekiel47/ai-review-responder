// src/app/api/locations/add/route.ts
//
// POST /api/locations/add — Adds a new location to an account.
// For active accounts, uses the outbox pattern (no Checkout redirect).
// Gated by MULTI_LOCATION_ENABLED flag.
//
// Validation contract: VAL-BILLING-072, VAL-LOC-007, VAL-LOC-008,
// VAL-LOC-024, VAL-LOC-031, VAL-LOC-036, VAL-LOC-041.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { sql } from '@/lib/db/server';
import { createOffboardingGate, isBillingMutationBlocked } from '@/lib/account-offboarding/gate';
import { assertCanAddLocation } from '@/lib/accounts/quota';
import { getAccountById, getAccountOwnerUserId } from '@/lib/accounts/repo';
import { addLocationTransaction } from '@/lib/locations/add-location-tx';
import { getActiveLocationCount } from '@/lib/locations/repo';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { isSubscriptionTier } from '@/lib/accounts/tier-config';
import {
  locationDenialResponse,
  LOCATION_ROUTE_NO_STORE as NO_STORE,
  ownerAccountMismatchResponse,
  readLocationRouteJson,
  readOwnerForMultiLocationRoute,
  UUID_RE,
} from '@/lib/locations/owner-route';

export const dynamic = 'force-dynamic';

// ── Request schema ─────────────────────────────────────────────────────────

const AddLocationSchema = z.object({
  accountId: z.string().regex(UUID_RE, 'Invalid account ID format'),
  displayLabel: z.string().min(1).max(255),
  // Trimmed + non-empty: '' is NOT nullish, so an untrimmed/empty value would
  // participate in businesses_account_place_uniq ('' collides with '') while
  // ' ChIJx' would slip past it. Normalization owner is the server.
  googlePlaceId: z.string().trim().min(1).optional(),
  placeIdVerified: z.boolean().optional().default(false),
  googleMapsUrl: z.string().optional(),
  // Optional voice config overrides. When provided, these values are used
  // instead of cloning from the primary location. The wizard sends these
  // when the user picks "copy from existing" or manually edits the config.
  voiceConfig: z.object({
    tone: z.string().optional(),
    productsServices: z.string().nullable().optional(),
    avoidFacts: z.array(z.string()).optional(),
    sampleResponses: z.array(z.string()).optional(),
  }).optional(),
}).refine((d) => !d.placeIdVerified || !!d.googlePlaceId, {
  message: 'placeIdVerified requires googlePlaceId',
  path: ['placeIdVerified'],
}).refine((d) => !(d.googlePlaceId && d.googleMapsUrl), {
  // Two input modes, never both: an explicit place id with a Maps URL is
  // ambiguous — the URL would later resolve and could silently overwrite the
  // supplied place id. The wizard sends exactly one of the two.
  message: 'googlePlaceId and googleMapsUrl are mutually exclusive',
  path: ['googleMapsUrl'],
});

// Maps quota-denial reasons to HTTP status codes.
const QUOTA_DENIAL_STATUS: Record<string, number> = {
  account_not_found: 404,
  subscription_inactive: 403,
  tier_disallows_multi_location: 403,
  quota_exhausted: 409,
};

// ── Handler ─────────────────────────────────────────────────────────────────

/**
 * POST /api/locations/add
 *
 * Adds a new location to an account. For already-active accounts, this
 * enqueues an update_stripe_overage_quantity outbox job instead of creating
 * a new Checkout Session (VAL-BILLING-072).
 *
 * The add-location transaction atomically:
 *   1. INSERTs a businesses row (account_id, is_primary=FALSE, display_label)
 *   2. INSERTs an account_audit_log row (event_type='location_created', actor_user_id)
 *   3. INSERTs a job_outbox row (topic='update_stripe_overage_quantity')
 * Voice config is cloned from the primary location at creation time (VAL-LOC-031).
 *
 * Gated by MULTI_LOCATION_ENABLED — returns 404 when disabled (VAL-LOC-041).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const offboardingGate = createOffboardingGate(sql);
  const owner = await readOwnerForMultiLocationRoute(sql, req, offboardingGate);
  if (!owner.ok) return owner.response;
  const { user } = owner;

  const body = await readLocationRouteJson(req, AddLocationSchema);
  if (!body.ok) return body.response;
  const { accountId, displayLabel, googlePlaceId, placeIdVerified, googleMapsUrl, voiceConfig } = body.data;

  // ── Ownership: body.accountId must match authenticated user ──────────────
  if (accountId !== user.accountId) {
    return ownerAccountMismatchResponse();
  }

  const offboardingState = await offboardingGate.getOffboardingState(accountId);
  if (isBillingMutationBlocked(offboardingState)) {
    return NextResponse.json(
      { error: 'account_offboarding_blocked' },
      { status: 403, headers: NO_STORE },
    );
  }

  // Use the quota chokepoint for tier, subscription, and overage preview.
  // Per AGENTS.md: "Never compute quota inline."
  const quotaResult = await assertCanAddLocation(sql, accountId);

  if (!quotaResult.allowed) {
    const httpStatus = QUOTA_DENIAL_STATUS[quotaResult.reason] ?? 403;

    return NextResponse.json(
      { error: quotaResult.reason },
      { status: httpStatus, headers: NO_STORE },
    );
  }

  // Gather pre-transaction data needed by addLocationTransaction.
  // Fixed width 3 on a customer-visible WRITE path — deliberately NOT
  // sequentialised (spec 2026-08-15-portal-audit-remediation-design.md §3.6):
  // serialising it adds latency to a write for no safety gain.
  const [activeLocations, account, actorUserId] = await Promise.all([
    getActiveLocationCount(sql, accountId),
    getAccountById(sql, accountId),
    getAccountOwnerUserId(sql, accountId),
  ]);

  if (!account) {
    return NextResponse.json(
      { error: 'account_not_found' },
      { status: 404, headers: NO_STORE },
    );
  }
  if (!isSubscriptionTier(account.subscription_tier)) {
    return NextResponse.json(
      { error: 'account_invalid_subscription_tier' },
      { status: 500, headers: NO_STORE },
    );
  }

  // Execute the add-location atomic transaction
  try {
    const result = await addLocationTransaction(sql, {
      accountId,
      displayLabel,
      googlePlaceId,
      placeIdVerified,
      googleMapsUrl,
      actorUserId,
      ownerName: user.name,
      ownerEmail: user.email,
      subscriptionTier: account.subscription_tier,
      subscriptionStatus: account.subscription_status,
      activeLocationsBefore: activeLocations,
      voiceConfig: voiceConfig ?? undefined,
    });

    return NextResponse.json(
      {
        businessId: result.businessId,
        displayLabel: result.displayLabel,
        voiceClonedFromPrimary: result.voiceClonedFromPrimary,
        activeLocations: activeLocations + 1,
        overageUnits: quotaResult.overageUnits,
      },
      { status: 201, headers: NO_STORE },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reportCaughtError('locations/add', err, { accountId });
    // duplicate_location (active-duplicate google_place_id, migration 062) → 409.
    const denial = locationDenialResponse(message);
    if (denial) return denial;
    return NextResponse.json(
      { error: 'add_location_failed' },
      { status: 500, headers: NO_STORE },
    );
  }
}
