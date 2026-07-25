// Live-DB integration coverage for the Requests read model (#544).
//
// NOT hard-gated by `pnpm test:integration` (the #520 class) — run it
// explicitly:
//   TEST_DATABASE_POOL_URL=postgres://…localhost… \
//     pnpm vitest run src/lib/solicitation/__tests__/batch-view.integration.test.ts

import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  cleanupTenantAccount,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import {
  acquireFeature543DatabaseLock,
  FEATURE_543_DATABASE_LOCK_HOOK_TIMEOUT_MS,
  type Feature543DatabaseLock,
} from '@/lib/shared/__tests__/helpers/feature-543-database-lock';
import { CONSENT_ATTESTATION_VERSION } from '../attestation';
import { RESTRAINT_POLICY_VERSION } from '../restraint-policy';
import { EVIDENCE_ROWS_PER_REASON, markBatchReviewed, readLatestBatch } from '../batch-view';

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

let db: postgresType.Sql | undefined;
let tenant: TenantSeed | undefined;
let otherTenant: TenantSeed | undefined;
// Serialises this suite against every other live-DB suite on the shared local
// test database. Without it this suite and batch-builder's seed and truncate
// overlapping solicitation_* tables concurrently and Postgres reports
// `deadlock detected` in whichever one loses.
let featureDatabaseLock: Feature543DatabaseLock | undefined;
const businessId = randomUUID();

/** The candidate-window bound the batch builder evaluates in one pass. */
const PERF_ASK_COUNT = 5_000;
/** Well inside the 30s statement_timeout the pooled client sets. */
const PERF_BUDGET_MS = 5_000;

function sql(): postgresType.Sql {
  if (!db) throw new Error('batch view integration database was not initialized');
  return db;
}

// Local-host refusal guard (mirrors contacts-repo.integration.test.ts): any
// localhost/127.0.0.1 Postgres is accepted, everything else — notably any
// Supabase/pooler host — is refused. Never widen this to remote hosts.
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
    throw new Error('batch view integration requires a local (localhost) test database');
  }
  return databaseUrl;
}

/** A completed upload — every batch needs its own (source_upload_id is UNIQUE). */
async function seedUpload(): Promise<string> {
  const uploadId = randomUUID();
  await sql()`
    INSERT INTO contact_csv_uploads
      (id, account_id, business_id, filename, byte_size, content_sha256, raw_csv,
       status, report, attested_by_user_id, attested_at, attestation_version, completed_at)
    VALUES
      (${uploadId}::uuid, ${tenant!.accountId}::uuid, ${businessId}::uuid,
       'batch-view.csv', 1, ${'0'.repeat(64)}, NULL, 'completed',
       ${sql().json({ accepted: 0 })}, ${tenant!.userId}::uuid, NOW(),
       ${CONSENT_ATTESTATION_VERSION}, NOW())
  `;
  return uploadId;
}

async function seedBatch(input: {
  batchId?: string;
  createdAt: string;
  builtAt: string | null;
}): Promise<string> {
  const batchId = input.batchId ?? randomUUID();
  const uploadId = await seedUpload();
  await sql()`
    INSERT INTO solicitation_batches
      (id, account_id, business_id, source_upload_id, built_at, created_at)
    VALUES
      (${batchId}::uuid, ${tenant!.accountId}::uuid, ${businessId}::uuid,
       ${uploadId}::uuid, ${input.builtAt}::timestamptz, ${input.createdAt}::timestamptz)
  `;
  return batchId;
}

async function seedContact(label: string): Promise<string> {
  const contactId = randomUUID();
  const uploadId = await seedUpload();
  await sql()`
    INSERT INTO solicitation_contacts (id, business_id, name, email, created_by_upload_id)
    VALUES (${contactId}::uuid, ${businessId}::uuid, ${label},
            ${`${label.toLowerCase().replaceAll(' ', '.')}@example.com`}, ${uploadId}::uuid)
  `;
  return contactId;
}

async function seedAsk(input: {
  batchId: string;
  contactId: string;
  status: 'send' | 'withhold';
  reason?: string;
  decidedAt: string;
}): Promise<string> {
  const askId = randomUUID();
  const evidence = input.status === 'send'
    ? { contact_id: input.contactId, policy_version: RESTRAINT_POLICY_VERSION, decided_at: input.decidedAt, decision: 'send' }
    : {
        contact_id: input.contactId,
        policy_version: RESTRAINT_POLICY_VERSION,
        decided_at: input.decidedAt,
        decision: 'withhold',
        reason: input.reason,
      };
  await sql()`
    INSERT INTO solicitation_asks
      (id, account_id, business_id, batch_id, contact_id, status, withheld_reason,
       evidence, decided_at)
    VALUES
      (${askId}::uuid, ${tenant!.accountId}::uuid, ${businessId}::uuid,
       ${input.batchId}::uuid, ${input.contactId}::uuid, ${input.status},
       ${input.reason ?? null}, ${sql().json(evidence)}, ${input.decidedAt}::timestamptz)
  `;
  return askId;
}

