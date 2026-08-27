// src/lib/locations/__tests__/review-qr.integration.test.ts
//
// Task 1 eval suite for the review-qr module against live Postgres (codex R1
// M5/M6): a mocked `sql` tag can prove the template was interpolated; only a
// live DB proves the exclusion predicate (account scope + archived filter)
// and the authoritative-column JOIN (accounts.subscription_status deciding,
// never the deprecated businesses.subscription_status). Authored FAILING
// before the module exists; Task 4 turns it green.
//
// Live-DB conventions (CLAUDE.md gotcha, `ci:live-db-suites`): named
// `*.integration.test.ts`, gated by describeWithDb, asserts its schema, and
// NEVER applies migration SQL. Seed helpers keep their real signatures
// (live-db-tenant.ts); columns those helpers do not model
// (google_place_id, archived_at, the deprecated businesses.subscription_status)
// are set by plain UPDATEs — DML, never DDL.

import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  cleanupLocation,
  cleanupTenantAccount,
  seedLocation,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import {
  assertSchemaReady,
  type SchemaRequirement,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import { getOwnerReviewQrLocations, resolveQrRedirect } from '../review-qr';

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

// Every column this suite touches predates migration head by years — the
// requirement exists so a hollow container fails loudly at setup, not
// mysteriously mid-test (#573 posture).
const REVIEW_QR_READS: SchemaRequirement = {
  migration: '001_initial_schema (+ multi-location columns, review-qr reads)',
  tables: ['businesses', 'accounts'],
  columns: [
    'businesses.google_place_id',
    'businesses.archived_at',
    'businesses.display_label',
    'businesses.subscription_status',
    'accounts.subscription_status',
  ],
};

let db: postgresType.Sql | undefined;
let tenantA: TenantSeed | undefined;
let tenantB: TenantSeed | undefined;
let tenantC: TenantSeed | undefined;

function sql(): postgresType.Sql {
  if (!db) throw new Error('review-qr integration database was not initialized');
  return db;
}

const CANONICAL_PLACE_ID = 'ChIJN1t_tDeuEmsRUsoyG83frY4';

/** Locations seeded by the current test, removed (children-first) afterEach. */
const seededLocationIds: string[] = [];

async function seedQrLocation(
  accountId: string,
  opts: { placeId?: string | null; archived?: boolean; isPrimary?: boolean; name?: string } = {},
): Promise<string> {
  const { businessId } = await seedLocation(sql(), accountId, {
    name: opts.name ?? 'QR Seed Location',
    isPrimary: opts.isPrimary ?? true,
  });
  seededLocationIds.push(businessId);
  await sql()`
    UPDATE businesses
    SET google_place_id = ${opts.placeId ?? null},
        archived_at = ${opts.archived ? sql()`now()` : null}
    WHERE id = ${businessId}::uuid
  `;
  return businessId;
}

describeWithDb('review-qr module against live Postgres', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    db = postgres(testDatabaseUrl!, { max: 2, prepare: false });
    await assertSchemaReady(db, [REVIEW_QR_READS]);
    tenantA = await seedTenantAccount(db, { accountDisplayName: 'QR Account A' });
    tenantB = await seedTenantAccount(db, { accountDisplayName: 'QR Account B' });
    tenantC = await seedTenantAccount(db, {
      accountDisplayName: 'QR Account C',
      subscriptionStatus: 'cancelled',
    });
  });

  afterEach(async () => {
    for (const businessId of seededLocationIds.splice(0)) {
      await cleanupLocation(sql(), businessId);
    }
  });

  afterAll(async () => {
    if (!db) return;
    for (const tenant of [tenantA, tenantB, tenantC]) {
      if (tenant) await cleanupTenantAccount(sql(), tenant);
    }
    await db.end({ timeout: 5 });
  });

  it("excludes another account's locations and the caller's archived locations", async () => {
    // Account A: one eligible location (canonical place id) and one ARCHIVED
    // location; account B: one eligible location.
    const eligibleA = await seedQrLocation(tenantA!.accountId, {
      placeId: CANONICAL_PLACE_ID,
      name: 'Eligible A',
    });
    await seedQrLocation(tenantA!.accountId, {
      placeId: CANONICAL_PLACE_ID,
      archived: true,
      isPrimary: false,
      name: 'Archived A',
    });
    await seedQrLocation(tenantB!.accountId, {
      placeId: CANONICAL_PLACE_ID,
      name: 'Eligible B',
    });

    const locations = await getOwnerReviewQrLocations(
      sql(),
      tenantA!.accountId,
      'https://app.example.com',
    );

    // EXACTLY the one eligible A location — B's location and the archived one
    // are absent.
    expect(locations).toHaveLength(1);
    expect(locations[0]?.businessId).toBe(eligibleA);
    expect(locations[0]?.qrTargetUrl.endsWith(`/q/${eligibleA}`)).toBe(true);
  });

  it('reads the subscription gate from accounts.subscription_status, not the deprecated businesses column', async () => {
    // Account C: accounts.subscription_status = 'cancelled' (seeded above)
    // while the location row carries the DEPRECATED
    // businesses.subscription_status = 'active' and a canonical place id.
    const businessId = await seedQrLocation(tenantC!.accountId, {
      placeId: CANONICAL_PLACE_ID,
      name: 'Diverged C',
    });
    await sql()`
      UPDATE businesses SET subscription_status = 'active'
      WHERE id = ${businessId}::uuid
    `;

    expect(await resolveQrRedirect(sql(), businessId)).toEqual({
      kind: 'unavailable',
      reason: 'subscription',
    });

    // Flip the divergence: accounts live, deprecated column cancelled. Only
    // accounts.subscription_status may decide.
    await sql()`
      UPDATE accounts SET subscription_status = 'active'
      WHERE id = ${tenantC!.accountId}::uuid
    `;
    await sql()`
      UPDATE businesses SET subscription_status = 'cancelled'
      WHERE id = ${businessId}::uuid
    `;

    expect((await resolveQrRedirect(sql(), businessId)).kind).toBe('redirect');

    // Restore the tenant's seeded posture for suite hygiene.
    await sql()`
      UPDATE accounts SET subscription_status = 'cancelled'
      WHERE id = ${tenantC!.accountId}::uuid
    `;
  });
});
