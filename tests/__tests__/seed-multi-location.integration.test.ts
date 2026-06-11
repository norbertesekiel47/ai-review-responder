// tests/__tests__/seed-multi-location.integration.test.ts
//
// DB-gated integration test for the F1 multi-location E2E seeder.
//
// Replaces the prior vacuous export-only test: it exercises the REAL seeder
// against Postgres and asserts the seeded contract (the two-location account
// shape every multi-location E2E relies on), then proves cleanup removes it.
//
// Skips cleanly without TEST_DATABASE_POOL_URL (mirrors the repo's other
// DB-gated integration tests, e.g. archive-location-tx.integration.test.ts):
// the seeder's own isE2eConfigured gate is the single source of truth for
// "can we write to a test DB", so we reuse it for the skip predicate.

import { describe, expect, it } from 'vitest';
import {
  isE2eConfigured,
  seedMultiLocationAccount,
  cleanupMultiLocationAccount,
  getE2eSql,
} from '../../e2e/seed';

// One runnable assertion even when the DB is absent, so the file is never a
// pure no-op in CI (where TEST_DATABASE_POOL_URL is unset). This guards the
// public surface the E2E kit imports.
describe('e2e/seed — multi-location exports', () => {
  it('exports seedMultiLocationAccount and cleanupMultiLocationAccount as functions', () => {
    expect(typeof seedMultiLocationAccount).toBe('function');
    expect(typeof cleanupMultiLocationAccount).toBe('function');
  });
});

describe.skipIf(!isE2eConfigured)(
  'seedMultiLocationAccount — DB-backed contract (integration)',
  () => {
    it('seeds the two-location account shape and cleans it up fully', async () => {
      const sql = getE2eSql();
      const seed = await seedMultiLocationAccount();

      try {
        // ── Account: standard-tier point-in-time snapshot (invariant #9a) ──
        const [account] = await sql<
          {
            locations_overage_price_cents: number;
            base_price_cents: number;
            locations_included: number;
            subscription_tier: string;
          }[]
        >`
          SELECT locations_overage_price_cents, base_price_cents, locations_included, subscription_tier
          FROM accounts WHERE id = ${seed.accountId}::uuid
        `;
        expect(account).toBeDefined();
        expect(account?.subscription_tier).toBe('standard');
        expect(Number(account?.locations_overage_price_cents)).toBe(2500);
        expect(Number(account?.base_price_cents)).toBe(7900);
        expect(Number(account?.locations_included)).toBe(2);

        // ── Businesses: exactly 2, one primary + one secondary, distinct
        //    non-null google_place_id. ──
        const businesses = await sql<
          { id: string; is_primary: boolean; google_place_id: string | null }[]
        >`
          SELECT id, is_primary, google_place_id
          FROM businesses WHERE account_id = ${seed.accountId}::uuid
          ORDER BY is_primary DESC
        `;
        expect(businesses).toHaveLength(2);
        const primaries = businesses.filter((b) => b.is_primary);
        const secondaries = businesses.filter((b) => !b.is_primary);
        expect(primaries).toHaveLength(1);
        expect(secondaries).toHaveLength(1);
        expect(primaries[0]?.id).toBe(seed.primaryBusinessId);
        expect(secondaries[0]?.id).toBe(seed.secondaryBusinessId);

        const placeIds = businesses.map((b) => b.google_place_id);
        expect(placeIds.every((p): p is string => typeof p === 'string' && p.length > 0)).toBe(true);
        expect(new Set(placeIds).size).toBe(2);

        // ── Zernio connections: exactly 2, distinct zernio_location_id. ──
        const connections = await sql<{ zernio_location_id: string }[]>`
          SELECT zc.zernio_location_id
          FROM zernio_connections zc
          JOIN businesses b ON b.id = zc.business_id
          WHERE b.account_id = ${seed.accountId}::uuid
        `;
        expect(connections).toHaveLength(2);
        const locationIds = connections.map((c) => c.zernio_location_id);
        expect(new Set(locationIds).size).toBe(2);
        expect(new Set(locationIds)).toEqual(
          new Set([seed.primaryZernioLocationId, seed.secondaryZernioLocationId]),
        );

        // ── Channel enrollment: exactly one org-default row
        //    (location_id IS NULL — invariant: org-default keyed by
        //    account_id + channel + location_id IS NULL). ──
        const [enrollmentCount] = await sql<{ count: number }[]>`
          SELECT COUNT(*)::int AS count
          FROM channel_enrollments
          WHERE account_id = ${seed.accountId}::uuid AND location_id IS NULL
        `;
        expect(Number(enrollmentCount?.count)).toBe(1);
      } finally {
        await cleanupMultiLocationAccount(seed.accountId);
      }

      // ── Cleanup removed every seeded row. ──
      const sqlAfter = getE2eSql();
      const [accountCount] = await sqlAfter<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM accounts WHERE id = ${seed.accountId}::uuid
      `;
      const [businessCount] = await sqlAfter<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM businesses WHERE account_id = ${seed.accountId}::uuid
      `;
      const [connectionCount] = await sqlAfter<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM zernio_connections
        WHERE zernio_account_id = ${seed.zernioAccountId}
      `;
      const [enrollmentCountAfter] = await sqlAfter<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM channel_enrollments WHERE account_id = ${seed.accountId}::uuid
      `;
      const [userCount] = await sqlAfter<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM users WHERE id = ${seed.userId}::uuid
      `;

      expect(Number(accountCount?.count)).toBe(0);
      expect(Number(businessCount?.count)).toBe(0);
      expect(Number(connectionCount?.count)).toBe(0);
      expect(Number(enrollmentCountAfter?.count)).toBe(0);
      expect(Number(userCount?.count)).toBe(0);
    });
  },
);
