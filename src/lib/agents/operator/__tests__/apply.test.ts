// Unit seams for src/lib/agents/operator/apply.ts, against the recording
// mock-sql double (worker/__tests__/helpers/mock-sql.ts). These prove
// ORDERING, BRANCHING and WHAT IS BOUND.
//
// Two collaborators are mocked because they are not this module's subject:
// `assertWritableSubscriptionForAccount` (its own suite owns the posture
// matrix) and the two voice-writer functions. The voice mock uses
// `importOriginal` so `VOICE_FIELD_LIMITS` stays REAL — `catalog.ts` builds its
// zod input schemas from it (src/lib/agents/operator/catalog.ts:108-121), and a
// blanket factory mock would make every `parseInput` throw at import time.
//
// The rollback, the row lock, the sibling sweep and the read-back are live-DB
// properties and live in apply.integration.test.ts.
import fc from 'fast-check';
import type postgres from 'postgres';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSql, sqlCalls, sqlReturnQueue, resetMockSql } = await vi.hoisted(async () => {
  const { createMockSql } = await import('../../../../../worker/__tests__/helpers/mock-sql');
  return { ...createMockSql() };
});

const { mockWritable, mockReadVoice, mockUpdateVoice } = vi.hoisted(() => ({
  mockWritable: vi.fn(),
  mockReadVoice: vi.fn(),
  mockUpdateVoice: vi.fn(),
}));

vi.mock('@/lib/shared/writable-subscription', () => ({
  assertWritableSubscriptionForAccount: (...a: unknown[]) => mockWritable(...a),
}));

vi.mock('@/lib/responses/voice-settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/responses/voice-settings')>();
  return {
    ...actual,
    readVoiceConfig: (...a: unknown[]) => mockReadVoice(...a),
    updateVoiceConfig: (...a: unknown[]) => mockUpdateVoice(...a),
  };
});

import { mkTaggedResult } from '../../../../../worker/__tests__/helpers/mock-sql';
import { applyProposal } from '../apply';
import { PROPOSAL_FAILURE_REASON, PROPOSAL_STATUS } from '../schema';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const LOCATION = '33333333-3333-4333-8333-333333333333';
const TURN = '55555555-5555-4555-8555-555555555555';
const PROPOSAL = '66666666-6666-4666-8666-666666666666';
const ACTOR_NAME = 'Dana Owner';
const ACTOR_EMAIL = 'dana@example.test';

const PREPARED_AT = '2026-09-12 09:00:00.111111+00';
const WRITTEN_AT = '2026-09-12 10:00:00.222222+00';

const VOICE_BEFORE = {
  tone: null, productsServices: null, avoidFacts: [], highlightFacts: [], sampleResponses: [],
};
const VOICE_AFTER = { ...VOICE_BEFORE, tone: 'warm and brief' };

/** The mock double, typed as the client the module's signature asks for. */
const sql = mockSql as unknown as postgres.Sql;

/** A stored `agent_proposals` row as the readers project it. */
function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    turn_id: TURN,
    id: PROPOSAL,
    operation: 'set_tone',
    contract_version: 1,
    label_kind: 'fact',
    location_id: LOCATION,
    status: PROPOSAL_STATUS.PENDING,
    rationale: 'You asked for shorter replies.',
    input: { tone: 'warm and brief' },
    before: VOICE_BEFORE,
    after: VOICE_AFTER,
    prepared_version_token: { businessId: LOCATION, updatedAt: PREPARED_AT },
    receipt: null,
    applied_at: null,
    failure_reason: null,
    ...overrides,
  };
}

const EXPECTED_TOKEN = { businessId: LOCATION, updatedAt: PREPARED_AT };

/**
 * An UPDATE result carrying a row COUNT. `mkTaggedResult([])` reports
 * `count: 0`, and `recordTerminal` reads that count to decide whether its
 * `status = 'pending'` predicate matched — so priming a successful terminal
 * write with an empty array would make the module think it lost a race.
 */
