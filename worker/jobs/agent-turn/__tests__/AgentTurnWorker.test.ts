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
import type { ParsedProposal } from '@/lib/agents/operator/render';

const {
  mockOwnerOperatorEnabled, mockBuildSnapshot, mockGenerate, mockReauthorize,
  mockClaimTurn, mockReadVoiceConfig, mockReadPolicySnapshot, mockConsequence, mockGetSettings,
} = vi.hoisted(() => ({
  mockOwnerOperatorEnabled: vi.fn(),
  mockBuildSnapshot: vi.fn(),
  mockGenerate: vi.fn(),
  mockReauthorize: vi.fn(),
  mockClaimTurn: vi.fn(),
  mockReadVoiceConfig: vi.fn(),
  mockReadPolicySnapshot: vi.fn(),
  mockConsequence: vi.fn(),
  mockGetSettings: vi.fn(),
}));

vi.mock('@/lib/agents/operator/policy-state', () => ({
  readPolicySnapshot: mockReadPolicySnapshot,
  consequenceForPolicy: mockConsequence,
  readRetainedVetoCount: vi.fn(),
}));
vi.mock('@/lib/auto-approval/settings', () => ({ getAutoApprovalSettings: mockGetSettings }));
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
import { proposableOperation } from '@/lib/agents/operator/catalog';

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
      const text = strings.join(' ? ');
      const rows = text.includes('RETURNING account_id, actor_user_id, location_id, conversation_id, completed_at') && count > 0
        ? [{ account_id: payload.account_id, actor_user_id: '00000000-0000-7000-8000-00000000e001',
          location_id: '00000000-0000-7000-8000-00000000b101', conversation_id: payload.conversation_id,
          completed_at: new Date('2026-09-14T00:00:00Z') }]
        : [];
      const promise = Promise.resolve(Object.assign(rows, { count }));
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
      actorUserId: '00000000-0000-7000-8000-00000000e001',
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

