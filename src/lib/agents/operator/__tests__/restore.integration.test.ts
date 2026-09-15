// Real source preparation + Apply receipts. Restore proposals never seed their
// own history; only explicit tamper cases alter a receipt after Apply.
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import { patchAutoApprovalSettings } from '@/lib/auto-approval/settings';
import { POLICY_ACTION_POSTING, POLICY_PERSONA_REPLY } from '@/lib/auto-approval/types';
import { resetServerConfigForTests } from '@/lib/config/server';
import { readVoiceConfig, updateVoiceConfig } from '@/lib/responses/voice-settings';
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
import { buildProposalRows, insertProposals, listAppliedProposals, readProposalForAccount, type ProposalView } from '../proposals';
import { getConversationForOwner, getTurnForOwner, TRANSCRIPT_TURN_LIMIT } from '../reads';
import { createRestoreProposal, createRestoreProposalInTransaction } from '../restore';
import { PROPOSAL_STATUS, TURN_STATUS } from '../schema';
import { createTurn } from '../turns';

const databaseUrl = resolveTestDatabaseUrl();
let db: postgres.Sql;
let writer: postgres.Sql;
let selector: postgres.Sql;
let suiteLock: LiveDbLock | undefined;
let tenant: TenantSeed;
let locationId: string;
let siblingId: string;
const tenants: TenantSeed[] = [];
const writerName = `operator-restore-${randomUUID()}`;
const selectorName = `operator-latest-${randomUUID()}`;

function actor(owner = tenant) {
  return { accountId: owner.accountId, actorUserId: owner.userId, impersonated: false };
}

async function prepare(operationId: string, input: Record<string, unknown>, target: string | null = locationId) {
  const turn = await createTurn(db, {
    ...actor(), locationId: target ?? locationId,
    conversationId: randomUUID(), clientTurnKey: randomUUID(), text: `Please ${operationId}.`,
  });
  if (turn.kind !== 'created') throw new Error(`fixture turn: ${turn.kind}`);
  const operation = proposableOperation(operationId);
  if (!operation) throw new Error(`fixture operation missing: ${operationId}`);
  const parsed = operation.parseInput(input);
  if (!parsed.ok) throw new Error('fixture input invalid');
  const voice = await readVoiceConfig(db, { accountId: tenant.accountId, locationId: target ?? locationId });
  const snapshot = await readPolicySnapshot(db, { accountId: tenant.accountId, locationId: target });
  if (!voice || !snapshot) throw new Error('fixture scope missing');
  const rows = buildProposalRows(
    { ...actor(), conversationId: turn.conversationId, turnId: turn.turnId, locationId: target ?? locationId },
    [{ operation, input: parsed.input, scope: { accountId: tenant.accountId, ...(target ? { locationId: target } : {}) }, rationale: 'Owner requested this change.' }],
    voice, new Map([[target, { snapshot, blockReasons: [] }]]),
  );
  await db.begin(async (tx) => {
    await insertProposals(tx, rows);
    await tx`
      UPDATE agent_turns SET status = ${TURN_STATUS.COMPLETED}, completed_at = NOW(),
        reply = ${tx.json(rows.map((row) => ({ type: 'proposal', proposalId: row.id })))}
      WHERE id = ${turn.turnId}::uuid AND account_id = ${tenant.accountId}::uuid
    `;
  });
  const proposal = await readProposalForAccount(db, { accountId: tenant.accountId, proposalId: rows[0]!.id });
  if (!proposal) throw new Error('fixture proposal missing');
  return proposal;
}

async function applied(proposal: ProposalView, executor = db): Promise<ProposalView> {
  const result = await applyProposal(executor, {
    ...actor(), proposalId: proposal.id, expectedVersionToken: proposal.preparedVersionToken,
    confirmationLevel: proposal.confirmationPhrase ?? undefined,
  });
  expect(result.kind).toBe('applied');
  if (result.kind !== 'applied') throw new Error(`fixture Apply: ${result.kind}`);
  expect(result.proposal.receipt).not.toBeNull();
  return result.proposal;
}

async function restored(source: ProposalView): Promise<ProposalView> {
  const result = await createRestoreProposal(db, { ...actor(), sourceProposalId: source.id });
  expect(result.kind).toBe('prepared');
  if (result.kind !== 'prepared') throw new Error(`Restore preparation: ${result.kind}`);
  return result.proposal;
}

