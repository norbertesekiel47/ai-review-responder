// Live advisory-lock semantics behind the #877 provisioning protocol:
// shared readers coexist, an exclusive holder blocks shared acquisition until
// release, and acquisition honours its statement_timeout bound. Exercised on
// a SCRATCH key — never `LIVE_DB_LOCK_KEY` itself: this suite runs inside the
// serialized integration lane whose DDL suites hold the real key exclusively,
// so touching it here would deadlock the lane against its own protocol. The
// real key's cross-language spelling is pinned by test-db-provision.test.ts.
// Advisory-lock calls only — no run-time DDL (#573).
import { afterAll, beforeAll, expect, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  assertLocalTestDatabaseUrl,
  resolveTestDatabaseUrl,
} from '@/lib/shared/__tests__/helpers/live-db-lock';

const testDatabaseUrl = resolveTestDatabaseUrl();
const SCRATCH_KEY = 'repworth_877_lock_semantics_test';

let holder: postgresType.Sql | undefined;
let reader: postgresType.Sql | undefined;

describeWithDb(
  'live-DB advisory lock semantics (#877 provisioning protocol)',
  { enabled: Boolean(testDatabaseUrl), timeout: 60_000 },
  () => {
    beforeAll(() => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      holder = postgres(databaseUrl, { max: 1, prepare: false });
      reader = postgres(databaseUrl, { max: 1, prepare: false });
    }, 30_000);

    afterAll(async () => {
      // pg_advisory_unlock_all so a failed assertion never leaks a hold into
      // the sibling suites sharing this serialized lane.
      if (holder) {
        await holder`SELECT pg_advisory_unlock_all()`;
        await holder.end({ timeout: 5 });
      }
      if (reader) {
        await reader`SELECT pg_advisory_unlock_all()`;
        await reader.end({ timeout: 5 });
      }
    }, 30_000);

    it('two SHARED holders coexist', async () => {
      if (!holder || !reader) throw new Error('clients not initialised');
      await holder`SELECT pg_advisory_lock_shared(hashtext(${SCRATCH_KEY}))`;
      // try-variant so a regression fails fast instead of hanging the suite.
      const [row] = await reader`
        SELECT pg_try_advisory_lock_shared(hashtext(${SCRATCH_KEY})) AS acquired
      `;
      expect(row?.acquired).toBe(true);
      await reader`SELECT pg_advisory_unlock_shared(hashtext(${SCRATCH_KEY}))`;
      await holder`SELECT pg_advisory_unlock_shared(hashtext(${SCRATCH_KEY}))`;
    });

    it('an EXCLUSIVE holder blocks shared acquisition until it releases', async () => {
      if (!holder || !reader) throw new Error('clients not initialised');
      await holder`SELECT pg_advisory_lock(hashtext(${SCRATCH_KEY}))`;

      const [blocked] = await reader`
        SELECT pg_try_advisory_lock_shared(hashtext(${SCRATCH_KEY})) AS acquired
      `;
      expect(blocked?.acquired).toBe(false);

      await holder`SELECT pg_advisory_unlock(hashtext(${SCRATCH_KEY}))`;
      const [afterRelease] = await reader`
        SELECT pg_try_advisory_lock_shared(hashtext(${SCRATCH_KEY})) AS acquired
      `;
      expect(afterRelease?.acquired).toBe(true);
      await reader`SELECT pg_advisory_unlock_shared(hashtext(${SCRATCH_KEY}))`;
    });

    it('a SHARED holder blocks exclusive acquisition (provisioning waits for readers)', async () => {
      if (!holder || !reader) throw new Error('clients not initialised');
      await reader`SELECT pg_advisory_lock_shared(hashtext(${SCRATCH_KEY}))`;

      const [blocked] = await holder`
        SELECT pg_try_advisory_lock(hashtext(${SCRATCH_KEY})) AS acquired
      `;
      expect(blocked?.acquired).toBe(false);

      await reader`SELECT pg_advisory_unlock_shared(hashtext(${SCRATCH_KEY}))`;
      const [afterRelease] = await holder`
        SELECT pg_try_advisory_lock(hashtext(${SCRATCH_KEY})) AS acquired
      `;
      expect(afterRelease?.acquired).toBe(true);
      await holder`SELECT pg_advisory_unlock(hashtext(${SCRATCH_KEY}))`;
    });

    it('a blocked wait respects statement_timeout (the acquisition bound both sides set)', async () => {
      if (!holder || !reader) throw new Error('clients not initialised');
      await holder`SELECT pg_advisory_lock(hashtext(${SCRATCH_KEY}))`;
      await reader`SET statement_timeout = '300ms'`;
      await expect(
        reader`SELECT pg_advisory_lock_shared(hashtext(${SCRATCH_KEY}))`,
      ).rejects.toMatchObject({ code: '57014' });
      await reader`RESET statement_timeout`;
      await holder`SELECT pg_advisory_unlock(hashtext(${SCRATCH_KEY}))`;
    });
  },
);
