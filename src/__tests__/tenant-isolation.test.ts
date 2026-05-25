import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { randomUUID } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;
const RUN = Boolean(testDatabaseUrl);
const d = RUN ? describe : describe.skip;

let db: postgresType.Sql | undefined;
const createdAccountIds: string[] = [];
const createdUserIds: string[] = [];

interface SeededTenant {
  accountId: string;
  userId: string;
  businessIds: string[];
  reviewIds: string[];
  responseIds: string[];
  channelEnrollmentId: string;
  approvalAuditId: string;
  accountAuditId: string;
}

interface TenantReadRow {
  account_id: string;
  business_id: string;
  review_id: string;
  response_id: string;
  approval_link_id: string;
  approval_audit_id: string;
}

function sql(): postgresType.Sql {
  if (!db) throw new Error('tenant isolation test database was not initialized');
  return db;
}

function requiredId(id: string | undefined, label: string): string {
  if (!id) throw new Error(`missing seeded ${label}`);
  return id;
}

function tenantEmail(label: string): string {
  return `tenant-isolation-${label}-${randomUUID()}@test.local`;
}

async function seedTenant(label: 'a' | 'b'): Promise<SeededTenant> {
  const accountId = uuidv7();
  const userId = uuidv7();
  const primaryBusinessId = uuidv7();
  const secondaryBusinessId = uuidv7();
  const firstReviewId = uuidv7();
  const secondReviewId = uuidv7();
  const firstResponseId = uuidv7();
  const secondResponseId = uuidv7();
  const firstApprovalLinkId = uuidv7();
  const secondApprovalLinkId = uuidv7();
  const approvalAuditId = uuidv7();
  const accountAuditId = uuidv7();
  const channelEnrollmentId = uuidv7();
  const ownerEmail = tenantEmail(label);

  await sql().begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`;
    await tx`
      INSERT INTO users (id, name, email, role, auth_id, account_id)
      VALUES (${userId}, ${`Tenant ${label.toUpperCase()} Owner`}, ${ownerEmail}, 'owner', ${`auth-${userId}`}, ${accountId})
    `;
    await tx`
      INSERT INTO accounts (id, owner_user_id, display_name, subscription_tier, subscription_status)
      VALUES (${accountId}, ${userId}, ${`Tenant ${label.toUpperCase()} Account`}, 'standard', 'active')
    `;
    await tx`
      INSERT INTO businesses (id, name, owner_name, owner_email, account_id, is_primary, display_label, subscription_status)
      VALUES
        (${primaryBusinessId}, ${`Tenant ${label.toUpperCase()} Primary`}, ${`Tenant ${label.toUpperCase()} Owner`}, ${ownerEmail}, ${accountId}, TRUE, ${`Tenant ${label.toUpperCase()} Primary`}, 'active'),
        (${secondaryBusinessId}, ${`Tenant ${label.toUpperCase()} Secondary`}, ${`Tenant ${label.toUpperCase()} Owner`}, ${ownerEmail}, ${accountId}, FALSE, ${`Tenant ${label.toUpperCase()} Secondary`}, 'active')
    `;
    await tx`
      INSERT INTO reviews (id, business_id, provider, provider_review_id, provider_review_name, provider_location_name, reviewer_name, star_rating, review_text, status)
      VALUES
        (${firstReviewId}, ${primaryBusinessId}, 'zernio', ${`review-${label}-1-${randomUUID()}`}, ${`zernio://tenant-${label}/reviews/1-${randomUUID()}`}, ${`zernio://tenant-${label}/locations/1`}, 'Reviewer One', 5, 'Excellent service', 'responded'),
        (${secondReviewId}, ${secondaryBusinessId}, 'zernio', ${`review-${label}-2-${randomUUID()}`}, ${`zernio://tenant-${label}/reviews/2-${randomUUID()}`}, ${`zernio://tenant-${label}/locations/2`}, 'Reviewer Two', 4, 'Solid visit', 'responded')
    `;
    await tx`
      INSERT INTO responses (id, review_id, business_id, response_text, original_draft_text, approved_text, response_language, version, status, posted_at)
      VALUES
        (${firstResponseId}, ${firstReviewId}, ${primaryBusinessId}, ${`Tenant ${label} response 1`}, ${`Tenant ${label} response 1`}, ${`Tenant ${label} response 1`}, 'en', 1, 'posted', NOW()),
        (${secondResponseId}, ${secondReviewId}, ${secondaryBusinessId}, ${`Tenant ${label} response 2`}, ${`Tenant ${label} response 2`}, ${`Tenant ${label} response 2`}, 'en', 1, 'posted', NOW())
    `;
    await tx`
      INSERT INTO approval_links (id, response_id, business_id, token_hash, channel, expires_at)
      VALUES
        (${firstApprovalLinkId}, ${firstResponseId}, ${primaryBusinessId}, ${`hash-${label}-1-${randomUUID()}`}, 'email', NOW() + INTERVAL '1 hour'),
        (${secondApprovalLinkId}, ${secondResponseId}, ${secondaryBusinessId}, ${`hash-${label}-2-${randomUUID()}`}, 'email', NOW() + INTERVAL '1 hour')
    `;
    await tx`
      INSERT INTO approval_audit_log (id, response_id, business_id, account_id, token_hash, action)
      VALUES (${approvalAuditId}, ${firstResponseId}, ${primaryBusinessId}, ${accountId}, ${`hash-${label}-audit-${randomUUID()}`}, 'approved')
    `;
    await tx`
      INSERT INTO account_audit_log (id, account_id, location_id, event_type, actor_user_id)
      VALUES (${accountAuditId}, ${accountId}, ${primaryBusinessId}, 'tenant_isolation_seed', ${userId})
    `;
    await tx`
      INSERT INTO channel_enrollments (id, account_id, business_id, location_id, channel, handle, status, verified_at)
      VALUES (${channelEnrollmentId}, ${accountId}, ${primaryBusinessId}, ${primaryBusinessId}, 'email', ${ownerEmail}, 'verified', NOW())
    `;
  });

  createdAccountIds.push(accountId);
  createdUserIds.push(userId);

  return {
    accountId,
    userId,
    businessIds: [primaryBusinessId, secondaryBusinessId],
    reviewIds: [firstReviewId, secondReviewId],
    responseIds: [firstResponseId, secondResponseId],
    channelEnrollmentId,
    approvalAuditId,
    accountAuditId,
  };
}

async function cleanupSeededTenants(): Promise<void> {
  if (!db || createdAccountIds.length === 0) return;
  const accountIds = [...createdAccountIds];
  const userIds = [...createdUserIds];
  createdAccountIds.length = 0;
  createdUserIds.length = 0;

  await db.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`;
    await tx`DELETE FROM businesses WHERE account_id = ANY(${accountIds}::uuid[])`;
    await tx`DELETE FROM account_audit_log WHERE account_id = ANY(${accountIds}::uuid[])`;
    await tx`DELETE FROM accounts WHERE id = ANY(${accountIds}::uuid[])`;
    await tx`DELETE FROM users WHERE id = ANY(${userIds}::uuid[])`;
  });
}

