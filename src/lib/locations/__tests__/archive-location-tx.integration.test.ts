// src/lib/locations/__tests__/archive-location-tx.integration.test.ts
//
// DB-gated integration test for B1: race-proof primary archive.
// Skips without TEST_DATABASE_POOL_URL (mirrors audit-snapshot.integration.test.ts).
//
// Invariant under test: businesses_account_primary_uniq — the owner archive path
// must NOT archive the primary while another active location exists (promote_first),
// and a non-primary archive succeeds. Deterministic; no real concurrency.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { randomUUID } from 'node:crypto';

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;
const RUN = Boolean(testDatabaseUrl);
const d = RUN ? describe : describe.skip;

let db: postgresType.Sql | undefined;

const ids = {
  ownerUserId: randomUUID(),
  accountId: randomUUID(),
  primaryLocationId: randomUUID(),
  secondaryLocationId: randomUUID(),
};

function sql(): postgresType.Sql {
  if (!db) throw new Error('archive-location integration database was not initialized');
  return db;
}

d('archiveLocationTransaction primary-archive invariant integration', () => {
  beforeAll(async () => {
    db = postgres(testDatabaseUrl!, { max: 1, prepare: false, connection: { statement_timeout: 30_000 } });

    const ownerEmail = `archive-b1-${randomUUID()}@test.local`;
    await sql().begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`;
      await tx`
        INSERT INTO users (id, name, email, role, account_id)
        VALUES (${ids.ownerUserId}::uuid, 'Archive B1 Owner', ${ownerEmail}, 'owner', ${ids.accountId}::uuid)
      `;
      await tx`
        INSERT INTO accounts (id, owner_user_id, display_name, subscription_tier, subscription_status)
        VALUES (${ids.accountId}::uuid, ${ids.ownerUserId}::uuid, 'Archive B1 Account', 'standard', 'active')
      `;
      await tx`
        INSERT INTO businesses (id, name, owner_name, owner_email, account_id, subscription_status, is_primary, archived_at)
        VALUES (${ids.primaryLocationId}::uuid, 'Primary Loc', 'Archive B1 Owner', ${ownerEmail}, ${ids.accountId}::uuid, 'active', TRUE, NULL)
      `;
      await tx`
        INSERT INTO businesses (id, name, owner_name, owner_email, account_id, subscription_status, is_primary, archived_at)
        VALUES (${ids.secondaryLocationId}::uuid, 'Secondary Loc', 'Archive B1 Owner', ${ownerEmail}, ${ids.accountId}::uuid, 'active', FALSE, NULL)
      `;
    });
  });

  afterAll(async () => {
    if (!db) return;
    await sql().begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`;
      await tx`DELETE FROM account_audit_log WHERE account_id = ${ids.accountId}::uuid`;
      await tx`DELETE FROM job_outbox WHERE aggregate_id = ${ids.accountId}::uuid`;
      await tx`DELETE FROM businesses WHERE account_id = ${ids.accountId}::uuid`;
      await tx`DELETE FROM accounts WHERE id = ${ids.accountId}::uuid`;
      await tx`DELETE FROM users WHERE id = ${ids.ownerUserId}::uuid`;
    });
    await db.end({ timeout: 5 });
  });

  it('rejects archiving the primary with promote_first while a non-primary stays primary-free', async () => {
    const { archiveLocationTransaction } = await import('../archive-location-tx');

    await expect(
      archiveLocationTransaction({
        locationId: ids.primaryLocationId,
        accountId: ids.accountId,
        actorUserId: ids.ownerUserId,
        activeLocationsBefore: 2,
      }),
    ).rejects.toThrow('promote_first');

    // Primary row untouched.
    const [primary] = await sql()<{ archived_at: Date | null; is_primary: boolean }[]>`
      SELECT archived_at, is_primary FROM businesses WHERE id = ${ids.primaryLocationId}::uuid
    `;
    expect(primary).toBeDefined();
    expect(primary?.archived_at).toBeNull();
    expect(primary?.is_primary).toBe(true);
  });

  it('archives a non-primary location successfully', async () => {
    const { archiveLocationTransaction } = await import('../archive-location-tx');

    const result = await archiveLocationTransaction({
      locationId: ids.secondaryLocationId,
      accountId: ids.accountId,
      actorUserId: ids.ownerUserId,
      activeLocationsBefore: 2,
    });

    expect(result).toEqual({ locationId: ids.secondaryLocationId, archived: true });

    const [secondary] = await sql()<{ archived_at: Date | null; is_primary: boolean }[]>`
      SELECT archived_at, is_primary FROM businesses WHERE id = ${ids.secondaryLocationId}::uuid
    `;
    expect(secondary).toBeDefined();
    expect(secondary?.archived_at).not.toBeNull();
    expect(secondary?.is_primary).toBe(false);

    // Primary still the sole primary.
    const [primary] = await sql()<{ is_primary: boolean; archived_at: Date | null }[]>`
      SELECT is_primary, archived_at FROM businesses WHERE id = ${ids.primaryLocationId}::uuid
    `;
    expect(primary).toBeDefined();
    expect(primary?.is_primary).toBe(true);
    expect(primary?.archived_at).toBeNull();
  });
});
