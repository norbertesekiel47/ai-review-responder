import type Stripe from 'stripe';
import { sql } from '../../../src/lib/db/server';
import { zernioPublishingEnabled } from '../../../src/lib/publishing/flags';
import { isSubscriptionTier } from '../../../src/lib/accounts/tier-config';
import {
  createImportOffer,
  enqueueInitialImport,
  readImportConsent,
} from '../../../src/lib/reviews/import-consent';

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
 * connection AND the owner has ACCEPTED the Import offer, enqueue a fresh
 * zernio_initial_backfill outbox row so the worker runs the import.
 *
 * The enqueue itself — payload, completed-run guard and in-flight dedup — is
 * `enqueueInitialImport` in `src/lib/reviews/import-consent.ts`, shared with the
 * other two consent-honouring producers (round-1 O3). Its completed-run guard is
 * scoped to `run_reason = 'initial'`, which covers BOTH shapes this hook exists
 * for:
 *   - past_due → active recovery where a prior worker run inserted a
 *     row but skipped the import via the subscription guard (completed_at
 *     stayed NULL) — the run is retryable via ON CONFLICT DO NOTHING.
 *   - Admin-onboarded business that connected Zernio BEFORE checkout
 *     completed — no zernio_backfill_runs row exists yet, because at connect
 *     time the account was not activated and the junction had not been reached.
 *
 * What THIS function still owns is the one precondition the shared enqueue does
 * not: the account's subscription must be in a writable status (invariant #11).
 * Activation is what triggers this hook, so the check is defensive — but a
 * webhook replay after a cancellation must not resume an import.
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

    // ELIGIBILITY, not payload. Since round-1 O3 the payload is resolved by
    // `enqueueInitialImport` under this same row lock, and the completed-run
    // guard moved there too — scoped to `run_reason = 'initial'`, which is the
    // A4 fix this copy could not have carried on its own (an unscoped guard let
    // one archive/reactivate cycle suppress the one-time import forever).
    //
    // What remains is the junction plus the one predicate the shared enqueue
    // deliberately does not carry: the writable subscription status.
    //
    // Every tenant key is now bound in a TOP-LEVEL predicate (`zc.business_id`,
    // `b.account_id`, `a.id`) instead of being reached through the JOIN graph,
    // which is why this statement no longer needs the `ci:tenant-scope`
    // allowlist entries the previous shape carried.
    const [eligible] = await tx<{ subscription_tier: string }[]>`
      SELECT a.subscription_tier
      FROM zernio_connections zc
      JOIN businesses b ON b.id = zc.business_id
      JOIN accounts a ON a.id = b.account_id
      WHERE zc.business_id = ${businessId}::uuid
        AND b.account_id = ${locked.account_id}::uuid
        AND a.id = ${locked.account_id}::uuid
        AND zc.status = 'active'
        AND b.archived_at IS NULL
        AND a.subscription_status IN ('active', 'trialing')  -- enum: SubscriptionStatus.ACTIVE / .TRIALING
        AND a.subscription_activated_at IS NOT NULL
      LIMIT 1
    `;

    if (!eligible) return;
    if (!isSubscriptionTier(eligible.subscription_tier)) {
      throw new Error(`invalid_ws8_subscription_tier:${eligible.subscription_tier}`);
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

    await enqueueInitialImport(tx, businessId, locked.account_id);
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
