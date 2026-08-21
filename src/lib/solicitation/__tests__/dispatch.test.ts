// Unit half of `dispatchOutreach` (#899 Task 0 — the eval task).
//
// Everything here is about ORDER, ISOLATION and REDACTION — claims that a live
// database cannot witness because they are about what the module does BETWEEN
// its writes, not about the rows it leaves behind:
//
//   * the two slow gate checks run with NO lock held (decision 3),
//   * a retryable provider failure is absorbed INSIDE one handler invocation
//     with the same idempotency key and the same body (decision 9a),
//   * no raw unsubscribe token and no recipient handle ever reaches a log line
//     (invariant #5 plus CLAUDE.md's structured-logging rule),
//   * neither placeholder survives into the outbound message.
//
// The Messaging adapter is STUBBED here — reached through `getMessagingAdapter()`
// so the stub sits at the seam, never at `EmailAdapter` and never at a Resend
// client. No database, no network, no clock.
//
// The Postgres.js stand-in is the shared fragment-aware harness
// (`worker/__tests__/helpers/mock-sql`), the same one the run-spine writer
// suites use — no hand-rolled tagged-template shim. `dispatchOutreach` takes its
// executor as a parameter (invariant #15), so the harness is passed in rather
// than injected through a module mock.
//
// Three titles are still `it.todo`: Tasks 4 and 6 choose which collaborators
// they call and in what order, and writing those assertions now would pin an
// internal seam the plan has deliberately left to the implementer.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { ModerationDecision } from '@/lib/moderation/output-filter';
import {
  createMockSql,
  mkTaggedResult,
  type MockSqlHarness,
} from '../../../../worker/__tests__/helpers/mock-sql';
import { CONSENT_ATTESTATION_VERSION } from '../attestation';
import { assembleAskBody } from '../ask-render';

// ── Collaborator stubs ───────────────────────────────────────────────────────
//
// Everything `dispatchOutreach` reaches for that is NOT the subject of these
// cases: the outbox CAS, the run spine, the batch-closure join, the moderation
// provider and the Messaging adapter seam. The five FAST gate reads stay REAL
// and are answered through the harness's return queue, so the gate under test is
// the production one.

const mocks = vi.hoisted(() => ({
  lockDispatchedOutboxAttemptIfOwned: vi.fn<() => Promise<boolean>>(),
  markOutboxCompletedIfOwned: vi.fn<() => Promise<void>>(),
  findActiveSolicitationSendBatchRun: vi.fn<() => Promise<{ runId: string } | null>>(),
  startOrGetSolicitationAskRun: vi.fn<() => Promise<{ runId: string; created: boolean }>>(),
  recordStep: vi.fn<() => Promise<void>>(),
  completeRun: vi.fn<() => Promise<void>>(),
  closeBatchIfSettled: vi.fn<() => Promise<unknown>>(),
  moderateResponse: vi.fn<(text: string) => Promise<ModerationDecision>>(),
  send: vi.fn<() => Promise<unknown>>(),
  /** Filled by the moderation module mock so a case can delegate to the REAL
   *  `moderateResponse` — which is what makes the flag-off case a test of the
   *  production mapping rather than of a stub. */
  realModerateResponse: { current: null as null | ((text: string) => Promise<ModerationDecision>) },
  // Inline rather than `mockWorkerLogger()`: `vi.hoisted` runs before static
  // imports initialize, so calling the harness's factory here throws.
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/shared/logger', () => ({ createWorkerLogger: () => mocks.logger }));

vi.mock('@/lib/shared/outbox', () => ({
  lockDispatchedOutboxAttemptIfOwned: mocks.lockDispatchedOutboxAttemptIfOwned,
  markOutboxCompletedIfOwned: mocks.markOutboxCompletedIfOwned,
}));

vi.mock('@/lib/agents/run-spine', () => ({
  findActiveSolicitationSendBatchRun: mocks.findActiveSolicitationSendBatchRun,
  startOrGetSolicitationAskRun: mocks.startOrGetSolicitationAskRun,
  recordStep: mocks.recordStep,
  completeRun: mocks.completeRun,
}));

// Partial: `BATCH_SEND_WINDOW_HOURS`, `deriveBatchState` and
// `parseOutreachInterpolationInputs` are the production ones — the gate's
// batch-open item and the snapshot parse are part of what is under test.
vi.mock('../outreach', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../outreach')>()),
  closeBatchIfSettled: mocks.closeBatchIfSettled,
}));

vi.mock('@/lib/moderation/moderate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/moderation/moderate')>();
  mocks.realModerateResponse.current = actual.moderateResponse;
  return { moderateResponse: mocks.moderateResponse };
});

