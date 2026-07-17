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
import type { SubscriptionTierValue } from '../../../src/lib/accounts/tier-config';
import {
  resolveOverageItem,
  overageItemMutationParams,
  OVERAGE_BILLING_ROLE,
} from '../../../src/lib/payments/overage-item';
import type { OverageItemResolution } from '../../../src/lib/payments/overage-item';
import { overagePriceInfoForId } from '../../../src/lib/payments/price-tier-map';
import type { WorkerLogger } from '../../../src/lib/shared/logger';

export type OverageSyncOutcome =
  | { kind: 'applied'; action: 'deleted' | 'updated' | 'created' }
  | { kind: 'noop' }
  | { kind: 'policy_blocked'; detail: string }
  | { kind: 'ambiguous'; detail: string };

export type OverageMutationPolicy = 'allow_all' | 'contractions_only';

export interface OverageSyncInput {
  accountId: string;
  subscriptionId: string;
  tier: SubscriptionTierValue;
  storedOveragePriceCents: number;
  /** Canonical overage Price ID for the account's stored tier + variant. */
  overagePriceId: string | null;
  newQuantity: number;
  /** Offboarding-aware provider mutation policy resolved under the billing lock. */
  mutationPolicy: OverageMutationPolicy;
  /** Per-outbox scope embedded in every Stripe idempotency key. */
  operationScope: string;
}

type PolicyDecisionOutcome = Extract<
  OverageSyncOutcome,
  { kind: 'noop' | 'policy_blocked' }
>;

type ReplacementPriceDecision =
  | { required: false }
  | { required: true; priceId: string | null };

type TrustedOverageResolution = Extract<
  OverageItemResolution,
  { kind: 'trusted' }
>;

type UntrustedOverageResolution = Extract<
  OverageItemResolution,
  { kind: 'untrusted' }
>;

function replacementPriceForTrustedItem(
  item: Stripe.SubscriptionItem,
  input: OverageSyncInput,
): ReplacementPriceDecision {
  const mappedPrice = overagePriceInfoForId(item.price?.id);
  if (mappedPrice && mappedPrice.tier !== input.tier) {
    return { required: true, priceId: input.overagePriceId };
  }

  const providerUnitAmount = item.price?.unit_amount;
  if (
    providerUnitAmount !== null
    && providerUnitAmount !== undefined
    && providerUnitAmount !== input.storedOveragePriceCents
  ) {
    return { required: true, priceId: input.overagePriceId };
  }

  // Same-tier and historical Prices compatible with the immutable stored
  // cents remain untouched. Merely rotating operator config must not migrate
  // an existing account off its stored/grandfathered billing contract.
  return { required: false };
}

function idempotencyKey(
  op: 'update' | 'create' | 'delete',
  input: OverageSyncInput,
  target: string,
  quantity: number,
): string {
  return `stripe-overage-${op}:${input.accountId}:${target}:${quantity}:${input.operationScope}`;
}

function trustedItemPolicyOutcome(
  item: Stripe.SubscriptionItem,
  input: OverageSyncInput,
  replacementPrice: ReplacementPriceDecision,
): PolicyDecisionOutcome | null {
  if (input.mutationPolicy !== 'contractions_only') return null;

  const providerCurrentQuantity = item.quantity ?? 0;
  if (replacementPrice.required) {
    return {
      kind: 'policy_blocked',
      detail:
        `offboarding_contractions_only: refusing Price replacement on item `
        + `${item.id}`,
    };
  }
  if (input.newQuantity > providerCurrentQuantity) {
    return {
      kind: 'policy_blocked',
      detail:
        `offboarding_contractions_only: refusing quantity expansion on item `
        + `${item.id} from ${providerCurrentQuantity} to ${input.newQuantity}`,
    };
  }
  return input.newQuantity === providerCurrentQuantity ? { kind: 'noop' } : null;
}

function createPolicyOutcome(input: OverageSyncInput): PolicyDecisionOutcome | null {
  if (input.mutationPolicy !== 'contractions_only') return null;
  return {
    kind: 'policy_blocked',
    detail:
      `offboarding_contractions_only: refusing overage-item creation at quantity `
      + `${input.newQuantity}`,
  };
}

function missingRetainedOveragePrice(input: OverageSyncInput): Error {
  return new Error(
    `Missing retained overage Price for ${input.tier} at `
    + `${input.storedOveragePriceCents} cents`,
  );
}

