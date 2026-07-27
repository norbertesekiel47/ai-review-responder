// Live-Postgres coverage for the WS4 §2.8 owner-decision instrumentation
// (plan Task 10): approving a seeded pending response whose review has a
// RUNNING review_handler run must land exactly one 'reply_approved_no_edit'
// agent_outcomes row attributed 'reply' — and re-driving the emitter must be
// absorbed by the agent_outcomes_once_per_run_kind partial unique index
// (the unit suite pins the ON CONFLICT text; this proves the absorption).
//
// Gated on TEST_DATABASE_POOL_URL (skips cleanly without one). Migration 071
// is applied idempotently in beforeAll (veto.integration precedent).

import { afterAll, beforeAll, expect, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { randomUUID } from 'node:crypto';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  cleanupTenantAccount,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import {
  assertSchemaReady,
  MIGRATION_071_RUN_SPINE,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import { startOrGetActiveRun } from '@/lib/agents/run-spine';
import { approveBySession } from '../session-mode';
import { anchorReviewLockOrder, recordOwnerDecisionOutcome } from '../outcomes';

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

let db: postgresType.Sql | undefined;
let tenant: TenantSeed | undefined;
let runId: string | undefined;

const businessId = randomUUID();
const reviewId = randomUUID();
const responseId = randomUUID();

function sql(): postgresType.Sql {
  if (!db) throw new Error('owner-decision outcomes integration database was not initialized');
  return db;
}

describeWithDb('owner-decision outcomes against live Postgres (WS4 §2.8)', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    db = postgres(testDatabaseUrl!, { max: 2, prepare: false });
    await assertSchemaReady(db, [MIGRATION_071_RUN_SPINE]);
    tenant = await seedTenantAccount(db, {
      userName: 'Outcome Instrumentation Owner',
      accountDisplayName: 'Outcome Instrumentation Account',
    });
    await db`
      INSERT INTO businesses (id, name, owner_name, owner_email, account_id, subscription_status)
      VALUES (${businessId}::uuid, 'Outcome Instrumentation Biz', 'Outcome Instrumentation Owner', ${tenant.ownerEmail}, ${tenant.accountId}::uuid, 'active')
    `;
    await db`
      INSERT INTO reviews (id, business_id, provider, provider_review_id, provider_review_name, provider_location_name, reviewer_name, star_rating, review_text, status)
      VALUES (${reviewId}::uuid, ${businessId}::uuid, 'zernio', ${`outcome-int-${reviewId}`}, ${`zernio://outcome-int/reviews/${reviewId}`}, 'zernio://outcome-int/locations/1', 'Reviewer', 5, 'Wonderful service', 'pending')
    `;
    await db`
      INSERT INTO responses (id, review_id, business_id, response_text, original_draft_text, response_language, status)
      VALUES (${responseId}::uuid, ${reviewId}::uuid, ${businessId}::uuid, 'Thanks for visiting!', 'Thanks for visiting!', 'en', 'pending_approval')
    `;
    await db.begin(async (tx) => {
      // Lock-ordering contract: review row FOR UPDATE first.
      await tx`SELECT id FROM reviews WHERE id = ${reviewId}::uuid FOR UPDATE`;
      const started = await startOrGetActiveRun(tx, {
        kind: 'review_handler',
        subjectType: 'review',
        subjectId: reviewId,
        accountId: tenant!.accountId,
        businessId,
      });
      runId = started.runId;
    });
  });

  afterAll(async () => {
    if (!db) return;
    if (tenant) {
      await sql()`DELETE FROM agent_outcomes WHERE account_id = ${tenant.accountId}::uuid`;
      await sql()`DELETE FROM agent_run_steps WHERE agent_run_id IN (SELECT id FROM agent_runs WHERE account_id = ${tenant.accountId}::uuid)`;
      await sql()`DELETE FROM agent_runs WHERE account_id = ${tenant.accountId}::uuid`;
      await sql()`DELETE FROM approval_audit_log WHERE response_id = ${responseId}::uuid`;
      await sql()`DELETE FROM job_outbox WHERE aggregate_id = ${responseId}`;
      await sql()`DELETE FROM responses WHERE id = ${responseId}::uuid`;
      await sql()`DELETE FROM reviews WHERE id = ${reviewId}::uuid`;
      await sql()`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
      await cleanupTenantAccount(sql(), tenant);
    }
    await db.end({ timeout: 5 });
  });

  it("approveBySession lands exactly one 'reply_approved_no_edit' outcome on the running run", async () => {
    await sql().begin((tx) =>
      approveBySession(tx, responseId, businessId, {
        actorUserId: tenant!.userId,
        ipAddress: null,
      }),
    );

    const [resp] = await sql()<{ status: string; approval_method: string | null }[]>`
      SELECT status, approval_method FROM responses WHERE id = ${responseId}::uuid
    `;
    expect(resp).toMatchObject({ status: 'approved', approval_method: 'owner' });

    const outcomes = await sql()<{
      agent_run_id: string; attributed_agent: string; business_id: string;
    }[]>`
      SELECT agent_run_id, attributed_agent, business_id
      FROM agent_outcomes
      WHERE account_id = ${tenant!.accountId}::uuid
        AND outcome_kind = 'reply_approved_no_edit'
    `;
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      agent_run_id: runId,
      attributed_agent: 'reply',
      business_id: businessId,
    });
  });

  it('re-driving the emitter for the same (run, kind) is absorbed by the partial unique index', async () => {
    await sql().begin(async (tx) => {
      await anchorReviewLockOrder(tx, responseId, businessId);
      await recordOwnerDecisionOutcome(tx, {
        reviewId,
        businessId,
        outcomeKind: 'reply_approved_no_edit',
      });
    });

    const [count] = await sql()<{ n: string }[]>`
      SELECT COUNT(*) AS n FROM agent_outcomes
      WHERE agent_run_id = ${runId!}::uuid
        AND outcome_kind = 'reply_approved_no_edit'
    `;
    expect(Number(count!.n)).toBe(1);
  });
});
