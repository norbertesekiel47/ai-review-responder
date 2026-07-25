import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import type { Job } from 'bullmq';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import { startOrGetActiveRun } from '@/lib/agents/run-spine';
import {
  cleanupTenantAccount,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import type { BuildSolicitationBatchPayload } from '@/lib/shared/worker-types';
import { handleSolicitationBatchFailed } from '../../../../worker/jobs/solicitation-batch/failed-hook';
import { CONSENT_ATTESTATION_VERSION } from '../attestation';
import { buildSolicitationBatch } from '../batch-builder';

function localTestDatabaseUrl(): string | undefined {
  if (process.env.TEST_DATABASE_POOL_URL) return process.env.TEST_DATABASE_POOL_URL;
  try {
    const raw = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8');
    const line = raw.split('\n').find((candidate) =>
      /^\s*TEST_DATABASE_POOL_URL\s*=/.test(candidate),
    );
    return line
      ?.replace(/^\s*TEST_DATABASE_POOL_URL\s*=\s*/, '')
      .trim()
      .replace(/^["']|["']$/g, '');
  } catch {
    return undefined;
  }
}

const testDatabaseUrl = localTestDatabaseUrl();
// verify-gate runs changed integration files in separate processes against one DB.
// Keep this feature's schema setup and large fixture lifecycles from overlapping.
const FEATURE_543_DATABASE_LOCK_KEY = 'repworth_feature_543_integration';
const businessId = randomUUID();
let db: postgresType.Sql | undefined;
let featureDatabaseLock: postgresType.Sql | undefined;
let tenant: TenantSeed | undefined;

function sql(): postgresType.Sql {
  if (!db) throw new Error('batch-builder integration database was not initialized');
  return db;
}

function assertExactLocalDatabaseUrl(databaseUrl: string | undefined): string {
  let parsed: URL | undefined;
  try {
    parsed = databaseUrl === undefined ? undefined : new URL(databaseUrl);
  } catch {
    parsed = undefined;
  }
  const isLocalPostgres =
    parsed !== undefined &&
    (parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:') &&
    (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
  if (databaseUrl === undefined || !isLocalPostgres) {
    throw new Error('batch-builder integration requires a local (localhost) test database');
  }
  return databaseUrl;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function assertStillBlocked(promise: Promise<unknown>): Promise<void> {
  const outcome = await Promise.race([
    promise.then(() => 'completed', () => 'rejected'),
    new Promise<'blocked'>((resolveBlocked) => {
      setTimeout(() => resolveBlocked('blocked'), 150);
    }),
  ]);
  expect(outcome).toBe('blocked');
}

async function releaseFeatureDatabaseLock(): Promise<void> {
  if (!featureDatabaseLock) return;
  const lock = featureDatabaseLock;
  featureDatabaseLock = undefined;
  try {
    await lock`
      SELECT pg_advisory_unlock(hashtext(${FEATURE_543_DATABASE_LOCK_KEY}))
    `;
  } finally {
    await lock.end({ timeout: 5 });
  }
}

async function seedCompletedUpload(): Promise<string> {
  const uploadId = randomUUID();
  await sql()`
    INSERT INTO contact_csv_uploads (
      id, account_id, business_id, filename, byte_size, content_sha256,
      raw_csv, status, report, attested_by_user_id, attested_at,
      attestation_version, completed_at
    ) VALUES (
      ${uploadId}::uuid, ${tenant!.accountId}::uuid, ${businessId}::uuid,
      'batch-builder.csv', 1, ${uploadId.replaceAll('-', '').padEnd(64, '0').slice(0, 64)},
      NULL, 'completed', ${sql().json({ accepted: 0 })},
      ${tenant!.userId}::uuid, NOW(), ${CONSENT_ATTESTATION_VERSION}, NOW()
    )
  `;
  return uploadId;
}

async function seedContact(
  uploadId: string,
  visitDate: string,
): Promise<string> {
  const contactId = randomUUID();
  await sql()`
    INSERT INTO solicitation_contacts (
      id, business_id, name, email, created_by_upload_id
    ) VALUES (
      ${contactId}::uuid, ${businessId}::uuid, 'Batch Candidate',
      ${`${contactId}@example.test`}, ${uploadId}::uuid
    )
  `;
  await sql()`
    INSERT INTO solicitation_visits (
      id, contact_id, business_id, visit_date, upload_id
    ) VALUES (
      ${randomUUID()}::uuid, ${contactId}::uuid, ${businessId}::uuid,
      ${visitDate}::date, ${uploadId}::uuid
    )
  `;
  return contactId;
}

interface SeedBatchResult {
  batchId: string;
  outboxId: string;
  attempt: number;
}

async function seedBatch(attempt = 1): Promise<SeedBatchResult> {
  const batchId = randomUUID();
  const outboxId = randomUUID();
  const sourceUploadId = await seedCompletedUpload();
  await sql()`
    INSERT INTO solicitation_batches (
      id, account_id, business_id, source_upload_id
    ) VALUES (
      ${batchId}::uuid, ${tenant!.accountId}::uuid,
      ${businessId}::uuid, ${sourceUploadId}::uuid
    )
  `;
  await sql()`
    INSERT INTO job_outbox (
      id, topic, aggregate_type, aggregate_id, payload,
      status, attempts, dispatched_at
    ) VALUES (
      ${outboxId}::uuid, ${QUEUE_NAMES.BUILD_SOLICITATION_BATCH},
      'solicitation_batch', ${batchId}::uuid,
      ${sql().json({ batch_id: batchId, business_id: businessId })},
      'dispatched', ${attempt}, NOW()
    )
  `;
  return { batchId, outboxId, attempt };
}

async function build(batch: SeedBatchResult) {
  return buildSolicitationBatch(sql(), {
    batchId: batch.batchId,
    businessId,
    outboxId: batch.outboxId,
    attempt: batch.attempt,
    correlationId: 'batch-builder-integration',
  });
}

async function seedParentRun(batchId: string): Promise<string> {
  return sql().begin(async (tx) => {
    const parent = await startOrGetActiveRun(tx, {
      kind: 'solicitation_batch',
      subjectType: 'solicitation_batch',
      subjectId: batchId,
      accountId: tenant!.accountId,
      businessId,
      correlationId: 'batch-builder-integration-parent',
    });
    return parent.runId;
  });
}

async function seedPriorAsk(input: {
  contactId: string;
  status: 'send' | 'withhold';
  decidedAt: string;
  withheldReason?: 'velocity_banked';
}): Promise<void> {
  const historical = await seedBatch();
  await sql()`
    UPDATE solicitation_batches
    SET created_at = ${input.decidedAt}::timestamptz - INTERVAL '1 second',
        built_at = ${input.decidedAt}::timestamptz
    WHERE id = ${historical.batchId}::uuid
  `;
  await sql()`
    UPDATE job_outbox
    SET status = 'completed', completed_at = NOW()
    WHERE id = ${historical.outboxId}::uuid
  `;
  await sql()`
    INSERT INTO solicitation_asks (
      id, account_id, business_id, batch_id, contact_id, status,
      withheld_reason, evidence, decided_at
    ) VALUES (
      ${randomUUID()}::uuid, ${tenant!.accountId}::uuid, ${businessId}::uuid,
      ${historical.batchId}::uuid, ${input.contactId}::uuid, ${input.status},
      ${input.withheldReason ?? null},
      ${sql().json({
        contact_id: input.contactId,
        policy_version: 'fixture',
        decided_at: input.decidedAt,
        decision: input.status,
        ...(input.withheldReason ? { reason: input.withheldReason } : {}),
      })},
      ${input.decidedAt}::timestamptz
    )
  `;
}

describeWithDb('solicitation batch builder against live local Postgres', {
  enabled: Boolean(testDatabaseUrl),
  timeout: 90_000,
}, () => {
  beforeAll(async () => {
    const databaseUrl = assertExactLocalDatabaseUrl(testDatabaseUrl);
    featureDatabaseLock = postgres(databaseUrl, { max: 1, prepare: false });
    await featureDatabaseLock`
      SELECT pg_advisory_lock(hashtext(${FEATURE_543_DATABASE_LOCK_KEY}))
    `;
    db = postgres(databaseUrl, {
      max: 4,
      prepare: false,
    });
    await db.unsafe(
      readFileSync(resolve(process.cwd(), 'supabase/migrations/071_agent_run_spine.sql'), 'utf-8'),
    );
    await db.unsafe(
      readFileSync(
        resolve(process.cwd(), 'supabase/migrations/088_solicitation_batch_executor.sql'),
        'utf-8',
      ),
    );
    tenant = await seedTenantAccount(db, {
      userName: 'Batch Builder Integration Owner',
      accountDisplayName: 'Batch Builder Integration Account',
      subscriptionStatus: 'active',
    });
    await db`
      INSERT INTO businesses (
        id, name, owner_name, owner_email, account_id,
        subscription_status, category
      ) VALUES (
        ${businessId}::uuid, 'Batch Builder Integration Business',
        'Batch Owner', ${tenant.ownerEmail}, ${tenant.accountId}::uuid,
        'active', 'automotive'
      )
    `;
  }, 120_000);

  afterEach(async () => {
    delete process.env.SOLICITATION_WATCH_ENABLED;
    await sql()`
      DELETE FROM job_outbox
      WHERE aggregate_type = 'solicitation_batch'
        AND payload->>'business_id' = ${businessId}
    `;
    await sql()`
      DELETE FROM agent_runs
      WHERE account_id = ${tenant!.accountId}::uuid
        AND kind IN ('solicitation_batch', 'solicitation_ask')
    `;
    await sql()`DELETE FROM contact_csv_uploads WHERE business_id = ${businessId}::uuid`;
  }, 30_000);

  afterAll(async () => {
    try {
      if (db) {
        await db`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
        if (tenant) await cleanupTenantAccount(db, tenant);
      }
    } finally {
      try {
        if (db) await db.end({ timeout: 5 });
      } finally {
        await releaseFeatureDatabaseLock();
      }
    }
  }, 120_000);

  it('build_solicitation_batch atomically records decisions and completes the parent and owned outbox', async () => {
    process.env.SOLICITATION_WATCH_ENABLED = 'true';
    const uploadId = await seedCompletedUpload();
    const contactId = await seedContact(uploadId, '2026-07-23');
    const batch = await seedBatch(3);

    const result = await build(batch);

    expect(result).toMatchObject({
      status: 'built',
      candidateCount: 1,
      sendCount: 1,
      withholdCount: 0,
    });
    const [state] = await sql()<{
      outbox_status: string;
      built_at: string | null;
      parent_status: string;
      child_status: string;
      linked_run_id: string | null;
      outcome_units: number;
      parent_steps: number;
      child_steps: number;
      evidence_text: string;
    }[]>`
      SELECT
        jo.status AS outbox_status,
        sb.built_at::text AS built_at,
        parent.status AS parent_status,
        child.status AS child_status,
        ask.agent_run_id::text AS linked_run_id,
        outcome.unit_count AS outcome_units,
        (SELECT COUNT(*)::int FROM agent_run_steps s
         WHERE s.agent_run_id = parent.id AND s.step_key = 'batch_built') AS parent_steps,
        (SELECT COUNT(*)::int FROM agent_run_steps s
         WHERE s.agent_run_id = child.id AND s.step_key = 'ask_evaluated') AS child_steps,
        ask.evidence::text AS evidence_text
      FROM solicitation_batches sb
      JOIN job_outbox jo ON jo.aggregate_id = sb.id
      JOIN agent_runs parent
        ON parent.kind = 'solicitation_batch' AND parent.subject_id = sb.id::text
      JOIN solicitation_asks ask
        ON ask.batch_id = sb.id AND ask.contact_id = ${contactId}::uuid
      JOIN agent_runs child ON child.id = ask.agent_run_id
      JOIN agent_outcomes outcome
        ON outcome.agent_run_id = parent.id
       AND outcome.outcome_kind = 'solicitation_batch_built'
      WHERE sb.id = ${batch.batchId}::uuid
    `;
    expect(state).toMatchObject({
      outbox_status: 'completed',
      parent_status: 'completed',
      child_status: 'completed',
      outcome_units: 1,
      parent_steps: 1,
      child_steps: 1,
    });
    expect(state!.built_at).not.toBeNull();
    expect(state!.linked_run_id).not.toBeNull();
    expect(state!.evidence_text).not.toContain('@example.test');
    expect(state!.evidence_text).not.toContain('Batch Candidate');
  });

  it('builds an empty accumulated pool with a zero-unit batch outcome', async () => {
    process.env.SOLICITATION_WATCH_ENABLED = 'true';
    const batch = await seedBatch();

    await expect(build(batch)).resolves.toMatchObject({
      status: 'built',
      candidateCount: 0,
      sendCount: 0,
      withholdCount: 0,
    });

    const [state] = await sql()<{
      built: boolean;
      unit_count: number;
      child_count: number;
    }[]>`
      SELECT
        sb.built_at IS NOT NULL AS built,
        outcome.unit_count,
        (SELECT COUNT(*)::int FROM agent_runs child
         WHERE child.parent_run_id = parent.id) AS child_count
      FROM solicitation_batches sb
      JOIN agent_runs parent
        ON parent.kind = 'solicitation_batch'
       AND parent.subject_id = sb.id::text
      JOIN agent_outcomes outcome
        ON outcome.agent_run_id = parent.id
       AND outcome.outcome_kind = 'solicitation_batch_built'
      WHERE sb.id = ${batch.batchId}::uuid
    `;
    expect(state).toEqual({ built: true, unit_count: 0, child_count: 0 });
  });

  it('priorBatch reads only would-have-sent asks and never velocity_banked decisions', async () => {
    process.env.SOLICITATION_WATCH_ENABLED = 'true';
    const uploadId = await seedCompletedUpload();
    const bankedContactId = await seedContact(uploadId, '2026-07-23');
    const sentContactId = await seedContact(uploadId, '2026-07-22');
    const recent = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await seedPriorAsk({
      contactId: bankedContactId,
      status: 'withhold',
      withheldReason: 'velocity_banked',
      decidedAt: recent,
    });
    await seedPriorAsk({
      contactId: sentContactId,
      status: 'send',
      decidedAt: recent,
    });

    const batch = await seedBatch();
    await build(batch);

    const asks = await sql()<{
      contact_id: string;
      status: string;
      withheld_reason: string | null;
    }[]>`
      SELECT contact_id::text, status, withheld_reason
      FROM solicitation_asks
      WHERE batch_id = ${batch.batchId}::uuid
      ORDER BY contact_id
    `;
    expect(asks.find((ask) => ask.contact_id === bankedContactId)).toMatchObject({
      status: 'send',
      withheld_reason: null,
    });
    expect(asks.find((ask) => ask.contact_id === sentContactId)).toMatchObject({
      status: 'withhold',
      withheld_reason: 'over_contacted',
    });
  });

  it('concurrent location batches serialize so the later batch observes earlier would-have-sent history', async () => {
    process.env.SOLICITATION_WATCH_ENABLED = 'true';
    const uploadId = await seedCompletedUpload();
    await seedContact(uploadId, '2026-07-23');
    const first = await seedBatch();
    const second = await seedBatch();

    const results = await Promise.all([build(first), build(second)]);

    expect(results.map((result) => result.status)).toEqual(['built', 'built']);
    const decisions = await sql()<{
      status: string;
      withheld_reason: string | null;
    }[]>`
      SELECT status, withheld_reason
      FROM solicitation_asks
      WHERE batch_id IN (${first.batchId}::uuid, ${second.batchId}::uuid)
      ORDER BY status
    `;
    expect(decisions).toHaveLength(2);
    expect(decisions.filter((decision) => decision.status === 'send')).toHaveLength(1);
    expect(decisions.filter(
      (decision) =>
        decision.status === 'withhold' &&
        decision.withheld_reason === 'over_contacted',
    )).toHaveLength(1);
  });

  it('retry after committed construction does not create an extra parent or duplicate asks or child runs', async () => {
    process.env.SOLICITATION_WATCH_ENABLED = 'true';
    const uploadId = await seedCompletedUpload();
    await seedContact(uploadId, '2026-07-23');
    const batch = await seedBatch(2);

    await build(batch);
    await expect(build(batch)).resolves.toMatchObject({ status: 'stale' });

    const [counts] = await sql()<{
      parents: number;
      asks: number;
      children: number;
    }[]>`
      SELECT
        (SELECT COUNT(*)::int FROM agent_runs
         WHERE kind = 'solicitation_batch'
           AND subject_id = ${batch.batchId}) AS parents,
        (SELECT COUNT(*)::int FROM solicitation_asks
         WHERE batch_id = ${batch.batchId}::uuid) AS asks,
        (SELECT COUNT(*)::int FROM agent_runs child
         JOIN solicitation_asks ask ON ask.agent_run_id = child.id
         WHERE ask.batch_id = ${batch.batchId}::uuid
           AND child.kind = 'solicitation_ask') AS children
    `;
    expect(counts).toEqual({ parents: 1, asks: 1, children: 1 });
  });

  it('lockDispatchedOutboxAttemptIfOwned prevents a stale build attempt from creating a parent', async () => {
    process.env.SOLICITATION_WATCH_ENABLED = 'true';
    const batch = await seedBatch(4);

    await expect(
      buildSolicitationBatch(sql(), {
        batchId: batch.batchId,
        businessId,
        outboxId: batch.outboxId,
        attempt: 3,
      }),
    ).resolves.toMatchObject({ status: 'stale' });

    const [state] = await sql()<{
      outbox_status: string;
      built_at: string | null;
      parents: number;
    }[]>`
      SELECT
        jo.status AS outbox_status,
        sb.built_at::text AS built_at,
        (SELECT COUNT(*)::int FROM agent_runs
         WHERE kind = 'solicitation_batch'
           AND subject_id = sb.id::text) AS parents
      FROM solicitation_batches sb
      JOIN job_outbox jo ON jo.aggregate_id = sb.id
      WHERE sb.id = ${batch.batchId}::uuid
    `;
    expect(state).toEqual({
      outbox_status: 'dispatched',
      built_at: null,
      parents: 0,
    });
  });

  it('a dispatched builder serializes behind delete_data offboarding and closes without history effects', async () => {
    process.env.SOLICITATION_WATCH_ENABLED = 'true';
    const uploadId = await seedCompletedUpload();
    await seedContact(uploadId, '2026-07-23');
    const batch = await seedBatch(2);
    const offboardingId = randomUUID();
    const accountLockHeld = deferred();
    const allowOffboardingCommit = deferred();
    let offboardingWriter: Promise<unknown> | undefined;
    let dispatchedBuilder: Promise<unknown> | undefined;

    try {
      offboardingWriter = sql().begin(async (tx) => {
        await tx`SET LOCAL lock_timeout = '4s'`;
        await tx`SET LOCAL statement_timeout = '7s'`;
        await tx`
          SELECT id
          FROM accounts
          WHERE id = ${tenant!.accountId}::uuid
          FOR UPDATE
        `;
        accountLockHeld.resolve();
        await allowOffboardingCommit.promise;
        await tx`
          INSERT INTO account_offboardings (id, account_id, mode, status)
          VALUES (
            ${offboardingId}::uuid,
            ${tenant!.accountId}::uuid,
            'delete_data',
            'pending'
          )
        `;
      });
      await accountLockHeld.promise;

      dispatchedBuilder = build(batch);
      await assertStillBlocked(dispatchedBuilder);
      allowOffboardingCommit.resolve();

      await offboardingWriter;
      await expect(dispatchedBuilder).resolves.toEqual({
        status: 'gate_closed',
        reason: 'account_offboarding_blocked',
        parentTerminalized: false,
      });

      const [state] = await sql()<{
        batch_count: number;
        outbox_status: string;
        ask_count: number;
        run_count: number;
      }[]>`
        SELECT
          (SELECT COUNT(*)::int
           FROM solicitation_batches
           WHERE id = ${batch.batchId}::uuid) AS batch_count,
          (SELECT status
           FROM job_outbox
           WHERE id = ${batch.outboxId}::uuid) AS outbox_status,
          (SELECT COUNT(*)::int
           FROM solicitation_asks
           WHERE batch_id = ${batch.batchId}::uuid) AS ask_count,
          (SELECT COUNT(*)::int
           FROM agent_runs
           WHERE account_id = ${tenant!.accountId}::uuid
             AND subject_id = ${batch.batchId}) AS run_count
      `;
      expect(state).toEqual({
        batch_count: 0,
        outbox_status: 'completed',
        ask_count: 0,
        run_count: 0,
      });
    } finally {
      allowOffboardingCommit.resolve();
      await Promise.allSettled([
        offboardingWriter ?? Promise.resolve(),
        dispatchedBuilder ?? Promise.resolve(),
      ]);
      await sql()`
        DELETE FROM account_offboardings
        WHERE id = ${offboardingId}::uuid
      `;
    }
  });

  it('build_solicitation_batch removes no-parent unbuilt work when the flag or subscription gate closes', async () => {
    const uploadId = await seedCompletedUpload();
    await seedContact(uploadId, '2026-07-23');
    const flagClosed = await seedBatch(2);
    const untouched = await seedBatch(2);

    delete process.env.SOLICITATION_WATCH_ENABLED;
    await expect(build(flagClosed)).resolves.toEqual({
      status: 'gate_closed',
      reason: 'flag_disabled',
      parentTerminalized: false,
    });

    process.env.SOLICITATION_WATCH_ENABLED = 'true';
    const subscriptionClosed = await seedBatch(4);
    let subscriptionResult;
    try {
      await sql()`
        UPDATE accounts
        SET subscription_status = 'cancelled'
        WHERE id = ${tenant!.accountId}::uuid
      `;
      subscriptionResult = await build(subscriptionClosed);
    } finally {
      await sql()`
        UPDATE accounts
        SET subscription_status = 'active'
        WHERE id = ${tenant!.accountId}::uuid
      `;
    }
    expect(subscriptionResult).toEqual({
      status: 'gate_closed',
      reason: 'subscription_inactive',
      parentTerminalized: false,
    });

    const [state] = await sql()<{
      target_batches: number;
      untouched_batches: number;
      target_parents: number;
      target_asks: number;
      completed_outboxes: number;
    }[]>`
      SELECT
        (SELECT COUNT(*)::int
         FROM solicitation_batches
         WHERE id IN (
           ${flagClosed.batchId}::uuid,
           ${subscriptionClosed.batchId}::uuid
         )) AS target_batches,
        (SELECT COUNT(*)::int
         FROM solicitation_batches
         WHERE id = ${untouched.batchId}::uuid
           AND built_at IS NULL) AS untouched_batches,
        (SELECT COUNT(*)::int
         FROM agent_runs
         WHERE kind = 'solicitation_batch'
           AND subject_id IN (
             ${flagClosed.batchId},
             ${subscriptionClosed.batchId}
           )) AS target_parents,
        (SELECT COUNT(*)::int
         FROM solicitation_asks
         WHERE batch_id IN (
           ${flagClosed.batchId}::uuid,
           ${subscriptionClosed.batchId}::uuid
         )) AS target_asks,
        (SELECT COUNT(*)::int
         FROM job_outbox
         WHERE id IN (
           ${flagClosed.outboxId}::uuid,
           ${subscriptionClosed.outboxId}::uuid
         )
           AND status = 'completed') AS completed_outboxes
    `;
    expect(state).toEqual({
      target_batches: 0,
      untouched_batches: 1,
      target_parents: 0,
      target_asks: 0,
      completed_outboxes: 2,
    });
  });

  it('build_solicitation_batch gate closure after parent start completes the owned outbox and fails that parent as gate_closed', async () => {
    const uploadId = await seedCompletedUpload();
    await seedContact(uploadId, '2026-07-23');
    const target = await seedBatch(3);
    const untouched = await seedBatch(3);
    const targetParentId = await seedParentRun(target.batchId);
    const untouchedParentId = await seedParentRun(untouched.batchId);

    delete process.env.SOLICITATION_WATCH_ENABLED;
    await expect(build(target)).resolves.toEqual({
      status: 'gate_closed',
      reason: 'flag_disabled',
      parentTerminalized: true,
    });

    const [state] = await sql()<{
      target_batch_count: number;
      untouched_batch_count: number;
      outbox_status: string;
      target_parent_status: string;
      target_error_code: string | null;
      target_error_gate: string | null;
      untouched_parent_status: string;
      target_asks: number;
    }[]>`
      SELECT
        (SELECT COUNT(*)::int FROM solicitation_batches
         WHERE id = ${target.batchId}::uuid) AS target_batch_count,
        (SELECT COUNT(*)::int FROM solicitation_batches
         WHERE id = ${untouched.batchId}::uuid
           AND built_at IS NULL) AS untouched_batch_count,
        (SELECT status FROM job_outbox
         WHERE id = ${target.outboxId}::uuid) AS outbox_status,
        (SELECT status FROM agent_runs
         WHERE id = ${targetParentId}::uuid) AS target_parent_status,
        (SELECT error->>'code' FROM agent_runs
         WHERE id = ${targetParentId}::uuid) AS target_error_code,
        (SELECT error->>'gate' FROM agent_runs
         WHERE id = ${targetParentId}::uuid) AS target_error_gate,
        (SELECT status FROM agent_runs
         WHERE id = ${untouchedParentId}::uuid) AS untouched_parent_status,
        (SELECT COUNT(*)::int FROM solicitation_asks
         WHERE batch_id = ${target.batchId}::uuid) AS target_asks
    `;
    expect(state).toEqual({
      target_batch_count: 0,
      untouched_batch_count: 1,
      outbox_status: 'completed',
      target_parent_status: 'failed',
      target_error_code: 'gate_closed',
      target_error_gate: 'flag_disabled',
      untouched_parent_status: 'running',
      target_asks: 0,
    });
  });

  it('build_solicitation_batch exhausted failure marks only the owned parent failed and keeps the unbuilt batch hidden', async () => {
    process.env.SOLICITATION_WATCH_ENABLED = 'true';
    const uploadId = await seedCompletedUpload();
    await seedContact(uploadId, '2026-07-23');
    const target = await seedBatch(3);
    const untouched = await seedBatch(3);
    const targetParentId = await seedParentRun(target.batchId);
    const untouchedParentId = await seedParentRun(untouched.batchId);
    const job = {
      id: target.outboxId,
      data: {
        batch_id: target.batchId,
        business_id: businessId,
        outbox_id: target.outboxId,
        outbox_attempt: target.attempt,
        correlation_id: 'batch-builder-exhaustion',
      },
      attemptsMade: 3,
      opts: { attempts: 3 },
    } as unknown as Job<BuildSolicitationBatchPayload>;

    await handleSolicitationBatchFailed(
      sql(),
      job,
      new Error('contact-name@example.test must never be persisted'),
    );

    const [state] = await sql()<{
      target_batch_count: number;
      target_built_at: string | null;
      target_outbox_status: string;
      target_last_error: string | null;
      target_parent_status: string;
      target_error_code: string | null;
      target_error_class: string | null;
      untouched_parent_status: string;
      untouched_outbox_status: string;
      target_asks: number;
    }[]>`
      SELECT
        (SELECT COUNT(*)::int FROM solicitation_batches
         WHERE id = ${target.batchId}::uuid) AS target_batch_count,
        (SELECT built_at::text FROM solicitation_batches
         WHERE id = ${target.batchId}::uuid) AS target_built_at,
        (SELECT status FROM job_outbox
         WHERE id = ${target.outboxId}::uuid) AS target_outbox_status,
        (SELECT last_error FROM job_outbox
         WHERE id = ${target.outboxId}::uuid) AS target_last_error,
        (SELECT status FROM agent_runs
         WHERE id = ${targetParentId}::uuid) AS target_parent_status,
        (SELECT error->>'code' FROM agent_runs
         WHERE id = ${targetParentId}::uuid) AS target_error_code,
        (SELECT error->>'error_class' FROM agent_runs
         WHERE id = ${targetParentId}::uuid) AS target_error_class,
        (SELECT status FROM agent_runs
         WHERE id = ${untouchedParentId}::uuid) AS untouched_parent_status,
        (SELECT status FROM job_outbox
         WHERE id = ${untouched.outboxId}::uuid) AS untouched_outbox_status,
        (SELECT COUNT(*)::int FROM solicitation_asks
         WHERE batch_id = ${target.batchId}::uuid) AS target_asks
    `;
    expect(state).toEqual({
      target_batch_count: 1,
      target_built_at: null,
      target_outbox_status: 'failed',
      target_last_error: 'build_solicitation_batch_exhausted:Error',
      target_parent_status: 'failed',
      target_error_code: 'build_failed',
      target_error_class: 'Error',
      untouched_parent_status: 'running',
      untouched_outbox_status: 'dispatched',
      target_asks: 0,
    });
    expect(JSON.stringify(state)).not.toContain('contact-name@example.test');
  });

  it('repeated visit and evaluation histories remain buildable under a bounded statement timeout', async () => {
    process.env.SOLICITATION_WATCH_ENABLED = 'true';
    const uploadId = await seedCompletedUpload();
    const contactId = await seedContact(uploadId, '2026-07-23');
    const fixtureSeed = randomUUID();
    const historyRows = 4_000;

    await sql()`
      WITH fixtures AS (
        SELECT
          n,
          md5(${fixtureSeed} || '-upload-' || n::text)::uuid AS upload_id
        FROM generate_series(1, ${historyRows}) AS n
      )
      INSERT INTO contact_csv_uploads (
        id, account_id, business_id, filename, byte_size, content_sha256,
        raw_csv, status, report, attested_by_user_id, attested_at,
        attestation_version, completed_at
      )
      SELECT
        upload_id,
        ${tenant!.accountId}::uuid,
        ${businessId}::uuid,
        'history.csv',
        1,
        md5(${fixtureSeed} || '-sha-' || n::text)
          || md5(${fixtureSeed} || '-sha-tail-' || n::text),
        NULL,
        'completed',
        ${sql().json({ accepted: 1 })},
        ${tenant!.userId}::uuid,
        NOW(),
        ${CONSENT_ATTESTATION_VERSION},
        NOW()
      FROM fixtures
    `;
    await sql()`
      WITH fixtures AS (
        SELECT
          n,
          md5(${fixtureSeed} || '-upload-' || n::text)::uuid AS upload_id,
          md5(${fixtureSeed} || '-batch-' || n::text)::uuid AS batch_id
        FROM generate_series(1, ${historyRows}) AS n
      )
      INSERT INTO solicitation_batches (
        id, account_id, business_id, source_upload_id, built_at, created_at
      )
      SELECT
        batch_id,
        ${tenant!.accountId}::uuid,
        ${businessId}::uuid,
        upload_id,
        NOW(),
        NOW() - INTERVAL '1 second'
      FROM fixtures
    `;
    await sql()`
      WITH fixtures AS (
        SELECT
          n,
          md5(${fixtureSeed} || '-upload-' || n::text)::uuid AS upload_id,
          md5(${fixtureSeed} || '-visit-' || n::text)::uuid AS visit_id
        FROM generate_series(1, ${historyRows}) AS n
      )
      INSERT INTO solicitation_visits (
        id, contact_id, business_id, visit_date, upload_id
      )
      SELECT
        visit_id,
        ${contactId}::uuid,
        ${businessId}::uuid,
        '2026-07-23'::date - n,
        upload_id
      FROM fixtures
    `;
    await sql()`
      WITH fixtures AS (
        SELECT
          n,
          md5(${fixtureSeed} || '-batch-' || n::text)::uuid AS batch_id,
          md5(${fixtureSeed} || '-ask-' || n::text)::uuid AS ask_id
        FROM generate_series(1, ${historyRows}) AS n
      )
      INSERT INTO solicitation_asks (
        id, account_id, business_id, batch_id, contact_id, status,
        withheld_reason, evidence, decided_at
      )
      SELECT
        ask_id,
        ${tenant!.accountId}::uuid,
        ${businessId}::uuid,
        batch_id,
        ${contactId}::uuid,
        'withhold',
        'stale_visit',
        ${sql().json({
          contact_id: contactId,
          policy_version: 'history-fixture',
          decided_at: '2026-07-23T00:00:00.000Z',
          decision: 'withhold',
          reason: 'stale_visit',
        })},
        NOW() - n * INTERVAL '1 second'
      FROM fixtures
    `;

    const batch = await seedBatch();
    const boundedSql = postgres(assertExactLocalDatabaseUrl(testDatabaseUrl), {
      max: 1,
      prepare: false,
    });
    try {
      await boundedSql`SET statement_timeout = '2s'`;
      await expect(
        buildSolicitationBatch(boundedSql, {
          batchId: batch.batchId,
          businessId,
          outboxId: batch.outboxId,
          attempt: batch.attempt,
          correlationId: 'batch-builder-history-bound',
        }),
      ).resolves.toMatchObject({
        status: 'built',
        candidateCount: 1,
      });
    } finally {
      await boundedSql.end({ timeout: 5 });
    }
  }, 30_000);

  it('candidate windows are capped at 5000 and rotate by least-recently-evaluated ask', async () => {
    process.env.SOLICITATION_WATCH_ENABLED = 'true';
    const uploadId = await seedCompletedUpload();
    await sql()`
      WITH contacts AS (
        INSERT INTO solicitation_contacts (
          id, business_id, name, email, created_by_upload_id
        )
        SELECT
          gen_random_uuid(), ${businessId}::uuid, 'Window Candidate',
          'window-' || n::text || '@example.test', ${uploadId}::uuid
        FROM generate_series(1, 5001) AS n
        RETURNING id
      )
      INSERT INTO solicitation_visits (
        id, contact_id, business_id, visit_date, upload_id
      )
      SELECT
        gen_random_uuid(), id, ${businessId}::uuid, '2026-07-23'::date,
        ${uploadId}::uuid
      FROM contacts
    `;
    const first = await seedBatch();
    const firstResult = await build(first);
    expect(firstResult).toMatchObject({ status: 'built', candidateCount: 5000 });

    const [neverEvaluated] = await sql()<{ id: string }[]>`
      SELECT c.id::text AS id
      FROM solicitation_contacts c
      LEFT JOIN solicitation_asks a
        ON a.contact_id = c.id AND a.batch_id = ${first.batchId}::uuid
      WHERE c.business_id = ${businessId}::uuid
        AND a.id IS NULL
    `;
    expect(neverEvaluated).toBeDefined();

    const second = await seedBatch();
    const secondResult = await build(second);
    expect(secondResult).toMatchObject({ status: 'built', candidateCount: 5000 });
    const [rotated] = await sql()<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM solicitation_asks
      WHERE batch_id = ${second.batchId}::uuid
        AND contact_id = ${neverEvaluated!.id}::uuid
    `;
    expect(rotated!.count).toBe(1);
  });
});
