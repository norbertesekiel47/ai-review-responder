// src/lib/db/account-guard.ts
//
// Account-level subscription guard. Every worker and SSR route that needs
// to check whether a subscription is active must use this helper — never
// read `businesses.subscription_status` directly (that column is deprecated
// per VAL-SCHEMA-036).
//
// Validation contract: VAL-BILLING-033 through VAL-BILLING-037, VAL-BILLING-044.

import { sql } from '@/lib/db/server';
import type { AccountId } from '@/lib/shared/ids';

// ── Types ──────────────────────────────────────────────────────────────────

export interface AccountActiveResult {
  active: true;
}

export interface AccountInactiveResult {
  active: false;
  reason: 'pending_payment' | 'past_due' | 'cancelled' | 'not_found';
}

export type AccountActiveCheck = AccountActiveResult | AccountInactiveResult;

// ── isAccountActive ─────────────────────────────────────────────────────────

/**
 * Checks whether an account's subscription is active by reading
 * `accounts.subscription_status` (NOT `businesses.subscription_status`).
 *
 * VAL-BILLING-033: reads from accounts table.
 * VAL-BILLING-034: returns false for pending_payment.
 * VAL-BILLING-035: returns false for past_due.
 * VAL-BILLING-036: returns false for cancelled.
 * VAL-BILLING-037: returns true for active.
 */
export async function isAccountActive(
  accountId: string,
): Promise<AccountActiveCheck> {
  const [row] = await sql<{ subscription_status: string }[]>`
    SELECT subscription_status
    FROM accounts
    WHERE id = ${accountId}::uuid
  `;

  if (!row) {
    return { active: false, reason: 'not_found' };
  }

  if (row.subscription_status === 'active') {
    return { active: true };
  }

  // Map the non-active status to a reason string.
  // Only the four canonical statuses from SubscriptionStatus are expected.
  const reason =
    row.subscription_status === 'pending_payment' ? 'pending_payment' :
    row.subscription_status === 'past_due' ? 'past_due' :
    row.subscription_status === 'cancelled' ? 'cancelled' :
    'not_found'; // fallback for unexpected values

  return { active: false, reason: reason as AccountInactiveResult['reason'] };
}

// ── getLocationContext ──────────────────────────────────────────────────────

export interface LocationContext {
  account: {
    id: string;
    subscriptionTier: string;
    subscriptionStatus: string;
    stripeCustomerId: string | null;
    stripeSubscriptionId: string | null;
    locationsIncluded: number;
    locationsPaid: number;
  };
  location: {
    id: string;
    isPrimary: boolean;
    displayLabel: string | null;
    name: string;
    archivedAt: Date | null;
  };
}

/**
 * Returns the account + location rows for a given location ID.
 * Validates that the location belongs to the returned account.
 * Returns null if the location doesn't exist or is archived.
 */
export async function getLocationContext(
  locationId: string,
): Promise<LocationContext | null> {
  // VAL-LOC-034: Returns null for archived locations, preventing workers
  // from operating on them. The WHERE clause excludes archived locations
  // so the query returns 0 rows when archived_at IS NOT NULL.
  const [row] = await sql<{
    account_id: string;
    subscription_tier: string;
    subscription_status: string;
    stripe_customer_id: string | null;
    stripe_subscription_id: string | null;
    locations_included: number;
    locations_paid: number;
    location_id: string;
    is_primary: boolean;
    display_label: string | null;
    name: string;
    archived_at: Date | null;
  }[]>`
    SELECT
      a.id AS account_id,
      a.subscription_tier,
      a.subscription_status,
      a.stripe_customer_id,
      a.stripe_subscription_id,
      a.locations_included,
      a.locations_paid,
      b.id AS location_id,
      b.is_primary,
      b.display_label,
      b.name,
      b.archived_at
    FROM businesses b
    JOIN accounts a ON a.id = b.account_id
    WHERE b.id = ${locationId}::uuid
      AND b.archived_at IS NULL
  `;

  if (!row) return null;

  return {
    account: {
      id: row.account_id,
      subscriptionTier: row.subscription_tier,
      subscriptionStatus: row.subscription_status,
      stripeCustomerId: row.stripe_customer_id,
      stripeSubscriptionId: row.stripe_subscription_id,
      locationsIncluded: row.locations_included,
      locationsPaid: row.locations_paid,
    },
    location: {
      id: row.location_id,
      isPrimary: row.is_primary,
      displayLabel: row.display_label,
      name: row.name,
      archivedAt: row.archived_at,
    },
  };
}

// ── getLocationContextForAccount ──────────────────────────────────────────

export interface AccountMismatchResult {
  kind: 'account_mismatch';
  /** The account that actually owns the location. */
  owningAccountId: string;
}

/**
 * Returns the account + location rows for a given location ID, but also
 * validates that the location belongs to the specified account.
 *
 * VAL-LOC-077: Workers validate that the job's accountId matches
 * location.account_id from getLocationContext. A mismatch indicates a
 * stale or misrouted job and must be rejected.
 *
 * Returns:
 *   - LocationContext when the location exists, is active, AND belongs to the given account
 *   - { kind: 'account_mismatch', owningAccountId } when the location exists but belongs to a different account
 *   - null when the location doesn't exist or is archived
 */
export async function getLocationContextForAccount(
  locationId: string,
  accountId: string,
): Promise<LocationContext | AccountMismatchResult | null> {
  const [row] = await sql<{
    account_id: string;
    subscription_tier: string;
    subscription_status: string;
    stripe_customer_id: string | null;
    stripe_subscription_id: string | null;
    locations_included: number;
    locations_paid: number;
    location_id: string;
    is_primary: boolean;
    display_label: string | null;
    name: string;
    archived_at: Date | null;
  }[]>`
    SELECT
      a.id AS account_id,
      a.subscription_tier,
      a.subscription_status,
      a.stripe_customer_id,
      a.stripe_subscription_id,
      a.locations_included,
      a.locations_paid,
      b.id AS location_id,
      b.is_primary,
      b.display_label,
      b.name,
      b.archived_at
    FROM businesses b
    JOIN accounts a ON a.id = b.account_id
    WHERE b.id = ${locationId}::uuid
      AND b.archived_at IS NULL
  `;

  // Location doesn't exist or is archived
  if (!row) return null;

  // VAL-LOC-077: Cross-account mismatch detection
  // The location exists but its account_id doesn't match the caller's account
  if (row.account_id !== accountId) {
    return { kind: 'account_mismatch', owningAccountId: row.account_id };
  }

  return {
    account: {
      id: row.account_id,
      subscriptionTier: row.subscription_tier,
      subscriptionStatus: row.subscription_status,
      stripeCustomerId: row.stripe_customer_id,
      stripeSubscriptionId: row.stripe_subscription_id,
      locationsIncluded: row.locations_included,
      locationsPaid: row.locations_paid,
    },
    location: {
      id: row.location_id,
      isPrimary: row.is_primary,
      displayLabel: row.display_label,
      name: row.name,
      archivedAt: row.archived_at,
    },
  };
}
