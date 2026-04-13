import postgres from 'postgres';
import { randomUUID, createHash } from 'node:crypto';

// ── Safety: never run against production ─────────────────────────────
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

const sql = postgres(dbUrl);

export interface SeedData {
  businessId: string;
  reviewId: string;
  responseId: string;
  rawToken: string;
  tokenHash: string;
  approvalLinkId: string;
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

/**
 * Deletes all test data created by seedApprovalFlow.
 * Order respects foreign key constraints.
 */
export async function cleanupApprovalFlow(data: SeedData): Promise<void> {
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

/** Read a response row by ID for assertions. */
export async function getResponse(
  responseId: string,
): Promise<{
  status: string;
  approved_text: string | null;
  edited_text: string | null;
  edit_distance: number | null;
} | null> {
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
  await sql.end();
}