async function readTenantEvidence(accountId: string): Promise<TenantReadRow[]> {
  return sql()<TenantReadRow[]>`
    SELECT
      b.account_id,
      b.id AS business_id,
      r.id AS review_id,
      resp.id AS response_id,
      al.id AS approval_link_id,
      aal.id AS approval_audit_id
    FROM businesses b
    JOIN reviews r ON r.business_id = b.id
    JOIN responses resp ON resp.review_id = r.id
    JOIN approval_links al ON al.response_id = resp.id
    LEFT JOIN approval_audit_log aal ON aal.response_id = resp.id
    WHERE b.account_id = ${accountId}::uuid
    ORDER BY b.id ASC, r.id ASC
  `;
}

d('tenant isolation integration', () => {
  beforeAll(() => {
    db = postgres(testDatabaseUrl!, { max: 1, prepare: false });
  });

  afterAll(async () => {
    await cleanupSeededTenants();
    await db?.end({ timeout: 5 });
  });

  it('seeds two accounts and prevents cross-account read and update leakage', async () => {
    const tenantA = await seedTenant('a');
    const tenantB = await seedTenant('b');
    const tenantAPrimaryBusinessId = requiredId(tenantA.businessIds[0], 'tenant A primary business id');
    const tenantBPrimaryBusinessId = requiredId(tenantB.businessIds[0], 'tenant B primary business id');
    const tenantBFirstResponseId = requiredId(tenantB.responseIds[0], 'tenant B first response id');

    const tenantARows = await readTenantEvidence(tenantA.accountId);
    expect(tenantARows).toHaveLength(2);
    expect(tenantARows.map((row) => row.account_id)).toEqual([
      tenantA.accountId,
      tenantA.accountId,
    ]);
    expect(tenantARows.map((row) => row.business_id).sort()).toEqual([...tenantA.businessIds].sort());
    expect(tenantARows.some((row) => tenantB.businessIds.includes(row.business_id))).toBe(false);
    expect(tenantARows.some((row) => tenantB.responseIds.includes(row.response_id))).toBe(false);

    const tenantAAccountAudit = await sql()<{
      id: string;
      account_id: string;
    }[]>`
      SELECT id, account_id
      FROM account_audit_log
      WHERE account_id = ${tenantA.accountId}::uuid
    `;
    expect(tenantAAccountAudit).toEqual([
      { id: tenantA.accountAuditId, account_id: tenantA.accountId },
    ]);

    const tenantAChannels = await sql()<{
      id: string;
      account_id: string;
    }[]>`
      SELECT id, account_id
      FROM channel_enrollments
      WHERE account_id = ${tenantA.accountId}::uuid
    `;
    expect(tenantAChannels).toEqual([
      { id: tenantA.channelEnrollmentId, account_id: tenantA.accountId },
    ]);

    const ownBusinessUpdate = await sql()<{
      id: string;
    }[]>`
      UPDATE businesses
      SET display_label = 'Tenant A verified update', updated_at = NOW()
      WHERE id = ${tenantAPrimaryBusinessId}::uuid
        AND account_id = ${tenantA.accountId}::uuid
      RETURNING id
    `;
    expect(ownBusinessUpdate).toEqual([{ id: tenantAPrimaryBusinessId }]);

    const crossBusinessUpdate = await sql()<{
      id: string;
    }[]>`
      UPDATE businesses
      SET display_label = 'cross-account leak', updated_at = NOW()
      WHERE id = ${tenantBPrimaryBusinessId}::uuid
        AND account_id = ${tenantA.accountId}::uuid
      RETURNING id
    `;
    expect(crossBusinessUpdate).toEqual([]);

    const crossResponseUpdate = await sql()<{
      id: string;
    }[]>`
      UPDATE responses resp
      SET status = 'failed', updated_at = NOW()
      FROM businesses b
      WHERE resp.business_id = b.id
        AND resp.id = ${tenantBFirstResponseId}::uuid
        AND b.account_id = ${tenantA.accountId}::uuid
      RETURNING resp.id
    `;
    expect(crossResponseUpdate).toEqual([]);

    const crossChannelUpdate = await sql()<{
      id: string;
    }[]>`
      UPDATE channel_enrollments
      SET unsubscribed_reason = 'cross-account leak', updated_at = NOW()
      WHERE id = ${tenantB.channelEnrollmentId}::uuid
        AND account_id = ${tenantA.accountId}::uuid
      RETURNING id
    `;
    expect(crossChannelUpdate).toEqual([]);

    const [tenantBBusiness] = await sql()<{
      display_label: string | null;
    }[]>`
      SELECT display_label
      FROM businesses
      WHERE id = ${tenantBPrimaryBusinessId}::uuid
    `;
    expect(tenantBBusiness?.display_label).toBe('Tenant B Primary');

    const [tenantBResponse] = await sql()<{
      status: string;
    }[]>`
      SELECT status
      FROM responses
      WHERE id = ${tenantBFirstResponseId}::uuid
    `;
    expect(tenantBResponse?.status).toBe('posted');
  });
});
