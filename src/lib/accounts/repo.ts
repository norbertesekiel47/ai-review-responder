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

import type { Sql } from 'postgres';
import { isSubscriptionTier, type SubscriptionTierValue } from './tier-config';
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
  base_price_cents: number;
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
 *
 * @param sql  Postgres.js client (composition root supplies the singleton —
 *   this module never imports @/lib/db/server).
 */
export async function getAccountById(
  sql: Sql,
  accountId: string,
): Promise<AccountRow | null> {
  const [row] = await sql<Array<Omit<AccountRow, 'subscription_tier'> & {
    subscription_tier: string;
  }>>`
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
      base_price_cents,
      flags,
      created_at,
      updated_at
    FROM accounts
    WHERE id = ${accountId}::uuid
  `;

  if (!row) return null;
  if (!isSubscriptionTier(row.subscription_tier)) {
    throw new Error(`invalid_ws8_subscription_tier:${row.subscription_tier}`);
  }
  return { ...row, subscription_tier: row.subscription_tier };
}

// ── getAccountOwnerUserId ──────────────────────────────────────────────────

/**
 * Returns the owner_user_id for the given account.
 * Used by audit log to record actor_user_id when the caller
 * is the account owner (e.g., add-location endpoint).
 *
 * @param sql  Postgres.js client (composition root supplies the singleton —
 *   this module never imports @/lib/db/server).
 */
export async function getAccountOwnerUserId(
  sql: Sql,
  accountId: string,
): Promise<string | null> {
  const [row] = await sql<{ owner_user_id: string | null }[]>`
    SELECT owner_user_id
    FROM accounts
    WHERE id = ${accountId}::uuid
  `;

  return row?.owner_user_id ?? null;
}

/**
 * Returns the owner's identity (id, name, email) for the given account, by
 * joining accounts to users on owner_user_id.
 *
 * @param sql  Postgres.js client (composition root supplies the singleton —
 *   this module never imports @/lib/db/server).
 */
export async function getAccountOwnerUser(
  sql: Sql,
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
