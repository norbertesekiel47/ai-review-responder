import type postgres from 'postgres';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSql, sqlCalls, sqlReturnQueue, resetMockSql } = await vi.hoisted(async () => {
  const { createMockSql } = await import('../../../../../worker/__tests__/helpers/mock-sql');
  return { ...createMockSql() };
});

import { mkTaggedResult } from '../../../../../worker/__tests__/helpers/mock-sql';
import { insertProposals, listProposalsForTurn, type ProposalRow } from '../proposals';
import { PROPOSAL_STATUS } from '../schema';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const LOCATION = '33333333-3333-4333-8333-333333333333';
const CONVERSATION = '44444444-4444-4444-8444-444444444444';
const TURN = '55555555-5555-4555-8555-555555555555';

function proposal(overrides: Partial<ProposalRow> = {}): ProposalRow {
  return {
    id: '66666666-6666-4666-8666-666666666666',
    conversationId: CONVERSATION,
    turnId: TURN,
    accountId: ACCOUNT,
    actorUserId: ACTOR,
    locationId: LOCATION,
    operation: 'set_tone',
    contractVersion: 1,
    input: { tone: 'warm and brief' },
    before: { tone: null },
    after: { tone: 'warm and brief' },
    rationale: 'You asked for shorter replies.',
    labelKind: 'fact',
    preparedVersionToken: { businessId: LOCATION, updatedAt: '2026-09-11T00:00:00.000Z' },
    requiresConfirmation: false,
    status: PROPOSAL_STATUS.PENDING,
    ...overrides,
  };
}

// Bound-value positions in the INSERT's VALUES list (proposals.ts), asserted by
// index because the column list is positional and a silent re-order is what a
// test at this seam exists to catch.
const VALUE_INDEX = {
  id: 0,
  conversationId: 1,
  turnId: 2,
  accountId: 3,
  actorUserId: 4,
  locationId: 5,
  operation: 6,
  contractVersion: 7,
  input: 8,
  before: 9,
  after: 10,
  rationale: 11,
  labelKind: 12,
  preparedVersionToken: 13,
  requiresConfirmation: 14,
  status: 15,
} as const;

describe('operator proposals', () => {
  beforeEach(() => {
    resetMockSql();
    vi.clearAllMocks();
  });

  it('insertProposals writes one row per proposal with contract_version and prepared_version_token', async () => {
    const rows = [
      proposal(),
      proposal({
        id: '77777777-7777-4777-8777-777777777777',
        operation: 'set_avoid_facts',
        // An account-default proposal: a NULL location is a real shape, not an
        // omission, and supersession depends on it round-tripping.
        locationId: null,
        input: { avoidFacts: ['never mention the old owner'] },
        preparedVersionToken: { businessId: LOCATION, updatedAt: '2026-09-11T01:00:00.000Z' },
      }),
    ];

    await insertProposals(mockSql as unknown as postgres.TransactionSql, rows);

    // One statement per proposal — no multi-row VALUES, no batching that would
    // make a single bad row roll back its siblings silently.
    expect(sqlCalls).toHaveLength(2);
    for (const [index, call] of sqlCalls.entries()) {
      const row = rows[index]!;
      expect(call.text).toContain('INSERT INTO agent_proposals');
      expect(call.values[VALUE_INDEX.id]).toBe(row.id);
      expect(call.values[VALUE_INDEX.conversationId]).toBe(CONVERSATION);
      expect(call.values[VALUE_INDEX.turnId]).toBe(TURN);
      expect(call.values[VALUE_INDEX.accountId]).toBe(ACCOUNT);
      expect(call.values[VALUE_INDEX.actorUserId]).toBe(ACTOR);
      expect(call.values[VALUE_INDEX.locationId]).toBe(row.locationId);
      expect(call.values[VALUE_INDEX.operation]).toBe(row.operation);
      // The two the title names. `contract_version` is what makes a stored
      // proposal re-parseable after the catalog moves on, and
      // `prepared_version_token` is the voice-scope staleness check Run B's
      // Apply reads — a row missing either is unusable, not merely thin.
      expect(call.values[VALUE_INDEX.contractVersion]).toBe(1);
      expect(call.values[VALUE_INDEX.preparedVersionToken]).toEqual(row.preparedVersionToken);
      expect(call.values[VALUE_INDEX.input]).toEqual(row.input);
      expect(call.values[VALUE_INDEX.before]).toEqual(row.before);
      expect(call.values[VALUE_INDEX.after]).toEqual(row.after);
      expect(call.values[VALUE_INDEX.rationale]).toBe(row.rationale);
      expect(call.values[VALUE_INDEX.labelKind]).toBe('fact');
      // Always false in Run A: no registered operation widens autonomy (L5).
      expect(call.values[VALUE_INDEX.requiresConfirmation]).toBe(false);
      // The status is the CONSTANT, never the caller's field: a row cannot be
      // written already-applied.
      expect(call.values[VALUE_INDEX.status]).toBe(PROPOSAL_STATUS.PENDING);
    }

    // The four JSONB columns (input, before, after, prepared_version_token)
    // cross as tagged values, never as strings — the
    // `${JSON.stringify(x)}::jsonb` double-encode trap.
    expect(mockSql.json).toHaveBeenCalledTimes(rows.length * 4);

    // No proposals, no statements: an empty turn must not issue a bare INSERT.
    resetMockSql();
    await insertProposals(mockSql as unknown as postgres.TransactionSql, []);
    expect(sqlCalls).toHaveLength(0);
  });
});

