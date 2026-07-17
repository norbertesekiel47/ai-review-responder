import postgres from 'postgres';
import { randomUUID, createHash } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import type { SubscriptionTierValue } from '../src/lib/accounts/tier-config';

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

  // prepare:false — TEST_DATABASE_POOL_URL may point at a Supabase PgBouncer
  // pooler (transaction pooling drops prepared statements between queries;
  // same setting as the app client in src/lib/db/server.ts). Harmless against
  // a direct local Postgres.
  _sql = postgres(dbUrl, { prepare: false });
  return _sql;
}

export interface SeedData {
  accountId: string;
  userId: string;
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

export interface MultiLocationSeedData {
  accountId: string;
  primaryBusinessId: string;
  secondaryBusinessId: string;
  zernioAccountId: string;
  primaryZernioLocationId: string;
  secondaryZernioLocationId: string;
  userId: string;
  authUserId: string;
  ownerEmail: string;
}

export interface SeedMultiLocationAccountOptions {
  subscriptionStatus?: 'active' | 'pending_payment' | 'past_due' | 'cancelled';
  /** Stored quota override for grandfathering tests. Default: one launch-included location. */
  locationsIncluded?: number;
  /** Insert an org-default email channel enrollment. Default: true. */
  orgDefaultChannel?: boolean;
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
 * Point-in-time Copilot list billing snapshot (invariant #9a) stamped onto
 * every seeded accounts row. One owner for the numbers the seeders write and
 * the integration tests assert — import it instead of repeating the literals.
 */
export const COPILOT_TIER_SNAPSHOT = {
  tier: 'copilot',
  priceVariant: 'list',
  overagePriceCents: 1500,
  basePriceCents: 2900,
} as const;

// ── Shared seed builders ─────────────────────────────────────────────────────
// Every account-shaped seeder (offboarding, multi-location, the next one)
// composes these instead of cloning INSERT blocks. One column list per table;
// adding a column is a one-place change.

interface OwnerAccountSeed {
  accountId: string;
  userId: string;
  authUserId: string;
  ownerName: string;
  ownerEmail: string;
  accountDisplayName: string;
  subscriptionStatus: string;
  locationsIncluded: number;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
}

// users.account_id ↔ accounts.owner_user_id are circular DEFERRABLE FKs
// (migration 036) — hence SET CONSTRAINTS ALL DEFERRED before the pair.
async function insertOwnerWithAccount(tx: TransactionSql, seed: OwnerAccountSeed): Promise<void> {
  await tx`SET CONSTRAINTS ALL DEFERRED`;
  await tx`
    INSERT INTO users (id, name, email, role, auth_id, account_id)
    VALUES (
      ${seed.userId}::uuid,
      ${seed.ownerName},
      ${seed.ownerEmail},
      'owner',
      ${seed.authUserId},
      ${seed.accountId}::uuid
    )
  `;
  await tx`
    INSERT INTO accounts (
      id,
      owner_user_id,
      display_name,
      subscription_tier,
      price_variant,
      subscription_status,
      stripe_customer_id,
      stripe_subscription_id,
      subscription_activated_at,
      locations_included,
      locations_paid,
      locations_overage_price_cents,
      base_price_cents
    ) VALUES (
      ${seed.accountId}::uuid,
      ${seed.userId}::uuid,
      ${seed.accountDisplayName},
      ${COPILOT_TIER_SNAPSHOT.tier},
      ${COPILOT_TIER_SNAPSHOT.priceVariant},
      ${seed.subscriptionStatus},
      ${seed.stripeCustomerId},
      ${seed.stripeSubscriptionId},
      NOW(),
      ${seed.locationsIncluded},
      0,
      ${COPILOT_TIER_SNAPSHOT.overagePriceCents},
      ${COPILOT_TIER_SNAPSHOT.basePriceCents}
    )
  `;
}

interface BusinessSeedRow {
  id: string;
  name: string;
  display_label: string | null;
  category: string;
  google_place_id: string;
  owner_name: string;
  owner_email: string;
  subscription_tier: SubscriptionTierValue;
  subscription_status: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  account_id: string;
  is_primary: boolean;
  onboarded_by: string;
}

async function insertBusinesses(tx: TransactionSql, rows: BusinessSeedRow[]): Promise<void> {
  await tx`INSERT INTO businesses ${tx(rows)}`;
}

interface ZernioConnectionSeedRow {
  business_id: string;
  zernio_profile_id: string;
  zernio_account_id: string;
  zernio_location_id: string;
  status: string;
  connected_at: Date;
}

async function insertZernioConnections(
  tx: TransactionSql,
  rows: ZernioConnectionSeedRow[],
): Promise<void> {
  await tx`INSERT INTO zernio_connections ${tx(rows)}`;
}

/**
 * Account-scoped delete cascade — the ONE owner of the table order needed to
 * tear down a seeded account. Every seeder family's cleanup delegates here so
 * a new FK-bearing table is a one-place change. (The previous twin cascades
 * diverged twice in a single PR: channel_enrollments and api_costs each
 * landed in only one copy.)
 *
 * `knownBusinessIds` / `ownerUserId` keep callers robust when the flow under
 * test already mutated the graph: offboarding purge tests may have deleted
 * the accounts row (so owner_user_id is unfetchable) or unlinked businesses
 * (so resolving them via account_id alone would miss rows).
 */
async function cleanupAccountCascade(
  accountId: string,
  opts: {
    ownerUserId?: string | null;
    knownBusinessIds?: readonly string[];
    analyticsEventKeyLike?: string;
  } = {},
): Promise<void> {
  const sql = getSql();
  const ownerUserId =
    opts.ownerUserId !== undefined
      ? opts.ownerUserId
      : ((
          await sql<{ owner_user_id: string }[]>`
            SELECT owner_user_id FROM accounts WHERE id = ${accountId}::uuid
          `
        )[0]?.owner_user_id ?? null);

  await sql.begin(async (tx) => {
    const liveBizRows = await tx<{ id: string }[]>`
      SELECT id FROM businesses WHERE account_id = ${accountId}::uuid
    `;
    const bizIds = [
      ...new Set([...liveBizRows.map((row) => row.id), ...(opts.knownBusinessIds ?? [])]),
    ];

    await tx`
      DELETE FROM job_outbox
      WHERE aggregate_id = ${accountId}::uuid
         OR aggregate_id = ANY(${bizIds}::uuid[])
         OR payload->>'account_id' = ${accountId}
         OR payload->>'business_id' = ANY(${bizIds}::text[])
    `;
    await tx`
      DELETE FROM analytics_events
      WHERE account_id = ${accountId}::uuid
         OR business_id = ANY(${bizIds}::uuid[])
         ${ownerUserId ? tx`OR user_id = ${ownerUserId}::uuid` : tx``}
         ${opts.analyticsEventKeyLike ? tx`OR event_key LIKE ${opts.analyticsEventKeyLike}` : tx``}
    `;
    await tx`
      DELETE FROM account_offboarding_tokens t
      USING account_offboardings ao
      WHERE t.account_offboarding_id = ao.id
        AND ao.account_id = ${accountId}::uuid
    `;
    await tx`DELETE FROM account_offboardings WHERE account_id = ${accountId}::uuid`;
    await tx`
      DELETE FROM notification_deliveries
      WHERE account_id = ${accountId}::uuid OR business_id = ANY(${bizIds}::uuid[])
    `;
    await tx`
      DELETE FROM approval_audit_log
      WHERE account_id = ${accountId}::uuid OR business_id = ANY(${bizIds}::uuid[])
    `;
    await tx`DELETE FROM account_audit_log WHERE account_id = ${accountId}::uuid`;
    await tx`DELETE FROM channel_enrollments WHERE account_id = ${accountId}::uuid`;
    await tx`DELETE FROM zernio_connections WHERE business_id = ANY(${bizIds}::uuid[])`;
    // api_costs.business_id / .response_id have NO ON DELETE action (001 schema):
    // rows written by real draft generation block both the businesses delete and
    // the responses cascade, so they go first.
    await tx`
      DELETE FROM api_costs
      WHERE account_id = ${accountId}::uuid
         OR business_id = ANY(${bizIds}::uuid[])
         OR response_id IN (
           SELECT id FROM responses WHERE business_id = ANY(${bizIds}::uuid[])
         )
    `;
    await tx`
      DELETE FROM businesses
      WHERE account_id = ${accountId}::uuid OR id = ANY(${bizIds}::uuid[])
    `;
    if (ownerUserId) {
      await tx`UPDATE users SET account_id = NULL WHERE id = ${ownerUserId}::uuid`;
    }
    await tx`DELETE FROM accounts WHERE id = ${accountId}::uuid`;
    if (ownerUserId) {
      await tx`DELETE FROM users WHERE id = ${ownerUserId}::uuid`;
    }
  });
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
  const accountId = randomUUID();
  const userId = randomUUID();
  const authUserId = randomUUID();
  const businessId = randomUUID();
  const reviewId = randomUUID();
  const responseId = randomUUID();
  const approvalLinkId = randomUUID();
  const rawToken = randomUUID();
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const suffix = businessId.slice(0, 8);
  const ownerEmail = `e2e-approval-${suffix}@test.local`;

  const expiresAt = overrides.expiresAt ?? new Date(Date.now() + 48 * 3600_000);
  const consumedAt = overrides.consumedAt ?? null;

  await sql.begin(async (tx) => {
    // businesses.account_id is NOT NULL (accounts-parent schema) — every
    // location needs its billing account + owner user, even for the
    // token-based approval flow that never logs in.
    await insertOwnerWithAccount(tx, {
      accountId,
      userId,
      authUserId,
      ownerName: 'Test Owner',
      ownerEmail,
      accountDisplayName: `E2E Approval Account ${suffix}`,
      subscriptionStatus: 'active',
      locationsIncluded: 1,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    });
    await insertBusinesses(tx, [
      {
        id: businessId,
        name: `E2E Test Biz ${suffix}`,
        display_label: null,
        category: 'restaurant',
        google_place_id: `e2e-place-${suffix}`,
        owner_name: 'Test Owner',
        owner_email: ownerEmail,
        subscription_tier: COPILOT_TIER_SNAPSHOT.tier,
        subscription_status: 'active',
        stripe_customer_id: null,
        stripe_subscription_id: null,
        account_id: accountId,
        is_primary: true,
        onboarded_by: userId,
      },
    ]);

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

  return { accountId, userId, businessId, reviewId, responseId, rawToken, tokenHash, approvalLinkId };
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
    await insertOwnerWithAccount(tx, {
      accountId,
      userId,
      authUserId,
      ownerName: `Owner Offboarding ${suffix}`,
      ownerEmail,
      accountDisplayName: `Owner Offboarding Account ${suffix}`,
      subscriptionStatus,
      locationsIncluded: 1,
      stripeCustomerId,
      stripeSubscriptionId,
    });
    await insertBusinesses(tx, [
      {
        id: businessId,
        name: `Owner Offboarding Location ${suffix}`,
        display_label: null,
        category: 'restaurant',
        google_place_id: `e2e-owner-offboarding-${suffix}`,
        owner_name: 'Owner Offboarding',
        owner_email: ownerEmail,
        subscription_tier: COPILOT_TIER_SNAPSHOT.tier,
        subscription_status: subscriptionStatus,
        stripe_customer_id: stripeCustomerId,
        stripe_subscription_id: stripeSubscriptionId,
        account_id: accountId,
        is_primary: true,
        onboarded_by: userId,
      },
    ]);
    if (zernioAccountId && zernioProfileId) {
      await insertZernioConnections(tx, [
        {
          business_id: businessId,
          zernio_profile_id: zernioProfileId,
          zernio_account_id: zernioAccountId,
          zernio_location_id: `zloc_e2e_${suffix}`,
          status: 'active',
          connected_at: new Date(),
        },
      ]);
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

export async function seedMultiLocationAccount(
  options: SeedMultiLocationAccountOptions = {},
): Promise<MultiLocationSeedData> {
  const sql = getSql();
  const accountId = randomUUID();
  const primaryBusinessId = randomUUID();
  const secondaryBusinessId = randomUUID();
  const userId = randomUUID();
  const authUserId = randomUUID();
  const suffix = accountId.slice(0, 8);
  const ownerEmail = `owner-multiloc-${suffix}@test.local`;
  const subscriptionStatus = options.subscriptionStatus ?? 'active';
  const locationsIncluded = options.locationsIncluded ?? 1;
  const orgDefaultChannel = options.orgDefaultChannel !== false;
  const zernioAccountId = `zacct_e2e_${suffix}`;
  const primaryZernioLocationId = `zloc_e2e_${suffix}_1`;
  const secondaryZernioLocationId = `zloc_e2e_${suffix}_2`;

  await sql.begin(async (tx) => {
    await insertOwnerWithAccount(tx, {
      accountId,
      userId,
      authUserId,
      ownerName: `Multi-Location Owner ${suffix}`,
      ownerEmail,
      accountDisplayName: `Multi-Location Account ${suffix}`,
      subscriptionStatus,
      locationsIncluded,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    });
    const sharedBusinessColumns = {
      category: 'restaurant',
      owner_name: 'Multi-Location Owner',
      owner_email: ownerEmail,
      subscription_tier: COPILOT_TIER_SNAPSHOT.tier,
      subscription_status: subscriptionStatus,
      stripe_customer_id: null,
      stripe_subscription_id: null,
      account_id: accountId,
      onboarded_by: userId,
    };
    await insertBusinesses(tx, [
      {
        ...sharedBusinessColumns,
        id: primaryBusinessId,
        name: `E2E Primary Location ${suffix}`,
        display_label: 'Downtown',
        google_place_id: `e2e-ml-${suffix}-loc1`,
        is_primary: true,
      },
      {
        ...sharedBusinessColumns,
        id: secondaryBusinessId,
        name: `E2E Secondary Location ${suffix}`,
        display_label: 'Airport',
        google_place_id: `e2e-ml-${suffix}-loc2`,
        is_primary: false,
      },
    ]);
    await insertZernioConnections(tx, [
      {
        business_id: primaryBusinessId,
        zernio_profile_id: `zprof_e2e_${suffix}_1`,
        zernio_account_id: zernioAccountId,
        zernio_location_id: primaryZernioLocationId,
        status: 'active',
        connected_at: new Date(),
      },
      {
        business_id: secondaryBusinessId,
        zernio_profile_id: `zprof_e2e_${suffix}_2`,
        zernio_account_id: zernioAccountId,
        zernio_location_id: secondaryZernioLocationId,
        status: 'active',
        connected_at: new Date(),
      },
    ]);
    if (orgDefaultChannel) {
      await tx`
        INSERT INTO channel_enrollments (
          id,
          business_id,
          account_id,
          location_id,
          channel,
          handle,
          status,
          verified_at
        ) VALUES (
          ${randomUUID()}::uuid,
          ${primaryBusinessId}::uuid,
          ${accountId}::uuid,
          NULL,
          'email',
          ${ownerEmail},
          'verified',
          NOW()
        )
      `;
    }
  });

  return {
    accountId,
    primaryBusinessId,
    secondaryBusinessId,
    zernioAccountId,
    primaryZernioLocationId,
    secondaryZernioLocationId,
    userId,
    authUserId,
    ownerEmail,
  };
}

export interface LocationReviewSeedData {
  reviewId: string;
  responseId: string;
}

/**
 * Seed one review + pending_approval response on a specific location, with a
 * caller-supplied marker woven into the review and draft text so per-location
 * scoping assertions can tell the two locations' data apart. This is the seed
 * capability the fixme'd scoping scenarios in e2e/multi-location.spec.ts
 * assert against; rows cascade on business delete, and api_costs rows (only
 * written by REAL generation, not this seeder) are removed by
 * cleanupMultiLocationAccount.
 */
export async function seedLocationReview(input: {
  businessId: string;
  marker: string;
}): Promise<LocationReviewSeedData> {
  const sql = getSql();
  const reviewId = randomUUID();
  const responseId = randomUUID();
  const contentHash = createHash('sha256').update(reviewId).digest('hex');

  await sql.begin(async (tx) => {
    // Sentiment columns mirror classifySentiment (deterministic_star_v1) for
    // star 4: score (4-3)/2 = 0.5, label 'positive'. Review-content write
    // sites populate sentiment (repo convention); values are inlined because
    // seed.ts is raw-SQL-only and does not import from src/.
    await tx`
      INSERT INTO reviews (id, business_id, provider, provider_review_id, provider_review_name, provider_location_name, reviewer_name, star_rating, review_text, review_date, detected_language, review_content_hash, status, sentiment_score, sentiment_label, sentiment_source)
      VALUES (${reviewId}, ${input.businessId}, 'test', ${reviewId}, ${'test://review/' + reviewId}, ${'test://location/' + input.businessId}, 'E2E Reviewer', 4, ${input.marker + ' — great experience, would come again!'}, NOW(), 'en', ${contentHash}, 'pending_approval', 0.5, 'positive', 'deterministic_star_v1')
    `;
    await tx`
      INSERT INTO responses (id, review_id, business_id, response_text, response_language, version, status, original_draft_text, llm_provider, llm_model, prompt_tokens, completion_tokens)
      VALUES (${responseId}, ${reviewId}, ${input.businessId}, ${'Thank you for your kind words! ' + input.marker}, 'en', 1, 'pending_approval', ${'Thank you for your kind words! ' + input.marker}, 'openai', 'gpt-4o-mini', 100, 50)
    `;
  });

  return { reviewId, responseId };
}

export async function cleanupMultiLocationAccount(accountId: string): Promise<void> {
  await cleanupAccountCascade(accountId);
}

/**
 * Deletes all test data created by seedApprovalFlow.
 * Order respects foreign key constraints.
 */
export async function cleanupApprovalFlow(data: SeedData): Promise<void> {
  const sql = getSql();
  const { accountId, userId, businessId, reviewId, responseId } = data;

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
  // users.account_id ↔ accounts.owner_user_id are circular FKs — break the
  // link before deleting either side (same dance as the other cleanups).
  await sql`UPDATE users SET account_id = NULL WHERE id = ${userId}::uuid`;
  await sql`DELETE FROM accounts WHERE id = ${accountId}::uuid`;
  await sql`DELETE FROM users WHERE id = ${userId}::uuid`;
}

export async function cleanupOwnerOffboardingSeed(data: OwnerOffboardingSeedData): Promise<void> {
  // ownerUserId/knownBusinessIds come from the seed handle, NOT a live lookup:
  // offboarding purge tests may have already deleted the accounts row or
  // unlinked the business, and cleanup must still remove everything.
  await cleanupAccountCascade(data.accountId, {
    ownerUserId: data.userId,
    knownBusinessIds: [data.businessId],
    analyticsEventKeyLike: 'offboarding_%',
  });
}

// ── Auth-harness owner seed (e2e/harness.ts) ────────────────────────────────
// A full owner identity for the auth-funnel specs: the Supabase Auth user
// lives in the harness project (staging); these are the matching TEST-DB rows
// (account + users + primary business) keyed by that auth user's id.

export interface AuthOwnerSeedData {
  accountId: string;
  userId: string;
  businessId: string;
  ownerEmail: string;
}

export async function seedAuthOwnerAccount(input: {
  ownerEmail: string;
  authUserId: string;
}): Promise<AuthOwnerSeedData> {
  const sql = getSql();
  const accountId = randomUUID();
  const userId = randomUUID();
  const businessId = randomUUID();
  const suffix = accountId.slice(0, 8);

  await sql.begin(async (tx) => {
    await insertOwnerWithAccount(tx, {
      accountId,
      userId,
      authUserId: input.authUserId,
      ownerName: 'E2E Harness Owner',
      ownerEmail: input.ownerEmail,
      accountDisplayName: `E2E Auth Account ${suffix}`,
      subscriptionStatus: 'active',
      locationsIncluded: 1,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    });
    await insertBusinesses(tx, [
      {
        id: businessId,
        name: `E2E Auth Biz ${suffix}`,
        display_label: null,
        category: 'restaurant',
        google_place_id: `e2e-auth-${suffix}`,
        owner_name: 'E2E Harness Owner',
        owner_email: input.ownerEmail,
        subscription_tier: COPILOT_TIER_SNAPSHOT.tier,
        subscription_status: 'active',
        stripe_customer_id: null,
        stripe_subscription_id: null,
        account_id: accountId,
        is_primary: true,
        onboarded_by: userId,
      },
    ]);
  });

  return { accountId, userId, businessId, ownerEmail: input.ownerEmail };
}

export async function cleanupAuthOwnerAccount(data: AuthOwnerSeedData): Promise<void> {
  const sql = getSql();
  await sql`DELETE FROM channel_enrollments WHERE business_id = ${data.businessId}::uuid`;
  await sql`DELETE FROM businesses WHERE id = ${data.businessId}::uuid`;
  await sql`UPDATE users SET account_id = NULL WHERE id = ${data.userId}::uuid`;
  await sql`DELETE FROM accounts WHERE id = ${data.accountId}::uuid`;
  await sql`DELETE FROM users WHERE id = ${data.userId}::uuid`;
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