describe('AgentTurnWorker policy preparation', () => {
  const LOCATION = '00000000-0000-7000-8000-00000000b101';
  const OTHER_LOCATION = '00000000-0000-7000-8000-00000000b102';
  const ATTEMPT = '00000000-0000-7000-8000-00000000a701';
  const ACCOUNT_STATE = {
    domain: 'policy', threshold: null, vetoWindowMinutes: 30, dailyAutoPostCap: null, effectiveDailyCap: 10, rowExists: true,
  };
  const TOKEN = { accountDefaultRow: { id: '00000000-0000-7000-8000-0000000000aa', updatedAt: '2026-09-12 09:00:00.1+00' } };
  const LINE = {
    total: 0, eligible: 0, held: { below_threshold: 0, cap_reached: 0, manual: 0 }, byDay: [], busiestDay: 0,
    windowStart: '2026-08-14 03:00:00+00', windowEnd: '2026-09-13 03:00:00+00', asOf: '2026-09-13 03:00:00+00',
    source: 'reviews_received_30d', excludedImported: 1, excludedUnknown: 3,
  };
  const VALUE = { locationId: 5, before: 9, after: 10, token: 13, requiresConfirmation: 14 } as const;

  function primeTurn(proposals: ParsedProposal[]) {
    mockOwnerOperatorEnabled.mockReturnValue(true);
    mockClaimTurn.mockResolvedValue({
      turnId: payload.turn_id, conversationId: payload.conversation_id, accountId: payload.account_id,
      actorUserId: '00000000-0000-7000-8000-00000000e001', locationId: LOCATION, sequence: 1,
      ownerText: 'Let the good ones post.', attempt: 1, attemptToken: ATTEMPT,
    });
    mockReauthorize.mockResolvedValue({ ok: true, locationName: 'Salon', subscriptionTier: 'autopilot' });
    mockBuildSnapshot.mockResolvedValue({ metrics: { asOf: '2026-09-13T03:00:00.000Z' } });
    mockReadVoiceConfig.mockResolvedValue({
      tone: null, productsServices: null, avoidFacts: [], highlightFacts: [], sampleResponses: [],
      updatedAt: '2026-09-12 09:00:00.111111+00',
    });
    mockGenerate.mockResolvedValue({
      ok: true, attempts: 1, proposals, restoreRequests: [],
      output: { segments: [{ type: 'proposal_ref', index: 0 }], unsupported: [],
        proposals: proposals.map((proposal) => ({ ...proposal, operation: proposal.operation.id })) },
    });
    mockGetSettings.mockResolvedValue({ readiness: { blockReasons: ['autopilot_unavailable'] } });
    mockConsequence.mockReturnValue(LINE);
  }

  function parsed(id: string, input: Record<string, unknown>, scope: Record<string, unknown>) {
    const operation = proposableOperation(id);
    if (!operation) throw new Error(`${id} left the catalog`);
    return { operation, input, scope: { accountId: payload.account_id, ...scope }, rationale: 'r' };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockReadPolicySnapshot.mockReset();
  });

  it('worker fails the turn unauthorized when a policy proposal names a target the policy reader cannot find', async () => {
    primeTurn([parsed('set_veto_window', { minutes: 30 }, { locationId: OTHER_LOCATION })]);
    mockReadPolicySnapshot.mockResolvedValue(null);

    const calls: Recorded[] = [];
    await handleAgentTurn(makeSql(calls) as never, job);

    expect(mockReadPolicySnapshot).toHaveBeenCalledWith(expect.anything(), {
      accountId: payload.account_id, locationId: OTHER_LOCATION,
    });
    const statements = statementsOf(calls);
    expect(statements[0]!.text).toContain('UPDATE agent_turns');
    expect(statements[0]!.values).toContain('unauthorized');
    expect(calls.some((call) => call.text.includes('agent_proposals'))).toBe(false);
  });

  it('worker stamps a policy proposal from the snapshot of its own target, not the turn location', async () => {
    primeTurn([parsed('set_auto_reply_scope', { threshold: 4 }, {})]);
    mockReadPolicySnapshot.mockResolvedValue({
      accountId: payload.account_id, locationId: null, target: { scope: 'account' },
      state: { accountDefault: ACCOUNT_STATE, location: null }, versionToken: TOKEN,
      targetArchived: false, policySuspended: true, locations: [], reviews: [],
      windowStart: LINE.windowStart, windowEnd: LINE.windowEnd, asOf: LINE.asOf,
      source: 'reviews_received_30d', excludedImported: 1, excludedUnknown: 3,
    });

    const calls: Recorded[] = [];
    await handleAgentTurn(makeSql(calls) as never, job);

    // Account target: the reader is asked for null, although the turn is on LOCATION.
    expect(mockReadPolicySnapshot).toHaveBeenCalledTimes(1);
    expect(mockReadPolicySnapshot.mock.calls[0]![1]).toEqual({ accountId: payload.account_id, locationId: null });
    expect(mockGetSettings.mock.calls[0]![1]).toEqual({ accountId: payload.account_id, impersonated: false });

    const insert = calls.find((call) => call.text.includes('INSERT INTO agent_proposals'));
    expect(insert).toBeDefined();
    expect(insert!.values[VALUE.locationId]).toBeNull();
    expect(insert!.values[VALUE.before]).toEqual({ ...ACCOUNT_STATE, consequence: LINE, affectedLocationCount: 0 });
    expect(insert!.values[VALUE.after]).toMatchObject({
      threshold: 4, consequence: LINE, expansionBlockedBy: ['autopilot_unavailable', 'policy_suspended'],
    });
    expect(insert!.values[VALUE.token]).toEqual(TOKEN);
    expect(insert!.values[VALUE.requiresConfirmation]).toBe(true);
  });

  it('a voice-only turn issues no policy read', async () => {
    primeTurn([parsed('set_tone', { tone: 'warm' }, { locationId: LOCATION })]);

    const calls: Recorded[] = [];
    await handleAgentTurn(makeSql(calls) as never, job);

    expect(mockReadPolicySnapshot).not.toHaveBeenCalled();
    expect(mockGetSettings).not.toHaveBeenCalled();
    const insert = calls.find((call) => call.text.includes('INSERT INTO agent_proposals'));
    expect(insert!.values[VALUE.token]).toEqual({ businessId: LOCATION, updatedAt: '2026-09-12 09:00:00.111111+00' });
  });
});
