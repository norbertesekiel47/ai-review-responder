import type postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSql, sqlCalls, sqlReturnQueue, resetMockSql } = await vi.hoisted(async () => {
  const { createMockSql } = await import('../../../../../worker/__tests__/helpers/mock-sql');
  return { ...createMockSql() };
});

const { mockConsequence } = vi.hoisted(() => ({ mockConsequence: vi.fn() }));
vi.mock('../policy-state', () => ({
  consequenceForPolicy: (...a: unknown[]) => mockConsequence(...a),
}));

import { SubscriptionTier } from '@/lib/accounts/tier-config';
import { POSTING_BLOCK_COPY } from '@/lib/auto-approval/posting-block-copy';
import { DEFAULT_DAILY_AUTO_POST_CAP } from '@/lib/auto-approval/policy';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import { mkTaggedResult } from '../../../../../worker/__tests__/helpers/mock-sql';
import { proposableOperation } from '../catalog';
import type { PolicySnapshot } from '../policy-state';
import {
  buildProposalRows,
  declineProposal,
  insertProposals,
  listProposalsForTurn,
  markSiblingProposalsStale,
  policyStateWithConsequence,
  type PolicyPreparations,
  type ProposalRow,
} from '../proposals';
import { PROPOSAL_STATUS, type PolicyState } from '../schema';

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
  const PENDING_ROW = {
    turn_id: TURN,
    id: '66666666-6666-4666-8666-666666666666',
    operation: 'set_tone',
    contract_version: 1,
    label_kind: 'fact',
    location_id: LOCATION,
    status: 'pending',
    rationale: 'You asked for shorter replies.',
    input: { tone: 'warm and brief' },
    before: { tone: null, productsServices: null, avoidFacts: [], highlightFacts: [], sampleResponses: [] },
    after: { tone: 'warm and brief', productsServices: null, avoidFacts: [], highlightFacts: [], sampleResponses: [] },
    prepared_version_token: { businessId: LOCATION, updatedAt: '2026-09-12 09:00:00.111111+00' },
    receipt: null,
    applied_at: null,
    failure_reason: null,
  };

  // The harness's tagged-template double is not a `postgres.Sql`; the cast is
  // the same one every other case in this file uses.
  const db = mockSql as unknown as postgres.Sql;

  it('declineProposal sets status rejected and decided_by_user_id with no reason and is idempotent', async () => {
    resetMockSql();
    sqlReturnQueue.push(
      mkTaggedResult([PENDING_ROW]),                                        // lock
      mkTaggedResult([ACCOUNT_ROW]),                                        // Posting block
      mkTaggedResult([]),                                                   // UPDATE
      mkTaggedResult([{ ...PENDING_ROW, status: 'rejected' }]),             // re-read
      mkTaggedResult([ACCOUNT_ROW]),                                        // Posting block
    );

    const first = await declineProposal(db, {
      proposalId: PENDING_ROW.id,
      accountId: ACCOUNT,
      actorUserId: ACTOR,
    });

    expect(first).toEqual({
      kind: 'rejected',
      repeated: false,
      proposal: expect.objectContaining({ status: 'rejected', failureReason: null }),
    });

    // `includes('UPDATE')` would also match the lock SELECT's trailing `FOR
    // UPDATE`, so the write is found with a line-anchored match.
    const update = sqlCalls.find((call) => /^\s*UPDATE\s/m.test(call.text))!;
    expect(update.text).toContain('account_id = ?');
    expect(update.values).toContain(ACTOR);
    // NO REASON (D5). `owner_declined` in `failure_reason` would make "the
    // owner said no" indistinguishable from a server refusal in every read
    // that counts non-NULL reasons.
    expect(update.text).toContain('failure_reason = NULL');

    // Idempotent: a second click on the same card, or a retried POST, finds an
    // owner-declined row (rejected, no reason) and returns it unchanged.
    resetMockSql();
    sqlReturnQueue.push(
      mkTaggedResult([{ ...PENDING_ROW, status: 'rejected' }]),             // lock
      mkTaggedResult([ACCOUNT_ROW]),                                        // Posting block
    );
    const second = await declineProposal(db, {
      proposalId: PENDING_ROW.id,
      accountId: ACCOUNT,
      actorUserId: ACTOR,
    });
    expect(second).toEqual({
      kind: 'rejected',
      repeated: true,
      proposal: expect.objectContaining({ status: 'rejected' }),
    });
    expect(sqlCalls.some((call) => /^\s*UPDATE\s/m.test(call.text))).toBe(false);
  });

  it('declineProposal answers proposal_not_pending for an applied proposal', async () => {
    resetMockSql();
    sqlReturnQueue.push(mkTaggedResult([{ ...PENDING_ROW, status: 'applied' }]));

    const result = await declineProposal(db, {
      proposalId: PENDING_ROW.id,
      accountId: ACCOUNT,
      actorUserId: ACTOR,
    });

    expect(result).toEqual({
      kind: 'not_pending',
      status: 'applied',
      proposal: expect.objectContaining({ status: 'applied' }),
    });
    expect(sqlCalls.some((call) => /^\s*UPDATE\s/m.test(call.text))).toBe(false);

    // A row REJECTED BY THE SERVER is not an owner decline: it carries a
    // reason, so declining it again is `not_pending`, not a silent success.
    resetMockSql();
    sqlReturnQueue.push(mkTaggedResult([{
      ...PENDING_ROW, status: 'rejected', failure_reason: 'contract_changed',
    }]));
    const refused = await declineProposal(db, {
      proposalId: PENDING_ROW.id,
      accountId: ACCOUNT,
      actorUserId: ACTOR,
    });
    expect(refused).toMatchObject({ kind: 'not_pending', status: 'rejected' });
  });
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

    expect(view).toBeDefined();
    expect(view!.turnId).toBe(TURN);
    expect(view!.preparedVersionToken).toEqual({
      businessId: LOCATION,
      updatedAt: '2026-09-12 09:00:00.111111+00',
    });
    // Byte for byte, PLUS the `actorName` the reader defaults: this fixture is
    // a Receipt written before that field existed and must still parse (S5).
    expect(view!.receipt).toEqual({ ...receipt, actorName: null });
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

