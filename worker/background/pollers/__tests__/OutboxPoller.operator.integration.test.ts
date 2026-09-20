// Run D drives the production dispatch-failure phase against real PostgreSQL.
// The full poller also claims unrelated topics, so the phase's explicit client
// keeps this proof isolated from other suites' pending billing fixtures.
import { randomUUID } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import { claimTurn, createTurn } from '@/lib/agents/operator/turns';
import { TURN_STATUS } from '@/lib/agents/operator/schema';
import { abortingExecutor } from '@/lib/shared/__tests__/helpers/abort-injection';
import {
  acquireLiveDbLock, assertLocalTestDatabaseUrl, LIVE_DB_LOCK_HOOK_TIMEOUT_MS,
  resolveTestDatabaseUrl, type LiveDbLock,
} from '@/lib/shared/__tests__/helpers/live-db-lock';
import { assertSchemaReady, MIGRATION_120_OWNER_OPERATOR } from '@/lib/shared/__tests__/helpers/schema-ready';
import { cleanupTenantAccount, seedLocation, seedTenantAccount, type TenantSeed } from '@/lib/shared/__tests__/live-db-tenant';
import { createWorkerLogger } from '@/lib/shared/logger';

vi.mock('../../../queues', () => ({ topicToQueue: {} }));
vi.mock('@sentry/node', () => ({ captureMessage: vi.fn(), addBreadcrumb: vi.fn(), captureException: vi.fn() }));

import { runOutboxDispatchFailure, runOutboxWatchdogRecovery } from '../OutboxPoller';

const testDatabaseUrl = resolveTestDatabaseUrl();
let db: Sql;
let lock: LiveDbLock | undefined;
let tenant: TenantSeed;
let locationId: string;
const outboxIds: string[] = [];
const logger = createWorkerLogger('[RunDOutboxTest]');

async function seedTurn(attempts = 5) {
  const created = await createTurn(db, {
    accountId: tenant.accountId, actorUserId: tenant.userId, locationId,
    conversationId: randomUUID(), clientTurnKey: randomUUID(), text: 'Make replies warmer.',
  });
  if (created.kind !== 'created') throw new Error('fixture turn was not created');
  const [outbox] = await db<{ id: string }[]>`
    SELECT id FROM job_outbox WHERE topic = 'agent_turn' AND aggregate_id = ${created.turnId}::uuid
  `;
  if (!outbox) throw new Error('fixture outbox is missing');
  outboxIds.push(outbox.id);
  await db`UPDATE job_outbox SET status = 'dispatching', attempts = ${attempts}, max_attempts = 5, dispatched_at = NOW() WHERE id = ${outbox.id}::uuid`;
  return { ...created, outboxId: outbox.id };
}

async function readPair(turnId: string, outboxId: string) {
  const [row] = await db<{
    turn_status: string; failure_reason: string | null; attempt_token: string | null;
    turn_completed: string | null; outbox_status: string; attempts: number; outbox_completed: string | null;
  }[]>`
    SELECT t.status AS turn_status, t.failure_reason, t.attempt_token,
           t.completed_at::text AS turn_completed, o.status AS outbox_status,
           o.attempts, o.completed_at::text AS outbox_completed
    FROM agent_turns t CROSS JOIN job_outbox o
    WHERE t.id = ${turnId}::uuid AND t.account_id = ${tenant.accountId}::uuid
      AND o.id = ${outboxId}::uuid
  `;
  if (!row) throw new Error('fixture pair is missing');
  return row;
}

async function claimedEntries(ids: string[]) {
  return db<Parameters<typeof runOutboxDispatchFailure>[1]>`
    SELECT id, topic, payload, attempts, max_attempts FROM job_outbox WHERE id = ANY(${ids}::uuid[])
  `;
}

async function failDispatch(ids: string[], executor = db) {
  await runOutboxDispatchFailure(executor, await claimedEntries(ids), 'synthetic queue unavailable', logger);
}