const updated = (count = 1) => Object.assign([] as unknown[], { count });

/**
 * The statements that WRITE. `text.includes('UPDATE')` is WRONG here: both lock
 * SELECTs end in `FOR UPDATE`, and mock-sql preserves that text
 * (`worker/__tests__/helpers/mock-sql.ts:115-134`), so an `includes` check
 * reports a write on every locking read and can never fail. Anchored to the
 * start of a line instead.
 */
const writes = () => sqlCalls.filter((call) => /^\s*UPDATE\s/m.test(call.text));

function input(overrides: Record<string, unknown> = {}) {
  return {
    proposalId: PROPOSAL,
    accountId: ACCOUNT,
    actorUserId: ACTOR,
    expectedVersionToken: EXPECTED_TOKEN,
    ...overrides,
  };
}

/**
 * Primes the queue for a FULL happy path. The order is the module's statement
 * order and is the thing under test in title 3, so it is spelled out rather
 * than hidden behind a helper that could drift from the module:
 *
 *   0 pre-tx  readProposalForAccount
 *   1 tx      businesses … FOR UPDATE      → { updated_at }
 *   2 tx      agent_proposals … FOR UPDATE → the locked row
 *   3 tx      users … role = 'owner'       → the actor
 *   4 tx      accounts … subscription_tier
 *   5 tx      agent_turns … owner_text
 *   6 tx      UPDATE agent_proposals (applied)
 *   7 tx      readProposalForAccount (the applied view)
 *   8 tx      UPDATE agent_proposals (sibling sweep)
 *
 * `assertWritableSubscriptionForAccount` issues no statement here — it is
 * mocked — so there is no queue entry between 3 and 4.
 */
function primeHappyPath(options: { currentUpdatedAt?: string; storedOverrides?: Record<string, unknown> } = {}) {
  const locked = storedRow(options.storedOverrides);
  sqlReturnQueue.push(
    mkTaggedResult([locked]),
    mkTaggedResult([{ updated_at: options.currentUpdatedAt ?? PREPARED_AT }]),
    mkTaggedResult([locked]),
    mkTaggedResult([{ id: ACTOR, name: ACTOR_NAME, email: ACTOR_EMAIL }]),
    mkTaggedResult([{ subscription_tier: 'copilot' }]),
    mkTaggedResult([{ owner_text: 'Make my replies warmer.' }]),
    mkTaggedResult([]),
    mkTaggedResult([storedRow({ status: PROPOSAL_STATUS.APPLIED, ...options.storedOverrides })]),
    mkTaggedResult([]),
  );
}

