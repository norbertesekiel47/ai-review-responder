// Live-DB proofs for the AgentTurnWorker claim/fence protocol (T7). Seeds
// through seedTenantAccount / seedLocation, gates on describeWithDb, locks with
// acquireLiveDbLock, and asserts the schema with assertSchemaReady. runLlmTask,
// the cost guard and the api_costs audit are mocked (plan decision V2); the
// database is real.
import { randomUUID } from 'node:crypto';
import { DelayedError, type Job } from 'bullmq';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';

// V2: the cost guard is mocked with a PASS-THROUGH that still invokes the
// closure, so the reserve-before-call ordering stays a production property
// proven by src/lib/costs/__tests__/cost-guard.test.ts rather than something
// this suite re-proves against a Redis it does not have. Mock shape follows
// src/lib/responses/__tests__/judge.test.ts:9-18.
const { runLlmTask, recordApiCost } = vi.hoisted(() => ({
  runLlmTask: vi.fn(),
  recordApiCost: vi.fn(),
}));
// `importOriginal`, not a bare replacement: model-call.ts also imports
// `LLMStructuredOutputError` from this module and runs `error instanceof` on
// it, which throws once the mock drops the class.
vi.mock('@/lib/llm/run-task', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/llm/run-task')>()),
  runLlmTask,
}));
vi.mock('@/lib/costs/cost-guard', () => ({
  withCostGuard: async (
    _opts: unknown,
    fn: () => Promise<{ value: unknown; actualCostCents: number }>,
  ) => (await fn()).value,
}));
vi.mock('@/lib/costs/audit', () => ({ calculateCostUsd: () => 0.0009, recordApiCost }));

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
  MIGRATION_120_OWNER_OPERATOR,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import {
  cleanupTenantAccount,
  seedLocation,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import type { AgentTurnPayload } from '@/lib/shared/worker-types';
import type { AccountOffboardingPurgeRow } from '../../../../../worker/jobs/account-offboarding/purge-stages';
import { handleAgentTurn } from '../../../../../worker/jobs/agent-turn/AgentTurnWorker';
import { PROPOSAL_STATUS, parseReplySegments, TURN_FAILURE_REASON, TURN_STATUS } from '../schema';
import { createTurn, type CreateTurnResult } from '../turns';

const testDatabaseUrl = resolveTestDatabaseUrl();
let db: postgres.Sql;
let lock: LiveDbLock | undefined;
let tenant: TenantSeed;
let locationId: string;
/** The lease-theft mock needs the turn id before `createTurn` returns it. */
let stolenTurnId = '';

function modelReply(structured: Record<string, unknown> = {}) {
  return {
    text: '',
    provider: 'openai' as const,
    model: 'gpt-4o-mini-2024-07-18',
    usage: { promptTokens: 900, completionTokens: 180 },
    structured: {
      segments: [{ type: 'text', text: 'Apply the card below and I will use it from the next reply.' }],
      proposals: [],
      unsupported: [],
      ...structured,
    },
  };
}

function toneProposal(location = locationId) {
  return {
    operation: 'set_tone',
    scope: { accountId: tenant.accountId, locationId: location },
    input: { tone: 'warm and brief' },
    rationale: 'You asked for shorter replies.',
  };
}

/** One POST's worth of input, with a fresh turn key per call. */
function baseTurnInput(overrides: Partial<Parameters<typeof createTurn>[1]> = {}) {
  return {
    accountId: tenant.accountId,
    actorUserId: tenant.userId,
    conversationId: randomUUID(),
    clientTurnKey: randomUUID(),
    locationId,
    text: 'Make my replies warmer.',
    ...overrides,
  };
}

function createdOrThrow(result: CreateTurnResult): { conversationId: string; turnId: string } {
  if (result.kind !== 'created') throw new Error(`expected a created turn, got ${result.kind}`);
  return { conversationId: result.conversationId, turnId: result.turnId };
}

/** The payload the poller would dispatch for a turn that createTurn just wrote. */
async function payloadFor(
  created: { conversationId: string; turnId: string },
  outboxAttempt = 1,
): Promise<AgentTurnPayload & { outbox_id: string }> {
  const [row] = await db<{ id: string }[]>`
    SELECT id FROM job_outbox
    WHERE topic = 'agent_turn' AND aggregate_id = ${created.turnId}::uuid
  `;
  if (!row) throw new Error('createTurn wrote no agent_turn outbox row');
  return {
    turn_id: created.turnId,
    account_id: tenant.accountId,
    conversation_id: created.conversationId,
    outbox_id: row.id,
    outbox_attempt: outboxAttempt,
  };
}

/**
 * Simulates the poller's dispatch, because `markOutboxCompletedIfOwned` matches
 * ONLY a row that is `status = 'dispatched'` with `attempts = <attempt>` — the
 * shared `dispatchedRow` fragment, src/lib/shared/outbox.ts:19-22. Without this
 * the fenced completion's CAS silently matches nothing and every case below
 * would pass for the wrong reason.
 *
 * The column set is exactly what OutboxPoller writes across its two steps: the
 * claim sets `status='dispatching', attempts = attempts + 1, dispatched_at =
 * NOW()` (worker/background/pollers/OutboxPoller.ts:193-194) and `markDispatched`
 * then sets `status='dispatched', dispatched_at = NOW()` under an
 * `o.attempts = claimed.attempts` guard
 * (worker/background/pollers/OutboxPoller.ts:218-223).
 */
async function markDispatched(
  exec: postgres.Sql,
  outboxId: string,
  attempts: number,
): Promise<void> {
  await exec`
    UPDATE job_outbox
    SET status = 'dispatched', attempts = ${attempts}, dispatched_at = NOW()
    WHERE id = ${outboxId}::uuid
  `;
}

function jobFor(
  payload: AgentTurnPayload,
  overrides: Partial<Job<AgentTurnPayload>> = {},
): Job<AgentTurnPayload> {
  return {
    id: `job-${payload.turn_id}`,
    data: payload,
    opts: { attempts: 5 },
    attemptsMade: 0,
    token: 'token-1',
    moveToDelayed: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as Job<AgentTurnPayload>;
}

interface TurnRow {
  status: string;
  failure_reason: string | null;
  attempt: number;
  attempt_token: string | null;
  reply: unknown;
}

async function readTurn(turnId: string): Promise<TurnRow> {
  const [row] = await db<TurnRow[]>`
    SELECT status, failure_reason, attempt, attempt_token, reply
    FROM agent_turns
    WHERE id = ${turnId}::uuid AND account_id = ${tenant.accountId}::uuid
  `;
  if (!row) throw new Error(`no agent_turns row for ${turnId}`);
  return row;
}

interface VoiceColumns {
  tone: string | null;
  products_services: string | null;
  avoid_facts: string[] | null;
  highlight_facts: string[] | null;
  sample_responses: string[] | null;
  updated_at: Date | string;
}

/** The location's voice columns, for the "nothing was applied" assertions. */
async function readVoiceColumns(businessId: string): Promise<VoiceColumns> {
  const [row] = await db<VoiceColumns[]>`
    SELECT tone, products_services, avoid_facts, highlight_facts, sample_responses, updated_at
    FROM businesses
    WHERE id = ${businessId}::uuid AND account_id = ${tenant.accountId}::uuid
  `;
  if (!row) throw new Error(`no businesses row for ${businessId}`);
  return row;
}

async function readOutbox(outboxId: string): Promise<{ status: string; last_error: string | null }> {
  const [row] = await db<{ status: string; last_error: string | null }[]>`
    SELECT status, last_error FROM job_outbox WHERE id = ${outboxId}::uuid
  `;
  if (!row) throw new Error(`no job_outbox row for ${outboxId}`);
  return row;
}

describeWithDb(
  'AgentTurnWorker (live DB)',
  { enabled: Boolean(testDatabaseUrl), timeout: 180_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      lock = await acquireLiveDbLock(databaseUrl);
      db = postgres(databaseUrl, {
        max: 4,
        prepare: false,
        connection: { statement_timeout: 30_000 },
      });
      await assertSchemaReady(db, [MIGRATION_120_OWNER_OPERATOR]);
      tenant = await seedTenantAccount(db, {
        userName: 'Operator Run A Owner',
        accountDisplayName: 'Operator Run A Account',
      });
      locationId = (await seedLocation(db, tenant.accountId, { name: 'Salon' })).businessId;
      process.env.OWNER_OPERATOR_ENABLED = 'true';
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    afterEach(async () => {
      vi.clearAllMocks();
      // Children first, every statement account-scoped.
      await db`DELETE FROM agent_unsupported_requests WHERE account_id = ${tenant.accountId}::uuid`;
      await db`DELETE FROM agent_proposals WHERE account_id = ${tenant.accountId}::uuid`;
      await db`DELETE FROM agent_turns WHERE account_id = ${tenant.accountId}::uuid`;
      await db`DELETE FROM agent_conversations WHERE account_id = ${tenant.accountId}::uuid`;
      await db`DELETE FROM job_outbox WHERE topic = 'agent_turn'`;
      await db`DELETE FROM account_offboardings WHERE account_id = ${tenant.accountId}::uuid`;
    }, 60_000);

    afterAll(async () => {
      try {
        if (db) {
          await db`DELETE FROM businesses WHERE account_id = ${tenant.accountId}::uuid`;
          await cleanupTenantAccount(db, tenant);
        }
      } finally {
        try {
          if (db) await db.end({ timeout: 5 });
        } finally {
          await lock?.release();
          lock = undefined;
        }
      }
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    it('worker claim race: two dispatches of one turn produce one completed turn and one proposal set', async () => {
      runLlmTask.mockResolvedValue(modelReply({
        proposals: [toneProposal()],
        segments: [{ type: 'proposal_ref', index: 0 }, { type: 'status_ref', metric: 'pending_count' }],
      }));
      const created = createdOrThrow(await createTurn(db, baseTurnInput()));
      const payload = await payloadFor(created, 2);
      const voiceBefore = await readVoiceColumns(locationId);

      // The real watchdog shape, driven DETERMINISTICALLY. The row has been
      // dispatched twice, so it sits at attempts = 2 and only a dispatch
      // carrying outbox_attempt 2 owns it. Running attempt 1 alone first means
      // the assertions below describe one ordering rather than whichever of two
      // interleavings the scheduler happened to pick.
      await markDispatched(db, payload.outbox_id, 2);
      await handleAgentTurn(db, jobFor({ ...payload, outbox_attempt: 1 }));

      const turn = await readTurn(created.turnId);
      expect(turn.status).toBe(TURN_STATUS.COMPLETED);
      expect(turn.failure_reason).toBeNull();
      const proposals = await db<{
        id: string; operation: string; status: string; location_id: string | null;
        contract_version: number; requires_confirmation: boolean;
      }[]>`
        SELECT id, operation, status, location_id, contract_version, requires_confirmation
        FROM agent_proposals
        WHERE turn_id = ${created.turnId}::uuid AND account_id = ${tenant.accountId}::uuid
      `;
      expect(proposals).toHaveLength(1);
      expect(proposals[0]!.operation).toBe('set_tone');
      expect(proposals[0]!.status).toBe(PROPOSAL_STATUS.PENDING);
      expect(proposals[0]!.location_id).toBe(locationId);
      expect(proposals[0]!.contract_version).toBe(1);
      expect(proposals[0]!.requires_confirmation).toBe(false);

      // The turn is DONE and the outbox row is NOT: attempt 1's CAS could not
      // match a row at attempts = 2. This is the exact state that stranded the
      // row before the terminal-turn branch existed.
      expect((await readOutbox(payload.outbox_id)).status).toBe('dispatched');

      // The status_ref was MATERIALIZED: the stored reply carries a value, not
      // a metric name to resolve later.
      const stored = parseReplySegments(turn.reply);
      const status = stored.find((segment) => segment.type === 'status');
      expect(status).toMatchObject({ type: 'status', metric: 'pending_count', reportingPeriodDays: 7 });
      expect(typeof (status as { value: number }).value).toBe('number');
      // Asserted against the RAW column, not the parsed union: `StoredSegment`
      // has no `status_ref` member, so the plan's
      // `stored.some((s) => s.type === 'status_ref')` is a compile error rather
      // than a test. The type half is the stronger guarantee and is free; this
      // is the runtime half — the bytes in the row carry no unresolved ref.
      expect(JSON.stringify(turn.reply)).not.toContain('status_ref');

      // NOTHING WAS APPLIED (invariant #3, and the whole point of Run A).
      expect(await readVoiceColumns(locationId)).toEqual(voiceBefore);
      const policies = await db<{ id: string }[]>`
        SELECT id FROM auto_approval_policies WHERE account_id = ${tenant.accountId}::uuid
      `;
      expect(policies).toHaveLength(0);
      const publishRows = await db<{ id: string }[]>`
        SELECT jo.id
        FROM job_outbox jo
        JOIN responses r ON r.id = jo.aggregate_id
        WHERE jo.topic = 'publish_response'
          AND r.business_id = ${locationId}::uuid
      `;
      expect(publishRows).toHaveLength(0);

      // Now the owning dispatch arrives. It cannot claim a terminal turn, takes
      // the readTerminalTurn branch, and closes the row — writing no domain
      // rows of its own.
      await handleAgentTurn(db, jobFor({ ...payload, outbox_attempt: 2 }));
      expect((await readOutbox(payload.outbox_id)).status).toBe('completed');
      expect((await readTurn(created.turnId)).status).toBe(TURN_STATUS.COMPLETED);
      const after = await db<{ id: string }[]>`
        SELECT id FROM agent_proposals
        WHERE turn_id = ${created.turnId}::uuid AND account_id = ${tenant.accountId}::uuid
      `;
      expect(after).toHaveLength(1);

      // And the genuinely CONCURRENT race, on a fresh turn: whichever ordering
      // the scheduler picks, exactly one turn completes with one proposal set.
      const racy = createdOrThrow(await createTurn(db, baseTurnInput()));
      const racyPayload = await payloadFor(racy, 1);
      await markDispatched(db, racyPayload.outbox_id, 1);
      await Promise.all([
        handleAgentTurn(db, jobFor({ ...racyPayload, outbox_attempt: 1 })),
        handleAgentTurn(db, jobFor({ ...racyPayload, outbox_attempt: 1 })),
      ]);
      expect((await readTurn(racy.turnId)).status).toBe(TURN_STATUS.COMPLETED);
      const racyProposals = await db<{ id: string }[]>`
        SELECT id FROM agent_proposals
        WHERE turn_id = ${racy.turnId}::uuid AND account_id = ${tenant.accountId}::uuid
      `;
      expect(racyProposals).toHaveLength(1);
      expect((await readOutbox(racyPayload.outbox_id)).status).toBe('completed');
    });

    it('worker releases its claim on a transient failure so the retry re-claims and completes', async () => {
      const { TransientLLMError } = await import('@/lib/llm/error-classifier');
      runLlmTask
        .mockRejectedValueOnce(new TransientLLMError('provider timeout'))
        .mockResolvedValueOnce(modelReply({
          proposals: [toneProposal()],
          segments: [{ type: 'proposal_ref', index: 0 }],
        }));
      const created = createdOrThrow(await createTurn(db, baseTurnInput()));
      const payload = await payloadFor(created, 1);
      await markDispatched(db, payload.outbox_id, 1);

      await expect(handleAgentTurn(db, jobFor(payload))).rejects.toBeInstanceOf(TransientLLMError);

      // The claim was handed back, so the ~5 s retry can take it immediately
      // rather than bouncing off a live 180 s lease.
      const afterFailure = await readTurn(created.turnId);
      expect(afterFailure.status).toBe(TURN_STATUS.ACCEPTED);
      expect(afterFailure.attempt).toBe(0);
      expect(afterFailure.attempt_token).toBeNull();
      expect((await readOutbox(payload.outbox_id)).status).toBe('dispatched');

      // The retry re-claims and finishes.
      await handleAgentTurn(db, jobFor(payload, { attemptsMade: 1 }));
      expect((await readTurn(created.turnId)).status).toBe(TURN_STATUS.COMPLETED);
      expect((await readOutbox(payload.outbox_id)).status).toBe('completed');
    });

    it('worker fenced completion discards an attempt whose lease was lost', async () => {
      let stolen = false;
      runLlmTask.mockImplementation(async () => {
        // Steal the lease mid-call: exactly the window the fence exists for.
        if (!stolen) {
          stolen = true;
          await db`
            UPDATE agent_turns
            SET attempt_token = ${randomUUID()}::uuid
            WHERE id = ${stolenTurnId}::uuid AND account_id = ${tenant.accountId}::uuid
          `;
        }
        return modelReply({ proposals: [toneProposal()], segments: [{ type: 'proposal_ref', index: 0 }] });
      });
      const created = createdOrThrow(await createTurn(db, baseTurnInput()));
      stolenTurnId = created.turnId;
      const payload = await payloadFor(created, 1);
      await markDispatched(db, payload.outbox_id, 1);

      await handleAgentTurn(db, jobFor(payload));

      const turn = await readTurn(created.turnId);
      // Nothing was written: not the reply, not the proposals, not the outbox.
      expect(turn.status).toBe(TURN_STATUS.RUNNING);
      expect(turn.reply).toBeNull();
      const proposals = await db<{ id: string }[]>`
        SELECT id FROM agent_proposals
        WHERE turn_id = ${created.turnId}::uuid AND account_id = ${tenant.accountId}::uuid
      `;
      expect(proposals).toHaveLength(0);
      expect((await readOutbox(payload.outbox_id)).status).toBe('dispatched');
    });

    it('worker predecessor wait releases the claim and delays the job without spending retry budget', async () => {
      runLlmTask.mockResolvedValue(modelReply());
      const conversationId = randomUUID();
      const first = createdOrThrow(await createTurn(db, baseTurnInput({ conversationId })));
      const second = createdOrThrow(await createTurn(db, baseTurnInput({
        conversationId, text: 'Also keep them short.',
      })));
      // Turn 1 is in flight with a FRESH claim — not stalled.
      await db`
        UPDATE agent_turns
        SET status = 'running', attempt = 1, attempt_token = ${randomUUID()}::uuid, claimed_at = NOW()
        WHERE id = ${first.turnId}::uuid AND account_id = ${tenant.accountId}::uuid
      `;
      const payload = await payloadFor(second, 1);
      await markDispatched(db, payload.outbox_id, 1);
      const job = jobFor(payload);

      await expect(handleAgentTurn(db, job)).rejects.toBeInstanceOf(DelayedError);

      expect(job.moveToDelayed).toHaveBeenCalledTimes(1);
      const [delayUntil, token] = vi.mocked(job.moveToDelayed).mock.calls[0]!;
      expect(token).toBe('token-1');
      expect(delayUntil).toBeGreaterThan(Date.now() + 5_000);
      expect(delayUntil).toBeLessThanOrEqual(Date.now() + 10_000);

      // The claim was handed back and the wait cost nothing.
      const turn = await readTurn(second.turnId);
      expect(turn.status).toBe(TURN_STATUS.ACCEPTED);
      expect(turn.attempt).toBe(0);
      expect(turn.attempt_token).toBeNull();
      // The outbox row is still in flight — the job is delayed, not finished.
      expect((await readOutbox(payload.outbox_id)).status).toBe('dispatched');
      expect(runLlmTask).not.toHaveBeenCalled();
    });

    it('worker fails the turn predecessor_stalled after the stall limit', async () => {
      runLlmTask.mockResolvedValue(modelReply());
      const conversationId = randomUUID();
      const first = createdOrThrow(await createTurn(db, baseTurnInput({ conversationId })));
      const second = createdOrThrow(await createTurn(db, baseTurnInput({
        conversationId, text: 'Also keep them short.',
      })));
      // 21 minutes — past AGENT_TURN_PREDECESSOR_STALL_SECONDS (1200 s).
      await db`
        UPDATE agent_turns
        SET status = 'running', attempt = 1, attempt_token = ${randomUUID()}::uuid,
            claimed_at = NOW() - interval '21 minutes'
        WHERE id = ${first.turnId}::uuid AND account_id = ${tenant.accountId}::uuid
      `;
      const payload = await payloadFor(second, 1);
      await markDispatched(db, payload.outbox_id, 1);
      const job = jobFor(payload);

      await handleAgentTurn(db, job);

      const turn = await readTurn(second.turnId);
      expect(turn.status).toBe(TURN_STATUS.FAILED);
      expect(turn.failure_reason).toBe(TURN_FAILURE_REASON.PREDECESSOR_STALLED);
      expect((await readOutbox(payload.outbox_id)).status).toBe('completed');
      expect(job.moveToDelayed).not.toHaveBeenCalled();
      expect(runLlmTask).not.toHaveBeenCalled();
    });

    it('worker step 3 fails the turn unauthorized for a revoked owner and builds no snapshot', async () => {
      runLlmTask.mockResolvedValue(modelReply());
      const created = createdOrThrow(await createTurn(db, baseTurnInput()));
      const payload = await payloadFor(created, 1);
      await markDispatched(db, payload.outbox_id, 1);
      // Role revoked: the users row no longer satisfies role = 'owner'.
      await db`UPDATE users SET role = 'admin' WHERE id = ${tenant.userId}::uuid`;

      try {
        await handleAgentTurn(db, jobFor(payload));
      } finally {
        await db`UPDATE users SET role = 'owner' WHERE id = ${tenant.userId}::uuid`;
      }

      const turn = await readTurn(created.turnId);
      expect(turn.status).toBe(TURN_STATUS.FAILED);
      expect(turn.failure_reason).toBe(TURN_FAILURE_REASON.UNAUTHORIZED);
      expect(turn.reply).toBeNull();
      expect(runLlmTask).not.toHaveBeenCalled();
      expect((await readOutbox(payload.outbox_id)).status).toBe('completed');
    });

    it('worker step 3 fails the turn account_offboarding for an offboarding account and builds no snapshot', async () => {
      runLlmTask.mockResolvedValue(modelReply());
      const created = createdOrThrow(await createTurn(db, baseTurnInput()));
      const payload = await payloadFor(created, 1);
      await markDispatched(db, payload.outbox_id, 1);
      // A live offboarding in a processing-blocked state. `isFullBlockState`
      // (src/lib/account-offboarding/gate.ts) blocks mode 'delete_data'
      // outright and status 'tearing_down' besides, which is what
      // assertWritableSubscriptionForAccount maps to
      // `account_offboarding_blocked`. `terminal_at` stays NULL so the row is
      // the ACTIVE offboarding the gate reads.
      await db`
        INSERT INTO account_offboardings (id, account_id, mode, status)
        VALUES (${randomUUID()}::uuid, ${tenant.accountId}::uuid, 'delete_data', 'tearing_down')
      `;

      await handleAgentTurn(db, jobFor(payload));

      const turn = await readTurn(created.turnId);
      expect(turn.status).toBe(TURN_STATUS.FAILED);
      expect(turn.failure_reason).toBe(TURN_FAILURE_REASON.ACCOUNT_OFFBOARDING);
      expect(turn.reply).toBeNull();
      expect(runLlmTask).not.toHaveBeenCalled();
      expect((await readOutbox(payload.outbox_id)).status).toBe('completed');
    });

    it('worker retries the model call once on invalid output and fails the turn model_output_invalid on the second failure', async () => {
      runLlmTask
        // Attempt 1: an invented count next to a metric word.
        .mockResolvedValueOnce(modelReply({
          segments: [{ type: 'text', text: 'You have 3 reviews waiting.' }],
        }))
        // Attempt 2: a completion claim before any click.
        .mockResolvedValueOnce(modelReply({
          segments: [{ type: 'text', text: 'I have updated your tone.' }],
        }));
      const created = createdOrThrow(await createTurn(db, baseTurnInput()));
      const payload = await payloadFor(created, 1);
      await markDispatched(db, payload.outbox_id, 1);

      await handleAgentTurn(db, jobFor(payload));

      expect(runLlmTask).toHaveBeenCalledTimes(2);
      // The retry carries the validator's reason back to the model.
      const secondPrompt = runLlmTask.mock.calls[1]![1] as { user: string };
      expect(secondPrompt.user).toContain('previousAttemptRejectedBecause');
      // EVERY attempt is billed and audited, including the invalid one.
      expect(recordApiCost).toHaveBeenCalledTimes(2);
      expect(recordApiCost.mock.calls[0]![1]).toMatchObject({ endpoint: 'owner-operator' });

      const turn = await readTurn(created.turnId);
      expect(turn.status).toBe(TURN_STATUS.FAILED);
      expect(turn.failure_reason).toBe(TURN_FAILURE_REASON.MODEL_OUTPUT_INVALID);
      expect(turn.reply).toBeNull();
      const proposals = await db<{ id: string }[]>`
        SELECT id FROM agent_proposals
        WHERE turn_id = ${created.turnId}::uuid AND account_id = ${tenant.accountId}::uuid
      `;
      expect(proposals).toHaveLength(0);
      expect((await readOutbox(payload.outbox_id)).status).toBe('completed');
    });

    it('worker supersedes earlier pending proposals with the same operation and scope', async () => {
      const conversationId = randomUUID();

      runLlmTask.mockResolvedValue(modelReply({
        proposals: [
          toneProposal(),
          {
            operation: 'set_avoid_facts',
            scope: { accountId: tenant.accountId, locationId },
            input: { avoidFacts: ['never mention the old owner'] },
            rationale: 'You asked me to leave that out.',
          },
        ],
        segments: [{ type: 'proposal_ref', index: 0 }, { type: 'proposal_ref', index: 1 }],
      }));
      const first = createdOrThrow(await createTurn(db, baseTurnInput({ conversationId })));
      const firstPayload = await payloadFor(first, 1);
      await markDispatched(db, firstPayload.outbox_id, 1);
      await handleAgentTurn(db, jobFor(firstPayload));

      // A correction: same operation, same scope.
      runLlmTask.mockResolvedValue(modelReply({
        proposals: [{ ...toneProposal(), input: { tone: 'warm, brief and specific' } }],
        segments: [{ type: 'proposal_ref', index: 0 }],
      }));
      const second = createdOrThrow(await createTurn(db, baseTurnInput({
        conversationId, text: 'Actually make it more specific too.',
      })));
      const secondPayload = await payloadFor(second, 1);
      await markDispatched(db, secondPayload.outbox_id, 1);
      await handleAgentTurn(db, jobFor(secondPayload));

      const rows = await db<{
        id: string; operation: string; status: string; superseded_by: string | null; turn_id: string;
      }[]>`
        SELECT id, operation, status, superseded_by, turn_id
        FROM agent_proposals
        WHERE conversation_id = ${conversationId}::uuid
          AND account_id = ${tenant.accountId}::uuid
        ORDER BY created_at ASC
      `;
      const firstTone = rows.find((r) => r.turn_id === first.turnId && r.operation === 'set_tone')!;
      const secondTone = rows.find((r) => r.turn_id === second.turnId && r.operation === 'set_tone')!;
      const avoid = rows.find((r) => r.operation === 'set_avoid_facts')!;

      expect(firstTone.status).toBe(PROPOSAL_STATUS.SUPERSEDED);
      expect(firstTone.superseded_by).toBe(secondTone.id);
      expect(secondTone.status).toBe(PROPOSAL_STATUS.PENDING);
      // A different operation on the same scope is untouched.
      expect(avoid.status).toBe(PROPOSAL_STATUS.PENDING);
      expect(avoid.superseded_by).toBeNull();
    });

    // ── createTurn concurrency + verbatim text (extras, not promised titles) ──

    it('createTurn resolves one turn key across two conversations to created and turn_key_conflict without leaking 23505', async () => {
      const clientTurnKey = randomUUID();
      // DIFFERENT conversations, so the two calls take FOR UPDATE on different
      // rows and neither serializes behind the other: the loser's INSERT hits
      // agent_turns_account_client_key_uniq. The caller must still see a clean
      // 409, never a raw unique violation.
      const results = await Promise.all([
        createTurn(db, baseTurnInput({ conversationId: randomUUID(), clientTurnKey })),
        createTurn(db, baseTurnInput({
          conversationId: randomUUID(), clientTurnKey, text: 'A different message.',
        })),
      ]);

      const kinds = results.map((r) => r.kind).sort();
      expect(kinds).toEqual(['created', 'turn_key_conflict']);

      const turns = await db<{ id: string }[]>`
        SELECT id FROM agent_turns
        WHERE account_id = ${tenant.accountId}::uuid
          AND client_turn_key = ${clientTurnKey}::uuid
      `;
      expect(turns).toHaveLength(1);
      const outbox = await db<{ id: string }[]>`
        SELECT id FROM job_outbox
        WHERE topic = 'agent_turn' AND aggregate_id = ${turns[0]!.id}::uuid
      `;
      expect(outbox).toHaveLength(1);
    });

    it('createTurn returns the same ids for two concurrent identical POSTs and writes one row', async () => {
      const input = baseTurnInput();
      const results = await Promise.all([createTurn(db, input), createTurn(db, input)]);

      // One of them created it; both answer with the same ids.
      expect(new Set(results.map((r) => r.kind))).toEqual(new Set(['created', 'existing']));
      const ids = results.map((r) => (r.kind === 'created' || r.kind === 'existing' ? r.turnId : null));
      expect(ids[0]).toBe(ids[1]);

      const turns = await db<{ id: string }[]>`
        SELECT id FROM agent_turns
        WHERE account_id = ${tenant.accountId}::uuid
          AND client_turn_key = ${input.clientTurnKey}::uuid
      `;
      expect(turns).toHaveLength(1);
      const outbox = await db<{ id: string }[]>`
        SELECT id FROM job_outbox
        WHERE topic = 'agent_turn' AND aggregate_id = ${turns[0]!.id}::uuid
      `;
      expect(outbox).toHaveLength(1);
    });

    it('createTurn stores owner_text byte-for-byte and treats a trimmed repeat as a conflict', async () => {
      const clientTurnKey = randomUUID();
      const padded = '  keep it warm  ';
      const created = createdOrThrow(await createTurn(db, baseTurnInput({ clientTurnKey, text: padded })));

      const [row] = await db<{ owner_text: string }[]>`
        SELECT owner_text FROM agent_turns
        WHERE id = ${created.turnId}::uuid AND account_id = ${tenant.accountId}::uuid
      `;
      // VERBATIM: no trim anywhere on the path, so the padding survives.
      expect(row!.owner_text).toBe(padded);

      // The trimmed form is a DIFFERENT payload under the same key. A `.trim()`
      // re-introduced anywhere would make this return `existing` instead.
      const repeat = await createTurn(db, baseTurnInput({ clientTurnKey, text: 'keep it warm' }));
      expect(repeat.kind).toBe('turn_key_conflict');

      const turns = await db<{ id: string }[]>`
        SELECT id FROM agent_turns
        WHERE account_id = ${tenant.accountId}::uuid
          AND client_turn_key = ${clientTurnKey}::uuid
      `;
      expect(turns).toHaveLength(1);
    });

    // ── the offboarding purge (extra, not a promised title) ───────────────────

    it('content purge removes account A\'s owner-operator rows and preserves account B', async () => {
      const { runContentPurgeStage } = await import(
        '../../../../../worker/jobs/account-offboarding/purge-stages'
      );
      const { verificationQuery } = await import('@/lib/account-offboarding/purge-verification');

      const other = await seedTenantAccount(db, {
        userName: 'Neighbour Owner', accountDisplayName: 'Neighbour Account',
      });
      const otherLocation = (await seedLocation(db, other.accountId, { name: 'Neighbour' })).businessId;

      // Account A: two turns in one conversation, a superseded proposal chain,
      // a NULL-location (account-default) proposal, and an unsupported row.
      const conversationId = randomUUID();
      runLlmTask.mockResolvedValue(modelReply({
        proposals: [toneProposal()],
        segments: [{ type: 'proposal_ref', index: 0 }],
        unsupported: [{ request: 'Stop replying on weekends', context: '' }],
      }));
      const first = createdOrThrow(await createTurn(db, baseTurnInput({ conversationId })));
      const firstPayload = await payloadFor(first, 1);
      await markDispatched(db, firstPayload.outbox_id, 1);
      await handleAgentTurn(db, jobFor(firstPayload));
      const second = createdOrThrow(await createTurn(db, baseTurnInput({
        conversationId, text: 'Actually make it more specific too.',
      })));
      const secondPayload = await payloadFor(second, 1);
      await markDispatched(db, secondPayload.outbox_id, 1);
      await handleAgentTurn(db, jobFor(secondPayload));
      // The superseded chain must exist, or this case proves less than it claims.
      const superseded = await db<{ id: string }[]>`
        SELECT id FROM agent_proposals
        WHERE account_id = ${tenant.accountId}::uuid AND superseded_by IS NOT NULL
      `;
      expect(superseded.length).toBeGreaterThan(0);
      // An account-default proposal: location_id IS NULL, which a business join
      // would leave behind.
      await db`
        INSERT INTO agent_proposals (
          id, conversation_id, turn_id, account_id, actor_user_id, location_id,
          operation, contract_version, input, before, after, rationale,
          label_kind, prepared_version_token, status
        )
        VALUES (
          ${randomUUID()}::uuid, ${conversationId}::uuid, ${second.turnId}::uuid,
          ${tenant.accountId}::uuid, ${tenant.userId}::uuid, NULL,
          'set_tone', 1, ${db.json({ tone: 'warm' })}, ${db.json({})}, ${db.json({})},
          'account default', 'fact', ${db.json({ businessId: null })}, 'pending'
        )
      `;

      // Account B gets its own conversation + turn, untouched by the purge.
      const otherTurn = createdOrThrow(await createTurn(db, {
        accountId: other.accountId,
        actorUserId: other.userId,
        conversationId: randomUUID(),
        clientTurnKey: randomUUID(),
        locationId: otherLocation,
        text: 'Neighbour message.',
      }));

      // Spelled in full rather than cast: AccountOffboardingPurgeRow
      // (worker/jobs/account-offboarding/purge-stages.ts:30) carries five more
      // columns than the plan's literal, and the four Operator arms read only
      // `account_id`.
      const purgeRow: AccountOffboardingPurgeRow = {
        id: randomUUID(),
        account_id: tenant.accountId,
        mode: 'delete_data',
        status: 'purge_scheduled',
        terminal_at: null,
        teardown_completed_at: null,
        purge_started_at: null,
        purge_cancelled_at: null,
        auth_user_id: null,
        recipient_email: null,
        provider_dispositions: null,
        stripe_customer_id: null,
        stripe_subscription_id: null,
        zernio_account_ids: null,
        zernio_profile_ids: null,
        location_ids: null,
        stripe_step: null,
        zernio_accounts_step: null,
        zernio_profiles_step: null,
        location_archival_step: null,
      };
      // (sql, row) — worker/jobs/account-offboarding/purge-stages.ts:245.
      await runContentPurgeStage(db, purgeRow);

      for (const table of ['agent_unsupported_requests', 'agent_proposals', 'agent_turns', 'agent_conversations']) {
        const [remaining] = await verificationQuery(
          table,
          {
            accountId: tenant.accountId,
            offboardingId: purgeRow.id,
            currentOutboxId: randomUUID(),
            authUserId: null,
            stripeCustomerId: null,
            stripeSubscriptionId: null,
          },
          db,
        );
        expect(Number(remaining!.violation_count), `${table} after purge`).toBe(0);
      }

      // Account B is untouched.
      const survivors = await db<{ id: string }[]>`
        SELECT id FROM agent_turns
        WHERE account_id = ${other.accountId}::uuid AND id = ${otherTurn.turnId}::uuid
      `;
      expect(survivors).toHaveLength(1);

      await db`DELETE FROM agent_turns WHERE account_id = ${other.accountId}::uuid`;
      await db`DELETE FROM agent_conversations WHERE account_id = ${other.accountId}::uuid`;
      await db`DELETE FROM businesses WHERE account_id = ${other.accountId}::uuid`;
      await cleanupTenantAccount(db, other);
    });
  },
);
