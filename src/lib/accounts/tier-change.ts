// Tier-change preview and execution. Every mutable-state read happens only
// after the fixed entitlement -> billing advisory-lock sequence.

import type Stripe from 'stripe';
import type { Sql, TransactionSql } from 'postgres';
import { subscriptionGrantsFullAccess } from '@/lib/shared/subscription-status';
import {
  activeOffboardingStateFromProjection,
  isBillingMutationBlocked,
  lockAccountBeforeOffboardingProjection,
  type ActiveOffboardingProjection,
} from '@/lib/account-offboarding/gate';
import {
  isPriceVariant,
  isSubscriptionTier,
  resolveTierSnapshot,
  type PriceVariant,
  type ResolvedTierSnapshot,
  type SubscriptionTierValue,
} from './tier-config';
import { computeOverageQuantity, type BillingSnapshot } from './quota';
import { acquireTierAndBillingLocks } from './billing-locks';
import {
  synchronizeBusinessTierMirror,
  writeResolvedTierSnapshot,
} from './tier-snapshot';
import { writeAccountAuditLog } from '@/lib/audit/log';
import { getStripe } from '@/lib/payments/stripe-client';
import {
  assertTierPurchasable,
  TierNotPurchasableError,
} from '@/lib/payments/tier-purchasability';
import { basePriceIdSet, priceIdFor } from '@/lib/payments/price-tier-map';
import { resolveOverageItem, overageItemMutationParams } from '@/lib/payments/overage-item';

export interface TierChangeValidation {
  allowed: boolean;
  reason?:
    | 'unknown_tier'
    | 'same_tier'
    | 'subscription_inactive'
    | 'account_offboarding_blocked';
  newBillingPreview?: BillingSnapshot;
}

interface LockedAccountState extends ActiveOffboardingProjection {
  owner_user_id: string | null;
  price_variant: string;
  stripe_subscription_id: string | null;
  subscription_status: string;
  subscription_tier: string;
  locations_overage_price_cents: number;
}

async function loadLockedAccountState(
  tx: TransactionSql,
  accountId: string,
): Promise<LockedAccountState | undefined> {
  const accountLocked = await lockAccountBeforeOffboardingProjection(tx, accountId);
  if (!accountLocked) return undefined;

  const [account] = await tx<LockedAccountState[]>`
    SELECT
      a.owner_user_id,
      a.price_variant,
      a.stripe_subscription_id,
      a.subscription_status,
      a.subscription_tier,
      a.locations_overage_price_cents,
      ao.id AS offboarding_id,
      ao.account_id AS offboarding_account_id,
      ao.mode AS offboarding_mode,
      ao.status AS offboarding_status,
      ao.failed_step AS offboarding_failed_step,
      ao.access_ends_at AS offboarding_access_ends_at,
      ao.teardown_started_at AS offboarding_teardown_started_at,
      ao.purge_after AS offboarding_purge_after,
      ao.purge_started_at AS offboarding_purge_started_at,
      ao.purge_cancelled_at AS offboarding_purge_cancelled_at
    FROM accounts a
    LEFT JOIN LATERAL (
      SELECT active.*
      FROM account_offboardings active
      WHERE active.account_id = a.id
        AND active.terminal_at IS NULL
      ORDER BY active.created_at DESC
      LIMIT 1
    ) ao ON TRUE
    WHERE a.id = ${accountId}::uuid
  `;
  return account;
}

async function countActiveLocations(tx: TransactionSql, accountId: string): Promise<number> {
  const [row] = await tx<{ count: number | string }[]>`
    SELECT COUNT(*) AS count
    FROM businesses
    WHERE account_id = ${accountId}::uuid
      AND archived_at IS NULL
  `;
  const count = Number(row?.count ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error('Active location count must be a non-negative safe integer');
  }
  return count;
}

function previewFor(
  snapshot: ResolvedTierSnapshot,
  activeLocations: number,
): BillingSnapshot {
  const overageUnits = computeOverageQuantity(activeLocations, snapshot.included);
  return {
    basePriceCents: snapshot.baseCents,
    includedLocations: snapshot.included,
    overagePriceCents: snapshot.overageCents,
    overageUnits,
    totalCents: snapshot.baseCents + overageUnits * snapshot.overageCents,
  };
}

