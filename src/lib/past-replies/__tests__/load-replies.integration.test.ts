// src/lib/past-replies/__tests__/load-replies.integration.test.ts
//
// T1 EVAL suite for #678 — the LIVE half of the Reviews list query.
//
// The mocked suite (`reviews-list.test.ts`) asserts the SHAPE of the SQL the
// loader issues; this asserts the statement actually RUNS against the real
// schema: the LEFT JOIN + four LATERALs compile, `ORDER BY (resp.id IS NOT NULL)`
// really puts Unanswered first in Postgres' own collation, and the two group
// COUNTs really denominate over ALL reviews rather than posted-only ones. A
// mocked `sql` tag structurally cannot prove any of that — it returns whatever
// the fixture says regardless of what the SQL means.
//
// Live-DB conventions (CLAUDE.md gotcha, `ci:live-db-suites`): named
// `*.integration.test.ts` so vitest serializes it in the `integration` project,
// gated by `describeWithDb`, ASSERTS its schema with `assertSchemaReady`, and
// NEVER applies migration SQL — provisioning is `pnpm test:db:setup`'s job.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  cleanupTenantAccount,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import {
  assertSchemaReady,
  MIGRATION_100_IMPORT_CONSENT,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import { REVIEW_STATUS } from '@/lib/reviews/status';
import { PAGE_SIZE } from '../replies-view';
import { loadPastRepliesPageView } from '../load-replies';

// The batched regen-budget peek is an Upstash read, orthogonal to ordering and
// denominators. Stub it so this suite needs only Postgres. (Its own fail-open
// contract lives in src/lib/costs/__tests__/regen-budget-batch.test.ts.)
vi.mock('@/lib/costs/tracker', () => ({
  peekRegenBudgetBatch: vi.fn(async () => new Map()),
}));

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

let db: postgresType.Sql | undefined;
let tenant: TenantSeed | undefined;
const businessId = randomUUID();

function sql(): postgresType.Sql {
  if (!db) throw new Error('reviews-list integration database was not initialized');
  return db;
}

interface ReviewsListView {
  unansweredRows: { review_id: string; reply_state: string; row_action: string }[];
  answeredRows: { review_id: string; reply_state: string; row_action: string }[];
  unansweredTotal: number;
  answeredTotal: number;
  avgStarRating: number | null;
  totalPages: number;
}

// Deterministic ids so the assertions can name rows rather than positions.
const REVIEW_ANSWERED_NEW = randomUUID();
const REVIEW_ANSWERED_OLD = randomUUID();
const REVIEW_UNANSWERED_NEW = randomUUID();
const REVIEW_UNANSWERED_OLD = randomUUID();
const RESPONSE_NEW = randomUUID();
const RESPONSE_OLD = randomUUID();
const REVIEW_HELD_REPLACEMENT = randomUUID();
const RESPONSE_HELD_POSTED = randomUUID();
const RESPONSE_HELD_DRAFT = randomUUID();
const REVIEW_READY_CONTROL = randomUUID();
const RESPONSE_READY_POSTED = randomUUID();
const RESPONSE_READY_DRAFT = randomUUID();
const REVIEW_CLOSED_CONTROL = randomUUID();
const RESPONSE_CLOSED_POSTED = randomUUID();
const RESPONSE_CLOSED_DRAFT = randomUUID();
const HELD_DRAFT_TEXT = 'held replacement draft SECRET sentinel';