// ── Policy proposals ──────────────────────────────────────────────────────

const POLICY_ROW_ID = '77777777-7777-4777-8777-777777777777';
const ACCOUNT_TOKEN = { accountDefaultRow: { id: POLICY_ROW_ID, updatedAt: '2026-09-12 09:00:00.333333+00' } };
const LINE = (eligible: number) => ({
  total: 3,
  eligible,
  held: { below_threshold: 0, cap_reached: 0, manual: 3 - eligible },
  byDay: [{ day: '2026-09-01', total: 3, eligible, held: 3 - eligible }],
  busiestDay: 3,
  windowStart: '2026-08-14 03:00:00+00',
  windowEnd: '2026-09-13 03:00:00+00',
  asOf: '2026-09-13 03:00:00.123456+00',
  source: 'reviews_received_30d',
  excludedImported: 0,
  excludedUnknown: 2,
});

function policyState(overrides: Partial<PolicyState> = {}): PolicyState {
  return {
    domain: 'policy', threshold: null, vetoWindowMinutes: 30, dailyAutoPostCap: null,
    effectiveDailyCap: DEFAULT_DAILY_AUTO_POST_CAP, rowExists: true, ...overrides,
  };
}

function accountSnapshot(accountDefault: PolicyState, policySuspended = false): PolicySnapshot {
  return {
    accountId: ACCOUNT, locationId: null, target: { scope: 'account' },
    state: { accountDefault, location: null, targetRowSuspended: policySuspended }, versionToken: ACCOUNT_TOKEN,
    targetArchived: false, policySuspended, locations: [], reviews: [],
    windowStart: '2026-08-14 03:00:00+00', windowEnd: '2026-09-13 03:00:00+00',
    asOf: '2026-09-13 03:00:00.123456+00', source: 'reviews_received_30d',
    excludedImported: 0, excludedUnknown: 2,
  };
}

