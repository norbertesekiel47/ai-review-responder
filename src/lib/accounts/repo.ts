// src/lib/accounts/repo.ts
//
// Data access layer for account queries.
// Every piece of code that needs to query accounts must use this module —
// never write ad-hoc account SQL outside this file (per AGENTS.md).
//
// Exports:
//   getAccountById(accountId) — single account lookup
//   getAccountOwnerUserId(accountId) — owner user ID for audit actor
//
// Validation contract: indirectly covers account query assertions in
// VAL-BILLING-033 (isAccountActive reads from accounts),
// VAL-LOC-007 (add-location tx reads account fields).

import { sql } from '@/lib/db/server';
import type { AccountId } from '@/lib/shared/ids';
import type { SubscriptionTierValue } from './tier-config';
import type { SubscriptionStatusValue } from '@/lib/shared/subscription-status';

// ── Account row type ──────────────────────────────────────────────────────

export interface AccountRow {
  id: string;
  owner_user_id: string;
  display_name: string;
  subscription_tier: SubscriptionTierValue;
  subscription_status: SubscriptionStatusValue;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  trial_ends_at: Date | null;
  subscription_activated_at: Date | null;
  locations_included: number;
  locations_paid: number;
  locations_overage_price_cents: number;
  flags: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface AccountOwnerUserRow {
  id: string;
  name: string;
  email: string;
}

// ── getAccountById ─────────────────────────────────────────────────────────

/**
 * Returns a single account by ID. Returns null if the account does not exist.
 *
 * Used by add-location flow (reads tier/status for businesses INSERT),
// billing snapshot computation, and account-level queries.
 */
export async function getAccountById(
  accountId: string,
): Promise<AccountRow | null> {
  const [row] = await sql<AccountRow[]>`
    SELECT
      id,
      owner_user_id,
      display_name,
      subscription_tier,
      subscription_status,
      stripe_customer_id,
      stripe_subscription_id,
      trial_ends_at,
      subscription_activated_at,
      locations_included,
      locations_paid,
      locations_overage_price_cents,
      flags,
      created_at,
      updated_at
    FROM accounts
    WHERE id = ${accountId}::uuid
  `;

  return row ?? null;
}

// ── getAccountOwnerUserId ──────────────────────────────────────────────────

/**
 * Returns the owner_user_id for the given account.
 * Used by audit log to record actor_user_id when the caller
 * is the account owner (e.g., add-location endpoint).
 */
export async function getAccountOwnerUserId(
  accountId: string,
): Promise<string | null> {
  const [row] = await sql<{ owner_user_id: string | null }[]>`
    SELECT owner_user_id
    FROM accounts
    WHERE id = ${accountId}::uuid
  `;

  return row?.owner_user_id ?? null;
}

export async function getAccountOwnerUser(
  accountId: string,
): Promise<AccountOwnerUserRow | null> {
  const [row] = await sql<AccountOwnerUserRow[]>`
    SELECT u.id, u.name, u.email
    FROM accounts a
    JOIN users u ON u.id = a.owner_user_id
    WHERE a.id = ${accountId}::uuid
    LIMIT 1
  `;

  return row ?? null;
}