// The seam, never `EmailAdapter` and never a Resend client. Task 3 reaches it in
// no path at all — which is precisely the claim "never sends" makes, and wiring
// the stub here keeps that claim honest once Task 6 makes the call real.
vi.mock('@/lib/messaging/messaging-adapter', () => ({
  getMessagingAdapter: () => ({ send: mocks.send }),
}));

const { dispatchOutreach } = await import('../dispatch');

// ── Fixture bytes ────────────────────────────────────────────────────────────

const ACCOUNT_ID = '00000000-0000-4000-8000-00000000acc7';
const BUSINESS_ID = '00000000-0000-4000-8000-0000000000b1';
const BATCH_ID = '00000000-0000-4000-8000-0000000000ba';
const OUTREACH_ID = '00000000-0000-4000-8000-0000000000c0';
const ASK_ID = '00000000-0000-4000-8000-0000000000a5';
const CONTACT_ID = '00000000-0000-4000-8000-0000000000c1';
const OUTBOX_ID = '00000000-0000-4000-8000-0000000000b0';
const HANDLE = 'dana@example.test';
const POSTAL_ADDRESS = '742 Evergreen Terrace\nSpringfield, IL 62704';

const STORED_SUBJECT = 'How did we do?';

/** The real assembler, so the stored bytes carry the real footer — the postal
 *  byte-match and lint class 7 are both claims about exactly these bytes. */
const STORED_BODY = assembleAskBody(
  'Thanks for stopping by — would you mind leaving us a review?',
  { businessName: 'Dispatch Business', postalAddress: POSTAL_ADDRESS },
)!;

/** The §5.3 snapshot the re-lint replays its exemption corpus from. */
const STORED_INTERPOLATION_INPUTS = {
  contact_first_name: 'Dana',
  business_name: 'Dispatch Business',
  days_since_visit_bucket: 'last week',
  vertical: 'other',
  visit_note: null,
  note_disposition: 'absent',
};

const CLEAN_PROVIDER_VERDICT: ModerationDecision = {
  flagged: false,
  severity: 'low',
  reason: null,
  categories: { openai_moderation: 'clean' },
  score: 0,
  source: null,
  providerStatus: 'clean',
};

function outreachDispatchRow() {
  return {
    account_id: ACCOUNT_ID,
    delivery_status: 'queued',
    rendered_subject: STORED_SUBJECT,
    rendered_body: STORED_BODY,
    interpolation_inputs: STORED_INTERPOLATION_INPUTS,
  };
}

/** Approved, past its veto window, inside the send window and already dripping —
 *  `deriveBatchState` reads `sending`, one of the two states the gate's
 *  `batch_open` item admits. */
function openBatchRow() {
  const now = Date.now();
  return {
    built_at: new Date(now - 2 * 60 * 60 * 1000),
    approved_at: new Date(now - 90 * 60 * 1000),
    veto_deadline_at: new Date(now - 60 * 60 * 1000),
    sending_started_at: new Date(now - 45 * 60 * 1000),
    send_closed_at: null,
    halted_at: null,
  };
}

/**
 * The FAST reads tx1 issues, in the order `runDispatchTx` and
 * `gatherFastGateEvidence` issue them. Positions matter: the harness answers
 * awaited queries strictly FIFO, so an empty slot is a real query with an empty
 * result, not a gap.
 */