function ambiguousOutcome(
  resolution: UntrustedOverageResolution,
): OverageSyncOutcome {
  return {
    kind: 'ambiguous',
    detail:
      `ambiguous_overage_item: item ${resolution.item.id} matched only by `
      + `${resolution.matchedBy} — refusing to mutate; resolve manually `
      + `(stamp metadata.billing_role='${OVERAGE_BILLING_ROLE}' on the real overage item)`,
  };
}

async function deleteTrustedOverageItem(
  stripe: Stripe,
  resolution: TrustedOverageResolution,
  input: OverageSyncInput,
  logger: WorkerLogger,
): Promise<OverageSyncOutcome> {
  await stripe.subscriptionItems.del(
    resolution.item.id,
    {},
    { idempotencyKey: idempotencyKey('delete', input, resolution.item.id, 0) },
  );
  logger.log(
    `Deleted overage item ${resolution.item.id} for account `
    + `${input.accountId} because computed quantity=0`,
  );
  return { kind: 'applied', action: 'deleted' };
}

async function updateTrustedOverageItem(
  stripe: Stripe,
  resolution: TrustedOverageResolution,
  input: OverageSyncInput,
  logger: WorkerLogger,
): Promise<OverageSyncOutcome> {
  // VAL-LOC-010: preserve a compatible same-tier/historical Price, but repair
  // a demonstrable cross-tier or stored-cent mismatch. This keeps immutable
  // grandfathering intact across operator config rotation while still healing
  // a stale Copilot item on an Autopilot account.
  const replacement = replacementPriceForTrustedItem(resolution.item, input);
  const policyOutcome = trustedItemPolicyOutcome(
    resolution.item,
    input,
    replacement,
  );
  if (policyOutcome) return policyOutcome;
  if (replacement.required && !replacement.priceId) {
    throw missingRetainedOveragePrice(input);
  }

  const replacementPrice = replacement.required ? replacement.priceId : null;
  await stripe.subscriptionItems.update(
    resolution.item.id,
    replacementPrice
      ? {
          price: replacementPrice,
          ...overageItemMutationParams(input.newQuantity),
        }
      : overageItemMutationParams(input.newQuantity),
    {
      idempotencyKey: idempotencyKey(
        'update',
        input,
        replacementPrice
          ? `${resolution.item.id}:${replacementPrice}`
          : resolution.item.id,
        input.newQuantity,
      ),
    },
  );
  logger.log(
    `Updated overage item ${resolution.item.id} to quantity=${input.newQuantity} `
    + `for account ${input.accountId}`,
  );
  return { kind: 'applied', action: 'updated' };
}

async function createOverageItem(
  stripe: Stripe,
  input: OverageSyncInput,
  logger: WorkerLogger,
): Promise<OverageSyncOutcome> {
  const policyOutcome = createPolicyOutcome(input);
  if (policyOutcome) return policyOutcome;
  if (!input.overagePriceId) throw missingRetainedOveragePrice(input);

  // VAL-BILLING-071: create the overage item when none exists.
  await stripe.subscriptionItems.create(
    {
      subscription: input.subscriptionId,
      price: input.overagePriceId,
      ...overageItemMutationParams(input.newQuantity),
    },
    // Key shape matches the pre-refactor builder: subscription + price both
    // participate, so a price rotation between retries yields a fresh key.
    {
      idempotencyKey: idempotencyKey(
        'create',
        input,
        `${input.subscriptionId}:${input.overagePriceId}`,
        input.newQuantity,
      ),
    },
  );
  logger.log(
    `Created overage item with price=${input.overagePriceId} `
    + `quantity=${input.newQuantity} for account ${input.accountId}`,
  );
  return { kind: 'applied', action: 'created' };
}

export async function syncStripeOverageItem(
  stripe: Stripe,
  input: OverageSyncInput,
  logger: WorkerLogger,
): Promise<OverageSyncOutcome> {
  const subscription = await stripe.subscriptions.retrieve(input.subscriptionId);

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
    return ambiguousOutcome(resolution);
  }

  if (resolution.kind === 'trusted') {
    return input.newQuantity === 0
      ? deleteTrustedOverageItem(stripe, resolution, input, logger)
      : updateTrustedOverageItem(stripe, resolution, input, logger);
  }

  if (input.newQuantity > 0) return createOverageItem(stripe, input, logger);

  logger.log(
    `No overage item exists and computed quantity=0 for account `
    + `${input.accountId} — nothing to create`,
  );
  return { kind: 'noop' };
}
