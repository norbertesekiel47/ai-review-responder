import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { sql } from '@/lib/db/server';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import { assertSameOrigin, SameOriginError } from '@/lib/shared/csrf';
import { SelectPlanSchema } from '@/lib/shared/schemas';
import { getIpKey } from '@/lib/shared/request-ip';
import { createCheckoutSession, CheckoutUnavailableError } from '@/lib/payments/create-checkout-session';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;

/**
 * POST /api/onboarding/select-plan
 *
 * Self-serve owner picks a plan (founders | standard | premium) on /onboarding/pay.
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
 * surface, not a fresh signup.
 *
 * Same-origin: yes — this UPDATEs account state, so a CSRF-driven call
 * with a victim's cookies could flip them to a different tier.
 *
 * Rate-limit: 10/auth-id/10min + 30/IP/10min. The legitimate flow is one
 * click, but the picker stays on screen and someone may double-click; the
 * limits are generous enough that two impatient retries don't trip them.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  if (process.env.SELF_SERVE_SIGNUP_ENABLED !== 'true') {
    return NextResponse.json(
      { error: 'not_found' },
      { status: 404, headers: NO_STORE },
    );
  }

  try {
    assertSameOrigin(req);
  } catch (err) {
    if (err instanceof SameOriginError) {
      return NextResponse.json(
        { error: 'forbidden' },
        { status: 403, headers: NO_STORE },
      );
    }
    throw err;
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
  const parsed = SelectPlanSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_body', issues: parsed.error.issues },
      { status: 400, headers: NO_STORE },
    );
  }
  const { tier } = parsed.data;

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
    return NextResponse.json(
      { error: 'unauthorized' },
      { status: 401, headers: NO_STORE },
    );
  }

  try {
    const authRl = await checkRateLimit(
      `select-plan:auth:${user.id}`,
      10,
      600,
      { strict: true },
    );
    if (!authRl.allowed) {
      return NextResponse.json(
        { error: 'rate_limited' },
        { status: 429, headers: NO_STORE },
      );
    }
    const ipRl = await checkRateLimit(
      getIpKey(req, 'select-plan'),
      30,
      600,
      { strict: true },
    );
    if (!ipRl.allowed) {
      return NextResponse.json(
        { error: 'rate_limited' },
        { status: 429, headers: NO_STORE },
      );
    }
  } catch (err) {
    console.error('[select-plan] rate-limit strict failure:', err);
    return NextResponse.json(
      { error: 'rate_limit_unavailable' },
      { status: 503, headers: NO_STORE },
    );
  }

  // Lock-then-read pattern.
  //
  // Earlier version read status BEFORE taking the activation lock and ran
  // an unguarded UPDATE — racing a Stripe activation in the gap between
  // SELECT and lock could let this route return a payment-link URL for
  // an already-active business, prompting the owner to start a duplicate
  // Stripe subscription. Fix: take the activation lock FIRST so any
  // in-flight webhook commits before our re-read; SELECT FOR UPDATE the
  // business row; check status under the lock; verify UPDATE.count > 0.
  //
  // We need the business_id to take the per-business lock, but we don't
  // know it yet — a single round to find it doesn't need locking because
  // we re-validate everything once we own the lock.
  // Owner-only filter at the SQL boundary. Middleware does NOT gate
  // `/api/onboarding/*` on role, so an admin/sales_partner session
  // calling this directly would otherwise hit whichever business their
  // account points at via the primary location. Returning
  // 404 on non-owner sessions keeps this an authorization invariant
  // independent of middleware.
  const lookup = await sql<{ id: string; owner_email: string }[]>`
    SELECT b.id, b.owner_email
    FROM users u
    JOIN accounts a ON a.id = u.account_id
    JOIN businesses b ON b.account_id = a.id AND b.is_primary = TRUE
    WHERE u.auth_id = ${user.id}
      AND u.role = 'owner'
    LIMIT 1
  `;
  if (lookup.length === 0) {
    return NextResponse.json(
      { error: 'account_incomplete' },
      { status: 404, headers: NO_STORE },
    );
  }
  const { id: businessId, owner_email: ownerEmail } = lookup[0]!;

  const result = await sql.begin(async (tx) => {
    // Lock first, THEN re-read state. Any pending Stripe webhook taking the
    // same key (worker/ingress/stripe.ts processCheckoutSessionCompleted)
    // commits before we proceed.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${businessId + ':activation'}))`;

    // Read subscription_status from accounts (source of truth after migration 034).
    // Also lock the accounts row FOR UPDATE to prevent concurrent writes.
    const [row] = await tx<{ subscription_status: string }[]>`
      SELECT a.subscription_status
      FROM accounts a
      JOIN businesses b ON b.account_id = a.id
      WHERE b.id = ${businessId}::uuid
      FOR UPDATE OF a
    `;
    if (!row) {
      // The row vanished between the lookup above and now (e.g., cleanup
      // poller deleted it). Surface as account_incomplete.
      return { kind: 'not_found' as const };
    }
    if (row.subscription_status !== SubscriptionStatus.PENDING_PAYMENT) {
      return {
        kind: 'wrong_status' as const,
        status: row.subscription_status,
      };
    }

    // UPDATE accounts (source of truth) and businesses (deprecated column
    // retained for backward compat per VAL-SCHEMA-037). Verify count > 0
    // as defense-in-depth — if for any reason the WHERE didn't match
    // (status changed inside this same tx, which shouldn't be possible
    // but is the kind of paranoia that catches future refactors), fail
    // loudly rather than handing out a Stripe link.
    const update = await tx`
      UPDATE accounts
      SET subscription_tier = ${tier}, updated_at = NOW()
      WHERE id = (SELECT account_id FROM businesses WHERE id = ${businessId}::uuid)
        AND subscription_status = ${SubscriptionStatus.PENDING_PAYMENT}
    `;
    if (update.count === 0) {
      return { kind: 'race_lost' as const };
    }
    // Also write to businesses.subscription_tier (deprecated, retained).
    await tx`
      UPDATE businesses
      SET subscription_tier = ${tier}, updated_at = NOW()
      WHERE id = ${businessId}::uuid
    `;
    return { kind: 'ok' as const };
  });

  if (result.kind === 'not_found') {
    return NextResponse.json(
      { error: 'account_incomplete' },
      { status: 404, headers: NO_STORE },
    );
  }
  if (result.kind === 'wrong_status') {
    return NextResponse.json(
      { error: 'subscription_not_pending', subscriptionStatus: result.status },
      { status: 409, headers: NO_STORE },
    );
  }
  if (result.kind === 'race_lost') {
    // Status flipped under the lock — extremely unlikely (the lock should
    // serialize against the only other writer, the Stripe webhook) but the
    // honest response is "you're already active, go to dashboard".
    console.warn(
      `[select-plan] UPDATE matched 0 rows for business ${businessId} despite pending_payment check passing — race_lost branch`,
    );
    return NextResponse.json(
      { error: 'subscription_not_pending', subscriptionStatus: 'active' },
      { status: 409, headers: NO_STORE },
    );
  }

  // Create a Stripe Checkout Session instead of a Payment Link URL.
  // The session includes the correct base + overage line items.
  let checkoutUrl: string;
  try {
    // Resolve the account_id for this owner
    const [accountRow] = await sql<{ account_id: string }[]>`
      SELECT account_id FROM businesses WHERE id = ${businessId}::uuid
    `;
    if (!accountRow) {
      return NextResponse.json(
        { error: 'account_incomplete' },
        { status: 404, headers: NO_STORE },
      );
    }

    const result = await createCheckoutSession(accountRow.account_id, tier, ownerEmail);
    checkoutUrl = result.url;
  } catch (err) {
    if (err instanceof CheckoutUnavailableError) {
      // Missing price env vars — same posture as the old payment_link_unavailable.
      return NextResponse.json(
        { error: 'checkout_unavailable', detail: err.message },
        { status: 500, headers: NO_STORE },
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[select-plan] Checkout Session creation failed for business=${businessId}: ${message}`);
    return NextResponse.json(
      { error: 'checkout_error', detail: message },
      { status: 500, headers: NO_STORE },
    );
  }

  return NextResponse.json({ paymentUrl: checkoutUrl }, { headers: NO_STORE });
}
