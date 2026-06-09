import postgres from 'postgres';
import { randomUUID, createHash } from 'node:crypto';
import type { Sql } from 'postgres';

/**
 * Whether E2E DB seeding is configured. Import this in test files
 * to gate test.skip() BEFORE calling any seed functions.
 */
export const isE2eConfigured: boolean =
  !!process.env.TEST_DATABASE_POOL_URL &&
  (process.env.NODE_ENV === 'test' || process.env.ALLOW_E2E_DB_WRITES === 'true');

// ── Lazy DB connection (only created when seed functions are called) ──
let _sql: Sql | null = null;

function getSql(): Sql {
  if (_sql) return _sql;

  const dbUrl = process.env.TEST_DATABASE_POOL_URL;
  if (!dbUrl) {
    throw new Error(
      'TEST_DATABASE_POOL_URL is not set. E2E tests require a dedicated test database.',
    );
  }

  const allowWrites =
    process.env.NODE_ENV === 'test' ||
    process.env.ALLOW_E2E_DB_WRITES === 'true';

  if (!allowWrites) {
    throw new Error(
      'E2E DB writes require NODE_ENV=test or ALLOW_E2E_DB_WRITES=true',
    );
  }

  _sql = postgres(dbUrl);
  return _sql;
}

export interface SeedData {
  businessId: string;
  reviewId: string;
  responseId: string;
  rawToken: string;
  tokenHash: string;
  approvalLinkId: string;
}

export interface OwnerOffboardingSeedData {
  accountId: string;
  businessId: string;
  userId: string;
  authUserId: string;
  ownerEmail: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  zernioAccountId: string | null;
  zernioProfileId: string | null;
}

export interface SeedOwnerOffboardingAccountOptions {
  subscriptionStatus?: 'active' | 'pending_payment' | 'past_due' | 'cancelled';
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  zernioConnection?: boolean;
}

export function getE2eSql(): Sql {
  return getSql();
}

/**
 * Creates a unique set of test data for one E2E test.
 * Each call produces unique IDs so parallel tests don't collide.
 */
