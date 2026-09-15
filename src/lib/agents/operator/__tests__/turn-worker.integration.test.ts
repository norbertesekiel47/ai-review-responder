// Live-DB proofs for the AgentTurnWorker claim/fence protocol (T7). Seeds
// through seedTenantAccount / seedLocation, gates on describeWithDb, locks with
// acquireLiveDbLock, and asserts the schema with assertSchemaReady. runLlmTask,
// the cost guard and the api_costs audit are mocked (plan decision V2); the
// database is real.
import { randomUUID } from 'node:crypto';
import { DelayedError, type Job, type Queue } from 'bullmq';
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
vi.mock('../../../../../worker/queues', () => ({ topicToQueue: {} }));

import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import { abortingExecutor } from '@/lib/shared/__tests__/helpers/abort-injection';
import { createWorkerLogger } from '@/lib/shared/logger';
import { runOutboxTopicDispatch, runOutboxWatchdogRecovery } from '../../../../../worker/background/pollers/OutboxPoller';
import { REVIEW_STATUS } from '@/lib/reviews/status';
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
import { handleAgentTurnFailed } from '../../../../../worker/jobs/agent-turn/failed-hook';
import * as refusalWriter from '@/lib/refusals/write';
import { AGENT_TURN_LEASE_SECONDS } from '../../../../../worker/jobs/agent-turn/constants';
import { REVIEW_TEXT_REMOVED_MARKER } from '../render';
import { applyProposal } from '../apply';
import { listProposalsForTurn } from '../proposals';
import { getConversationForOwner, getTurnForOwner } from '../reads';
import {
  PROPOSAL_STATUS,
  SERVER_NOTICE,
  parseJsonbObject,
  parseReplySegments,
  TURN_FAILURE_REASON,
  TURN_STATUS,
} from '../schema';
import { claimTurn, completeTurnFenced, createTurn, releaseTurnClaim, type CreateTurnResult, type TurnReplyPlan } from '../turns';

const testDatabaseUrl = resolveTestDatabaseUrl();
let db: postgres.Sql;
let lock: LiveDbLock | undefined;
let tenant: TenantSeed;
let locationId: string;
/** A SECOND location, so the account aggregate can differ from the turn's own. */
let secondLocationId: string;
/** The lease-theft mock needs the turn id before `createTurn` returns it. */
let stolenTurnId = '';

/**
 * One review + its draft, in the shape the live schema actually requires:
 * `reviews` carries three NOT NULL provider identifiers,
 * `responses.original_draft_text` is NOT NULL, and `unique_provider_review` is
 * (provider, provider_review_name) so the name is minted per row.
 */
async function seedReview(
  businessId: string,
  starRating: number | null,
  responseStatus: typeof REVIEW_STATUS.PENDING_APPROVAL | typeof REVIEW_STATUS.POSTED,
): Promise<void> {
  const reviewId = randomUUID();
  await db`
    INSERT INTO reviews (id, business_id, provider, provider_review_id, provider_review_name,
                         provider_location_name, reviewer_name, star_rating, review_text,
                         review_date, status)
    VALUES (${reviewId}::uuid, ${businessId}::uuid, 'google', ${`seed-${reviewId}`},
            ${`seed-${reviewId}`}, ${`locations/${businessId}`}, 'Seed Reviewer',
            ${starRating}, 'Seeded review body.', NOW(), ${responseStatus})
  `;
  await db`
    INSERT INTO responses (id, review_id, business_id, response_text, original_draft_text,
                           status, version, posted_at)
    VALUES (${randomUUID()}::uuid, ${reviewId}::uuid, ${businessId}::uuid,
            'Thank you for the feedback.', 'Thank you for the feedback.',
            ${responseStatus}, 1,
            ${responseStatus === REVIEW_STATUS.POSTED ? new Date() : null})
  `;
}

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

async function readOutbox(outboxId: string) {
  const [row] = await db<{ status: string; last_error: string | null; attempts: number; dispatched_at: string | null }[]>`
    SELECT status, last_error, attempts, dispatched_at::text FROM job_outbox WHERE id = ${outboxId}::uuid
  `;
  if (!row) throw new Error(`no job_outbox row for ${outboxId}`);
  return row;
}

async function seedWaitingTurn(attempt = 1) {
  const conversationId = randomUUID();
  const first = createdOrThrow(await createTurn(db, baseTurnInput({ conversationId })));
  const second = createdOrThrow(await createTurn(db, baseTurnInput({ conversationId })));
  const payload = await payloadFor(second, attempt);
  await markDispatched(db, payload.outbox_id, attempt);
  return { first, second, payload, job: jobFor(payload) };
}

async function seedAppliedTone() {
  runLlmTask.mockResolvedValue(modelReply({ proposals: [toneProposal()], segments: [{ type: 'proposal_ref', index: 0 }] }));
  const created = createdOrThrow(await createTurn(db, baseTurnInput()));
  const payload = await payloadFor(created);
  await markDispatched(db, payload.outbox_id, 1);
  await handleAgentTurn(db, jobFor(payload));
  const [proposal] = await listProposalsForTurn(db, { turnId: created.turnId, accountId: tenant.accountId });
  if (!proposal) throw new Error('source tone proposal missing');
  const result = await applyProposal(db, {
    accountId: tenant.accountId, actorUserId: tenant.userId, proposalId: proposal.id,
    expectedVersionToken: proposal.preparedVersionToken,
  });
  if (result.kind !== 'applied') throw new Error(`source Apply failed: ${result.kind}`);
  return { ...created, proposal: result.proposal };
}

