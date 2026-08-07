import type Stripe from 'stripe';
import { v7 as uuidv7 } from 'uuid';
import { sql } from '../../../src/lib/db/server';
import { QUEUE_NAMES } from '../../../src/lib/shared/queue-names';
import { zernioPublishingEnabled } from '../../../src/lib/publishing/flags';
import { isSubscriptionTier } from '../../../src/lib/accounts/tier-config';
import { createImportOffer, readImportConsent } from '../../../src/lib/reviews/import-consent';
import type { ZernioInitialBackfillPayload } from '../../../src/lib/shared/worker-types';

export const LOG_PREFIX = '[ingress/stripe]';

export { getStripe } from '../../../src/lib/payments/stripe-client';

/**
 * Thrown by subscription.updated/.deleted handlers when no account resolves by
 * stripe_customer_id. accounts.stripe_customer_id is written ONLY by
 * checkout-completed, and Stripe does not guarantee event ordering, so a
 * subscription.* event can arrive BEFORE its checkout.session.completed. This
 * is a deliberate, transient retry signal — NOT a bug: the ingress wrapper maps
 * any throw to status='failed' + HTTP 500 so Stripe redelivers, by which time
 * checkout-completed has written the customer id and the redelivery resolves
 * the account (idempotent via claimInboundEvent + the status-guarded UPDATE). A
 * genuinely orphaned customer (checkout abandoned, account never created)
 * simply retries until Stripe's ~3-day schedule gives up; the hourly reconcile
 * poller is the standing backstop. (deep-scan §6.2)
 */
export class AccountNotProvisionedYetError extends Error {
  constructor(customerId: string) {
    super(
      `No account found for stripe_customer_id=${customerId} — likely a subscription event delivered before checkout.session.completed; signaling retry`,
    );
    this.name = 'AccountNotProvisionedYetError';
  }
}

export function extractCustomerId(customer: string | Stripe.Customer | Stripe.DeletedCustomer | null): string | null {
  if (!customer) return null;
  return typeof customer === 'string' ? customer : customer.id;
}

export function extractSubscriptionId(subscription: string | Stripe.Subscription | null): string | null {
  if (!subscription) return null;
  return typeof subscription === 'string' ? subscription : subscription.id;
}

/**
 * Pull the subscription id off an invoice across Stripe API-version shapes.
 * Newer endpoint versions move it under `parent.subscription_details`; older
 * ones keep a flat `subscription`. Single owner for both invoice handlers
 * (invoice.paid trial-convert + invoice.payment_failed trial card-fail).
 */
export function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const raw = invoice as unknown as {
    subscription?: string | Stripe.Subscription | null;
    parent?: { subscription_details?: { subscription?: string | Stripe.Subscription | null } };
  };
  return extractSubscriptionId(
    raw.subscription ?? raw.parent?.subscription_details?.subscription ?? null,
  );
}

// Canonical UUID 8-4-4-4-12 hex shape — accepts all version digits (we use
// v7 from the `uuid` package, but legacy admin rows may be v4). Same regex
// + reasoning as worker/ingress/twilio/twilio-whatsapp.ts:154.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Auto-recovery: when a business activates AND has an active Zernio
 * connection AND no completed backfill exists yet, enqueue a fresh
 * zernio_initial_backfill outbox row so the worker runs the backfill.
 *
 * Predicate is "no completed run exists" (NOT EXISTS completed_at IS
 * NOT NULL) so the hook covers BOTH:
 *   - past_due → active recovery where a prior worker run inserted a
 *     row but skipped backfill via subscription guard (completed_at
 *     stayed NULL) — the run is retryable via ON CONFLICT DO NOTHING.
 *   - Admin-onboarded business that connected Zernio BEFORE checkout
 *     completed — no zernio_backfill_runs row exists yet because the
 *     connect callback's needs_backfill predicate didn't fire (it
 *     gates on subscription_activated_at IS NOT NULL).
 *
 * In-flight outbox dedup: skips enqueue when a non-terminal
 * zernio_initial_backfill outbox row already exists for the business
 * (avoids re-enqueueing on rapid duplicate webhooks).
 *
 * Invoked OUTSIDE the activation tx — billing flip is the load-bearing
 * mutation, this is best-effort on top.
 *
 * Module-private: every activation handler reaches it through
 * `resumePrimaryBusinessBackfill` (below), which owns the null-skip + best-effort
 * error boundary. Call that, not this, from a handler.
 */