/**
 * Computes a proposed write-time snapshot from the account's immutable variant.
 * The locks make the account/location read one coherent preview and pin source
 * order so this reader cannot race an overage writer mid-plan.
 */
export async function validateTierChange(
  sql: Sql,
  accountId: string,
  newTier: string,
): Promise<TierChangeValidation> {
  if (!isSubscriptionTier(newTier)) {
    return { allowed: false, reason: 'unknown_tier' };
  }
  assertTierPurchasable(newTier);

  return sql.begin(async (tx) => {
    await acquireTierAndBillingLocks(tx, accountId);
    const account = await loadLockedAccountState(tx, accountId);
    if (!account || !subscriptionGrantsFullAccess(account.subscription_status)) {
      return { allowed: false, reason: 'subscription_inactive' };
    }
    if (isBillingMutationBlocked(activeOffboardingStateFromProjection(account))) {
      return { allowed: false, reason: 'account_offboarding_blocked' };
    }
    if (account.subscription_tier === newTier) {
      return { allowed: false, reason: 'same_tier' };
    }
    if (!isPriceVariant(account.price_variant)) {
      throw new Error(`Invalid stored price variant for account ${accountId}`);
    }
    const activeLocations = await countActiveLocations(tx, accountId);
    const targetSnapshot = resolveTierSnapshot(newTier, account.price_variant);
    return {
      allowed: true,
      newBillingPreview: previewFor(targetSnapshot, activeLocations),
    };
  });
}

export type TierChangeFailureCode =
  | 'no_stripe_subscription'
  | 'account_offboarding_blocked'
  | 'subscription_inactive'
  | 'same_tier'
  | 'operation_conflict'
  | 'missing_price_config'
  | 'base_item_not_found'
  | 'ambiguous_overage_item'
  | 'tier_change_failed';

export type TierChangeOutcome =
  | { ok: true; newBilling: BillingSnapshot }
  | { ok: false; code: TierChangeFailureCode; detail: string };

export interface ApplyTierChangeInput {
  accountId: string;
  tier: SubscriptionTierValue;
  /** Stable caller operation identity; never a timestamp or retry attempt. */
  operationKey: string;
}

type OverageMutation =
  | { kind: 'update'; itemId: string; priceId: string; quantity: number }
  | { kind: 'create'; priceId: string; quantity: number }
  | { kind: 'delete'; itemId: string }
  | { kind: 'none' };

export const TIER_CHANGE_OPERATION_METADATA_KEY = 'repworth_tier_change_operation';
export const TIER_CHANGE_SOURCE_METADATA_KEY = 'repworth_tier_change_source';

interface CommittedTierChangeRow {
  new_tier: string | null;
  price_variant: string | null;
  base_price_cents: string | null;
  locations_overage_price_cents: string | null;
  locations_included: string | null;
  locations_paid: string | null;
}

type CommittedTierChangeLookup =
  | { kind: 'none' }
  | { kind: 'conflict'; committedTier: SubscriptionTierValue }
  | { kind: 'success'; billing: BillingSnapshot };

type MatchedCommittedIdentity = {
  kind: 'matched';
  tier: SubscriptionTierValue;
  variant: PriceVariant;
};

function parseAuditInteger(
  value: string | null,
  field: string,
  options: { positive: boolean },
): number {
  if (!value || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`Committed tier-change audit has invalid ${field}`);
  }
  const parsed = Number(value);
  const minimum = options.positive ? 1 : 0;
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`Committed tier-change audit has invalid ${field}`);
  }
  return parsed;
}

function singleCommittedRow(rows: CommittedTierChangeRow[]): CommittedTierChangeRow | null {
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    throw new Error('Committed tier-change operation has duplicate audit rows');
  }
  return rows[0]!;
}