describe('declineProposal', () => {
  it.todo('declineProposal sets status rejected and decided_by_user_id with no reason and is idempotent');
  it.todo('declineProposal answers proposal_not_pending for an applied proposal');
});

describe('proposal view', () => {
  it('proposal view carries receipt, prepared version token, applied_at and failure_reason', async () => {
    const receipt = {
      version: 1,
      operation: 'set_tone',
      scope: { accountId: ACCOUNT, locationId: LOCATION },
      before: { tone: null, productsServices: null, avoidFacts: [], highlightFacts: [], sampleResponses: [] },
      after: { tone: 'warm and brief', productsServices: null, avoidFacts: [], highlightFacts: [], sampleResponses: [] },
      differsFromPreview: false,
      effectiveNow: true,
      affects: 'future_drafts',
      remainingBlocked: [],
      appliedAt: '2026-09-12T10:00:00.000Z',
      actorUserId: ACTOR,
      ownerText: 'Make my replies warmer.',
      turnId: TURN,
      versionToken: {
        before: { businessId: LOCATION, updatedAt: '2026-09-12 09:00:00.111111+00' },
        after: { businessId: LOCATION, updatedAt: '2026-09-12 10:00:00.222222+00' },
      },
    };

    sqlReturnQueue.push(mkTaggedResult([{
      turn_id: TURN,
      id: '66666666-6666-4666-8666-666666666666',
      operation: 'set_tone',
      contract_version: 1,
      label_kind: 'fact',
      location_id: LOCATION,
      status: 'applied',
      rationale: 'You asked for shorter replies.',
      input: { tone: 'warm and brief' },
      before: receipt.before,
      after: receipt.after,
      // The PgBouncer STRING form on purpose: these two columns are the new
      // parse sites, and a string is what the pooler can hand back.
      prepared_version_token: JSON.stringify(receipt.versionToken.before),
      receipt: JSON.stringify(receipt),
      applied_at: new Date('2026-09-12T10:00:00.000Z'),
      failure_reason: null,
    }]));

    const [view] = await listProposalsForTurn(
      mockSql as unknown as postgres.Sql,
      { turnId: TURN, accountId: ACCOUNT },
    );

    expect(view!.turnId).toBe(TURN);
    expect(view!.preparedVersionToken).toEqual({
      businessId: LOCATION,
      updatedAt: '2026-09-12 09:00:00.111111+00',
    });
    expect(view!.receipt).toEqual(receipt);
    expect(view!.appliedAt).toBe('2026-09-12T10:00:00.000Z');
    expect(view!.failureReason).toBeNull();

    // The projection has to ASK for the four columns, or the view above would
    // be built from undefineds that happen to satisfy a loose assertion.
    const [call] = sqlCalls;
    for (const column of ['prepared_version_token', 'receipt', 'applied_at', 'failure_reason', 'turn_id']) {
      expect(call!.text).toContain(column);
    }
    expect(call!.text).toContain('account_id = ?');
  });
});
