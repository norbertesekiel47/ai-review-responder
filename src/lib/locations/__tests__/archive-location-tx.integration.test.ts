// src/lib/locations/__tests__/archive-location-tx.integration.test.ts
//
// DB-gated integration test for B1: race-proof primary archive.
// Skips without TEST_DATABASE_POOL_URL (mirrors audit-snapshot.integration.test.ts).
//
// Invariant under test: businesses_account_primary_uniq — the owner archive path
// must NOT archive the primary while another active location exists (promote_first),
// and a non-primary archive succeeds. Deterministic; no real concurrency.

import { afterAll, beforeAll, expect, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { randomUUID } from 'node:crypto';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

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

describeWithDb('archiveLocationTransaction primary-archive invariant integration', () => {
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
    // Release the shared pool; the B3 describe re-creates it in its beforeAll
    // (guarded by `if (!db)`), so it must observe a fresh/undefined handle.
    await db.end({ timeout: 5 });
    db = undefined;
  });

  it('rejects archiving the primary with promote_first while a non-primary stays primary-free', async () => {
    const { archiveLocationTransaction } = await import('../archive-location-tx');

    await expect(
      archiveLocationTransaction(sql(), {
        locationId: ids.primaryLocationId,
        accountId: ids.accountId,
        actorUserId: ids.ownerUserId,
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

    const result = await archiveLocationTransaction(sql(), {
      locationId: ids.secondaryLocationId,
      accountId: ids.accountId,
      actorUserId: ids.ownerUserId,
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

// ══════════════════════════════════════════════════════════════════════════
// B3: reactivation self-heals a zero-primary account
// ══════════════════════════════════════════════════════════════════════════
// Deterministic (no real concurrency). Two independent accounts:
//   - zeroPrimary: primary archived → zero active primaries; reactivating the
//     secondary must make it the SOLE active primary (selfPromoted=true).
//   - hasPrimary: an active primary already exists; reactivating the archived
//     secondary must leave the existing primary untouched (selfPromoted=false).

const b3 = {
  // Each account needs its OWN owner: idx_accounts_owner_unique (migration 038)
  // is a partial unique index on accounts(owner_user_id), so two accounts cannot
  // share an owner_user_id.
  zeroPrimaryOwnerUserId: randomUUID(),
  hasPrimaryOwnerUserId: randomUUID(),
  zeroPrimaryAccountId: randomUUID(),
  zeroPrimaryArchivedPrimaryId: randomUUID(),
  zeroPrimarySecondaryId: randomUUID(),
  hasPrimaryAccountId: randomUUID(),
  hasPrimaryPrimaryId: randomUUID(),
  hasPrimaryArchivedSecondaryId: randomUUID(),
};

describeWithDb('reactivateLocationTransaction zero-primary self-heal integration', () => {
  beforeAll(async () => {
    if (!db) {
      db = postgres(testDatabaseUrl!, { max: 1, prepare: false, connection: { statement_timeout: 30_000 } });
    }

    const zeroPrimaryEmail = `reactivate-b3-zp-${randomUUID()}@test.local`;
    const hasPrimaryEmail = `reactivate-b3-hp-${randomUUID()}@test.local`;
    await sql().begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`;
      await tx`
        INSERT INTO users (id, name, email, role, account_id)
        VALUES (${b3.zeroPrimaryOwnerUserId}::uuid, 'Reactivate B3 ZeroPrimary Owner', ${zeroPrimaryEmail}, 'owner', ${b3.zeroPrimaryAccountId}::uuid)
      `;
      await tx`
        INSERT INTO users (id, name, email, role, account_id)
        VALUES (${b3.hasPrimaryOwnerUserId}::uuid, 'Reactivate B3 HasPrimary Owner', ${hasPrimaryEmail}, 'owner', ${b3.hasPrimaryAccountId}::uuid)
      `;

      // Account 1: zero active primaries (primary archived).
      await tx`
        INSERT INTO accounts (id, owner_user_id, display_name, subscription_tier, subscription_status, subscription_activated_at)
        VALUES (${b3.zeroPrimaryAccountId}::uuid, ${b3.zeroPrimaryOwnerUserId}::uuid, 'B3 ZeroPrimary Account', 'standard', 'active', NOW())
      `;
      await tx`
        INSERT INTO businesses (id, name, owner_name, owner_email, account_id, subscription_status, is_primary, archived_at)
        VALUES (${b3.zeroPrimaryArchivedPrimaryId}::uuid, 'Zero Primary (archived)', 'Reactivate B3 Owner', ${zeroPrimaryEmail}, ${b3.zeroPrimaryAccountId}::uuid, 'active', FALSE, NOW())
      `;
      await tx`
        INSERT INTO businesses (id, name, owner_name, owner_email, account_id, subscription_status, is_primary, archived_at)
        VALUES (${b3.zeroPrimarySecondaryId}::uuid, 'Zero Secondary (archived)', 'Reactivate B3 Owner', ${zeroPrimaryEmail}, ${b3.zeroPrimaryAccountId}::uuid, 'active', FALSE, NOW())
      `;

      // Account 2: an active primary already exists (separate owner).
      await tx`
        INSERT INTO accounts (id, owner_user_id, display_name, subscription_tier, subscription_status, subscription_activated_at)
        VALUES (${b3.hasPrimaryAccountId}::uuid, ${b3.hasPrimaryOwnerUserId}::uuid, 'B3 HasPrimary Account', 'standard', 'active', NOW())
      `;
      await tx`
        INSERT INTO businesses (id, name, owner_name, owner_email, account_id, subscription_status, is_primary, archived_at)
        VALUES (${b3.hasPrimaryPrimaryId}::uuid, 'Has Primary (active)', 'Reactivate B3 Owner', ${hasPrimaryEmail}, ${b3.hasPrimaryAccountId}::uuid, 'active', TRUE, NULL)
      `;
      await tx`
        INSERT INTO businesses (id, name, owner_name, owner_email, account_id, subscription_status, is_primary, archived_at)
        VALUES (${b3.hasPrimaryArchivedSecondaryId}::uuid, 'Has Secondary (archived)', 'Reactivate B3 Owner', ${hasPrimaryEmail}, ${b3.hasPrimaryAccountId}::uuid, 'active', FALSE, NOW())
      `;
    });
  });

  afterAll(async () => {
    if (!db) return;
    await sql().begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`;
      await tx`DELETE FROM account_audit_log WHERE account_id IN (${b3.zeroPrimaryAccountId}::uuid, ${b3.hasPrimaryAccountId}::uuid)`;
      await tx`DELETE FROM job_outbox WHERE aggregate_id IN (${b3.zeroPrimaryAccountId}::uuid, ${b3.hasPrimaryAccountId}::uuid, ${b3.zeroPrimarySecondaryId}::uuid, ${b3.hasPrimaryArchivedSecondaryId}::uuid)`;
      await tx`DELETE FROM businesses WHERE account_id IN (${b3.zeroPrimaryAccountId}::uuid, ${b3.hasPrimaryAccountId}::uuid)`;
      await tx`DELETE FROM accounts WHERE id IN (${b3.zeroPrimaryAccountId}::uuid, ${b3.hasPrimaryAccountId}::uuid)`;
      await tx`DELETE FROM users WHERE id IN (${b3.zeroPrimaryOwnerUserId}::uuid, ${b3.hasPrimaryOwnerUserId}::uuid)`;
    });
    await db.end({ timeout: 5 });
    db = undefined;
  });

  it('self-promotes the reactivated location to sole primary when the account has zero active primaries', async () => {
    const { reactivateLocationTransaction } = await import('../archive-location-tx');

    const result = await reactivateLocationTransaction(sql(), {
      locationId: b3.zeroPrimarySecondaryId,
      accountId: b3.zeroPrimaryAccountId,
      actorUserId: b3.zeroPrimaryOwnerUserId,
    });

    expect(result.reactivated).toBe(true);
    expect(result.selfPromoted).toBe(true);

    // The reactivated location is now active AND primary.
    const [reactivated] = await sql()<{ archived_at: Date | null; is_primary: boolean }[]>`
      SELECT archived_at, is_primary FROM businesses WHERE id = ${b3.zeroPrimarySecondaryId}::uuid
    `;
    expect(reactivated?.archived_at).toBeNull();
    expect(reactivated?.is_primary).toBe(true);

    // It is the SOLE active primary for the account.
    const [primaryCountRow] = await sql()<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM businesses
      WHERE account_id = ${b3.zeroPrimaryAccountId}::uuid AND is_primary = TRUE AND archived_at IS NULL
    `;
    expect(Number(primaryCountRow?.count)).toBe(1);

    // A primary_promoted audit row was written for the self-heal.
    const [auditCountRow] = await sql()<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM account_audit_log
      WHERE account_id = ${b3.zeroPrimaryAccountId}::uuid
        AND location_id = ${b3.zeroPrimarySecondaryId}::uuid
        AND event_type = 'primary_promoted'
    `;
    expect(Number(auditCountRow?.count)).toBe(1);
  });

  it('leaves the existing primary untouched when the account already has an active primary', async () => {
    const { reactivateLocationTransaction } = await import('../archive-location-tx');

    const result = await reactivateLocationTransaction(sql(), {
      locationId: b3.hasPrimaryArchivedSecondaryId,
      accountId: b3.hasPrimaryAccountId,
      actorUserId: b3.hasPrimaryOwnerUserId,
    });

    expect(result.reactivated).toBe(true);
    expect(result.selfPromoted).toBe(false);

    // Reactivated secondary is active but NOT primary.
    const [secondary] = await sql()<{ archived_at: Date | null; is_primary: boolean }[]>`
      SELECT archived_at, is_primary FROM businesses WHERE id = ${b3.hasPrimaryArchivedSecondaryId}::uuid
    `;
    expect(secondary?.archived_at).toBeNull();
    expect(secondary?.is_primary).toBe(false);

    // The pre-existing primary is still THE primary.
    const [primary] = await sql()<{ is_primary: boolean; archived_at: Date | null }[]>`
      SELECT is_primary, archived_at FROM businesses WHERE id = ${b3.hasPrimaryPrimaryId}::uuid
    `;
    expect(primary?.is_primary).toBe(true);
    expect(primary?.archived_at).toBeNull();

    // No primary_promoted audit row for the no-op case.
    const [noopAuditRow] = await sql()<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM account_audit_log
      WHERE account_id = ${b3.hasPrimaryAccountId}::uuid
        AND event_type = 'primary_promoted'
    `;
    expect(Number(noopAuditRow?.count)).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// B3 race: two CONCURRENT reactivations against a zero-primary account
// ══════════════════════════════════════════════════════════════════════════
// Real concurrency (not deterministic mocks): both reactivations run through
// the module's connection pool at once. The accounts FOR UPDATE lock taken
// FIRST in reactivateLocationTransaction must serialize them so exactly one
// self-promotes — without it both would read primary-count 0 and both promote
// (double-primary, tripping businesses_account_primary_uniq or worse).

const race = {
  ownerUserId: randomUUID(),
  accountId: randomUUID(),
  archivedLocationAId: randomUUID(),
  archivedLocationBId: randomUUID(),
};

describeWithDb('reactivateLocationTransaction concurrent zero-primary race integration', () => {
  beforeAll(async () => {
    if (!db) {
      db = postgres(testDatabaseUrl!, { max: 1, prepare: false, connection: { statement_timeout: 30_000 } });
    }

    const ownerEmail = `reactivate-race-${randomUUID()}@test.local`;
    await sql().begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`;
      await tx`
        INSERT INTO users (id, name, email, role, account_id)
        VALUES (${race.ownerUserId}::uuid, 'Reactivate Race Owner', ${ownerEmail}, 'owner', ${race.accountId}::uuid)
      `;
      await tx`
        INSERT INTO accounts (id, owner_user_id, display_name, subscription_tier, subscription_status, subscription_activated_at)
        VALUES (${race.accountId}::uuid, ${race.ownerUserId}::uuid, 'Reactivate Race Account', 'standard', 'active', NOW())
      `;
      // Zero active primaries: both locations archived, neither primary.
      await tx`
        INSERT INTO businesses (id, name, owner_name, owner_email, account_id, subscription_status, is_primary, archived_at)
        VALUES (${race.archivedLocationAId}::uuid, 'Race Loc A (archived)', 'Reactivate Race Owner', ${ownerEmail}, ${race.accountId}::uuid, 'active', FALSE, NOW())
      `;
      await tx`
        INSERT INTO businesses (id, name, owner_name, owner_email, account_id, subscription_status, is_primary, archived_at)
        VALUES (${race.archivedLocationBId}::uuid, 'Race Loc B (archived)', 'Reactivate Race Owner', ${ownerEmail}, ${race.accountId}::uuid, 'active', FALSE, NOW())
      `;
    });
  });

  afterAll(async () => {
    if (!db) return;
    await sql().begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`;
      await tx`DELETE FROM account_audit_log WHERE account_id = ${race.accountId}::uuid`;
      await tx`DELETE FROM job_outbox WHERE aggregate_id IN (${race.accountId}::uuid, ${race.archivedLocationAId}::uuid, ${race.archivedLocationBId}::uuid)`;
      await tx`DELETE FROM businesses WHERE account_id = ${race.accountId}::uuid`;
      await tx`DELETE FROM accounts WHERE id = ${race.accountId}::uuid`;
      await tx`DELETE FROM users WHERE id = ${race.ownerUserId}::uuid`;
    });
    await db.end({ timeout: 5 });
    db = undefined;
  });

  it('exactly one of two concurrent reactivations self-promotes; exactly one active primary results', async () => {
    const { reactivateLocationTransaction } = await import('../archive-location-tx');

    // Start both reactivations together — the module pool (max > 1) runs them
    // on separate connections, so they genuinely contend for the account lock.
    const [resultA, resultB] = await Promise.all([
      reactivateLocationTransaction(sql(), {
        locationId: race.archivedLocationAId,
        accountId: race.accountId,
        actorUserId: race.ownerUserId,
      }),
      reactivateLocationTransaction(sql(), {
        locationId: race.archivedLocationBId,
        accountId: race.accountId,
        actorUserId: race.ownerUserId,
      }),
    ]);

    expect(resultA.reactivated).toBe(true);
    expect(resultB.reactivated).toBe(true);

    // Exactly ONE result self-promoted.
    const promotedCount = [resultA, resultB].filter((r) => r.selfPromoted).length;
    expect(promotedCount).toBe(1);

    // Exactly ONE businesses row is the active primary.
    const [primaryRow] = await sql()<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM businesses
      WHERE account_id = ${race.accountId}::uuid AND is_primary = TRUE AND archived_at IS NULL
    `;
    expect(Number(primaryRow?.count)).toBe(1);

    // Both locations are active again.
    const [activeRow] = await sql()<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM businesses
      WHERE account_id = ${race.accountId}::uuid AND archived_at IS NULL
    `;
    expect(Number(activeRow?.count)).toBe(2);

    // Exactly one primary_promoted audit row (the self-heal is audited once).
    const [auditRow] = await sql()<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM account_audit_log
      WHERE account_id = ${race.accountId}::uuid AND event_type = 'primary_promoted'
    `;
    expect(Number(auditRow?.count)).toBe(1);
  });
});