function validateCommittedIdentity(
  row: CommittedTierChangeRow,
  input: { targetTier: SubscriptionTierValue; storedPriceVariant: string },
): MatchedCommittedIdentity | Extract<CommittedTierChangeLookup, { kind: 'conflict' }> {
  if (!row.new_tier || !isSubscriptionTier(row.new_tier)) {
    throw new Error('Committed tier-change audit has invalid new_tier');
  }
  if (row.new_tier !== input.targetTier) {
    return { kind: 'conflict', committedTier: row.new_tier };
  }
  if (!row.price_variant || !isPriceVariant(row.price_variant)) {
    throw new Error('Committed tier-change audit has invalid price_variant');
  }
  if (row.price_variant !== input.storedPriceVariant) {
    throw new Error('Committed tier-change audit price_variant does not match account');
  }
  return { kind: 'matched', tier: row.new_tier, variant: row.price_variant };
}

function committedBillingSnapshot(
  row: CommittedTierChangeRow,
): BillingSnapshot {
  const basePriceCents = parseAuditInteger(
    row.base_price_cents,
    'base_price_cents',
    { positive: true },
  );
  const overagePriceCents = parseAuditInteger(
    row.locations_overage_price_cents,
    'locations_overage_price_cents',
    { positive: true },
  );
  const includedLocations = parseAuditInteger(
    row.locations_included,
    'locations_included',
    { positive: true },
  );
  const overageUnits = parseAuditInteger(
    row.locations_paid,
    'locations_paid',
    { positive: false },
  );
  // The committed audit is the immutable operation result. Re-validating its
  // cents against today's registry would make a successful historical retry
  // fail after a legitimate Price rotation. Identity is validated separately;
  // this parser enforces structural/integer integrity only.
  const totalCents = basePriceCents + overageUnits * overagePriceCents;
  if (!Number.isSafeInteger(totalCents)) {
    throw new Error('Committed tier-change audit has invalid total billing cents');
  }
  return {
    basePriceCents,
    includedLocations,
    overagePriceCents,
    overageUnits,
    totalCents,
  };
}

async function loadCommittedTierChange(
  tx: TransactionSql,
  input: {
    accountId: string;
    operationKey: string;
    targetTier: SubscriptionTierValue;
    storedPriceVariant: string;
  },
): Promise<CommittedTierChangeLookup> {
  const rows = await tx<CommittedTierChangeRow[]>`
    SELECT
      payload->>'new_tier' AS new_tier,
      payload->>'price_variant' AS price_variant,
      payload->>'base_price_cents' AS base_price_cents,
      payload->>'locations_overage_price_cents' AS locations_overage_price_cents,
      payload->>'locations_included' AS locations_included,
      payload->>'locations_paid' AS locations_paid
    FROM account_audit_log
    WHERE account_id = ${input.accountId}::uuid
      AND event_type = 'tier_changed'
      AND payload->>'idempotency_key' = ${input.operationKey}
    ORDER BY created_at DESC, id DESC
    LIMIT 2
  `;
  const row = singleCommittedRow(rows);
  if (!row) return { kind: 'none' };
  if (!isPriceVariant(input.storedPriceVariant)) {
    throw new Error('Committed tier-change account has invalid price_variant');
  }
  const identity = validateCommittedIdentity(row, input);
  if (identity.kind === 'conflict') return identity;
  return {
    kind: 'success',
    billing: committedBillingSnapshot(row),
  };
}

function planOverageMutation(input: {
  items: Stripe.SubscriptionItem[];
  storedOveragePriceCents: number;
  targetOveragePriceId: string;
  newOverageUnits: number;
}): { plan: OverageMutation } | { failure: TierChangeOutcome & { ok: false } } {
  const resolution = resolveOverageItem(input.items, {
    storedOveragePriceCents: input.storedOveragePriceCents,
  });
  if (resolution.kind === 'untrusted') {
    return {
      failure: {
        ok: false,
        code: 'ambiguous_overage_item',
        detail: `Subscription item ${resolution.item.id} matched only by ${resolution.matchedBy}; refusing to modify it`,
      },
    };
  }
  const item = resolution.kind === 'trusted' ? resolution.item : undefined;
  if (input.newOverageUnits === 0) {
    return { plan: item ? { kind: 'delete', itemId: item.id } : { kind: 'none' } };
  }
  return {
    plan: item
      ? {
          kind: 'update',
          itemId: item.id,
          priceId: input.targetOveragePriceId,
          quantity: input.newOverageUnits,
        }
      : {
          kind: 'create',
          priceId: input.targetOveragePriceId,
          quantity: input.newOverageUnits,
        },
  };
}

