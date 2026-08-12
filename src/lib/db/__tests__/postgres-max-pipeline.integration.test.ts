import { afterAll, beforeAll, expect, it } from 'vitest';
import postgres from 'postgres';

import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  assertLocalTestDatabaseUrl,
  resolveTestDatabaseUrl,
} from '@/lib/shared/__tests__/helpers/live-db-lock';
import {
  assertSchemaReady,
  MIGRATION_100_IMPORT_CONSENT,
} from '@/lib/shared/__tests__/helpers/schema-ready';

const testDatabaseUrl = resolveTestDatabaseUrl();
let db: postgres.Sql | undefined;

function sql(): postgres.Sql {
  if (!db) throw new Error('max_pipeline compatibility database was not initialized');
  return db;
}

describeWithDb(
  'postgres.js max_pipeline compatibility against live local Postgres',
  { enabled: Boolean(testDatabaseUrl), timeout: 30_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      // postgres.js 3.4.9 implements max_pipeline but omits it from Options.
      // This narrow cast mirrors the isolated differential without widening the
      // production client API around an undocumented compatibility option.
      const options: postgres.Options<{}> & { max_pipeline: number } = {
        prepare: false,
        max: 2,
        max_pipeline: 1,
      };
      db = postgres(databaseUrl, options);
      await assertSchemaReady(db, [MIGRATION_100_IMPORT_CONSENT]);
    });

    afterAll(async () => {
      await db?.end({ timeout: 5 });
      db = undefined;
    });

    it('max_pipeline one preserves sql.begin transaction reservation', async () => {
      const transactionResult = await sql().begin(async (tx) => {
        const [first] = await tx<{ value: number }[]>`SELECT 1::int AS value`;
        const [second] = await tx<{ value: number }[]>`SELECT 2::int AS value`;
        return (first?.value ?? 0) + (second?.value ?? 0);
      });

      // sql.begin resolves only after postgres.js receives COMMIT, so this proves
      // the connection was reserved and the transaction completed successfully.
      expect(transactionResult).toBe(3);
    });
  },
);
