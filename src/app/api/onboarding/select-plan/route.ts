import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { sql } from '@/lib/db/server';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import { assertSameOrigin, SameOriginError } from '@/lib/shared/csrf';
import { SelectPlanSchema } from '@/lib/shared/schemas';
import { getIpKey } from '@/lib/shared/request-ip';
import {
  CheckoutOffboardingBlockedError,
  CheckoutUnavailableError,
  createCheckoutSession,
} from '@/lib/payments/create-checkout-session';
import {
  applyTierSnapshot,
  CheckoutAttemptConflictError,
  resolveCheckoutContext,
} from '@/lib/payments/plan-activation';
import { TierNotPurchasableError } from '@/lib/payments/tier-purchasability';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import type { SubscriptionTierValue } from '@/lib/accounts/tier-config';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;

type SelectPlanRequestGate =
  | { kind: 'ok'; tier: SubscriptionTierValue; userId: string }
  | { kind: 'response'; response: NextResponse };

async function validateSelectPlanRequest(
  req: NextRequest,
): Promise<SelectPlanRequestGate> {
  try {
    assertSameOrigin(req);
  } catch (err) {
    if (!(err instanceof SameOriginError)) throw err;
    return {
      kind: 'response',
      response: NextResponse.json(
        { error: 'forbidden' },
        { status: 403, headers: NO_STORE },
      ),
    };
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return {
      kind: 'response',
      response: NextResponse.json(
        { error: 'invalid_json' },
        { status: 400, headers: NO_STORE },
      ),
    };
  }
  const parsed = SelectPlanSchema.safeParse(body);
  if (!parsed.success) {
    return {
      kind: 'response',
      response: NextResponse.json(
        { error: 'invalid_body', issues: parsed.error.issues },
        { status: 400, headers: NO_STORE },
      ),
    };
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return req.cookies.getAll();
        },
        setAll() {
          // Read-only.
        },
      },
    },
  );
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return {
      kind: 'response',
      response: NextResponse.json(
        { error: 'unauthorized' },
        { status: 401, headers: NO_STORE },
      ),
    };
  }

  try {
    const authRl = await checkRateLimit(
      `select-plan:auth:${user.id}`,
      10,
      600,
      { strict: true },
    );
    if (!authRl.allowed) {
      return {
        kind: 'response',
        response: NextResponse.json(
          { error: 'rate_limited' },
          { status: 429, headers: NO_STORE },
        ),
      };
    }
    const ipRl = await checkRateLimit(
      getIpKey(req, 'select-plan'),
      30,
      600,
      { strict: true },
    );
    if (!ipRl.allowed) {
      return {
        kind: 'response',
        response: NextResponse.json(
          { error: 'rate_limited' },
          { status: 429, headers: NO_STORE },
        ),
      };
    }
  } catch (err) {
    reportCaughtError('select-plan', err, { reason: 'rate_limit_strict_failure' });
    return {
      kind: 'response',
      response: NextResponse.json(
        { error: 'rate_limit_unavailable' },
        { status: 503, headers: NO_STORE },
      ),
    };
  }

  return { kind: 'ok', tier: parsed.data.tier, userId: user.id };
}

