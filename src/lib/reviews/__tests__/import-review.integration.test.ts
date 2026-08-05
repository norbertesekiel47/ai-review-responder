// src/lib/reviews/__tests__/import-review.integration.test.ts
//
// Live-Postgres proof for importReview (#674). The mocked suite in
// process-review.test.ts asserts the BINDINGS; this asserts the statement
// actually RUNS — every column exists, no constraint is violated, the
// ON CONFLICT dedup really dedupes, the agent run lands terminal, and no
// job_outbox row is written. importReview ships with no callers, so without
// this nothing in the repo ever executes its SQL.
//
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  cleanupTenantAccount,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import { importReview } from '../process-review';
import type { MonitoredReview } from '../types';
import { REVIEW_STATUS } from '@/lib/reviews/status';

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

let db: postgresType.Sql | undefined;
let tenant: TenantSeed | undefined;
const businessId = randomUUID();
const providerReviewId = `import-${randomUUID()}`;
const providerReviewName = `zernio://import-test/reviews/${providerReviewId}`;

function sql(): postgresType.Sql {
  if (!db) throw new Error('import-review integration database was not initialized');
  return db;
}

function makeMonitored(): MonitoredReview {
  return {
    review: {
      reviewerName: 'Import Fixture Reviewer',
      starRating: 2,
      reviewText: 'Imported inventory review.',
      reviewDate: '2026-07-01T12:00:00.000Z',
      detectedLanguage: 'en',
    },
    identity: {
      provider: 'zernio',
      providerReviewId,
      providerReviewName,
      providerLocationName: 'zernio://import-test/locations/1',
      googleReviewName: null,
      identityStrategy: 'zernio_id',
    },
    contentHash: 'import-fixture-hash',
  };
}

describeWithDb('importReview against live Postgres', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    db = postgres(testDatabaseUrl!, { max: 1, prepare: false });
    tenant = await seedTenantAccount(db, {
      userName: 'Import Review Owner',
      accountDisplayName: 'Import Review Account',
    });

    await sql()`
      INSERT INTO businesses (
        id, name, owner_name, owner_email, account_id, subscription_status
      ) VALUES (
        ${businessId}::uuid, 'Import Review Location', 'Import Review Owner',
        ${tenant.ownerEmail}, ${tenant.accountId}::uuid, 'active'
      )
    `;
  });

  afterAll(async () => {
    if (!db) return;
    if (tenant) {
      await sql()`DELETE FROM analytics_events WHERE account_id = ${tenant.accountId}::uuid`;
      await sql()`DELETE FROM agent_run_steps WHERE agent_run_id IN (
        SELECT id FROM agent_runs WHERE account_id = ${tenant.accountId}::uuid
      )`;
      await sql()`DELETE FROM agent_runs WHERE account_id = ${tenant.accountId}::uuid`;
      await sql()`DELETE FROM reviews WHERE business_id = ${businessId}::uuid`;
      await sql()`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
      await cleanupTenantAccount(sql(), tenant);
    }
    await db.end({ timeout: 5 });
  });

  it('importReview stores the review against the live schema and returns new', async () => {
    const result = await importReview(sql(), makeMonitored(), businessId, 'corr-import-1');

    expect(result).toBe('new');

    const [row] = await sql()<{
      business_id: string;
      provider: string;
      provider_review_id: string;
      provider_review_name: string;
      reviewer_name: string;
      star_rating: number;
      status: string;
      sentiment_score: string | number;
      sentiment_label: string;
      sentiment_source: string;
      review_content_hash: string;
    }[]>`
      SELECT business_id, provider, provider_review_id, provider_review_name,
             reviewer_name, star_rating, status,
             sentiment_score, sentiment_label, sentiment_source,
             review_content_hash
      FROM reviews
      WHERE provider_review_name = ${providerReviewName}
    `;

    expect(row).toBeDefined();
    // Every binding landed in the column it was meant for — the assertion the
    // mocked suite structurally cannot make.
    expect(row!.business_id).toBe(businessId);
    expect(row!.provider).toBe('zernio');
    expect(row!.provider_review_id).toBe(providerReviewId);
    expect(row!.reviewer_name).toBe('Import Fixture Reviewer');
    expect(row!.star_rating).toBe(2);
    expect(row!.status).toBe(REVIEW_STATUS.NEW);
    expect(row!.review_content_hash).toBe('import-fixture-hash');
    // Sentiment is classified at the write site: classifySentiment(2) →
    // { score: (2-3)/2 = -0.5, label: 'negative' }. Assert the SCORE too — the
    // label alone would still pass if the score binding landed in the wrong
    // column, which is the whole point of this suite. NUMERIC comes back as a
    // string from postgres.js, so compare numerically.
    expect(Number(row!.sentiment_score)).toBe(-0.5);
    expect(row!.sentiment_label).toBe('negative');
    expect(row!.sentiment_source).toBe('deterministic_star_v1');
  });

  it('importReview leaves the agent run terminal, not running', async () => {
    const [run] = await sql()<{ id: string; status: string; ended_at: Date | null }[]>`
      SELECT id, status, ended_at
      FROM agent_runs
      WHERE account_id = ${tenant!.accountId}::uuid
        AND kind = 'review_handler'
    `;

    expect(run).toBeDefined();
    // An imported review has no draft and no publish, so nothing downstream
    // would ever complete this run — it would read as 'stalled' after 48h.
    expect(run!.status).toBe('completed');
    expect(run!.ended_at).not.toBeNull();

    // The FK column is `agent_run_id`, NOT `run_id` (migration 071; writer at
    // src/lib/agents/run-spine.ts:304). `run_id` is the name used for the local
    // variable in the run-spine writers, which is what makes this an easy
    // mistake — and exactly the kind of error only a live-DB suite catches.
    const steps = await sql()<{ step_key: string }[]>`
      SELECT step_key FROM agent_run_steps WHERE agent_run_id = ${run!.id}::uuid
    `;
    expect(steps.map((s) => s.step_key)).toContain('review_ingested');
  });

  it('importReview writes no job_outbox row against the live database', async () => {
    const [reviewRow] = await sql()<{ id: string }[]>`
      SELECT id FROM reviews WHERE provider_review_name = ${providerReviewName}
    `;

    const outbox = await sql()<{ id: string }[]>`
      SELECT id FROM job_outbox WHERE aggregate_id::text = ${reviewRow!.id}
    `;
    // Cast the COLUMN, not the parameter — job_outbox.aggregate_id's declared
    // type must not silently decide whether this comparison type-checks.

    // Invariants #2 and #3: no follow-up work, so nothing this path stores
    // can ever reach Google.
    expect(outbox).toHaveLength(0);
  });

  it('importReview is idempotent on a second call for the same review', async () => {
    const result = await importReview(sql(), makeMonitored(), businessId, 'corr-import-2');

    // ON CONFLICT (provider, provider_review_name) DO NOTHING really dedupes.
    expect(result).toBe('unchanged');

    const rows = await sql()<{ id: string }[]>`
      SELECT id FROM reviews WHERE provider_review_name = ${providerReviewName}
    `;
    expect(rows).toHaveLength(1);

    // The skip wrote nothing: still exactly one run, not two.
    const runs = await sql()<{ id: string }[]>`
      SELECT id FROM agent_runs
      WHERE account_id = ${tenant!.accountId}::uuid AND kind = 'review_handler'
    `;
    expect(runs).toHaveLength(1);
  });
});
