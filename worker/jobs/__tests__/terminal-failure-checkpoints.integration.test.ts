import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Job } from 'bullmq';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { randomUUID } from 'node:crypto';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  cleanupTenantAccount,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import { startOrGetActiveRun } from '@/lib/agents/run-spine';
import { checkpointTerminalGeneration } from '../ResponseGeneratorWorker';
import {
  checkpointTerminalPublisherFailure,
  handlePublisherFailed,
} from '../publisher/failed-hook';
import { PublisherTransientWithContext } from '../publisher/publisher-error-handlers';
import { ZernioTransientError } from '@/lib/zernio/errors';
import type { PublishResponsePayload } from '@/lib/shared/worker-types';

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;
let db: postgresType.Sql | undefined;
let tenant: TenantSeed | undefined;

const businessId = randomUUID();
const generationReviewId = randomUUID();
const publisherReviewId = randomUUID();
const responseId = randomUUID();
const generationOutboxId = randomUUID();
const publisherOutboxId = randomUUID();
const staleGenerationReviewId = randomUUID();
const stalePublisherReviewId = randomUUID();
const staleOrphanReviewId = randomUUID();
const stalePublisherResponseId = randomUUID();
const staleOrphanResponseId = randomUUID();
const staleGenerationOutboxId = randomUUID();
const stalePublisherOutboxId = randomUUID();
const staleOrphanOutboxId = randomUUID();

function sql(): postgresType.Sql {
  if (!db) throw new Error('terminal checkpoint integration DB was not initialized');
  return db;
}

async function seedRun(reviewId: string): Promise<string> {
  const result = await sql().begin((tx) => startOrGetActiveRun(tx, {
    kind: 'review_handler',
    subjectType: 'review',
    subjectId: reviewId,
    accountId: tenant!.accountId,
    businessId,
  }));
  return result.runId;
}