describe('applyProposal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockSql();
    mockWritable.mockResolvedValue({ ok: true });
    mockUpdateVoice.mockResolvedValue({ ok: true, updatedAt: WRITTEN_AT });
    mockReadVoice.mockResolvedValue({ ...VOICE_AFTER, updatedAt: WRITTEN_AT });
  });

  it("applyProposal locks the businesses row before the proposal row and writes only the operation's own fields through updateVoiceConfig", async () => {
    primeHappyPath();

    const result = await applyProposal(sql, input());
    expect(result.kind).toBe('applied');

    // Statement 0 is the pre-transaction contract read and takes no lock.
    expect(sqlCalls[0]!.inTransaction).toBe(false);
    expect(sqlCalls[0]!.text).toContain('FROM agent_proposals');
    expect(sqlCalls[0]!.text).not.toContain('FOR UPDATE');

    // THE ORDERING THIS TEST EXISTS FOR: businesses first, proposal second.
    // Reversed, a concurrent settings PUT can move `updated_at` between the
    // proposal lock and the freshness read, and Apply commits against a row it
    // never actually held.
    expect(sqlCalls[1]!.inTransaction).toBe(true);
    expect(sqlCalls[1]!.text).toContain('FROM businesses');
    expect(sqlCalls[1]!.text).toContain('FOR UPDATE');
    expect(sqlCalls[1]!.text).toContain('archived_at IS NULL');
    expect(sqlCalls[1]!.text).toContain('updated_at::text');

    expect(sqlCalls[2]!.inTransaction).toBe(true);
    expect(sqlCalls[2]!.text).toContain('FROM agent_proposals');
    expect(sqlCalls[2]!.text).toContain('FOR UPDATE');

    // ONLY the operation's own field reaches the writer (D10). `after` carries
    // all five; passing it would revert a concurrent edit to another field.
    expect(mockUpdateVoice).toHaveBeenCalledTimes(1);
    const writerInput = mockUpdateVoice.mock.calls[0]![1] as { fields: Record<string, unknown> };
    expect(Object.keys(writerInput.fields)).toEqual(['tone']);
    expect(writerInput.fields).toEqual({ tone: 'warm and brief' });
  });

  it("applyProposal writes the actor's name on the receipt, falling back to the email", async () => {
    // S5 / F10. The card used to print `actorUserId`, a raw uuid. The name is
    // read on the gate's OWN `users` statement — one row, one source of truth
    // about who the actor is — and frozen into the Receipt, so a later rename
    // does not rewrite what the owner was told happened.
    primeHappyPath();
    await applyProposal(sql, input());

    const appliedWrite = writes()[0]!;
    expect(appliedWrite.text).toContain('SET status = ?');
    const receipt = appliedWrite.values.find(
      (value): value is { actorName: unknown; actorUserId: unknown } =>
        typeof value === 'object' && value !== null && 'actorName' in value,
    );
    expect(receipt).toBeDefined();
    expect(receipt!.actorName).toBe(ACTOR_NAME);
    // The uuid is still recorded — the NAME is what the card renders, the id
    // is what an audit follows.
    expect(receipt!.actorUserId).toBe(ACTOR);

    // A row with no name yet falls back to the email rather than to the uuid.
    resetMockSql();
    vi.clearAllMocks();
    mockWritable.mockResolvedValue({ ok: true });
    mockUpdateVoice.mockResolvedValue({ ok: true, updatedAt: WRITTEN_AT });
    mockReadVoice.mockResolvedValue({ ...VOICE_AFTER, updatedAt: WRITTEN_AT });
    const locked = storedRow();
    sqlReturnQueue.push(
      mkTaggedResult([locked]),
      mkTaggedResult([{ updated_at: PREPARED_AT }]),
      mkTaggedResult([locked]),
      mkTaggedResult([{ id: ACTOR, name: null, email: ACTOR_EMAIL }]),
      mkTaggedResult([{ subscription_tier: 'copilot' }]),
      mkTaggedResult([{ owner_text: 'Make my replies warmer.' }]),
      mkTaggedResult([]),
      mkTaggedResult([storedRow({ status: PROPOSAL_STATUS.APPLIED })]),
      mkTaggedResult([]),
    );
    await applyProposal(sql, input());
    const fallback = writes()[0]!.values.find(
      (value): value is { actorName: unknown } =>
        typeof value === 'object' && value !== null && 'actorName' in value,
    );
    expect(fallback!.actorName).toBe(ACTOR_EMAIL);
  });

  it('applyProposal on an applied proposal returns the stored receipt and executes nothing', async () => {
    const receipt = {
      version: 1,
      operation: 'set_tone',
      scope: { accountId: ACCOUNT, locationId: LOCATION },
      before: VOICE_BEFORE,
      after: VOICE_AFTER,
      differsFromPreview: false,
      effectiveNow: true,
      affects: 'future_drafts',
      remainingBlocked: [],
      appliedAt: '2026-09-12T10:00:00.000Z',
      actorUserId: ACTOR,
      ownerText: 'Make my replies warmer.',
      turnId: TURN,
      versionToken: {
        before: { businessId: LOCATION, updatedAt: PREPARED_AT },
        after: { businessId: LOCATION, updatedAt: WRITTEN_AT },
      },
    };
    const applied = storedRow({ status: PROPOSAL_STATUS.APPLIED, receipt, applied_at: new Date('2026-09-12T10:00:00.000Z') });
    sqlReturnQueue.push(
      mkTaggedResult([applied]),                                  // pre-tx read
      mkTaggedResult([{ updated_at: WRITTEN_AT }]),               // businesses lock
      mkTaggedResult([applied]),                                  // proposal lock
    );

    const result = await applyProposal(sql, input());

    expect(result).toEqual({
      kind: 'applied',
      repeated: true,
      // THE STORED RECEIPT HAS NO `actorName`, deliberately: it is a Receipt
      // written before that field existed, and it must still parse. The reader
      // defaults it to `null` rather than throwing — a `.strict()` schema that
      // required the new key would crash the card for exactly the owners who
      // already applied something (S5).
      proposal: expect.objectContaining({
        id: PROPOSAL,
        status: PROPOSAL_STATUS.APPLIED,
        receipt: { ...receipt, actorName: null },
      }),
    });
    // Nothing executed and nothing was written: three statements, no writer.
    expect(mockUpdateVoice).not.toHaveBeenCalled();
    expect(sqlCalls).toHaveLength(3);
    expect(writes()).toHaveLength(0);
  });

  it('applyProposal marks the proposal stale without mutation when the current token differs from the prepared token', async () => {
    const locked = storedRow();
    sqlReturnQueue.push(
      mkTaggedResult([locked]),
      // The settings form wrote between preparation and this click.
      mkTaggedResult([{ updated_at: WRITTEN_AT }]),
      mkTaggedResult([locked]),
      mkTaggedResult([{ id: ACTOR }]),
      mkTaggedResult([{ subscription_tier: 'copilot' }]),
      updated(1),                                                  // the stale UPDATE
      mkTaggedResult([storedRow({ status: PROPOSAL_STATUS.STALE, failure_reason: PROPOSAL_FAILURE_REASON.VERSION_MISMATCH })]),
    );

    const result = await applyProposal(sql, input());

    expect(result.kind).toBe('stale');
    expect(mockUpdateVoice).not.toHaveBeenCalled();
    const staleWrite = writes()[0];
    expect(staleWrite!.text).toContain('account_id = ?');
    expect(staleWrite!.values).toContain(PROPOSAL_FAILURE_REASON.VERSION_MISMATCH);
    // The STATE CHANGE commits even though nothing was applied (spec §6.4
    // step 3) — the card must come back saying why, not saying nothing.
    expect(staleWrite!.inTransaction).toBe(true);
  });

  it("applyProposal marks the proposal stale without mutation when the client's expected token differs from the prepared token", async () => {
    const locked = storedRow();
    sqlReturnQueue.push(
      mkTaggedResult([locked]),
      // The ROW has not moved — current equals prepared.
      mkTaggedResult([{ updated_at: PREPARED_AT }]),
      mkTaggedResult([locked]),
      mkTaggedResult([{ id: ACTOR }]),
      mkTaggedResult([{ subscription_tier: 'copilot' }]),
      updated(1),
      mkTaggedResult([storedRow({ status: PROPOSAL_STATUS.STALE, failure_reason: PROPOSAL_FAILURE_REASON.VERSION_MISMATCH })]),
    );

    // …but the CLIENT sent a token that is not the stored one. Spec §6.4
    // step 3 requires all three to agree, so this is a miss even though the
    // row is unchanged: the browser is describing a plan this row is not.
    const result = await applyProposal(sql, input({
      expectedVersionToken: { businessId: LOCATION, updatedAt: WRITTEN_AT },
    }));

    expect(result.kind).toBe('stale');
    expect(mockUpdateVoice).not.toHaveBeenCalled();
  });

  it("applyProposal rejects a proposal whose contract_version is not the catalog's with contract_changed before any lock", async () => {
    sqlReturnQueue.push(
      mkTaggedResult([storedRow({ contract_version: 2 })]),
      updated(1),                                                  // the rejecting UPDATE
      mkTaggedResult([storedRow({ contract_version: 2, status: PROPOSAL_STATUS.REJECTED, failure_reason: PROPOSAL_FAILURE_REASON.CONTRACT_CHANGED })]),
    );

    const result = await applyProposal(sql, input());

    expect(result).toEqual({
      kind: 'rejected',
      reason: PROPOSAL_FAILURE_REASON.CONTRACT_CHANGED,
      proposal: expect.objectContaining({ status: PROPOSAL_STATUS.REJECTED }),
    });
    // BEFORE ANY LOCK: no transaction was opened and nothing was locked.
    expect(mockSql.begin).not.toHaveBeenCalled();
    expect(sqlCalls.every((call) => !call.text.includes('FOR UPDATE'))).toBe(true);
    expect(sqlCalls.every((call) => !call.inTransaction)).toBe(true);

    // …AND THE WRITE IS GUARDED ON `pending`. The status was read without a
    // lock, so a concurrent Apply can commit between that read and this UPDATE;
    // without the predicate the write would stamp `rejected` over an `applied`
    // row and destroy a committed Receipt.
    const update = writes()[0]!;
    expect(update.text).toContain('AND status = ?');
    expect(update.values).toContain(PROPOSAL_STATUS.PENDING);

    // And when it LOSES that race the zero-row UPDATE is not swallowed: the
    // re-read row is what the caller gets back.
    resetMockSql();
    sqlReturnQueue.push(
      mkTaggedResult([storedRow({ contract_version: 2 })]),
      updated(0),                                                  // the predicate matched nothing
      mkTaggedResult([storedRow({ contract_version: 2, status: PROPOSAL_STATUS.APPLIED })]),
    );
    const lost = await applyProposal(sql, input());
    expect(lost).toMatchObject({ kind: 'applied', repeated: true });
  });

  it('applyProposal returns proposal_not_found for a proposal of another account', async () => {
    // The account predicate matched nothing. Same answer an unknown id gets.
    sqlReturnQueue.push(mkTaggedResult([]));

    const result = await applyProposal(sql, input());

    expect(result).toEqual({ kind: 'not_found' });
    expect(mockSql.begin).not.toHaveBeenCalled();
    expect(sqlCalls).toHaveLength(1);
    expect(sqlCalls[0]!.values).toContain(ACCOUNT);
  });

  it('applyProposal answers proposal_not_pending for a stale, rejected, superseded or failed proposal', async () => {
    for (const status of [
      PROPOSAL_STATUS.STALE,
      PROPOSAL_STATUS.REJECTED,
      PROPOSAL_STATUS.SUPERSEDED,
      PROPOSAL_STATUS.FAILED,
    ]) {
      resetMockSql();
      vi.clearAllMocks();
      mockWritable.mockResolvedValue({ ok: true });
      const locked = storedRow({ status });
      sqlReturnQueue.push(
        mkTaggedResult([locked]),
        mkTaggedResult([{ updated_at: PREPARED_AT }]),
        mkTaggedResult([locked]),
      );

      const result = await applyProposal(sql, input());

      expect(result).toEqual({
        kind: 'not_pending',
        status,
        proposal: expect.objectContaining({ status }),
      });
      expect(mockUpdateVoice).not.toHaveBeenCalled();
      expect(writes()).toHaveLength(0);
    }
  });

  it('applyProposal rejects the proposal unauthorized when the actor is no longer a writable owner', async () => {
    const locked = storedRow();
    sqlReturnQueue.push(
      mkTaggedResult([locked]),
      mkTaggedResult([{ updated_at: PREPARED_AT }]),
      mkTaggedResult([locked]),
      mkTaggedResult([]),                                          // no owner row: role changed
      updated(1),                                                  // the rejecting UPDATE
      mkTaggedResult([storedRow({ status: PROPOSAL_STATUS.REJECTED, failure_reason: PROPOSAL_FAILURE_REASON.UNAUTHORIZED })]),
    );

    const result = await applyProposal(sql, input());

    expect(result).toEqual({
      kind: 'rejected',
      reason: PROPOSAL_FAILURE_REASON.UNAUTHORIZED,
      proposal: expect.objectContaining({ status: PROPOSAL_STATUS.REJECTED }),
    });
    expect(mockUpdateVoice).not.toHaveBeenCalled();

    // The offboarding arm answers its own reason, not `unauthorized`.
    resetMockSql();
    vi.clearAllMocks();
    mockWritable.mockResolvedValue({ ok: false, status: 403, error: 'account_offboarding_blocked' });
    sqlReturnQueue.push(
      mkTaggedResult([locked]),
      mkTaggedResult([{ updated_at: PREPARED_AT }]),
      mkTaggedResult([locked]),
      mkTaggedResult([{ id: ACTOR }]),
      updated(1),
      mkTaggedResult([storedRow({ status: PROPOSAL_STATUS.REJECTED, failure_reason: PROPOSAL_FAILURE_REASON.ACCOUNT_OFFBOARDING })]),
    );

    const offboarding = await applyProposal(sql, input());
    expect(offboarding).toMatchObject({
      kind: 'rejected',
      reason: PROPOSAL_FAILURE_REASON.ACCOUNT_OFFBOARDING,
    });
  });

  it('applyProposal rejects the proposal location_not_found when the location was archived after preparation', async () => {
    sqlReturnQueue.push(
      mkTaggedResult([storedRow()]),
      // `archived_at IS NULL` in the lock's own predicate matched nothing.
      mkTaggedResult([]),
      // The proposal row is STILL locked and read: the status branch runs
      // before the location refusal (RB-10), so an already-applied row on an
      // archived location gets its Receipt back instead of a 409.
      mkTaggedResult([storedRow()]),
      updated(1),                                                  // the rejecting UPDATE
      mkTaggedResult([storedRow({ status: PROPOSAL_STATUS.REJECTED, failure_reason: PROPOSAL_FAILURE_REASON.LOCATION_NOT_FOUND })]),
    );

    const result = await applyProposal(sql, input());

    expect(result).toEqual({
      kind: 'rejected',
      reason: PROPOSAL_FAILURE_REASON.LOCATION_NOT_FOUND,
      proposal: expect.objectContaining({ status: PROPOSAL_STATUS.REJECTED }),
    });
    expect(mockUpdateVoice).not.toHaveBeenCalled();
    expect(writes()).toHaveLength(1);
  });
});

