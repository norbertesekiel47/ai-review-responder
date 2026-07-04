import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { randomUUID } from 'node:crypto';
import { describeWithDb } from '../../../../src/__tests__/helpers/describe-with-db';

// Real removal proof for the FK-independent analytics scrub (M1). The unit test
// only asserts the SQL shape; this drives the PRODUCTION runAnalyticsPurgeStage
// against a live Postgres and proves that a fragile row — distinct_id holding the
// raw account UUID with NO account_id FK — is actually scrubbed (caught only by the
// FK-independent pass), while another account's row is left untouched.
//
// Gated on TEST_DATABASE_POOL_URL; skips cleanly without one. Expects the database
// to already have migrations applied (like the repo's other integration tests).
// Both seeded rows use account_id = NULL, so no accounts/users seed is required and
// the test only ever touches the rows it inserts.
const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

const ACCOUNT_ID = randomUUID();
const OTHER_ACCOUNT_ID = randomUUID();

let seed: postgresType.Sql | undefined;
let appSql: postgresType.Sql | undefined;
let runAnalyticsPurgeStage: (row: { account_id: string }) => Promise<void>;
const insertedIds: string[] = [];

function db(): postgresType.Sql {
  if (!seed) throw new Error('analytics scrub integration database not initialized');
  return seed;
}

describeWithDb('runAnalyticsPurgeStage — real PII removal (M1)', () => {
  beforeAll(async () => {
    // The app sql singleton reads DATABASE_POOL_URL at import; point it (and the
    // dummy Supabase env createClient needs) before dynamically importing the worker.
    process.env.DATABASE_POOL_URL = testDatabaseUrl;
    process.env.SUPABASE_URL ??= 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_KEY ??= 'test-service-key';

    seed = postgres(testDatabaseUrl!, { max: 1, prepare: false });
    const mod = await import('../purge-stages');
    runAnalyticsPurgeStage = mod.runAnalyticsPurgeStage as typeof runAnalyticsPurgeStage;
    const dbMod = await import('../../../../src/lib/db/server');
    appSql = dbMod.sql as unknown as postgresType.Sql;
  });

  afterEach(async () => {
    if (!seed || insertedIds.length === 0) return;
    await seed`DELETE FROM analytics_events WHERE id = ANY(${insertedIds}::uuid[])`;
    insertedIds.length = 0;
  });

  afterAll(async () => {
    if (seed) await seed.end({ timeout: 5 });
    if (appSql) await appSql.end({ timeout: 5 });
  });

  it('scrubs a fragile raw-UUID distinct_id row with no FK, and leaves other accounts untouched', async () => {
    const fragileId = randomUUID();
    const controlId = randomUUID();
    insertedIds.push(fragileId, controlId);
    await db()`
      INSERT INTO analytics_events
        (id, event_key, event_name, distinct_id, account_id, properties, anonymous_id, last_error)
      VALUES
        (${fragileId}::uuid, ${`m1-scrub-${fragileId}`}, 'offboarding_started', ${ACCOUNT_ID}, NULL,
         '{"email":"owner@example.com"}'::jsonb, 'anon-owner', 'boom'),
        (${controlId}::uuid, ${`m1-scrub-${controlId}`}, 'offboarding_started', ${OTHER_ACCOUNT_ID}, NULL,
         '{"email":"other@example.com"}'::jsonb, 'anon-other', NULL)
    `;

    await runAnalyticsPurgeStage({ account_id: ACCOUNT_ID });

    const [fragile] = await db()<{
      distinct_id: string;
      properties: unknown;
      anonymous_id: string | null;
      last_error: string | null;
    }[]>`
      SELECT distinct_id, properties, anonymous_id, last_error
      FROM analytics_events WHERE id = ${fragileId}::uuid
    `;
    expect(fragile?.distinct_id.startsWith('scrubbed:')).toBe(true);
    expect(fragile?.anonymous_id).toBeNull();
    expect(fragile?.last_error).toBeNull();
    const props = typeof fragile?.properties === 'string'
      ? JSON.parse(fragile.properties)
      : fragile?.properties;
    expect(props).toEqual({});

    // A different account's fragile row must be untouched (account-scoped).
    const [control] = await db()<{ distinct_id: string }[]>`
      SELECT distinct_id FROM analytics_events WHERE id = ${controlId}::uuid
    `;
    expect(control?.distinct_id).toBe(OTHER_ACCOUNT_ID);
  });
});
