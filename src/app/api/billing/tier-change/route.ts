// src/app/api/billing/tier-change/route.ts
//
// POST /api/billing/tier-change — Changes the account's subscription tier.
// Parses + authorizes the request, calls validateTierChange / applyTierChange
// (src/lib/accounts/tier-change.ts owns the tier-change concept), and maps
// outcomes to HTTP. No business logic lives here.
//
// VAL-BILLING-073: Tier change UI renders downgrade confirmation modal
// with new billing summary.

import { v7 as uuidv7 } from 'uuid';
import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { sql } from '@/lib/db/server';
import { getOffboardingState, isBillingMutationBlocked } from '@/lib/account-offboarding/gate';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';
import {
  validateTierChange,
  applyTierChange,
  type TierChangeFailureCode,
} from '@/lib/accounts/tier-change';
import { isSubscriptionTier, type SubscriptionTierValue } from '@/lib/accounts/tier-config';
import { requireOwnerWithAccount, withSameOrigin } from '@/lib/auth/route-helpers';

export const dynamic = 'force-dynamic';

// ── Request schema ─────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TierChangeSchema = z.object({
  accountId: z.string().regex(UUID_RE, 'Invalid account ID format'),
  newTier: z.string().refine(isSubscriptionTier, {
    message: 'Invalid subscription tier',
  }),
  preview: z.boolean().optional().default(false),
});

function normalizeIdempotencyKey(raw: string | null): string {
  const source = raw && raw.trim().length > 0 ? raw.trim() : uuidv7();
  const safe = source.replace(/[^a-zA-Z0-9_-]/g, '-');
  if (safe.length > 0 && safe.length <= 96) return safe;
  return createHash('sha256').update(source).digest('hex');
}

const FAILURE_STATUS: Record<TierChangeFailureCode, number> = {
  no_stripe_subscription: 400,
  missing_price_config: 500,
  base_item_not_found: 500,
  ambiguous_overage_item: 500,
  tier_change_failed: 502,
};

// ── Handler ─────────────────────────────────────────────────────────────────

async function changeBillingTier(req: NextRequest): Promise<NextResponse> {
  const owner = await requireOwnerWithAccount(req);
  if (!owner.ok) return owner.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400, headers: NO_STORE_HEADERS });
  }

  const parsed = TierChangeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_body', issues: parsed.error.issues },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  const { accountId, newTier, preview } = parsed.data;
  const tier = newTier as SubscriptionTierValue;

  // ── Ownership: body.accountId must match authenticated user ──────────────
  if (accountId !== owner.accountId) {
    return NextResponse.json(
      { error: 'Account ID mismatch' },
      { status: 403, headers: NO_STORE_HEADERS },
    );
  }

  const offboardingState = await getOffboardingState(accountId, sql);
  if (isBillingMutationBlocked(offboardingState)) {
    return NextResponse.json(
      { error: 'account_offboarding_blocked' },
      { status: 403, headers: NO_STORE_HEADERS },
    );
  }

  const validation = await validateTierChange(sql, accountId, tier);
  if (!validation.allowed) {
    return NextResponse.json(
      { error: validation.reason ?? 'tier_change_not_allowed' },
      { status: 409, headers: NO_STORE_HEADERS },
    );
  }

  if (preview) {
    return NextResponse.json(
      {
        success: true,
        preview: true,
        newTier: tier,
        newBilling: validation.newBillingPreview,
      },
      { status: 200, headers: NO_STORE_HEADERS },
    );
  }

  const outcome = await applyTierChange(sql, {
    accountId,
    tier,
    newOverageUnits: validation.newBillingPreview?.overageUnits ?? 0,
    operationKey: normalizeIdempotencyKey(req.headers.get('Idempotency-Key')),
  });

  if (!outcome.ok) {
    return NextResponse.json(
      { error: outcome.code, detail: outcome.detail },
      { status: FAILURE_STATUS[outcome.code], headers: NO_STORE_HEADERS },
    );
  }

  return NextResponse.json(
    {
      success: true,
      newTier: tier,
      newBilling: validation.newBillingPreview,
    },
    { status: 200, headers: NO_STORE_HEADERS },
  );
}

export const POST = withSameOrigin()(changeBillingTier);
