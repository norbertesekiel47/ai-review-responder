import type { TransactionSql } from 'postgres';

const TIER_ENTITLEMENT_LOCK_SUFFIX = ':tier_entitlement';
const OVERAGE_SYNC_LOCK_SUFFIX = ':overage_sync';
const ACTIVATION_LOCK_SUFFIX = ':activation';
const LOCATION_LIFECYCLE_LOCK_SUFFIX = ':location_lifecycle';

/**
 * Serializes Autopilot grant/publish with every existing-account tier writer.
 * Approval lanes call this only after their review/business[/response] anchors;
 * billing lanes call it before the billing lock and before the account row.
 */
export async function acquireTierEntitlementLock(
  tx: TransactionSql,
  accountId: string,
): Promise<void> {
  await tx`
    SELECT pg_advisory_xact_lock(
      hashtext(${accountId + TIER_ENTITLEMENT_LOCK_SUFFIX})
    )
  `;
}

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
 * Serializes same-account location add/archive/reactivate/promote operations.
 *
 * Location writers take this lock before any business-row lock. They lock the
 * affected business rows in deterministic id order before taking an account
 * row lock, when one is still required. Keeping the lifecycle mutex separate
 * from tier entitlement prevents the global account -> business -> entitlement
 * -> account deadlock while preserving same-account location invariants.
 */
export async function acquireLocationLifecycleLock(
  tx: TransactionSql,
  accountId: string,
): Promise<void> {
  await tx`
    SELECT pg_advisory_xact_lock(
      hashtext(${accountId + LOCATION_LIFECYCLE_LOCK_SUFFIX})
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
  await acquireTierEntitlementLock(tx, accountId);
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
