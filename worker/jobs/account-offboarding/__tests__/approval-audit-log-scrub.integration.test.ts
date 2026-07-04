import { afterAll, beforeAll, expect, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { randomUUID } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { describeWithDb } from '../../../../src/__tests__/helpers/describe-with-db';

// Real-schema regression for staging dry-run defect D3. The unit PurgeWorker test
// only asserts the scrub SQL *text*, so it never noticed that the approval_audit_log
// scrub + verification referenced columns (approval_link_id, user_agent) that do
// NOT exist in the real table — every delete_data purge threw
// `column "approval_link_id" of relation "approval_audit_log" does not exist`,
// stranding the row at failed/purge and leaving the data undeleted.
//
// This drives the PRODUCTION runDependentReferencePurgeStage + verificationQuery
// against a live Postgres with the real schema: a column-name drift makes the SQL
// throw at plan time (caught here), and a missed PII column fails the removal
// assertion. Gated on TEST_DATABASE_POOL_URL; skips cleanly without one. Expects
// the database to already have migrations applied (like the repo's other
// integration tests).
const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

const userId = randomUUID();
const accountId = randomUUID();
const businessId = randomUUID();
const auditId = randomUUID();
const offboardingId = uuidv7();
const ownerEmail = `purge-d3-${accountId}@test.local`;

let seed: postgresType.Sql | undefined;
let appSql: postgresType.Sql | undefined;
let runDependentReferencePurgeStage: (row: { id: string; account_id: string }) => Promise<void>;
let verificationQuery: (
  table: string,
  input: Record<string, unknown>,
  exec: postgresType.Sql,
) => Promise<Array<{ violation_count: number | string }>>;

function db(): postgresType.Sql {
  if (!seed) throw new Error('approval_audit_log scrub integration database not initialized');
  return seed;
}

describeWithDb('runDependentReferencePurgeStage — approval_audit_log real PII removal (D3)', () => {
  beforeAll(async () => {
    // The app sql singleton reads DATABASE_POOL_URL at import; point it (and the
    // dummy Supabase env createClient needs) before dynamically importing the worker.
    process.env.DATABASE_POOL_URL = testDatabaseUrl;
    process.env.SUPABASE_URL ??= 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_KEY ??= 'test-service-key';

    seed = postgres(testDatabaseUrl!, { max: 1, prepare: false });
    const stages = await import('../purge-stages');
    runDependentReferencePurgeStage =
      stages.runDependentReferencePurgeStage as unknown as typeof runDependentReferencePurgeStage;
    const verify = await import('../../../../src/lib/account-offboarding/purge-verification');
    verificationQuery = verify.verificationQuery as unknown as typeof verificationQuery;
    const dbMod = await import('../../../../src/lib/db/server');
    appSql = dbMod.sql as unknown as postgresType.Sql;

    // Seed the FK chain (approval_audit_log.account_id + business_id are NOT NULL FKs).
    await db()`INSERT INTO users (id, name, email, role) VALUES (${userId}::uuid, 'Purge D3', ${ownerEmail}, 'owner')`;
    await db()`INSERT INTO accounts (id, owner_user_id, display_name) VALUES (${accountId}::uuid, ${userId}::uuid, 'Purge D3 Acct')`;
    await db()`UPDATE users SET account_id = ${accountId}::uuid WHERE id = ${userId}::uuid`;
    await db()`INSERT INTO businesses (id, name, owner_name, owner_email, account_id, is_primary) VALUES (${businessId}::uuid, 'Purge D3 Loc', 'Owner', ${ownerEmail}, ${accountId}::uuid, TRUE)`;
    await db()`
      INSERT INTO approval_audit_log
        (id, business_id, action, account_id, token_hash, device_cookie_hash,
         ip_address, metadata, actor_user_id, response_text_at_approval)
      VALUES
        (${auditId}::uuid, ${businessId}::uuid, 'approve', ${accountId}::uuid,
         'tok-hash-secret', 'cookie-hash-secret', '203.0.113.7',
         '{"pii":"present"}'::jsonb, ${userId}::uuid, 'sensitive review reply text')
    `;
  });

  afterAll(async () => {
    if (seed) {
      await seed`DELETE FROM approval_audit_log WHERE id = ${auditId}::uuid`;
      await seed`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
      await seed`UPDATE users SET account_id = NULL WHERE id = ${userId}::uuid`;
      await seed`DELETE FROM accounts WHERE id = ${accountId}::uuid`;
      await seed`DELETE FROM users WHERE id = ${userId}::uuid`;
      await seed.end({ timeout: 5 });
    }
    if (appSql) await appSql.end({ timeout: 5 });
  });

  it('scrubs approval_audit_log PII against the real schema and passes verification', async () => {
    // Throws here on a column-name drift (the D3 failure mode) before any assertion.
    await runDependentReferencePurgeStage({ id: offboardingId, account_id: accountId });

    const [row] = await db()<Array<{
      token_hash: string | null;
      device_cookie_hash: string | null;
      ip_address: string | null;
      actor_user_id: string | null;
      response_text_at_approval: string | null;
      metadata: unknown;
    }>>`
      SELECT token_hash, device_cookie_hash, ip_address, actor_user_id,
             response_text_at_approval, metadata
      FROM approval_audit_log WHERE id = ${auditId}::uuid
    `;
    expect(row?.token_hash).toBeNull();
    expect(row?.device_cookie_hash).toBeNull();
    expect(row?.ip_address).toBeNull();
    expect(row?.actor_user_id).toBeNull();
    expect(row?.response_text_at_approval).toBeNull();
    const metadata = typeof row?.metadata === 'string' ? JSON.parse(row.metadata) : row?.metadata;
    expect(metadata).toEqual({});

    // The real verification query must also run clean against the schema (it
    // referenced the same phantom columns) and report no residual PII.
    const verifyRows = await verificationQuery(
      'approval_audit_log',
      {
        accountId,
        offboardingId,
        currentOutboxId: null,
        authUserId: null,
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        zernioAccountIds: [],
        zernioProfileIds: [],
      },
      appSql!,
    );
    expect(Number(verifyRows[0]?.violation_count ?? -1)).toBe(0);
  });
});
