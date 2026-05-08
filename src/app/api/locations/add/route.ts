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
import { assertCanAddLocation } from '@/lib/accounts/quota';
import { getAccountById, getAccountOwnerUserId } from '@/lib/accounts/repo';
import { addLocationTransaction } from '@/lib/locations/add-location-tx';
import { getActiveLocationCount } from '@/lib/locations/repo';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;

// ── Request schema ─────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const AddLocationSchema = z.object({
  accountId: z.string().regex(UUID_RE, 'Invalid account ID format'),
  displayLabel: z.string().min(1).max(255),
  googlePlaceId: z.string().optional(),
  placeIdVerified: z.boolean().optional().default(false),
  googleMapsUrl: z.string().optional(),
});

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
  // VAL-LOC-041: Gate by MULTI_LOCATION_ENABLED flag
  if (process.env.MULTI_LOCATION_ENABLED !== 'true') {
    return NextResponse.json(
      { error: 'not_found' },
      { status: 404, headers: NO_STORE },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'invalid_json' },
      { status: 400, headers: NO_STORE },
    );
  }

  const parsed = AddLocationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_body', issues: parsed.error.issues },
      { status: 400, headers: NO_STORE },
    );
  }
  const { accountId, displayLabel, googlePlaceId, placeIdVerified, googleMapsUrl } = parsed.data;

  // Use the quota chokepoint — handles SELECT FOR UPDATE, tier check,
  // subscription check, and quota boundary check in one call.
  // Per AGENTS.md: "Never compute quota inline."
  const quotaResult = await assertCanAddLocation(accountId);

  if (!quotaResult.allowed) {
    const statusMap: Record<string, number> = {
      account_not_found: 404,
      subscription_inactive: 403,
      tier_disallows_multi_location: 403,
      quota_exhausted: 409,
    };
    const httpStatus = statusMap[quotaResult.reason] ?? 403;

    return NextResponse.json(
      { error: quotaResult.reason },
      { status: httpStatus, headers: NO_STORE },
    );
  }

  // Gather pre-transaction data needed by addLocationTransaction
  const [activeLocations, account, actorUserId] = await Promise.all([
    getActiveLocationCount(accountId),
    getAccountById(accountId),
    getAccountOwnerUserId(accountId),
  ]);

  if (!account) {
    return NextResponse.json(
      { error: 'account_not_found' },
      { status: 404, headers: NO_STORE },
    );
  }

  // Execute the add-location atomic transaction
  try {
    const result = await addLocationTransaction({
      accountId,
      displayLabel,
      googlePlaceId,
      placeIdVerified,
      googleMapsUrl,
      actorUserId,
      subscriptionTier: account.subscription_tier,
      subscriptionStatus: account.subscription_status,
      activeLocationsBefore: activeLocations,
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
    console.error(`[locations/add] Transaction failed for account=${accountId}: ${message}`);
    return NextResponse.json(
      { error: 'add_location_failed', detail: message },
      { status: 500, headers: NO_STORE },
    );
  }
}