describe('frozen policy scope count', () => {
  it('counts only inheriting active locations for the account default', () => {
    const snapshot = accountSnapshot(policyState());
    snapshot.locations = [
      { id: LOCATION, state: policyState({ rowExists: false }) },
      { id: '77777777-7777-4777-8777-777777777777', state: policyState({ rowExists: true }) },
    ];
    mockConsequence.mockReturnValue(LINE(0));
    expect(policyStateWithConsequence(snapshot, snapshot.state.accountDefault))
      .toMatchObject({ affectedLocationCount: 1 });
  });
});

const TURN_CONTEXT = {
  conversationId: CONVERSATION, turnId: TURN, accountId: ACCOUNT, actorUserId: ACTOR, locationId: LOCATION,
};
const VOICE = {
  tone: null, productsServices: null, avoidFacts: [], highlightFacts: [], sampleResponses: [],
  updatedAt: '2026-09-12 09:00:00.111111+00',
};

function scopeProposal(input: Record<string, unknown>, locationId?: string) {
  const operation = proposableOperation('set_auto_reply_scope');
  if (!operation) throw new Error('set_auto_reply_scope left the catalog');
  return {
    operation,
    input,
    scope: locationId === undefined ? { accountId: ACCOUNT } : { accountId: ACCOUNT, locationId },
    rationale: 'You asked to let good reviews post.',
  };
}

