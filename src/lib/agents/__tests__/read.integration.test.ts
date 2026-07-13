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
import { getAgentTeamSummary, getReviewTimeline } from '../read';
import {
  completeRun,
  recordOutcome,
  recordStep,
  startOrGetActiveRun,
} from '../run-spine';

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

let db: postgresType.Sql | undefined;
let tenant: TenantSeed | undefined;
const businessId = randomUUID();
const otherBusinessId = randomUUID();
const reviewId = randomUUID();
const legacyReviewId = randomUUID();
const olderResponseId = randomUUID();
const responseId = randomUUID();
const escalationId = randomUUID();
const resolvedEscalationId = randomUUID();
let olderRunId = '';
let latestRunId = '';

function sql(): postgresType.Sql {
  if (!db) throw new Error('agent read integration database was not initialized');
  return db;
}

function accountId(): string {
  if (!tenant) throw new Error('agent read integration tenant was not seeded');
  return tenant.accountId;
}

async function lockReview(tx: postgresType.TransactionSql): Promise<void> {
  await tx`SELECT id FROM reviews WHERE id = ${reviewId}::uuid FOR UPDATE`;
}

describeWithDb('agent spine reads against live Postgres', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    db = postgres(testDatabaseUrl!, { max: 1, prepare: false });
    tenant = await seedTenantAccount(db, {
      userName: 'Agent Read Owner',
      accountDisplayName: 'Agent Read Account',
    });

    await sql()`
      INSERT INTO businesses (
        id, name, owner_name, owner_email, account_id, subscription_status
      ) VALUES
        (${businessId}::uuid, 'Agent Read Primary', 'Agent Read Owner', ${tenant.ownerEmail}, ${tenant.accountId}::uuid, 'active'),
        (${otherBusinessId}::uuid, 'Agent Read Other', 'Agent Read Owner', ${tenant.ownerEmail}, ${tenant.accountId}::uuid, 'active')
    `;
    await sql()`
      INSERT INTO reviews (
        id, business_id, provider, provider_review_id, provider_review_name,
        provider_location_name, reviewer_name, star_rating, review_text,
        review_date, status
      ) VALUES
        (
          ${reviewId}::uuid, ${businessId}::uuid, 'zernio', ${`agent-read-${reviewId}`},
          ${`zernio://agent-read/reviews/${reviewId}`}, 'zernio://agent-read/locations/1',
          'Timeline Reviewer', 5, 'A timeline fixture review.',
          '2026-07-10T09:30:00.000Z'::timestamptz, 'approved'
        ),
        (
          ${legacyReviewId}::uuid, ${businessId}::uuid, 'zernio', ${`agent-read-${legacyReviewId}`},
          ${`zernio://agent-read/reviews/${legacyReviewId}`}, 'zernio://agent-read/locations/1',
          'Legacy Reviewer', 4, 'A legacy fixture review.',
          '2026-07-09T09:30:00.000Z'::timestamptz, 'pending_approval'
        )
    `;
    await sql()`
      INSERT INTO responses (
        id, review_id, business_id, response_text, original_draft_text,
        version, status, approval_method, approved_at, auto_post_scheduled_at,
        posted_at
      ) VALUES
        (
          ${olderResponseId}::uuid, ${reviewId}::uuid, ${businessId}::uuid,
          'Older posted response.', 'Older posted response.',
          1, 'posted', 'owner', '2026-07-10T10:00:00.000Z'::timestamptz,
          NULL, '2026-07-10T10:05:00.000Z'::timestamptz
        ),
        (
          ${responseId}::uuid, ${reviewId}::uuid, ${businessId}::uuid,
          'New scheduled response.', 'New scheduled response.',
          2, 'approved', 'auto_policy', NOW(),
          '2030-01-01T12:00:00.000Z'::timestamptz, NULL
        )
    `;

    await sql().begin(async (tx) => {
      await lockReview(tx);
      const started = await startOrGetActiveRun(tx, {
        kind: 'review_handler',
        subjectType: 'review',
        subjectId: reviewId,
        accountId: accountId(),
        businessId,
        correlationId: 'agent-read-older',
      });
      olderRunId = started.runId;
      await recordStep(tx, {
        runId: olderRunId,
        stepKey: 'triage',
        detail: { severity: 'high' },
      });
      await recordOutcome(tx, {
        runId: olderRunId,
        accountId: accountId(),
        businessId,
        attributedAgent: 'guardian',
        outcomeKind: 'review_escalated',
      });
      await completeRun(tx, olderRunId, 'failed', { reason: 'provider_terminal' });
    });
    await sql()`
      UPDATE agent_runs
      SET started_at = '2026-07-10T09:31:00.000Z'::timestamptz
      WHERE id = ${olderRunId}::uuid
    `;

    await sql().begin(async (tx) => {
      await lockReview(tx);
      const started = await startOrGetActiveRun(tx, {
        kind: 'review_handler',
        subjectType: 'review',
        subjectId: reviewId,
        accountId: accountId(),
        businessId,
        correlationId: 'agent-read-latest',
      });
      latestRunId = started.runId;
      await recordStep(tx, {
        runId: latestRunId,
        stepKey: 'review_ingested',
        detail: { source: 'zernio' },
      });
      await recordStep(tx, {
        runId: latestRunId,
        stepKey: 'draft_generated',
        detail: { response_id: responseId, version: 1 },
        latencyMs: 42,
      });
      await recordStep(tx, {
        runId: latestRunId,
        stepKey: 'moderation_checked',
        detail: { severity: 'none' },
      });
      await recordOutcome(tx, {
        runId: latestRunId,
        accountId: accountId(),
        businessId,
        attributedAgent: 'reply',
        outcomeKind: 'reply_posted',
      });
      await recordOutcome(tx, {
        runId: latestRunId,
        accountId: accountId(),
        businessId,
        attributedAgent: 'reply',
        outcomeKind: 'reply_auto_posted',
      });
    });

    await sql()`
      INSERT INTO review_escalations (
        id, account_id, business_id, review_id, agent_run_id, status,
        triage_severity, triage_source, triage_suggested_action,
        escalated_at, acknowledged_at, resolved_at, created_at, updated_at
      ) VALUES
        (
          ${escalationId}::uuid, ${tenant.accountId}::uuid, ${businessId}::uuid,
          ${reviewId}::uuid, ${latestRunId}::uuid, 'escalated', 'high',
          'mock_v1', 'respond_and_escalate',
          '2026-07-10T09:32:00.000Z'::timestamptz, NULL, NULL,
          '2026-07-10T09:32:00.000Z'::timestamptz,
          '2026-07-10T09:32:00.000Z'::timestamptz
        ),
        (
          ${resolvedEscalationId}::uuid, ${tenant.accountId}::uuid, ${businessId}::uuid,
          ${reviewId}::uuid, ${olderRunId}::uuid, 'resolved', 'medium',
          'mock_v1', 'escalate',
          '2026-07-11T09:32:00.000Z'::timestamptz,
          '2026-07-11T09:34:00.000Z'::timestamptz,
          '2026-07-11T09:36:00.000Z'::timestamptz,
          '2026-07-11T09:32:00.000Z'::timestamptz,
          '2026-07-11T09:36:00.000Z'::timestamptz
        )
    `;

    await sql().begin(async (tx) => {
      const { runId } = await startOrGetActiveRun(tx, {
        kind: 'weekly_insights',
        subjectType: 'account_week',
        subjectId: `${accountId()}_2026-07-06`,
        accountId: accountId(),
        businessId: otherBusinessId,
        correlationId: 'agent-read-insights',
      });
      await recordOutcome(tx, {
        runId,
        accountId: accountId(),
        businessId: otherBusinessId,
        attributedAgent: 'insights',
        outcomeKind: 'digest_sent',
      });
      await completeRun(tx, runId, 'completed');
    });
  });

  afterAll(async () => {
    if (!db) return;
    if (tenant) {
      await sql()`DELETE FROM review_escalations WHERE account_id = ${tenant.accountId}::uuid`;
      await sql()`DELETE FROM responses WHERE business_id IN (${businessId}::uuid, ${otherBusinessId}::uuid)`;
      await sql()`DELETE FROM agent_outcomes WHERE account_id = ${tenant.accountId}::uuid`;
      await sql()`DELETE FROM agent_runs WHERE account_id = ${tenant.accountId}::uuid`;
      await sql()`DELETE FROM reviews WHERE business_id IN (${businessId}::uuid, ${otherBusinessId}::uuid)`;
      await sql()`DELETE FROM businesses WHERE id IN (${businessId}::uuid, ${otherBusinessId}::uuid)`;
      await cleanupTenantAccount(sql(), tenant);
    }
    await db.end({ timeout: 5 });
  });

  it('round-trips the bounded timeline with ordered runs, steps, outcomes, and JSONB', async () => {
    const timeline = await getReviewTimeline(sql(), { accountId: accountId(), reviewId });

    expect(timeline?.review).toMatchObject({
      id: reviewId,
      rating: 5,
      reviewerName: 'Timeline Reviewer',
    });
    expect(timeline?.response).toMatchObject({
      id: responseId,
      status: 'approved',
      approvalMethod: 'auto_policy',
      autoPostScheduledAt: '2030-01-01T12:00:00.000Z',
      responseText: 'New scheduled response.',
      version: 2,
    });
    expect(timeline?.escalation).toMatchObject({
      id: escalationId,
      status: 'escalated',
      severity: 'high',
      createdAt: '2026-07-10T09:32:00.000Z',
    });
    expect(timeline?.runs.map((run) => run.id)).toEqual([latestRunId, olderRunId]);
    expect(timeline?.runs[0]).toMatchObject({
      displayState: 'in_progress',
      steps: [
        expect.objectContaining({ stepIndex: 1, detail: { source: 'zernio' } }),
        expect.objectContaining({
          stepIndex: 2,
          detail: { response_id: responseId, version: 1 },
        }),
        expect.objectContaining({ stepIndex: 3, detail: { severity: 'none' } }),
      ],
      outcomes: [
        expect.objectContaining({ outcomeKind: 'reply_posted', attributedAgent: 'reply' }),
        expect.objectContaining({ outcomeKind: 'reply_auto_posted', attributedAgent: 'reply' }),
      ],
    });
    expect(timeline?.runs[1]).toMatchObject({
      displayState: 'failed',
      error: { reason: 'provider_terminal' },
    });
  });

  it('reads a pushed auto-post deadline live on every request', async () => {
    await sql()`
      UPDATE responses
      SET auto_post_scheduled_at = '2030-01-01T12:30:00.000Z'::timestamptz
      WHERE id = ${responseId}::uuid
    `;

    const timeline = await getReviewTimeline(sql(), { accountId: accountId(), reviewId });
    expect(timeline?.response?.autoPostScheduledAt).toBe('2030-01-01T12:30:00.000Z');
  });

  it('returns a legacy empty timeline and rejects an out-of-scope account', async () => {
    const legacy = await getReviewTimeline(sql(), {
      accountId: accountId(),
      reviewId: legacyReviewId,
    });
    expect(legacy).not.toBeNull();
    expect(legacy?.runs).toEqual([]);

    await expect(
      getReviewTimeline(sql(), { accountId: randomUUID(), reviewId }),
    ).resolves.toBeNull();
  });

  it('aggregates the team by account and filters it by location', async () => {
    await expect(
      getAgentTeamSummary(sql(), { kind: 'account', accountId: accountId() }, '30d'),
    ).resolves.toEqual({ reply: 2, guardian: 1, insights: 1 });

    await expect(
      getAgentTeamSummary(
        sql(),
        { kind: 'location', accountId: accountId(), businessId },
        '30d',
      ),
    ).resolves.toEqual({ reply: 2, guardian: 1, insights: 0 });
  });
});