async function seedPolicy(target: string | null, threshold: 4 | 5 | null, minutes = 30, cap: number | null = 2) {
  await db`
    INSERT INTO auto_approval_policies
      (id, account_id, location_id, persona, action_class, auto_approve_min_star, veto_window_minutes, daily_auto_post_cap)
    VALUES (${randomUUID()}::uuid, ${tenant.accountId}::uuid, ${target}::uuid,
      ${POLICY_PERSONA_REPLY}, ${POLICY_ACTION_POSTING}, ${threshold}, ${minutes}, ${cap})
  `;
}

async function policy(target: string | null) {
  const snapshot = await readPolicySnapshot(db, { accountId: tenant.accountId, locationId: target });
  if (!snapshot) throw new Error('fixture policy scope missing');
  return snapshot;
}

async function footprint() {
  const [row] = await db<{ policies: number; audits: number; costs: number }[]>`
    SELECT
      (SELECT COUNT(*)::int FROM auto_approval_policies WHERE account_id = ${tenant.accountId}::uuid) AS policies,
      (SELECT COUNT(*)::int FROM account_audit_log WHERE account_id = ${tenant.accountId}::uuid) AS audits,
      (SELECT COUNT(*)::int FROM api_costs WHERE account_id = ${tenant.accountId}::uuid) AS costs
  `;
  return row;
}

/** Pause real SQL after both scope locks, before proposal INSERT takes FK locks. */
function holdAfterScopeLocks(base: postgres.Sql) {
  let signalHeld!: () => void;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { signalHeld = resolve; });
  const resumed = new Promise<void>((resolve) => { release = resolve; });
  const executor = new Proxy(base, {
    get(target, prop) {
      if (prop !== 'begin') {
        const value: unknown = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (...args: unknown[]) => {
        const callback = args.at(-1) as (tx: postgres.TransactionSql) => Promise<unknown>;
        const wrapped = (tx: postgres.TransactionSql) => callback(new Proxy(tx, {
          apply(target, thisArg, queryArgs: unknown[]) {
            const query = Reflect.apply(target, thisArg, queryArgs) as postgres.PendingQuery<postgres.Row[]>;
            const strings = queryArgs[0];
            if (!Array.isArray(strings) || !/FROM\s+accounts\b[\s\S]*FOR (?:NO KEY )?UPDATE/i.test(strings.join('?'))) return query;
            return query.then(async (rows) => {
              signalHeld();
              await resumed;
              return rows;
            });
          },
        }));
        return (target.begin as (...forwarded: unknown[]) => Promise<unknown>)(...args.slice(0, -1), wrapped);
      };
    },
  });
  return { executor, held, release };
}

async function deadline<T>(promise: Promise<T>, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(description)), 3_000); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

async function blockedQuery(observer: postgres.TransactionSql, applicationName: string, holderPid: number, queuedPid = holderPid) {
  const end = Date.now() + 3_000;
  while (Date.now() < end) {
    await observer`SELECT pg_stat_clear_snapshot()`;
    const [waiting] = await observer<{ query: string; pid: number }[]>`
      SELECT query, pid FROM pg_stat_activity
      WHERE application_name = ${applicationName} AND wait_event_type = 'Lock'
        AND (${holderPid}::int = ANY(pg_blocking_pids(pid))
          OR ${queuedPid}::int = ANY(pg_blocking_pids(pid)))
    `;
    if (waiting) return waiting;
  }
  throw new Error(`${applicationName} did not reach the expected database lock`);
}