async function reviewedAt(batchId: string): Promise<string | null> {
  const [row] = await sql()<{ reviewed_at: string | null }[]>`
    SELECT reviewed_at::text AS reviewed_at
    FROM solicitation_batches WHERE id = ${batchId}::uuid
  `;
  return row?.reviewed_at ?? null;
}

describeWithDb('batch view against live local Postgres', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    const databaseUrl = assertExactLocalDatabaseUrl(testDatabaseUrl);
    featureDatabaseLock = await acquireFeature543DatabaseLock(databaseUrl);
    db = postgres(databaseUrl, { max: 2, prepare: false });
    tenant = await seedTenantAccount(db, {
      userName: 'Batch View Integration Owner',
      accountDisplayName: 'Batch View Integration Account',
    });
    otherTenant = await seedTenantAccount(db, {
      userName: 'Batch View Foreign Owner',
      accountDisplayName: 'Batch View Foreign Account',
    });
    await db`
      INSERT INTO businesses (id, name, owner_name, owner_email, account_id, subscription_status)
      VALUES (
        ${businessId}::uuid, 'Batch View Integration Business', 'Batch Owner',
        ${tenant.ownerEmail}, ${tenant.accountId}::uuid, 'active'
      )
    `;
  }, FEATURE_543_DATABASE_LOCK_HOOK_TIMEOUT_MS);

  afterEach(async () => {
    await sql()`DELETE FROM solicitation_asks WHERE business_id = ${businessId}::uuid`;
    await sql()`DELETE FROM solicitation_batches WHERE business_id = ${businessId}::uuid`;
    await sql()`DELETE FROM solicitation_contacts WHERE business_id = ${businessId}::uuid`;
    await sql()`DELETE FROM contact_csv_uploads WHERE business_id = ${businessId}::uuid`;
  });

  // Release in the reverse of acquisition order, and on every path: a
  // `beforeAll` that failed after taking the lock still holds it, and a leaked
  // advisory lock blocks every other live-DB suite until the session dies.
  afterAll(async () => {
    try {
      if (db) {
        await db`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
        if (tenant) await cleanupTenantAccount(db, tenant);
        if (otherTenant) await cleanupTenantAccount(db, otherTenant);
      }
    } finally {
      try {
        if (db) await db.end({ timeout: 5 });
      } finally {
        await featureDatabaseLock?.release();
        featureDatabaseLock = undefined;
      }
    }
  }, FEATURE_543_DATABASE_LOCK_HOOK_TIMEOUT_MS);

  it('returns the most recent batch when a location has several', async () => {
    await seedBatch({ createdAt: '2026-07-01T10:00:00Z', builtAt: '2026-07-01T10:05:00Z' });

    // created_at is NOT unique, so the id DESC tie-break is the only thing
    // making "most recent" deterministic — seed the tie explicitly.
    const tieIds = [randomUUID(), randomUUID()].sort();
    const [loserId, winnerId] = tieIds as [string, string];
    await seedBatch({ batchId: loserId, createdAt: '2026-07-02T10:00:00Z', builtAt: '2026-07-02T10:05:00Z' });
    await seedBatch({ batchId: winnerId, createdAt: '2026-07-02T10:00:00Z', builtAt: '2026-07-02T10:06:00Z' });

    const view = await readLatestBatch(sql(), tenant!.accountId, businessId);

    expect(view.state).toBe('built');
    if (view.state !== 'built') throw new Error('expected a built batch');
    expect(view.batchId).toBe(winnerId);
  });

  it('returns exact withheld counts per reason and at most 10 evidence rows per group', async () => {
    const batchId = await seedBatch({
      createdAt: '2026-07-10T10:00:00Z',
      builtAt: '2026-07-10T10:05:00Z',
    });

    for (let index = 0; index < 40; index += 1) {
      const contactId = await seedContact(`Stale ${index}`);
      await seedAsk({
        batchId,
        contactId,
        status: 'withhold',
        reason: 'stale_visit',
        decidedAt: `2026-07-10T10:0${index % 6}:00Z`,
      });
    }
    const sendContactId = await seedContact('Queued One');
    await seedAsk({ batchId, contactId: sendContactId, status: 'send', decidedAt: '2026-07-10T10:00:00Z' });

    const view = await readLatestBatch(sql(), tenant!.accountId, businessId);
    if (view.state !== 'built') throw new Error('expected a built batch');

    const stale = view.groups.find((group) => group.reason === 'stale_visit');
    expect(stale?.total).toBe(40);
    expect(stale?.sample).toHaveLength(EVIDENCE_ROWS_PER_REASON);
    expect(view.held).toBe(40);
    expect(view.queued).toBe(1);
    expect(view.evaluated).toBe(41);
    expect(view.contactsOnFile).toBe(41);
    // The full six-reason enum is always present, zero groups included.
    expect(view.groups).toHaveLength(6);
    expect(view.groups.find((group) => group.reason === 'suppressed')).toEqual({
      reason: 'suppressed',
      total: 0,
      sample: [],
    });
  });

  it('returns hasBatch false when the location\'s uploads completed before watch-mode was enabled', async () => {
    await seedContact('Pre Flip');

    const view = await readLatestBatch(sql(), tenant!.accountId, businessId);

    expect(view).toEqual({ state: 'no_batch', contactsOnFile: 1 });
  });

  it('returns uniform emptiness for a location owned by another account', async () => {
    const batchId = await seedBatch({
      createdAt: '2026-07-11T10:00:00Z',
      builtAt: '2026-07-11T10:05:00Z',
    });
    const contactId = await seedContact('Isolated');
    await seedAsk({
      batchId, contactId, status: 'withhold', reason: 'over_contacted',
      decidedAt: '2026-07-11T10:05:00Z',
    });

    const view = await readLatestBatch(sql(), otherTenant!.accountId, businessId);

    expect(view).toEqual({ state: 'no_batch', contactsOnFile: 0 });
    expect(await markBatchReviewed(sql(), otherTenant!.accountId, businessId, batchId)).toBe(0);
    expect(await reviewedAt(batchId)).toBeNull();
  });

  it('records reviewed_at once and does not overwrite it on a second view', async () => {
    const batchId = await seedBatch({
      createdAt: '2026-07-12T10:00:00Z',
      builtAt: '2026-07-12T10:05:00Z',
    });

    expect(await markBatchReviewed(sql(), tenant!.accountId, businessId, batchId)).toBe(1);
    const first = await reviewedAt(batchId);
    expect(first).not.toBeNull();

    expect(await markBatchReviewed(sql(), tenant!.accountId, businessId, batchId)).toBe(0);
    expect(await reviewedAt(batchId)).toBe(first);
  });

  it('refuses to record reviewed_at on a batch that has not been built', async () => {
    const batchId = await seedBatch({ createdAt: '2026-07-13T10:00:00Z', builtAt: null });

    expect(await markBatchReviewed(sql(), tenant!.accountId, businessId, batchId)).toBe(0);
    expect(await reviewedAt(batchId)).toBeNull();
  });

  it('runs its reads inside a read-only repeatable-read snapshot', async () => {
    // Direct proof that the wrapper readLatestBatch uses is not a silent
    // no-op. NOTE: this database is a DIRECT localhost Postgres — the
    // local-host guard above refuses pooler hosts, so this proves the SQL,
    // NOT PgBouncer/Supavisor transaction-pooling behaviour. The pooler is
    // proven only by the staging smoke test.
    const [row] = await sql().begin(async (tx) => {
      await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
      return tx<{ isolation: string; read_only: string }[]>`
        SELECT current_setting('transaction_isolation') AS isolation,
               current_setting('transaction_read_only') AS read_only
      `;
    });

    expect(row?.isolation).toBe('repeatable read');
    expect(row?.read_only).toBe('on');
  });

  it('reads a full candidate-window batch well inside the statement timeout', async () => {
    const batchId = await seedBatch({
      createdAt: '2026-07-14T10:00:00Z',
      builtAt: '2026-07-14T10:05:00Z',
    });
    const uploadId = await seedUpload();

    await sql()`
      INSERT INTO solicitation_contacts (id, business_id, name, email, created_by_upload_id)
      SELECT gen_random_uuid(), ${businessId}::uuid, 'Perf ' || g,
             'perf' || g || '@example.com', ${uploadId}::uuid
      FROM generate_series(1, ${PERF_ASK_COUNT}) g
    `;

    await sql()`
      WITH numbered AS (
        SELECT c.id, ROW_NUMBER() OVER (ORDER BY c.id) AS rn
        FROM solicitation_contacts c
        WHERE c.business_id = ${businessId}::uuid
          AND c.created_by_upload_id = ${uploadId}::uuid
      )
      INSERT INTO solicitation_asks
        (id, account_id, business_id, batch_id, contact_id, status, withheld_reason,
         evidence, decided_at)
      SELECT gen_random_uuid(), ${tenant!.accountId}::uuid, ${businessId}::uuid,
             ${batchId}::uuid, n.id,
             CASE WHEN n.rn % 10 = 0 THEN 'send' ELSE 'withhold' END,
             CASE WHEN n.rn % 10 = 0 THEN NULL ELSE
               (ARRAY['no_consent','already_reviewed','stale_visit',
                      'over_contacted','velocity_banked'])[(n.rn % 5) + 1] END,
             jsonb_build_object(
               'contact_id', n.id,
               'policy_version', ${RESTRAINT_POLICY_VERSION}::text,
               'decided_at', '2026-07-14T10:05:00Z',
               'decision', CASE WHEN n.rn % 10 = 0 THEN 'send' ELSE 'withhold' END
             ),
             '2026-07-14T10:05:00Z'::timestamptz
      FROM numbered n
    `;
    await sql()`ANALYZE solicitation_asks`;

    const startedAt = Date.now();
    const view = await readLatestBatch(sql(), tenant!.accountId, businessId);
    const elapsedMs = Date.now() - startedAt;

    if (view.state !== 'built') throw new Error('expected a built batch');
    expect(view.evaluated).toBe(PERF_ASK_COUNT);
    expect(elapsedMs).toBeLessThan(PERF_BUDGET_MS);
    // Bounded by construction regardless of pool size.
    for (const group of view.groups) {
      expect(group.sample.length).toBeLessThanOrEqual(EVIDENCE_ROWS_PER_REASON);
    }

    // The plan feared that every solicitation_asks index leads on business_id,
    // leaving Postgres to scan the location's full ask history. That premise is
    // wrong: migration 088's solicitation_asks_batch_contact_uniq UNIQUE
    // (batch_id, contact_id) IS a batch_id-leading index, asserted below. No
    // migration is needed, so the plan's escalation trigger does not apply.
    //
    // The plan is recorded rather than asserted on: this table holds one
    // tenant's 5,000 rows, where a sequential scan is the planner's CORRECT
    // choice regardless of available indexes, so "no Seq Scan" would be a
    // proxy that misfires. The wall-clock budget above is the real guard.
    const planRows = await sql()<{ 'QUERY PLAN': string }[]>`
      EXPLAIN (ANALYZE, BUFFERS)
      WITH ranked AS (
        SELECT id,
               (COUNT(*) OVER (PARTITION BY withheld_reason))::int AS group_total,
               ROW_NUMBER() OVER (PARTITION BY withheld_reason
                                  ORDER BY decided_at DESC, id DESC) AS rn
          FROM solicitation_asks
         WHERE account_id = ${tenant!.accountId}::uuid
           AND business_id = ${businessId}::uuid
           AND batch_id = ${batchId}::uuid
           AND status = 'withhold'
      ),
      totals AS (
        SELECT COUNT(*) FILTER (WHERE status = 'send')::int     AS queued,
               COUNT(*) FILTER (WHERE status = 'withhold')::int AS held,
               COUNT(*)::int                                    AS evaluated
          FROM solicitation_asks
         WHERE account_id = ${tenant!.accountId}::uuid
           AND business_id = ${businessId}::uuid
           AND batch_id = ${batchId}::uuid
      )
      SELECT t.queued, t.held, t.evaluated, a.id, a.contact_id,
             LEFT(c.name, 80), a.decided_at::text, a.evidence,
             a.withheld_reason, r.group_total
        FROM totals t
        LEFT JOIN ranked r ON r.rn <= ${EVIDENCE_ROWS_PER_REASON}
        LEFT JOIN solicitation_asks a
          ON a.id = r.id
         AND a.account_id = ${tenant!.accountId}::uuid
         AND a.business_id = ${businessId}::uuid
        LEFT JOIN solicitation_contacts c
          ON c.id = a.contact_id AND c.business_id = ${businessId}::uuid
       ORDER BY a.withheld_reason, r.rn
    `;
    const plan = planRows.map((row) => row['QUERY PLAN']).join('\n');
    process.stderr.write(`\n[batch-view] EXPLAIN (ANALYZE, BUFFERS) for Q3:\n${plan}\n`);

    const batchLeadingIndexes = await sql()<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'solicitation_asks' AND indexdef LIKE '%(batch_id%'
    `;
    expect(
      batchLeadingIndexes.length,
      'solicitation_asks lost its batch_id-leading index — the batch read would then '
        + 'scan a location\'s full ask history. Restoring it is a migration, which '
        + 'changes db_touching and the ship lane: escalate, do not add one quietly.',
    ).toBeGreaterThan(0);
  });
});
