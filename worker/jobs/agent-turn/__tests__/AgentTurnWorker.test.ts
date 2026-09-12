// Flag-gate proof with a fully mocked sql: with OWNER_OPERATOR_ENABLED off the
// handler fails the turn and completes its outbox row WITHOUT loading any
// tenant context — the judge posture (worker/jobs/judge/JudgeWorker.ts:27).
//
// Plus the step-7 `!voice` terminal branch, which has no live-DB case: the
// location's voice row vanishing between step 3 and step 7 is a race a seeded
// fixture cannot stage without racing the handler itself.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { AgentTurnPayload } from '@/lib/shared/worker-types';

const {
  mockOwnerOperatorEnabled, mockBuildSnapshot, mockGenerate, mockReauthorize,
  mockClaimTurn, mockReadVoiceConfig,
} = vi.hoisted(() => ({
  mockOwnerOperatorEnabled: vi.fn(),
  mockBuildSnapshot: vi.fn(),
  mockGenerate: vi.fn(),
  mockReauthorize: vi.fn(),
  mockClaimTurn: vi.fn(),
  mockReadVoiceConfig: vi.fn(),
}));

vi.mock('@/lib/agents/operator/flags', () => ({ ownerOperatorEnabled: mockOwnerOperatorEnabled }));
vi.mock('@/lib/agents/operator/context', () => ({ buildSnapshot: mockBuildSnapshot }));
vi.mock('@/lib/agents/operator/model-call', () => ({ generateOperatorReply: mockGenerate }));
vi.mock('@/lib/agents/operator/authorize', () => ({ reauthorizeTurn: mockReauthorize }));
// PARTIAL, and deliberately so: only `claimTurn` is replaced, because a claim
// is an `UPDATE … RETURNING` the sql double cannot satisfy. `failTurnFenced`
// stays REAL, so the statements it issues — and the transaction it issues them
// in — are what the null-voice case below asserts against.
vi.mock('@/lib/agents/operator/turns', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agents/operator/turns')>()),
  claimTurn: mockClaimTurn,
}));
// `importOriginal` too: the operation catalog builds its zod input schemas from
// this module's `VOICE_FIELD_LIMITS` at import time, and dropping the constant
// makes every `.max()` read `undefined`.
vi.mock('@/lib/responses/voice-settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/responses/voice-settings')>()),
  readVoiceConfig: mockReadVoiceConfig,
}));

import { handleAgentTurn } from '../AgentTurnWorker';

type Recorded = { text: string; values: unknown[]; inTransaction: boolean };

/**
 * STATEMENTS, not every tagged-template call. `markOutboxCompletedIfOwned`
 * composes its WHERE from the shared `dispatchedRow` FRAGMENT
 * (src/lib/shared/outbox.ts:19), which is itself a tagged template and is
 * therefore indistinguishable from a statement at this double's seam. Filtering
 * on a leading SQL verb is what separates the two; the fragment's own bound
 * values are still visible in the unfiltered list below.
 */
const statementsOf = (calls: readonly Recorded[]): Recorded[] =>
  calls.filter((call) => /^\s*(?:UPDATE|SELECT|INSERT|DELETE)\b/i.test(call.text));

/**
 * `count` is what the outbox CAS returns: 1 = this dispatch still owns the row,
 * 0 = a newer attempt superseded it.
 */
function makeSql(calls: Recorded[], count = 1) {
  // `inTransaction` is what separates "written in the same transaction as the
  // state change" from "written next to it" — invariant #2's actual claim.
  let openTransactions = 0;
  const record = (...args: unknown[]) => {
    const [first] = args;
    if (Array.isArray(first) && Object.prototype.hasOwnProperty.call(first, 'raw')) {
      const strings = first as unknown as TemplateStringsArray;
      const promise = Promise.resolve(Object.assign([], { count }));
      calls.push({
        text: strings.join(' ? '),
        values: args.slice(1),
        inTransaction: openTransactions > 0,
      });
      return promise;
    }
    return { __helper: first };
  };
  return Object.assign(record, {
    begin: async (cb: (tx: unknown) => Promise<unknown>) => {
      openTransactions++;
      try {
        return await cb(Object.assign(record, { json: (v: unknown) => v }));
      } finally {
        openTransactions--;
      }
    },
    json: (v: unknown) => v,
  });
}

const payload: AgentTurnPayload = {
  turn_id: '00000000-0000-7000-8000-000000000011',
  account_id: '00000000-0000-7000-8000-00000000ac01',
  conversation_id: '00000000-0000-7000-8000-00000000c001',
  outbox_id: '00000000-0000-7000-8000-00000000ob01',
  outbox_attempt: 1,
};

const job = { id: 'job-1', data: payload, opts: { attempts: 5 }, attemptsMade: 0 } as unknown as Job<AgentTurnPayload>;