async function maybeEnqueueBackfillResume(businessId: string): Promise<void> {
  // Producer 2 of 4, and the §5.2 fix. This is the OTHER junction ordering: the
  // owner connected Google BEFORE checkout, so activation is the second half to
  // arrive and finalize already ran without a junction to act on.
  //
  // THE WHOLE THING RUNS IN ONE TRANSACTION HOLDING THE businesses ROW LOCK
  // (round-2 F107). Before #677 this path ran on root `sql` with no transaction
  // at all — which meant `createImportOffer` (a TransactionSql helper) had
  // nothing to run in, and the check-then-insert dedup below was unserialized
  // against the other three producers. `SELECT … FOR UPDATE` is a NO-OP outside
  // sql.begin() under Supabase's transaction pooling (CLAUDE.md gotcha), so
  // "mostly safe" was not available as a position.
  //
  // OFFER CREATION SITS BEFORE THE KILL-SWITCH RETURN (round-1 Medium, F106).
  // `zernioPublishingEnabled()` governs PUBLISHING. Skipping durable offer
  // creation behind it would lose the offer with no replay path — the owner would
  // simply never be asked. The publishing gate therefore guards only the enqueue.
  await sql.begin(async (tx) => {
    const [locked] = await tx<{ account_id: string }[]>`
      SELECT account_id
      FROM businesses
      WHERE id = ${businessId}::uuid
        AND archived_at IS NULL
      FOR UPDATE
    `;
    if (!locked) return;

    const [target] = await tx<{
      zernio_account_id: string;
      zernio_location_id: string;
      subscription_tier: string;
      subscription_activated_at: Date;
    }[]>`
      SELECT
        zc.zernio_account_id,
        zc.zernio_location_id,
        a.subscription_tier,
        a.subscription_activated_at
      FROM zernio_connections zc
      JOIN businesses b ON b.id = zc.business_id
      JOIN accounts a ON a.id = b.account_id
      WHERE zc.business_id = ${businessId}::uuid
        AND zc.status = 'active'
        AND b.archived_at IS NULL
        AND a.subscription_status IN ('active', 'trialing')  -- enum: SubscriptionStatus.ACTIVE / .TRIALING
        AND a.subscription_activated_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM zernio_backfill_runs br
          WHERE br.business_id = ${businessId}::uuid
            AND br.completed_at IS NOT NULL
        )
      LIMIT 1
    `;

    if (!target) return;
    if (!isSubscriptionTier(target.subscription_tier)) {
      throw new Error(`invalid_ws8_subscription_tier:${target.subscription_tier}`);
    }

    // The junction is established by the query above (active connection +
    // activated subscription), so this is an offer-creating site.
    await createImportOffer(tx, businessId, locked.account_id);

    if (!zernioPublishingEnabled()) return;

    const consent = await readImportConsent(tx, businessId, locked.account_id);
    if (consent?.state !== 'accepted') {
      console.log(
        `${LOG_PREFIX} Review import not enqueued for business=${businessId} — import consent is ${consent?.state ?? 'unknown'}`,
      );
      return;
    }

    const payload = {
      business_id: businessId,
      zernio_account_id: target.zernio_account_id,
      zernio_location_id: target.zernio_location_id,
      subscription_tier: target.subscription_tier,
      subscription_activated_at: target.subscription_activated_at.toISOString(),
      backfill_reason: 'initial',
      correlation_id: uuidv7(),
    } satisfies ZernioInitialBackfillPayload;

    await tx`
      INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
      SELECT
        ${uuidv7()},
        ${QUEUE_NAMES.ZERNIO_INITIAL_BACKFILL},
        'business',
        ${businessId}::uuid,
        ${tx.json(payload)},
        'pending'
      WHERE NOT EXISTS (
        SELECT 1 FROM job_outbox jo
        WHERE jo.aggregate_id = ${businessId}::uuid
          AND jo.topic = ${QUEUE_NAMES.ZERNIO_INITIAL_BACKFILL}
          AND jo.status IN ('pending', 'dispatching', 'dispatched')
      )
    `;
    console.log(`${LOG_PREFIX} Re-enqueued zernio_initial_backfill for business=${businessId} (post-activation backfill resume)`);
  });
}

/**
 * The single home for the post-commit "subscription became active → resume the
 * Zernio backfill" side effect (issue #266). All four activation paths converge
 * here: invoice.paid past_due-recovery + trial-convert, and
 * checkout.session.completed paid + trial-start.
 *
 * The CALLER resolves WHICH business to resume — the account's primary business
 * in the common case, or the legacy Payment-Link business id for the legacy
 * checkout path — and passes it (or `null` when none resolved). That resolution
 * differs subtly per call site and is deliberately left to the caller; this
 * helper owns only the two things every call site repeated:
 *   - null-skip (no resolved business → nothing to resume), and
 *   - the best-effort error boundary: a resume failure is logged and swallowed
 *     so it can never flip an already-committed activation to `failed` (the
 *     worker best-effort-after-primary-side-effect rule).
 *
 * Always invoked OUTSIDE the activation tx — the billing flip already committed.
 */
export async function resumePrimaryBusinessBackfill(businessId: string | null): Promise<void> {
  if (!businessId) return;
  await maybeEnqueueBackfillResume(businessId).catch((err) => {
    console.error(
      `${LOG_PREFIX} maybeEnqueueBackfillResume failed for business=${businessId}: ${err instanceof Error ? err.message : err}`,
    );
  });
}
