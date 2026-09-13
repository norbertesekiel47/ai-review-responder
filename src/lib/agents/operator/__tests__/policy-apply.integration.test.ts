// Real policy writer + proposal transaction, following apply.integration.test.ts.
// Separate from that voice suite because these fixtures exercise account locks,
// policy inheritance and approval audits. No runtime DDL or mocked writers.
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import { completeRun, recordStep, startOrGetActiveRun } from '@/lib/agents/run-spine';
import { AUDIT_ACTION_AUTO_APPROVED_BY_POLICY } from '@/lib/approval/audit';
import { patchAutoApprovalSettings, patchAutoApprovalSettingsInTransaction } from '@/lib/auto-approval/settings';
import { POLICY_ACTION_POSTING, POLICY_PERSONA_REPLY } from '@/lib/auto-approval/types';
import { resetServerConfigForTests } from '@/lib/config/server';
import { readVoiceConfig } from '@/lib/responses/voice-settings';
import { REVIEW_STATUS } from '@/lib/reviews/status';
import { abortingExecutor } from '@/lib/shared/__tests__/helpers/abort-injection';
import {
  acquireLiveDbLock, assertLocalTestDatabaseUrl, LIVE_DB_LOCK_HOOK_TIMEOUT_MS,
  resolveTestDatabaseUrl, type LiveDbLock,
} from '@/lib/shared/__tests__/helpers/live-db-lock';
import { assertSchemaReady, MIGRATION_120_OWNER_OPERATOR } from '@/lib/shared/__tests__/helpers/schema-ready';
import { cleanupTenantAccount, seedLocation, seedTenantAccount, type TenantSeed } from '@/lib/shared/__tests__/live-db-tenant';
import { applyProposal } from '../apply';
import { proposableOperation } from '../catalog';
import { readPolicySnapshot } from '../policy-state';
import { buildProposalRows, insertProposals, readProposalForAccount, type ProposalRow } from '../proposals';
import { createTurn } from '../turns';

const databaseUrl = resolveTestDatabaseUrl();
let db: postgres.Sql;
let writer: postgres.Sql;
let suiteLock: LiveDbLock | undefined;
let tenant: TenantSeed;
let locationId: string;
let secondLocationId: string;
const writerName = `operator-policy-${randomUUID()}`;

function actor() {
  return { accountId: tenant.accountId, actorUserId: tenant.userId, impersonated: false };
}

async function seedPolicy(target: string | null, threshold: 4 | 5 | null = 4) {
  await db`
    INSERT INTO auto_approval_policies
      (id, account_id, location_id, persona, action_class, auto_approve_min_star,
       veto_window_minutes, daily_auto_post_cap)
    VALUES (${randomUUID()}::uuid, ${tenant.accountId}::uuid, ${target}::uuid,
      ${POLICY_PERSONA_REPLY}, ${POLICY_ACTION_POSTING}, ${threshold}, 30, 2)
  `;
}

async function prepare(operationId: string, input: Record<string, unknown>, target: string | null) {
  const turn = await createTurn(db, {
    accountId: tenant.accountId, actorUserId: tenant.userId, locationId,
    conversationId: randomUUID(), clientTurnKey: randomUUID(), text: 'Change the rule for this scope.',
  });
  if (turn.kind !== 'created') throw new Error(`fixture turn: ${turn.kind}`);
  const operation = proposableOperation(operationId);
  if (!operation) throw new Error('fixture operation missing');
  const parsed = operation.parseInput(input);
  if (!parsed.ok) throw new Error('fixture input invalid');
  const voice = await readVoiceConfig(db, { accountId: tenant.accountId, locationId });
  const snapshot = await readPolicySnapshot(db, { accountId: tenant.accountId, locationId: target });
  if (!voice || !snapshot) throw new Error('fixture scope missing');
  const rows = buildProposalRows(
    { ...actor(), conversationId: turn.conversationId, turnId: turn.turnId, locationId },
    [{ operation, input: parsed.input, scope: { accountId: tenant.accountId, ...(target ? { locationId: target } : {}) }, rationale: 'Owner requested this rule.' }],
    voice, new Map([[target, { snapshot, blockReasons: [] }]]),
  );
  await db.begin(async (tx) => { await insertProposals(tx, rows); });
  return rows[0]!;
}