describe('buildProposalRows policy stamping', () => {
  beforeEach(() => {
    resetMockSql();
    mockConsequence.mockReset();
    mockConsequence.mockImplementation((_snapshot: unknown, state: PolicyState) =>
      LINE(state.threshold === null ? 0 : 2));
  });

  it('buildProposalRows stamps a policy proposal from its STORED target snapshot, never the turn location or the model', () => {
    const manual = policyState();
    const snapshot = accountSnapshot(manual, true);
    const policy: PolicyPreparations = new Map([[null, { snapshot, blockReasons: ['autopilot_unavailable'] }]]);

    // The turn is on LOCATION, but the proposal names no location: account target.
    const [row] = buildProposalRows(TURN_CONTEXT, [scopeProposal({ threshold: 4 })], VOICE, policy);

    expect(row!.locationId).toBeNull();
    expect(row!.preparedVersionToken).toEqual(ACCOUNT_TOKEN);
    expect(row!.requiresConfirmation).toBe(true);
    expect(row!.before).toEqual({ ...manual, consequence: LINE(0), affectedLocationCount: 0 });
    expect(row!.after).toEqual({
      ...policyState({ threshold: 4 }),
      consequence: LINE(2),
      affectedLocationCount: 0,
      expansionBlockedBy: ['autopilot_unavailable', 'policy_suspended'],
    });
    for (const call of mockConsequence.mock.calls) expect(call[0]).toBe(snapshot);

    // A contraction carries no readiness metadata and no friction.
    const fourStar = policyState({ threshold: 4 });
    const [contraction] = buildProposalRows(
      TURN_CONTEXT,
      [scopeProposal({ threshold: null })],
      VOICE,
      new Map([[null, { snapshot: accountSnapshot(fourStar), blockReasons: ['autopilot_unavailable'] }]]),
    );
    expect(contraction!.requiresConfirmation).toBe(false);
    expect(contraction!.after).not.toHaveProperty('expansionBlockedBy');

    // A target with no prepared snapshot is an invariant failure, not a dropped card.
    expect(() => buildProposalRows(TURN_CONTEXT, [scopeProposal({ threshold: 4 }, LOCATION)], VOICE, policy))
      .toThrow(/no prepared policy snapshot/);
    expect(() => buildProposalRows(TURN_CONTEXT, [scopeProposal({ threshold: 4 })], VOICE))
      .toThrow(/no prepared policy snapshot/);
  });

  it('policy proposal view derives friction from the stored before/after and never from a stored flag', async () => {
    const storedRow = {
      turn_id: TURN,
      id: '66666666-6666-4666-8666-666666666666',
      operation: 'set_auto_reply_scope',
      contract_version: 1,
      label_kind: 'rule',
      location_id: null,
      status: 'pending',
      rationale: 'You asked to let good reviews post.',
      input: { threshold: 4 },
      before: { ...policyState(), consequence: LINE(0) },
      after: {
        ...policyState({ threshold: 4 }), consequence: LINE(2), expansionBlockedBy: ['autopilot_unavailable'],
      },
      prepared_version_token: ACCOUNT_TOKEN,
      // A stored flag that lies is ignored: the projection does not read it.
      requires_confirmation: false,
      receipt: null,
      applied_at: null,
      failure_reason: null,
    };
    // Two reads, and each one now also asks `accounts` for the **Posting
    // block** — the interleaved account rows keep the second read's proposal
    // row in its own position in the queue.
    sqlReturnQueue.push(
      mkTaggedResult([storedRow]),
      mkTaggedResult([ACCOUNT_ROW]),
      mkTaggedResult([{ ...storedRow, location_id: LOCATION }]),
      mkTaggedResult([ACCOUNT_ROW]),
    );

    const [account] = await listProposalsForTurn(mockSql as unknown as postgres.Sql, { turnId: TURN, accountId: ACCOUNT });
    expect(account).toMatchObject({
      requiresConfirmation: true,
      confirmationPhrase: 'all locations',
      readinessBlockReasons: ['autopilot_unavailable'],
      consequence: LINE(2),
    });
    expect(account!.describe).toContain('After Apply');

    const [location] = await listProposalsForTurn(mockSql as unknown as postgres.Sql, { turnId: TURN, accountId: ACCOUNT });
    expect(location!.confirmationPhrase).toBe('4 and 5 star');
  });

  it('a voice proposal view carries no friction', async () => {
    sqlReturnQueue.push(mkTaggedResult([{
      turn_id: TURN, id: '66666666-6666-4666-8666-666666666666', operation: 'set_tone',
      contract_version: 1, label_kind: 'fact', location_id: LOCATION, status: 'pending',
      rationale: 'r', input: { tone: 'warm' }, before: VOICE, after: { ...VOICE, tone: 'warm' },
      prepared_version_token: { businessId: LOCATION, updatedAt: VOICE.updatedAt },
      receipt: null, applied_at: null, failure_reason: null,
    }]));
    const [view] = await listProposalsForTurn(mockSql as unknown as postgres.Sql, { turnId: TURN, accountId: ACCOUNT });
    expect(view).toMatchObject({
      requiresConfirmation: false, confirmationPhrase: null, readinessBlockReasons: [], consequence: null,
    });
  });

  it('markSiblingProposalsStale sweeps only the token domain its write moved', async () => {
    const tx = mockSql as unknown as postgres.TransactionSql;
    const exclude = '99999999-9999-4999-8999-999999999999';

    await markSiblingProposalsStale(tx, { accountId: ACCOUNT, domain: 'voice', locationId: LOCATION, excludeProposalId: exclude });
    await markSiblingProposalsStale(tx, { accountId: ACCOUNT, domain: 'policy', locationId: LOCATION, excludeProposalId: exclude });
    await markSiblingProposalsStale(tx, { accountId: ACCOUNT, domain: 'policy', locationId: null, excludeProposalId: exclude });

    const [voice, location, account] = sqlCalls;
    expect(voice!.text).toContain('location_id = ?');
    expect(voice!.values).toContainEqual(['set_tone', 'set_products_services', 'set_avoid_facts', 'set_highlight_facts']);
    expect(location!.text).toContain('location_id = ?');
    expect(location!.values).toContainEqual(['set_auto_reply_scope', 'set_veto_window', 'set_daily_cap', 'clear_location_override']);
    expect(account!.text).not.toContain('location_id');
    expect(account!.values).toContainEqual(['set_auto_reply_scope', 'set_veto_window', 'set_daily_cap', 'clear_location_override']);
    for (const call of sqlCalls) {
      expect(call.values).toContain(ACCOUNT);
      expect(call.values).toContain(exclude);
    }

    await expect(markSiblingProposalsStale(tx, {
      accountId: ACCOUNT, domain: 'voice', locationId: null, excludeProposalId: exclude,
    })).rejects.toThrow(/voice write always names a location/);
  });
});