describeWithDb('terminal-failure run checkpoints against live Postgres', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    db = postgres(testDatabaseUrl!, { max: 2, prepare: false });
    tenant = await seedTenantAccount(db, {
      userName: 'Terminal Checkpoint Owner',
      accountDisplayName: 'Terminal Checkpoint Account',
    });
    await db`
      INSERT INTO businesses (id, name, owner_name, owner_email, account_id, subscription_status)
      VALUES (
        ${businessId}::uuid, 'Terminal Checkpoint Biz', 'Terminal Checkpoint Owner',
        ${tenant.ownerEmail}, ${tenant.accountId}::uuid, 'active'
      )
    `;
    await db`
      INSERT INTO reviews (
        id, business_id, provider, provider_review_id, provider_review_name,
        provider_location_name, reviewer_name, star_rating, review_text, status
      ) VALUES
      (
        ${generationReviewId}::uuid, ${businessId}::uuid, 'zernio',
        ${`terminal-generation-${generationReviewId}`},
        ${`zernio://terminal/reviews/${generationReviewId}`},
        'zernio://terminal/locations/1', 'Generation Reviewer', 2, 'Needs work', 'pending'
      ),
      (
        ${publisherReviewId}::uuid, ${businessId}::uuid, 'zernio',
        ${`terminal-publisher-${publisherReviewId}`},
        ${`zernio://terminal/reviews/${publisherReviewId}`},
        'zernio://terminal/locations/1', 'Publisher Reviewer', 4, 'Pretty good', 'responded'
      ),
      (
        ${staleGenerationReviewId}::uuid, ${businessId}::uuid, 'zernio',
        ${`stale-generation-${staleGenerationReviewId}`},
        ${`zernio://terminal/reviews/${staleGenerationReviewId}`},
        'zernio://terminal/locations/1', 'Stale Generation Reviewer', 2, 'Needs work', 'pending'
      ),
      (
        ${stalePublisherReviewId}::uuid, ${businessId}::uuid, 'zernio',
        ${`stale-publisher-${stalePublisherReviewId}`},
        ${`zernio://terminal/reviews/${stalePublisherReviewId}`},
        'zernio://terminal/locations/1', 'Stale Publisher Reviewer', 4, 'Pretty good', 'responded'
      ),
      (
        ${staleOrphanReviewId}::uuid, ${businessId}::uuid, 'zernio',
        ${`stale-orphan-${staleOrphanReviewId}`},
        ${`zernio://terminal/reviews/${staleOrphanReviewId}`},
        'zernio://terminal/locations/1', 'Stale Orphan Reviewer', 4, 'Pretty good', 'responded'
      )
    `;
    await db`
      INSERT INTO responses (
        id, review_id, business_id, response_text, original_draft_text,
        response_language, status, approval_method, approved_at, approved_text
      ) VALUES
      (
        ${responseId}::uuid, ${publisherReviewId}::uuid, ${businessId}::uuid,
        'Thanks for the review', 'Thanks for the review', 'en',
        'approved', 'owner', NOW(), 'Thanks for the review'
      ),
      (
        ${stalePublisherResponseId}::uuid, ${stalePublisherReviewId}::uuid, ${businessId}::uuid,
        'Thanks for the review', 'Thanks for the review', 'en',
        'approved', 'owner', NOW(), 'Thanks for the review'
      ),
      (
        ${staleOrphanResponseId}::uuid, ${staleOrphanReviewId}::uuid, ${businessId}::uuid,
        'Thanks for the review', 'Thanks for the review', 'en',
        'approved', 'owner', NOW(), 'Thanks for the review'
      )
    `;
    await db`
      UPDATE responses
      SET posting_error = 'pending_after_delete_succeeded'
      WHERE id = ${staleOrphanResponseId}::uuid
    `;
    await db`
      INSERT INTO job_outbox (
        id, topic, aggregate_type, aggregate_id, payload, status, attempts, max_attempts
      ) VALUES
      (
        ${generationOutboxId}::uuid, 'generate_response', 'review', ${generationReviewId},
        ${db.json({ review_id: generationReviewId, business_id: businessId, version: 1 })},
        'dispatched', 1, 3
      ),
      (
        ${publisherOutboxId}::uuid, 'publish_response', 'response', ${responseId},
        ${db.json({ response_id: responseId, business_id: businessId })},
        'dispatched', 1, 3
      ),
      (
        ${staleGenerationOutboxId}::uuid, 'generate_response', 'review', ${staleGenerationReviewId},
        ${db.json({ review_id: staleGenerationReviewId, business_id: businessId, version: 1 })},
        'dispatched', 2, 3
      ),
      (
        ${stalePublisherOutboxId}::uuid, 'publish_response', 'response', ${stalePublisherResponseId},
        ${db.json({ response_id: stalePublisherResponseId, business_id: businessId })},
        'dispatched', 2, 3
      ),
      (
        ${staleOrphanOutboxId}::uuid, 'publish_response', 'response', ${staleOrphanResponseId},
        ${db.json({ response_id: staleOrphanResponseId, business_id: businessId })},
        'dispatched', 2, 3
      )
    `;
  });

  afterAll(async () => {
    if (!db) return;
    if (tenant) {
      await sql()`DELETE FROM job_outbox WHERE id IN (
        ${generationOutboxId}::uuid, ${publisherOutboxId}::uuid,
        ${staleGenerationOutboxId}::uuid, ${stalePublisherOutboxId}::uuid,
        ${staleOrphanOutboxId}::uuid
      )`;
      await sql()`DELETE FROM responses WHERE id IN (
        ${responseId}::uuid, ${stalePublisherResponseId}::uuid, ${staleOrphanResponseId}::uuid
      )`;
      await sql()`DELETE FROM agent_runs WHERE account_id = ${tenant.accountId}::uuid`;
      await sql()`DELETE FROM reviews WHERE id IN (
        ${generationReviewId}::uuid, ${publisherReviewId}::uuid,
        ${staleGenerationReviewId}::uuid, ${stalePublisherReviewId}::uuid,
        ${staleOrphanReviewId}::uuid
      )`;
      await sql()`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
      await cleanupTenantAccount(sql(), tenant);
    }
    await db.end({ timeout: 5 });
  });

  it('generation terminal checkpoint is atomic and replay-idempotent', async () => {
    const runId = await seedRun(generationReviewId);
    const input = {
      reviewId: generationReviewId,
      businessId,
      outboxId: generationOutboxId,
      outboxAttempt: 1,
      reason: 'generation_terminal_test',
    };

    await checkpointTerminalGeneration(sql(), input);
    await checkpointTerminalGeneration(sql(), input);

    const [run] = await sql()<{
      status: string;
      ended_at: Date | null;
      error_reason: string | null;
    }[]>`
      SELECT status, ended_at, error->>'reason' AS error_reason
      FROM agent_runs WHERE id = ${runId}
    `;
    const [outbox] = await sql()<{
      status: string;
      last_error: string | null;
    }[]>`SELECT status, last_error FROM job_outbox WHERE id = ${generationOutboxId}::uuid`;
    expect(run!.status).toBe('failed');
    expect(run!.ended_at).not.toBeNull();
    expect(run!.error_reason).toBe('generation_terminal_test');
    expect(outbox).toEqual({ status: 'failed', last_error: 'generation_terminal_test' });
    expect(await sql()<{ count: string }[]>`
      SELECT COUNT(*) AS count FROM agent_runs
      WHERE id = ${runId} AND status = 'failed' AND ended_at IS NOT NULL
    `).toEqual([{ count: '1' }]);
  });

  it('publisher terminal checkpoint is atomic and replay-idempotent', async () => {
    const runId = await seedRun(publisherReviewId);

    await checkpointTerminalPublisherFailure(
      sql(),
      { response_id: responseId, business_id: businessId },
      publisherOutboxId,
      'publisher_terminal_test',
      1,
    );
    await checkpointTerminalPublisherFailure(
      sql(),
      { response_id: responseId, business_id: businessId },
      publisherOutboxId,
      'publisher_terminal_test',
      1,
    );

    const [run] = await sql()<{
      status: string;
      ended_at: Date | null;
      error_reason: string | null;
    }[]>`
      SELECT status, ended_at, error->>'reason' AS error_reason
      FROM agent_runs WHERE id = ${runId}
    `;
    const [outbox] = await sql()<{
      status: string;
      last_error: string | null;
    }[]>`SELECT status, last_error FROM job_outbox WHERE id = ${publisherOutboxId}::uuid`;
    expect(run!.status).toBe('failed');
    expect(run!.ended_at).not.toBeNull();
    expect(run!.error_reason).toBe('publisher_terminal_test');
    expect(outbox).toEqual({ status: 'failed', last_error: 'publisher_terminal_test' });
    expect(await sql()<{ count: string }[]>`
      SELECT COUNT(*) AS count FROM agent_runs
      WHERE id = ${runId} AND status = 'failed' AND ended_at IS NOT NULL
    `).toEqual([{ count: '1' }]);
  });

  it('generation stale attempt leaves the newer outbox dispatch and active run unchanged', async () => {
    const runId = await seedRun(staleGenerationReviewId);

    await checkpointTerminalGeneration(sql(), {
      reviewId: staleGenerationReviewId,
      businessId,
      outboxId: staleGenerationOutboxId,
      outboxAttempt: 1,
      reason: 'stale_generation_terminal',
    });

    const [run] = await sql()<{ status: string; ended_at: Date | null }[]>`
      SELECT status, ended_at FROM agent_runs WHERE id = ${runId}
    `;
    const [outbox] = await sql()<{ status: string; attempts: number; last_error: string | null }[]>`
      SELECT status, attempts, last_error FROM job_outbox WHERE id = ${staleGenerationOutboxId}::uuid
    `;
    expect(run).toEqual({ status: 'running', ended_at: null });
    expect(outbox).toEqual({ status: 'dispatched', attempts: 2, last_error: null });
  });

  it('generic publisher stale attempt leaves the newer outbox dispatch and active run unchanged', async () => {
    const runId = await seedRun(stalePublisherReviewId);

    await checkpointTerminalPublisherFailure(
      sql(),
      { response_id: stalePublisherResponseId, business_id: businessId },
      stalePublisherOutboxId,
      'stale_publisher_terminal',
      1,
    );

    const [run] = await sql()<{ status: string; ended_at: Date | null }[]>`
      SELECT status, ended_at FROM agent_runs WHERE id = ${runId}
    `;
    const [outbox] = await sql()<{ status: string; attempts: number; last_error: string | null }[]>`
      SELECT status, attempts, last_error FROM job_outbox WHERE id = ${stalePublisherOutboxId}::uuid
    `;
    expect(run).toEqual({ status: 'running', ended_at: null });
    expect(outbox).toEqual({ status: 'dispatched', attempts: 2, last_error: null });
  });

  it('orphan stale attempt leaves response, newer outbox dispatch, and active run unchanged', async () => {
    const runId = await seedRun(staleOrphanReviewId);
    process.env.EDIT_REPLIES_ENABLED = 'true';
    try {
      const inner = new ZernioTransientError('timeout', { httpStatus: 504 });
      const err = new PublisherTransientWithContext(inner, {
        response_id: staleOrphanResponseId,
        business_id: businessId,
        account_id: tenant!.accountId,
        location_id: 'stale-orphan-location',
      });
      const job = {
        id: 'stale-orphan-job',
        data: {
          response_id: staleOrphanResponseId,
          business_id: businessId,
          outbox_id: staleOrphanOutboxId,
          outbox_attempt: 1,
        },
        attemptsMade: 1,
        opts: { attempts: 1 },
      } as unknown as Job<PublishResponsePayload>;

      await handlePublisherFailed(sql(), job, err);
    } finally {
      delete process.env.EDIT_REPLIES_ENABLED;
    }

    const [run] = await sql()<{ status: string; ended_at: Date | null }[]>`
      SELECT status, ended_at FROM agent_runs WHERE id = ${runId}
    `;
    const [response] = await sql()<{ status: string; posting_error: string | null }[]>`
      SELECT status, posting_error FROM responses WHERE id = ${staleOrphanResponseId}::uuid
    `;
    const [outbox] = await sql()<{ status: string; attempts: number; last_error: string | null }[]>`
      SELECT status, attempts, last_error FROM job_outbox WHERE id = ${staleOrphanOutboxId}::uuid
    `;
    expect(run).toEqual({ status: 'running', ended_at: null });
    expect(response).toEqual({ status: 'approved', posting_error: 'pending_after_delete_succeeded' });
    expect(outbox).toEqual({ status: 'dispatched', attempts: 2, last_error: null });
  });
});
