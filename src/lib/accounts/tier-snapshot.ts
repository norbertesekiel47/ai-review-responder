import type { Sql, TransactionSql } from 'postgres';
import {
  resolveTierSnapshot,
  type PriceVariant,
  type ResolvedTierSnapshot,
  type SubscriptionTierValue,
} from '@/lib/accounts/tier-config';
import { writeAccountAuditLog } from '@/lib/audit/log';
import { acquireTierEntitlementLock } from '@/lib/accounts/billing-locks';

export interface TierSnapshotAuditContext {
  eventType: string;
  actorUserId?: string | null;
  payload?: Record<string, unknown>;
}

export interface WriteTierSnapshotInput {
  accountId: string;
  tier: SubscriptionTierValue;
  variant: PriceVariant;
  /** Provider-confirmed overage quantity, or zero before Stripe confirmation. */
  locationsPaid: number;
  audit?: TierSnapshotAuditContext;
}

export interface WriteResolvedTierSnapshotInput {
  accountId: string;
  /** Already-resolved stored or write-time snapshot; never re-derived here. */
  snapshot: ResolvedTierSnapshot;
  locationsPaid: number;
  audit?: TierSnapshotAuditContext;
}

export interface WriteTierSnapshotResult {
  changed: boolean;
  snapshot: ResolvedTierSnapshot;
}

/**
 * Writes the complete point-in-time billing snapshot. The deprecated business
 * mirror is synchronized only after this entitlement transaction commits (see
 * synchronizeBusinessTierMirror), because updating businesses while holding
 * entitlement deadlocks with publisher's business -> entitlement order.
 * The caller owns account locking, tier purchasability, and quantity
 * authority; this module owns snapshot completeness and change-only auditing.
 */
export async function writeTierSnapshot(
  tx: TransactionSql,
  input: WriteTierSnapshotInput,
): Promise<WriteTierSnapshotResult> {
  return writeResolvedTierSnapshot(tx, {
    accountId: input.accountId,
    snapshot: resolveTierSnapshot(input.tier, input.variant),
    locationsPaid: input.locationsPaid,
    audit: input.audit,
  });
}

/**
 * Complete atomic writer for an already-resolved billing snapshot. Selection
 * and tier-change callers resolve the registry once before entering here;
 * provider replay callers pass the stored point-in-time snapshot unchanged.
 */
export async function writeResolvedTierSnapshot(
  tx: TransactionSql,
  input: WriteResolvedTierSnapshotInput,
): Promise<WriteTierSnapshotResult> {
  if (!Number.isSafeInteger(input.locationsPaid) || input.locationsPaid < 0) {
    throw new Error('locationsPaid must be a non-negative safe integer');
  }

  const { snapshot } = input;
  for (const [name, value] of [
    ['baseCents', snapshot.baseCents],
    ['overageCents', snapshot.overageCents],
    ['included', snapshot.included],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive safe integer`);
    }
  }
  const updated = await tx<{ id: string }[]>`
    UPDATE accounts
    SET subscription_tier = ${snapshot.tier},
        base_price_cents = ${snapshot.baseCents},
        locations_overage_price_cents = ${snapshot.overageCents},
        locations_included = ${snapshot.included},
        locations_paid = ${input.locationsPaid},
        updated_at = NOW()
    WHERE id = ${input.accountId}::uuid
      AND ROW(
        subscription_tier,
        base_price_cents,
        locations_overage_price_cents,
        locations_included,
        locations_paid
      ) IS DISTINCT FROM ROW(
        ${snapshot.tier}::text,
        ${snapshot.baseCents}::integer,
        ${snapshot.overageCents}::integer,
        ${snapshot.included}::integer,
        ${input.locationsPaid}::integer
      )
    RETURNING id
  `;

  const changed = updated.length > 0;
  if (changed && input.audit) {
    await writeAccountAuditLog(tx, {
      accountId: input.accountId,
      eventType: input.audit.eventType,
      actorUserId: input.audit.actorUserId,
      entityType: 'account',
      entityId: input.accountId,
      payload: {
        tier: snapshot.tier,
        price_variant: snapshot.variant,
        base_price_cents: snapshot.baseCents,
        locations_overage_price_cents: snapshot.overageCents,
        locations_included: snapshot.included,
        locations_paid: input.locationsPaid,
        ...input.audit.payload,
      },
    });
  }

  return { changed, snapshot };
}

/**
 * Converges only the deprecated businesses tier mirror after the canonical
 * accounts transaction commits. Locking businesses before entitlement matches
 * the publisher edge and prevents the former webhook-entitlement -> business
 * versus publisher-business -> entitlement deadlock. The account is re-read
 * only after entitlement is acquired, so delayed/replayed syncs project the
 * latest canonical values rather than a stale caller snapshot.
 *
 * Failure is explicit: callers propagate it and their idempotent retry reruns
 * this projection; the already-committed account snapshot remains canonical.
 */
export async function synchronizeBusinessTierMirror(
  sql: Sql,
  accountId: string,
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      SELECT id
      FROM businesses
      WHERE account_id = ${accountId}::uuid
      ORDER BY id
      FOR UPDATE
    `;
    await acquireTierEntitlementLock(tx, accountId);
    const [account] = await tx<{ subscription_tier: string }[]>`
      SELECT subscription_tier
      FROM accounts
      WHERE id = ${accountId}::uuid
    `;
    if (!account) return;
    await tx`
      UPDATE businesses
      SET subscription_tier = ${account.subscription_tier},
          updated_at = NOW()
      WHERE account_id = ${accountId}::uuid
        AND subscription_tier IS DISTINCT FROM ${account.subscription_tier}::text
    `;
  });
}
