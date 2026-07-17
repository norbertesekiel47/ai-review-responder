// Shared live-DB tenant seed for integration tests gated on
// TEST_DATABASE_POOL_URL.
//
// NOT a test file: the vitest include glob only matches
// `**/__tests__/**/*.test.{ts,tsx}`, so this helper is invisible to the
// runner and only ever loaded by suites that import it.
//
// Owns exactly the awkward part every live-DB suite was copy-pasting:
// `users.account_id` <-> `accounts.owner_user_id` are mutually referential,
// so the owner user + account pair must be inserted in ONE transaction with
// FK checks deferred to commit. Domain rows (businesses, reviews,
// connections, …) reference already-committed parents and need no deferral —
// callers insert those themselves after seeding, and delete them before
// calling `cleanupTenantAccount`.
//
// Deliberately independent of e2e/seed.ts (Playwright lane): these vitest
// suites talk straight Postgres.js against TEST_DATABASE_POOL_URL.

import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';

export interface TenantSeed {
  userId: string;
  accountId: string;
  ownerEmail: string;
}

export interface SeedTenantAccountOverrides {
  userId?: string;
  accountId?: string;
  /** Defaults to `tenant-<accountId>@test.local`. */
  ownerEmail?: string;
  userName?: string;
  accountDisplayName?: string;
  subscriptionTier?: string;
  subscriptionStatus?: string;
}

/**
 * Inserts an owner user + account pair (deferred-constraints transaction)
 * and returns the ids. Pass overrides when a suite pins its own ids/labels.
 */
export async function seedTenantAccount(
  db: Sql,
  overrides: SeedTenantAccountOverrides = {},
): Promise<TenantSeed> {
  const userId = overrides.userId ?? randomUUID();
  const accountId = overrides.accountId ?? randomUUID();
  const ownerEmail = overrides.ownerEmail ?? `tenant-${accountId}@test.local`;
  const userName = overrides.userName ?? 'Tenant Seed Owner';
  const accountDisplayName = overrides.accountDisplayName ?? 'Tenant Seed Account';
  const subscriptionTier = overrides.subscriptionTier ?? 'copilot';
  const subscriptionStatus = overrides.subscriptionStatus ?? 'active';

  await db.begin(async (tx) => {
    // users.account_id <-> accounts.owner_user_id are mutually referential.
    await tx`SET CONSTRAINTS ALL DEFERRED`;
    await tx`
      INSERT INTO users (id, name, email, role, account_id)
      VALUES (${userId}::uuid, ${userName}, ${ownerEmail}, 'owner', ${accountId}::uuid)
    `;
    await tx`
      INSERT INTO accounts (id, owner_user_id, display_name, subscription_tier, subscription_status)
      VALUES (${accountId}::uuid, ${userId}::uuid, ${accountDisplayName}, ${subscriptionTier}, ${subscriptionStatus})
    `;
  });

  return { userId, accountId, ownerEmail };
}

/**
 * Deletes the seeded account + user pair (deferred-constraints transaction).
 * Callers must have removed their own domain rows referencing the pair first.
 */
export async function cleanupTenantAccount(
  db: Sql,
  ids: Pick<TenantSeed, 'userId' | 'accountId'>,
): Promise<void> {
  await db.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`;
    await tx`DELETE FROM accounts WHERE id = ${ids.accountId}::uuid`;
    await tx`DELETE FROM users WHERE id = ${ids.userId}::uuid`;
  });
}
