import { afterAll, beforeAll, expect, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { randomUUID } from 'node:crypto';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

let db: postgresType.Sql | undefined;

const ids = {
  userId: randomUUID(),
  accountId: randomUUID(),
  businessId: randomUUID(),
  reviewId: randomUUID(),
  responseId: randomUUID(),
  auditId: randomUUID(),
};

function sql(): postgresType.Sql {
  if (!db) throw new Error('audit snapshot integration database was not initialized');
  return db;
}

describeWithDb('approval audit content snapshot integration', () => {
  beforeAll(() => {
    db = postgres(testDatabaseUrl!, { max: 1, prepare: false });
  });

  afterAll(async () => {
    if (!db) return;
    await sql().begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`;
      await tx`DELETE FROM approval_audit_log WHERE id = ${ids.auditId}::uuid`;
      await tx`DELETE FROM responses WHERE id = ${ids.responseId}::uuid`;
      await tx`DELETE FROM reviews WHERE id = ${ids.reviewId}::uuid`;
      await tx`DELETE FROM businesses WHERE id = ${ids.businessId}::uuid`;
      await tx`DELETE FROM accounts WHERE id = ${ids.accountId}::uuid`;
      await tx`DELETE FROM users WHERE id = ${ids.userId}::uuid`;
    });
    await db.end({ timeout: 5 });
  });

  it('keeps response_text_at_approval unchanged after approved_text mutates', async () => {
    const ownerEmail = `audit-snapshot-${randomUUID()}@test.local`;
    const approvedAtDecision = 'Owner approved text at decision time';
    const laterApprovedText = 'Later corrected approved text';

    await sql().begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`;
      await tx`
        INSERT INTO users (id, name, email, role, account_id)
        VALUES (${ids.userId}::uuid, 'Audit Snapshot Owner', ${ownerEmail}, 'owner', ${ids.accountId}::uuid)
      `;
      await tx`
        INSERT INTO accounts (id, owner_user_id, display_name, subscription_tier, subscription_status)
        VALUES (${ids.accountId}::uuid, ${ids.userId}::uuid, 'Audit Snapshot Account', 'standard', 'active')
      `;
      await tx`
        INSERT INTO businesses (id, name, owner_name, owner_email, account_id, subscription_status)
        VALUES (${ids.businessId}::uuid, 'Audit Snapshot Biz', 'Audit Snapshot Owner', ${ownerEmail}, ${ids.accountId}::uuid, 'active')
      `;
      await tx`
        INSERT INTO reviews (id, business_id, provider, provider_review_id, provider_review_name, provider_location_name, reviewer_name, star_rating, review_text, status)
        VALUES (${ids.reviewId}::uuid, ${ids.businessId}::uuid, 'zernio', ${`audit-${ids.reviewId}`}, ${`zernio://audit/reviews/${ids.reviewId}`}, 'zernio://audit/locations/1', 'Reviewer', 5, 'Great visit', 'responded')
      `;
      await tx`
        INSERT INTO responses (id, review_id, business_id, response_text, original_draft_text, approved_text, response_language, version, status, approved_at, approval_method)
        VALUES (${ids.responseId}::uuid, ${ids.reviewId}::uuid, ${ids.businessId}::uuid, ${approvedAtDecision}, ${approvedAtDecision}, ${approvedAtDecision}, 'en', 1, 'approved', NOW(), 'owner')
      `;
      await tx`
        INSERT INTO approval_audit_log (
          id, response_id, business_id, account_id, token_hash, action, ip_address, metadata, response_text_at_approval
        )
        VALUES (
          ${ids.auditId}::uuid, ${ids.responseId}::uuid, ${ids.businessId}::uuid, ${ids.accountId}::uuid,
          'test-token-hash', 'approve', '127.0.0.1', '{}'::jsonb, ${approvedAtDecision}
        )
      `;
    });

    await sql()`
      UPDATE responses
      SET approved_text = ${laterApprovedText}, updated_at = NOW()
      WHERE id = ${ids.responseId}::uuid
    `;

    const [row] = await sql()<{
      approved_text: string;
      response_text_at_approval: string;
    }[]>`
      SELECT r.approved_text, aal.response_text_at_approval
      FROM responses r
      JOIN approval_audit_log aal ON aal.response_id = r.id
      WHERE r.id = ${ids.responseId}::uuid
        AND aal.id = ${ids.auditId}::uuid
    `;

    expect(row?.approved_text).toBe(laterApprovedText);
    expect(row?.response_text_at_approval).toBe(approvedAtDecision);
  });
});
