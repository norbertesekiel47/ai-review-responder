import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  cleanupTenantAccount,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
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
const businessId = randomUUID();
let db: postgresType.Sql | undefined;
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
    db = postgres(assertExactLocalDatabaseUrl(testDatabaseUrl), {
      max: 4,
      prepare: false,
    });
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
  });

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
    if (!db) return;
    await db`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
    if (tenant) await cleanupTenantAccount(db, tenant);
    await db.end();
  });

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