// These Stripe calls run while two pg advisory locks + FOR UPDATE are held, so
// a slow provider would pin the locked transaction open. Bound every under-lock
// request to a short per-call budget with no network retries. Single owner of
// the bound — no literal timeout/retry values live anywhere else.
const STRIPE_UNDER_LOCK_REQUEST_OPTIONS = { timeout: 8_000, maxNetworkRetries: 0 } as const;

function stripeOptions(accountId: string, operationKey: string, step: string) {
  return {
    ...STRIPE_UNDER_LOCK_REQUEST_OPTIONS,
    idempotencyKey: `tier-change:${accountId}:${operationKey}:${step}`,
  };
}

async function mutateStripe(input: {
  accountId: string;
  operationKey: string;
  subscriptionId: string;
  baseItemId: string;
  basePriceId: string;
  sourceTier: string;
  overage: OverageMutation;
}): Promise<void> {
  const stripe = getStripe();
  await stripe.subscriptionItems.update(
    input.baseItemId,
    {
      price: input.basePriceId,
      proration_behavior: 'create_prorations',
      metadata: {
        [TIER_CHANGE_OPERATION_METADATA_KEY]: input.operationKey,
        [TIER_CHANGE_SOURCE_METADATA_KEY]: input.sourceTier,
      },
    },
    stripeOptions(input.accountId, input.operationKey, 'base'),
  );

  switch (input.overage.kind) {
    case 'update':
      await stripe.subscriptionItems.update(
        input.overage.itemId,
        {
          price: input.overage.priceId,
          ...overageItemMutationParams(input.overage.quantity),
        },
        stripeOptions(input.accountId, input.operationKey, 'overage-update'),
      );
      break;
    case 'create':
      await stripe.subscriptionItems.create(
        {
          subscription: input.subscriptionId,
          price: input.overage.priceId,
          ...overageItemMutationParams(input.overage.quantity),
        },
        stripeOptions(input.accountId, input.operationKey, 'overage-create'),
      );
      break;
    case 'delete':
      await stripe.subscriptionItems.del(
        input.overage.itemId,
        {},
        stripeOptions(input.accountId, input.operationKey, 'overage-delete'),
      );
      break;
    case 'none':
      break;
  }
}

async function ensureTierChangeAudit(
  tx: TransactionSql,
  input: {
    accountId: string;
    actorUserId: string | null;
    operationKey: string;
    oldTier: string;
    snapshot: ResolvedTierSnapshot;
    locationsPaid: number;
  },
): Promise<void> {
  const [existing] = await tx<{ id: string }[]>`
    SELECT id
    FROM account_audit_log
    WHERE account_id = ${input.accountId}::uuid
      AND event_type = 'tier_changed'
      AND payload->>'idempotency_key' = ${input.operationKey}
    LIMIT 1
  `;
  if (existing) return;

  await writeAccountAuditLog(tx, {
    accountId: input.accountId,
    eventType: 'tier_changed',
    actorUserId: input.actorUserId,
    entityType: 'account',
    entityId: input.accountId,
    payload: {
      old_tier: input.oldTier,
      new_tier: input.snapshot.tier,
      price_variant: input.snapshot.variant,
      base_price_cents: input.snapshot.baseCents,
      locations_overage_price_cents: input.snapshot.overageCents,
      locations_included: input.snapshot.included,
      locations_paid: input.locationsPaid,
      idempotency_key: input.operationKey,
    },
  });
}

type TierChangeFailure = TierChangeOutcome & { ok: false };

type ExecutableAccount = Omit<LockedAccountState, 'price_variant' | 'stripe_subscription_id'> & {
  price_variant: PriceVariant;
  stripe_subscription_id: string;
};

interface TierChangeProviderPlan {
  account: ExecutableAccount;
  targetSnapshot: ResolvedTierSnapshot;
  newOverageUnits: number;
  newBilling: BillingSnapshot;
  baseItemId: string;
  basePriceId: string;
  sourceTier: string;
  overage: OverageMutation;
}