describeWithDb('Operator Restore (live DB)', { enabled: Boolean(databaseUrl), timeout: 30_000 }, () => {
  beforeAll(async () => {
    const url = assertLocalTestDatabaseUrl(databaseUrl);
    suiteLock = await acquireLiveDbLock(url);
    db = postgres(url, { max: 3, prepare: false, connection: { statement_timeout: 15_000 } });
    writer = postgres(url, { max: 1, prepare: false, connection: { application_name: writerName, statement_timeout: 15_000 } });
    selector = postgres(url, { max: 1, prepare: false, connection: { application_name: selectorName, statement_timeout: 15_000 } });
    await assertSchemaReady(db, [MIGRATION_120_OWNER_OPERATOR]);
  }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

  beforeEach(async () => {
    for (const flag of ['OWNER_OPERATOR_ENABLED', 'AUTO_APPROVAL_ENABLED', 'AUTOPILOT_PURCHASABLE',
      'OPENAI_MODERATION_ENABLED', 'AUTO_APPROVAL_PROVIDER_MODERATION_READY']) vi.stubEnv(flag, 'true');
    vi.stubEnv('VERCEL_TARGET_ENV', 'test');
    resetServerConfigForTests();
    tenant = await seedTenantAccount(db, { subscriptionTier: 'autopilot' });
    tenants.push(tenant);
    locationId = (await seedLocation(db, tenant.accountId)).businessId;
    siblingId = (await seedLocation(db, tenant.accountId, { isPrimary: false })).businessId;
  });

  afterEach(async () => {
    try {
      for (const owner of tenants.splice(0)) {
        await db`DELETE FROM job_outbox WHERE payload->>'account_id' = ${owner.accountId}`;
        await db`DELETE FROM agent_proposals WHERE account_id = ${owner.accountId}::uuid`;
        await db`DELETE FROM agent_turns WHERE account_id = ${owner.accountId}::uuid`;
        await db`DELETE FROM agent_conversations WHERE account_id = ${owner.accountId}::uuid`;
        await db`DELETE FROM auto_approval_policies WHERE account_id = ${owner.accountId}::uuid`;
        await db`DELETE FROM account_audit_log WHERE account_id = ${owner.accountId}::uuid`;
        await db`DELETE FROM businesses WHERE account_id = ${owner.accountId}::uuid`;
        await cleanupTenantAccount(db, owner);
      }
    } finally { vi.unstubAllEnvs(); resetServerConfigForTests(); }
  });

  afterAll(async () => {
    try { await selector?.end({ timeout: 5 }); await writer?.end({ timeout: 5 }); await db?.end({ timeout: 5 }); }
    finally { await suiteLock?.release(); }
  }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

  it('restore returns a nullable tone without changing unrelated voice fields', async () => {
    await db.begin(async (tx) => { await updateVoiceConfig(tx, {
      accountId: tenant.accountId, locationId,
      fields: { tone: null, productsServices: 'Haircuts', avoidFacts: ['prices'], highlightFacts: ['appointments'], sampleResponses: ['Existing sample'] },
    }); });
    const source = await applied(await prepare('set_tone', { tone: 'warm' }));
    // A later change to another field must survive this single-field inverse.
    await db.begin(async (tx) => { await updateVoiceConfig(tx, {
      accountId: tenant.accountId, locationId, fields: { productsServices: 'Haircuts and styling' },
    }); });
    const before = await readVoiceConfig(db, { accountId: tenant.accountId, locationId });
    const counts = await footprint();
    const restore = await restored(source);
    expect(restore.describe).toBe('Restore: Let RepWorth choose the reply tone.');
    expect(restore.input).toEqual({ restore: { sourceProposalId: source.id } });
    expect(await readVoiceConfig(db, { accountId: tenant.accountId, locationId })).toEqual(before);
    expect(await footprint()).toEqual(counts);
    const result = await applied(restore);
    expect(result.receipt?.after).toMatchObject({ tone: null, productsServices: 'Haircuts and styling' });
    expect(await readVoiceConfig(db, { accountId: tenant.accountId, locationId })).toMatchObject({
      tone: null, productsServices: 'Haircuts and styling', avoidFacts: ['prices'], highlightFacts: ['appointments'], sampleResponses: ['Existing sample'],
    });
  });

  it('restore recreates a cleared custom override and undo restores absence', async () => {
    await seedPolicy(null, 4, 15, 10);
    await seedPolicy(locationId, 5, 30, 2);
    const source = await applied(await prepare('clear_location_override', {}));
    expect((await policy(locationId)).state.location?.rowExists).toBe(false);
    const restore = await restored(source);
    expect(restore.after).toMatchObject({ threshold: 5, vetoWindowMinutes: 30, dailyAutoPostCap: 2, rowExists: true });
    const restoredState = await applied(restore);
    expect((await policy(locationId)).state.location).toMatchObject({
      threshold: 5, vetoWindowMinutes: 30, dailyAutoPostCap: 2, rowExists: true,
    });
    const undo = await restored(restoredState);
    expect(undo.after.rowExists).toBe(false);
    await applied(undo);
    expect((await policy(locationId)).state.location).toMatchObject({
      threshold: 4, vetoWindowMinutes: 15, dailyAutoPostCap: 10, rowExists: false,
    });
    const [count] = await db<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM auto_approval_policies
      WHERE account_id = ${tenant.accountId}::uuid AND location_id = ${locationId}::uuid
    `;
    expect(count?.count).toBe(0);
  });

  it('restore preserves an originally absent account default', async () => {
    const source = await applied(await prepare('set_daily_cap', { cap: 3 }, null));
    expect(source.receipt?.before).toMatchObject({ rowExists: false, dailyAutoPostCap: null });
    const restore = await restored(source);
    expect(restore.locationId).toBeNull();
    expect(restore.after.rowExists).toBe(false);
    await applied(restore);
    expect((await policy(null)).state.accountDefault.rowExists).toBe(false);
    expect((await footprint())?.policies).toBe(0);
  });

  it('restore expansion requires the exact phrase and current readiness', async () => {
    await seedPolicy(locationId, 5);
    const source = await applied(await prepare('set_auto_reply_scope', { threshold: null }));
    const restore = await restored(source);
    expect(restore.requiresConfirmation).toBe(true);
    expect(restore.confirmationPhrase).toBe('5 star only');
    const before = await footprint();
    for (const confirmationLevel of [undefined, '5 Star only', '5 star only ']) {
      expect(await applyProposal(db, {
        ...actor(), proposalId: restore.id, expectedVersionToken: restore.preparedVersionToken, confirmationLevel,
      })).toMatchObject({ kind: 'confirmation_mismatch' });
    }
    expect(await footprint()).toEqual(before);
    vi.stubEnv('AUTO_APPROVAL_ENABLED', 'false');
    resetServerConfigForTests();
    expect(await applyProposal(db, {
      ...actor(), proposalId: restore.id, expectedVersionToken: restore.preparedVersionToken, confirmationLevel: '5 star only',
    })).toMatchObject({ kind: 'blocked', blockReasons: expect.arrayContaining(['auto_approval_disabled']) });
    expect((await policy(locationId)).state.location?.threshold).toBeNull();
    expect(await footprint()).toEqual(before);
    vi.stubEnv('AUTO_APPROVAL_ENABLED', 'true');
    resetServerConfigForTests();
    await applied(await restored(source));
    expect((await policy(locationId)).state.location?.threshold).toBe(5);
  });

  it('restore rejects a changed account default and foreign receipt', async () => {
    await seedPolicy(null, 4);
    await seedPolicy(locationId, 5);
    const source = await applied(await prepare('set_daily_cap', { cap: 1 }));
    const restore = await restored(source);
    await patchAutoApprovalSettings(db, { ...actor(), operation: 'set_account_veto_window', minutes: 15, confirmationLevel: 'standard' });
    expect(await applyProposal(db, {
      ...actor(), proposalId: restore.id, expectedVersionToken: restore.preparedVersionToken,
    })).toMatchObject({ kind: 'stale' });
    expect((await policy(locationId)).state.location?.dailyAutoPostCap).toBe(1);
    const foreign = await seedTenantAccount(db, { subscriptionTier: 'autopilot' });
    tenants.push(foreign);
    expect(await createRestoreProposal(db, { ...actor(foreign), sourceProposalId: source.id })).toEqual({ kind: 'not_found' });
  });

  it('concurrent restore preparation creates one proposal per source and version', async () => {
    const source = await applied(await prepare('set_tone', { tone: 'warm' }));
    const results = await Promise.all([
      createRestoreProposal(db, { ...actor(), sourceProposalId: source.id }),
      createRestoreProposal(writer, { ...actor(), sourceProposalId: source.id }),
    ]);
    for (const result of results) expect(result.kind).toBe('prepared');
    if (results[0]?.kind !== 'prepared' || results[1]?.kind !== 'prepared') throw new Error('concurrent preparation failed');
    expect(results[0].proposal.id).toBe(results[1].proposal.id);
    expect(results.map((result) => result.kind === 'prepared' && result.repeated).sort()).toEqual([false, true]);
    await db.begin(async (tx) => { await updateVoiceConfig(tx, {
      accountId: tenant.accountId, locationId, fields: { productsServices: 'Updated independently' },
    }); });
    const fresh = await restored(source);
    expect(fresh.id).not.toBe(results[0].proposal.id);
    expect((await readProposalForAccount(db, {
      accountId: tenant.accountId, proposalId: results[0].proposal.id,
    }))?.status).toBe(PROPOSAL_STATUS.STALE);
    const [count] = await db<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM agent_proposals
      WHERE account_id = ${tenant.accountId}::uuid AND status = ${PROPOSAL_STATUS.PENDING}
        AND input->'restore'->>'sourceProposalId' = ${source.id}
    `;
    expect(count?.count).toBe(1);
  });

  it('restore_last resolves only the latest applied receipt in the stored scope', async () => {
    const first = await applied(await prepare('set_tone', { tone: 'warm' }));
    const latest = await applied(await prepare('set_tone', { tone: 'brief' }));
    const sibling = await applied(await prepare('set_tone', { tone: 'formal' }, siblingId));
    const account = await applied(await prepare('set_daily_cap', { cap: 3 }, null));
    for (const [target, source] of [[locationId, latest], [siblingId, sibling], [null, account]] as const) {
      const result = await db.begin((tx) => createRestoreProposalInTransaction(tx, { ...actor(), locationId: target }));
      expect(result).toMatchObject({ kind: 'prepared', proposal: { input: { restore: { sourceProposalId: source.id } } } });
    }
    // Same timestamp: UUID order is the deterministic tiebreaker, never row order.
    await db`
      UPDATE agent_proposals SET applied_at = '2026-09-14 12:00:00.123456+00'::timestamptz
      WHERE account_id = ${tenant.accountId}::uuid AND id = ANY(${[first.id, latest.id]}::uuid[])
    `;
    const tied = await db.begin((tx) => createRestoreProposalInTransaction(tx, { ...actor(), locationId }));
    expect(tied).toMatchObject({ kind: 'prepared', proposal: {
      input: { restore: { sourceProposalId: [first.id, latest.id].sort().at(-1) } },
    } });
  });

  it('Restore preparation rejects invalid actors, archived locations and unapplied sources without settings writes', async () => {
    const pending = await prepare('set_tone', { tone: 'warm' });
    expect(await createRestoreProposal(db, { ...actor(), sourceProposalId: pending.id })).toEqual({ kind: 'not_applied' });
    const source = await applied(pending);
    const before = await footprint();
    expect(await createRestoreProposal(db, { ...actor(), sourceProposalId: source.id, impersonated: true })).toEqual({ kind: 'unauthorized' });
    expect(await createRestoreProposal(db, { ...actor(), sourceProposalId: source.id, actorUserId: randomUUID() })).toEqual({ kind: 'unauthorized' });
    await db`UPDATE businesses SET archived_at = NOW() WHERE id = ${locationId}::uuid AND account_id = ${tenant.accountId}::uuid`;
    expect(await createRestoreProposal(db, { ...actor(), sourceProposalId: source.id })).toEqual({ kind: 'location_not_found' });
    expect(await footprint()).toEqual(before);
    expect(await db.begin((tx) => createRestoreProposalInTransaction(tx, { ...actor(), locationId: siblingId }))).toEqual({ kind: 'no_history' });
  });

  it('Restore revalidates source provenance on preparation, readback and Apply', async () => {
    const source = await applied(await prepare('set_tone', { tone: 'warm' }));
    const restore = await restored(source);
    // Explicit tamper: a real receipt is changed to name a different location.
    await db`
      UPDATE agent_proposals SET receipt = jsonb_set(receipt, '{scope,locationId}', to_jsonb(${siblingId}::text))
      WHERE id = ${source.id}::uuid AND account_id = ${tenant.accountId}::uuid
    `;
    expect(await createRestoreProposal(db, { ...actor(), sourceProposalId: source.id })).toEqual({ kind: 'invalid_source' });
    const reread = await readProposalForAccount(db, { accountId: tenant.accountId, proposalId: restore.id });
    expect(reread?.describe).toBe('Restore: The source receipt is no longer available.');
    expect(reread?.requiresConfirmation).toBe(false);
    expect(await applyProposal(db, {
      ...actor(), proposalId: restore.id, expectedVersionToken: restore.preparedVersionToken,
    })).toMatchObject({ kind: 'rejected', reason: 'contract_changed' });
    expect((await readVoiceConfig(db, { accountId: tenant.accountId, locationId }))?.tone).toBe('warm');
  });

  it('malformed source receipt shapes refuse Restore without settings or proposal writes', async () => {
    const source = await applied(await prepare('set_tone', { tone: 'warm' }));
    const restore = await restored(source);
    // Explicit tamper: this receipt shape cannot be emitted by Apply.
    await db`
      UPDATE agent_proposals SET receipt = '{"version":1}'::jsonb
      WHERE id = ${source.id}::uuid AND account_id = ${tenant.accountId}::uuid
    `;
    const before = await readVoiceConfig(db, { accountId: tenant.accountId, locationId });
    const counts = await footprint();
    expect((await readProposalForAccount(db, { accountId: tenant.accountId, proposalId: restore.id }))?.describe)
      .toBe('Restore: The source receipt is no longer available.');
    expect(await applyProposal(db, {
      ...actor(), proposalId: restore.id, expectedVersionToken: restore.preparedVersionToken,
    })).toMatchObject({ kind: 'rejected', reason: 'contract_changed' });
    const [beforeRows] = await db<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM agent_proposals WHERE account_id = ${tenant.accountId}::uuid
    `;
    try {
      await expect(createRestoreProposal(db, { ...actor(), sourceProposalId: source.id })).resolves.toEqual({ kind: 'invalid_source' });
    } finally {
      expect(await readVoiceConfig(db, { accountId: tenant.accountId, locationId })).toEqual(before);
      expect(await footprint()).toEqual(counts);
      const [afterRows] = await db<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM agent_proposals WHERE account_id = ${tenant.accountId}::uuid
      `;
      expect(afterRows).toEqual(beforeRows);
    }
  });

  it('reused Restore proposals remain pending visible and actionable across turns and reload beyond the transcript window', async () => {
    const source = await applied(await prepare('set_tone', { tone: 'warm' }));
    if (source.receipt?.affects !== 'future_drafts') throw new Error('voice receipt missing');
    const originalTone = source.receipt.before.tone;
    const buttonRestore = await restored(source);
    const [owning] = await db<{ conversation_id: string }[]>`
      SELECT conversation_id FROM agent_turns
      WHERE id = ${source.turnId}::uuid AND account_id = ${tenant.accountId}::uuid
    `;
    if (!owning) throw new Error('source conversation missing');
    let latestId = '';
    for (let index = 0; index < TRANSCRIPT_TURN_LIMIT; index += 1) {
      const turn = await createTurn(db, {
        ...actor(), locationId, conversationId: owning.conversation_id,
        clientTurnKey: randomUUID(), text: 'Put it back how it was.',
      });
      if (turn.kind !== 'created') throw new Error(`fixture transcript turn: ${turn.kind}`);
      latestId = turn.turnId;
      await db`
        UPDATE agent_turns SET status = ${TURN_STATUS.COMPLETED}, completed_at = NOW(), reply = '[]'::jsonb
        WHERE id = ${latestId}::uuid AND account_id = ${tenant.accountId}::uuid
      `;
    }
    const modelRestore = await db.begin((tx) => createRestoreProposalInTransaction(tx, {
      ...actor(), locationId, owner: { conversationId: owning.conversation_id, turnId: latestId },
    }));
    expect(modelRestore).toMatchObject({ kind: 'prepared', repeated: true, proposal: {
      id: buttonRestore.id, turnId: source.turnId, status: PROPOSAL_STATUS.PENDING,
    } });
    // Worker completion is covered in turn-worker.integration; this fixture
    // stores its resulting reference to exercise both public read builders.
    await db`
      UPDATE agent_turns SET reply = ${db.json([{ type: 'proposal', proposalId: buttonRestore.id }])}
      WHERE id = ${latestId}::uuid AND account_id = ${tenant.accountId}::uuid
    `;
    const polled = await getTurnForOwner(db, { accountId: tenant.accountId, turnId: latestId });
    expect(polled?.proposals.map((proposal) => proposal.id)).toEqual([buttonRestore.id]);
    const conversation = await getConversationForOwner(db, {
      ...actor(), conversationId: owning.conversation_id,
    });
    if (conversation.kind !== 'view') throw new Error('transcript missing');
    expect(conversation.view.turns).toHaveLength(TRANSCRIPT_TURN_LIMIT);
    expect(conversation.view.turns.some((turn) => turn.id === source.turnId)).toBe(false);
    expect(conversation.view.turns.at(-1)?.proposals.map((proposal) => proposal.id)).toEqual([buttonRestore.id]);
    const reread = polled?.proposals[0];
    if (!reread) throw new Error('reused Restore card missing');
    await applied(reread);
    expect((await readVoiceConfig(db, { accountId: tenant.accountId, locationId }))?.tone).toBe(originalTone);
  });

  it('rules timeline keyset preserves microseconds, deterministic ties and pending Restore reload', async () => {
    const rows: ProposalView[] = [];
    for (const tone of ['warm', 'brief', 'formal', 'friendly']) rows.push(await applied(await prepare('set_tone', { tone })));
    const times = [
      '2026-09-14 12:00:00.123100+00', '2026-09-14 12:00:00.123200+00',
      '2026-09-14 12:00:00.123300+00', '2026-09-14 12:00:00.123300+00',
    ];
    // Retiming real applied rows isolates the DB keyset precision. No receipt
    // or before/after state is invented for this ordering fixture.
    for (let index = 0; index < rows.length; index += 1) {
      await db`
        UPDATE agent_proposals SET applied_at = ${times[index]!}::text::timestamptz
        WHERE id = ${rows[index]!.id}::uuid AND account_id = ${tenant.accountId}::uuid
      `;
    }
    const expected = [...rows].sort((left, right) => {
      const leftAt = times[rows.indexOf(left)]!;
      const rightAt = times[rows.indexOf(right)]!;
      return rightAt.localeCompare(leftAt) || right.id.localeCompare(left.id);
    });
    const pending = await restored(expected[0]!);
    const first = await listAppliedProposals(db, { accountId: tenant.accountId, locationId, limit: 1 });
    expect(first.proposals.map((proposal) => proposal.id)).toEqual([expected[0]!.id]);
    expect(first.pendingRestores.map((proposal) => proposal.id)).toEqual([pending.id]);
    expect(first.nextCursor?.appliedAt).toContain('.1233');
    const seen = first.proposals.map((proposal) => proposal.id);
    let cursor = first.nextCursor;
    while (cursor !== null && seen.length <= rows.length) {
      const page = await listAppliedProposals(db, { accountId: tenant.accountId, locationId, cursor, limit: 1 });
      seen.push(...page.proposals.map((proposal) => proposal.id));
      cursor = page.nextCursor;
    }
    expect(cursor).toBeNull();
    expect(seen).toEqual(expected.map((proposal) => proposal.id));
    expect((await listAppliedProposals(db, { accountId: tenant.accountId, locationId, limit: 1 })).pendingRestores.map((proposal) => proposal.id)).toEqual([pending.id]);
    expect((await listAppliedProposals(db, { accountId: tenant.accountId, locationId: siblingId })).proposals).toEqual([]);
    expect((await listAppliedProposals(db, { accountId: tenant.accountId, locationId: null })).proposals).toEqual([]);
    expect((await listAppliedProposals(db, { accountId: randomUUID() })).proposals).toEqual([]);
  });

  it('atomic policy restore rolls back after a post-write error and records one audit', async () => {
    await seedPolicy(null, 4, 15, 10);
    await seedPolicy(locationId, 5, 30, 2);
    const source = await applied(await prepare('clear_location_override', {}));
    const restore = await restored(source);
    const before = (await policy(locationId)).state;
    const counts = await footprint();
    await expect(applied(restore, abortingExecutor(db, (tx) => tx`SELECT 1 / 0`))).rejects.toThrow();
    expect((await policy(locationId)).state).toEqual(before);
    expect(await footprint()).toEqual(counts);
    expect(await readProposalForAccount(db, { accountId: tenant.accountId, proposalId: restore.id })).toMatchObject({ status: PROPOSAL_STATUS.PENDING, receipt: null });
    await applied(restore);
    expect((await footprint())?.audits).toBe(counts!.audits + 1);
    expect((await policy(locationId)).state.location).toMatchObject({ threshold: 5, vetoWindowMinutes: 30, dailyAutoPostCap: 2, rowExists: true });
    await applied(restore);
    expect((await footprint())?.audits).toBe(counts!.audits + 1);
  });

  it('button restore preparation and concurrent turn submission retain one visible pending proposal', async () => {
    const source = await applied(await prepare('set_tone', { tone: 'warm' }));
    const [owning] = await db<{ conversation_id: string }[]>`
      SELECT conversation_id FROM agent_turns
      WHERE id = ${source.turnId}::uuid AND account_id = ${tenant.accountId}::uuid
    `;
    if (!owning) throw new Error('source conversation missing');
    const hold = holdAfterScopeLocks(db);
    const restorePromise = createRestoreProposal(hold.executor, { ...actor(), sourceProposalId: source.id });
    void restorePromise.catch(() => undefined);
    let submission: ReturnType<typeof createTurn> | undefined;
    try {
      await deadline(hold.held, 'Restore preparation did not reach its held transaction');
      submission = createTurn(writer, {
        ...actor(), locationId, conversationId: owning.conversation_id,
        clientTurnKey: randomUUID(), text: 'Put it back how it was.',
      });
      void submission.catch(() => undefined);
      const turn = await deadline(submission, 'Turn FK checks blocked on Restore parent locks');
      expect(turn.kind).toBe('created');
      // Restore still holds both parent locks, before its proposal insertion.
      // FOR UPDATE on either parent would block the submission's FK checks.
      hold.release();
      const restore = await restorePromise;
      if (restore.kind !== 'prepared' || turn.kind !== 'created') throw new Error('overlap did not prepare and submit');
      const reused = await db.begin((tx) => createRestoreProposalInTransaction(tx, {
        ...actor(), locationId, owner: { conversationId: owning.conversation_id, turnId: turn.turnId },
      }));
      expect(reused).toMatchObject({ kind: 'prepared', repeated: true, proposal: {
        id: restore.proposal.id, turnId: source.turnId, status: PROPOSAL_STATUS.PENDING,
      } });
      expect((await listAppliedProposals(db, { accountId: tenant.accountId, locationId })).pendingRestores.map((proposal) => proposal.id)).toEqual([restore.proposal.id]);
    } finally {
      hold.release();
      await restorePromise.catch(() => undefined);
      await submission?.catch(() => undefined);
    }
  });

  it('restore_last reselects a concurrently applied newer receipt under scope locks', async () => {
    const older = await applied(await prepare('set_tone', { tone: 'warm' }));
    const newer = await prepare('set_tone', { tone: 'brief' });
    let applyPromise: Promise<ProposalView> | undefined;
    let restorePromise: ReturnType<typeof createRestoreProposalInTransaction> | undefined;
    try {
      await db.begin(async (tx) => {
        await tx`
          SELECT id FROM businesses
          WHERE id = ${locationId}::uuid AND account_id = ${tenant.accountId}::uuid FOR UPDATE
        `;
        const [holder] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        if (!holder) throw new Error('holder pid missing');
        // Enqueue the real Apply first and observe its wait before starting
        // Restore. This forces Apply ahead of Restore in the PG lock queue.
        applyPromise = applied(newer, writer);
        void applyPromise.catch(() => undefined);
        const waitingApply = await blockedQuery(tx, writerName, holder.pid);
        expect(waitingApply.query).toMatch(/FROM\s+businesses[\s\S]*FOR UPDATE/i);
        restorePromise = selector.begin((scopeTx) => createRestoreProposalInTransaction(scopeTx, { ...actor(), locationId }));
        void restorePromise.catch(() => undefined);
        // PostgreSQL can report the earlier queued Apply as the soft blocker
        // instead of the transaction holding the row lock.
        const waitingRestore = await blockedQuery(tx, selectorName, holder.pid, waitingApply.pid);
        expect(waitingRestore.query).toMatch(/FROM\s+businesses[\s\S]*FOR NO KEY UPDATE/i);
      });
      const committed = await applyPromise;
      expect(committed?.id).toBe(newer.id);
      const restore = await restorePromise;
      expect(restore).toMatchObject({ kind: 'prepared', proposal: {
        input: { restore: { sourceProposalId: newer.id } },
        before: { tone: 'brief' }, after: { tone: 'warm' },
      } });
      if (restore?.kind !== 'prepared') throw new Error('latest Restore missing');
      expect(restore.proposal.restoreSourceProposalId).not.toBe(older.id);
      expect(restore.proposal.preparedVersionToken).toEqual(committed?.receipt?.versionToken.after);
    } finally {
      await applyPromise?.catch(() => undefined);
      await restorePromise?.catch(() => undefined);
    }
  });
});