function queueFastGatePassing(harness: MockSqlHarness): void {
  harness.sqlReturnQueue.push(
    mkTaggedResult([outreachDispatchRow()]),                      // pre-tx read
    mkTaggedResult([]),                                           // advisory lock
    mkTaggedResult([openBatchRow()]),                             // batch FOR UPDATE
    mkTaggedResult([{
      ask_id: ASK_ID,
      contact_id: CONTACT_ID,
      delivery_status: 'queued',
      rendered_body: STORED_BODY,
    }]),                                                          // outreach FOR UPDATE
    mkTaggedResult([{ email: HANDLE }]),                          // contact handle
    mkTaggedResult([]),                                           // suppression: no match
    mkTaggedResult([{
      id: 'consent-row',
      basis: 'owner_attested',
      attestation_version: CONSENT_ATTESTATION_VERSION,
    }]),                                                          // consent ledger
    mkTaggedResult([{
      address: POSTAL_ADDRESS,
      attested_at: '2026-08-01T00:00:00.000Z',
      attestation_version: 'postal_v1',
      google_place_address: null,
    }]),                                                          // attested postal address
  );
}

function dispatchInput(correlationId: string) {
  return {
    batchId: BATCH_ID,
    businessId: BUSINESS_ID,
    outreachId: OUTREACH_ID,
    outboxHandle: { outboxId: OUTBOX_ID, attempt: 1 },
    correlationId,
  };
}

/** Every UPDATE the run issued, flattened — the withheld reason arrives as a
 *  bound value, never as literal SQL text. */
function boundValues(harness: MockSqlHarness): unknown[] {
  return harness.sqlCalls.flatMap((call) => call.values);
}

