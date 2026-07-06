// src/lib/locations/__tests__/duplicate-place-id.integration.test.ts
//
// DB-gated integration test for C1: server-side duplicate google_place_id
// enforcement. Skips without TEST_DATABASE_POOL_URL (mirrors
// archive-location-tx.integration.test.ts).
//
// Invariant under test: businesses_account_place_uniq (migration 062) — an
// account cannot hold two ACTIVE locations with the same google_place_id. The
// Postgres 23505 unique violation must surface from addLocationTransaction as
// the typed 'duplicate_location' error (the route maps that to HTTP 409).

import { afterAll, beforeAll, expect, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { randomUUID } from 'node:crypto';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

let db: postgresType.Sql | undefined;

const DUP_PLACE_ID = 'PLACE_DUP';

const ids = {
  ownerUserId: randomUUID(),
  accountId: randomUUID(),
  primaryLocationId: randomUUID(),
};

function sql(): postgresType.Sql {
  if (!db) throw new Error('duplicate-place-id integration database was not initialized');
  return db;
}

describeWithDb('addLocationTransaction duplicate google_place_id enforcement integration', () => {
  beforeAll(async () => {
    db = postgres(testDatabaseUrl!, { max: 1, prepare: false, connection: { statement_timeout: 30_000 } });

    const ownerEmail = `dup-c1-${randomUUID()}@test.local`;
    await sql().begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`;
      await tx`
        INSERT INTO users (id, name, email, role, account_id)
        VALUES (${ids.ownerUserId}::uuid, 'Dup C1 Owner', ${ownerEmail}, 'owner', ${ids.accountId}::uuid)
      `;
      await tx`
        INSERT INTO accounts (id, owner_user_id, display_name, subscription_tier, subscription_status)
        VALUES (${ids.accountId}::uuid, ${ids.ownerUserId}::uuid, 'Dup C1 Account', 'standard', 'active')
      `;
      // An ACTIVE primary location already holding DUP_PLACE_ID.
      await tx`
        INSERT INTO businesses (
          id, name, owner_name, owner_email, account_id,
          subscription_status, is_primary, archived_at, google_place_id
        )
        VALUES (
          ${ids.primaryLocationId}::uuid, 'Primary Loc', 'Dup C1 Owner', ${ownerEmail}, ${ids.accountId}::uuid,
          'active', TRUE, NULL, ${DUP_PLACE_ID}
        )
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
    db = undefined;
  });

  it('rejects adding a second active location with a duplicate google_place_id', async () => {
    const { addLocationTransaction } = await import('../add-location-tx');

    await expect(
      addLocationTransaction(sql(), {
        accountId: ids.accountId,
        displayLabel: 'Duplicate Cafe',
        googlePlaceId: DUP_PLACE_ID,
        placeIdVerified: true,
        actorUserId: ids.ownerUserId,
        ownerName: 'Dup C1 Owner',
        ownerEmail: 'dup-c1-owner@test.local',
        subscriptionTier: 'standard',
        subscriptionStatus: 'active',
        activeLocationsBefore: 1,
      }),
    ).rejects.toThrow('duplicate_location');

    // No second active location row was committed for DUP_PLACE_ID.
    const [countRow] = await sql()<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM businesses
      WHERE account_id = ${ids.accountId}::uuid
        AND google_place_id = ${DUP_PLACE_ID}
        AND archived_at IS NULL
    `;
    expect(Number(countRow?.count)).toBe(1);
  });
});