function tierChangeFailure(
  code: TierChangeFailureCode,
  detail: string,
): TierChangeFailure {
  return { ok: false, code, detail };
}

function committedOutcome(committed: CommittedTierChangeLookup): TierChangeOutcome | null {
  if (committed.kind === 'success') {
    return { ok: true, newBilling: committed.billing };
  }
  if (committed.kind === 'conflict') {
    return tierChangeFailure(
      'operation_conflict',
      `Operation is already committed for tier: ${committed.committedTier}`,
    );
  }
  return null;
}

function validateExecutableAccount(
  account: LockedAccountState,
  accountId: string,
): { ok: true; account: ExecutableAccount } | { ok: false; outcome: TierChangeFailure } {
  if (!account.stripe_subscription_id) {
    return {
      ok: false,
      outcome: tierChangeFailure(
        'no_stripe_subscription',
        'Account has no active Stripe subscription',
      ),
    };
  }
  if (!subscriptionGrantsFullAccess(account.subscription_status)) {
    return {
      ok: false,
      outcome: tierChangeFailure(
        'subscription_inactive',
        'Account subscription does not permit a tier change',
      ),
    };
  }
  if (!isPriceVariant(account.price_variant)) {
    throw new Error(`Invalid stored price variant for account ${accountId}`);
  }
  return {
    ok: true,
    account: {
      ...account,
      price_variant: account.price_variant,
      stripe_subscription_id: account.stripe_subscription_id,
    },
  };
}

interface ConfiguredTierPrices {
  basePriceId: string;
  overagePriceId: string;
}

function configuredTierPrices(
  tier: SubscriptionTierValue,
  variant: PriceVariant,
): ConfiguredTierPrices | null {
  const basePriceId = priceIdFor(tier, variant, 'base');
  const overagePriceId = priceIdFor(tier, variant, 'overage');
  return basePriceId && overagePriceId ? { basePriceId, overagePriceId } : null;
}

function resolveProviderBase(input: {
  account: ExecutableAccount;
  subscription: Stripe.Subscription;
  targetTier: SubscriptionTierValue;
  operationKey: string;
  basePriceId: string;
}):
  | { ok: true; baseItemId: string; sourceTier: string }
  | { ok: false; outcome: TierChangeFailure } {
  const baseItem = input.subscription.items.data.find(
    (item) => basePriceIdSet().has(item.price.id),
  );
  if (!baseItem) {
    return {
      ok: false,
      outcome: tierChangeFailure(
        'base_item_not_found',
        'Could not identify the base subscription item',
      ),
    };
  }
  const projectedSameTier = input.account.subscription_tier === input.targetTier;
  const providerOperationKey = baseItem.metadata?.[TIER_CHANGE_OPERATION_METADATA_KEY];
  if (projectedSameTier && providerOperationKey !== input.operationKey) {
    return {
      ok: false,
      outcome: tierChangeFailure('same_tier', 'Account is already on this tier'),
    };
  }
  const sourceTier = projectedSameTier
    ? baseItem.metadata?.[TIER_CHANGE_SOURCE_METADATA_KEY] ?? input.account.subscription_tier
    : input.account.subscription_tier;
  return { ok: true, baseItemId: baseItem.id, sourceTier };
}

