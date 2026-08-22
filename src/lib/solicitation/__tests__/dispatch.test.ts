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
// Every title here is a real assertion — no `it.todo` remains. The two that
// pin ORDER rather than outcome are the load-bearing ones: re-moderation must
// resolve BEFORE the first `sql.begin` (no lock held across a ~10s provider
// call), and an in-process retry must reuse one message object so the
// idempotency key and the body are identical by construction.

import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { OutboundMessage } from '@/lib/messaging/messaging-adapter';
import type { ModerationDecision } from '@/lib/moderation/output-filter';
import { resetServerConfigForTests } from '@/lib/config/server';
import { resetWorkerConfigForTests } from '@/lib/config/worker';
import {
  createMockSql,
  mkTaggedResult,
  type MockSqlHarness,
} from '../../../../worker/__tests__/helpers/mock-sql';
import { CONSENT_ATTESTATION_VERSION } from '../attestation';
import {
  assembleAskBody,
  REVIEW_LINK_PLACEHOLDER,
  UNSUBSCRIBE_URL_PLACEHOLDER,
} from '../ask-render';
import { isWellFormedUnsubscribeToken, mintUnsubscribeRawToken } from '../unsubscribe';

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
  recordOutcome: vi.fn<() => Promise<void>>(),
  completeRun: vi.fn<() => Promise<void>>(),
  closeBatchIfSettled: vi.fn<() => Promise<unknown>>(),
  moderateResponse: vi.fn<(text: string) => Promise<ModerationDecision>>(),
  send: vi.fn<(message: OutboundMessage) => Promise<{ providerMessageId: string }>>(),
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
  recordOutcome: mocks.recordOutcome,
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

// The seam, never `EmailAdapter` and never a Resend client. Every "never sends"
// claim below is an assertion on THIS stub, so a future call site that reached
// around the seam would not silence them — it would fail them.
vi.mock('@/lib/messaging/messaging-adapter', () => ({
  getMessagingAdapter: () => ({ send: mocks.send }),
}));

const { assembleOutboundMessage, dispatchOutreach } = await import('../dispatch');

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

const BUSINESS_NAME = 'Dispatch Business';
const OWNER_EMAIL = 'owner@dispatch.test';

/** Canonical per `isPlaceId` (`src/lib/reviews/url-parser.ts`): starts with a
 *  letter, base64url charset, 20+ chars. */
const CANONICAL_PLACE_ID = 'ChIJdispatch0000000000000000';

/** Migration 007's legacy shape — the arm a reader will assume is fine. It
 *  passes `extractPlaceId` and fails `isPlaceId`, and pasted into
 *  `writereview?placeid=` it resolves to nothing at all. */
const HEX_CID_PLACE_ID = '0x89c25a31eee6a5db:0x4b1e6e5b2d3f7a10';

/** Pinned rather than inherited: the unsubscribe URL is built from this, and a
 *  case that read whatever `.env.local` carried would assert against a value
 *  that changes between machines. */
const APP_URL = 'https://dispatch.test';

/** ≥32 bytes — `mintUnsubscribeRawToken` signs with it, and
 *  `isWellFormedUnsubscribeToken` verifies against it below. */
const SESSION_SECRET = 'dispatch-test-session-secret-0123456789';

const EXPECTED_REVIEW_LINK =
  `https://search.google.com/local/writereview?placeid=${CANONICAL_PLACE_ID}`;

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
      rendered_subject: STORED_SUBJECT,
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

/**
 * The three further awaited queries a PASSING gate issues, in `runDispatchTx`'s
 * order: the consent snapshot UPDATE, the `businesses` identity read, and the
 * token mint. Positions matter for the same reason as above — the harness
 * answers FIFO.
 *
 * `mint: 'conflict'` returns NO row, which is what
 * `ON CONFLICT … DO NOTHING RETURNING id` yields when the row is already there
 * — locked decision 9's fresh-process case.
 */
