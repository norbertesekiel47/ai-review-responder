// src/lib/onboarding/__tests__/admin-onboarding-rollback.integration.test.ts
//
// Regression suite for D-8 (2026-09-02): `rollbackProvisionedBusiness` could
// never remove a single row, and the mocked characterization suite next door
// PASSED throughout.
//
// WHY LIVE POSTGRES. The defect is entirely in the foreign keys, and a mocked
// `sql` tag has none. `fk_businesses_account` is
// `FOREIGN KEY (account_id) REFERENCES accounts(id)` with NO ON DELETE CASCADE
// and no deferral, so deleting `accounts` while the `businesses` row still
// points at it raises 23503, aborts the enclosing `sql.begin`, and rolls back
// every earlier DELETE with it. The function removed NOTHING — and it is
// reached only when a business row exists, which is exactly what made it fail.
//
// The sibling suite asserts emitted SQL TEXT. That is necessary and not
// sufficient: it pinned the broken order as correct for as long as the bug
// lived. This suite asserts the rows are GONE, which is the claim the caller
// actually depends on.
//
// Found in production: an admin onboarding hit an SMTP 535 (the 2026-09-01
// Resend rotation invalidated Supabase Auth's SMTP password), the compensating
// rollback ran, and all three rows survived.
//
// Live-DB conventions (CLAUDE.md gotcha, `ci:live-db-suites`): named
// `*.integration.test.ts`, gated by describeWithDb, asserts its schema via
// assertSchemaReady, and NEVER applies migration SQL.
//
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  seedLocation,
  seedTenantAccount,
} from '@/lib/shared/__tests__/live-db-tenant';
import { assertSchemaReady } from '@/lib/shared/__tests__/helpers/schema-ready';
import { rollbackProvisionedBusiness } from '../admin-onboarding-service';

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

let db: postgresType.Sql | undefined;

function sql(): postgresType.Sql {
  if (!db) throw new Error('admin-onboarding rollback integration db not initialized');
  return db;
}

/**
 * Seeds the exact shape `onboardBusinessAsAdmin` leaves behind when
 * `createBusinessTx` has committed and the invite send then fails: an owner
 * user, its account, and a primary business pointing at that account.
 *
 * Seeded through raw SQL rather than through the production writer, so a broken
 * writer cannot construct its own passing precondition.
 */
async function seedProvisionedBusiness(): Promise<{
  businessId: string;
  userId: string;
  accountId: string;
}> {
  const tenant = await seedTenantAccount(sql(), {
    userName: 'Rollback Fixture Owner',
    accountDisplayName: 'Rollback Fixture Account',
    subscriptionStatus: 'pending_payment',
  });
  const { businessId } = await seedLocation(sql(), tenant.accountId, {
    name: 'Rollback Fixture Location',
    ownerEmail: tenant.ownerEmail,
  });
  return { businessId, userId: tenant.userId, accountId: tenant.accountId };
}

async function rowCounts(ids: {
  businessId: string;
  userId: string;
  accountId: string;
}): Promise<{ users: number; businesses: number; accounts: number }> {
  const rows = await sql()<{ users: number; businesses: number; accounts: number }[]>`
    SELECT
      (SELECT count(*)::int FROM users      WHERE id = ${ids.userId}::uuid)     AS users,
      (SELECT count(*)::int FROM businesses WHERE id = ${ids.businessId}::uuid) AS businesses,
      (SELECT count(*)::int FROM accounts   WHERE id = ${ids.accountId}::uuid)  AS accounts
  `;
  const row = rows[0];
  if (!row) throw new Error('count query returned no row');
  return row;
}

describeWithDb('rollbackProvisionedBusiness (live DB)', () => {
  let ids: { businessId: string; userId: string; accountId: string };

  beforeAll(async () => {
    db = postgres(testDatabaseUrl!, { max: 1, prepare: false });
    // No migration pinned: this suite exercises base-schema foreign keys that
    // have existed since 001. assertSchemaReady still runs so a behind-head
    // database fails loudly rather than silently.
    await assertSchemaReady(db, []);
  });

  beforeEach(async () => {
    ids = await seedProvisionedBusiness();
  });

  afterAll(async () => {
    await db?.end({ timeout: 5 });
    db = undefined;
  });

  it('removes the users, businesses and accounts rows — the claim the caller depends on', async () => {
    expect(await rowCounts(ids)).toEqual({ users: 1, businesses: 1, accounts: 1 });

    await rollbackProvisionedBusiness(sql(), ids);

    // Before the D-8 fix this returned {1,1,1}: the transaction aborted on
    // 23503 and every delete rolled back. The mocked suite could not see it.
    expect(await rowCounts(ids)).toEqual({ users: 0, businesses: 0, accounts: 0 });
  });

  it('cascades the businesses-owned children rather than leaving them behind', async () => {
    await sql()`
      INSERT INTO channel_enrollments (id, account_id, business_id, channel, status)
      VALUES (${randomUUID()}::uuid, ${ids.accountId}::uuid, ${ids.businessId}::uuid,
              'email', 'pending_verification')
    `;

    await rollbackProvisionedBusiness(sql(), ids);

    const remaining = await sql()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM channel_enrollments
      WHERE business_id = ${ids.businessId}::uuid
    `;
    expect(remaining[0]?.n).toBe(0);
  });

  it('NEGATIVE CONTROL: the pre-fix order still raises 23503, so this suite cannot pass vacuously', async () => {
    // The exact statement sequence the function shipped until 2026-09-02.
    // If this ever stops throwing, `fk_businesses_account` gained a cascade and
    // the ordering rule above is no longer load-bearing — read the constraint
    // before relaxing anything.
    await expect(
      sql().begin(async (tx) => {
        await tx`DELETE FROM job_outbox WHERE aggregate_id = ${ids.businessId}::uuid`;
        await tx`DELETE FROM users      WHERE id = ${ids.userId}::uuid`;
        await tx`DELETE FROM accounts   WHERE id = ${ids.accountId}::uuid`;
        await tx`DELETE FROM businesses WHERE id = ${ids.businessId}::uuid`;
      }),
    ).rejects.toMatchObject({ code: '23503' });

    // And the aborted transaction left everything in place — which is the
    // production symptom, reproduced.
    expect(await rowCounts(ids)).toEqual({ users: 1, businesses: 1, accounts: 1 });

    await rollbackProvisionedBusiness(sql(), ids);
  });
});
