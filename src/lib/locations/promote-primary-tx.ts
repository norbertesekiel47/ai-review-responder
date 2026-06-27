// src/lib/locations/promote-primary-tx.ts
//
// Primary promotion transaction. Atomically changes is_primary from the
// current primary location to a new primary location within the same account.
//
// ── CANONICAL OWNER of the one-primary invariant ────────────────────────────
// The invariant has two halves with two different enforcers:
//   AT MOST one  — the partial unique index businesses_account_primary_uniq
//                  (is_primary = TRUE AND archived_at IS NULL).
//   AT LEAST one — app-level repair, NOT the index. Zero-primary is a legal
//                  but transient state, reachable via offboarding-teardown
//                  (archives every location, primary included) followed by a
//                  cancelled offboarding + reactivation. It is repaired by:
//                  (a) this transaction, which tolerates demoting 0 rows
//                  precisely so promote can fix a zero-primary account;
//                  (b) reactivation's self-heal (archive-location-tx.ts),
//                  which auto-promotes when no active primary exists. The
//                  owner archive path blocks archiving a primary
//                  (promote_first), so steady state never drops to zero
//                  outside offboarding.
// New lifecycle writers (CSV import, merges, admin reassignment) must keep
// BOTH halves: never assume a primary exists, never create a second one.
//
// The partial unique index `businesses_account_primary_uniq` enforces that
// at most one row per account has is_primary = TRUE AND archived_at IS NULL.
// The transaction must set the old primary to FALSE before setting the new
// one to TRUE to avoid a transient constraint violation. Because both UPDATEs
// happen in the same transaction, the constraint check at commit time sees
// a consistent state.
//
// Implementation note: We use two separate UPDATE statements rather than a
// CTE because the order of operations matters — the old primary must be
// set to FALSE first, then the new one to TRUE. In a single transaction,
// PostgreSQL evaluates constraints at statement boundaries (deferred) or
// at commit time, so both approaches work. The two-UPDATE approach is
// clearer and easier to reason about.

import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '@/lib/db/server';

// ── Input / Output types ───────────────────────────────────────────────────

export interface PromotePrimaryTxInput {
  /** Account ID that owns both locations. */
  accountId: string;
  /** Location ID to promote to primary. Must be active and belong to the account. */
  newPrimaryId: string;
  /** User ID of the actor performing the promotion (for audit log). */
  actorUserId?: string | null;
}

export interface PromotePrimaryTxResult {
  /**
   * ID of the location that was demoted from primary, or `null` when the
   * account had no current primary — a zero-primary repair. Promoting any
   * active location heals such an account, so demoting 0 rows is expected,
   * not an error.
   */
  oldPrimaryId: string | null;
  /** ID of the location that was promoted to primary. */
  newPrimaryId: string;
}

// ── promotePrimaryTransaction ────────────────────────────────────────────────

/**
 * Atomically promotes a location to primary, demoting the current primary.
 *
 * Steps (all inside one tx; validation happens under the locks — the route
 * does its own pre-checks for the 404/403 UX split via getLocationById):
 *   1. Set is_primary = FALSE on the current primary for this account
 *   2. Set is_primary = TRUE on the new primary
 *   3. Insert account_audit_log with event_type 'primary_promoted'
 *
 * Throws LOCATION_DENIAL_STATUS code strings ('location_not_found',
 * 'already_primary') — see src/lib/locations/owner-route.ts.
 */
export async function promotePrimaryTransaction(
  input: PromotePrimaryTxInput,
): Promise<PromotePrimaryTxResult> {
  const { accountId, newPrimaryId, actorUserId } = input;

  let oldPrimaryId: string | null = null;

  await sql.begin(async (tx) => {
    await tx`
      SELECT id
      FROM accounts
      WHERE id = ${accountId}::uuid
      FOR UPDATE
    `;

    const [lockedTarget] = await tx<{ id: string; is_primary: boolean }[]>`
      SELECT id, is_primary
      FROM businesses
      WHERE id = ${newPrimaryId}::uuid
        AND account_id = ${accountId}::uuid
        AND archived_at IS NULL
      FOR UPDATE
    `;
    if (!lockedTarget) {
      throw new Error('location_not_found');
    }
    if (lockedTarget.is_primary) {
      throw new Error('already_primary');
    }

    // 1. Demote the current primary
    const [demoted] = await tx<{ id: string }[]>`
      UPDATE businesses
      SET is_primary = FALSE,
          updated_at = NOW()
      WHERE account_id = ${accountId}::uuid
        AND is_primary = TRUE
        AND archived_at IS NULL
      RETURNING id
    `;

    // A zero-primary account (no active is_primary row) is a reachable state.
    // Demoting 0 rows is expected there — promoting the new primary heals it,
    // so this is NOT an error.
    oldPrimaryId = demoted?.id ?? null;

    // 2. Promote the new primary
    const [promoted] = await tx<{ id: string }[]>`
      UPDATE businesses
      SET is_primary = TRUE,
          updated_at = NOW()
      WHERE id = ${newPrimaryId}::uuid
        AND account_id = ${accountId}::uuid
        AND archived_at IS NULL
      RETURNING id
    `;
    if (!promoted) {
      throw new Error('location_not_found');
    }

    // 3. Insert audit log entry
    await tx`
      INSERT INTO account_audit_log (
        id, account_id, location_id, event_type, actor_user_id, payload
      ) VALUES (
        ${uuidv7()}::uuid,
        ${accountId}::uuid,
        ${newPrimaryId}::uuid,
        'primary_promoted',
        ${actorUserId ?? null}::uuid,
        ${jsonb({
          old_primary_id: oldPrimaryId,
          new_primary_id: newPrimaryId,
        })}
      )
    `;
  });

  return {
    oldPrimaryId,
    newPrimaryId,
  };
}
