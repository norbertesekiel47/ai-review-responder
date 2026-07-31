import { afterAll, beforeAll, expect, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { randomUUID } from 'node:crypto';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  acquireLiveDbLock,
  assertLocalTestDatabaseUrl,
  LIVE_DB_LOCK_HOOK_TIMEOUT_MS,
  resolveTestDatabaseUrl,
  type LiveDbLock,
} from '@/lib/shared/__tests__/helpers/live-db-lock';
import {
  cleanupTenantAccount,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import {
  assertSchemaReady,
  MIGRATION_071_RUN_SPINE,
  MIGRATION_088_SOLICITATION_BATCH_EXECUTOR,
  MIGRATION_091_SEND_MODE_SPINE_LIFECYCLE,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import {
  checksum,
  insertOutreach,
} from '@/lib/shared/__tests__/helpers/outreach-fixture';
import {
  completeRun,
  recordCompletedChildRuns,
  recordGenerationSteps,
  recordOutcome,
  recordStep,
  startOrGetActiveRun,
  startOrGetSolicitationSendBatchRun,
} from '../run-spine';
import { commitWeeklyInsightsDigest } from '../../../../worker/jobs/WeeklySummaryWorker';

// Real-schema behavioral suite for the run-spine writers. The unit suite only
// asserts SQL *text*, and SQL-text tests have shipped broken SQL before
// (staging dry-run defect D3 — see approval-audit-log-scrub.integration.test.ts).
// This drives the production writers against live Postgres: ON CONFLICT
// arbiter recognition, the post-lock step-index serialization, outcome replay
// dedup, and the terminal-transition semantics all execute for real.
//
// Gated on TEST_DATABASE_POOL_URL (skips cleanly without one), like the repo's
// other integration tests. Those expect all migrations already applied — but
// migration 071 is born on this branch, so no shared test DB can have it yet;
// beforeAll applies the (fully idempotent) migration file, which becomes a
// no-op everywhere once 071 ships.
const testDatabaseUrl = resolveTestDatabaseUrl();

// max: 2 — the concurrency tests intentionally run two transactions at once.
let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;
let tenant: TenantSeed | undefined;
const solicitationBusinessId = randomUUID();

function sql(): postgresType.Sql {
  if (!db) throw new Error('run-spine integration database was not initialized');
  return db;
}

function accountId(): string {
  if (!tenant) throw new Error('run-spine integration tenant was not seeded');
  return tenant.accountId;
}

function startInput(subjectId: string) {
  return {
    kind: 'review_handler',
    subjectType: 'review',
    subjectId,
    accountId: accountId(),
    businessId: null,
  } as const;
}

async function startRun(subjectId: string): Promise<string> {
  const { runId } = await sql().begin((tx) => startOrGetActiveRun(tx, startInput(subjectId)));
  return runId;
}

describeWithDb(
  'run-spine writers against live Postgres',
  { enabled: Boolean(testDatabaseUrl), timeout: 30_000 },
  () => {
  beforeAll(async () => {
    const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
    featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
    db = postgres(databaseUrl, { max: 2, prepare: false });
    await assertSchemaReady(db, [
      MIGRATION_071_RUN_SPINE,
      MIGRATION_088_SOLICITATION_BATCH_EXECUTOR,
      MIGRATION_091_SEND_MODE_SPINE_LIFECYCLE,
    ]);
    tenant = await seedTenantAccount(db, {
      userName: 'Run Spine Owner',
      accountDisplayName: 'Run Spine Account',
    });
    await db`
      INSERT INTO businesses (
        id, name, owner_name, owner_email, account_id, subscription_status
      ) VALUES (
        ${solicitationBusinessId}::uuid,
        'Solicitation Run Spine',
        'Run Spine Owner',
        ${tenant.ownerEmail},
        ${tenant.accountId}::uuid,
        'active'
      )
    `;
  }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    try {
      if (db && tenant) {
        await sql()`DELETE FROM agent_outcomes WHERE account_id = ${tenant.accountId}::uuid`;
        // agent_run_steps cascade with their runs.
        await sql()`DELETE FROM agent_runs WHERE account_id = ${tenant.accountId}::uuid`;
        await sql()`DELETE FROM businesses WHERE id = ${solicitationBusinessId}::uuid`;
        await cleanupTenantAccount(sql(), tenant);
      }
    } finally {
      try {
        if (db) await db.end({ timeout: 5 });
      } finally {
        await featureDatabaseLock?.release();
        featureDatabaseLock = undefined;
      }
    }
  }, 120_000);

  it('two concurrent startOrGetActiveRun calls converge on one run', async () => {
    const subjectId = randomUUID();
    const [first, second] = await Promise.all([
      sql().begin((tx) => startOrGetActiveRun(tx, startInput(subjectId))),
      sql().begin((tx) => startOrGetActiveRun(tx, startInput(subjectId))),
    ]);

    expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
    expect(first.runId).toBe(second.runId);

    const rows = await sql()<{ count: string }[]>`
      SELECT COUNT(*) AS count FROM agent_runs
      WHERE subject_type = 'review' AND subject_id = ${subjectId}
    `;
    expect(Number(rows[0]!.count)).toBe(1);
  });

  it('sequential and concurrent recordStep calls yield gapless unique step indexes', async () => {
    const runId = await startRun(randomUUID());
    const responseId = randomUUID();

    await sql().begin((tx) => recordStep(tx, { runId, stepKey: 'review_ingested' }));
    await sql().begin((tx) =>
      recordStep(tx, {
        runId,
        stepKey: 'draft_generated',
        detail: { response_id: responseId, version: 1 },
        latencyMs: 42,
      }),
    );
    await sql().begin((tx) => recordStep(tx, { runId, stepKey: 'moderation_checked' }));

    const sequential = await sql()<
      { step_index: number; step_key: string; attributed_agent: string; detail: unknown }[]
    >`
      SELECT step_index, step_key, attributed_agent, detail
      FROM agent_run_steps WHERE agent_run_id = ${runId} ORDER BY step_index
    `;
    expect(sequential.map((row) => row.step_index)).toEqual([1, 2, 3]);
    expect(sequential.map((row) => row.step_key)).toEqual([
      'review_ingested', 'draft_generated', 'moderation_checked',
    ]);
    expect(sequential.map((row) => row.attributed_agent)).toEqual(['system', 'reply', 'system']);
    const rawDetail = sequential[1]!.detail;
    const detail = typeof rawDetail === 'string' ? JSON.parse(rawDetail) : rawDetail;
    expect(detail).toEqual({ response_id: responseId, version: 1 });

    // Two appenders at once: the own-statement run-row lock must serialize
    // them onto distinct indexes instead of throwing 23505 (review Fix 1).
    await Promise.all([
      sql().begin((tx) => recordStep(tx, { runId, stepKey: 'policy_gate' })),
      sql().begin((tx) => recordStep(tx, { runId, stepKey: 'owner_notified' })),
    ]);

    const after = await sql()<{ step_index: number }[]>`
      SELECT step_index FROM agent_run_steps WHERE agent_run_id = ${runId} ORDER BY step_index
    `;
    expect(after.map((row) => row.step_index)).toEqual([1, 2, 3, 4, 5]);
  });

  it('accepts a non-UUID correlation id (poller/ingest lanes pass logging strings)', async () => {
    // Live callers pass free-form correlation strings — the poller lane passes
    // `zernio-poll:<review-uuid>` and the ingest lane passes the provider event
    // id (TEXT). correlation_id must be TEXT: a UUID column aborts the WHOLE
    // ingest transaction with 22P02 on these inputs.
    const subjectId = randomUUID();
    const correlationId = `zernio-poll:${randomUUID()}`;

    const { runId, created } = await sql().begin((tx) =>
      startOrGetActiveRun(tx, { ...startInput(subjectId), correlationId }),
    );
    expect(created).toBe(true);

    const [row] = await sql()<{ correlation_id: string | null }[]>`
      SELECT correlation_id FROM agent_runs WHERE id = ${runId}
    `;
    expect(row!.correlation_id).toBe(correlationId);
  });

  it('replayed recordOutcome for the same (run, kind) stays one row', async () => {
    const runId = await startRun(randomUUID());
    const outcome = {
      runId,
      accountId: accountId(),
      businessId: null,
      attributedAgent: 'reply',
      outcomeKind: 'reply_posted',
    } as const;

    await sql().begin((tx) => recordOutcome(tx, outcome));
    await sql().begin((tx) => recordOutcome(tx, outcome)); // BullMQ-retry replay

    const rows = await sql()<{ count: string }[]>`
      SELECT COUNT(*) AS count FROM agent_outcomes
      WHERE agent_run_id = ${runId} AND outcome_kind = 'reply_posted'
    `;
    expect(Number(rows[0]!.count)).toBe(1);
  });

  it('persists Solicitation parent linkage and completed children against migration 088', async () => {
    const batchId = randomUUID();
    const askId = randomUUID();
    const childRunId = randomUUID();

    const { runId: parentRunId } = await sql().begin((tx) =>
      startOrGetActiveRun(tx, {
        kind: 'solicitation_batch',
        subjectType: 'solicitation_batch',
        subjectId: batchId,
        accountId: accountId(),
        businessId: solicitationBusinessId,
      }),
    );

    await sql().begin((tx) =>
      recordCompletedChildRuns(tx, {
        accountId: accountId(),
        businessId: solicitationBusinessId,
        parentRunId,
        children: [{
          runId: childRunId,
          askId,
          decision: 'withhold',
          withheldReason: 'stale_visit',
        }],
      }),
    );

    const [child] = await sql()<{
      parent_run_id: string | null;
      kind: string;
      subject_type: string;
      subject_id: string;
      status: string;
      ended_at: Date | null;
    }[]>`
      SELECT parent_run_id, kind, subject_type, subject_id, status, ended_at
      FROM agent_runs
      WHERE id = ${childRunId}::uuid
    `;
    expect(child).toMatchObject({
      parent_run_id: parentRunId,
      kind: 'solicitation_ask',
      subject_type: 'solicitation_ask',
      subject_id: askId,
      status: 'completed',
    });
    expect(child?.ended_at).not.toBeNull();

    const steps = await sql()<{
      step_index: number;
      step_key: string;
      attributed_agent: string;
      detail: unknown;
    }[]>`
      SELECT step_index, step_key, attributed_agent, detail
      FROM agent_run_steps
      WHERE agent_run_id = ${childRunId}::uuid
    `;
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      step_index: 1,
      step_key: 'ask_evaluated',
      attributed_agent: 'solicitation',
    });
    const rawDetail = steps[0]!.detail;
    const detail = typeof rawDetail === 'string' ? JSON.parse(rawDetail) : rawDetail;
    expect(detail).toEqual({
      ask_id: askId,
      decision: 'withhold',
      withheld_reason: 'stale_visit',
    });
  });

  it('completeRun transitions once, no-ops on replay, throws on a missing run', async () => {
    const runId = await startRun(randomUUID());

    await sql().begin((tx) => completeRun(tx, runId, 'completed'));

    const [completed] = await sql()<
      { status: string; ended_at: Date | null; error: unknown }[]
    >`SELECT status, ended_at, error FROM agent_runs WHERE id = ${runId}`;
    // agent_runs_terminal_consistency: terminal status ⇔ ended_at stamped.
    expect(completed!.status).toBe('completed');
    expect(completed!.ended_at).not.toBeNull();
    expect(completed!.error).toBeNull();

    // Replay (even with a different status + error payload) is a no-op.
    await sql().begin((tx) => completeRun(tx, runId, 'failed', { reason: 'replay' }));
    const [afterReplay] = await sql()<{ status: string; error: unknown }[]>`
      SELECT status, error FROM agent_runs WHERE id = ${runId}
    `;
    expect(afterReplay!.status).toBe('completed');
    expect(afterReplay!.error).toBeNull();

    await expect(
      sql().begin((tx) => completeRun(tx, randomUUID(), 'completed')),
    ).rejects.toThrow(/run not found/i);
  });

  it('commits separate weekly_insights runs per business and replay adds no spine rows', async () => {
    const firstBusinessId = randomUUID();
    const secondBusinessId = randomUUID();
    const weekStartDate = '2026-07-06';
    const subjectId = `${accountId()}_${weekStartDate}`;

    await sql()`
      INSERT INTO businesses (
        id, name, owner_name, owner_email, account_id, subscription_status
      ) VALUES
      (
        ${firstBusinessId}::uuid, 'Weekly Insights One', 'Run Spine Owner',
        ${tenant!.ownerEmail}, ${accountId()}::uuid, 'active'
      ),
      (
        ${secondBusinessId}::uuid, 'Weekly Insights Two', 'Run Spine Owner',
        ${tenant!.ownerEmail}, ${accountId()}::uuid, 'active'
      )
    `;
    await sql()`
      INSERT INTO weekly_summaries (
        id, business_id, week_start_date, total_reviews, total_responded
      ) VALUES
      (${randomUUID()}::uuid, ${firstBusinessId}::uuid, ${weekStartDate}::date, 3, 2),
      (${randomUUID()}::uuid, ${secondBusinessId}::uuid, ${weekStartDate}::date, 5, 5)
    `;

    try {
      const committed = await Promise.all([
        commitWeeklyInsightsDigest(sql(), {
          accountId: accountId(),
          businessId: firstBusinessId,
          weekStartDate,
          correlationId: 'weekly:first',
        }),
        commitWeeklyInsightsDigest(sql(), {
          accountId: accountId(),
          businessId: secondBusinessId,
          weekStartDate,
          correlationId: 'weekly:second',
        }),
      ]);
      expect(committed).toEqual([true, true]);
      await expect(commitWeeklyInsightsDigest(sql(), {
        accountId: accountId(),
        businessId: firstBusinessId,
        weekStartDate,
        correlationId: 'weekly:first:replay',
      })).resolves.toBe(false);

      const runs = await sql()<{
        id: string;
        business_id: string;
        subject_id: string;
        status: string;
        ended_at: Date | null;
      }[]>`
        SELECT id, business_id, subject_id, status, ended_at
        FROM agent_runs
        WHERE account_id = ${accountId()}::uuid
          AND kind = 'weekly_insights'
          AND subject_type = 'account_week'
          AND subject_id = ${subjectId}
        ORDER BY business_id
      `;
      expect(runs).toHaveLength(2);
      expect(runs.map((row) => row.business_id).sort()).toEqual(
        [firstBusinessId, secondBusinessId].sort(),
      );
      expect(runs.every((row) => row.status === 'completed' && row.ended_at !== null)).toBe(true);

      const steps = await sql()<{
        attributed_agent: string;
        step_key: string;
        status: string;
      }[]>`
        SELECT s.attributed_agent, s.step_key, s.status
        FROM agent_run_steps s
        JOIN agent_runs r ON r.id = s.agent_run_id
        WHERE r.subject_id = ${subjectId}
        ORDER BY r.business_id
      `;
      expect(steps).toEqual([
        { attributed_agent: 'insights', step_key: 'digest_sent', status: 'completed' },
        { attributed_agent: 'insights', step_key: 'digest_sent', status: 'completed' },
      ]);

      const outcomes = await sql()<{
        attributed_agent: string;
        outcome_kind: string;
      }[]>`
        SELECT o.attributed_agent, o.outcome_kind
        FROM agent_outcomes o
        JOIN agent_runs r ON r.id = o.agent_run_id
        WHERE r.subject_id = ${subjectId}
        ORDER BY r.business_id
      `;
      expect(outcomes).toEqual([
        { attributed_agent: 'insights', outcome_kind: 'digest_sent' },
        { attributed_agent: 'insights', outcome_kind: 'digest_sent' },
      ]);

      const [sent] = await sql()<{ count: string }[]>`
        SELECT COUNT(*) AS count
        FROM weekly_summaries
        WHERE business_id IN (${firstBusinessId}::uuid, ${secondBusinessId}::uuid)
          AND week_start_date = ${weekStartDate}::date
          AND sent_at IS NOT NULL
      `;
      expect(Number(sent!.count)).toBe(2);
    } finally {
      await sql()`DELETE FROM agent_runs WHERE business_id IN (
        ${firstBusinessId}::uuid, ${secondBusinessId}::uuid
      )`;
      await sql()`DELETE FROM businesses WHERE id IN (
        ${firstBusinessId}::uuid, ${secondBusinessId}::uuid
      )`;
    }
  });

  it('startOrGetSolicitationSendBatchRun starts the send parent once and coexists with the build parent', async () => {
    const batchId = randomUUID();

    const first = await sql().begin((tx) =>
      startOrGetSolicitationSendBatchRun(tx, {
        batchId,
        accountId: accountId(),
        businessId: solicitationBusinessId,
        correlationId: 'send-batch:first',
      }),
    );
    const replay = await sql().begin((tx) =>
      startOrGetSolicitationSendBatchRun(tx, {
        batchId,
        accountId: accountId(),
        businessId: solicitationBusinessId,
      }),
    );
    expect(first.created).toBe(true);
    expect(replay).toEqual({ runId: first.runId, created: false });

    const [row] = await sql()<{ kind: string; subject_type: string; subject_id: string }[]>`
      SELECT kind, subject_type, subject_id FROM agent_runs WHERE id = ${first.runId}::uuid
    `;
    // 091's widened kind CHECK and pairing: the send parent shares the build
    // parent's 'solicitation_batch' subject as its sibling on the same subject.
    expect(row).toEqual({
      kind: 'solicitation_send_batch',
      subject_type: 'solicitation_batch',
      subject_id: batchId,
    });

    // agent_runs_one_active_per_subject keys on (kind, subject_type,
    // subject_id), so the BUILD parent for the same batch is a distinct,
    // concurrently running run — not a conflict.
    const buildParent = await sql().begin((tx) =>
      startOrGetActiveRun(tx, {
        kind: 'solicitation_batch',
        subjectType: 'solicitation_batch',
        subjectId: batchId,
        accountId: accountId(),
        businessId: solicitationBusinessId,
      }),
    );
    expect(buildParent.created).toBe(true);
    expect(buildParent.runId).not.toBe(first.runId);
  });

  it('recordGenerationSteps derives one parent step per non-cancelled outreach row of the batch', async () => {
    const uploadId = randomUUID();
    const batchId = randomUUID();

    await sql()`
      INSERT INTO contact_csv_uploads (
        id, account_id, business_id, filename, byte_size, content_sha256,
        raw_csv, status, report, attested_by_user_id, attested_at,
        attestation_version, completed_at
      ) VALUES (
        ${uploadId}::uuid, ${accountId()}::uuid, ${solicitationBusinessId}::uuid,
        'run-spine-generation.csv', 1, ${checksum(uploadId)},
        NULL, 'completed', ${sql().json({ accepted: 1 })},
        ${tenant!.userId}::uuid, NOW(), 'run-spine-test', NOW()
      )
    `;
    await sql()`
      INSERT INTO solicitation_batches (id, account_id, business_id, source_upload_id)
      VALUES (
        ${batchId}::uuid, ${accountId()}::uuid, ${solicitationBusinessId}::uuid,
        ${uploadId}::uuid
      )
    `;
    const seedAsk = async (): Promise<string> => {
      const contactId = randomUUID();
      const askId = randomUUID();
      await sql()`
        INSERT INTO solicitation_contacts (id, business_id, name, email, created_by_upload_id)
        VALUES (
          ${contactId}::uuid, ${solicitationBusinessId}::uuid, 'Generation Candidate',
          ${`${contactId}@example.test`}, ${uploadId}::uuid
        )
      `;
      await sql()`
        INSERT INTO solicitation_asks (
          id, account_id, business_id, batch_id, contact_id,
          status, withheld_reason, evidence, decided_at
        ) VALUES (
          ${askId}::uuid, ${accountId()}::uuid, ${solicitationBusinessId}::uuid,
          ${batchId}::uuid, ${contactId}::uuid, 'send', NULL,
          ${sql().json({ decision: 'send' })}, NOW()
        )
      `;
      return askId;
    };
    const contactOf = async (askId: string): Promise<string> => {
      const [row] = await sql()<{ contact_id: string }[]>`
        SELECT contact_id::text AS contact_id FROM solicitation_asks WHERE id = ${askId}::uuid
      `;
      return row!.contact_id;
    };

    try {
      const { runId: parentRunId } = await sql().begin((tx) =>
        startOrGetSolicitationSendBatchRun(tx, {
          batchId,
          accountId: accountId(),
          businessId: solicitationBusinessId,
        }),
      );

      const renderedAskId = await seedAsk();
      const withheldAskId = await seedAsk();
      const supersededAskId = await seedAsk();
      const base = {
        accountId: accountId(),
        businessId: solicitationBusinessId,
        batchId,
      };
      const renderedOutreachId = await insertOutreach(sql(), {
        ...base,
        askId: renderedAskId,
        contactId: await contactOf(renderedAskId),
        deliveryStatus: 'rendered',
      });
      const withheldOutreachId = await insertOutreach(sql(), {
        ...base,
        askId: withheldAskId,
        contactId: await contactOf(withheldAskId),
        deliveryStatus: 'withheld',
        dispositionReason: 'moderation_high',
        moderationStatus: 'flagged',
        renderedSubject: null,
        renderedBody: null,
      });
      // The superseded ask carries a cancelled attempt 1 AND a live attempt 2:
      // exclusion is per ROW (delivery_status <> 'cancelled'), so the
      // replacement row is stepped and its predecessor is not.
      const supersededContactId = await contactOf(supersededAskId);
      await insertOutreach(sql(), {
        ...base,
        askId: supersededAskId,
        contactId: supersededContactId,
        attemptNo: 1,
        deliveryStatus: 'cancelled',
        dispositionReason: 'superseded',
      });
      const replacementOutreachId = await insertOutreach(sql(), {
        ...base,
        askId: supersededAskId,
        contactId: supersededContactId,
        attemptNo: 2,
        deliveryStatus: 'rendered',
      });

      const written = await sql().begin((tx) =>
        recordGenerationSteps(tx, { parentRunId, ...base }),
      );
      expect(written).toBe(3);

      const steps = await sql()<{
        step_index: number;
        step_key: string;
        attributed_agent: string;
        detail: unknown;
      }[]>`
        SELECT step_index, step_key, attributed_agent, detail
        FROM agent_run_steps
        WHERE agent_run_id = ${parentRunId}::uuid
        ORDER BY step_index
      `;
      expect(steps.map((row) => row.step_index)).toEqual([1, 2, 3]);
      expect(steps.every((row) => row.step_key === 'ask_generated')).toBe(true);
      expect(steps.every((row) => row.attributed_agent === 'solicitation')).toBe(true);

      const details = steps.map((row) => {
        const raw = row.detail;
        return (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>;
      });
      const byOutreachId = new Map(details.map((detail) => [detail.outreach_id, detail]));
      expect(byOutreachId.get(renderedOutreachId)).toEqual({
        outreach_id: renderedOutreachId,
        ask_id: renderedAskId,
        attempt_no: 1,
        delivery_status: 'rendered',
        // disposition_reason stripped by jsonb_strip_nulls — ids/enums only.
      });
      expect(byOutreachId.get(withheldOutreachId)).toEqual({
        outreach_id: withheldOutreachId,
        ask_id: withheldAskId,
        attempt_no: 1,
        delivery_status: 'withheld',
        disposition_reason: 'moderation_high',
      });
      expect(byOutreachId.get(replacementOutreachId)).toMatchObject({
        ask_id: supersededAskId,
        attempt_no: 2,
        delivery_status: 'rendered',
      });

      // recordStep and recordGenerationSteps share one index sequence: the
      // closure receipt appends AFTER the bulk block, gaplessly.
      await sql().begin((tx) =>
        recordStep(tx, { runId: parentRunId, stepKey: 'send_batch_closed' }),
      );
      const [last] = await sql()<{ max_index: number }[]>`
        SELECT MAX(step_index)::int AS max_index FROM agent_run_steps
        WHERE agent_run_id = ${parentRunId}::uuid
      `;
      expect(last!.max_index).toBe(4);

      await expect(
        sql().begin((tx) => recordGenerationSteps(tx, { parentRunId: randomUUID(), ...base })),
      ).rejects.toThrow(/send parent run not found/);
    } finally {
      await sql()`DELETE FROM solicitation_outreach WHERE batch_id = ${batchId}::uuid`;
      await sql()`DELETE FROM solicitation_asks WHERE batch_id = ${batchId}::uuid`;
      await sql()`
        DELETE FROM solicitation_contacts WHERE created_by_upload_id = ${uploadId}::uuid
      `;
      await sql()`DELETE FROM solicitation_batches WHERE id = ${batchId}::uuid`;
      await sql()`DELETE FROM contact_csv_uploads WHERE id = ${uploadId}::uuid`;
    }
  });
  },
);
