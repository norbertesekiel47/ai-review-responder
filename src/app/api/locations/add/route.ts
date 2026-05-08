// src/app/api/locations/add/route.ts
//
// POST /api/locations/add — Adds a new location to an account.
// For active accounts, uses the outbox pattern (no Checkout redirect).
// Gated by MULTI_LOCATION_ENABLED flag.
//
// Validation contract: VAL-BILLING-072.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '@/lib/db/server';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import { TIER_CONFIG, type SubscriptionTierValue } from '@/lib/accounts/tier-config';

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
 *   2. INSERTs an account_audit_log row (event_type='location_created')
 *   3. INSERTs a job_outbox row (topic='update_stripe_overage_quantity')
 *
 * Gated by MULTI_LOCATION_ENABLED — returns 404 when disabled.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  // Gate: MULTI_LOCATION_ENABLED must be true
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

  // Read and lock the account
  const [account] = await sql<{
    id: string;
    subscription_tier: string;
    subscription_status: string;
    locations_included: number;
    locations_paid: number;
  }[]>`
    SELECT id, subscription_tier, subscription_status,
           locations_included, locations_paid
    FROM accounts
    WHERE id = ${accountId}::uuid
    FOR UPDATE
  `;

  if (!account) {
    return NextResponse.json(
      { error: 'account_not_found' },
      { status: 404, headers: NO_STORE },
    );
  }

  // Check subscription is active
  if (account.subscription_status !== SubscriptionStatus.ACTIVE) {
    return NextResponse.json(
      { error: 'subscription_inactive', subscriptionStatus: account.subscription_status },
      { status: 403, headers: NO_STORE },
    );
  }

  // Check tier allows multi-location
  const tierConfig = TIER_CONFIG[account.subscription_tier as SubscriptionTierValue];
  if (!tierConfig || !tierConfig.multiLocAllowed) {
    return NextResponse.json(
      { error: 'tier_disallows_multi_location', tier: account.subscription_tier },
      { status: 403, headers: NO_STORE },
    );
  }

  // Count active locations
  const [locationRow] = await sql<{ count: number }[]>`
    SELECT COUNT(*) AS count
    FROM businesses
    WHERE account_id = ${accountId}::uuid
      AND archived_at IS NULL
  `;
  const activeLocations = Number(locationRow?.count ?? 0);

  // Execute the add-location transaction
  const businessId = uuidv7();

  try {
    await sql.begin(async (tx) => {
      // 1. Insert businesses row
      await tx`
        INSERT INTO businesses (
          id, account_id, is_primary, display_label,
          name, google_place_id, place_id_verified, google_maps_url,
          tone, products_services, staff_names, highlight_facts,
          avoid_facts, sample_responses, owner_name, owner_email,
          subscription_tier, subscription_status
        ) VALUES (
          ${businessId}::uuid,
          ${accountId}::uuid,
          FALSE,
          ${displayLabel},
          ${displayLabel},
          ${googlePlaceId ?? null},
          ${placeIdVerified ?? false},
          ${googleMapsUrl ?? null},
          ${'professional and friendly'},
          ${null},
          ${[]},
          ${[]},
          ${[]},
          ${[]},
          ${null},
          ${null},
          ${account.subscription_tier},
          ${account.subscription_status}
        )
      `;

      // 2. Insert audit log entry
      await tx`
        INSERT INTO account_audit_log (
          id, account_id, location_id, event_type, payload
        ) VALUES (
          ${uuidv7()}::uuid,
          ${accountId}::uuid,
          ${businessId}::uuid,
          'location_created',
          ${jsonb({
            display_label: displayLabel,
            google_place_id: googlePlaceId ?? null,
            active_locations_before: activeLocations,
          })}
        )
      `;

      // 3. Enqueue Stripe overage update (VAL-BILLING-072)
      // For active accounts, use the outbox pattern instead of Checkout redirect
      await tx`
        INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
        VALUES (
          ${uuidv7()},
          'update_stripe_overage_quantity',
          'account',
          ${accountId}::uuid,
          ${jsonb({
            account_id: accountId,
            correlation_id: uuidv7(),
          })},
          'pending'
        )
      `;
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[locations/add] Transaction failed for account=${accountId}: ${message}`);
    return NextResponse.json(
      { error: 'add_location_failed', detail: message },
      { status: 500, headers: NO_STORE },
    );
  }

  return NextResponse.json(
    {
      businessId,
      displayLabel,
      activeLocations: activeLocations + 1,
    },
    { status: 201, headers: NO_STORE },
  );
}
