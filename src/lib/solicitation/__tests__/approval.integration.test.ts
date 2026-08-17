import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  acquireLiveDbLock,
  assertLocalTestDatabaseUrl,
  LIVE_DB_LOCK_HOOK_TIMEOUT_MS,
  resolveTestDatabaseUrl,
  type LiveDbLock,
} from '@/lib/shared/__tests__/helpers/live-db-lock';
import {
  assertSchemaReady,
  MIGRATION_091_SEND_MODE_SPINE_LIFECYCLE,
  MIGRATION_108_OUTREACH_OWNER_EXCLUDED,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import {
  cleanupTenantAccount,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import { checksum, insertOutreach } from '@/lib/shared/__tests__/helpers/outreach-fixture';
import { acquireSolicitationBatchLock } from '../batch-builder';
import { insertOutreachRender, type InsertOutreachRenderInput } from '../outreach';
import { approveBatch } from '../approval';

// Live-DB suite for the owner approval writer (#629 T3). Applies NO migration
// SQL: `pnpm test:db:setup` provisions the schema and this file asserts it with
// assertSchemaReady (#573). It holds the cross-process live-DB lock because the
// interleaving case depends on two of its OWN connections contending on one
// batch's advisory lock — an unrelated writer in another vitest process would
// make that interleaving unreadable.
//
// Every lifecycle timestamp is written as a SQL interval off NOW(), never as a
// JS `Date`: postgres.js truncates timestamptz microseconds, so a JS-derived
// `built_at` can land before the NOW()-defaulted `created_at` it must not
// precede and trip a constraint that has nothing to do with the case under test.

const testDatabaseUrl = resolveTestDatabaseUrl();
const businessId = randomUUID();

let db: postgresType.Sql | undefined;
// The interleaving case holds an uncommitted child-render transaction open
// while the approval blocks on the same advisory key. That needs a SECOND
// connection: `approveBatch` is handed the pooled handle, and a pool whose only
// free connection is the one holding the lock deadlocks against itself.
let writerDb: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;
let tenant: TenantSeed | undefined;

function sql(): postgresType.Sql {
  if (!db) throw new Error('approval integration database was not initialized');
  return db;
}

function writerSql(): postgresType.Sql {
  if (!writerDb) throw new Error('approval integration writer connection was not initialized');
  return writerDb;
}

function accountId(): string {
  if (!tenant) throw new Error('approval integration tenant was not seeded');
  return tenant.accountId;
}

function userId(): string {
  if (!tenant) throw new Error('approval integration tenant was not seeded');
  return tenant.userId;
}

async function seedUpload(): Promise<string> {
  const uploadId = randomUUID();
  await sql()`
    INSERT INTO contact_csv_uploads (
      id, account_id, business_id, filename, byte_size, content_sha256,
      raw_csv, status, report, attested_by_user_id, attested_at,
      attestation_version, completed_at
    ) VALUES (
      ${uploadId}::uuid, ${accountId()}::uuid, ${businessId}::uuid,
      ${`approval-${uploadId}.csv`}, 1, ${checksum(uploadId)},
      NULL, 'completed', ${sql().json({ accepted: 1 })},
      ${userId()}::uuid, NOW(), 'approval-test', NOW()
    )
  `;
  return uploadId;
}

async function seedContact(uploadId: string): Promise<string> {
  const contactId = randomUUID();
  await sql()`
    INSERT INTO solicitation_contacts (
      id, business_id, name, email, created_by_upload_id
    ) VALUES (
      ${contactId}::uuid, ${businessId}::uuid, 'Approval Candidate',
      ${`${contactId}@example.test`}, ${uploadId}::uuid
    )
  `;
  return contactId;
}

/** One batch under the seeded business. `created_at` is anchored 40 days back
 *  so any `built_at` a case needs still satisfies the built-after-created arm. */
async function seedBatch(builtAgo: string): Promise<{ batchId: string; uploadId: string }> {
  const uploadId = await seedUpload();
  const batchId = randomUUID();
  await sql()`
    INSERT INTO solicitation_batches (
      id, account_id, business_id, source_upload_id, created_at, built_at
    ) VALUES (
      ${batchId}::uuid, ${accountId()}::uuid, ${businessId}::uuid,
      ${uploadId}::uuid, NOW() - INTERVAL '40 days', NOW() - ${builtAgo}::interval
    )
  `;
  return { batchId, uploadId };
}

async function seedSendParent(batchId: string): Promise<string> {
  const runId = randomUUID();
  await sql()`
    INSERT INTO agent_runs (
      id, account_id, business_id, kind, subject_type, subject_id,
      status, started_at, correlation_id
    ) VALUES (
      ${runId}::uuid, ${accountId()}::uuid, ${businessId}::uuid,
      'solicitation_send_batch', 'solicitation_batch', ${batchId},
      'running', NOW() - INTERVAL '1 minute', 'approval-integration'
    )
  `;
  return runId;
}

interface SeededAsk {
  askId: string;
  contactId: string;
}

/** One `send` ask with its own contact — the live-attempt index is per-ask. */
async function seedSendAsk(batchId: string, uploadId: string): Promise<SeededAsk> {
  const contactId = await seedContact(uploadId);
  const askId = randomUUID();
  await sql()`
    INSERT INTO solicitation_asks (
      id, account_id, business_id, batch_id, contact_id, status,
      withheld_reason, evidence, decided_at
    ) VALUES (
      ${askId}::uuid, ${accountId()}::uuid, ${businessId}::uuid,
      ${batchId}::uuid, ${contactId}::uuid, 'send', NULL,
      ${sql().json({
        contact_id: contactId,
        policy_version: 'approval-fixture',
        decision: 'send',
      })},
      NOW()
    )
  `;
  return { askId, contactId };
}

interface AttemptInput {
  batchId: string;
  ask: SeededAsk;
  deliveryStatus: 'rendered' | 'withheld' | 'cancelled';
  dispositionReason?: string | null;
  attemptNo?: number;
}

/** One attempt row on an existing ask. Withheld rows are seeded bodyless, the
 *  shape the render lane writes for `render_failed`; every other status keeps
 *  its bodies because `solicitation_outreach_body_presence` requires them. */
async function seedAttempt(input: AttemptInput): Promise<string> {
  const withheld = input.deliveryStatus === 'withheld';
  return insertOutreach(sql(), {
    accountId: accountId(),
    businessId,
    batchId: input.batchId,
    askId: input.ask.askId,
    contactId: input.ask.contactId,
    attemptNo: input.attemptNo ?? 1,
    ...(withheld ? { renderedSubject: null, renderedBody: null } : {}),
    deliveryStatus: input.deliveryStatus,
    dispositionReason: input.dispositionReason ?? null,
    renderedAt: sql()`NOW() - INTERVAL '1 minute'`,
  });
}

interface RenderedBatch {
  batchId: string;
  uploadId: string;
  accountId: string;
  businessId: string;
  userId: string;
  parentRunId: string;
  asks: SeededAsk[];
  outreachIds: string[];
}

/**
 * A built batch with a send parent and `renders` send asks, each carrying one
 * `rendered` attempt — the state generation leaves behind, and the only state
 * `approveBatch` accepts.
 */
async function seedRenderedBatch(
  options: { renders: number; builtAgo?: string },
): Promise<RenderedBatch> {
  const { batchId, uploadId } = await seedBatch(options.builtAgo ?? '1 hour');
  const parentRunId = await seedSendParent(batchId);
  const asks: SeededAsk[] = [];
  const outreachIds: string[] = [];
  for (let index = 0; index < options.renders; index += 1) {
    const ask = await seedSendAsk(batchId, uploadId);
    asks.push(ask);
    outreachIds.push(await seedAttempt({ batchId, ask, deliveryStatus: 'rendered' }));
  }
  return {
    batchId,
    uploadId,
    accountId: accountId(),
    businessId,
    userId: userId(),
    parentRunId,
    asks,
    outreachIds,
  };
}

/** The render lane's insert payload for an ask that has no attempt yet. */
function renderInput(
  batchId: string,
  ask: SeededAsk,
  parentRunId: string,
  attemptNo = 1,
): InsertOutreachRenderInput {
  return {
    accountId: accountId(),
    businessId,
    batchId,
    askId: ask.askId,
    contactId: ask.contactId,
    attemptNo,
    promptVersion: 'solicitation_ask_v1',
    promptHash: checksum(ask.askId),
    askLintVersion: 'ask_lint_v1',
    lintDetail: [],
    moderationStatus: 'clean',
    moderationDetail: {},
    interpolationInputs: {},
    renderedAt: new Date(),
    agentRunId: parentRunId,
    deliveryStatus: 'rendered',
    renderedSubject: 'How did we do?',
    renderedBody: 'Would you mind leaving a review?',
  };
}

interface BatchApprovalRow {
  approval_method: string | null;
  approved_at: string | null;
  send_closed_at: string | null;
  gap_minutes: number | null;
}

async function readBatch(batchId: string): Promise<BatchApprovalRow> {
  const [row] = await sql()<BatchApprovalRow[]>`
    SELECT approval_method,
           approved_at::text AS approved_at,
           send_closed_at::text AS send_closed_at,
           EXTRACT(EPOCH FROM (veto_deadline_at - approved_at))::int / 60 AS gap_minutes
    FROM solicitation_batches
    WHERE id = ${batchId}::uuid
      AND account_id = ${accountId()}::uuid
      AND business_id = ${businessId}::uuid
  `;
  return row!;
}

interface OutreachRow {
  id: string;
  delivery_status: string;
  disposition_reason: string | null;
}

async function readOutreach(batchId: string): Promise<OutreachRow[]> {
  return sql()<OutreachRow[]>`
    SELECT id::text AS id, delivery_status, disposition_reason
    FROM solicitation_outreach
    WHERE batch_id = ${batchId}::uuid
      AND account_id = ${accountId()}::uuid
      AND business_id = ${businessId}::uuid
    ORDER BY attempt_no, id
  `;
}

interface StepRow {
  step_key: string;
  attributed_agent: string;
  detail: unknown;
}

async function readSteps(runId: string, stepKey: string): Promise<StepRow[]> {
  return sql()<StepRow[]>`
    SELECT step_key, attributed_agent, detail
    FROM agent_run_steps
    WHERE agent_run_id = ${runId}::uuid
      AND step_key = ${stepKey}
    ORDER BY step_index
  `;
}

/** Postgres.js behind PgBouncer can hand back JSONB as a string. */
function stepDetail(row: StepRow): Record<string, unknown> {
  const parsed: unknown = typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail;
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('agent_run_steps detail is not an object');
  }
  return parsed as Record<string, unknown>;
}

async function readRunStatus(runId: string): Promise<string> {
  const [row] = await sql()<{ status: string }[]>`
    SELECT status FROM agent_runs
    WHERE id = ${runId}::uuid
      AND account_id = ${accountId()}::uuid
      AND business_id = ${businessId}::uuid
  `;
  return row!.status;
}

describeWithDb('approveBatch', { enabled: Boolean(testDatabaseUrl), timeout: 90_000 }, () => {
  beforeAll(async () => {
    const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
    featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
    db = postgres(databaseUrl, { max: 4, prepare: false });
    writerDb = postgres(databaseUrl, { max: 2, prepare: false });
    await assertSchemaReady(db, [
      MIGRATION_091_SEND_MODE_SPINE_LIFECYCLE,
      MIGRATION_108_OUTREACH_OWNER_EXCLUDED,
    ]);
    tenant = await seedTenantAccount(db, {
      userName: 'Approval Owner',
      accountDisplayName: 'Approval Account',
    });
    await db`
      INSERT INTO businesses (
        id, name, owner_name, owner_email, account_id,
        subscription_status, category
      ) VALUES (
        ${businessId}::uuid, 'Approval Business', 'Approval Owner',
        ${tenant.ownerEmail}, ${tenant.accountId}::uuid, 'active', 'automotive'
      )
    `;
  }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

  afterEach(async () => {
    await sql()`DELETE FROM solicitation_outreach WHERE business_id = ${businessId}::uuid`;
    await sql()`DELETE FROM solicitation_asks WHERE business_id = ${businessId}::uuid`;
    await sql()`DELETE FROM solicitation_batches WHERE business_id = ${businessId}::uuid`;
    await sql()`DELETE FROM solicitation_contacts WHERE business_id = ${businessId}::uuid`;
    await sql()`DELETE FROM contact_csv_uploads WHERE business_id = ${businessId}::uuid`;
    await sql()`
      DELETE FROM agent_runs
      WHERE account_id = ${accountId()}::uuid
        AND business_id = ${businessId}::uuid
    `;
  }, 30_000);

  afterAll(async () => {
    try {
      if (db) {
        await db`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
        if (tenant) await cleanupTenantAccount(db, tenant);
      }
    } finally {
      try {
        if (writerDb) await writerDb.end({ timeout: 5 });
        if (db) await db.end({ timeout: 5 });
      } finally {
        await featureDatabaseLock?.release();
        featureDatabaseLock = undefined;
      }
    }
  }, 120_000);

  it('approves a built batch with owner method and a 15-minute veto deadline', async () => {
    const { batchId, accountId: account, businessId: business, userId: owner } =
      await seedRenderedBatch({ renders: 3 });

    const result = await approveBatch(sql(), {
      batchId,
      accountId: account,
      businessId: business,
      approvedByUserId: owner,
      excludedOutreachIds: [],
    });

    expect(result).toMatchObject({ status: 'approved', approvedCount: 3, excludedCount: 0 });
    const row = await readBatch(batchId);
    expect(row.approval_method).toBe('owner');
    expect(row.gap_minutes).toBe(15);
  });

  it('a second approval writes nothing and reports the batch as already approved', async () => {
    const { batchId, accountId: account, businessId: business, userId: owner } =
      await seedRenderedBatch({ renders: 2 });
    const call = (): Promise<unknown> =>
      approveBatch(sql(), {
        batchId,
        accountId: account,
        businessId: business,
        approvedByUserId: owner,
        excludedOutreachIds: [],
      });

    const first = await call();
    const approvedAt = (await readBatch(batchId)).approved_at;
    const second = await call();

    expect(first).toMatchObject({ status: 'approved', approvedCount: 2 });
    expect(second).toEqual({ status: 'already_approved' });
    // The CAS is what makes a double-submit inert: a second approval would
    // otherwise restamp approved_at and hand the owner a fresh veto window.
    expect((await readBatch(batchId)).approved_at).toBe(approvedAt);
  });

  it('cancels excluded asks owner_excluded in the same transaction as the approval', async () => {
    const { batchId, accountId: account, businessId: business, userId: owner, outreachIds } =
      await seedRenderedBatch({ renders: 3 });

    const result = await approveBatch(sql(), {
      batchId,
      accountId: account,
      businessId: business,
      approvedByUserId: owner,
      excludedOutreachIds: [outreachIds[0]!],
    });

    expect(result).toMatchObject({ status: 'approved', approvedCount: 2, excludedCount: 1 });
    const rows = await readOutreach(batchId);
    const excluded = rows.find((row) => row.id === outreachIds[0]!);
    expect(excluded).toMatchObject({
      delivery_status: 'cancelled',
      disposition_reason: 'owner_excluded',
    });
    expect(rows.filter((row) => row.delivery_status === 'rendered')).toHaveLength(2);
  });

  it('refuses to approve while a send ask has no outreach row', async () => {
    const {
      batchId,
      uploadId,
      accountId: account,
      businessId: business,
      userId: owner,
      parentRunId,
    } = await seedRenderedBatch({ renders: 2 });
    // A third send ask whose render has not landed yet — generation is still
    // in flight, so approving now would let it render AFTER approval.
    const bareAsk = await seedSendAsk(batchId, uploadId);
    const approve = (): Promise<unknown> =>
      approveBatch(sql(), {
        batchId,
        accountId: account,
        businessId: business,
        approvedByUserId: owner,
        excludedOutreachIds: [],
      });

    expect(await approve()).toEqual({ status: 'not_ready', missingRenders: 1 });
    expect((await readBatch(batchId)).approved_at).toBeNull();

    // Committing the missing render is the ONLY thing that changes: the gate is
    // pinned to the committed render set, not to a client-supplied count.
    await seedAttempt({ batchId, ask: bareAsk, deliveryStatus: 'rendered' });

    expect(await approve()).toMatchObject({ status: 'approved', approvedCount: 3 });
    expect(await readSteps(parentRunId, 'batch_approved')).toHaveLength(1);
  });

  it(
    'blocks approval on the batch lock until an in-flight render commits, then counts it',
    async () => {
      const {
        batchId,
        uploadId,
        accountId: account,
        businessId: business,
        userId: owner,
        parentRunId,
      } = await seedRenderedBatch({ renders: 2 });
      const thirdAsk = await seedSendAsk(batchId, uploadId);

      // A: hold the child-render transaction open, exactly as persistChildRender
      // does — advisory lock, then the insert, no commit yet.
      let signalAReady!: () => void;
      const aReady = new Promise<void>((resolve) => {
        signalAReady = resolve;
      });
      let releaseA!: () => void;
      const aHeld = new Promise<void>((resolve) => {
        releaseA = resolve;
      });
      const aDone = writerSql().begin(async (tx) => {
        await acquireSolicitationBatchLock(tx, business);
        await insertOutreachRender(tx, renderInput(batchId, thirdAsk, parentRunId));
        signalAReady();
        await aHeld; // hold the lock
      });

      let settled = false;
      let bDone: Promise<unknown> | undefined;
      try {
        // Launching B without this handshake tests nothing: whichever
        // connection reaches the advisory key first wins, and B winning
        // produces a green `settled === false` for the wrong reason.
        // Racing against `aDone` surfaces an A that died before signalling
        // instead of hanging until the suite timeout.
        await Promise.race([aReady, aDone]);

        // B: approval must BLOCK on the advisory lock, not read past it.
        bDone = approveBatch(sql(), {
          batchId,
          accountId: account,
          businessId: business,
          approvedByUserId: owner,
          excludedOutreachIds: [],
        }).then((result) => {
          settled = true;
          return result;
        });

        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(settled).toBe(false); // still waiting on A
      } finally {
        releaseA();
        // Never leak the held transaction, whatever the assertion above did.
        await Promise.allSettled([aDone, bDone ?? Promise.resolve()]);
      }

      // Approval saw the COMMITTED set: three renders, none missed. A torn read
      // would have answered `not_ready` (uncommitted insert invisible) or
      // approved a count of 2 — this is the serialized-snapshot property.
      expect(await bDone).toMatchObject({ status: 'approved', approvedCount: 3 });
    },
    30_000,
  );

  it('refuses to approve a batch past its 7-day approval window', async () => {
    const { batchId, accountId: account, businessId: business, userId: owner } =
      await seedRenderedBatch({ renders: 1, builtAgo: '8 days' });

    const result = await approveBatch(sql(), {
      batchId,
      accountId: account,
      businessId: business,
      approvedByUserId: owner,
      excludedOutreachIds: [],
    });

    expect(result).toEqual({ status: 'not_approvable', state: 'expired' });
    expect((await readBatch(batchId)).approved_at).toBeNull();
  });

  it('excluding every ask closes the batch and terminalizes the send parent completed', async () => {
    const {
      batchId,
      accountId: account,
      businessId: business,
      userId: owner,
      parentRunId,
      outreachIds,
    } = await seedRenderedBatch({ renders: 3 });

    const result = await approveBatch(sql(), {
      batchId,
      accountId: account,
      businessId: business,
      approvedByUserId: owner,
      excludedOutreachIds: outreachIds,
    });

    expect(result).toMatchObject({
      status: 'approved',
      approvedCount: 0,
      excludedCount: 3,
      close: { status: 'closed', disposition: 'exhausted', parentStatus: 'completed' },
    });
    expect((await readBatch(batchId)).send_closed_at).not.toBeNull();
    expect(await readRunStatus(parentRunId)).toBe('completed');

    // The disposition is what distinguishes a correct close from a
    // coincidentally-correct parent status: `cancelled` and `expired` both
    // terminalize somewhere, and only one of them is right here.
    const closeSteps = await readSteps(parentRunId, 'send_batch_closed');
    expect(closeSteps).toHaveLength(1);
    expect(stepDetail(closeSteps[0]!)).toMatchObject({ disposition: 'exhausted', cancelled: 3 });
  });

  it('records the approval as a step on the send batch parent', async () => {
    const { batchId, accountId: account, businessId: business, userId: owner, parentRunId } =
      await seedRenderedBatch({ renders: 3 });

    await approveBatch(sql(), {
      batchId,
      accountId: account,
      businessId: business,
      approvedByUserId: owner,
      excludedOutreachIds: [],
    });

    const steps = await readSteps(parentRunId, 'batch_approved');
    expect(steps).toHaveLength(1);
    expect(steps[0]!.attributed_agent).toBe('solicitation');
    expect(stepDetail(steps[0]!)).toMatchObject({
      approval_method: 'owner',
      approved_by_user_id: owner,
      approved_count: 3,
      excluded_count: 0,
      veto_window_minutes: 15,
    });
  });

  it('refuses a stale exclusion list without cancelling any row or approving the batch', async () => {
    const {
      batchId,
      uploadId,
      accountId: account,
      businessId: business,
      userId: owner,
      outreachIds,
    } = await seedRenderedBatch({ renders: 2 });
    // A withheld row is a FINISHED attempt: it satisfies readiness but is not
    // approvable copy, so its id is not a live rendered row of this batch.
    const withheldAsk = await seedSendAsk(batchId, uploadId);
    const withheldId = await seedAttempt({
      batchId,
      ask: withheldAsk,
      deliveryStatus: 'withheld',
      dispositionReason: 'lint_failed',
    });

    const result = await approveBatch(sql(), {
      batchId,
      accountId: account,
      businessId: business,
      approvedByUserId: owner,
      excludedOutreachIds: [outreachIds[0]!, withheldId],
    });

    // Validate-then-mutate: postgres.js commits when the callback resolves, so
    // a validate-AFTER-write implementation would have committed the valid
    // row's cancellation while reporting the approval refused.
    expect(result).toEqual({ status: 'unknown_exclusion' });
    expect((await readBatch(batchId)).approved_at).toBeNull();
    const rows = await readOutreach(batchId);
    expect(rows.find((row) => row.id === outreachIds[0]!)!.delivery_status).toBe('rendered');
    expect(rows.find((row) => row.id === withheldId)!.delivery_status).toBe('withheld');
  });

  it('approves the rendered subset when another send ask is withheld', async () => {
    const { batchId, uploadId, accountId: account, businessId: business, userId: owner } =
      await seedRenderedBatch({ renders: 1 });
    const withheldAsk = await seedSendAsk(batchId, uploadId);
    const withheldId = await seedAttempt({
      batchId,
      ask: withheldAsk,
      deliveryStatus: 'withheld',
      dispositionReason: 'lint_failed',
    });

    const result = await approveBatch(sql(), {
      batchId,
      accountId: account,
      businessId: business,
      approvedByUserId: owner,
      excludedOutreachIds: [],
    });

    // Readiness is "non-cancelled", not "rendered" — requiring `rendered` would
    // wedge every batch that had one lint failure.
    expect(result).toMatchObject({ status: 'approved', approvedCount: 1, excludedCount: 0 });
    const withheld = (await readOutreach(batchId)).find((row) => row.id === withheldId);
    expect(withheld).toMatchObject({
      delivery_status: 'withheld',
      disposition_reason: 'lint_failed',
    });
  });

  it('treats a superseded attempt as ready only once its replacement exists', async () => {
    const { batchId, uploadId, accountId: account, businessId: business, userId: owner } =
      await seedRenderedBatch({ renders: 1 });
    // A cancelled attempt is the ONE status that leaves a hole: its replacement
    // has not been written yet, so the ask still owes a render.
    const supersededAsk = await seedSendAsk(batchId, uploadId);
    await seedAttempt({
      batchId,
      ask: supersededAsk,
      deliveryStatus: 'cancelled',
      dispositionReason: 'superseded',
      attemptNo: 1,
    });
    const approve = (): Promise<unknown> =>
      approveBatch(sql(), {
        batchId,
        accountId: account,
        businessId: business,
        approvedByUserId: owner,
        excludedOutreachIds: [],
      });

    expect(await approve()).toEqual({ status: 'not_ready', missingRenders: 1 });

    const replacementId = await seedAttempt({
      batchId,
      ask: supersededAsk,
      deliveryStatus: 'rendered',
      attemptNo: 2,
    });

    expect(await approve()).toMatchObject({ status: 'approved', approvedCount: 2 });
    const rendered = (await readOutreach(batchId))
      .filter((row) => row.delivery_status === 'rendered')
      .map((row) => row.id);
    expect(rendered).toContain(replacementId);
  });
});

describe('haltBatch', () => {
  it.todo('halt latches once and a second halt writes nothing');
  it.todo('halt cancels rendered and queued rows and never a sending row');
  it.todo('halt before sending starts records owner_veto and after it records owner_halt');
  it.todo('refuses to halt a batch that is already closed');
  it.todo('halts a built batch that was never approved');
});

describe('tenant scope', () => {
  it.todo('refuses to approve or halt a batch owned by another account');
});
