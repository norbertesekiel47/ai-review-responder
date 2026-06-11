// worker/jobs/billing/overage-sync.ts
//
// The Stripe interaction for an overage recompute: retrieve subscription →
// resolve the overage item (confidence-graded) → apply exactly one mutation.
// Returns a discriminated outcome; throws raw Stripe errors for the caller to
// classify (transient/terminal). Owns NO outbox effects — the worker handler
// maps outcomes onto outbox bookkeeping (repo invariant #12: entry points
// orchestrate, modules own behavior).
//
// Idempotency keys stay operation-scoped (per-outbox via operationScope) on
// purpose. This worker is single-consumer (concurrency:1 + one Railway
// instance), so BullMQ's bounded retry window (~3 attempts over ~15s) never
// overlaps the 1h outbox watchdog — a per-job key safely dedups the retry
// burst. A stable per-subscription create key was rejected: a delete→re-add
// within Stripe's ~24h key TTL would 400 `idempotency_error` deterministically
// (same key, different params), permanently failing a legitimate re-add. The
// per-outbox scope gives every distinct recompute a fresh key.

import type Stripe from 'stripe';
import {
  resolveOverageItem,
  overageItemMutationParams,
  OVERAGE_BILLING_ROLE,
} from '../../../src/lib/payments/overage-item';
import type { WorkerLogger } from '../../../src/lib/shared/logger';

export type OverageSyncOutcome =
  | { kind: 'applied'; action: 'deleted' | 'updated' | 'created' }
  | { kind: 'noop' }
  | { kind: 'ambiguous'; detail: string };

export interface OverageSyncInput {
  accountId: string;
  subscriptionId: string;
  storedOveragePriceCents: number;
  /** Env price ID for the account's tier — used only when creating a new item. */
  overagePriceId: string;
  newQuantity: number;
  /** Per-outbox scope embedded in every Stripe idempotency key. */
  operationScope: string;
}

function idempotencyKey(
  op: 'update' | 'create' | 'delete',
  input: OverageSyncInput,
  target: string,
  quantity: number,
): string {
  return `stripe-overage-${op}:${input.accountId}:${target}:${quantity}:${input.operationScope}`;
}

export async function syncStripeOverageItem(
  stripe: Stripe,
  input: OverageSyncInput,
  logger: WorkerLogger,
): Promise<OverageSyncOutcome> {
  const { accountId, subscriptionId, newQuantity } = input;

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);

  // Single owner of the "which item is the overage item?" predicate. Matching
  // a legacy/rotated price by stored unit-amount (not just the env price ID)
  // is what prevents adding a SECOND overage item — and double-billing — when
  // the env overage price has been rotated away from the one on the sub.
  const resolution = resolveOverageItem(subscription.items.data, {
    storedOveragePriceCents: input.storedOveragePriceCents,
  });

  // An untrusted (descriptor-only keyword) match is enough to FLAG an item,
  // never enough to delete or re-quantity one — a nickname like "Priority
  // Support Add-on" keyword-matches. Refuse to mutate; ops resolves manually.
  if (resolution.kind === 'untrusted') {
    return {
      kind: 'ambiguous',
      detail:
        `ambiguous_overage_item: item ${resolution.item.id} matched only by ` +
        `${resolution.matchedBy} — refusing to mutate; resolve manually ` +
        `(stamp metadata.billing_role='${OVERAGE_BILLING_ROLE}' on the real overage item)`,
    };
  }

  if (resolution.kind === 'trusted' && newQuantity === 0) {
    await stripe.subscriptionItems.del(
      resolution.item.id,
      {},
      { idempotencyKey: idempotencyKey('delete', input, resolution.item.id, 0) },
    );
    logger.log(`Deleted overage item ${resolution.item.id} for account ${accountId} because computed quantity=0`);
    return { kind: 'applied', action: 'deleted' };
  }

  if (resolution.kind === 'trusted') {
    // VAL-LOC-010: update existing overage item quantity. Quantity-only on the
    // price (legacy items keep their grandfathered price); the billing_role
    // stamp migrates legacy items to exact matching on their next recompute.
    await stripe.subscriptionItems.update(
      resolution.item.id,
      overageItemMutationParams(newQuantity),
      { idempotencyKey: idempotencyKey('update', input, resolution.item.id, newQuantity) },
    );
    logger.log(`Updated overage item ${resolution.item.id} to quantity=${newQuantity} for account ${accountId}`);
    return { kind: 'applied', action: 'updated' };
  }

  if (newQuantity > 0) {
    // VAL-BILLING-071: create the overage item when none exists.
    await stripe.subscriptionItems.create(
      {
        subscription: subscriptionId,
        price: input.overagePriceId,
        ...overageItemMutationParams(newQuantity),
      },
      // Key shape matches the pre-refactor builder: subscription + price both
      // participate, so a price rotation between retries yields a fresh key.
      { idempotencyKey: idempotencyKey('create', input, `${subscriptionId}:${input.overagePriceId}`, newQuantity) },
    );
    logger.log(`Created overage item with price=${input.overagePriceId} quantity=${newQuantity} for account ${accountId}`);
    return { kind: 'applied', action: 'created' };
  }

  logger.log(`No overage item exists and computed quantity=0 for account ${accountId} — nothing to create`);
  return { kind: 'noop' };
}