/**
 * POST /api/onboarding/select-plan
 *
 * Self-serve owner explicitly picks Copilot or Autopilot on /onboarding/pay.
 * We write the choice to `accounts.subscription_tier` BEFORE creating a
 * Stripe Checkout Session, so by the time `checkout.session.completed` fires
 * the DB tier already matches what they paid for. The Stripe webhook still
 * has a `customer.subscription.updated` branch that maps price→tier as a
 * defense-in-depth fallback.
 *
 * The Checkout Session replaces the old Stripe Payment Link flow.
 * VAL-BILLING-031: This handler does NOT reference STRIPE_PAYMENT_LINK_* env vars.
 *
 * Auth: cookie-bound Supabase session. Caller must be the owner of an
 * account in `pending_payment` status. Active / past_due / cancelled
 * are rejected — those states are the dashboard's billing-recovery
 * surface, not a fresh signup. That trio (session, `u.role = 'owner'` at the
 * SQL boundary below, and the `pending_payment` check `applyTierSnapshot`
 * makes while holding the activation lock → 409 `subscription_not_pending`)
 * IS the boundary: this route carries no `SELF_SERVE_SIGNUP_ENABLED` gate,
 * because the flag now means only "strangers may mint accounts"
 * (`docs/superpowers/plans/2026-08-14-admin-invite-funnel-flag-inventory.md`)
 * and an admin-invited owner buys through this same route while it is off.
 *
 * Same-origin: yes — this UPDATEs account state, so a CSRF-driven call
 * with a victim's cookies could flip them to a different tier.
 *
 * Rate-limit: 10/auth-id/10min + 30/IP/10min. The legitimate flow is one
 * click, but the picker stays on screen and someone may double-click; the
 * limits are generous enough that two impatient retries don't trip them.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestGate = await validateSelectPlanRequest(req);
  if (requestGate.kind === 'response') return requestGate.response;
  const { tier, userId } = requestGate;

  // We need the business_id before applyTierSnapshot can take the per-business
  // activation lock, but we don't know it yet — this single round to find it
  // doesn't need locking because applyTierSnapshot re-validates everything once
  // it owns the lock (lock-then-read mechanism documented in its JSDoc).
  // Owner-only filter at the SQL boundary. Proxy does NOT gate
  // `/api/onboarding/*` on role, so an admin session calling this directly
  // would otherwise hit whichever business their account points at via the
  // primary location. Returning 404 on non-owner sessions keeps this an
  // authorization invariant independent of proxy.
  const lookup = await sql<{
    id: string;
    account_id: string;
    owner_email: string;
  }[]>`
    SELECT b.id, a.id AS account_id, b.owner_email
    FROM users u
    JOIN accounts a ON a.id = u.account_id
    JOIN businesses b ON b.account_id = a.id AND b.is_primary = TRUE
    WHERE u.auth_id = ${userId}
      AND u.role = 'owner'
    LIMIT 1
  `;
  if (lookup.length === 0) {
    return NextResponse.json(
      { error: 'account_incomplete' },
      { status: 404, headers: NO_STORE },
    );
  }
  const {
    id: businessId,
    account_id: accountId,
    owner_email: ownerEmail,
  } = lookup[0]!;

  // Freeze the server-authoritative trial decision together with the other
  // caller/environment-dependent Stripe create parameters in the attempt.
  const ctx = await resolveCheckoutContext(sql, businessId);
  if (!ctx) {
    return NextResponse.json(
      { error: 'account_incomplete' },
      { status: 404, headers: NO_STORE },
    );
  }

  let result: Awaited<ReturnType<typeof applyTierSnapshot>>;
  try {
    result = await applyTierSnapshot(sql, {
      accountId,
      activationLockId: businessId,
      tier,
      ownerEmail,
      trial: ctx.trialEligible,
    });
  } catch (err) {
    if (err instanceof TierNotPurchasableError) {
      return NextResponse.json(
        { error: 'tier_unavailable' },
        { status: 409, headers: NO_STORE },
      );
    }
    if (err instanceof CheckoutAttemptConflictError) {
      return NextResponse.json(
        { error: 'checkout_attempt_conflict' },
        { status: 409, headers: NO_STORE },
      );
    }
    throw err;
  }

  if (result.kind === 'not_found') {
    return NextResponse.json(
      { error: 'account_incomplete' },
      { status: 404, headers: NO_STORE },
    );
  }
  if (result.kind === 'offboarding_blocked') {
    return NextResponse.json(
      { error: 'account_offboarding_blocked' },
      { status: 403, headers: NO_STORE },
    );
  }
  if (result.kind === 'wrong_status') {
    return NextResponse.json(
      { error: 'subscription_not_pending', subscriptionStatus: result.status },
      { status: 409, headers: NO_STORE },
    );
  }
  // Create a Stripe Checkout Session instead of a Payment Link URL.
  // The session includes the correct base + overage line items.
  let checkoutUrl: string;
  try {
    const checkout = await createCheckoutSession(
      sql,
      ctx.accountId,
      tier,
      result.variant,
      {
        attemptId: result.attemptId,
        activationLockId: businessId,
      },
    );
    checkoutUrl = checkout.url;
  } catch (err) {
    if (err instanceof TierNotPurchasableError) {
      return NextResponse.json(
        { error: 'tier_unavailable' },
        { status: 409, headers: NO_STORE },
      );
    }
    if (err instanceof CheckoutUnavailableError) {
      // Missing price env vars — same posture as the old payment_link_unavailable.
      return NextResponse.json(
        { error: 'checkout_unavailable', detail: err.message },
        { status: 502, headers: NO_STORE },
      );
    }
    if (err instanceof CheckoutOffboardingBlockedError) {
      return NextResponse.json(
        { error: 'account_offboarding_blocked' },
        { status: 403, headers: NO_STORE },
      );
    }
    if (err instanceof CheckoutAttemptConflictError) {
      return NextResponse.json(
        { error: 'checkout_attempt_conflict' },
        { status: 409, headers: NO_STORE },
      );
    }
    reportCaughtError('select-plan', err, { reason: 'checkout_session_creation_failed', businessId });
    // VAL-BILLING-066: Return 502 with user-facing error for Stripe failures
    return NextResponse.json(
      { error: 'checkout_error', detail: 'Unable to connect to payment provider. Please try again later.' },
      { status: 502, headers: NO_STORE },
    );
  }

  return NextResponse.json({ paymentUrl: checkoutUrl }, { headers: NO_STORE });
}