describe('AgentTurnWorker flag gate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('worker flag-off fails the turn operator_disabled and completes the outbox without loading tenant context', async () => {
    mockOwnerOperatorEnabled.mockReturnValue(false);
    const calls: Recorded[] = [];

    await handleAgentTurn(makeSql(calls) as never, job);

    // Exactly two statements, and the ORDER is the contract: the outbox
    // ownership CAS first, the unfenced turn failure only after it wins.
    const statements = statementsOf(calls);
    expect(statements).toHaveLength(2);
    expect(statements[0]!.text).toContain('UPDATE job_outbox');
    // The row id is bound inside the CAS's `dispatchedRow` fragment.
    expect(calls.some((call) => call.values.includes(payload.outbox_id))).toBe(true);
    expect(statements[1]!.text).toContain('UPDATE agent_turns');
    expect(statements[1]!.values).toContain('operator_disabled');
    expect(statements[1]!.values).toContain(payload.turn_id);
    expect(statements[1]!.values).toContain(payload.account_id);

    // No tenant context of any kind was loaded. `claimTurn` is deliberately
    // NOT asserted here: `@/lib/agents/operator/turns` is not mocked in this
    // file, so a `not.toHaveBeenCalled()` on a double the handler never reaches
    // could only ever pass. The two-statement count above is what actually
    // proves no claim was taken — a claim is its own `UPDATE agent_turns`.
    expect(mockReauthorize).not.toHaveBeenCalled();
    expect(mockBuildSnapshot).not.toHaveBeenCalled();
    expect(mockGenerate).not.toHaveBeenCalled();
    for (const call of calls) {
      expect(call.text).not.toContain('FROM businesses');
      expect(call.text).not.toContain('FROM reviews');
      expect(call.text).not.toContain('FROM responses');
    }

    // A LOST CAS writes nothing at all: a newer dispatch owns the row, and may
    // be running right now with the flag back on.
    const superseded: Recorded[] = [];
    await handleAgentTurn(makeSql(superseded, 0) as never, job);
    const supersededStatements = statementsOf(superseded);
    expect(supersededStatements).toHaveLength(1);
    expect(supersededStatements[0]!.text).toContain('UPDATE job_outbox');
    expect(superseded.some((c) => c.text.includes('UPDATE agent_turns'))).toBe(false);
  });

  it('worker fails the turn unauthorized when the location voice row vanished after authorization', async () => {
    // Steps 1–6 all SUCCEED — claim, reauthorize, snapshot, a valid model
    // reply carrying a proposal — and then step 7's voice read comes back
    // null: the location was archived or moved between the authorization and
    // here. Every proposal is prepared against that row's state and its
    // `updated_at` **Version token**, so there is nothing honest left to store.
    mockOwnerOperatorEnabled.mockReturnValue(true);
    mockClaimTurn.mockResolvedValue({
      turnId: payload.turn_id,
      conversationId: payload.conversation_id,
      accountId: payload.account_id,
      actorUserId: '00000000-0000-7000-8000-00000000us01',
      locationId: '00000000-0000-7000-8000-00000000b101',
      sequence: 1,
      ownerText: 'Make my replies warmer.',
      attempt: 1,
      attemptToken: '00000000-0000-7000-8000-00000000a701',
    });
    mockReauthorize.mockResolvedValue({
      ok: true, locationName: 'Salon', subscriptionTier: 'copilot',
    });
    mockBuildSnapshot.mockResolvedValue({ metrics: { asOf: '2026-09-11T00:00:00.000Z' } });
    mockGenerate.mockResolvedValue({
      ok: true,
      attempts: 1,
      proposals: [{
        operation: { id: 'set_tone', contractVersion: 1, labelKind: 'fact' },
        scope: { locationId: '00000000-0000-7000-8000-00000000b101' },
        input: { tone: 'warm and brief' },
        rationale: 'You asked for shorter replies.',
      }],
      output: { segments: [{ type: 'proposal_ref', index: 0 }], unsupported: [] },
    });
    mockReadVoiceConfig.mockResolvedValue(null);

    const calls: Recorded[] = [];
    await handleAgentTurn(makeSql(calls) as never, job);

    // `claimTurn` is mocked, so the only statements left are the fenced
    // failure's two — and they are the whole terminal step.
    const statements = statementsOf(calls);
    expect(statements).toHaveLength(2);
    expect(statements[0]!.text).toContain('UPDATE agent_turns');
    expect(statements[0]!.values).toContain('unauthorized');
    expect(statements[0]!.values).toContain(payload.turn_id);
    expect(statements[0]!.values).toContain(payload.account_id);
    // FENCED on this attempt's token: an attempt that lost its lease fails
    // nothing.
    expect(statements[0]!.values).toContain('00000000-0000-7000-8000-00000000a701');
    // The outbox row is completed INSIDE the same transaction as the failure —
    // not beside it — so the watchdog can never re-pend a turn that is finished.
    expect(statements[1]!.text).toContain('UPDATE job_outbox');
    expect(statements.every((statement) => statement.inTransaction)).toBe(true);

    // NOTHING was proposed: the turn is failed, not completed with a reply
    // whose cards were silently dropped.
    expect(calls.some((call) => call.text.includes('agent_proposals'))).toBe(false);
    expect(calls.some((call) => call.text.includes('agent_unsupported_requests'))).toBe(false);
    expect(calls.some((call) => call.values.includes('completed'))).toBe(false);
  });
});
