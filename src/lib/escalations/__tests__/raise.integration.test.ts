// Real-schema behavioral suite for the WS3 escalation raise (spec §2.2): the
// unit suite only asserts SQL *text*; this drives the production persistTriage
// → raiseEscalation path against live Postgres so the ON CONFLICT arbiter of
// review_escalations_one_open_per_review and the escalation_notice in-flight
// outbox dedup (migration 073) execute for real.
//
// Gated on TEST_DATABASE_POOL_URL (skips cleanly without one). Migrations
// 071/072/073 are applied in beforeAll — all three are fully idempotent, so
// this becomes a no-op once they ship to the shared test DB.

import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  cleanupTenantAccount,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import { TRIAGE_SOURCE } from '@/lib/reviews/triage-schema';
import { persistTriage, type TriageClassification } from '@/lib/reviews/triage';
import { startOrGetActiveRun } from '@/lib/agents/run-spine';

// The raise gate is ESCALATION_ENABLED (default off) — force it on so the
// real persistTriage → raiseEscalation path runs.
vi.mock('@/lib/escalations/flags', () => ({ escalationEnabled: () => true }));

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

let db: postgresType.Sql | undefined;
let tenant: TenantSeed | undefined;
const businessId = randomUUID();
const reviewId = randomUUID();
// Second review for the seeded-RUNNING-run lane (the first review exercises
// the legacy run-less lane and its dedup, so it can't be reused here).
const runReviewId = randomUUID();

function sql(): postgresType.Sql {
  if (!db) throw new Error('escalation-raise integration database was not initialized');
  return db;
}

function accountId(): string {
  if (!tenant) throw new Error('escalation-raise integration tenant was not seeded');
  return tenant.accountId;
}

const escalatingClassification: TriageClassification = {
  output: { severity: 'high', issues: ['staff_conduct'], suggested_action: 'escalate' },
  source: TRIAGE_SOURCE.LLM,
  model: 'gpt-4o-mini-2024-07-18',
  latencyMs: 500,
};

async function runPersistTriage(forReviewId: string = reviewId): Promise<void> {
  await sql().begin((tx) =>
    persistTriage(tx, {
      reviewId: forReviewId,
      businessId,
      accountId: accountId(),
      classification: escalatingClassification,
      contentHash: 'hash-1',
      correlationId: `esc-int-${forReviewId}`,
    }),
  );
}

async function openEscalations(): Promise<{ id: string; status: string }[]> {
  return sql()<{ id: string; status: string }[]>`
    SELECT id, status FROM review_escalations
    WHERE review_id = ${reviewId}::uuid AND status <> 'resolved'
    ORDER BY created_at
  `;
}

async function noticeOutboxRows(): Promise<{ aggregate_id: string; status: string }[]> {
  return sql()<{ aggregate_id: string; status: string }[]>`
    SELECT aggregate_id, status FROM job_outbox
    WHERE topic = 'escalation_notice'
      AND aggregate_id IN (SELECT id FROM review_escalations WHERE review_id = ${reviewId}::uuid)
    ORDER BY created_at
  `;
}