function queuePostGate(
  harness: MockSqlHarness,
  options: { placeId?: string | null; mint?: 'minted' | 'conflict' } = {},
): void {
  harness.sqlReturnQueue.push(
    mkTaggedResult([]),                                           // consent snapshot UPDATE
    mkTaggedResult([{
      name: BUSINESS_NAME,
      owner_email: OWNER_EMAIL,
      google_place_id: options.placeId === undefined ? CANONICAL_PLACE_ID : options.placeId,
    }]),                                                          // businesses identity
    options.mint === 'conflict'
      ? mkTaggedResult<{ id: string }>([])
      : mkTaggedResult([{ id: 'token-row' }]),                    // unsubscribe token mint
  );
}

/**
 * The rest of tx1 on the PASSING path, in `runDispatchTx`'s order: the
 * `agent_run_id` stamp and the `queued → sending` CAS. The child creation and
 * the `dispatch_gate_evaluated` step run through the mocked run-spine and issue
 * no query, so they take no slot.
 *
 * The CAS is `RETURNING id`, so an empty result is the "another worker owns it"
 * arm — `cas: 'lost'` drives exactly that.
 */
function queueTx1Tail(harness: MockSqlHarness, options: { cas?: 'won' | 'lost' } = {}): void {
  harness.sqlReturnQueue.push(
    mkTaggedResult([]),                                           // agent_run_id stamp
    options.cas === 'lost'
      ? mkTaggedResult<{ id: string }>([])
      : mkTaggedResult([{ id: OUTREACH_ID }]),                    // queued → sending CAS
  );
}

/**
 * tx2's two awaited queries: the advisory lock (`acquireSolicitationBatchLock`
 * is the FIRST statement, mirroring tx1's global lock order) and the terminal
 * `sending → sent | failed` CAS. Everything else in that transaction — the
 * child's terminal, the outcome, the outbox completion, the batch-closure join
 * — runs through a mocked collaborator.
 */
function queueTx2(harness: MockSqlHarness): void {
  harness.sqlReturnQueue.push(
    mkTaggedResult([]),                                           // advisory lock
    mkTaggedResult([{ id: OUTREACH_ID }]),                        // terminal CAS
  );
}

/** The provider's answer for a case that is not about the provider. */
const PROVIDER_MESSAGE_ID = 'msg_dispatch_unit';

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

/**
 * Everything the logger was handed, as one string per call — message AND
 * structured fields together, because `createWorkerLogger` renders both and a
 * leak can hide in either.
 */