describeWithDb('Operator dispatch exhaustion through the production phase', { enabled: Boolean(testDatabaseUrl), timeout: 120_000 }, () => {
  beforeAll(async () => {
    const url = assertLocalTestDatabaseUrl(testDatabaseUrl);
    lock = await acquireLiveDbLock(url);
    db = postgres(url, { max: 4, prepare: false, connection: { statement_timeout: 10_000 } });
    await assertSchemaReady(db, [MIGRATION_120_OWNER_OPERATOR]);
    tenant = await seedTenantAccount(db, { userName: 'Run D Owner', accountDisplayName: 'Run D Test' });
    locationId = (await seedLocation(db, tenant.accountId, { name: 'Run D Salon' })).businessId;
  }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    if (outboxIds.length) await db`DELETE FROM job_outbox WHERE id = ANY(${outboxIds}::uuid[])`;
    outboxIds.length = 0;
    if (tenant) {
      await db`DELETE FROM agent_turns WHERE account_id = ${tenant.accountId}::uuid`;
      await db`DELETE FROM agent_conversations WHERE account_id = ${tenant.accountId}::uuid`;
    }
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    try {
      if (tenant) {
        await db`DELETE FROM businesses WHERE account_id = ${tenant.accountId}::uuid`;
        await cleanupTenantAccount(db, tenant);
      }
    } finally {
      await db?.end({ timeout: 5 });
      await lock?.release();
    }
  });

  it('dispatch exhaustion fails only the accepted turn owned by the winning outbox attempt', async () => {
    const exhausted = await seedTurn();
    const retryable = await seedTurn(1);
    await failDispatch([exhausted.outboxId, retryable.outboxId]);
    const result = await readPair(exhausted.turnId, exhausted.outboxId);
    expect(result).toMatchObject({ turn_status: 'failed', failure_reason: 'dispatch_exhausted', attempt_token: null, outbox_status: 'failed', attempts: 5 });
    expect(result.turn_completed).not.toBeNull();
    expect(result.turn_completed).toBe(result.outbox_completed);
    expect(await readPair(retryable.turnId, retryable.outboxId)).toMatchObject({ turn_status: 'accepted', outbox_status: 'pending', attempts: 1 });

    // A late dispatch error must lose its CAS to the replacement attempt.
    const stale = await seedTurn();
    const oldClaim = await claimedEntries([stale.outboxId]);
    await db`UPDATE job_outbox SET status = 'dispatched', attempts = 6 WHERE id = ${stale.outboxId}::uuid`;
    await runOutboxDispatchFailure(db, oldClaim, 'old dispatch callback', logger);
    expect(await readPair(stale.turnId, stale.outboxId)).toMatchObject({ turn_status: 'accepted', outbox_status: 'dispatched', attempts: 6, failure_reason: null });
  });

  it('dispatch exhaustion rolls back the outbox transition when its turn update fails', async () => {
    const fixture = await seedTurn();
    const aborting = abortingExecutor(db, (tx) => tx`SELECT 1 / 0`);
    await expect(failDispatch([fixture.outboxId], aborting)).rejects.toMatchObject({ code: '22012' });
    expect(await readPair(fixture.turnId, fixture.outboxId)).toMatchObject({ turn_status: 'accepted', outbox_status: 'dispatching', attempts: 5, failure_reason: null, turn_completed: null, outbox_completed: null });

    // Once the database recovers, the rolled-back final dispatch still needs
    // an owner. A fresh dispatch is left alone; an aged one fails atomically.
    await runOutboxWatchdogRecovery(db, 900, logger);
    expect(await readPair(fixture.turnId, fixture.outboxId)).toMatchObject({ turn_status: 'accepted', outbox_status: 'dispatching' });
    await db`UPDATE job_outbox SET dispatched_at = NOW() - INTERVAL '3 minutes' WHERE id = ${fixture.outboxId}::uuid`;
    await runOutboxWatchdogRecovery(db, 900, logger);
    const recovered = await readPair(fixture.turnId, fixture.outboxId);
    expect(recovered).toMatchObject({ turn_status: 'failed', failure_reason: 'dispatch_exhausted', outbox_status: 'failed', attempts: 5 });
    expect(recovered.turn_completed).not.toBeNull();
    expect(recovered.turn_completed).toBe(recovered.outbox_completed);
    const [outbox] = await db<{ last_error: string }[]>`SELECT last_error FROM job_outbox WHERE id = ${fixture.outboxId}::uuid`;
    expect(outbox?.last_error).toBe('Stale dispatching entry exceeded max_attempts');
  });

  it('dispatch exhaustion preserves running and terminal turns after an ambiguous enqueue failure', async () => {
    const fixtures = await Promise.all([seedTurn(), seedTurn(), seedTurn()]);
    const [running, completed, failed] = fixtures;
    await claimTurn(db, { turnId: running!.turnId, accountId: tenant.accountId, leaseSeconds: 180 });
    await db`UPDATE agent_turns SET status = ${TURN_STATUS.COMPLETED}, completed_at = NOW() WHERE id = ${completed!.turnId}::uuid AND account_id = ${tenant.accountId}::uuid`;
    await db`UPDATE agent_turns SET status = ${TURN_STATUS.FAILED}, failure_reason = 'budget_exceeded', completed_at = NOW() WHERE id = ${failed!.turnId}::uuid AND account_id = ${tenant.accountId}::uuid`;
    const before = await Promise.all(fixtures.map((f) => readPair(f.turnId, f.outboxId)));
    await failDispatch(fixtures.map((f) => f.outboxId));
    for (let i = 0; i < fixtures.length; i += 1) {
      const f = fixtures[i]!;
      expect(await readPair(f.turnId, f.outboxId)).toMatchObject({ ...before[i], outbox_status: i === 0 ? 'dispatched' : 'failed', attempts: 5, outbox_completed: i === 0 ? null : expect.any(String) });
    }
  });

  it('watchdog recovery of exhausted dispatching Operator work preserves live claims and other topics', async () => {
    const live = await seedTurn();
    const otherTopic = await seedTurn();
    const missingTimestamp = await seedTurn();
    await claimTurn(db, { turnId: live.turnId, accountId: tenant.accountId, leaseSeconds: 180 });
    await db`UPDATE job_outbox SET dispatched_at = NOW() - INTERVAL '3 minutes' WHERE id = ANY(${[live.outboxId, otherTopic.outboxId]}::uuid[])`;
    await db`UPDATE job_outbox SET topic = 'generate_response' WHERE id = ${otherTopic.outboxId}::uuid`;
    await db`UPDATE job_outbox SET dispatched_at = NULL WHERE id = ${missingTimestamp.outboxId}::uuid`;

    await runOutboxWatchdogRecovery(db, 900, logger);
    expect(await readPair(live.turnId, live.outboxId)).toMatchObject({ turn_status: 'running', outbox_status: 'dispatched', attempts: 5, outbox_completed: null });
    // #1378 made the terminal arm topic-blind, so this row IS terminalized.
    // What stays topic-scoped is the RECONCILIATION: the array_agg(...) FILTER
    // keeps reconcileTurnForFailedOutbox off a non-agent_turn row, so the turn
    // must still read 'accepted' with no failure_reason.
    expect(await readPair(otherTopic.turnId, otherTopic.outboxId)).toMatchObject({ turn_status: 'accepted', failure_reason: null, outbox_status: 'failed', attempts: 5 });
    const recovered = await readPair(missingTimestamp.turnId, missingTimestamp.outboxId);
    expect(recovered).toMatchObject({ turn_status: 'failed', outbox_status: 'failed', failure_reason: 'dispatch_exhausted', attempts: 5 });
    expect(recovered.turn_completed).not.toBeNull();
    expect(recovered.turn_completed).toBe(recovered.outbox_completed);
  });

  it('watchdog recovery of exhausted dispatching work defers a turn locked by completion', async () => {
    const fixture = await seedTurn();
    await claimTurn(db, { turnId: fixture.turnId, accountId: tenant.accountId, leaseSeconds: 180 });
    await db`UPDATE job_outbox SET dispatched_at = NOW() - INTERVAL '3 minutes' WHERE id = ${fixture.outboxId}::uuid`;
    let announceLock!: () => void;
    let releaseLock!: () => void;
    const locked = new Promise<void>((resolve) => { announceLock = resolve; });
    const released = new Promise<void>((resolve) => { releaseLock = resolve; });
    const completion = db.begin(async (tx) => {
      await tx`SELECT id FROM agent_turns WHERE id = ${fixture.turnId}::uuid AND account_id = ${tenant.accountId}::uuid FOR UPDATE`;
      announceLock();
      await released;
      await tx`UPDATE agent_turns SET status = 'completed', completed_at = NOW() WHERE id = ${fixture.turnId}::uuid AND account_id = ${tenant.accountId}::uuid`;
      await tx`UPDATE job_outbox SET status = 'completed', completed_at = NOW() WHERE id = ${fixture.outboxId}::uuid AND status = 'dispatched' AND attempts = 5`;
    });
    try {
      await locked;
      await runOutboxWatchdogRecovery(db, 900, logger);
      expect(await readPair(fixture.turnId, fixture.outboxId)).toMatchObject({ turn_status: 'running', outbox_status: 'dispatched', attempts: 5 });
    } finally {
      releaseLock();
      await completion;
    }
    expect(await readPair(fixture.turnId, fixture.outboxId)).toMatchObject({ turn_status: 'completed', outbox_status: 'completed', attempts: 5 });
  });

  it('a worker crash after ambiguous dispatch exhaustion remains recoverable by the watchdog', async () => {
    const fixture = await seedTurn();
    await claimTurn(db, { turnId: fixture.turnId, accountId: tenant.accountId, leaseSeconds: 180 });
    await failDispatch([fixture.outboxId]);
    expect(await readPair(fixture.turnId, fixture.outboxId)).toMatchObject({ turn_status: 'running', outbox_status: 'dispatched', attempts: 5, outbox_completed: null });

    // An old dispatch timestamp alone cannot terminate a freshly renewed claim.
    await db`UPDATE job_outbox SET dispatched_at = NOW() - INTERVAL '16 minutes' WHERE id = ${fixture.outboxId}::uuid`;
    const logs = vi.spyOn(logger, 'log');
    await runOutboxWatchdogRecovery(db, 900, logger);
    expect(await readPair(fixture.turnId, fixture.outboxId)).toMatchObject({ turn_status: 'running', outbox_status: 'dispatched', attempts: 5, outbox_completed: null });
    expect(logs).not.toHaveBeenCalledWith('Watchdog recovered stale entries', expect.objectContaining({ failed: 1 }));

    // The worker then disappears. Advance durable timestamps, not wall time.
    await db`UPDATE agent_turns SET claimed_at = NOW() - INTERVAL '4 minutes' WHERE id = ${fixture.turnId}::uuid AND account_id = ${tenant.accountId}::uuid`;
    await db`UPDATE job_outbox SET dispatched_at = NOW() - INTERVAL '16 minutes' WHERE id = ${fixture.outboxId}::uuid`;
    const aborting = abortingExecutor(db, (tx) => tx`SELECT 1 / 0`);
    await expect(runOutboxWatchdogRecovery(aborting, 900, logger)).rejects.toMatchObject({ code: '22012' });
    expect(await readPair(fixture.turnId, fixture.outboxId)).toMatchObject({ turn_status: 'running', outbox_status: 'dispatched', attempts: 5 });
    await runOutboxWatchdogRecovery(db, 900, logger);
    const result = await readPair(fixture.turnId, fixture.outboxId);
    expect(result).toMatchObject({ turn_status: 'failed', failure_reason: 'dispatch_exhausted', attempt_token: null, outbox_status: 'failed', attempts: 5 });
    expect(result.turn_completed).toBe(result.outbox_completed);
    expect(logs).toHaveBeenCalledWith('Watchdog recovered stale entries', expect.objectContaining({ failed: 1 }));
    const [proposals] = await db<{ count: string }[]>`SELECT COUNT(*)::text AS count FROM agent_proposals WHERE account_id = ${tenant.accountId}::uuid AND turn_id = ${fixture.turnId}::uuid`;
    expect(proposals?.count).toBe('0');
  });

  it('dispatch exhaustion defers a locked turn without deadlocking fenced completion', async () => {
    const fixture = await seedTurn();
    await claimTurn(db, { turnId: fixture.turnId, accountId: tenant.accountId, leaseSeconds: 180 });
    let announceLock!: () => void;
    let releaseLock!: () => void;
    const locked = new Promise<void>((resolve) => { announceLock = resolve; });
    const released = new Promise<void>((resolve) => { releaseLock = resolve; });
    const completion = db.begin(async (tx) => {
      await tx`SELECT id FROM agent_turns WHERE id = ${fixture.turnId}::uuid AND account_id = ${tenant.accountId}::uuid FOR UPDATE`;
      announceLock();
      await released;
      await tx`UPDATE agent_turns SET status = 'completed', completed_at = NOW() WHERE id = ${fixture.turnId}::uuid AND account_id = ${tenant.accountId}::uuid`;
      await tx`UPDATE job_outbox SET status = 'completed', completed_at = NOW() WHERE id = ${fixture.outboxId}::uuid AND status = 'dispatched' AND attempts = 5`;
    });
    try {
      await locked;
      await failDispatch([fixture.outboxId]);
      expect(await readPair(fixture.turnId, fixture.outboxId)).toMatchObject({ turn_status: 'running', outbox_status: 'dispatched', attempts: 5 });
    } finally {
      releaseLock();
      await completion;
    }
    expect(await readPair(fixture.turnId, fixture.outboxId)).toMatchObject({ turn_status: 'completed', outbox_status: 'completed', attempts: 5 });
  });

  it('dispatch exhaustion ignores mismatched account and aggregate identities', async () => {
    for (const mismatch of ['account_id', 'turn_id', 'conversation_id', 'aggregate_id', 'aggregate_type', 'malformed']) {
      const fixture = await seedTurn();
      if (mismatch === 'aggregate_id') {
        await db`UPDATE job_outbox SET aggregate_id = ${randomUUID()}::uuid WHERE id = ${fixture.outboxId}::uuid`;
      } else if (mismatch === 'aggregate_type') {
        await db`UPDATE job_outbox SET aggregate_type = 'business' WHERE id = ${fixture.outboxId}::uuid`;
      } else {
        const key = mismatch === 'malformed' ? 'account_id' : mismatch;
        const value = mismatch === 'malformed' ? 'not-a-uuid' : randomUUID();
        await db`UPDATE job_outbox SET payload = payload || ${db.json({ [key]: value })} WHERE id = ${fixture.outboxId}::uuid`;
      }
      await failDispatch([fixture.outboxId]);
      expect(await readPair(fixture.turnId, fixture.outboxId)).toMatchObject({ turn_status: 'accepted', failure_reason: null, outbox_status: 'failed', attempts: 5 });
    }
  });

  it('watchdog exhaustion terminalizes an accepted Operator turn in the same transaction', async () => {
    const fixture = await seedTurn(5);
    await db`UPDATE job_outbox SET status = 'dispatched', dispatched_at = NOW() - INTERVAL '16 minutes', last_error = 'preserved_failure_class' WHERE id = ${fixture.outboxId}::uuid`;
    await runOutboxWatchdogRecovery(db, 900, logger);
    const result = await readPair(fixture.turnId, fixture.outboxId);
    expect(result).toMatchObject({ turn_status: 'failed', failure_reason: 'dispatch_exhausted', outbox_status: 'failed' });
    expect(result.turn_completed).toBe(result.outbox_completed);
    const [outbox] = await db<{ last_error: string }[]>`SELECT last_error FROM job_outbox WHERE id = ${fixture.outboxId}::uuid`;
    expect(outbox?.last_error).toBe('preserved_failure_class');
  });
});
