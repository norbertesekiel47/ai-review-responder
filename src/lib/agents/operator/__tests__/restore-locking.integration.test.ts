// Real public transactions contend in both directions; PostgreSQL identifies
// the blocker before either transaction is allowed to commit.
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import { resetServerConfigForTests } from '@/lib/config/server';
import { archiveLocationTransaction } from '@/lib/locations/archive-location-tx';
import { readVoiceConfig } from '@/lib/responses/voice-settings';
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
import { buildProposalRows, insertProposals, readProposalForAccount, type ProposalView } from '../proposals';
import { createRestoreProposal } from '../restore';
import { parsePolicyState, PROPOSAL_STATUS, TURN_STATUS } from '../schema';
import { createTurn } from '../turns';
import { computeVoiceVersionToken } from '../version-token';

const databaseUrl = resolveTestDatabaseUrl();
const waiterName = `restore-lock-waiter-${randomUUID()}`;
let db: postgres.Sql;
let holder: postgres.Sql;
let waiter: postgres.Sql;
let suiteLock: LiveDbLock | undefined;
let tenant: TenantSeed;
let locationId: string;
type Domain = 'voice Apply' | 'policy Apply' | 'archive';
const domains: Domain[] = ['voice Apply', 'policy Apply', 'archive'];

function actor() {
  return { accountId: tenant.accountId, actorUserId: tenant.userId, impersonated: false };
}