// ── The Posting block on a Proposal card (#1352) ───────────────────────────
//
// The card's correction is DERIVED at read time from the CURRENT account, so
// every case here fixes the account row and the flags and then asserts what
// `mapStoredRows` puts on the view. The frozen `expansionBlockedBy` sits in the
// same fixture on purpose: the two facts must not be confused for each other.

/** Active + Autopilot, so the flags below are the only Posting block input. */
const ACCOUNT_ROW = {
  id: ACCOUNT,
  subscription_tier: SubscriptionTier.AUTOPILOT,
  subscription_status: SubscriptionStatus.ACTIVE,
  past_due_at: null,
  flags: {},
};

/** EXACTLY ONE reason, so the rendered sentences are an equality, not a match. */
function blockPostingOnJudge(): void {
  vi.stubEnv('AUTO_APPROVAL_ENABLED', 'true');
  vi.stubEnv('OPENAI_MODERATION_ENABLED', 'true');
  vi.stubEnv('JUDGE_ENABLED', 'false');
}

function clearPostingBlock(): void {
  vi.stubEnv('AUTO_APPROVAL_ENABLED', 'true');
  vi.stubEnv('OPENAI_MODERATION_ENABLED', 'true');
  vi.stubEnv('JUDGE_ENABLED', 'true');
}

function policyStoredRow(overrides: Record<string, unknown> = {}) {
  return {
    turn_id: TURN,
    id: '66666666-6666-4666-8666-666666666666',
    operation: 'set_auto_reply_scope',
    contract_version: 1,
    label_kind: 'rule',
    location_id: null,
    status: PROPOSAL_STATUS.PENDING,
    rationale: 'You asked to let good reviews post.',
    input: { threshold: 4 },
    before: { ...policyState(), consequence: LINE(0) },
    after: {
      ...policyState({ threshold: 4 }), consequence: LINE(2),
      expansionBlockedBy: ['autopilot_unavailable'],
    },
    prepared_version_token: ACCOUNT_TOKEN,
    receipt: null,
    applied_at: null,
    failure_reason: null,
    ...overrides,
  };
}

/** The applied Proposal a Restore card inverts, and its stored evidence. */
const RESTORE_SOURCE = '99999999-9999-4999-8999-999999999999';

/** Armed → off. Restoring it therefore RE-ARMS auto-posting. */
const RESTORE_SOURCE_ROW = {
  id: RESTORE_SOURCE,
  operation: 'set_auto_reply_scope',
  contract_version: 1,
  location_id: null,
  status: PROPOSAL_STATUS.APPLIED,
  turn_id: TURN,
  receipt: {
    version: 1,
    operation: 'set_auto_reply_scope',
    scope: { accountId: ACCOUNT, locationId: null },
    before: { ...policyState({ threshold: 4 }), consequence: LINE(2), affectedLocationCount: 1 },
    after: { ...policyState(), consequence: LINE(0), affectedLocationCount: 1 },
    differsFromPreview: false,
    effectiveNow: true,
    affects: 'future_eligible_reviews',
    remainingBlocked: [],
    appliedAt: '2026-09-13T03:00:00.000Z',
    actorUserId: ACTOR,
    actorName: 'Ada Owner',
    ownerText: 'Turn automatic replies off',
    turnId: TURN,
    versionToken: { before: ACCOUNT_TOKEN, after: ACCOUNT_TOKEN },
    retainedVeto: { count: 0, asOf: '2026-09-13 03:00:00.123456+00' },
  },
};

/** A PENDING restore proposal: currently off, armed again after Apply. */
function restoreStoredRow() {
  return policyStoredRow({
    input: { restore: { sourceProposalId: RESTORE_SOURCE } },
    before: { ...policyState(), consequence: LINE(0) },
    after: { ...policyState({ threshold: 4 }), consequence: LINE(2) },
  });
}

const db = () => mockSql as unknown as postgres.Sql;
const readOne = async () =>
  (await listProposalsForTurn(db(), { turnId: TURN, accountId: ACCOUNT }))[0];

