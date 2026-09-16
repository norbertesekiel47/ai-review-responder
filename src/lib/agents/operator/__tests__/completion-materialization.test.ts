import { beforeEach, describe, expect, it, vi } from 'vitest';
import { completeTurnFenced, type CompleteTurnInput } from '../turns';

const mocks = vi.hoisted(() => ({ restore: vi.fn(), refusals: vi.fn(), supersede: vi.fn(), outbox: vi.fn() }));
vi.mock('../restore', () => ({ createRestoreProposalInTransaction: mocks.restore }));
vi.mock('../refusal-completion', () => ({ completeOperatorRefusals: mocks.refusals }));
vi.mock('../proposals', () => ({ insertProposals: vi.fn(), insertUnsupported: vi.fn(), supersedePendingProposals: mocks.supersede }));
vi.mock('@/lib/shared/outbox', () => ({ markOutboxCompletedIfOwned: mocks.outbox }));

const ACCOUNT = '00000000-0000-4000-8000-000000000001';
const LOCATION = '00000000-0000-4000-8000-000000000002';
const TURN = '00000000-0000-4000-8000-000000000003';
const CONVERSATION = '00000000-0000-4000-8000-000000000004';
const ACTOR = '00000000-0000-4000-8000-000000000005';
const DECIDED_AT = new Date('2026-09-14T20:00:00.123Z');

function input(): CompleteTurnInput {
  const band = { locationId: LOCATION, total: 0, byStar: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 } };
  return {
    accountId: ACCOUNT, turnId: TURN, conversationId: 'stale caller conversation', attemptToken: ACTOR,
    segments: [], proposals: [], unsupported: [], outboxId: TURN, outboxAttempt: 1,
    replyPlan: {
      segments: [{ type: 'proposal_ref', index: 0 }, { type: 'proposal_ref', index: 1 }],
      proposalIds: [null, null], scrubbed: false,
      restoreRequests: [{ index: 0, scope: { accountId: ACCOUNT } }, { index: 1, scope: { accountId: ACCOUNT, locationId: LOCATION } }],
      metrics: { pendingCount: 0, posted7d: 0, draftsWaiting: 0, reportingPeriodDays: 7, asOf: DECIDED_AT.toISOString(),
        starBands: band, accountStarBands: { ...band, locationId: null } },
    },
  };
}

function executor(wins: boolean) {
  const statements: { text: string; values: unknown[] }[] = [];
  const tag = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    statements.push({ text, values });
    if (text.includes('RETURNING account_id')) {
      return wins ? [{ account_id: ACCOUNT, actor_user_id: ACTOR, location_id: LOCATION, conversation_id: CONVERSATION, completed_at: DECIDED_AT }] : [];
    }
    return [];
  };
  const sql = Object.assign(tag, { json: (value: unknown) => value, begin: async (run: (tx: unknown) => Promise<unknown>) => run(sql) });
  return { sql, statements };
}

describe('fenced reply materialization boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.refusals.mockResolvedValue({});
    mocks.restore.mockImplementation(async (_tx, request) => ({ kind: 'prepared', repeated: false,
      proposal: { id: request.locationId === null ? 'account-proposal' : 'location-proposal', operation: 'set_daily_cap', locationId: request.locationId },
    }));
  });

  it('locks location requests before account requests while preserving model order and stored ownership', async () => {
    const { sql, statements } = executor(true);
    await expect(completeTurnFenced(sql as never, input())).resolves.toEqual({ fenced: true });
    expect(mocks.restore.mock.calls.map((call) => call[1].locationId)).toEqual([LOCATION, null]);
    for (const [tx, request] of mocks.restore.mock.calls) {
      expect(tx).toBe(sql);
      expect(request).toMatchObject({ accountId: ACCOUNT, actorUserId: ACTOR, owner: { conversationId: CONVERSATION, turnId: TURN } });
    }
    const persisted = statements.find((statement) => statement.text.startsWith('UPDATE agent_turns SET reply'));
    expect(persisted?.values[0]).toEqual([
      { type: 'proposal', proposalId: 'account-proposal' }, { type: 'proposal', proposalId: 'location-proposal' },
    ]);
    expect(mocks.supersede.mock.calls[0]?.[1]).toMatchObject({ conversationId: CONVERSATION, replacements: [
      { proposalId: 'location-proposal' }, { proposalId: 'account-proposal' },
    ] });
    expect(mocks.refusals).toHaveBeenCalledExactlyOnceWith(sql, {
      turn: { accountId: ACCOUNT, locationId: LOCATION }, decidedAt: 'transaction_time', references: [],
    });
    expect(statements.at(-1)?.values).toContain(CONVERSATION);
    expect(mocks.outbox).toHaveBeenCalledExactlyOnceWith(sql, TURN, 1);
  });

  it('does not call preparation, ledger, supersession or outbox after losing the fence', async () => {
    const { sql, statements } = executor(false);
    await expect(completeTurnFenced(sql as never, input())).resolves.toEqual({ fenced: false });
    expect(statements).toHaveLength(1);
    for (const mock of Object.values(mocks)) expect(mock).not.toHaveBeenCalled();
  });

  it('rejects a legacy stored refusal subject instead of bypassing ledger materialization', async () => {
    const { sql } = executor(true);
    const legacy = { ...input(), replyPlan: undefined,
      segments: [{ type: 'refusal' as const, reason: 'review_incentive' as const, subjectId: LOCATION }] };
    await expect(completeTurnFenced(sql as never, legacy)).rejects.toThrow('require fenced ledger materialization');
    expect(mocks.outbox).not.toHaveBeenCalled();
  });
});
