import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { randomUUID } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { cleanupTenantAccount, seedTenantAccount } from './live-db-tenant';

// Behavioral (live-DB) companion to migration-055-auto-approval-policy.test.ts,
// which only asserts the migration SQL *text*. This proves the runtime schema
// behavior the string test cannot: the composite FK (MATCH SIMPLE) admits
// account-default rows but rejects a cross-account location, the partial unique
// indexes enforce one account-default and one override per location, and the
// approval_method / auth_method CHECKs accept the new auto_policy value. Each
// failure case asserts the *specific* constraint by name, so a test can never
// pass for the wrong reason.
//
// Gated on a real test database (TEST_DATABASE_POOL_URL), like the repo's other
// integration tests; skips cleanly without one (e.g. in the no-DB CI test job).
// The database is expected to already have all migrations applied.
const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;
const RUN = Boolean(testDatabaseUrl);
const d = RUN ? describe : describe.skip;

let db: postgresType.Sql | undefined;

// Two tenants so we can prove cross-account FK rejection.
const a = {
  userId: randomUUID(),
  accountId: randomUUID(),
  businessId: randomUUID(),
  reviewId: randomUUID(),
  responseId: randomUUID(),
};
const b = {
  userId: randomUUID(),
  accountId: randomUUID(),
  businessId: randomUUID(),
};
const ownerEmailA = `aap-055-a-${a.accountId}@test.local`;
const ownerEmailB = `aap-055-b-${b.accountId}@test.local`;

function sql(): postgresType.Sql {
  if (!db) throw new Error('migration 055 integration database was not initialized');
  return db;
}

async function insertPolicy(
  accountId: string,
  locationId: string | null,
  minStar: number,
): Promise<void> {
  await sql()`
    INSERT INTO auto_approval_policies (id, account_id, location_id, auto_approve_min_star)
    VALUES (${uuidv7()}::uuid, ${accountId}::uuid, ${locationId}::uuid, ${minStar})
  `;
}