export async function seedApprovalFlow(
  overrides: {
    expiresAt?: Date;
    consumedAt?: Date | null;
  } = {},
): Promise<SeedData> {
  const sql = getSql();
  const businessId = randomUUID();
  const reviewId = randomUUID();
  const responseId = randomUUID();
  const approvalLinkId = randomUUID();
  const rawToken = randomUUID();
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');

  const expiresAt = overrides.expiresAt ?? new Date(Date.now() + 48 * 3600_000);
  const consumedAt = overrides.consumedAt ?? null;

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO businesses (id, name, category, owner_name, owner_email, subscription_status, google_place_id)
      VALUES (${businessId}, ${'E2E Test Biz ' + businessId.slice(0, 8)}, 'restaurant', 'Test Owner', 'e2e@test.local', 'active', ${'e2e-place-' + businessId.slice(0, 8)})
    `;

    await tx`
      INSERT INTO reviews (id, business_id, provider, provider_review_id, provider_review_name, provider_location_name, reviewer_name, star_rating, review_text, review_date, detected_language, review_content_hash, status)
      VALUES (${reviewId}, ${businessId}, 'test', ${reviewId}, ${'test://review/' + reviewId}, ${'test://location/' + businessId}, 'E2E Reviewer', 4, 'Great experience, would come again!', NOW(), 'en', 'e2e-hash', 'pending_approval')
    `;

    await tx`
      INSERT INTO responses (id, review_id, business_id, response_text, response_language, version, status, original_draft_text, llm_provider, llm_model, prompt_tokens, completion_tokens)
      VALUES (${responseId}, ${reviewId}, ${businessId}, 'Thank you for your kind words! We look forward to seeing you again.', 'en', 1, 'pending_approval', 'Thank you for your kind words! We look forward to seeing you again.', 'openai', 'gpt-4o-mini', 100, 50)
    `;

    await tx`
      INSERT INTO approval_links (id, response_id, business_id, token_hash, channel, expires_at, consumed_at)
      VALUES (${approvalLinkId}, ${responseId}, ${businessId}, ${tokenHash}, 'email', ${expiresAt}, ${consumedAt})
    `;
  });

  return { businessId, reviewId, responseId, rawToken, tokenHash, approvalLinkId };
}

export async function seedOwnerOffboardingAccount(
  options: SeedOwnerOffboardingAccountOptions = {},
): Promise<OwnerOffboardingSeedData> {
  const sql = getSql();
  const accountId = randomUUID();
  const businessId = randomUUID();
  const userId = randomUUID();
  const authUserId = randomUUID();
  const suffix = accountId.slice(0, 8);
  const ownerEmail = `owner-offboarding-${suffix}@test.local`;
  const subscriptionStatus = options.subscriptionStatus ?? 'active';
  const stripeCustomerId = options.stripeCustomerId === undefined
    ? `cus_e2e_${suffix}`
    : options.stripeCustomerId;
  const stripeSubscriptionId = options.stripeSubscriptionId === undefined
    ? `sub_e2e_${suffix}`
    : options.stripeSubscriptionId;
  const zernioAccountId = options.zernioConnection === false ? null : `zacct_e2e_${suffix}`;
  const zernioProfileId = options.zernioConnection === false ? null : `zprof_e2e_${suffix}`;

  await sql.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`;
    await tx`
      INSERT INTO users (id, name, email, role, auth_id, account_id)
      VALUES (
        ${userId}::uuid,
        ${'Owner Offboarding ' + suffix},
        ${ownerEmail},
        'owner',
        ${authUserId},
        ${accountId}::uuid
      )
    `;
    await tx`
      INSERT INTO accounts (
        id,
        owner_user_id,
        display_name,
        subscription_tier,
        subscription_status,
        stripe_customer_id,
        stripe_subscription_id,
        subscription_activated_at,
        locations_included,
        locations_paid,
        locations_overage_price_cents,
        base_price_cents
      ) VALUES (
        ${accountId}::uuid,
        ${userId}::uuid,
        ${'Owner Offboarding Account ' + suffix},
        'standard',
        ${subscriptionStatus},
        ${stripeCustomerId},
        ${stripeSubscriptionId},
        NOW(),
        1,
        0,
        2500,
        7900
      )
    `;
    await tx`
      INSERT INTO businesses (
        id,
        name,
        category,
        google_place_id,
        owner_name,
        owner_email,
        subscription_tier,
        subscription_status,
        stripe_customer_id,
        stripe_subscription_id,
        account_id,
        is_primary,
        onboarded_by
      ) VALUES (
        ${businessId}::uuid,
        ${'Owner Offboarding Location ' + suffix},
        'restaurant',
        ${'e2e-owner-offboarding-' + suffix},
        'Owner Offboarding',
        ${ownerEmail},
        'standard',
        ${subscriptionStatus},
        ${stripeCustomerId},
        ${stripeSubscriptionId},
        ${accountId}::uuid,
        TRUE,
        ${userId}::uuid
      )
    `;
    if (zernioAccountId && zernioProfileId) {
      await tx`
        INSERT INTO zernio_connections (
          business_id,
          zernio_profile_id,
          zernio_account_id,
          zernio_location_id,
          status,
          connected_at
        ) VALUES (
          ${businessId}::uuid,
          ${zernioProfileId},
          ${zernioAccountId},
          ${'zloc_e2e_' + suffix},
          'active',
          NOW()
        )
      `;
    }
  });

  return {
    accountId,
    businessId,
    userId,
    authUserId,
    ownerEmail,
    stripeCustomerId,
    stripeSubscriptionId,
    zernioAccountId,
    zernioProfileId,
  };
}

/**
 * Deletes all test data created by seedApprovalFlow.
 * Order respects foreign key constraints.
 */