async function prepare(domain: Domain, newer = false): Promise<ProposalView> {
  const operationId = domain === 'policy Apply' ? 'set_daily_cap' : 'set_tone';
  const input = domain === 'policy Apply' ? { cap: newer ? 1 : 2 } : { tone: newer ? 'formal' : 'warm' };
  const turn = await createTurn(db, {
    ...actor(), locationId, conversationId: randomUUID(), clientTurnKey: randomUUID(), text: `Please ${operationId}.`,
  });
  if (turn.kind !== 'created') throw new Error(`fixture turn: ${turn.kind}`);
  const operation = proposableOperation(operationId);
  if (!operation) throw new Error(`fixture operation: ${operationId}`);
  const parsed = operation.parseInput(input);
  if (!parsed.ok) throw new Error('fixture input invalid');
  const voice = await readVoiceConfig(db, { accountId: tenant.accountId, locationId });
  const snapshot = await readPolicySnapshot(db, { accountId: tenant.accountId, locationId });
  if (!voice || !snapshot) throw new Error('fixture scope missing');
  const rows = buildProposalRows(
    { ...actor(), conversationId: turn.conversationId, turnId: turn.turnId, locationId },
    [{ operation, input: parsed.input, scope: { accountId: tenant.accountId, locationId }, rationale: 'Owner requested this change.' }],
    voice, new Map([[locationId, { snapshot, blockReasons: [] }]]),
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

async function apply(proposal: ProposalView, executor = db) {
  const result = await applyProposal(executor, {
    ...actor(), proposalId: proposal.id, expectedVersionToken: proposal.preparedVersionToken,
    confirmationLevel: proposal.confirmationPhrase ?? undefined,
  });
  expect(result.kind).toBe('applied');
  if (result.kind !== 'applied') throw new Error(`fixture Apply: ${result.kind}`);
  expect(result.proposal.receipt).not.toBeNull();
  return result.proposal;
}

function restore(source: ProposalView, executor: postgres.Sql) {
  return createRestoreProposal(executor, { ...actor(), sourceProposalId: source.id });
}

async function mutate(domain: Domain, proposal: ProposalView, executor: postgres.Sql) {
  if (domain === 'archive') return archiveLocationTransaction(executor, { ...actor(), locationId });
  return apply(proposal, executor);
}

async function footprint(executor: postgres.Sql | postgres.TransactionSql = db) {
  const [row] = await executor<{ state: unknown }[]>`
    SELECT jsonb_build_object(
      'business', (SELECT jsonb_build_object('tone', tone, 'updated_at', updated_at::text,
        'archived_at', archived_at::text) FROM businesses
        WHERE id = ${locationId}::uuid AND account_id = ${tenant.accountId}::uuid),
      'policies', (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM auto_approval_policies p
        WHERE p.account_id = ${tenant.accountId}::uuid),
      'audits', (SELECT COUNT(*) FROM account_audit_log WHERE account_id = ${tenant.accountId}::uuid)
    ) AS state
  `;
  return row!.state;
}

async function freshToken(domain: Domain) {
  if (domain === 'policy Apply') {
    const snapshot = await readPolicySnapshot(db, { accountId: tenant.accountId, locationId });
    if (!snapshot) throw new Error('policy disappeared');
    return snapshot.versionToken;
  }
  const voice = await readVoiceConfig(db, { accountId: tenant.accountId, locationId });
  if (!voice) throw new Error('voice disappeared');
  return computeVoiceVersionToken({ businessId: locationId, updatedAt: voice.updatedAt });
}

async function blockedQuery(holderPid: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await db`SELECT pg_stat_clear_snapshot()`;
    const [row] = await db<{ query: string }[]>`
      SELECT query FROM pg_stat_activity
      WHERE application_name = ${waiterName} AND wait_event_type = 'Lock'
        AND ${holderPid}::int = ANY(pg_blocking_pids(pid))
    `;
    if (row) return row.query;
  }
  throw new Error('competing public transaction did not wait on the holder');
}

/** The injection seam holds the real transaction after its last write, before COMMIT. */
async function contend<H, W>(
  hold: (executor: postgres.Sql) => Promise<H>,
  wait: () => Promise<W>,
  inspect: (tx: postgres.TransactionSql, query: string) => Promise<void>,
) {
  let pending: Promise<W> | undefined;
  const executor = abortingExecutor(holder, async (tx) => {
    const [row] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    pending = wait();
    void pending.catch(() => undefined);
    await inspect(tx, await blockedQuery(row!.pid));
  });
  try {
    const held = await hold(executor);
    if (!pending) throw new Error('holder did not execute a transaction');
    return { held, waited: await pending };
  } finally {
    // Any assertion failure rolls the holder back and releases the waiter.
    await pending?.catch(() => undefined);
  }
}

describeWithDb('restore preparation serializes against lifecycle and both Apply domains', {
  enabled: Boolean(databaseUrl), timeout: 30_000,
}, () => {
  beforeAll(async () => {
    const url = assertLocalTestDatabaseUrl(databaseUrl);
    suiteLock = await acquireLiveDbLock(url);
    db = postgres(url, { max: 1, prepare: false, connection: { statement_timeout: 15_000 } });
    holder = postgres(url, { max: 1, prepare: false, connection: { statement_timeout: 15_000 } });
    waiter = postgres(url, { max: 1, prepare: false, connection: { application_name: waiterName, statement_timeout: 15_000 } });
    await assertSchemaReady(db, [MIGRATION_120_OWNER_OPERATOR]);
  }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

  beforeEach(async () => {
    for (const flag of ['OWNER_OPERATOR_ENABLED', 'AUTO_APPROVAL_ENABLED', 'AUTOPILOT_PURCHASABLE',
      'OPENAI_MODERATION_ENABLED', 'AUTO_APPROVAL_PROVIDER_MODERATION_READY']) vi.stubEnv(flag, 'true');
    vi.stubEnv('VERCEL_TARGET_ENV', 'test');
    resetServerConfigForTests();
    tenant = await seedTenantAccount(db, { subscriptionTier: 'autopilot' });
    await seedLocation(db, tenant.accountId);
    locationId = (await seedLocation(db, tenant.accountId, { isPrimary: false })).businessId;
  });

  afterEach(async () => {
    try {
      await db`DELETE FROM job_outbox WHERE aggregate_id = ${tenant.accountId} OR payload->>'account_id' = ${tenant.accountId}`;
      await db`DELETE FROM agent_proposals WHERE account_id = ${tenant.accountId}::uuid`;
      await db`DELETE FROM agent_turns WHERE account_id = ${tenant.accountId}::uuid`;
      await db`DELETE FROM agent_conversations WHERE account_id = ${tenant.accountId}::uuid`;
      await db`DELETE FROM auto_approval_policies WHERE account_id = ${tenant.accountId}::uuid`;
      await db`DELETE FROM account_audit_log WHERE account_id = ${tenant.accountId}::uuid`;
      await db`DELETE FROM businesses WHERE account_id = ${tenant.accountId}::uuid`;
      await cleanupTenantAccount(db, tenant);
    } finally { vi.unstubAllEnvs(); resetServerConfigForTests(); }
  });

  afterAll(async () => {
    try { await waiter?.end({ timeout: 5 }); await holder?.end({ timeout: 5 }); await db?.end({ timeout: 5 }); }
    finally { await suiteLock?.release(); }
  }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

  it.each(domains)('Restore waits for %s and reads its committed state', async (domain) => {
    const source = await apply(await prepare(domain));
    const newer = domain === 'archive' ? source : await prepare(domain, true);
    const originalToken = await freshToken(domain);
    const before = await footprint();
    let committedState: unknown;
    const { waited } = await contend(
      (executor) => mutate(domain, newer, executor),
      () => restore(source, waiter),
      async (tx, query) => {
        expect(query).toMatch(domain === 'policy Apply' ? /FROM accounts[\s\S]*FOR NO KEY UPDATE/i : /FROM businesses[\s\S]*FOR NO KEY UPDATE/i);
        expect(await footprint()).toEqual(before);
        committedState = await footprint(tx);
      },
    );
    expect(await footprint()).toEqual(committedState);
    if (domain === 'archive') {
      expect(waited.kind).toBe('location_not_found');
      return;
    }
    expect(waited.kind).toBe('prepared');
    if (waited.kind !== 'prepared') throw new Error(`Restore: ${waited.kind}`);
    expect(waited.proposal.status).toBe(PROPOSAL_STATUS.PENDING);
    expect(waited.proposal.receipt).toBeNull();
    expect(waited.proposal.preparedVersionToken).toEqual(await freshToken(domain));
    expect(waited.proposal.preparedVersionToken).not.toEqual(originalToken);
    const receipt = (await apply(waited.proposal)).receipt;
    if (domain === 'policy Apply') {
      expect(parsePolicyState(receipt?.after, 'restore.after'))
        .toEqual(parsePolicyState(source.receipt?.before, 'source.before'));
    } else expect(receipt?.after).toEqual(source.receipt?.before);
  });

  it.each(domains)('%s waits for Restore preparation without observing a settings write', async (domain) => {
    const source = await apply(await prepare(domain));
    const newer = domain === 'archive' ? source : await prepare(domain, true);
    const token = await freshToken(domain);
    const before = await footprint();
    const { held } = await contend(
      (executor) => restore(source, executor),
      () => mutate(domain, newer, waiter),
      async (tx, query) => {
        expect(query).toMatch(domain === 'policy Apply' ? /FROM accounts[\s\S]*FOR UPDATE/i : /FROM businesses[\s\S]*FOR UPDATE/i);
        expect(await footprint(tx)).toEqual(before);
        expect(await footprint()).toEqual(before);
      },
    );
    expect(held.kind).toBe('prepared');
    if (held.kind !== 'prepared') throw new Error(`Restore: ${held.kind}`);
    expect(held.proposal.preparedVersionToken).toEqual(token);
    expect(held.proposal.receipt).toBeNull();
    const current = await readProposalForAccount(db, { accountId: tenant.accountId, proposalId: held.proposal.id });
    if (domain === 'archive') {
      const result = await applyProposal(db, {
        ...actor(), proposalId: held.proposal.id, expectedVersionToken: held.proposal.preparedVersionToken,
      });
      expect(result).toMatchObject({ kind: 'rejected', reason: 'location_not_found' });
      expect(current?.receipt).toBeNull();
    } else {
      expect(current?.status).toBe(PROPOSAL_STATUS.STALE);
      expect(await freshToken(domain)).not.toEqual(token);
    }
  });
});
