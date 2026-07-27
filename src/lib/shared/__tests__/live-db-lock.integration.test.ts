import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  acquireLiveDbLockForTest,
  assertLocalTestDatabaseUrl,
  liveDbLockSessionNameForTest,
  resolveTestDatabaseUrl,
} from './helpers/live-db-lock';

const testDatabaseUrl = resolveTestDatabaseUrl();
let observer: postgresType.Sql | undefined;

describeWithDb(
  'live-DB lock against live local Postgres',
  { enabled: Boolean(testDatabaseUrl), timeout: 10_000 },
  () => {
    afterAll(async () => {
      if (observer) await observer.end({ timeout: 5 });
    });

    it('live-DB lock times out in Postgres and releases its session', async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      const lockKey = `repworth_feature_543_lock_test_${randomUUID()}`;
      const acquisitionTimeoutMs = 500;
      const applicationName = liveDbLockSessionNameForTest(lockKey);
      observer = postgres(databaseUrl, { max: 1, prepare: false });

      const holder = await acquireLiveDbLockForTest(databaseUrl, {
        lockKey,
        acquisitionTimeoutMs,
      });

      try {
        const startedAt = Date.now();
        let timeoutError: unknown;
        try {
          await acquireLiveDbLockForTest(databaseUrl, {
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

      const successor = await acquireLiveDbLockForTest(databaseUrl, {
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
