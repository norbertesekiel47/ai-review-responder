import type { TransactionSql } from 'postgres';

export const TIER_ENTITLEMENT_LOCK_SUFFIX = ':tier_entitlement';
export const OVERAGE_SYNC_LOCK_SUFFIX = ':overage_sync';
export const ACTIVATION_LOCK_SUFFIX = ':activation';

/** Overage-only writers acquire only the shared billing lock. */
export async function acquireBillingLock(
  tx: TransactionSql,
  accountId: string,
): Promise<void> {
  await tx`
    SELECT pg_advisory_xact_lock(
      hashtext(${accountId + OVERAGE_SYNC_LOCK_SUFFIX})
    )
  `;
}

/**
 * Serializes an existing-account tier writer with autonomy entitlement and
 * overage synchronization before either path can lock the account row.
 */
export async function acquireTierAndBillingLocks(
  tx: TransactionSql,
  accountId: string,
): Promise<void> {
  await tx`
    SELECT pg_advisory_xact_lock(
      hashtext(${accountId + TIER_ENTITLEMENT_LOCK_SUFFIX})
    )
  `;
  await acquireBillingLock(tx, accountId);
}

/**
 * Signup activation adds its legacy account-scoped activation lock only after
 * the shared entitlement and billing locks. Call this before any account-row
 * lock or account-FK child write.
 */
export async function acquireTierBillingActivationLocks(
  tx: TransactionSql,
  accountId: string,
  activationLockId: string,
): Promise<void> {
  await acquireTierAndBillingLocks(tx, accountId);
  await tx`
    SELECT pg_advisory_xact_lock(
      hashtext(${activationLockId + ACTIVATION_LOCK_SUFFIX})
    )
  `;
}