function apply(row: ProposalRow, confirmationLevel?: string, executor = db) {
  return applyProposal(executor, {
    ...actor(), proposalId: row.id, expectedVersionToken: row.preparedVersionToken, confirmationLevel,
  });
}

async function footprint() {
  const [row] = await db<{ policies: number; audits: number; costs: number; posted: number }[]>`
    SELECT
      (SELECT COUNT(*)::int FROM auto_approval_policies WHERE account_id = ${tenant.accountId}::uuid) AS policies,
      (SELECT COUNT(*)::int FROM account_audit_log WHERE account_id = ${tenant.accountId}::uuid) AS audits,
      (SELECT COUNT(*)::int FROM api_costs WHERE account_id = ${tenant.accountId}::uuid) AS costs,
      (SELECT COUNT(*)::int FROM responses r JOIN businesses b ON b.id = r.business_id
       WHERE b.account_id = ${tenant.accountId}::uuid AND r.status = 'posted') AS posted
  `;
  if (!row) throw new Error('fixture counts missing');
  return row;
}

async function seedReview(stars: number, origin?: 'live' | 'imported') {
  const id = randomUUID();
  await db`
    INSERT INTO reviews (id, business_id, provider, provider_review_id, provider_review_name,
      provider_location_name, reviewer_name, star_rating, review_text, detected_at, status)
    VALUES (${id}::uuid, ${locationId}::uuid, 'zernio', ${id}, ${`fixture/${id}`},
      'fixture/location', 'Fixture reviewer', ${stars}, 'Fixture review',
      date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' - interval '12 hours', ${REVIEW_STATUS.NEW})
  `;
  if (origin) await db.begin(async (tx) => {
    const run = await startOrGetActiveRun(tx, {
      accountId: tenant.accountId, businessId: locationId, kind: 'review_handler', subjectType: 'review', subjectId: id,
    });
    await recordStep(tx, { runId: run.runId, stepKey: 'review_ingested', detail: { ingestion_origin: origin } });
    await completeRun(tx, run.runId, 'completed');
  });
  return id;
}

async function grantVeto(reviewId: string) {
  const responseId = randomUUID();
  await db`
    INSERT INTO responses (id, review_id, business_id, response_text, original_draft_text, version,
      status, approval_method, approved_at, approved_text)
    VALUES (${responseId}::uuid, ${reviewId}::uuid, ${locationId}::uuid,
      'Fixture reply', 'Fixture reply', 1, 'approved', 'auto_policy', NOW(), 'Fixture reply')
  `;
  await db`
    INSERT INTO approval_audit_log
      (id, response_id, business_id, account_id, action, metadata, auth_method, response_text_at_approval)
    VALUES (${randomUUID()}::uuid, ${responseId}::uuid, ${locationId}::uuid, ${tenant.accountId}::uuid,
      ${AUDIT_ACTION_AUTO_APPROVED_BY_POLICY}, ${db.json({ veto_window_minutes: 30 })}, 'auto_policy', 'Fixture reply')
  `;
}

async function blockedQuery(tx: postgres.TransactionSql, holderPid: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await tx`SELECT pg_stat_clear_snapshot()`;
    const [row] = await tx<{ query: string }[]>`
      SELECT query FROM pg_stat_activity
      WHERE application_name = ${writerName} AND wait_event_type = 'Lock'
        AND ${holderPid}::int = ANY(pg_blocking_pids(pid))
    `;
    if (row) return row.query;
  }
  throw new Error('Apply did not wait on the settings transaction');
}