function loggedLines(): string[] {
  return [
    ...mocks.logger.log.mock.calls,
    ...mocks.logger.warn.mock.calls,
    ...mocks.logger.error.mock.calls,
  ].map((args) => args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
}

/**
 * Every substring of `text` shaped like a minted token (`<nonce>.<mac>`), so
 * the leak check does not depend on knowing the raw token — which no test can,
 * by construction. `isWellFormedUnsubscribeToken` VERIFIES the HMAC, so a real
 * leaked token is caught wherever it is embedded while ordinary text is not.
 */
function looksLikeAMintedToken(text: string): boolean {
  return (text.match(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{40,}/g) ?? [])
    .some((candidate) => isWellFormedUnsubscribeToken(candidate));
}

describe('dispatchOutreach — gate ordering and provider isolation', () => {
  let harness: MockSqlHarness;

  const priorEnv = {
    appUrl: process.env.NEXT_PUBLIC_APP_URL,
    sessionSecret: process.env.SESSION_COOKIE_SECRET,
  };

  afterAll(() => {
    if (priorEnv.appUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = priorEnv.appUrl;
    if (priorEnv.sessionSecret === undefined) delete process.env.SESSION_COOKIE_SECRET;
    else process.env.SESSION_COOKIE_SECRET = priorEnv.sessionSecret;
    resetWorkerConfigForTests();
    resetServerConfigForTests();
  });

  beforeEach(() => {
    harness = createMockSql();
    vi.clearAllMocks();
    // Both config accessors MEMOIZE, so setting the variable is not enough —
    // the memo has to be dropped or the next read returns whatever the first
    // read in this process parsed.
    process.env.NEXT_PUBLIC_APP_URL = APP_URL;
    process.env.SESSION_COOKIE_SECRET = SESSION_SECRET;
    resetWorkerConfigForTests();
    resetServerConfigForTests();
    mocks.lockDispatchedOutboxAttemptIfOwned.mockResolvedValue(true);
    mocks.markOutboxCompletedIfOwned.mockResolvedValue(undefined);
    mocks.findActiveSolicitationSendBatchRun.mockResolvedValue({ runId: 'parent-run' });
    mocks.startOrGetSolicitationAskRun.mockResolvedValue({ runId: 'child-run', created: true });
    mocks.recordStep.mockResolvedValue(undefined);
    mocks.recordOutcome.mockResolvedValue(undefined);
    mocks.completeRun.mockResolvedValue(undefined);
    mocks.closeBatchIfSettled.mockResolvedValue({});
    mocks.send.mockResolvedValue({ providerMessageId: PROVIDER_MESSAGE_ID });
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
  it('never logs the raw unsubscribe token or the recipient handle', async () => {
    mocks.moderateResponse.mockResolvedValue(CLEAN_PROVIDER_VERDICT);
    queueFastGatePassing(harness);
    queuePostGate(harness);
    queueTx1Tail(harness);
    queueTx2(harness);

    // The whole passing path: the gate, the mint, the CAS, the provider call
    // and the terminal transaction — so every line this lane can emit about a
    // real send has been emitted by the time the scan below runs.
    await dispatchOutreach(harness.mockSql as unknown as Sql, dispatchInput('redaction'));
    expect(mocks.send).toHaveBeenCalledTimes(1);

    const lines = loggedLines();
    // Sanity: this case is worthless if nothing was logged at all.
    expect(lines.length).toBeGreaterThan(0);

    // NEGATIVE CONTROL. The leak check can never assert against the raw token
    // itself — it never leaves the module — so it has to recognise one by
    // shape and signature instead. If that detector silently stopped working,
    // every assertion below would pass on an empty claim.
    expect(looksLikeAMintedToken(`before ${mintUnsubscribeRawToken()} after`)).toBe(true);

    for (const line of lines) {
      // No raw token, however it were embedded — bare, or inside the /u/ URL.
      expect(looksLikeAMintedToken(line)).toBe(false);
      expect(line).not.toContain(`${APP_URL}/u/`);
      // Nor any of the other three things this lane holds and must not log.
      expect(line).not.toContain(HANDLE);
      expect(line).not.toContain(STORED_SUBJECT);
      expect(line).not.toContain(POSTAL_ADDRESS);
    }

    // And the token WAS logged — as `unsubscribeTokenLogPrefix`'s 12 hex chars
    // of digest, which is what makes an attempt correlatable with its retry.
    const assembled = mocks.logger.log.mock.calls.find(
      ([message]) => typeof message === 'string' && message.includes('message assembled'),
    );
    expect(assembled).toBeDefined();
    expect(assembled![1]).toMatchObject({ unsubscribe_token: expect.stringMatching(/^[a-f0-9]{12}$/) });
  });

  // Task 6. The adapter stub rejects once with a retryable failure, then
  // resolves. Assert: two `send` calls, one handler invocation, and the two
  // calls carry byte-identical `outreachId` (the provider idempotency key) and
  // byte-identical bodies. A retry that rebuilds the body can send a DIFFERENT
  // message under the same key, which is worse than sending twice.
  it('retries a retryable provider failure in process with the same idempotency key and the same body', async () => {
    mocks.moderateResponse.mockResolvedValue(CLEAN_PROVIDER_VERDICT);
    queueFastGatePassing(harness);
    queuePostGate(harness);
    queueTx1Tail(harness);
    queueTx2(harness);

    // Resend's shape: the SDK's `ErrorResponse` rides on `cause`, which is
    // where `classifySendFailure` reads the provider's own fields from. A 500
    // is D12c's row 2 — retryable.
    mocks.send.mockRejectedValueOnce(
      new Error('Resend refused the solicitation send', {
        cause: { name: 'internal_server_error', statusCode: 500, message: 'upstream boom' },
      }),
    );

    await dispatchOutreach(harness.mockSql as unknown as Sql, dispatchInput('retryable-send'));

    // TWO calls, ONE handler invocation. The retry lives inside this call
    // because the raw unsubscribe token only exists inside it (decision 9).
    expect(mocks.send).toHaveBeenCalledTimes(2);
    const [first] = mocks.send.mock.calls[0]!;
    const [second] = mocks.send.mock.calls[1]!;

    // The IDEMPOTENCY KEY. `EmailAdapter` derives it from `outreachId`, so the
    // two attempts are the same request to Resend rather than two sends.
    expect(first.outreachId).toBe(OUTREACH_ID);
    expect(second.outreachId).toBe(first.outreachId);

    // And the BODY, which is the half a retry can silently get wrong: a rebuilt
    // message would carry a NEW unsubscribe URL under that same key, so the
    // recipient's opt-out link would resolve to a token nothing minted.
    expect(second.bodyText).toBe(first.bodyText);
    expect(second.bodyHtml).toBe(first.bodyHtml);
    expect(second.subject).toBe(first.subject);
    expect(second.unsubscribeUrl).toBe(first.unsubscribeUrl);
    expect(second.recipient).toBe(first.recipient);
    // Byte-identity is not an accident of assembly here — it is the SAME
    // object, never re-derived between attempts.
    expect(second).toBe(first);
    // Sanity: the body really did carry a resolvable opt-out URL, so the
    // equality above is a claim about a real message.
    expect(first.bodyText).toContain(`${APP_URL}/u/`);

    // The retry SUCCEEDED, so the terminal transaction records a send: the
    // outcome lands on the child run with unit_count 1 and the run completes.
    expect(mocks.recordOutcome).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 'child-run',
        outcomeKind: 'solicitation_sent',
        unitCount: 1,
      }),
    );
    expect(mocks.completeRun).toHaveBeenCalledWith(expect.anything(), 'child-run', 'completed');

    // Nothing about the provider's failure text reached a log line — Resend
    // quotes the offending field, which can be the recipient address.
    for (const line of loggedLines()) {
      expect(line).not.toContain('upstream boom');
      expect(line).not.toContain(HANDLE);
    }
  });

  // Task 4. Both placeholders are substituted in memory only. Assert the
  // outbound `OutboundMessage` contains neither literal placeholder, and that
  // the stored bytes handed in were never mutated — a recipient receiving a
  // raw placeholder is a visible defect no other test in this plan catches.
  it('substitutes the review-link placeholder only in the outbound message and never sends the stored placeholder', async () => {
    // ── Half 1: the substitution itself, over the REAL stored bytes ──────────
    const unsubscribeUrl = `${APP_URL}/u/nonce.mac`;
    const message = assembleOutboundMessage({
      outreachId: OUTREACH_ID,
      accountId: ACCOUNT_ID,
      businessId: BUSINESS_ID,
      batchId: BATCH_ID,
      businessName: BUSINESS_NAME,
      ownerEmail: OWNER_EMAIL,
      recipient: HANDLE,
      subject: STORED_SUBJECT,
      storedBody: STORED_BODY,
      unsubscribeUrl,
      reviewLink: EXPECTED_REVIEW_LINK,
    });

    // The stored bytes DO carry both placeholders — otherwise this proves
    // nothing about substitution.
    expect(STORED_BODY).toContain(REVIEW_LINK_PLACEHOLDER);
    expect(STORED_BODY).toContain(UNSUBSCRIBE_URL_PLACEHOLDER);

    for (const part of [message.bodyText, message.bodyHtml, message.subject]) {
      expect(part).not.toContain(REVIEW_LINK_PLACEHOLDER);
      expect(part).not.toContain(UNSUBSCRIBE_URL_PLACEHOLDER);
    }
    expect(message.bodyText).toContain(EXPECTED_REVIEW_LINK);
    // The write-review deep link, never the maps VIEW link: the ask's call to
    // action is "Leave a review".
    expect(message.bodyText).toContain('search.google.com/local/writereview?placeid=');
    // §7.1's multipart rule and §7.2's "conspicuous" opt-out.
    expect(message.bodyHtml).toContain(`<a href="${unsubscribeUrl}">`);
    expect(message.unsubscribeUrl).toBe(unsubscribeUrl);

    // The **Owner approval** contract: substituting BACK reproduces the stored
    // bytes exactly, so the two placeholder swaps are demonstrably the ONLY
    // difference — not a reflow, not a trim, not a re-render.
    expect(
      message.bodyText
        .replaceAll(EXPECTED_REVIEW_LINK, REVIEW_LINK_PLACEHOLDER)
        .replaceAll(unsubscribeUrl, UNSUBSCRIBE_URL_PLACEHOLDER),
    ).toBe(STORED_BODY);

    // ── Half 2: the substituted bytes never reach Postgres ───────────────────
    mocks.moderateResponse.mockResolvedValue(CLEAN_PROVIDER_VERDICT);
    queueFastGatePassing(harness);
    queuePostGate(harness);
    queueTx1Tail(harness);
    queueTx2(harness);

    await dispatchOutreach(harness.mockSql as unknown as Sql, dispatchInput('substitution'));

    const written = boundValues(harness).filter(
      (value): value is string => typeof value === 'string',
    );
    for (const value of written) {
      expect(value).not.toContain(EXPECTED_REVIEW_LINK);
      expect(value).not.toContain(`${APP_URL}/u/`);
    }
    // Nothing wrote a body at all: the substituted copy lives only in memory,
    // and `rendered_body` is never an UPDATE target on this path.
    expect(harness.sqlCalls.some((call) => call.text.includes('rendered_body ='))).toBe(false);

    // ...and the substituted bytes DID reach the wire. Without this half the
    // claim above would be satisfied by a lane that substituted nothing.
    const [sentMessage] = mocks.send.mock.calls[0]!;
    expect(sentMessage.bodyText).toContain(EXPECTED_REVIEW_LINK);
    expect(sentMessage.bodyText).toContain(`${APP_URL}/u/`);
  });

  // Ruling 2 + 3. There is no `no_review_link` withheld reason (that needs a
  // migration this ticket does not own) and no eighth gate item (B6/B14 lock
  // the gate at seven), so an unbuildable call to action throws. Both arms are
  // covered because the second is the one a reader assumes is fine: migration
  // 007's legacy hex CIDs are non-null and non-canonical, and
  // `writereview?placeid=<hex cid>` resolves to nothing.
  it('throws rather than sending when the business has no canonical Google place id', async () => {
    for (const placeId of [null, HEX_CID_PLACE_ID]) {
      harness.resetMockSql();
      vi.clearAllMocks();
      mocks.lockDispatchedOutboxAttemptIfOwned.mockResolvedValue(true);
      mocks.moderateResponse.mockResolvedValue(CLEAN_PROVIDER_VERDICT);
      queueFastGatePassing(harness);
      queuePostGate(harness, { placeId });

      await expect(
        dispatchOutreach(harness.mockSql as unknown as Sql, dispatchInput('no-place-id')),
      ).rejects.toThrow(/no canonical Google place id/);

      // Thrown from inside tx1, BEFORE the mint: a business whose call to
      // action cannot be built never burns a token row it could not use.
      expect(harness.sqlCalls.some(
        (call) => call.text.includes('solicitation_unsubscribe_tokens'),
      )).toBe(false);
      expect(mocks.send).not.toHaveBeenCalled();
    }
  });
});
