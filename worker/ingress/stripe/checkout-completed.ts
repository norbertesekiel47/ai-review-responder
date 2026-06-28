import Stripe from 'stripe';
import { sql } from '../../../src/lib/db/server';
import { LOG_PREFIX, extractCustomerId, extractSubscriptionId, UUID_RE, resumePrimaryBusinessBackfill, getStripe } from './shared';
import { applyStripeSubscriptionState, type TransitionResult } from './apply-subscription-state';

export async function processCheckoutSessionCompleted(session: Stripe.Checkout.Session): Promise<void> {
  // The client_reference_id is set by /api/billing/checkout to the account ID.
  // Legacy Payment Links used the business ID instead. We try the account table
  // first (new flow), then fall back to the business table (legacy).
  const refId = session.client_reference_id ?? session.metadata?.business_id;
  if (!refId) {
    console.warn(`${LOG_PREFIX} checkout.session.completed missing client_reference_id — skipping`);
    return;
  }

  // Validate UUID shape BEFORE the `${refId}::uuid` cast inside the tx.
  // Same reasoning as the original guard — malformed IDs would crash the
  // Postgres cast and cause Stripe retries for ~3 days.
  if (!UUID_RE.test(refId)) {
    console.warn(
      `${LOG_PREFIX} checkout.session.completed has malformed ref_id=${JSON.stringify(refId)} — skipping (Stripe will not retry; inbound_events marked processed)`,
    );
    return;
  }

  const customerId = extractCustomerId(session.customer);
  const subscriptionId = extractSubscriptionId(session.subscription as string | Stripe.Subscription | null);

  // Only activate for subscription-mode sessions with confirmed payment
  if (session.mode !== 'subscription') {
    console.warn(`${LOG_PREFIX} checkout.session.completed mode=${session.mode} (not subscription) — skipping activation`);
    return;
  }

  // A card-up-front trial completes Checkout with payment_status
  // 'no_payment_required' ($0 charged now). Accept it alongside 'paid' so the
  // trial-start path below can run; any other payment_status is still a no-op.
  if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') {
    console.warn(`${LOG_PREFIX} checkout.session.completed payment_status=${session.payment_status} (not paid/no_payment_required) — skipping activation for ref ${refId}`);
    return;
  }

  // Resolve whether refId is an account_id (new Checkout Session flow)
  // or a business_id (legacy Payment Link flow).
  let accountId: string | null = null;
  let businessId: string | null = null;

  const [accountLookup] = await sql<{ id: string }[]>`
    SELECT id FROM accounts WHERE id = ${refId}::uuid
  `;
  if (accountLookup) {
    accountId = accountLookup.id;
  } else {
    // Legacy Payment Link flow: refId was a business_id.
    const [bizLookup] = await sql<{ account_id: string }[]>`
      SELECT account_id FROM businesses WHERE id = ${refId}::uuid
    `;
    if (bizLookup) {
      accountId = bizLookup.account_id;
      businessId = refId;
    }
  }

  if (!accountId) {
    console.warn(`${LOG_PREFIX} checkout.session.completed ref_id=${refId} matches neither account nor business — skipping`);
    return;
  }

  // ── Trial-start path ──────────────────────────────────────────────────────
  // A card-up-front trial completes Checkout charging $0 NOW (amount_total === 0)
  // with a status='trialing' subscription. Stripe reports the session's
  // payment_status as EITHER 'paid' OR 'no_payment_required': with
  // payment_method_collection:'always' the $0 subscription_create invoice is
  // auto-finalized 'paid', so we must NOT gate on payment_status — doing so misfiled
  // every real trial as a paid 'active' account (caught by staging E2E, 2026-06-22).
  // Gate on the $0 subscription-mode signal, then retrieve the subscription and
  // project trial-start ONLY if it is genuinely 'trialing' (future trial_end,
  // matching customer). A $0 non-trial session (e.g. a 100%-off coupon → status
  // 'active') retrieves, finds status!='trialing', and falls through to the
  // unchanged inline paid path (plan §4.11). A normal paid session (amount_total>0)
  // skips the retrieve entirely. Worker-side Stripe call is allowed (inv #1).
  if (subscriptionId && (session.amount_total === 0 || session.payment_status === 'no_payment_required')) {
    const trialStarted = await maybeStartTrial(accountId, businessId, customerId, subscriptionId);
    if (trialStarted) return;
  }

  // Subscription-mode sessions always carry a subscription id; without one we
  // cannot persist the identifiers every later webhook needs — skip safely.
  if (!subscriptionId) {
    console.warn(`${LOG_PREFIX} checkout.session.completed for ref ${refId} has no subscription id — skipping activation`);
    return;
  }

  // Single writer for the paid activation (QUALITY-OBS). checkout/by-accountId
  // mode behind the same ':activation' advisory lock. The applier flips
  // pending_payment/past_due→active, COALESCE-fills the Stripe ids
  // (first-writer-wins, invariant #3), clears trial_ends_at/past_due_at, sets
  // subscription_activated_at, writes the audit row, mirrors the primary business
  // (NOTE-A), and enqueues the overage recompute — all in one tx.
  const transition: TransitionResult = await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${accountId! + ':activation'}))`;
    return applyStripeSubscriptionState(
      tx,
      { mode: 'checkout', accountId: accountId! },
      { id: subscriptionId, status: 'active', trial_end: null, customer: customerId },
    );
  });

  // Best-effort backfill resume — only after a real activation.
  if (transition.changed && transition.activated) {
    await resumePrimaryBusinessBackfill(businessId ?? transition.primaryBusinessId);
  }
}

/**
 * Trial-start sub-path for checkout.session.completed.
 *
 * Retrieves the Checkout Session's subscription and, when it is a genuine
 * card-up-front trial (status='trialing', future trial_end, customer matches the
 * session), projects trial-start onto the account via the single applier in
 * checkout mode (in a tx, behind the same ':activation' advisory lock as the
 * paid path), then runs best-effort post-commit backfill resume.
 *
 * Returns:
 *   - true  → the retrieved subscription is `trialing` (handled here; the caller
 *             MUST NOT fall through to the inline paid activation, which would
 *             mis-flip a trialing sub to 'active'). This holds even for an
 *             invalid trial (past trial_end / customer mismatch), which is a
 *             logged no-op.
 *   - false → not a trial (e.g. retrieved status 'active'); the caller proceeds
 *             with the unchanged inline paid activation.
 */
async function maybeStartTrial(
  accountId: string,
  knownBusinessId: string | null,
  customerId: string | null,
  subscriptionId: string,
): Promise<boolean> {
  // Only called for $0 subscription-mode sessions (trial candidates — amount_total
  // === 0 or payment_status 'no_payment_required'). A retrieve
  // failure here means we cannot confirm the (probable) trial — throw so the
  // ingress wrapper replies 500 and Stripe redelivers (idempotent via the
  // applier's status-guarded write).
  const subscription = await getStripe().subscriptions.retrieve(subscriptionId);

  if (subscription.status !== 'trialing') {
    return false; // not a trial → caller proceeds with inline paid activation
  }

  // From here the subscription IS trialing — never fall through to paid path.
  const subCustomerId = extractCustomerId(subscription.customer);
  if (customerId && subCustomerId && subCustomerId !== customerId) {
    console.warn(`${LOG_PREFIX} checkout.session.completed trialing subscription=${subscriptionId} customer ${subCustomerId} != session customer ${customerId} — skipping`);
    return true;
  }

  const trialEnd = subscription.trial_end;
  if (typeof trialEnd !== 'number' || trialEnd <= Math.floor(Date.now() / 1000)) {
    console.warn(`${LOG_PREFIX} checkout.session.completed trialing subscription=${subscriptionId} has no future trial_end (${trialEnd}) — skipping`);
    return true;
  }

  const transition: TransitionResult = await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${accountId + ':activation'}))`;
    return applyStripeSubscriptionState(
      tx,
      { mode: 'checkout', accountId },
      subscription,
    );
  });

  if (transition.changed && transition.activated) {
    await resumePrimaryBusinessBackfill(knownBusinessId ?? transition.primaryBusinessId);
  }
  return true;
}