d('migration 055 auto_approval_policies — behavioral', () => {
  beforeAll(async () => {
    db = postgres(testDatabaseUrl!, { max: 1, prepare: false });
    // Domain rows reference the committed user/account pairs — only the
    // user<->account seed itself needs deferred constraints (helper-owned).
    for (const [tenant, email] of [
      [a, ownerEmailA],
      [b, ownerEmailB],
    ] as const) {
      await seedTenantAccount(sql(), {
        userId: tenant.userId,
        accountId: tenant.accountId,
        ownerEmail: email,
        userName: 'AAP 055 Owner',
        accountDisplayName: 'AAP 055 Account',
      });
      await sql()`
        INSERT INTO businesses (id, name, owner_name, owner_email, account_id, subscription_status)
        VALUES (${tenant.businessId}::uuid, 'AAP 055 Biz', 'AAP 055 Owner', ${email}, ${tenant.accountId}::uuid, 'active')
      `;
    }
    await sql()`
      INSERT INTO reviews (
        id, business_id, provider, provider_review_id, provider_review_name,
        provider_location_name, reviewer_name, star_rating, review_text, status
      )
      VALUES (
        ${a.reviewId}::uuid, ${a.businessId}::uuid, 'zernio', ${`aap-055-${a.reviewId}`},
        ${`zernio://aap/reviews/${a.reviewId}`}, 'zernio://aap/locations/1', 'Reviewer', 5,
        'Great visit', 'responded'
      )
    `;
    await sql()`
      INSERT INTO responses (
        id, review_id, business_id, response_text, original_draft_text, response_language
      )
      VALUES (
        ${a.responseId}::uuid, ${a.reviewId}::uuid, ${a.businessId}::uuid, 'A reply', 'A reply', 'en'
      )
    `;
  });

  afterEach(async () => {
    if (!db) return;
    await sql()`
      DELETE FROM auto_approval_policies
      WHERE account_id IN (${a.accountId}::uuid, ${b.accountId}::uuid)
    `;
  });

  afterAll(async () => {
    if (!db) return;
    // Policies are cleaned per-test by afterEach; tear down the seed parents.
    await sql()`DELETE FROM approval_audit_log WHERE response_id = ${a.responseId}::uuid`;
    await sql()`DELETE FROM responses WHERE id = ${a.responseId}::uuid`;
    await sql()`DELETE FROM reviews WHERE id = ${a.reviewId}::uuid`;
    await sql()`DELETE FROM businesses WHERE id IN (${a.businessId}::uuid, ${b.businessId}::uuid)`;
    await cleanupTenantAccount(sql(), a);
    await cleanupTenantAccount(sql(), b);
    await db.end({ timeout: 5 });
  });

  it('composite FK (MATCH SIMPLE) admits an account-default and a same-account override, rejects a cross-account location', async () => {
    await insertPolicy(a.accountId, null, 4); // account default: NULL location passes MATCH SIMPLE
    await insertPolicy(a.accountId, a.businessId, 5); // same-account override allowed
    const rows = await sql()<{ count: string }[]>`
      SELECT count(*)::text AS count
      FROM auto_approval_policies
      WHERE account_id = ${a.accountId}::uuid
    `;
    expect(rows[0]?.count).toBe('2');

    // A location owned by a DIFFERENT account must fail the composite FK specifically.
    await expect(insertPolicy(a.accountId, b.businessId, 5)).rejects.toThrow(
      /auto_approval_policies_location_account_fk/,
    );
  });

  it('partial unique indexes enforce one account-default and one override per (account, location)', async () => {
    await insertPolicy(a.accountId, null, 4);
    await expect(insertPolicy(a.accountId, null, 3)).rejects.toThrow(
      /auto_approval_policies_one_account_default/,
    );

    await insertPolicy(a.accountId, a.businessId, 5);
    await expect(insertPolicy(a.accountId, a.businessId, 2)).rejects.toThrow(
      /auto_approval_policies_one_location_override/,
    );
  });

  it('approval_audit_log.auth_method accepts auto_policy and rejects unknown values', async () => {
    const auditId = randomUUID();
    await sql()`
      INSERT INTO approval_audit_log (
        id, response_id, business_id, account_id, token_hash, action, auth_method, metadata
      )
      VALUES (
        ${auditId}::uuid, ${a.responseId}::uuid, ${a.businessId}::uuid, ${a.accountId}::uuid,
        'test-token-hash', 'auto_approved_by_policy', 'auto_policy', '{}'::jsonb
      )
    `;
    const [row] = await sql()<{ auth_method: string }[]>`
      SELECT auth_method FROM approval_audit_log WHERE id = ${auditId}::uuid
    `;
    expect(row?.auth_method).toBe('auto_policy');

    // Only auth_method differs, so the rejection isolates its CHECK.
    await expect(
      sql()`
        INSERT INTO approval_audit_log (
          id, response_id, business_id, account_id, token_hash, action, auth_method, metadata
        )
        VALUES (
          ${randomUUID()}::uuid, ${a.responseId}::uuid, ${a.businessId}::uuid, ${a.accountId}::uuid,
          'test-token-hash', 'auto_approved_by_policy', 'not_a_method', '{}'::jsonb
        )
      `,
    ).rejects.toThrow(/approval_audit_log_auth_method_check/);

    await sql()`DELETE FROM approval_audit_log WHERE id = ${auditId}::uuid`;
  });

  it('responses.approval_method accepts owner/auto_policy and rejects other values', async () => {
    await sql()`UPDATE responses SET approval_method = 'auto_policy' WHERE id = ${a.responseId}::uuid`;
    await sql()`UPDATE responses SET approval_method = 'owner' WHERE id = ${a.responseId}::uuid`;
    await expect(
      sql()`UPDATE responses SET approval_method = 'bogus' WHERE id = ${a.responseId}::uuid`,
    ).rejects.toThrow(/responses_approval_method_check/);
    await sql()`UPDATE responses SET approval_method = NULL WHERE id = ${a.responseId}::uuid`;
  });
});