function restoreReplyPlan(): TurnReplyPlan {
  const band = { locationId, total: 0, byStar: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 } };
  return {
    segments: [{ type: 'proposal_ref', index: 0 }, { type: 'refusal_ref', reason: 'invented_business_fact' }],
    proposalIds: [null], restoreRequests: [{ index: 0, scope: { accountId: tenant.accountId, locationId } }],
    scrubbed: false,
    metrics: { pendingCount: 0, draftsWaiting: 0, posted7d: 0, starBands: band,
      accountStarBands: { ...band, locationId: null }, reportingPeriodDays: 7, asOf: new Date().toISOString() },
  };
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
      secondLocationId = (await seedLocation(db, tenant.accountId, {
        name: 'Cafe', isPrimary: false,
      })).businessId;
      process.env.OWNER_OPERATOR_ENABLED = 'true';
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    afterEach(async () => {
      vi.clearAllMocks();
      // Children first, every statement account-scoped.
      await db`
        DELETE FROM responses
        WHERE business_id = ANY(${[locationId, secondLocationId]}::uuid[])
      `;
      await db`
        DELETE FROM reviews
        WHERE business_id = ANY(${[locationId, secondLocationId]}::uuid[])
      `;
      await db`
        UPDATE businesses SET tone = NULL
        WHERE account_id = ${tenant.accountId}::uuid
      `;
      await db`DELETE FROM agent_unsupported_requests WHERE account_id = ${tenant.accountId}::uuid`;
      await db`DELETE FROM refusal_events WHERE account_id = ${tenant.accountId}::uuid`;
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

    it('distinct same-lane Operator refusals retain distinct durable subjects with mixed ordinary and Restore indices', async () => {
      const source = await seedAppliedTone();
      const created = createdOrThrow(await createTurn(db, baseTurnInput({ conversationId: source.conversationId })));
      const payload = await payloadFor(created);
      await markDispatched(db, payload.outbox_id, 1);
      runLlmTask.mockResolvedValue(modelReply({
        proposals: [
          { operation: 'restore_last', scope: { accountId: tenant.accountId, locationId }, input: {}, rationale: 'Restore the last change' },
          { ...toneProposal(), operation: 'set_avoid_facts', input: { avoidFacts: ['prices'] } },
        ],
        segments: [{ type: 'proposal_ref', index: 0 }, { type: 'refusal_ref', reason: 'invented_business_fact' },
          { type: 'proposal_ref', index: 1 }, { type: 'refusal_ref', reason: 'customer_data_exposure' }],
      }));
      await handleAgentTurn(db, jobFor(payload));
      const turn = await readTurn(created.turnId);
      expect(turn.status).toBe(TURN_STATUS.COMPLETED);
      const proposals = await listProposalsForTurn(db, { turnId: created.turnId, accountId: tenant.accountId });
      const restored = proposals.find((proposal) => proposal.operation === 'set_tone');
      const ordinary = proposals.find((proposal) => proposal.operation === 'set_avoid_facts');
      expect(restored?.status).toBe(PROPOSAL_STATUS.PENDING);
      expect(restored?.input).toEqual({ restore: { sourceProposalId: source.proposal.id } });
      expect(ordinary?.status).toBe(PROPOSAL_STATUS.PENDING);
      const segments = parseReplySegments(turn.reply);
      expect(segments[0]).toEqual({ type: 'proposal', proposalId: restored?.id });
      expect(segments[2]).toEqual({ type: 'proposal', proposalId: ordinary?.id });
      const ledger = await db<{ subject_id: string; business_id: string; decision_matches: boolean }[]>`
        SELECT r.subject_id, r.business_id, r.occurred_at = t.completed_at AS decision_matches
        FROM refusal_events r JOIN agent_turns t ON t.id = ${created.turnId}::uuid AND t.account_id = r.account_id
        WHERE r.account_id = ${tenant.accountId}::uuid ORDER BY r.subject_id
      `;
      expect(ledger).toHaveLength(2);
      const subjects = segments.flatMap((segment) => segment.type === 'refusal' ? [segment.subjectId] : []).sort();
      expect(ledger.map((row) => row.subject_id)).toEqual(subjects);
      expect(new Set(subjects).size).toBe(2);
      expect(ledger.every((row) => row.business_id === locationId && row.decision_matches)).toBe(true);
      const polled = await getTurnForOwner(db, { turnId: created.turnId, accountId: tenant.accountId });
      expect(polled?.refused.map((refusal) => refusal.subjectId).sort()).toEqual(subjects);
      expect(polled?.refused.map((refusal) => refusal.reason)).toEqual(['invented_business_fact', 'customer_data_exposure']);
      const reloaded = await getConversationForOwner(db, {
        accountId: tenant.accountId, actorUserId: tenant.userId, conversationId: created.conversationId,
      });
      if (reloaded.kind !== 'view') throw new Error('completed conversation unavailable');
      const reloadedTurn = reloaded.view.turns.find((entry) => entry.id === created.turnId);
      expect(reloadedTurn?.refused).toEqual(polled?.refused);
      expect(reloadedTurn?.segments).toEqual(polled?.segments);
      expect((await readOutbox(payload.outbox_id)).status).toBe('completed');
      expect((await readVoiceColumns(locationId)).tone).toBe('warm and brief');
    });

    it('say we are licensed returns refused without unsupported or Apply', async () => {
      // Classification is mocked; this proves the real worker/persistence/GET
      // pipeline. Staging must separately exercise the actual model classifier.
      const created = createdOrThrow(await createTurn(db, baseTurnInput({ text: 'say we are licensed' })));
      const payload = await payloadFor(created);
      await markDispatched(db, payload.outbox_id, 1);
      const voiceBefore = await readVoiceColumns(locationId);
      const policiesBefore = await db`SELECT * FROM auto_approval_policies WHERE account_id = ${tenant.accountId}::uuid`;
      runLlmTask.mockResolvedValue(modelReply({
        segments: [{ type: 'refusal_ref', reason: 'invented_business_fact' }], proposals: [], unsupported: [],
      }));
      await handleAgentTurn(db, jobFor(payload));
      expect(runLlmTask).toHaveBeenCalledOnce();
      expect(JSON.parse(runLlmTask.mock.calls[0]![1].user)).toMatchObject({ ownerMessage: 'say we are licensed' });
      const polled = await getTurnForOwner(db, { turnId: created.turnId, accountId: tenant.accountId });
      expect(polled).toMatchObject({ status: TURN_STATUS.COMPLETED, proposals: [], unsupported: [] });
      expect(polled?.refused).toEqual([{
        type: 'refusal', reason: 'invented_business_fact', subjectId: expect.any(String),
        text: 'RepWorth rules prohibit inventing or claiming unverified business facts, including licenses and credentials.',
      }]);
      expect(polled?.segments).toEqual(polled?.refused);
      const ledger = await db<{ subject_id: string; refusal_source: string; business_id: string }[]>`
        SELECT subject_id, refusal_source, business_id FROM refusal_events WHERE account_id = ${tenant.accountId}::uuid
      `;
      expect(ledger).toEqual([{
        subject_id: polled!.refused[0]!.subjectId, refusal_source: 'operator_content_refused', business_id: locationId,
      }]);
      const reloaded = await getConversationForOwner(db, {
        accountId: tenant.accountId, actorUserId: tenant.userId, conversationId: created.conversationId,
      });
      if (reloaded.kind !== 'view') throw new Error('completed conversation unavailable');
      expect(reloaded.view.turns[0]).toMatchObject({ refused: polled?.refused, proposals: [], unsupported: [] });
      expect(await readVoiceColumns(locationId)).toEqual(voiceBefore);
      expect(await db`SELECT * FROM auto_approval_policies WHERE account_id = ${tenant.accountId}::uuid`).toEqual(policiesBefore);
      expect((await readOutbox(payload.outbox_id)).status).toBe('completed');
    });

    it('a lost completion fence writes no restore proposals or refusals', async () => {
      await seedAppliedTone();
      const created = createdOrThrow(await createTurn(db, baseTurnInput()));
      const payload = await payloadFor(created);
      await markDispatched(db, payload.outbox_id, 1);
      const claimed = await claimTurn(db, { turnId: created.turnId, accountId: tenant.accountId, leaseSeconds: 180 });
      if (!claimed) throw new Error('turn claim missing');
      const result = await completeTurnFenced(db, {
        ...created, accountId: tenant.accountId, attemptToken: randomUUID(),
        segments: [], proposals: [], unsupported: [], replyPlan: restoreReplyPlan(),
        outboxId: payload.outbox_id, outboxAttempt: 1,
      });
      expect(result).toEqual({ fenced: false });
      expect(await readTurn(created.turnId)).toMatchObject({ status: TURN_STATUS.RUNNING, reply: null, attempt_token: claimed.attemptToken });
      expect(await listProposalsForTurn(db, { turnId: created.turnId, accountId: tenant.accountId })).toHaveLength(0);
      expect(await db`SELECT id FROM refusal_events WHERE account_id = ${tenant.accountId}::uuid`).toHaveLength(0);
      expect((await readOutbox(payload.outbox_id)).status).toBe('dispatched');
    });

    it('a refusal ledger failure rolls back the completed turn and its already prepared Restore', async () => {
      await seedAppliedTone();
      const created = createdOrThrow(await createTurn(db, baseTurnInput()));
      const payload = await payloadFor(created);
      await markDispatched(db, payload.outbox_id, 1);
      const claimed = await claimTurn(db, { turnId: created.turnId, accountId: tenant.accountId, leaseSeconds: 180 });
      if (!claimed) throw new Error('turn claim missing');
      const fault = vi.spyOn(refusalWriter, 'writeRefusalEvent').mockImplementationOnce(async (tx) => {
        const prepared = await tx`SELECT id FROM agent_proposals WHERE account_id = ${tenant.accountId}::uuid AND turn_id = ${created.turnId}::uuid`;
        expect(prepared).toHaveLength(1);
        await tx`SELECT 1 / 0`;
      });
      try {
        await expect(completeTurnFenced(db, {
          ...created, accountId: tenant.accountId, attemptToken: claimed.attemptToken,
          segments: [], proposals: [], unsupported: [], replyPlan: restoreReplyPlan(),
          outboxId: payload.outbox_id, outboxAttempt: 1,
        })).rejects.toMatchObject({ code: '22012' });
      } finally {
        fault.mockRestore();
      }
      expect(await readTurn(created.turnId)).toMatchObject({ status: TURN_STATUS.RUNNING, reply: null, attempt_token: claimed.attemptToken });
      expect(await listProposalsForTurn(db, { turnId: created.turnId, accountId: tenant.accountId })).toHaveLength(0);
      expect(await db`SELECT id FROM refusal_events WHERE account_id = ${tenant.accountId}::uuid`).toHaveLength(0);
      expect((await readOutbox(payload.outbox_id)).status).toBe('dispatched');
    });

    it('missing restore history produces a fixed server explanation and no proposal', async () => {
      const created = createdOrThrow(await createTurn(db, baseTurnInput()));
      const payload = await payloadFor(created);
      await markDispatched(db, payload.outbox_id, 1);
      runLlmTask.mockResolvedValue(modelReply({ proposals: [
        { operation: 'restore_last', scope: { accountId: tenant.accountId, locationId }, input: {}, rationale: 'Restore' },
      ], segments: [{ type: 'proposal_ref', index: 0 }] }));
      await handleAgentTurn(db, jobFor(payload));
      expect(parseReplySegments((await readTurn(created.turnId)).reply)).toEqual([
        { type: 'server_notice', notice: SERVER_NOTICE.RESTORE_UNAVAILABLE },
      ]);
      expect(await listProposalsForTurn(db, { turnId: created.turnId, accountId: tenant.accountId })).toHaveLength(0);
      expect((await readOutbox(payload.outbox_id)).status).toBe('completed');
    });

    it('restore completion and concurrent turn submission finish without a parent conversation deadlock', async () => {
      const source = await seedAppliedTone();
      const created = createdOrThrow(await createTurn(db, baseTurnInput({ conversationId: source.conversationId })));
      const payload = await payloadFor(created);
      await markDispatched(db, payload.outbox_id, 1);
      const claimed = await claimTurn(db, { turnId: created.turnId, accountId: tenant.accountId, leaseSeconds: 180 });
      if (!claimed) throw new Error('turn claim missing');
      let signalConversation!: () => void;
      const conversationLocked = new Promise<void>((resolve) => { signalConversation = resolve; });
      let signalParents!: () => void;
      const parentsLocked = new Promise<void>((resolve) => { signalParents = resolve; });
      // Keep the real createTurn transaction and SQL. Pre-acquire its own
      // conversation lock to force the formerly cyclic interleaving.
      const submitting = new Proxy(db, {
        get(target, property) {
          if (property !== 'begin') return Reflect.get(target, property);
          return (callback: (tx: postgres.TransactionSql) => Promise<unknown>) => target.begin(async (tx) => {
            await tx`SET LOCAL statement_timeout = '5s'`;
            await tx`SELECT id FROM agent_conversations WHERE id = ${created.conversationId}::uuid AND account_id = ${tenant.accountId}::uuid FOR UPDATE`;
            signalConversation();
            await parentsLocked;
            return callback(tx);
          });
        },
      });
      // Insertion follows authoritative scope locks and source validation.
      // It must wait for submission's conversation lock while submission's
      // account/business FK KEY SHARE checks can pass those scope locks.
      const completing = new Proxy(db, {
        get(target, property) {
          if (property !== 'begin') return Reflect.get(target, property);
          return (callback: (tx: postgres.TransactionSql) => Promise<unknown>) => target.begin(async (tx) => {
            await tx`SET LOCAL statement_timeout = '5s'`;
            return callback(new Proxy(tx, {
              apply(transaction, thisArg, args: unknown[]) {
                const query = (args[0] as TemplateStringsArray).join(' ');
                if (/INSERT\s+INTO\s+agent_proposals/i.test(query)) signalParents();
                return Reflect.apply(transaction, thisArg, args);
              },
            }));
          });
        },
      });
      const nextTurn = createTurn(submitting, baseTurnInput({ conversationId: created.conversationId, text: 'Keep my next request.' }));
      await conversationLocked;
      const completion = completeTurnFenced(completing, {
        ...created, accountId: tenant.accountId, attemptToken: claimed.attemptToken,
        segments: [], proposals: [], unsupported: [], replyPlan: restoreReplyPlan(),
        outboxId: payload.outbox_id, outboxAttempt: 1,
      }).finally(signalParents);
      const results = await Promise.allSettled([nextTurn, completion]);
      expect(results[0]).toMatchObject({ status: 'fulfilled', value: { kind: 'created' } });
      expect(results[1]).toEqual({ status: 'fulfilled', value: { fenced: true } });
      expect((await readTurn(created.turnId)).status).toBe(TURN_STATUS.COMPLETED);
      expect((await readOutbox(payload.outbox_id)).status).toBe('completed');
      expect(await listProposalsForTurn(db, { turnId: created.turnId, accountId: tenant.accountId })).toHaveLength(1);
      expect((await readVoiceColumns(locationId)).tone).toBe('warm and brief');
    });

    it('worker claim race: two dispatches of one turn produce one completed turn and one proposal set', async () => {
      // DISTINCT counts, so each materialized value can only match the metric
      // it names: 2 pending here, 1 pending at the other location (account
      // total 3), 4 posted here inside the 7-day window.
      await seedReview(locationId, 5, REVIEW_STATUS.PENDING_APPROVAL);
      await seedReview(locationId, 2, REVIEW_STATUS.PENDING_APPROVAL);
      await seedReview(secondLocationId, 4, REVIEW_STATUS.PENDING_APPROVAL);
      for (let i = 0; i < 4; i += 1) await seedReview(locationId, 5, REVIEW_STATUS.POSTED);
      // A seeded tone, so `before` is a real prior state rather than nulls.
      await db`
        UPDATE businesses SET tone = 'formal and factual'
        WHERE id = ${locationId}::uuid AND account_id = ${tenant.accountId}::uuid
      `;

      runLlmTask.mockResolvedValue(modelReply({
        proposals: [toneProposal()],
        segments: [
          { type: 'proposal_ref', index: 0 },
          { type: 'status_ref', metric: 'pending_count' },
          { type: 'status_ref', metric: 'drafts_waiting' },
          { type: 'status_ref', metric: 'posted_7d' },
        ],
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
        before: unknown; after: unknown; prepared_version_token: unknown;
      }[]>`
        SELECT id, operation, status, location_id, contract_version, requires_confirmation,
               before, after, prepared_version_token
        FROM agent_proposals
        WHERE turn_id = ${created.turnId}::uuid AND account_id = ${tenant.accountId}::uuid
      `;
      expect(proposals).toHaveLength(1);
      expect(proposals[0]!.operation).toBe('set_tone');
      expect(proposals[0]!.status).toBe(PROPOSAL_STATUS.PENDING);
      expect(proposals[0]!.location_id).toBe(locationId);
      expect(proposals[0]!.contract_version).toBe(1);
      expect(proposals[0]!.requires_confirmation).toBe(false);

      // `before`/`after` END-TO-END: the FULL effective voice state of the
      // location, computed server-side from the catalog's preview, never from
      // anything the model said. `before` is the tone seeded above — a real
      // prior state — and `after` is the proposed one, with every other field
      // carried across unchanged. Without this the pair could be written empty
      // and Run B's card would render a diff of nothing.
      const voiceBeforeJson = parseJsonbObject(proposals[0]!.before, 'agent_proposals.before');
      const voiceAfterJson = parseJsonbObject(proposals[0]!.after, 'agent_proposals.after');
      expect(voiceBeforeJson.tone).toBe('formal and factual');
      expect(voiceAfterJson.tone).toBe('warm and brief');
      expect(voiceAfterJson.avoidFacts).toEqual(voiceBeforeJson.avoidFacts);
      expect(voiceAfterJson.highlightFacts).toEqual(voiceBeforeJson.highlightFacts);
      expect(voiceAfterJson.productsServices).toEqual(voiceBeforeJson.productsServices);
      // The **Version token** is the location's own `updated_at` AS TEXT — the
      // microseconds Postgres stores, not a JS `Date`'s milliseconds.
      const token = parseJsonbObject(
        proposals[0]!.prepared_version_token,
        'agent_proposals.prepared_version_token',
      );
      const [stamp] = await db<{ updated_at: string }[]>`
        SELECT updated_at::text AS updated_at
        FROM businesses
        WHERE id = ${locationId}::uuid AND account_id = ${tenant.accountId}::uuid
      `;
      expect(token.businessId).toBe(locationId);
      expect(token.updatedAt).toBe(stamp!.updated_at);

      // The turn is DONE and the outbox row is NOT: attempt 1's CAS could not
      // match a row at attempts = 2. This is the exact state that stranded the
      // row before the terminal-turn branch existed.
      expect((await readOutbox(payload.outbox_id)).status).toBe('dispatched');

      // The status_refs were MATERIALIZED, and each one carries ITS OWN
      // number. The counts were seeded distinct on purpose: 2 pending at this
      // location, 3 across the account, 4 posted in the window. `typeof value
      // === 'number'` would pass if every metric resolved to the same figure —
      // equality against the named metric is what catches a swapped branch.
      const stored = parseReplySegments(turn.reply);
      const statuses = stored.filter((segment) => segment.type === 'status');
      expect(statuses).toEqual([
        { type: 'status', metric: 'pending_count', value: 2, reportingPeriodDays: 7, asOf: expect.any(String) },
        { type: 'status', metric: 'drafts_waiting', value: 3, reportingPeriodDays: 7, asOf: expect.any(String) },
        { type: 'status', metric: 'posted_7d', value: 4, reportingPeriodDays: 7, asOf: expect.any(String) },
      ]);
      // The proposal_ref was materialized too: the stored segment carries the
      // stored row's ID, bound at completion where the insertion order is known
      // — not an index a read would have to re-derive by sorting rows that
      // share one `created_at`.
      expect(stored.filter((segment) => segment.type === 'proposal'))
        .toEqual([{ type: 'proposal', proposalId: proposals[0]!.id }]);
      // Asserted against the RAW column, not the parsed union: `StoredSegment`
      // has neither a `status_ref` nor a `proposal_ref` member, so
      // `stored.some((s) => s.type === 'status_ref')` is a compile error rather
      // than a test. The type half is the stronger guarantee and is free; this
      // is the runtime half — the bytes in the row carry no unresolved ref of
      // either kind.
      expect(JSON.stringify(turn.reply)).not.toContain('status_ref');
      expect(JSON.stringify(turn.reply)).not.toContain('proposal_ref');

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
      const llmCallsBefore = runLlmTask.mock.calls.length;
      const billedCallsBefore = recordApiCost.mock.calls.length;
      await Promise.all([
        handleAgentTurn(db, jobFor({ ...racyPayload, outbox_attempt: 1 })),
        handleAgentTurn(db, jobFor({ ...racyPayload, outbox_attempt: 1 })),
      ]);
      // THE SPEND HALF. **Turn claim** (the UPDATE one dispatch wins, bounded by
      // a 180 s lease) and **Fenced completion** (the terminal UPDATE fenced on
      // `attempt_token`) are two SEPARATE guards: the fence stops a stale
      // attempt from WRITING, and only the lease stops a second attempt from
      // SPENDING a second cost-guarded model call. Every end-state assertion
      // below is satisfied by the fence alone, so the lease needs its own
      // oracle — exactly one model call and exactly one billed cost for the
      // racy turn. Asserted on the mock call counts rather than on `api_costs`
      // rows: `recordApiCost` is replaced by the hoisted mock above
      // (`vi.mock('@/lib/costs/audit', …)`), so this suite writes no such row.
      expect(runLlmTask.mock.calls.length - llmCallsBefore).toBe(1);
      expect(recordApiCost.mock.calls.length - billedCallsBefore).toBe(1);
      expect((await readTurn(racy.turnId)).status).toBe(TURN_STATUS.COMPLETED);
      const racyProposals = await db<{ id: string }[]>`
        SELECT id FROM agent_proposals
        WHERE turn_id = ${racy.turnId}::uuid AND account_id = ${tenant.accountId}::uuid
      `;
      expect(racyProposals).toHaveLength(1);
      expect((await readOutbox(racyPayload.outbox_id)).status).toBe('completed');
    });

    it('claimTurn turns a second dispatch away inside the lease and lets one in after it expires', async () => {
      const created = createdOrThrow(await createTurn(db, baseTurnInput()));

      // **Turn claim**: the UPDATE one dispatch wins, bounded by a 180 s lease.
      const first = await claimTurn(db, {
        turnId: created.turnId,
        accountId: tenant.accountId,
        leaseSeconds: AGENT_TURN_LEASE_SECONDS,
      });
      expect(first).not.toBeNull();
      expect(first!.attempt).toBe(1);
      const claimed = await readTurn(created.turnId);
      expect(claimed.status).toBe(TURN_STATUS.RUNNING);
      expect(claimed.attempt_token).toBe(first!.attemptToken);

      // A second dispatch INSIDE the live lease gets nothing, so it never
      // reaches the cost-guarded model call. **Fenced completion** (the terminal
      // UPDATE fenced on `attempt_token`) is a separate guard that would stop
      // this attempt's WRITE; only the lease predicate stops its SPEND.
      const second = await claimTurn(db, {
        turnId: created.turnId,
        accountId: tenant.accountId,
        leaseSeconds: AGENT_TURN_LEASE_SECONDS,
      });
      expect(second).toBeNull();
      const afterSecond = await readTurn(created.turnId);
      expect(afterSecond.attempt).toBe(1);
      expect(afterSecond.attempt_token).toBe(first!.attemptToken);

      // Past the lease, the watchdog's re-dispatch takes the row over: a new
      // attempt number and a NEW token, which is what retires the old one.
      await db`
        UPDATE agent_turns
        SET claimed_at = NOW() - make_interval(secs => ${AGENT_TURN_LEASE_SECONDS + 1})
        WHERE id = ${created.turnId}::uuid AND account_id = ${tenant.accountId}::uuid
      `;
      const third = await claimTurn(db, {
        turnId: created.turnId,
        accountId: tenant.accountId,
        leaseSeconds: AGENT_TURN_LEASE_SECONDS,
      });
      expect(third).not.toBeNull();
      expect(third!.attempt).toBe(2);
      expect(third!.attemptToken).not.toBe(first!.attemptToken);
      expect((await readTurn(created.turnId)).attempt_token).toBe(third!.attemptToken);
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

      const beforeTransient = await readOutbox(payload.outbox_id);
      await expect(handleAgentTurn(db, jobFor(payload))).rejects.toBeInstanceOf(TransientLLMError);
      expect(await readOutbox(payload.outbox_id)).toEqual(beforeTransient);

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

    it('worker fails the turn budget_exceeded terminally instead of burning the retry ladder', async () => {
      const { CostLimitExceededError } = await import('@/lib/costs/tracker');
      runLlmTask.mockRejectedValueOnce(new CostLimitExceededError(locationId));
      const created = createdOrThrow(await createTurn(db, baseTurnInput()));
      const payload = await payloadFor(created, 1);
      await markDispatched(db, payload.outbox_id, 1);
      const job = jobFor(payload);

      // TERMINAL BY DECISION, per the cost-guard contract: one account's
      // exhausted budget is not a systemic failure, so `handleAgentTurn`
      // RESOLVES rather than rethrowing for the BullMQ ladder. Without this
      // branch the error would fall through to `exhausted` five attempts later
      // and the reason the spec promises to distinguish would be lost.
      await expect(handleAgentTurn(db, job)).resolves.toBeUndefined();

      const turn = await readTurn(created.turnId);
      expect(turn.status).toBe(TURN_STATUS.FAILED);
      expect(turn.failure_reason).toBe(TURN_FAILURE_REASON.BUDGET_EXCEEDED);
      // The decision is settled in one transaction with the outbox row, so
      // nothing is left for the watchdog to reclaim.
      expect((await readOutbox(payload.outbox_id)).status).toBe('completed');
      expect(job.moveToDelayed).not.toHaveBeenCalled();
    });

    it('claim release reconciles dispatch exhaustion after a running worker yields', async () => {
      const { TransientLLMError } = await import('@/lib/llm/error-classifier');
      for (const path of ['predecessor', 'transient']) {
        const conversationId = randomUUID();
        if (path === 'predecessor') await createTurn(db, baseTurnInput({ conversationId }));
        const created = createdOrThrow(await createTurn(db, baseTurnInput({ conversationId })));
        const payload = await payloadFor(created, 5);
        await markDispatched(db, payload.outbox_id, 5);
        const terminalizeOutbox = async () => {
          await db`UPDATE job_outbox SET status = 'failed', completed_at = NOW() WHERE id = ${payload.outbox_id}::uuid`;
        };
        if (path === 'predecessor') {
          // A worker delivered by an ambiguous enqueue may still claim this
          // accepted row. Its yield must reconcile the failed outbox.
          await terminalizeOutbox();
        } else {
          runLlmTask.mockImplementationOnce(async () => {
            expect((await readTurn(created.turnId)).status).toBe(TURN_STATUS.RUNNING);
            await terminalizeOutbox();
            throw new TransientLLMError('synthetic timeout after enqueue exhaustion');
          });
        }
        const job = jobFor(payload);
        await expect(handleAgentTurn(db, job)).resolves.toBeUndefined();
        expect(await readTurn(created.turnId)).toMatchObject({ status: TURN_STATUS.FAILED, failure_reason: 'dispatch_exhausted', attempt: 0, attempt_token: null });
        expect(job.moveToDelayed).not.toHaveBeenCalled();
        await handleAgentTurnFailed(db, jobFor(payload, { attemptsMade: 5 }), new Error('late retry exhaustion'));
        expect((await readTurn(created.turnId)).failure_reason).toBe('dispatch_exhausted');
        expect((await readOutbox(payload.outbox_id)).status).toBe('failed');
      }
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

    it('healthy predecessor waits survive the watchdog window without redispatch or retry spending', async () => {
      const { first, second, payload, job } = await seedWaitingTurn();
      const logger = createWorkerLogger('[RunDWaitTest]');
      for (let cycle = 0; cycle < 3; cycle += 1) {
        await db`UPDATE job_outbox SET dispatched_at = NOW() - INTERVAL '16 minutes' WHERE id = ${payload.outbox_id}::uuid`;
        const before = await readOutbox(payload.outbox_id);
        await expect(handleAgentTurn(db, job)).rejects.toBeInstanceOf(DelayedError);
        const after = await readOutbox(payload.outbox_id);
        expect(after).toMatchObject({ status: 'dispatched', attempts: 1 });
        expect(after.dispatched_at).not.toBe(before.dispatched_at);
        await runOutboxWatchdogRecovery(db, 900, logger);
        expect(await readOutbox(payload.outbox_id)).toEqual(after);
        expect(await readTurn(second.turnId)).toMatchObject({ status: 'accepted', attempt: 0, attempt_token: null });
        expect(job.attemptsMade).toBe(0);
      }
      expect(job.moveToDelayed).toHaveBeenCalledTimes(3);
      expect(runLlmTask).not.toHaveBeenCalled();
      // Heartbeats must not reset the predecessor's independent stall age.
      await db`UPDATE agent_turns SET created_at = NOW() - INTERVAL '21 minutes' WHERE id = ${first.turnId}::uuid AND account_id = ${tenant.accountId}::uuid`;
      await handleAgentTurn(db, job);
      expect((await readTurn(second.turnId)).failure_reason).toBe('predecessor_stalled');
    });

    it('predecessor wait ignores a superseded outbox attempt and a stolen turn token', async () => {
      const { second, payload } = await seedWaitingTurn();
      const claimed = await claimTurn(db, { turnId: second.turnId, accountId: tenant.accountId, leaseSeconds: AGENT_TURN_LEASE_SECONDS });
      if (!claimed) throw new Error('fixture claim missing');
      const input = { turnId: second.turnId, accountId: tenant.accountId, attemptToken: claimed.attemptToken, outboxId: payload.outbox_id, outboxAttempt: 1, leaseSeconds: AGENT_TURN_LEASE_SECONDS, refreshLiveness: true };
      const originalTurn = await readTurn(second.turnId);
      const originalOutbox = await readOutbox(payload.outbox_id);
      // The yield must not wait behind completion's turn-first lock order.
      await db.begin(async (completionTx) => {
        await completionTx`SELECT id FROM agent_turns WHERE id = ${second.turnId}::uuid AND account_id = ${tenant.accountId}::uuid FOR UPDATE`;
        await expect(releaseTurnClaim(db, input)).resolves.toBe('lost');
        expect(await readTurn(second.turnId)).toEqual(originalTurn);
        expect(await readOutbox(payload.outbox_id)).toEqual(originalOutbox);
      });
      for (const override of [{ outboxAttempt: 0 }, { outboxAttempt: undefined }, { attemptToken: randomUUID() }, { accountId: randomUUID() }, { outboxId: randomUUID() }]) {
        await expect(releaseTurnClaim(db, { ...input, ...override })).resolves.toBe('lost');
        expect(await readTurn(second.turnId)).toEqual(originalTurn);
        expect(await readOutbox(payload.outbox_id)).toEqual(originalOutbox);
      }
      await db`UPDATE job_outbox SET payload = payload || ${db.json({ conversation_id: randomUUID() })} WHERE id = ${payload.outbox_id}::uuid`;
      await expect(releaseTurnClaim(db, input)).resolves.toBe('lost');
      expect(await readTurn(second.turnId)).toEqual(originalTurn);
      expect(await readOutbox(payload.outbox_id)).toEqual(originalOutbox);
    });

    it('predecessor wait rolls back both liveness and claim release on a database failure', async () => {
      const { second, payload } = await seedWaitingTurn();
      const claimed = await claimTurn(db, { turnId: second.turnId, accountId: tenant.accountId, leaseSeconds: AGENT_TURN_LEASE_SECONDS });
      if (!claimed) throw new Error('fixture claim missing');
      await db`UPDATE job_outbox SET dispatched_at = NOW() - INTERVAL '16 minutes' WHERE id = ${payload.outbox_id}::uuid`;
      const beforeTurn = await readTurn(second.turnId);
      const beforeOutbox = await readOutbox(payload.outbox_id);
      const aborting = abortingExecutor(db, async (tx) => {
        const [updated] = await tx<{ refreshed: boolean }[]>`SELECT dispatched_at > NOW() - INTERVAL '1 minute' AS refreshed FROM job_outbox WHERE id = ${payload.outbox_id}::uuid`;
        expect(updated?.refreshed).toBe(true);
        await tx`SELECT 1 / 0`;
      });
      await expect(releaseTurnClaim(aborting, { turnId: second.turnId, accountId: tenant.accountId, attemptToken: claimed.attemptToken, outboxId: payload.outbox_id, outboxAttempt: 1, leaseSeconds: AGENT_TURN_LEASE_SECONDS, refreshLiveness: true })).rejects.toMatchObject({ code: '22012' });
      expect(await readTurn(second.turnId)).toEqual(beforeTurn);
      expect(await readOutbox(payload.outbox_id)).toEqual(beforeOutbox);
    });

    it('a crashed predecessor wait is recovered by the unchanged watchdog', async () => {
      const { second, payload, job } = await seedWaitingTurn();
      await expect(handleAgentTurn(db, job)).rejects.toBeInstanceOf(DelayedError);
      await db`UPDATE job_outbox SET dispatched_at = NOW() - INTERVAL '16 minutes' WHERE id = ${payload.outbox_id}::uuid`;
      await runOutboxWatchdogRecovery(db, 900, createWorkerLogger('[RunDCrashWaitTest]'));
      expect(await readOutbox(payload.outbox_id)).toMatchObject({ status: 'pending', attempts: 1, dispatched_at: null });
      expect(await readTurn(second.turnId)).toMatchObject({ status: 'accepted', attempt: 0 });
    });

    it('predecessor delay failure preserves a retryable turn and outbox', async () => {
      const { second, payload, job } = await seedWaitingTurn();
      const schedulingError = new Error('synthetic Redis delay failure');
      vi.mocked(job.moveToDelayed).mockRejectedValueOnce(schedulingError);
      await expect(handleAgentTurn(db, job)).rejects.toBe(schedulingError);
      expect(await readTurn(second.turnId)).toMatchObject({ status: 'accepted', attempt: 0, attempt_token: null });
      expect(await readOutbox(payload.outbox_id)).toMatchObject({ status: 'dispatched', attempts: 1 });
      expect(job.attemptsMade).toBe(0);
      await expect(handleAgentTurn(db, job)).rejects.toBeInstanceOf(DelayedError);
      expect(job.moveToDelayed).toHaveBeenCalledTimes(2);
      expect(runLlmTask).not.toHaveBeenCalled();
    });

    it('predecessor wait handles a worker starting before dispatch acknowledgement', async () => {
      const { second, payload } = await seedWaitingTurn();
      await db`UPDATE job_outbox SET status = 'dispatching', dispatched_at = NOW() - INTERVAL '1 minute' WHERE id = ${payload.outbox_id}::uuid`;
      const before = await readOutbox(payload.outbox_id);
      const entries = await db<Parameters<typeof runOutboxTopicDispatch>[3]>`SELECT id, topic, payload, attempts, max_attempts FROM job_outbox WHERE id = ${payload.outbox_id}::uuid`;
      const queue: Pick<Queue, 'addBulk'> = {
        addBulk: vi.fn(async (prepared) => {
          const delivered = prepared[0]!;
          const job = jobFor(delivered.data as AgentTurnPayload, { id: delivered.opts!.jobId });
          await expect(handleAgentTurn(db, job)).rejects.toBeInstanceOf(DelayedError);
          expect(job.moveToDelayed).toHaveBeenCalledOnce();
          const intermediate = await readOutbox(payload.outbox_id);
          expect(intermediate).toMatchObject({ status: 'dispatching', attempts: 1 });
          expect(intermediate.dispatched_at).not.toBe(before.dispatched_at);
          expect(await readTurn(second.turnId)).toMatchObject({ status: 'accepted', attempt: 0, attempt_token: null });
          return [job];
        }),
      };
      await expect(runOutboxTopicDispatch(db, 'agent_turn', queue, entries, 10_000, createWorkerLogger('[RunDHandoffTest]'))).resolves.toBe(false);
      expect(queue.addBulk).toHaveBeenCalledOnce();
      expect(await readOutbox(payload.outbox_id)).toMatchObject({ status: 'dispatched', attempts: 1 });
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

    it('worker scrubs a pasted review out of the prompt and stores the notice as the first segment', async () => {
      // THE ORACLE for the **Pasted-review scrub** on the CURRENT message. The
      // unit tests prove the function; this proves the pipeline actually calls
      // it between the stored row and the provider — the only place where a
      // regression silently ships review text to a third party.
      const reviewBody = 'Great food, terrible parking, and the staff ignored us for twenty minutes.';
      const ownerText = `What do I do about this?\n\n5/5\n${reviewBody} — Priya M.`;
      runLlmTask.mockResolvedValue(modelReply());

      const created = createdOrThrow(await createTurn(db, baseTurnInput({ text: ownerText })));
      const payload = await payloadFor(created, 1);
      await markDispatched(db, payload.outbox_id, 1);

      await handleAgentTurn(db, jobFor(payload));

      // 1. The PROMPT — the whole envelope, system and user — carries none of
      // the review body and none of the reviewer's name.
      expect(runLlmTask).toHaveBeenCalledTimes(1);
      const prompt = runLlmTask.mock.calls[0]![1] as { system: string; user: string };
      const envelope = `${prompt.system}\n${prompt.user}`;
      expect(envelope).not.toContain(reviewBody);
      expect(envelope).not.toContain('terrible parking');
      expect(envelope).not.toContain('Priya M.');
      expect(envelope).toContain(REVIEW_TEXT_REMOVED_MARKER);
      // The owner's actual QUESTION survives — the scrub is block-level, not
      // message-level, or this feature would drop the request itself.
      expect(envelope).toContain('What do I do about this?');

      // 2. The STORED row keeps `owner_text` verbatim: the scrub is a
      // read-path transform, and the owner's own words are theirs.
      const [stored] = await db<{ owner_text: string }[]>`
        SELECT owner_text FROM agent_turns
        WHERE id = ${created.turnId}::uuid AND account_id = ${tenant.accountId}::uuid
      `;
      expect(stored!.owner_text).toBe(ownerText);

      // 3. The REPLY opens with the server-written notice, stored so a refresh
      // renders it again — the GET route never sees the raw message and could
      // not re-derive it.
      const turn = await readTurn(created.turnId);
      expect(turn.status).toBe(TURN_STATUS.COMPLETED);
      const segments = parseReplySegments(turn.reply);
      expect(segments[0]).toEqual({ type: 'server_notice', notice: SERVER_NOTICE.PASTED_REVIEW_REMOVED });
      expect(JSON.stringify(turn.reply)).not.toContain('terrible parking');
    });

    it('worker leaves two same-scope proposals from ONE turn both pending, and a later turn supersedes both', async () => {
      const conversationId = randomUUID();

      // One reply, two proposals with the same (operation, scope). They are
      // SIBLINGS, not a correction of one another: superseding by operation and
      // scope alone would kill one of them from its own sentence, and which one
      // died would depend on the loop order.
      runLlmTask.mockResolvedValue(modelReply({
        proposals: [
          { ...toneProposal(), input: { tone: 'warm and brief' } },
          { ...toneProposal(), input: { tone: 'warm, brief and specific' } },
        ],
        segments: [{ type: 'proposal_ref', index: 0 }, { type: 'proposal_ref', index: 1 }],
      }));
      const first = createdOrThrow(await createTurn(db, baseTurnInput({ conversationId })));
      const firstPayload = await payloadFor(first, 1);
      await markDispatched(db, firstPayload.outbox_id, 1);
      await handleAgentTurn(db, jobFor(firstPayload));

      const sameTurn = await db<{ id: string; tone: string; status: string; superseded_by: string | null }[]>`
        SELECT id, input ->> 'tone' AS tone, status, superseded_by
        FROM agent_proposals
        WHERE turn_id = ${first.turnId}::uuid AND account_id = ${tenant.accountId}::uuid
      `;
      expect(sameTurn).toHaveLength(2);
      for (const row of sameTurn) {
        expect(row.status).toBe(PROPOSAL_STATUS.PENDING);
        expect(row.superseded_by).toBeNull();
      }
      // Identify each proposal by its input: transaction timestamps can tie,
      // so database row order cannot establish the model's proposal order.
      const firstProposal = sameTurn.find((row) => row.tone === 'warm and brief');
      const secondProposal = sameTurn.find((row) => row.tone === 'warm, brief and specific');
      expect(firstProposal).toBeDefined();
      expect(secondProposal).toBeDefined();
      // Both ids are also the ones the reply points at, in the model's order.
      const firstTurnRow = await readTurn(first.turnId);
      expect(parseReplySegments(firstTurnRow.reply).filter((s) => s.type === 'proposal')).toEqual([
        { type: 'proposal', proposalId: firstProposal!.id },
        { type: 'proposal', proposalId: secondProposal!.id },
      ]);

      // A LATER turn is a correction, and supersedes EVERY earlier pending
      // proposal on that scope — both of them, not just the last one.
      runLlmTask.mockResolvedValue(modelReply({
        proposals: [{ ...toneProposal(), input: { tone: 'plain and short' } }],
        segments: [{ type: 'proposal_ref', index: 0 }],
      }));
      const second = createdOrThrow(await createTurn(db, baseTurnInput({
        conversationId, text: 'Actually, simpler than that.',
      })));
      const secondPayload = await payloadFor(second, 1);
      await markDispatched(db, secondPayload.outbox_id, 1);
      await handleAgentTurn(db, jobFor(secondPayload));

      const [replacement] = await db<{ id: string }[]>`
        SELECT id FROM agent_proposals
        WHERE turn_id = ${second.turnId}::uuid AND account_id = ${tenant.accountId}::uuid
      `;
      const after = await db<{ id: string; status: string; superseded_by: string | null }[]>`
        SELECT id, status, superseded_by
        FROM agent_proposals
        WHERE turn_id = ${first.turnId}::uuid AND account_id = ${tenant.accountId}::uuid
        ORDER BY created_at ASC
      `;
      for (const row of after) {
        expect(row.status).toBe(PROPOSAL_STATUS.SUPERSEDED);
        expect(row.superseded_by).toBe(replacement!.id);
      }
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
      const conversationId = randomUUID();
      const padded = '  keep it warm  ';
      const created = createdOrThrow(await createTurn(db, baseTurnInput({
        conversationId, clientTurnKey, text: padded,
      })));

      const [row] = await db<{ owner_text: string }[]>`
        SELECT owner_text FROM agent_turns
        WHERE id = ${created.turnId}::uuid AND account_id = ${tenant.accountId}::uuid
      `;
      // VERBATIM: no trim anywhere on the path, so the padding survives.
      expect(row!.owner_text).toBe(padded);

      // The trimmed form is a DIFFERENT payload under the same key.
      //
      // The SAME conversationId is load-bearing, and the earlier version of
      // this case did not pass it: `sameTurnPayload` compares conversation,
      // location and text in that order, so a fresh conversation id per call
      // made the comparison fail on its FIRST field and the `owner_text` arm
      // never ran. The conflict was real and the reason was not the one the
      // comment claimed. With the conversation and location held equal, text
      // is the only thing left that can decide — so a `.trim()` reintroduced
      // anywhere on the path makes this return `existing` and fails here.
      const repeat = await createTurn(db, baseTurnInput({
        conversationId, clientTurnKey, text: 'keep it warm',
      }));
      expect(repeat.kind).toBe('turn_key_conflict');

      // And the true replay — same conversation, same location, same bytes —
      // still answers with the original ids, so the case above is narrow.
      const replay = await createTurn(db, baseTurnInput({
        conversationId, clientTurnKey, text: padded,
      }));
      expect(replay).toEqual({
        kind: 'existing', conversationId, turnId: created.turnId,
      });

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