describe('dispatchOutreach — gate ordering and provider isolation', () => {
  let harness: MockSqlHarness;

  beforeEach(() => {
    harness = createMockSql();
    vi.clearAllMocks();
    mocks.lockDispatchedOutboxAttemptIfOwned.mockResolvedValue(true);
    mocks.markOutboxCompletedIfOwned.mockResolvedValue(undefined);
    mocks.findActiveSolicitationSendBatchRun.mockResolvedValue({ runId: 'parent-run' });
    mocks.startOrGetSolicitationAskRun.mockResolvedValue({ runId: 'child-run', created: true });
    mocks.recordStep.mockResolvedValue(undefined);
    mocks.completeRun.mockResolvedValue(undefined);
    mocks.closeBatchIfSettled.mockResolvedValue({});
    // Default: the REAL moderation function. A case that needs a scripted
    // verdict overrides it; a case about the production mapping does not.
    mocks.moderateResponse.mockImplementation((text) => mocks.realModerateResponse.current!(text));
    process.env.SOLICITATION_SEND_ENABLED = 'true';
  });

  // Task 3. `moderateResponse` fails OPEN for the reply lane (invariant #4's
  // OPENAI_MODERATION_ENABLED carve-out), and the Solicitation lane inverts
  // that: an unmoderated ask is not a send-eligible ask. The verdict lands at
  // gate slot 9 as `moderationClean: false`, so the row is WITHHELD with
  // `moderation_high` and the adapter stub records zero calls.
  it('treats OPENAI_MODERATION_ENABLED=false as a failed re-moderation and never sends', async () => {
    const previous = process.env.OPENAI_MODERATION_ENABLED;
    process.env.OPENAI_MODERATION_ENABLED = 'false';
    queueFastGatePassing(harness);

    try {
      await dispatchOutreach(harness.mockSql as unknown as Sql, dispatchInput('moderation-off'));
    } finally {
      if (previous === undefined) delete process.env.OPENAI_MODERATION_ENABLED;
      else process.env.OPENAI_MODERATION_ENABLED = previous;
    }

    // The REAL `moderateResponse` ran (no scripted verdict): with the provider
    // off it returns the local decision, whose `providerStatus` is null — and
    // null is not 'clean'. That mapping is the whole subject of this case.
    expect(mocks.moderateResponse).toHaveBeenCalledTimes(1);

    // Every fast item passed, so `moderation_high` can only have come from slot
    // 9 — and it reached the row as a bound value on the withhold UPDATE.
    expect(boundValues(harness)).toContain('moderation_high');
    expect(mocks.completeRun).toHaveBeenCalledWith(expect.anything(), 'child-run', 'completed');

    // Never sends, in both senses that matter: no adapter call, and no write
    // that could move the row toward the wire.
    expect(mocks.send).not.toHaveBeenCalled();
    expect(boundValues(harness)).not.toContain('sending');
    expect(harness.sqlCalls.some((call) => call.text.includes('sending_at'))).toBe(false);
  });

  // Task 3. The claim is temporal: re-lint and re-moderation complete before
  // `sql.begin` is entered. A fake `Sql` records when `begin` opens and closes;
  // the moderation stub records when it was called. Holding the batch row lock
  // across a remote call is how one slow provider stalls a whole batch.
  it('runs re-lint and re-moderation before tx1 opens so no lock is held across a slow remote call', async () => {
    const timeline: string[] = [];

    mocks.moderateResponse.mockImplementation(async () => {
      timeline.push('moderation:called');
      // The provider round trip. Anything tx1 did concurrently would interleave
      // here, which is exactly what this microtask boundary is for.
      expect(harness.isInTransaction()).toBe(false);
      expect(harness.mockSql.begin).not.toHaveBeenCalled();
      await Promise.resolve();
      timeline.push('moderation:resolved');
      return CLEAN_PROVIDER_VERDICT;
    });

    // tx1's FIRST statement. Stopping the transaction here keeps the case about
    // ordering alone — a stale attempt does nothing else at all.
    mocks.lockDispatchedOutboxAttemptIfOwned.mockImplementation(async () => {
      timeline.push('tx1:first-statement');
      return false;
    });

    harness.sqlReturnQueue.push(mkTaggedResult([outreachDispatchRow()]));

    await dispatchOutreach(harness.mockSql as unknown as Sql, dispatchInput('slow-before-tx1'));

    // RESOLVED before tx1 opened, not merely called before it: the ordering
    // claim decision 3 makes is about the awaited round trip, and an assertion
    // on call order alone would still pass if the await happened under the lock.
    expect(timeline).toEqual(['moderation:called', 'moderation:resolved', 'tx1:first-statement']);

    // The bytes moderated are the STORED ones, subject and body together, so a
    // subject-only violation cannot slip past. Read from the row before the
    // transaction, never re-derived.
    expect(mocks.moderateResponse).toHaveBeenCalledWith(`${STORED_SUBJECT}\n${STORED_BODY}`);

    // And the pre-tx read really was the only query outside the transaction.
    expect(harness.sqlCalls.filter((call) => !call.inTransaction)).toHaveLength(1);
  });

  // Task 4. Assert over the captured logger output: the raw token appears
  // nowhere, only `unsubscribeTokenLogPrefix`'s prefix does, and the recipient
  // handle appears nowhere at all. String args are logged VERBATIM by
  // `createWorkerLogger` — the analytics blocked-key sanitizer only covers
  // object args, so this is not something the logger protects us from.
  it.todo('never logs the raw unsubscribe token or the recipient handle');

  // Task 6. The adapter stub rejects once with a retryable failure, then
  // resolves. Assert: two `send` calls, one handler invocation, and the two
  // calls carry byte-identical `outreachId` (the provider idempotency key) and
  // byte-identical bodies. A retry that rebuilds the body can send a DIFFERENT
  // message under the same key, which is worse than sending twice.
  it.todo('retries a retryable provider failure in process with the same idempotency key and the same body');

  // Task 4. Both placeholders are substituted in memory only. Assert the
  // outbound `OutboundMessage` contains neither literal placeholder, and that
  // the stored bytes handed in were never mutated — a recipient receiving a
  // raw placeholder is a visible defect no other test in this plan catches.
  it.todo('substitutes the review-link placeholder only in the outbound message and never sends the stored placeholder');
});