describe('proposal card Posting block', () => {
  beforeEach(() => {
    resetMockSql();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('a policy proposal that arms auto-posting carries the account Posting block reasons', async () => {
    blockPostingOnJudge();
    sqlReturnQueue.push(mkTaggedResult([policyStoredRow()]), mkTaggedResult([ACCOUNT_ROW]));

    const view = await readOne();

    // The OWNER SENTENCES, byte for byte, from the one copy owner — the view
    // does no mapping of its own and neither does the card.
    expect(view!.postingBlockSentences).toEqual([POSTING_BLOCK_COPY.judge_disabled]);
    // And the frozen preparation-time fact is untouched beside it. The stored
    // `expansionBlockedBy` says `autopilot_unavailable`; the sentences say
    // nothing of the kind, because they came from the CURRENT account.
    expect(view!.readinessBlockReasons).toEqual(['autopilot_unavailable']);

    // ONE account-scoped primary-key read, issued alongside the proposal
    // SELECT and never per row.
    expect(sqlCalls).toHaveLength(2);
    const accountRead = sqlCalls.find((call) => call.text.includes('FROM accounts'))!;
    expect(accountRead).toBeDefined();
    expect(accountRead.values).toContain(ACCOUNT);
  });

  it('a policy proposal that turns auto-posting off carries no Posting block reasons', async () => {
    blockPostingOnJudge();
    // The stored `after` is UNARMED: this card already tells the owner replies
    // will not post, so a block must not turn a true sentence into a
    // correction.
    sqlReturnQueue.push(mkTaggedResult([policyStoredRow({
      input: { threshold: null },
      before: { ...policyState({ threshold: 4 }), consequence: LINE(2) },
      after: { ...policyState(), consequence: LINE(0) },
    })]), mkTaggedResult([ACCOUNT_ROW]));

    const view = await readOne();

    expect(view!.postingBlockSentences).toEqual([]);
    // The account really is blocked — the empty list is the precedence rule,
    // not a missing read.
    expect(sqlCalls.some((call) => call.text.includes('FROM accounts'))).toBe(true);
  });

  it('a Posting block corrects neither history, a voice proposal, nor an unblocked account', async () => {
    // APPLIED and armed, while blocked: a record of the past gets no
    // correction.
    blockPostingOnJudge();
    sqlReturnQueue.push(
      mkTaggedResult([policyStoredRow({ status: PROPOSAL_STATUS.APPLIED })]),
      mkTaggedResult([ACCOUNT_ROW]),
    );
    expect((await readOne())!.postingBlockSentences).toEqual([]);

    // A VOICE proposal while blocked: the Posting block is about posting, and
    // a tone change does not claim anything about it.
    resetMockSql();
    sqlReturnQueue.push(mkTaggedResult([{
      turn_id: TURN, id: '66666666-6666-4666-8666-666666666666', operation: 'set_tone',
      contract_version: 1, label_kind: 'fact', location_id: LOCATION,
      status: PROPOSAL_STATUS.PENDING, rationale: 'r', input: { tone: 'warm' },
      before: VOICE, after: { ...VOICE, tone: 'warm' },
      prepared_version_token: { businessId: LOCATION, updatedAt: VOICE.updatedAt },
      receipt: null, applied_at: null, failure_reason: null,
    }]), mkTaggedResult([ACCOUNT_ROW]));
    expect((await readOne())!.postingBlockSentences).toEqual([]);

    // An UNBLOCKED account: the same pending, armed row carries nothing.
    resetMockSql();
    clearPostingBlock();
    sqlReturnQueue.push(mkTaggedResult([policyStoredRow()]), mkTaggedResult([ACCOUNT_ROW]));
    expect((await readOne())!.postingBlockSentences).toEqual([]);

    // An EMPTY read issues no statement at all — not the restore-source read
    // and not the account's Posting block.
    resetMockSql();
    blockPostingOnJudge();
    sqlReturnQueue.push(mkTaggedResult([]));
    expect(await listProposalsForTurn(db(), { turnId: TURN, accountId: ACCOUNT })).toEqual([]);
    expect(sqlCalls).toHaveLength(1);
  });

  it('an applied armed rule states the account posting status NOW, and the pending warning stays pending-only', async () => {
    // #1352 at the moment of confirmation: Apply succeeds (Judge availability
    // is no expansion-readiness gate), the label reads "Active rule" and the
    // receipt says "Effective now" — so a card that went silent here would
    // tell the owner the rule is live while nothing posts.
    blockPostingOnJudge();
    sqlReturnQueue.push(
      mkTaggedResult([policyStoredRow({ status: PROPOSAL_STATUS.APPLIED })]),
      mkTaggedResult([ACCOUNT_ROW]),
    );

    const applied = await readOne();

    expect(applied!.postingBlockNowSentences).toEqual([POSTING_BLOCK_COPY.judge_disabled]);
    // The PRE-Apply warning is still pending-only. The two lists are mutually
    // exclusive by construction, so history is never repainted with it.
    expect(applied!.postingBlockSentences).toEqual([]);

    // An applied rule that turns auto-posting OFF claims nothing about posting
    // and gets no notice, on the same blocked account.
    resetMockSql();
    sqlReturnQueue.push(mkTaggedResult([policyStoredRow({
      status: PROPOSAL_STATUS.APPLIED,
      input: { threshold: null },
      before: { ...policyState({ threshold: 4 }), consequence: LINE(2) },
      after: { ...policyState(), consequence: LINE(0) },
    })]), mkTaggedResult([ACCOUNT_ROW]));
    expect((await readOne())!.postingBlockNowSentences).toEqual([]);

    // And the PENDING card carries the warning, never the current-status
    // notice: one status per row, one list per status.
    resetMockSql();
    sqlReturnQueue.push(mkTaggedResult([policyStoredRow()]), mkTaggedResult([ACCOUNT_ROW]));
    const pending = await readOne();
    expect(pending!.postingBlockSentences).toEqual([POSTING_BLOCK_COPY.judge_disabled]);
    expect(pending!.postingBlockNowSentences).toEqual([]);
  });

  it('a pending restore that re-arms auto-posting carries the Posting block through the restore branch', async () => {
    // The SECOND route into `policyCardFacts`. A restore that re-arms
    // auto-posting makes the same claim about posting as an ordinary rule
    // card, and a fix threaded into only one branch leaves restore cards
    // silent — which nothing else in the tree observes.
    blockPostingOnJudge();
    sqlReturnQueue.push(
      mkTaggedResult([restoreStoredRow()]),
      mkTaggedResult([RESTORE_SOURCE_ROW]),
      mkTaggedResult([ACCOUNT_ROW]),
    );

    const view = await readOne();

    // It really is the restore card: its words come from `describePolicyRestore`
    // and it names the source receipt it inverts.
    expect(view!.describe).toMatch(/^Restore: Account default now/);
    expect(view!.restoreSourceProposalId).toBe(RESTORE_SOURCE);
    expect(view!.postingBlockSentences).toEqual([POSTING_BLOCK_COPY.judge_disabled]);
  });

  it('a batch no row could use issues no Posting block read at all', async () => {
    // A rejected/stale page can use neither list, so the account-wide read is
    // not issued — including inside the Apply transaction, which holds
    // `SELECT … FOR UPDATE` while `mapStoredRows` runs.
    blockPostingOnJudge();
    sqlReturnQueue.push(mkTaggedResult([
      policyStoredRow({ status: PROPOSAL_STATUS.REJECTED }),
      policyStoredRow({ id: '88888888-8888-4888-8888-888888888888', status: PROPOSAL_STATUS.STALE }),
    ]));

    const views = await listProposalsForTurn(db(), { turnId: TURN, accountId: ACCOUNT });

    expect(views).toHaveLength(2);
    expect(sqlCalls).toHaveLength(1);
    expect(sqlCalls.some((call) => call.text.includes('FROM accounts'))).toBe(false);
    // The neutral status degrades through the same predicate: empty lists, not
    // a crash and not a stale correction.
    for (const view of views) {
      expect(view.postingBlockSentences).toEqual([]);
      expect(view.postingBlockNowSentences).toEqual([]);
    }
  });
});
