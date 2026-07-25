import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  acquireFeature543DatabaseLockForTest,
  assertFeature543LocalTestDatabaseUrl,
  feature543DatabaseLockSessionNameForTest,
  resolveFeature543TestDatabaseUrl,
} from './helpers/feature-543-database-lock';

const testDatabaseUrl = resolveFeature543TestDatabaseUrl();
let observer: postgresType.Sql | undefined;

describeWithDb(
  'feature 543 database lock against live local Postgres',
  { enabled: Boolean(testDatabaseUrl), timeout: 10_000 },
  () => {
    afterAll(async () => {
      if (observer) await observer.end({ timeout: 5 });
    });

    it('feature 543 database lock times out in Postgres and releases its session', async () => {
      const databaseUrl = assertFeature543LocalTestDatabaseUrl(testDatabaseUrl);
      const lockKey = `repworth_feature_543_lock_test_${randomUUID()}`;
      const acquisitionTimeoutMs = 500;
      const applicationName = feature543DatabaseLockSessionNameForTest(lockKey);
      observer = postgres(databaseUrl, { max: 1, prepare: false });

      const holder = await acquireFeature543DatabaseLockForTest(databaseUrl, {
        lockKey,
        acquisitionTimeoutMs,
      });

      try {
        const startedAt = Date.now();
        let timeoutError: unknown;
        try {
          await acquireFeature543DatabaseLockForTest(databaseUrl, {
            lockKey,
            acquisitionTimeoutMs,
          });
        } catch (error) {
          timeoutError = error;
        }

        expect(timeoutError).toMatchObject({ code: '57014' });
        expect(Date.now() - startedAt).toBeLessThan(5_000);

        const [sessionsAfterTimeout] = await observer<{ count: string }[]>`
          SELECT COUNT(*) AS count
          FROM pg_stat_activity
          WHERE application_name = ${applicationName}
        `;
        expect(Number(sessionsAfterTimeout!.count)).toBe(1);
      } finally {
        await holder.release();
      }

      const successor = await acquireFeature543DatabaseLockForTest(databaseUrl, {
        lockKey,
        acquisitionTimeoutMs,
      });
      await successor.release();

      const [sessionsAfterSuccessor] = await observer<{ count: string }[]>`
        SELECT COUNT(*) AS count
        FROM pg_stat_activity
        WHERE application_name = ${applicationName}
      `;
      expect(Number(sessionsAfterSuccessor!.count)).toBe(0);
    });
  },
);