export async function cleanupApprovalFlow(data: SeedData): Promise<void> {
  const sql = getSql();
  const { businessId, reviewId, responseId } = data;

  await sql`
    DELETE FROM job_outbox
    WHERE aggregate_id IN (${responseId}, ${reviewId}, ${businessId})
       OR (payload->>'business_id' = ${businessId})
  `;

  await sql`DELETE FROM approval_audit_log WHERE business_id = ${businessId}`;
  await sql`DELETE FROM approval_links WHERE business_id = ${businessId}`;
  await sql`DELETE FROM notification_deliveries WHERE business_id = ${businessId}`;
  await sql`DELETE FROM responses WHERE business_id = ${businessId}`;
  await sql`DELETE FROM reviews WHERE business_id = ${businessId}`;
  await sql`DELETE FROM businesses WHERE id = ${businessId}`;
}

export async function cleanupOwnerOffboardingSeed(data: OwnerOffboardingSeedData): Promise<void> {
  const sql = getSql();
  const { accountId, businessId, userId } = data;

  await sql.begin(async (tx) => {
    await tx`
      DELETE FROM job_outbox
      WHERE aggregate_id IN (${accountId}::uuid, ${businessId}::uuid)
         OR payload->>'account_id' = ${accountId}
         OR payload->>'business_id' = ${businessId}
    `;
    await tx`
      DELETE FROM analytics_events
      WHERE account_id = ${accountId}::uuid
         OR business_id = ${businessId}::uuid
         OR user_id = ${userId}::uuid
         OR event_key LIKE 'offboarding_%'
    `;
    await tx`
      DELETE FROM account_offboarding_tokens t
      USING account_offboardings ao
      WHERE t.account_offboarding_id = ao.id
        AND ao.account_id = ${accountId}::uuid
    `;
    await tx`DELETE FROM account_offboardings WHERE account_id = ${accountId}::uuid`;
    await tx`DELETE FROM notification_deliveries WHERE account_id = ${accountId}::uuid OR business_id = ${businessId}::uuid`;
    await tx`DELETE FROM approval_audit_log WHERE account_id = ${accountId}::uuid OR business_id = ${businessId}::uuid`;
    await tx`DELETE FROM account_audit_log WHERE account_id = ${accountId}::uuid`;
    await tx`DELETE FROM zernio_connections WHERE business_id = ${businessId}::uuid`;
    await tx`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
    await tx`UPDATE users SET account_id = NULL WHERE id = ${userId}::uuid`;
    await tx`DELETE FROM accounts WHERE id = ${accountId}::uuid`;
    await tx`DELETE FROM users WHERE id = ${userId}::uuid`;
  });
}

/** Read a response row by ID for assertions. */
export async function getResponse(
  responseId: string,
): Promise<{
  status: string;
  approved_text: string | null;
  edited_text: string | null;
  edit_distance: number | null;
} | null> {
  const sql = getSql();
  const [row] = await sql<{
    status: string;
    approved_text: string | null;
    edited_text: string | null;
    edit_distance: number | null;
  }[]>`
    SELECT status, approved_text, edited_text, edit_distance
    FROM responses WHERE id = ${responseId}
  `;
  return row ?? null;
}

/** Read outbox entries for a business to verify side effects. */
export async function getOutboxEntriesForBusiness(
  businessId: string,
): Promise<Array<{ topic: string; status: string; payload: unknown }>> {
  const sql = getSql();
  const rows = await sql<{ topic: string; status: string; payload: unknown }[]>`
    SELECT topic, status, payload
    FROM job_outbox
    WHERE payload->>'business_id' = ${businessId}
    ORDER BY created_at DESC
  `;
  return rows.map((r) => ({
    ...r,
    payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
  }));
}

/** Close the DB connection (call in globalTeardown or afterAll). */
export async function closeSeedDb(): Promise<void> {
  if (_sql) {
    await _sql.end();
    _sql = null;
  }
}