describeWithDb('Operator policy Apply (live DB)', { enabled: Boolean(databaseUrl), timeout: 30_000 }, () => {
  beforeAll(async () => {
    const url = assertLocalTestDatabaseUrl(databaseUrl);
    suiteLock = await acquireLiveDbLock(url);
    db = postgres(url, { max: 3, prepare: false, connection: { statement_timeout: 15_000 } });
    writer = postgres(url, { max: 1, prepare: false, connection: { application_name: writerName, statement_timeout: 15_000 } });
    await assertSchemaReady(db, [MIGRATION_120_OWNER_OPERATOR]);
  }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

  beforeEach(async () => {
    for (const flag of ['OWNER_OPERATOR_ENABLED', 'AUTO_APPROVAL_ENABLED', 'AUTOPILOT_PURCHASABLE',
      'OPENAI_MODERATION_ENABLED', 'AUTO_APPROVAL_PROVIDER_MODERATION_READY']) vi.stubEnv(flag, 'true');
    vi.stubEnv('VERCEL_TARGET_ENV', 'test');
    resetServerConfigForTests();
    tenant = await seedTenantAccount(db, { subscriptionTier: 'autopilot' });
    locationId = (await seedLocation(db, tenant.accountId)).businessId;
    secondLocationId = (await seedLocation(db, tenant.accountId, { isPrimary: false })).businessId;
  });

  afterEach(async () => {
    try {
      if (!tenant) return;
      await db`DELETE FROM job_outbox WHERE payload->>'account_id' = ${tenant.accountId}`;
      await db`DELETE FROM agent_proposals WHERE account_id = ${tenant.accountId}::uuid`;
      await db`DELETE FROM agent_turns WHERE account_id = ${tenant.accountId}::uuid`;
      await db`DELETE FROM agent_conversations WHERE account_id = ${tenant.accountId}::uuid`;
      await db`DELETE FROM agent_runs WHERE account_id = ${tenant.accountId}::uuid`;
      await db`DELETE FROM approval_audit_log WHERE account_id = ${tenant.accountId}::uuid`;
      await db`DELETE FROM responses WHERE business_id IN (SELECT id FROM businesses WHERE account_id = ${tenant.accountId}::uuid)`;
      await db`DELETE FROM reviews WHERE business_id IN (SELECT id FROM businesses WHERE account_id = ${tenant.accountId}::uuid)`;
      await db`DELETE FROM auto_approval_policies WHERE account_id = ${tenant.accountId}::uuid`;
      await db`DELETE FROM account_audit_log WHERE account_id = ${tenant.accountId}::uuid`;
      await db`DELETE FROM businesses WHERE account_id = ${tenant.accountId}::uuid`;
      await cleanupTenantAccount(db, tenant);
    } finally { vi.unstubAllEnvs(); resetServerConfigForTests(); }
  });

  afterAll(async () => {
    try { await writer?.end({ timeout: 5 }); await db?.end({ timeout: 5 }); }
    finally { await suiteLock?.release(); }
  }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

  it('exact account phrase applies once, with hand-counted consequences, retained veto, and no posting or cost', async () => {
    await seedPolicy(null, null);
    const fiveStar = await seedReview(5, 'live');
    await seedReview(4, 'live');
    await seedReview(2, 'live');
    await seedReview(5, 'imported');
    await seedReview(5);
    await grantVeto(fiveStar);
    const row = await prepare('set_auto_reply_scope', { threshold: 4 }, null);
    const before = await footprint();
    for (const phrase of [undefined, 'all locations ', 'All locations', '4 and 5 star', 'off']) {
      expect((await apply(row, phrase)).kind).toBe('confirmation_mismatch');
      expect(await footprint()).toEqual(before);
    }
    // A newly received review does not change a policy version token. The
    // receipt must recompute its cohort instead of copying the prepared line.
    expect(row.after.consequence).toMatchObject({ total: 3 });
    await seedReview(5, 'live');
    const result = await apply(row, 'all locations');
    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied' || result.proposal.receipt?.affects !== 'future_eligible_reviews') throw new Error('missing policy receipt');
    const receipt = result.proposal.receipt;
    expect(receipt.before.consequence).toMatchObject({ total: 4, eligible: 0, excludedImported: 1, excludedUnknown: 1 });
    expect(receipt.after.consequence).toMatchObject({ total: 4, eligible: 2, held: { below_threshold: 1, cap_reached: 1, manual: 0 } });
    expect(receipt.after.affectedLocationCount).toBe(2);
    expect(receipt.retainedVeto.count).toBe(1);
    expect(receipt.retainedVeto.asOf).toBeTruthy();
    expect(await footprint()).toEqual({ ...before, audits: before.audits + 1 });
    const repeat = await apply(row, 'wrong after settlement');
    expect(repeat).toMatchObject({ kind: 'applied', repeated: true, proposal: { receipt } });
    expect(await footprint()).toEqual({ ...before, audits: before.audits + 1 });
  });

  it('first dial-only override is manual, inherits the other dial, and preserves voice and other-location proposals', async () => {
    await seedPolicy(null);
    const voice = await prepare('set_tone', { tone: 'warm' }, locationId);
    const other = await prepare('set_daily_cap', { cap: 1 }, secondLocationId);
    const row = await prepare('set_veto_window', { minutes: 15 }, locationId);
    const result = await apply(row);
    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied' || result.proposal.receipt?.affects !== 'future_eligible_reviews') throw new Error('missing policy receipt');
    expect(result.proposal.receipt.before).toMatchObject({ threshold: 4, rowExists: false });
    expect(result.proposal.receipt.after).toMatchObject({ threshold: null, rowExists: true, vetoWindowMinutes: 15, dailyAutoPostCap: 2 });
    for (const untouched of [voice, other]) expect(await readProposalForAccount(db, { proposalId: untouched.id, accountId: tenant.accountId })).toMatchObject({ status: 'pending' });
  });

  it('an account-default Apply stales inheriting and overridden location proposals across conversations while voice stays pending', async () => {
    await seedPolicy(null);
    await seedPolicy(secondLocationId);
    const inheriting = await prepare('set_veto_window', { minutes: 15 }, locationId);
    const overridden = await prepare('set_daily_cap', { cap: 1 }, secondLocationId);
    const voice = await prepare('set_tone', { tone: 'warm' }, locationId);
    const account = await prepare('set_daily_cap', { cap: 1 }, null);
    const proposals = [inheriting, overridden, voice, account];
    // Each preparation creates a genuine separate conversation. A sweep
    // limited to the applied card's conversation must fail this fixture.
    expect(new Set(proposals.map((row) => row.conversationId)).size).toBe(4);
    expect(inheriting.before.rowExists).toBe(false);
    expect(overridden.before.rowExists).toBe(true);
    for (const row of proposals) {
      expect(await readProposalForAccount(db, { accountId: tenant.accountId, proposalId: row.id }))
        .toMatchObject({ status: 'pending', receipt: null });
    }

    expect((await apply(account)).kind).toBe('applied');

    for (const row of [inheriting, overridden]) {
      expect(await readProposalForAccount(writer, { accountId: tenant.accountId, proposalId: row.id }))
        .toMatchObject({ status: 'stale', failureReason: 'version_mismatch', receipt: null });
    }
    expect(await readProposalForAccount(writer, { accountId: tenant.accountId, proposalId: voice.id }))
      .toMatchObject({ status: 'pending', failureReason: null, receipt: null });
    const snapshot = await readPolicySnapshot(writer, { accountId: tenant.accountId, locationId: null });
    expect(snapshot?.locations.find((location) => location.id === locationId)?.state.dailyAutoPostCap).toBe(1);
    expect(snapshot?.locations.find((location) => location.id === secondLocationId)?.state.dailyAutoPostCap).toBe(2);
    expect(await footprint()).toEqual({ policies: 2, audits: 1, costs: 0, posted: 0 });
  });

  it('a zero-included-review Apply receipt persists imported and unknown exclusions with the recomputed reporting window', async () => {
    await seedPolicy(null, null);
    await seedReview(5, 'imported');
    await seedReview(5);
    const row = await prepare('set_auto_reply_scope', { threshold: 4 }, null);
    expect(row.after.consequence).toMatchObject({ total: 0, excludedImported: 1, excludedUnknown: 1 });
    // Even with no included reviews, Apply must refresh exclusions rather
    // than copying the prepared empty-cohort result or dropping its metadata.
    await seedReview(4);

    const result = await apply(row, 'all locations');
    expect(result.kind).toBe('applied');
    const stored = await readProposalForAccount(writer, { accountId: tenant.accountId, proposalId: row.id });
    expect(stored?.status).toBe('applied');
    if (result.kind !== 'applied' || stored?.receipt?.affects !== 'future_eligible_reviews') {
      throw new Error('missing persisted policy receipt');
    }
    expect(stored.receipt).toEqual(result.proposal.receipt);
    const { before, after } = stored.receipt;
    expect(before.consequence).toEqual(after.consequence);
    expect(after.consequence).toMatchObject({
      total: 0, eligible: 0, held: { below_threshold: 0, cap_reached: 0, manual: 0 },
      byDay: [], busiestDay: 0, source: 'reviews_received_30d',
      excludedImported: 1, excludedUnknown: 2,
    });
    const { windowStart, windowEnd, asOf } = after.consequence;
    const utcMicroseconds = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
    expect(windowStart).toMatch(utcMicroseconds);
    expect(windowEnd).toMatch(utcMicroseconds);
    expect(asOf).toBe(windowEnd);
    expect(Date.parse(windowEnd) - Date.parse(windowStart)).toBe(30 * 24 * 60 * 60 * 1000);
    expect(before.threshold).toBeNull();
    expect(after.threshold).toBe(4);
    expect(await footprint()).toEqual({ policies: 1, audits: 1, costs: 0, posted: 0 });
  });

  it('readiness rejects expansion while a contraction still commits', async () => {
    await seedPolicy(null, 5);
    const expansion = await prepare('set_auto_reply_scope', { threshold: 4 }, null);
    const contraction = await prepare('set_auto_reply_scope', { threshold: null }, null);
    vi.stubEnv('AUTO_APPROVAL_ENABLED', 'false'); resetServerConfigForTests();
    expect(await apply(expansion, 'all locations')).toMatchObject({ kind: 'blocked' });
    expect(await readProposalForAccount(db, { accountId: tenant.accountId, proposalId: expansion.id }))
      .toMatchObject({ status: 'rejected', readinessBlockReasons: ['auto_approval_disabled', 'autopilot_unavailable'] });
    expect((await footprint()).audits).toBe(0);
    expect((await apply(contraction)).kind).toBe('applied');
  });

  it('a database abort after all writes rolls back policy, audit, sibling statuses and receipt', async () => {
    await seedPolicy(null);
    const first = await prepare('set_daily_cap', { cap: 1 }, locationId);
    const sibling = await prepare('set_veto_window', { minutes: 15 }, locationId);
    const before = await footprint();
    await expect(apply(first, undefined, abortingExecutor(db, (tx) => tx`SELECT 1 / 0`))).rejects.toThrow();
    expect(await footprint()).toEqual(before);
    for (const row of [first, sibling]) expect(await readProposalForAccount(db, { proposalId: row.id, accountId: tenant.accountId })).toMatchObject({ status: 'pending', receipt: null });
  });

  it.each(['same location', 'first override', 'parent default'] as const)('form write versus Apply: %s serializes account before proposal and makes the old token stale', async (race) => {
    await seedPolicy(null);
    if (race === 'same location') await seedPolicy(locationId);
    const row = await prepare('set_veto_window', { minutes: 15 }, locationId);
    let outcome: ReturnType<typeof apply> | undefined;
    try {
      await db.begin(async (tx) => {
        await patchAutoApprovalSettingsInTransaction(tx, race === 'parent default'
          ? { ...actor(), operation: 'set_account_daily_cap', cap: 1 }
          : { ...actor(), operation: 'set_location_daily_cap', locationId, cap: 1 });
        const [holder] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        outcome = apply(row, undefined, writer);
        void outcome.catch(() => undefined);
        expect(await blockedQuery(tx, holder!.pid)).toMatch(/FROM\s+accounts[\s\S]*FOR UPDATE/i);
        // If Apply had locked its proposal first, NOWAIT would fail here.
        await tx`SELECT id FROM agent_proposals WHERE id = ${row.id}::uuid AND account_id = ${tenant.accountId}::uuid FOR UPDATE NOWAIT`;
      });
      expect((await outcome)!.kind).toBe('stale');
      expect((await footprint()).audits).toBe(1);
    } finally { await outcome?.catch(() => undefined); }
  });

  it('two prepared proposals racing to create the first policy row commit exactly one receipt and audit', async () => {
    const first = await prepare('set_daily_cap', { cap: 1 }, locationId);
    const second = await prepare('set_veto_window', { minutes: 30 }, locationId);
    const results = await Promise.all([apply(first), apply(second, undefined, writer)]);
    expect(results.filter((result) => result.kind === 'applied')).toHaveLength(1);
    expect(results.filter((result) => result.kind === 'stale' || result.kind === 'not_pending')).toHaveLength(1);
    expect(await footprint()).toEqual({ policies: 1, audits: 1, costs: 0, posted: 0 });
  });

  it('Apply preceding a concurrent form write preserves its receipt and serializes the form after commit', async () => {
    await seedPolicy(null);
    await seedPolicy(locationId);
    const row = await prepare('set_veto_window', { minutes: 15 }, locationId);
    let form: ReturnType<typeof patchAutoApprovalSettings> | undefined;
    // Reuse the transaction wrapper's post-callback seam to inspect a REAL
    // blocked form writer before Apply commits. No writer or lock is mocked.
    const heldApply = abortingExecutor(db, async (tx) => {
      const [holder] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      form = patchAutoApprovalSettings(writer, {
        ...actor(), operation: 'set_location_daily_cap', locationId, cap: 1,
      });
      void form.catch(() => undefined);
      expect(await blockedQuery(tx, holder!.pid)).toMatch(/FROM\s+accounts[\s\S]*FOR UPDATE/i);
    });
    try {
      const result = await apply(row, '4 and 5 star', heldApply);
      expect(result.kind).toBe('applied');
      if (result.kind !== 'applied' || result.proposal.receipt?.affects !== 'future_eligible_reviews') throw new Error('missing policy receipt');
      expect(result.proposal.receipt.after).toMatchObject({ vetoWindowMinutes: 15, dailyAutoPostCap: 2 });
      await form;
      const snapshot = await readPolicySnapshot(db, { accountId: tenant.accountId, locationId });
      expect(snapshot?.state.location).toMatchObject({ vetoWindowMinutes: 15, dailyAutoPostCap: 1 });
      expect((await footprint()).audits).toBe(2);
      const settled = await readProposalForAccount(db, { accountId: tenant.accountId, proposalId: row.id });
      expect(settled?.receipt).toEqual(result.proposal.receipt);
    } finally { await form?.catch(() => undefined); }
  });

  it('an archived target refuses setting an override scope but permits manual contractions and repeated receipts', async () => {
    await seedPolicy(null);
    const creation = await prepare('set_auto_reply_scope', { threshold: 4 }, secondLocationId);
    await seedPolicy(locationId);
    const contraction = await prepare('set_auto_reply_scope', { threshold: null }, locationId);
    await db`UPDATE businesses SET archived_at = NOW() WHERE account_id = ${tenant.accountId}::uuid`;
    expect(await apply(creation)).toMatchObject({ kind: 'rejected', reason: 'location_inactive' });
    const result = await apply(contraction);
    expect(result.kind).toBe('applied');
    expect(await apply(contraction)).toMatchObject({ kind: 'applied', repeated: true });
  });

  it('a committed form change invalidates the parent token even for an existing location override', async () => {
    await seedPolicy(null); await seedPolicy(locationId);
    const row = await prepare('set_daily_cap', { cap: 1 }, locationId);
    await patchAutoApprovalSettings(db, { ...actor(), operation: 'set_account_veto_window', minutes: 15, confirmationLevel: 'standard' });
    expect((await apply(row)).kind).toBe('stale');
    expect((await footprint()).audits).toBe(1);
  });
});
