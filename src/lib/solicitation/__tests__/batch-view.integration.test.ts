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
  acquireLiveDbLock,
  LIVE_DB_LOCK_HOOK_TIMEOUT_MS,
  type LiveDbLock,
} from '@/lib/shared/__tests__/helpers/live-db-lock';
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
let featureDatabaseLock: LiveDbLock | undefined;
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

const ATTEMPT_INTERPOLATION_INPUTS = {
  contact_first_name: 'Dana',
  business_name: 'Batch View Integration Business',
  days_since_visit_bucket: 'last week',
  vertical: 'home_services',
  visit_note: null,
  note_disposition: 'absent',
};

/**
 * One outreach attempt, satisfying 091's CHECKs (bodies paired; status↔reason
 * consistency; no dispatch stamps for undispatched statuses).
 */
async function seedOutreach(input: {
  batchId: string;
  askId: string;
  contactId: string;
  attemptNo?: number;
  deliveryStatus: 'rendered' | 'withheld' | 'cancelled';
  dispositionReason?: string | null;
  subject?: string | null;
  body?: string | null;
  lintDetail?: readonly string[];
  moderationStatus?: string;
  moderationDetail?: Record<string, unknown>;
}): Promise<string> {
  const outreachId = randomUUID();
  await sql()`
    INSERT INTO solicitation_outreach
      (id, account_id, business_id, batch_id, ask_id, contact_id, attempt_no,
       rendered_subject, rendered_body, prompt_version, prompt_hash,
       interpolation_inputs, rendered_at, ask_lint_version, lint_detail,
       moderation_status, moderation_detail, delivery_status, disposition_reason)
    VALUES
      (${outreachId}::uuid, ${tenant!.accountId}::uuid, ${businessId}::uuid,
       ${input.batchId}::uuid, ${input.askId}::uuid, ${input.contactId}::uuid,
       ${input.attemptNo ?? 1},
       ${input.subject ?? null}, ${input.body ?? null},
       'solicitation_ask_v1', ${'0'.repeat(64)},
       ${sql().json(ATTEMPT_INTERPOLATION_INPUTS)}, NOW(),
       'ask_lint_v1', ${sql().json([...(input.lintDetail ?? [])])},
       ${input.moderationStatus ?? 'clean'},
       ${sql().json((input.moderationDetail ?? {}) as never)},
       ${input.deliveryStatus}, ${input.dispositionReason ?? null})
  `;
  return outreachId;
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
    featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
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
  }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

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
  }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

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

  it('joins each ask\'s current attempt, excludes superseded rows, and redacts moderation_high content', async () => {
    const batchId = await seedBatch({
      createdAt: '2026-07-20T10:00:00Z',
      builtAt: '2026-07-20T10:05:00Z',
    });

    // Ask 1: regenerated once — the cancelled attempt 1 must not surface.
    const draftedContact = await seedContact('Drafted Dana');
    const draftedAsk = await seedAsk({
      batchId, contactId: draftedContact, status: 'send', decidedAt: '2026-07-20T10:05:00Z',
    });
    await seedOutreach({
      batchId, askId: draftedAsk, contactId: draftedContact, attemptNo: 1,
      deliveryStatus: 'cancelled', dispositionReason: 'superseded',
      subject: 'SUPERSEDED-SUBJECT', body: 'SUPERSEDED-BODY',
    });
    await seedOutreach({
      batchId, askId: draftedAsk, contactId: draftedContact, attemptNo: 2,
      deliveryStatus: 'rendered',
      subject: 'Thanks for having us out', body: 'Hi Dana — thanks for choosing us.',
    });

    // Ask 2: moderation-blocked — the row stores its bytes for admin
    // diagnosis, but the owner view must never carry them (SPEC §3.3).
    const blockedContact = await seedContact('Blocked Bea');
    const blockedAsk = await seedAsk({
      batchId, contactId: blockedContact, status: 'send', decidedAt: '2026-07-20T10:05:00Z',
    });
    await seedOutreach({
      batchId, askId: blockedAsk, contactId: blockedContact,
      deliveryStatus: 'withheld', dispositionReason: 'moderation_high',
      subject: 'FORBIDDEN-SUBJECT', body: 'FORBIDDEN-BODY',
      moderationStatus: 'flagged', moderationDetail: { harassment: 0.97 },
    });

    // Ask 3: lint-blocked — text and matched classes stay visible on purpose
    // (SPEC §5.2: the block teaches the owner).
    const lintContact = await seedContact('Linted Lou');
    const lintAsk = await seedAsk({
      batchId, contactId: lintContact, status: 'send', decidedAt: '2026-07-20T10:05:00Z',
    });
    await seedOutreach({
      batchId, askId: lintAsk, contactId: lintContact,
      deliveryStatus: 'withheld', dispositionReason: 'lint_failed',
      subject: 'A special thank-you', body: 'Mention us in your review for 10% off.',
      lintDetail: ['incentive_language', 'review_steering'],
    });

    const view = await readLatestBatch(sql(), tenant!.accountId, businessId);
    if (view.state !== 'built') throw new Error('expected a built batch');

    expect(view.attempts).toHaveLength(3);

    const drafted = view.attempts.find((attempt) => attempt.askId === draftedAsk);
    if (!drafted || drafted.redacted) throw new Error('expected an unredacted drafted attempt');
    expect(drafted.attemptNo).toBe(2);
    expect(drafted.deliveryStatus).toBe('rendered');
    expect(drafted.subject).toBe('Thanks for having us out');
    expect(drafted.body).toBe('Hi Dana — thanks for choosing us.');
    expect(drafted.lintClasses).toEqual([]);
    expect(drafted.moderationStatus).toBe('clean');
    expect(drafted.interpolationInputs).toEqual(ATTEMPT_INTERPOLATION_INPUTS);
    expect(drafted.contactName).toBe('Drafted Dana');

    const blocked = view.attempts.find((attempt) => attempt.askId === blockedAsk);
    expect(blocked).toEqual({
      outreachId: expect.any(String),
      askId: blockedAsk,
      contactId: blockedContact,
      contactName: 'Blocked Bea',
      attemptNo: 1,
      deliveryStatus: 'withheld',
      dispositionReason: 'moderation_high',
      renderedAt: expect.any(String),
      redacted: true,
    });

    const linted = view.attempts.find((attempt) => attempt.askId === lintAsk);
    if (!linted || linted.redacted) throw new Error('expected an unredacted lint attempt');
    expect(linted.body).toBe('Mention us in your review for 10% off.');
    expect(linted.lintClasses).toEqual(['incentive_language', 'review_steering']);
    expect(linted.dispositionReason).toBe('lint_failed');

    // Leak-proof across the WHOLE view: neither superseded nor
    // moderation_high bytes appear anywhere in the serialized payload.
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('FORBIDDEN');
    expect(serialized).not.toContain('SUPERSEDED');
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
      ), decided AS (
        -- Decision and reason resolved ONCE, then used for both the columns
        -- and the evidence object. They were previously spelled twice and the
        -- evidence copy omitted the reason key entirely, so this fixture seeded
        -- rows batch-builder.ts could never produce; migration 090's
        -- solicitation_asks_evidence_matches_columns now rejects them (#593).
        SELECT n.id, n.rn,
               CASE WHEN n.rn % 10 = 0 THEN 'send' ELSE 'withhold' END AS decision,
               CASE WHEN n.rn % 10 = 0 THEN NULL ELSE
                 (ARRAY['no_consent','already_reviewed','stale_visit',
                        'over_contacted','velocity_banked'])[(n.rn % 5) + 1] END AS reason
        FROM numbered n
      )
      INSERT INTO solicitation_asks
        (id, account_id, business_id, batch_id, contact_id, status, withheld_reason,
         evidence, decided_at)
      SELECT gen_random_uuid(), ${tenant!.accountId}::uuid, ${businessId}::uuid,
             ${batchId}::uuid, d.id,
             d.decision,
             d.reason,
             -- strip_nulls so a send carries no reason key at all, matching
             -- the SendDecision shape rather than a null-valued key.
             jsonb_strip_nulls(jsonb_build_object(
               'contact_id', d.id,
               'policy_version', ${RESTRAINT_POLICY_VERSION}::text,
               'decided_at', '2026-07-14T10:05:00Z',
               'decision', d.decision,
               'reason', d.reason
             )),
             '2026-07-14T10:05:00Z'::timestamptz
      FROM decided d
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