describeWithDb('raiseEscalation via persistTriage against live Postgres', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    db = postgres(testDatabaseUrl!, { max: 1, prepare: false });
    for (const migration of [
      '071_agent_run_spine.sql',
      '072_review_triage.sql',
      '073_review_escalations.sql',
    ]) {
      await db.unsafe(readFileSync(resolve(process.cwd(), 'supabase/migrations', migration), 'utf-8'));
    }
    tenant = await seedTenantAccount(db, {
      userName: 'Escalation Raise Owner',
      accountDisplayName: 'Escalation Raise Account',
    });
    await db`
      INSERT INTO businesses (id, name, owner_name, owner_email, account_id, subscription_status)
      VALUES (${businessId}::uuid, 'Escalation Raise Biz', 'Escalation Raise Owner', ${tenant.ownerEmail}, ${tenant.accountId}::uuid, 'active')
    `;
    await db`
      INSERT INTO reviews (id, business_id, provider, provider_review_id, provider_review_name, provider_location_name, reviewer_name, star_rating, review_text, status)
      VALUES (${reviewId}::uuid, ${businessId}::uuid, 'zernio', ${`esc-${reviewId}`}, ${`zernio://esc/reviews/${reviewId}`}, 'zernio://esc/locations/1', 'Reviewer', 1, 'The manager screamed at us.', 'pending')
    `;
    await db`
      INSERT INTO reviews (id, business_id, provider, provider_review_id, provider_review_name, provider_location_name, reviewer_name, star_rating, review_text, status)
      VALUES (${runReviewId}::uuid, ${businessId}::uuid, 'zernio', ${`esc-${runReviewId}`}, ${`zernio://esc/reviews/${runReviewId}`}, 'zernio://esc/locations/1', 'Run Reviewer', 1, 'Health inspector needs to see this place.', 'pending')
    `;
  });

  afterAll(async () => {
    if (!db) return;
    if (tenant) {
      await sql()`
        DELETE FROM job_outbox
        WHERE topic = 'escalation_notice'
          AND aggregate_id IN (
            SELECT id FROM review_escalations
            WHERE review_id IN (${reviewId}::uuid, ${runReviewId}::uuid)
          )
      `;
      await sql()`DELETE FROM review_escalations WHERE review_id IN (${reviewId}::uuid, ${runReviewId}::uuid)`;
      await sql()`
        DELETE FROM agent_outcomes
        WHERE agent_run_id IN (
          SELECT id FROM agent_runs
          WHERE kind = 'review_handler' AND subject_type = 'review' AND subject_id = ${runReviewId}
        )
      `;
      await sql()`
        DELETE FROM agent_run_steps
        WHERE agent_run_id IN (
          SELECT id FROM agent_runs
          WHERE kind = 'review_handler' AND subject_type = 'review' AND subject_id = ${runReviewId}
        )
      `;
      await sql()`
        DELETE FROM agent_runs
        WHERE kind = 'review_handler' AND subject_type = 'review' AND subject_id = ${runReviewId}
      `;
      await sql()`DELETE FROM reviews WHERE id IN (${reviewId}::uuid, ${runReviewId}::uuid)`;
      await sql()`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
      await cleanupTenantAccount(sql(), tenant);
    }
    await db.end({ timeout: 5 });
  });

  it('persists the escalation row (snapshot columns) and enqueues one escalation_notice', async () => {
    await runPersistTriage();

    const [escalation] = await sql()<
      {
        id: string;
        account_id: string;
        business_id: string;
        status: string;
        agent_run_id: string | null;
        triage_severity: string;
        triage_source: string;
        triage_suggested_action: string;
        triage_issues: string[] | null;
      }[]
    >`
      SELECT id, account_id, business_id, status, agent_run_id,
             triage_severity, triage_source, triage_suggested_action, triage_issues
      FROM review_escalations WHERE review_id = ${reviewId}::uuid
    `;
    expect(escalation).toBeDefined();
    expect(escalation!.account_id).toBe(accountId());
    expect(escalation!.business_id).toBe(businessId);
    expect(escalation!.status).toBe('escalated');
    // No agent_runs row was seeded — the legacy (run-less) lane still raises.
    expect(escalation!.agent_run_id).toBeNull();
    expect(escalation!.triage_severity).toBe('high');
    expect(escalation!.triage_source).toBe(TRIAGE_SOURCE.LLM);
    expect(escalation!.triage_suggested_action).toBe('escalate');
    expect(escalation!.triage_issues).toEqual(['staff_conduct']);

    const outbox = await noticeOutboxRows();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.aggregate_id).toBe(escalation!.id);
    expect(outbox[0]!.status).toBe('pending');
  });

  it('re-triage is absorbed: still exactly ONE open escalation and ONE in-flight notice', async () => {
    await runPersistTriage();

    expect(await openEscalations()).toHaveLength(1);
    expect(await noticeOutboxRows()).toHaveLength(1);
  });

  it('after the escalation resolves, a new raise creates a SECOND escalation row', async () => {
    await sql()`
      UPDATE review_escalations
      SET status = 'resolved', acknowledged_at = NOW(), resolved_at = NOW(), updated_at = NOW()
      WHERE review_id = ${reviewId}::uuid
    `;

    await runPersistTriage();

    const all = await sql()<{ status: string }[]>`
      SELECT status FROM review_escalations WHERE review_id = ${reviewId}::uuid ORDER BY created_at
    `;
    expect(all).toHaveLength(2);
    expect(all.map((row) => row.status).sort()).toEqual(['escalated', 'resolved']);
    // The second raise enqueues its own notice (different aggregate_id).
    expect(await noticeOutboxRows()).toHaveLength(2);
  });

  it('with a RUNNING review_handler run, the raise links the run and records outcome + step', async () => {
    const { runId } = await sql().begin((tx) =>
      startOrGetActiveRun(tx, {
        kind: 'review_handler',
        subjectType: 'review',
        subjectId: runReviewId,
        accountId: accountId(),
        businessId,
      }),
    );

    await runPersistTriage(runReviewId);

    const [escalation] = await sql()<{ id: string; agent_run_id: string | null }[]>`
      SELECT id, agent_run_id FROM review_escalations WHERE review_id = ${runReviewId}::uuid
    `;
    expect(escalation).toBeDefined();
    expect(escalation!.agent_run_id).toBe(runId);

    const outcomes = await sql()<{ attributed_agent: string; outcome_kind: string }[]>`
      SELECT attributed_agent, outcome_kind FROM agent_outcomes
      WHERE agent_run_id = ${runId} AND outcome_kind = 'review_escalated'
    `;
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.attributed_agent).toBe('guardian');

    const steps = await sql()<{ step_key: string; status: string }[]>`
      SELECT step_key, status FROM agent_run_steps
      WHERE agent_run_id = ${runId} AND step_key = 'escalation_raised'
    `;
    expect(steps).toHaveLength(1);
    expect(steps[0]!.status).toBe('completed');
  });
});