async function seedReview(
  reviewId: string,
  starRating: number,
  reviewDateIso: string,
  status: string,
): Promise<void> {
  await sql()`
    INSERT INTO reviews (
      id, business_id, provider, provider_review_id, provider_review_name,
      provider_location_name, reviewer_name, star_rating, review_text,
      review_date, status
    ) VALUES (
      ${reviewId}::uuid, ${businessId}::uuid, 'zernio',
      ${`revlist-${reviewId}`}, ${`zernio://revlist/reviews/${reviewId}`},
      'zernio://revlist/locations/1', 'Reviews List Customer',
      ${starRating}, 'Reviews list fixture review',
      ${reviewDateIso}::timestamptz, ${status}
    )
  `;
}

async function seedPostedResponse(responseId: string, reviewId: string): Promise<void> {
  await sql()`
    INSERT INTO responses (
      id, review_id, business_id, response_text, original_draft_text,
      approved_text, response_language, version, status, approval_method, posted_at
    ) VALUES (
      ${responseId}::uuid, ${reviewId}::uuid, ${businessId}::uuid,
      'Thank you!', 'Thank you!', 'Thank you!', 'en', 1, 'posted', 'owner', NOW()
    )
  `;
}

// A non-terminal replacement draft (version 2) beside a live posted reply.
// `posted` is outside the responses_one_non_terminal_per_review predicate, so
// the pair coexists — exactly the Regenerate-in-flight shape.
async function seedReplacementDraft(
  reviewId: string,
  draftId: string,
  responseText: string,
): Promise<void> {
  await sql()`
    INSERT INTO responses (
      id, review_id, business_id, response_text, original_draft_text,
      response_language, version, status
    ) VALUES (
      ${draftId}::uuid, ${reviewId}::uuid, ${businessId}::uuid,
      ${responseText}, ${responseText}, 'en', 2, 'pending_approval'
    )
  `;
}

// Status literals are spelled inline the same way the loader's LATERAL spells
// `f.status = 'open'` (D6; src/lib/moderation/held-draft.ts is the semantic
// owner). `api_cost_id` is nullable — deliberately omitted.
async function seedFlag(reviewId: string, draftId: string, status: string): Promise<void> {
  await sql()`
    INSERT INTO flagged_responses (
      id, response_id, account_id, business_id, review_id,
      source, reason, severity, status
    ) VALUES (
      ${randomUUID()}::uuid, ${draftId}::uuid, ${tenant!.accountId}::uuid,
      ${businessId}::uuid, ${reviewId}::uuid,
      'local_regex', 'reviews-list integration fixture hold', 'high', ${status}
    )
  `;
}

describeWithDb('Reviews list query against live Postgres', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    db = postgres(testDatabaseUrl!, { max: 1, prepare: false });
    // #678 ships NO migration, so there is no requirement of its own to name.
    // 100 is asserted as the head proxy: it is the newest requirement touching
    // `businesses`, and a container behind it fails loudly with the actionable
    // `pnpm test:db:setup` message instead of surfacing as a confusing
    // assertion failure inside a title about ordering.
    await assertSchemaReady(db, [MIGRATION_100_IMPORT_CONSENT]);
    tenant = await seedTenantAccount(db, {
      userName: 'Reviews List Owner',
      accountDisplayName: 'Reviews List Account',
    });
    await sql()`
      UPDATE accounts SET subscription_activated_at = '2026-03-01T00:00:00Z'::timestamptz
      WHERE id = ${tenant.accountId}::uuid
    `;
    await sql()`
      INSERT INTO businesses (id, name, owner_name, owner_email, account_id, subscription_status)
      VALUES (${businessId}::uuid, 'Reviews List Location', 'Reviews List Owner',
              ${tenant.ownerEmail}, ${tenant.accountId}::uuid, 'active')
    `;

    // Two answered + two unanswered, deliberately interleaved in time so a
    // date-only ORDER BY would put an answered row first.
    await seedReview(REVIEW_ANSWERED_NEW, 5, '2026-07-01T00:00:00Z', REVIEW_STATUS.POSTED);
    await seedReview(REVIEW_ANSWERED_OLD, 4, '2026-05-01T00:00:00Z', REVIEW_STATUS.POSTED);
    await seedReview(REVIEW_UNANSWERED_NEW, 2, '2026-06-01T00:00:00Z', REVIEW_STATUS.NEW);
    await seedReview(REVIEW_UNANSWERED_OLD, 1, '2026-04-01T00:00:00Z', REVIEW_STATUS.NEW);
    await seedPostedResponse(RESPONSE_NEW, REVIEW_ANSWERED_NEW);
    await seedPostedResponse(RESPONSE_OLD, REVIEW_ANSWERED_OLD);

    // #727: three answered rows with a replacement draft — held, ready, and
    // closed-flag. All rate 3 so the avg assertion stays 3 = (5+4+2+1+3+3+3)/7;
    // the dates sort them after the existing answered rows.
    await seedReview(REVIEW_HELD_REPLACEMENT, 3, '2026-02-01T00:00:00Z', REVIEW_STATUS.POSTED);
    await seedPostedResponse(RESPONSE_HELD_POSTED, REVIEW_HELD_REPLACEMENT);
    await seedReplacementDraft(REVIEW_HELD_REPLACEMENT, RESPONSE_HELD_DRAFT, HELD_DRAFT_TEXT);
    await seedFlag(REVIEW_HELD_REPLACEMENT, RESPONSE_HELD_DRAFT, 'open');

    // Negative control 1: identical shape, NO flag → the draft is ready, not held.
    await seedReview(REVIEW_READY_CONTROL, 3, '2026-01-15T00:00:00Z', REVIEW_STATUS.POSTED);
    await seedPostedResponse(RESPONSE_READY_POSTED, REVIEW_READY_CONTROL);
    await seedReplacementDraft(REVIEW_READY_CONTROL, RESPONSE_READY_DRAFT, 'ready replacement draft');

    // Negative control 2: identical shape, flag exists but is NOT open.
    // 'dismissed_false_positive' verified against the migration 051 status
    // CHECK ('open' | 'approved_for_owner_review' | 'dismissed_false_positive'
    // | 'requires_regeneration').
    await seedReview(REVIEW_CLOSED_CONTROL, 3, '2026-01-10T00:00:00Z', REVIEW_STATUS.POSTED);
    await seedPostedResponse(RESPONSE_CLOSED_POSTED, REVIEW_CLOSED_CONTROL);
    await seedReplacementDraft(REVIEW_CLOSED_CONTROL, RESPONSE_CLOSED_DRAFT, 'closed-flag replacement draft');
    await seedFlag(REVIEW_CLOSED_CONTROL, RESPONSE_CLOSED_DRAFT, 'dismissed_false_positive');
  });

  afterAll(async () => {
    if (!db) return;
    if (tenant) {
      // FK order: flagged_responses references responses.
      await sql()`DELETE FROM flagged_responses WHERE business_id = ${businessId}::uuid`;
      await sql()`DELETE FROM responses WHERE business_id = ${businessId}::uuid`;
      await sql()`DELETE FROM reviews WHERE business_id = ${businessId}::uuid`;
      await sql()`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
      await cleanupTenantAccount(sql(), tenant);
    }
    await db.end({ timeout: 5 });
  });

  it('loadPastRepliesPageView integration: unanswered-first ordering and count denominators against the live schema', async () => {
    const view = (await loadPastRepliesPageView(sql(), {
      accountId: tenant!.accountId,
      locationId: businessId,
      page: 1,
    })) as unknown as ReviewsListView | null;

    expect(view).not.toBeNull();

    // Unanswered first, newest-first inside each group (S6). The interleaved
    // fixture dates mean this ordering cannot come out right by accident.
    expect(view!.unansweredRows.map((row) => row.review_id)).toEqual([
      REVIEW_UNANSWERED_NEW,
      REVIEW_UNANSWERED_OLD,
    ]);
    expect(view!.answeredRows.map((row) => row.review_id)).toEqual([
      REVIEW_ANSWERED_NEW,
      REVIEW_ANSWERED_OLD,
      REVIEW_HELD_REPLACEMENT,
      REVIEW_READY_CONTROL,
      REVIEW_CLOSED_CONTROL,
    ]);

    // Count denominators span ALL reviews, not only replied ones (#671 landmine 3).
    expect(view!.unansweredTotal).toBe(2);
    expect(view!.answeredTotal).toBe(5);
    expect(view!.totalPages).toBe(Math.max(1, Math.ceil(7 / PAGE_SIZE)));

    // Avg rating over all seven reviews (5 + 4 + 2 + 1 + 3 + 3 + 3) / 7 = 3,
    // NOT the posted-only average the pre-#678 query returned.
    expect(view!.avgStarRating).toBeCloseTo(3, 5);

    // The action slots the live query derives, end to end (#727): every
    // unanswered row offers Generate; the held-replacement row alone withdraws
    // its affordance while its posted siblings keep Regenerate.
    expect(view!.unansweredRows.every((row) => row.row_action === 'generate')).toBe(true);
    expect(view!.answeredRows.map((row) => row.row_action)).toEqual([
      'regenerate', 'regenerate', 'none', 'regenerate', 'regenerate',
    ]);
  });

  it('returns row_action none while keeping reply_state posted for a review whose replacement draft is moderation-held', async () => {
    const view = (await loadPastRepliesPageView(sql(), {
      accountId: tenant!.accountId,
      locationId: businessId,
      page: 1,
    })) as unknown as ReviewsListView | null;

    const heldRow = view!.answeredRows.find((row) => row.review_id === REVIEW_HELD_REPLACEMENT);
    // The posted-reply axis owns grouping: the row stays Answered.
    expect(heldRow).toBeDefined();
    expect(heldRow!.reply_state).toBe('posted');
    // The action slot withdraws Regenerate (invariant #4, the #710-item-1 bug cell).
    expect(heldRow!.row_action).toBe('none');
    // The draft axis never crosses the wire — by key OR by value: the held
    // draft's text must not appear anywhere in the serialized page view.
    const keys = Object.keys(heldRow!);
    expect(keys).not.toContain('draft_held');
    expect(keys).not.toContain('draft_response_id');
    expect(JSON.stringify(view)).not.toContain(HELD_DRAFT_TEXT);
  });

  it('distinguishes an open-held replacement from unflagged and closed replacements', async () => {
    const view = (await loadPastRepliesPageView(sql(), {
      accountId: tenant!.accountId,
      locationId: businessId,
      page: 1,
    })) as unknown as ReviewsListView | null;

    const actionFor = (id: string) =>
      view!.answeredRows.find((row) => row.review_id === id)?.row_action;
    // Only the OPEN flag holds; an unflagged or closed-flag replacement keeps
    // Regenerate — the withdrawal tracks flagged_responses.status = 'open'
    // exactly (src/lib/moderation/held-draft.ts semantics).
    expect(actionFor(REVIEW_HELD_REPLACEMENT)).toBe('none');
    expect(actionFor(REVIEW_READY_CONTROL)).toBe('regenerate');
    expect(actionFor(REVIEW_CLOSED_CONTROL)).toBe('regenerate');
  });
});