describe('applyProposal invariants', () => {
  it('invariants: from any non-pending status applyProposal never writes businesses', async () => {
    const nonPending = fc.constantFrom(
      PROPOSAL_STATUS.APPLIED,
      PROPOSAL_STATUS.STALE,
      PROPOSAL_STATUS.REJECTED,
      PROPOSAL_STATUS.FAILED,
      PROPOSAL_STATUS.SUPERSEDED,
    );
    // Any current row timestamp, matching or not: the status branch runs BEFORE
    // the token comparison, so freshness cannot make a terminal row writable.
    const currentUpdatedAt = fc.constantFrom(PREPARED_AT, WRITTEN_AT, '2026-01-01 00:00:00+00');

    await fc.assert(
      fc.asyncProperty(nonPending, currentUpdatedAt, async (status, updatedAt) => {
        resetMockSql();
        vi.clearAllMocks();
        mockWritable.mockResolvedValue({ ok: true });
        mockUpdateVoice.mockResolvedValue({ ok: true, updatedAt: WRITTEN_AT });
        mockReadVoice.mockResolvedValue({ ...VOICE_AFTER, updatedAt: WRITTEN_AT });

        const locked = storedRow({ status });
        sqlReturnQueue.push(
          mkTaggedResult([locked]),
          mkTaggedResult([{ updated_at: updatedAt }]),
          mkTaggedResult([locked]),
        );

        const result = await applyProposal(sql, input());

        expect(['applied', 'not_pending']).toContain(result.kind);
        expect(mockUpdateVoice).not.toHaveBeenCalled();
        expect(writes()).toHaveLength(0);
      }),
      { numRuns: 40 },
    );
  });
});