async function buildTierChangeProviderPlan(
  tx: TransactionSql,
  account: ExecutableAccount,
  input: ApplyTierChangeInput,
): Promise<{ ok: true; plan: TierChangeProviderPlan } | { ok: false; outcome: TierChangeFailure }> {
  const activeLocations = await countActiveLocations(tx, input.accountId);
  const targetSnapshot = resolveTierSnapshot(input.tier, account.price_variant);
  const newOverageUnits = computeOverageQuantity(activeLocations, targetSnapshot.included);
  const newBilling = previewFor(targetSnapshot, activeLocations);
  const prices = configuredTierPrices(input.tier, account.price_variant);
  if (!prices) {
    return {
      ok: false,
      outcome: tierChangeFailure(
        'missing_price_config',
        `Stripe prices are not fully configured for tier: ${input.tier}`,
      ),
    };
  }

  // `retrieve` has a single overload (id, params, options); the request-options
  // bound is the third arg, so pass empty params. It is a GET — no idempotency key.
  const subscription = await getStripe().subscriptions.retrieve(
    account.stripe_subscription_id,
    {},
    STRIPE_UNDER_LOCK_REQUEST_OPTIONS,
  );
  const providerBase = resolveProviderBase({
    account,
    subscription,
    targetTier: input.tier,
    operationKey: input.operationKey,
    basePriceId: prices.basePriceId,
  });
  if (!providerBase.ok) return providerBase;
  const overage = planOverageMutation({
    items: subscription.items.data,
    storedOveragePriceCents: account.locations_overage_price_cents,
    targetOveragePriceId: prices.overagePriceId,
    newOverageUnits,
  });
  if ('failure' in overage) return { ok: false, outcome: overage.failure };

  return {
    ok: true,
    plan: {
      account,
      targetSnapshot,
      newOverageUnits,
      newBilling,
      baseItemId: providerBase.baseItemId,
      basePriceId: prices.basePriceId,
      sourceTier: providerBase.sourceTier,
      overage: overage.plan,
    },
  };
}

async function applyTierChangeInTx(
  tx: TransactionSql,
  input: ApplyTierChangeInput,
): Promise<TierChangeOutcome> {
  await acquireTierAndBillingLocks(tx, input.accountId);

  const account = await loadLockedAccountState(tx, input.accountId);
  if (!account) {
    return tierChangeFailure(
      'no_stripe_subscription',
      'Account has no active Stripe subscription',
    );
  }
  const committed = await loadCommittedTierChange(tx, {
    accountId: input.accountId,
    operationKey: input.operationKey,
    targetTier: input.tier,
    storedPriceVariant: account.price_variant,
  });
  const replay = committedOutcome(committed);
  if (replay) return replay;

  if (isBillingMutationBlocked(activeOffboardingStateFromProjection(account))) {
    return tierChangeFailure(
      'account_offboarding_blocked',
      'Account offboarding blocks tier changes',
    );
  }

  assertTierPurchasable(input.tier);
  const executable = validateExecutableAccount(account, input.accountId);
  if (!executable.ok) return executable.outcome;
  const providerPlan = await buildTierChangeProviderPlan(tx, executable.account, input);
  if (!providerPlan.ok) return providerPlan.outcome;
  const { plan } = providerPlan;

  await mutateStripe({
    accountId: input.accountId,
    operationKey: input.operationKey,
    subscriptionId: plan.account.stripe_subscription_id,
    baseItemId: plan.baseItemId,
    basePriceId: plan.basePriceId,
    sourceTier: plan.sourceTier,
    overage: plan.overage,
  });
  await writeResolvedTierSnapshot(tx, {
    accountId: input.accountId,
    snapshot: plan.targetSnapshot,
    locationsPaid: plan.newOverageUnits,
  });
  await ensureTierChangeAudit(tx, {
    accountId: input.accountId,
    actorUserId: plan.account.owner_user_id,
    operationKey: input.operationKey,
    oldTier: plan.sourceTier,
    snapshot: plan.targetSnapshot,
    locationsPaid: plan.newOverageUnits,
  });
  return { ok: true, newBilling: plan.newBilling };
}

/**
 * Revalidates and executes a tier change from one locked plan. Stripe calls use
 * the shared bounded client and stable per-step keys while both advisory locks
 * are held. The complete DB snapshot and audit commit only after every provider
 * mutation succeeds.
 */
export async function applyTierChange(
  sql: Sql,
  input: ApplyTierChangeInput,
): Promise<TierChangeOutcome> {
  try {
    const outcome = await sql.begin((tx) => applyTierChangeInTx(tx, input));
    if (outcome.ok) {
      await synchronizeBusinessTierMirror(sql, input.accountId);
    }
    return outcome;
  } catch (err) {
    // Purchasability is an authoritative caller-visible rejection, not a
    // provider failure. Let the route map the typed error to a 409.
    if (err instanceof TierNotPurchasableError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[billing/tier-change] Failed for account=${input.accountId}: ${message}`);
    return {
      ok: false,
      code: 'tier_change_failed',
      detail: 'Unable to change subscription tier. Please try again later.',
    };
  }
}
