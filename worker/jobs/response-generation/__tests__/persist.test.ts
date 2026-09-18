import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerationResult } from '../../../../src/lib/responses/types';
import type { ModerationDecision } from '../../../../src/lib/moderation/output-filter';

const { mockSql, mockTx, txQueue } = vi.hoisted(() => {
  const txQueue: unknown[][] = [];
  const mockTx: any = vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => {
    return Promise.resolve(txQueue.shift() ?? []);
  });
  // Stand-in for Postgres.js's tx.json(value) (audit.ts's JSONB bind for the
  // auto-policy audit metadata column) — identity pass-through.
  mockTx.json = vi.fn((value: unknown) => value);
  const mockSql: any = vi.fn();
  mockSql.begin = vi.fn(async (callback: (tx: typeof mockTx) => Promise<unknown>) => callback(mockTx));
  return { mockSql, mockTx, txQueue };
});

vi.mock('../../../../src/lib/db/server', () => ({
  sql: mockSql,
  jsonb: (value: unknown) => value,
}));

vi.mock('uuid', () => ({
  v7: vi.fn(() => 'deterministic-uuid-v7'),
}));

vi.mock('../../../../src/lib/agents/run-spine', () => ({
  findActiveReviewRun: vi.fn(),
  recordStep: vi.fn(),
  recordOutcome: vi.fn(),
}));

// ---------------------------------------------------------------------------
// #1079 — two PARTIAL mocks, both pass-through by default.
//
// They exist for the flag property at the bottom of this file and change
// nothing for the cases above: the gate override is `null` unless a case sets
// it, and the resolver spy delegates to the real vocabulary. The integration
// suite's `poison` switches are the precedent for the shape.
// ---------------------------------------------------------------------------

/**
 * The gate's `blockReasons`, DICTATED for one case rather than derived.
 *
 * `blockReasons` is COMPUTED from the stub's rows on the real path, and many
 * members are mutually exclusive — so a generated array cannot reach
 * `recordPolicyGateRefusal` without this. `null` means "use the real gate".
 *
 * ONLY the two fields the property is about are replaced. Every other field of
 * the decision stays the REAL one, because `buildAutoApprovalDecisionSummary`
 * reads five of them and a hand-built decision would be a second, drifting
 * definition of the gate's own DTO.
 */
const gateOverride = { blockReasons: null as readonly string[] | null };

vi.mock('../auto-approval', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auto-approval')>();
  return {
    ...actual,
    evaluateAutoApprovalCandidate: (
      ...args: Parameters<typeof actual.evaluateAutoApprovalCandidate>
    ): AutoApprovalDecision => {
      const decision = actual.evaluateAutoApprovalCandidate(...args);
      if (gateOverride.blockReasons === null) return decision;
      return {
        ...decision,
        approved: false,
        blockReasons: [...gateOverride.blockReasons] as AutoApprovalDecision['blockReasons'],
      };
    },
  };
});

/**
 * The vocabulary resolver as a SPY, so its CALL COUNT is observable.
 *
 * The count is the property's only oracle. "No refusal row with the flag off"
 * is satisfied by a `try/catch` around the resolve — the shape #1079 rejects,
 * because it leaves a vocabulary fault running inside the deciding transaction.
 * Only "never CALLED" separates them.
 */
const resolvePolicyGateRefusalSpy = vi.hoisted(() =>
  vi.fn<(codes: readonly string[]) => unknown>(),
);

vi.mock('../../../../src/lib/refusals/vocabulary', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/lib/refusals/vocabulary')>();
  // Installed ONCE, here. `vi.clearAllMocks()` (which this file uses) clears
  // call history and keeps implementations; `mockReset` would strip this and
  // make every later case resolve `undefined`.
  resolvePolicyGateRefusalSpy.mockImplementation((codes: readonly string[]) =>
    (actual.resolvePolicyGateRefusal as (c: readonly string[]) => unknown)(codes),
  );
  return { ...actual, resolvePolicyGateRefusal: resolvePolicyGateRefusalSpy };
});

/**
 * The ledger-dark note as a SPY, so guard 4's WARNING is observable (#1079).
 *
 * IT IS A SEPARATE ORACLE FROM THE RESOLVER SPY ABOVE, and has to be. With the
 * flag off the resolver count is zero for EVERY input, so it cannot say which
 * of those inputs would have produced a row — that is the whole question the
 * warning answers. Only this count separates "the ledger has a gap here" from
 * "this decision recorded nothing either way".
 *
 * The rest of the module stays REAL — `isRefusalLedgerEnabled` above all, since
 * the property drives it through the actual env flag.
 */
const noteRefusalLedgerDarkSpy = vi.hoisted(() => vi.fn<() => void>());

/**
 * The vocabulary-hole note as a SPY, so guard 4's SECOND signal is observable
 * (#1105).
 *
 * A THIRD ORACLE, and it has to be third. The resolver spy is zero for every
 * input while the flag is off, and the ledger-dark spy is zero for every input
 * that would not have recorded a row — an unmapped member is exactly such an
 * input, so neither existing counter can tell "nothing was refused here" from
 * "a block reason has no category mapping". Only this count separates them.
 *
 * WHAT IT DOES NOT PROVE, and the distinction matters: this file mocks the whole
 * write module, so a real helper could resolve-and-catch behind this stub and
 * every case here would still pass. `write.test.ts` owns that claim, against the
 * REAL helper and a resolver spy.
 */
const noteUnmappedBlockReasonsSpy = vi.hoisted(() =>
  vi.fn<(codes: readonly string[]) => void>(),
);

vi.mock('../../../../src/lib/refusals/write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/lib/refusals/write')>();
  return {
    ...actual,
    noteRefusalLedgerDark: noteRefusalLedgerDarkSpy,
    noteUnmappedBlockReasons: noteUnmappedBlockReasonsSpy,
  };
});

/**
 * `Sentry.captureException` as a SPY, so LEDGER ATTRIBUTION is observable here
 * (#1083).
 *
 * THE COUNT IS THE ORACLE, not the fact that a capture happened. Both fault
 * classes on this lane raise an `error`-level event tagged
 * `subsystem=refusal_ledger`, so "a capture occurred" cannot tell a vocabulary
 * fault from a write fault, and it cannot tell ONE event from TWO. Two events
 * for one failure is the defect the wrapper narrowing exists to remove: an
 * operator triaging a duplicated issue cannot tell which of the two is the
 * fault and which is the echo.
 *
 * A PARTIAL mock, on this file's `importOriginal` house style. `persist.ts`
 * imports the namespace, and the rest of the module graph keeps whatever else it
 * reaches for; only the one function under observation is replaced.
 */
const captureExceptionSpy = vi.hoisted(() => vi.fn());

vi.mock('@sentry/node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sentry/node')>();
  return { ...actual, captureException: captureExceptionSpy };
});

import { hasStaleReviewContent, persistResponseAndNotify } from '../persist';
import type { AutoApprovalDecision } from '../auto-approval';
import { POLICY_GATE_HELD_REFUSAL_CATEGORIES } from '../../../../src/lib/refusals/vocabulary';
import { REFUSAL_LEDGER_FLAG } from '../../../../src/lib/refusals/write';
import { findActiveReviewRun, recordStep, recordOutcome } from '../../../../src/lib/agents/run-spine';
import { QUEUE_NAMES } from '../../../../src/lib/shared/queue-names';
import {
  GENERATE_RESPONSE_ORIGIN_LANE,
  GENERATE_RESPONSE_ORIGIN_LANES,
} from '../../../../src/lib/shared/worker-types';
import { OUTBOX_COMPLETION_REASON } from '../../../../src/lib/shared/outbox-completion-reason';

const RESULT: GenerationResult = {
  responseText: 'Thank you for the kind review.',
  language: 'en',
  provider: 'openai',
  model: 'gpt-4o-mini-2024-07-18',
  usage: { promptTokens: 100, completionTokens: 50 },
  costUsd: 0.001,
  apiCostId: 'cost-1',
};

// Sentinel instance for the approve UPDATE's RETURNING'd deadline. Tests
// assert IDENTITY (===) of this object flowing into the publish enqueue's
// availableAt bind — the deadline must be DB-clock-derived, never recomputed.
const SCHEDULED_AT = new Date('2026-07-09T15:00:00.000Z');

const CLEAN_MODERATION: ModerationDecision = {
  flagged: false,
  severity: 'low',
  reason: null,
  categories: {},
  score: 0,
  source: 'openai_moderation',
  providerStatus: 'clean',
};

function currentState(overrides = {}) {
  return {
    star_rating: 5,
    review_content_hash: 'hash-1',
    archived_at: null,
    subscription_status: 'active',
    subscription_tier: 'autopilot',
    account_past_due_at: null,
    account_flags: {},
    triage_severity: null,
    triage_source: null,
    ...overrides,
  };
}

function enabledPolicy(overrides = {}) {
  return {
    id: 'policy-1',
    account_id: 'acct-1',
    location_id: null,
    auto_approve_min_star: 4,
    veto_window_minutes: 15,
    daily_auto_post_cap: null,
    suspended_at: null,
    ...overrides,
  };
}

function disabledPolicy(overrides = {}) {
  return enabledPolicy({ auto_approve_min_star: null, ...overrides });
}

function sendNotificationPayloads(): Record<string, unknown>[] {
  return txArgs().filter(
    (arg): arg is Record<string, unknown> =>
      !!arg
      && typeof arg === 'object'
      && !Array.isArray(arg)
      && 'response_id' in arg
      && 'business_id' in arg
      && !('review_id' in arg),
  );
}

function queuePersistRows(input: {
  state?: Record<string, unknown>;
  policies?: Record<string, unknown>[];
  connection?: Record<string, unknown> | null;
  flaggedHigh?: boolean;
  notify?: boolean;
  autoApprove?: boolean;
  reviewLockRows?: unknown[];
  autoApprovedToday?: number;
  approveUpdateRows?: unknown[];
  /**
   * Structural non-candidate (flag off / bad lane / version>1 / suppressed):
   * persist.ts short-circuits BEFORE the businesses FOR UPDATE and never runs
   * loadAutoApprovalRuntimeState, so neither the lock row nor the loader rows
   * are consumed.
   */
  structural?: boolean;
} = {}) {
  txQueue.push(
    // SELECT id FROM reviews … FOR UPDATE (lock ordering — FIRST tx statement)
    input.reviewLockRows ?? [{ id: 'rev-1' }],
  );
  if (!input.structural) {
    // SELECT id FROM businesses … FOR UPDATE (statement #2 — must precede the
    // responses INSERT, whose business_id FK takes an implicit FOR KEY SHARE)
    txQueue.push([{ id: 'biz-1' }]);
    txQueue.push([]); // pg_advisory_xact_lock(:tier_entitlement)
  }
  txQueue.push(
    [], // INSERT responses
    [], // UPDATE api_costs response_id
    [], // UPDATE api_costs moderation metadata
  );
  if (input.flaggedHigh) {
    txQueue.push([]); // INSERT flagged_responses
    // The held_draft Refusal (#1013) costs TWO queue entries here, and the
    // second one is a MOCK ARTIFACT rather than a second statement.
    //
    // `mockTx` (the hoisted block at the top of this file) shifts `txQueue` on
    // EVERY tagged-template call, awaited or not. `writeRefusalEvent` builds its
    // decision time with `occurredAtFragment`, which evaluates `tx`NOW()`` as an
    // INTERPOLATED FRAGMENT — real Postgres.js never executes that, but this
    // mock cannot tell a fragment from a query and consumes a result for it.
    //
    // So: one entry for the NOW() fragment, one for the INSERT. Do NOT "tidy"
    // this to a single push — the queue is STATEMENT-ORDER-SENSITIVE, and an
    // off-by-one here surfaces much later as
    // `auto_approval_invalid_subscription_tier:undefined` when the runtime-state
    // read consumes the policy row instead of its own.
    txQueue.push([]); // tx`NOW()` fragment (mock artifact, not a real query)
    txQueue.push([]); // INSERT refusal_events
  }
  if (!input.structural) {
    txQueue.push(
      [currentState(input.state)],
      input.policies ?? [enabledPolicy()],
      [{ id: 'biz-1' }], // loader's same-tx businesses FOR UPDATE re-take
      [{ auto_approved_today: input.autoApprovedToday ?? 0 }], // daily-cap count
      input.connection === null ? [] : [input.connection ?? { id: 'conn-1' }],
    );
  }
  if (input.autoApprove) {
    txQueue.push(
      // UPDATE responses approved … RETURNING auto_post_scheduled_at
      input.approveUpdateRows ?? [{ auto_post_scheduled_at: SCHEDULED_AT }],
      [{ account_id: 'acct-1' }], // audit account lookup
      [], // INSERT approval_audit_log
      [], // INSERT publish outbox (delayed to the RETURNING'd deadline)
      [], // INSERT pending_post_notice outbox
    );
  } else if (input.notify ?? true) {
    txQueue.push([]); // INSERT send_notification outbox
  }
  // NO push for the `policy_gate_held` Refusal (#1013), and that is deliberate
  // rather than an omission. On a HELD path it consumes two entries (the
  // `tx`NOW()`` fragment plus the INSERT, see the flaggedHigh branch above), but
  // it runs AFTER every row-CONSUMING read in the flow — the runtime-state
  // SELECTs, the cap count and the connection lookup are all behind it — and the
  // only statement after it on that path is the send_notification INSERT, whose
  // result nothing reads. `mockTx` yields `[]` for an exhausted queue, so the
  // shift is harmless there.
  //
  // It never runs on the APPROVED path at all (guard 2 in
  // `recordPolicyGateRefusal`), which is the path whose `RETURNING
  // auto_post_scheduled_at` row a test actually depends on.
  //
  // If a future statement is added AFTER the ledger write that reads its result,
  // this comment stops being true and the branch needs its two pushes.
}

function baseInput(overrides: Partial<Parameters<typeof persistResponseAndNotify>[1]> = {}) {
  return {
    result: RESULT,
    retryCostId: undefined,
    reviewId: 'rev-1',
    businessId: 'biz-1',
    version: 1,
    correlationId: 'corr-1',
    suppressNotification: false,
    originLane: 'live_ingest_new' as const,
    loadedReviewContentHash: 'hash-1',
    moderation: CLEAN_MODERATION,
    // The APPROVABLE default, so every pre-existing case keeps testing the gate
    // it is about. Absence is not clearance (that is the safety row's whole
    // point), so this cannot be left undefined.
    safetyVerdict: {
      cleared: true,
      concern: null,
      source: 'llm',
      provider: 'openai',
    } as const,
    accountId: 'acct-1',
    preLlmSubscriptionTier: 'autopilot' as const,
    logger: { log: () => {}, warn: () => {} },
    ...overrides,
  };
}

function sqlText(call: unknown[]): string {
  return (call[0] as TemplateStringsArray).join('?').replace(/\s+/g, ' ');
}

function txTexts(): string[] {
  return mockTx.mock.calls.map(sqlText);
}

function txArgs(): unknown[] {
  return mockTx.mock.calls.flat();
}

function assertManualNotificationFallback(options: { structural?: boolean } = {}) {
  // Find the responses INSERT by text — structural non-candidates skip the
  // businesses lock, so its position differs between the two lanes.
  const responsesInsert = txTexts().find((text) => text.includes('INSERT INTO responses'));
  expect(responsesInsert).toBeDefined();
  expect(responsesInsert).toContain('approval_method');
  if (options.structural) {
    // Structural short-circuit (findings 5/10): no businesses FOR UPDATE, no
    // policy read (074 columns), no daily-cap count, no runtime-state re-read.
    expect(txTexts().some((text) => text.includes('FROM businesses') && text.includes('FOR UPDATE'))).toBe(false);
    expect(txTexts().some((text) => text.includes('auto_approval_policies'))).toBe(false);
    expect(txTexts().some((text) => text.includes('FROM approval_audit_log'))).toBe(false);
    expect(txTexts().some((text) => text.includes('FROM reviews r') && text.includes('JOIN accounts a'))).toBe(false);
  }
  expect(txArgs()).toContain(QUEUE_NAMES.SEND_NOTIFICATION);
  expect(txArgs()).not.toContain(QUEUE_NAMES.PUBLISH_RESPONSE);
  // The auto-policy audit INSERT must never run on a fallback path. (The bare
  // 'auto_approved_by_policy' bind is NOT asserted absent anymore: the daily-
  // cap COUNT on approval_audit_log binds it on every path as its action
  // filter — same evolution as the 'auto_policy' bind note below.)
  expect(txTexts().some((text) => text.includes('INSERT INTO approval_audit_log'))).toBe(false);
  // The approve UPDATE must never run on a fallback path. (The bare
  // 'auto_policy' bind is NOT asserted absent anymore: the pre-fix WS4
  // daily-cap COUNT bound it as its approval_method filter.)
  expect(txTexts().some((text) => text.includes('UPDATE responses') && text.includes('approved_text'))).toBe(false);
  // WS4: no veto-window deadline stamp and no pending-post notice off the
  // auto-approve path.
  expect(txTexts().some((text) => text.includes('auto_post_scheduled_at'))).toBe(false);
  expect(txArgs()).not.toContain(QUEUE_NAMES.PENDING_POST_NOTICE);
  expect(sendNotificationPayloads()).toHaveLength(1);
}

type PersistInputOverrides = Partial<Parameters<typeof persistResponseAndNotify>[1]>;

interface ManualFallbackScenario {
  input?: PersistInputOverrides;
  state?: Record<string, unknown>;
  policies?: Record<string, unknown>[];
  connection?: Record<string, unknown> | null;
  autoApprovedToday?: number;
  structural?: boolean;
  env?: {
    OPENAI_MODERATION_ENABLED?: string;
  };
}

const manualFallbackCases: Array<[string, ManualFallbackScenario]> = [
  ['bad lane', { input: { originLane: 'regenerate' }, structural: true }],
  ['version > 1', { input: { version: 2 }, structural: true }],
  ['hash mismatch', { state: { review_content_hash: 'hash-2' } }],
  ['null loaded hash', { input: { loadedReviewContentHash: null } }],
  ['null current hash', { state: { review_content_hash: null } }],
  ['below threshold', { state: { star_rating: 3 } }],
  ['no policy', { policies: [] }],
  ['disabled policy', { policies: [disabledPolicy()] }],
  ['provider disabled', { env: { OPENAI_MODERATION_ENABLED: 'false' } }],
  ['provider error', { input: { moderation: { ...CLEAN_MODERATION, providerStatus: 'error' } } }],
  ['provider flagged low/medium local flag', {
    input: {
      moderation: {
        ...CLEAN_MODERATION,
        flagged: true,
        severity: 'medium',
        source: 'local_regex',
        reason: 'contains_contact',
      },
    },
  }],
  ['publisher subscription denied', { state: { subscription_status: 'pending_payment' } }],
  ['Copilot tier', { state: { subscription_tier: 'copilot' } }],
  ['missing active connection', { connection: null }],
  ['archived location', { state: { archived_at: new Date('2026-06-04T00:00:00.000Z') } }],
  ['triage high severity', { state: { triage_severity: 'high', triage_source: 'llm_triage_v1' } }],
  ['triage fallback source', { state: { triage_severity: 'low', triage_source: 'fallback_high_v1' } }],
  // WS4 gates (spec §2.2–§2.4), threaded from the loader through the evaluator.
  ['positive-quadrant hard floor (3-star)', { state: { star_rating: 3 } }],
  ['daily cap exhausted (default cap 10)', { autoApprovedToday: 10 }],
  ['daily cap exhausted (policy cap 2)', { policies: [enabledPolicy({ daily_auto_post_cap: 2 })], autoApprovedToday: 2 }],
  ['suspended policy', { policies: [enabledPolicy({ suspended_at: new Date('2026-07-07T00:00:00.000Z') })] }],
];

describe('persistResponseAndNotify auto approval runtime branch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    txQueue.length = 0;
    process.env.AUTO_APPROVAL_ENABLED = 'true';
    process.env.OPENAI_MODERATION_ENABLED = 'true';
  });

  afterEach(() => {
    delete process.env.AUTO_APPROVAL_ENABLED;
    delete process.env.OPENAI_MODERATION_ENABLED;
  });

  it('auto-approves eligible live-ingest-new drafts and enqueues publish without notifying owner', async () => {
    queuePersistRows({ autoApprove: true });

    const outcome = await persistResponseAndNotify(mockSql, baseInput());

    if (outcome.kind !== 'persisted') throw new Error('expected persisted');
    const responseId = outcome.responseId;
    expect(responseId).toBe('deterministic-uuid-v7');
    const texts = txTexts();
    expect(texts[3]).toContain('approval_method');
    expect(texts.some((text) => text.includes('UPDATE responses') && text.includes('approved_text'))).toBe(true);
    expect(txArgs()).toContain('auto_policy');
    expect(txArgs()).toContain('auto_approved_by_policy');
    expect(txArgs()).toContain(QUEUE_NAMES.PUBLISH_RESPONSE);
    expect(txArgs()).not.toContain(QUEUE_NAMES.SEND_NOTIFICATION);
    expect(
      txArgs().some(
        (arg) =>
          !!arg
          && typeof arg === 'object'
          && !Array.isArray(arg)
          && (arg as Record<string, unknown>).response_id === responseId
          && (arg as Record<string, unknown>).business_id === 'biz-1'
          && (arg as Record<string, unknown>).correlation_id === 'corr-1',
      ),
    ).toBe(true);
  });

  it('uses the locked post-LLM tier: Autopilot hint changed to Copilot falls back', async () => {
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    queuePersistRows({ state: { subscription_tier: 'copilot' } });

    await persistResponseAndNotify(mockSql, baseInput({
      preLlmSubscriptionTier: 'autopilot',
      logger,
    }));

    assertManualNotificationFallback();
    expect(logger.log).toHaveBeenCalledWith(
      'Subscription tier changed during response generation',
      expect.objectContaining({
        pre_llm_subscription_tier: 'autopilot',
        current_subscription_tier: 'copilot',
      }),
    );
  });

  it('uses the locked post-LLM tier: Copilot hint changed to Autopilot may grant', async () => {
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    queuePersistRows({ autoApprove: true });

    await persistResponseAndNotify(mockSql, baseInput({
      preLlmSubscriptionTier: 'copilot',
      logger,
    }));

    expect(txArgs()).toContain('auto_policy');
    expect(txArgs()).toContain(QUEUE_NAMES.PUBLISH_RESPONSE);
    expect(logger.log).toHaveBeenCalledWith(
      'Subscription tier changed during response generation',
      expect.objectContaining({
        pre_llm_subscription_tier: 'copilot',
        current_subscription_tier: 'autopilot',
      }),
    );
  });

  it('stamps the veto deadline via make_interval and delays the publish to the identical RETURNING\'d instant', async () => {
    queuePersistRows({ autoApprove: true });

    await persistResponseAndNotify(mockSql, baseInput());

    const approveCall = mockTx.mock.calls.find(
      (call: unknown[]) => sqlText(call).includes('UPDATE responses') && sqlText(call).includes('approved_text'),
    );
    expect(approveCall).toBeDefined();
    const approveText = sqlText(approveCall!);
    expect(approveText).toContain('auto_post_scheduled_at = NOW() + make_interval(mins => ?)');
    expect(approveText).toContain('RETURNING auto_post_scheduled_at');
    // enabledPolicy() default dial: veto_window_minutes 15.
    expect(approveCall!.slice(1)).toContain(15);

    // The publish outbox INSERT must bind the very Date object RETURNING'd by
    // the approve UPDATE (identity, not equality): the delay instant is
    // DB-clock-derived, never recomputed from Date.now().
    const publishCall = mockTx.mock.calls.find(
      (call: unknown[]) => call.slice(1).includes(QUEUE_NAMES.PUBLISH_RESPONSE),
    );
    expect(publishCall).toBeDefined();
    expect(publishCall!.slice(1).some((arg: unknown) => arg === SCHEDULED_AT)).toBe(true);
  });

  it('binds a 30-minute veto window when the policy dial says 30', async () => {
    queuePersistRows({
      autoApprove: true,
      policies: [enabledPolicy({ veto_window_minutes: 30 })],
    });

    await persistResponseAndNotify(mockSql, baseInput());

    const approveCall = mockTx.mock.calls.find(
      (call: unknown[]) => sqlText(call).includes('make_interval'),
    );
    expect(approveCall).toBeDefined();
    expect(approveCall!.slice(1)).toContain(30);
  });

  it('enqueues the pending-post notice with an ids-only payload in the same tx', async () => {
    queuePersistRows({ autoApprove: true });

    await persistResponseAndNotify(mockSql, baseInput());

    const noticeCall = mockTx.mock.calls.find(
      (call: unknown[]) => call.slice(1).includes(QUEUE_NAMES.PENDING_POST_NOTICE),
    );
    expect(noticeCall).toBeDefined();
    const payload = noticeCall!.slice(1).find(
      (arg: unknown): arg is Record<string, unknown> =>
        !!arg && typeof arg === 'object' && !Array.isArray(arg) && !(arg instanceof Date),
    );
    // ids-only: the deadline is NEVER duplicated into a payload — its single
    // source of truth is responses.auto_post_scheduled_at.
    expect(payload).toEqual({
      response_id: 'deterministic-uuid-v7',
      business_id: 'biz-1',
      correlation_id: 'corr-1',
    });
    expect(noticeCall!.slice(1).some((arg: unknown) => arg instanceof Date)).toBe(false);
  });

  it('records veto_window_minutes and the WS4 dial facts in the auto-policy audit metadata', async () => {
    // insertAuditLogAutoPolicy runs for real against the mocked tx (tx.json is
    // an identity pass-through), so a compaction-allowlist miss fails here.
    queuePersistRows({ autoApprove: true });

    await persistResponseAndNotify(mockSql, baseInput());

    const auditCall = mockTx.mock.calls.find(
      (call: unknown[]) => sqlText(call).includes('INSERT INTO approval_audit_log'),
    );
    expect(auditCall).toBeDefined();
    const metadata = auditCall!.slice(1).find(
      (arg: unknown): arg is Record<string, unknown> =>
        !!arg && typeof arg === 'object' && !Array.isArray(arg) && 'policy_id' in arg,
    );
    expect(metadata).toBeDefined();
    expect(metadata!.veto_window_minutes).toBe(15);
    // WS4 decision facts must SURVIVE the deny-by-default compaction allowlist
    // (AUTO_POLICY_METADATA_KEYS) — before the allowlist widened, daily_cap /
    // auto_approved_today / policy_suspended were silently dropped here.
    expect(metadata!.daily_cap).toBe(10);
    expect(metadata!.auto_approved_today).toBe(0);
    expect(metadata!.policy_suspended).toBe(false);
  });

  it('throws auto_approve_transition_lost when the guarded approve UPDATE matches zero rows', async () => {
    // The guarded UPDATE lost its race (status moved off pending_approval
    // concurrently) — the tx must roll back; generation-job retry semantics
    // cover recovery.
    queuePersistRows({ autoApprove: true, approveUpdateRows: [] });

    await expect(persistResponseAndNotify(mockSql, baseInput()))
      .rejects.toThrow('auto_approve_transition_lost');
  });

  it('warns but proceeds when the review lock matches zero rows (orphan response)', async () => {
    // Same posture as mark-posted.ts: the lock SELECT no-oping is a caller
    // bug / corrupt state — surface loudly, keep control flow unchanged.
    process.env.AUTO_APPROVAL_ENABLED = 'false';
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    queuePersistRows({ reviewLockRows: [], structural: true });

    await persistResponseAndNotify(mockSql, baseInput({ logger } as never));

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]![0]).toContain('review lock no-oped');
    assertManualNotificationFallback({ structural: true });
  });

  it('falls back to pending approval and notification when the runtime flag is disabled', async () => {
    process.env.AUTO_APPROVAL_ENABLED = 'false';
    queuePersistRows({ structural: true });

    await persistResponseAndNotify(mockSql, baseInput());

    assertManualNotificationFallback({ structural: true });
  });

  it('logs low-cardinality block reasons when an auto-eligible draft falls back', async () => {
    process.env.OPENAI_MODERATION_ENABLED = 'false';
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    queuePersistRows();

    await persistResponseAndNotify(mockSql, baseInput({ logger } as never));

    expect(logger.log).toHaveBeenCalledWith(
      'Auto-approval fallback to owner review',
      expect.objectContaining({
        response_id: 'deterministic-uuid-v7',
        review_id: 'rev-1',
        business_id: 'biz-1',
        origin_lane: 'live_ingest_new',
        response_version: 1,
        block_reasons: expect.arrayContaining(['provider_moderation_disabled']),
        runtime_enabled: true,
        provider_moderation_enabled: false,
        policy_source: 'account_default',
        resolved_min_star: 4,
        triage_severity: null,
        triage_source: null,
        daily_cap: 10,
        auto_approved_today: 0,
        policy_suspended: false,
      }),
    );
    const logged = logger.log.mock.calls[0]![1] as Record<string, unknown>;
    expect(JSON.stringify(logged)).not.toContain('Thank you for the kind review');
    expect(JSON.stringify(logged)).not.toContain('hash-1');
  });

  it('does not log a fallback for non-candidate drafts even while the runtime flag is on', async () => {
    // A bad-lane draft was never an auto candidate; with AUTO_APPROVAL_ENABLED
    // on, the log must stay scoped to live-ingest/policy-relevant drafts (spec
    // §15) rather than firing on every generated draft.
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    queuePersistRows({ structural: true });

    // safetyVerdict null, because a structural non-candidate never reaches the
    // check — ResponseGeneratorWorker skips it with no LLM call. The fixture's
    // cleared default would be a state the worker cannot produce here.
    await persistResponseAndNotify(
      mockSql,
      baseInput({ originLane: 'regenerate', safetyVerdict: null, logger } as never),
    );

    expect(logger.log).not.toHaveBeenCalled();
    assertManualNotificationFallback({ structural: true });
  });

  it.each(manualFallbackCases)('persists manual notification fallback for %s', async (_label, scenario) => {
    if (scenario.env?.OPENAI_MODERATION_ENABLED) {
      process.env.OPENAI_MODERATION_ENABLED = scenario.env.OPENAI_MODERATION_ENABLED;
    }
    queuePersistRows({
      state: scenario.state,
      policies: scenario.policies,
      connection: scenario.connection,
      autoApprovedToday: scenario.autoApprovedToday,
      structural: scenario.structural,
    });

    await persistResponseAndNotify(mockSql, baseInput(scenario.input ?? {}));

    assertManualNotificationFallback({ structural: scenario.structural });
  });

  it('re-reads triage_severity and triage_source in the runtime-state SELECT (column-drift pin)', async () => {
    // Fail-open guard: if a refactor drops these columns from the projection,
    // every mocked test stays green while the veto silently never fires. Pin
    // the captured query text so the drift breaks here instead.
    queuePersistRows({ autoApprove: true });

    await persistResponseAndNotify(mockSql, baseInput());

    const runtimeStateSelect = txTexts().find(
      (text) => text.includes('FROM reviews r') && text.includes('JOIN accounts a'),
    );
    expect(runtimeStateSelect).toBeDefined();
    expect(runtimeStateSelect).toContain('triage_severity');
    expect(runtimeStateSelect).toContain('triage_source');
  });

  it('suppressed backfill fallback stays pending without owner notification or publish', async () => {
    queuePersistRows({ notify: false, structural: true });

    await persistResponseAndNotify(mockSql, baseInput({ suppressNotification: true }));

    // Structural short-circuit: suppressed drafts take no businesses lock and
    // read no 074 columns (findings 5/10).
    expect(txTexts().some((text) => text.includes('FROM businesses') && text.includes('FOR UPDATE'))).toBe(false);
    expect(txTexts().some((text) => text.includes('auto_approval_policies'))).toBe(false);
    expect(txArgs()).not.toContain(QUEUE_NAMES.SEND_NOTIFICATION);
    expect(txArgs()).not.toContain(QUEUE_NAMES.PUBLISH_RESPONSE);
    expect(txArgs()).not.toContain(QUEUE_NAMES.PENDING_POST_NOTICE);
    // Audit-INSERT absence, not the bare action bind — the daily-cap COUNT
    // now binds 'auto_approved_by_policy' on every path (see the fallback
    // helper's note).
    expect(txTexts().some((text) => text.includes('INSERT INTO approval_audit_log'))).toBe(false);
    expect(txTexts().some((text) => text.includes('auto_post_scheduled_at'))).toBe(false);
    expect(sendNotificationPayloads()).toHaveLength(0);
  });

  it('held high-severity moderation fallback writes a hold and skips owner notification', async () => {
    queuePersistRows({ flaggedHigh: true, notify: false });

    await persistResponseAndNotify(mockSql, baseInput({
      moderation: {
        ...CLEAN_MODERATION,
        flagged: true,
        severity: 'high',
        source: 'local_regex',
        reason: 'refund_discount',
      },
    }));

    expect(txArgs()).toContain('local_regex');
    expect(txArgs()).toContain('open');
    expect(txArgs()).not.toContain(QUEUE_NAMES.SEND_NOTIFICATION);
    expect(txArgs()).not.toContain(QUEUE_NAMES.PUBLISH_RESPONSE);
    expect(txArgs()).not.toContain(QUEUE_NAMES.PENDING_POST_NOTICE);
    expect(txTexts().some((text) => text.includes('auto_post_scheduled_at'))).toBe(false);
    expect(sendNotificationPayloads()).toHaveLength(0);
  });
});

describe('persistResponseAndNotify run-spine instrumentation', () => {
  // account_id deliberately differs from the job input's accountId ('acct-1')
  // so the outcome assertion pins that attribution comes from the run row.
  const ACTIVE_RUN = { id: 'run-1', account_id: 'run-acct-1' };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(findActiveReviewRun).mockReset();
    vi.mocked(recordStep).mockReset();
    vi.mocked(recordOutcome).mockReset();
    txQueue.length = 0;
    process.env.AUTO_APPROVAL_ENABLED = 'false';
    process.env.OPENAI_MODERATION_ENABLED = 'true';
  });

  afterEach(() => {
    delete process.env.AUTO_APPROVAL_ENABLED;
    delete process.env.OPENAI_MODERATION_ENABLED;
  });

  it('records draft_generated + moderation_checked steps and a reply_drafted outcome in the persist tx', async () => {
    vi.mocked(findActiveReviewRun).mockResolvedValue(ACTIVE_RUN);
    queuePersistRows({ structural: true }); // flag off → structural short-circuit

    await persistResponseAndNotify(mockSql, baseInput());

    expect(findActiveReviewRun).toHaveBeenCalledWith(mockTx, 'rev-1');
    expect(recordStep).toHaveBeenCalledWith(mockTx, expect.objectContaining({
      runId: 'run-1',
      stepKey: 'draft_generated',
      detail: { response_id: 'deterministic-uuid-v7', version: 1 },
    }));
    expect(recordStep).toHaveBeenCalledWith(mockTx, expect.objectContaining({
      runId: 'run-1',
      stepKey: 'moderation_checked',
      status: 'completed',
      detail: { flagged: false, severity: 'low', held: false },
    }));
    expect(recordOutcome).toHaveBeenCalledWith(mockTx, {
      runId: 'run-1',
      accountId: 'run-acct-1', // from the run row, NOT the job input's 'acct-1'
      businessId: 'biz-1',
      attributedAgent: 'reply',
      outcomeKind: 'reply_drafted',
    });
  });

  it('locks the review row FOR UPDATE as the FIRST tx statement, before the responses INSERT and spine writes (candidate lane)', async () => {
    // Candidate lane (flag ON, live_ingest_new, v1, not suppressed): the
    // businesses lock pin below only exists for candidates — structural
    // non-candidates skip it entirely (see the companion test).
    process.env.AUTO_APPROVAL_ENABLED = 'true';
    vi.mocked(findActiveReviewRun).mockResolvedValue(ACTIVE_RUN);
    queuePersistRows({ autoApprove: true });

    await persistResponseAndNotify(mockSql, baseInput());

    const texts = txTexts();
    const lockIndex = texts.findIndex(
      (text) => text.includes('FROM reviews') && text.includes('FOR UPDATE'),
    );
    const businessLockIndex = texts.findIndex(
      (text) => text.includes('FROM businesses') && text.includes('FOR UPDATE'),
    );
    const insertIndex = texts.findIndex((text) => text.includes('INSERT INTO responses'));
    const entitlementLockIndex = texts.findIndex(
      (text) => text.includes('pg_advisory_xact_lock') && text.includes('hashtext'),
    );
    // First statement of the tx: the responses INSERT's FK takes an implicit
    // FOR KEY SHARE on the reviews tuple, so a later FOR UPDATE would be a
    // deadlock-prone lock upgrade. Statement #2 is the businesses FOR UPDATE
    // for exactly the same reason (the INSERT's business_id FK) — taking it
    // only inside the loader (after the INSERT) reproduces a 40P01 against a
    // concurrent persist for the same business.
    expect(lockIndex).toBe(0);
    expect(businessLockIndex).toBe(1);
    expect(entitlementLockIndex).toBe(2);
    expect(insertIndex).toBeGreaterThan(entitlementLockIndex);

    // And the lock precedes the first spine write (cross-mock global order).
    const lockInvocation = mockTx.mock.invocationCallOrder[lockIndex]!;
    const firstSpineWriteInvocation = vi.mocked(recordStep).mock.invocationCallOrder[0]!;
    expect(lockInvocation).toBeLessThan(firstSpineWriteInvocation);
  });

  it('structural non-candidates (flag off) take NO businesses lock and read NO 074 columns', async () => {
    // Finding 10: without the later cap-count FOR UPDATE, the FK
    // share→exclusive upgrade hazard doesn't exist for non-candidates, so the
    // pre-emptive businesses lock is pure contention — skipped. Finding 5: a
    // flag-off deploy must not read migration-074 columns
    // (auto_approval_policies / runtime-state projection).
    vi.mocked(findActiveReviewRun).mockResolvedValue(ACTIVE_RUN);
    queuePersistRows({ structural: true });

    await persistResponseAndNotify(mockSql, baseInput());

    const texts = txTexts();
    expect(texts.findIndex((text) => text.includes('FROM reviews') && text.includes('FOR UPDATE'))).toBe(0);
    expect(texts.some((text) => text.includes('FROM businesses') && text.includes('FOR UPDATE'))).toBe(false);
    expect(texts.some((text) => text.includes('auto_approval_policies'))).toBe(false);
    expect(texts.some((text) => text.includes('FROM approval_audit_log'))).toBe(false);
    expect(texts.some((text) => text.includes('FROM reviews r') && text.includes('JOIN accounts a'))).toBe(false);
    // The draft still lands on the owner path.
    expect(txArgs()).toContain(QUEUE_NAMES.SEND_NOTIFICATION);
  });

  it('records a policy_gate step with the auto-approval decision on the auto-approved path', async () => {
    process.env.AUTO_APPROVAL_ENABLED = 'true';
    vi.mocked(findActiveReviewRun).mockResolvedValue(ACTIVE_RUN);
    queuePersistRows({ autoApprove: true });

    await persistResponseAndNotify(mockSql, baseInput());

    expect(recordStep).toHaveBeenCalledWith(mockTx, expect.objectContaining({
      runId: 'run-1',
      stepKey: 'policy_gate',
      detail: { decision: 'auto_approved' },
    }));
  });

  it('records a held_for_owner policy_gate step on the normal owner-review path', async () => {
    vi.mocked(findActiveReviewRun).mockResolvedValue(ACTIVE_RUN);
    queuePersistRows({ structural: true }); // flag off → structural short-circuit

    await persistResponseAndNotify(mockSql, baseInput());

    expect(recordStep).toHaveBeenCalledWith(mockTx, expect.objectContaining({
      runId: 'run-1',
      stepKey: 'policy_gate',
      detail: { decision: 'held_for_owner' },
    }));
    expect(txArgs()).toContain(QUEUE_NAMES.SEND_NOTIFICATION);
  });

  it('records moderation_checked as failed with held detail and NO policy_gate on the held path', async () => {
    vi.mocked(findActiveReviewRun).mockResolvedValue(ACTIVE_RUN);
    queuePersistRows({ flaggedHigh: true, notify: false, structural: true }); // flag off

    await persistResponseAndNotify(mockSql, baseInput({
      moderation: {
        ...CLEAN_MODERATION,
        flagged: true,
        severity: 'high',
        source: 'local_regex',
        reason: 'refund_discount',
      },
    }));

    expect(recordStep).toHaveBeenCalledWith(mockTx, expect.objectContaining({
      stepKey: 'moderation_checked',
      status: 'failed',
      detail: { flagged: true, severity: 'high', held: true },
    }));
    const policyGateCalls = vi.mocked(recordStep).mock.calls
      .filter(([, stepInput]) => stepInput.stepKey === 'policy_gate');
    expect(policyGateCalls).toHaveLength(0);
    // The draft still exists (held for admin disposition) — it counts as drafted.
    expect(recordOutcome).toHaveBeenCalledWith(mockTx, expect.objectContaining({
      outcomeKind: 'reply_drafted',
    }));
  });

  it('skips spine writes when no running review_handler run exists (legacy rows)', async () => {
    vi.mocked(findActiveReviewRun).mockResolvedValue(null);
    queuePersistRows({ structural: true }); // flag off → structural short-circuit

    const outcome = await persistResponseAndNotify(mockSql, baseInput());

    expect(outcome).toEqual({ kind: 'persisted', responseId: 'deterministic-uuid-v7' });
    expect(recordStep).not.toHaveBeenCalled();
    expect(recordOutcome).not.toHaveBeenCalled();
    expect(txArgs()).toContain(QUEUE_NAMES.SEND_NOTIFICATION);
  });
});

describe('content-freshness gate (ADR 0017)', () => {
  // Block fixture built on the file's baseInput (the name is taken at module
  // scope by the live_ingest_new-defaulting helper): default non-auto lane
  // ON_DEMAND_GENERATE — with no AUTO_APPROVAL env set the persist is a
  // structural non-candidate, so the review-lock SELECT is the tx's ONLY
  // preamble statement and the zero-writes assertions count statements without
  // candidate-lane noise. reviewId matches the queued lock row's 'review-1'.
  function gateInput(overrides: PersistInputOverrides = {}) {
    return baseInput({
      reviewId: 'review-1',
      originLane: GENERATE_RESPONSE_ORIGIN_LANE.ON_DEMAND_GENERATE,
      ...overrides,
    });
  }

  beforeEach(() => {
    // Round-2 finding #4: without these resets the zero-writes count
    // assertion inherits calls from earlier tests in the file.
    vi.clearAllMocks();
    txQueue.length = 0;
  });

  it('skips persist and returns skipped_stale_content when loaded and current hashes are both non-null and differ', async () => {
    txQueue.push([{ id: 'review-1', review_content_hash: 'hash-current' }]);
    const outcome = await persistResponseAndNotify(mockSql, gateInput({ loadedReviewContentHash: 'hash-loaded' }));
    expect(outcome).toEqual({ kind: 'skipped_stale_content' });
  });

  it('gate skip performs no writes: no responses INSERT, no api_costs link, no spine steps, no notification enqueue', async () => {
    txQueue.push([{ id: 'review-1', review_content_hash: 'hash-current' }]);
    await persistResponseAndNotify(mockSql, gateInput({ loadedReviewContentHash: 'hash-loaded', retryCostId: 'retry-cost-1' }));
    // The review-lock SELECT must be the ONLY tx statement, and nothing may
    // run on the top-level sql handle either (codex finding: a pre-gate
    // sql`UPDATE api_costs` outside the tx would evade a tx-only assertion).
    expect(mockTx).toHaveBeenCalledTimes(1);
    expect(mockSql).not.toHaveBeenCalled(); // sql.begin is a property call, not a tagged-template call
    expect(findActiveReviewRun).not.toHaveBeenCalled();
    expect(recordStep).not.toHaveBeenCalled();
    expect(recordOutcome).not.toHaveBeenCalled();
  });

  it('content-freshness gate skips every generate-response origin lane before lane-specific work', async () => {
    // A gate conditional on one lane would pass every other test in this file.
    // Round-2 finding #3 / round-3 nit: enable the flag CONCRETELY, the way
    // this file's candidate tests do, so live_ingest_new v1 is a TRUE
    // candidate and its 3-statement lock preamble executes (reviews FOR UPDATE
    // → businesses FOR UPDATE → entitlement advisory lock). "Lane-specific
    // work" the gate must precede is the runtime-state read / responses INSERT
    // / notification enqueue — NOT the deadlock-avoidance lock preamble, which
    // by the WS8 lock-order law must stay first and is write-free (harmless on
    // skip).
    process.env.AUTO_APPROVAL_ENABLED = 'true';
    try {
      for (const lane of GENERATE_RESPONSE_ORIGIN_LANES) {
        vi.clearAllMocks();
        txQueue.length = 0;
        const isCandidateLane = lane === GENERATE_RESPONSE_ORIGIN_LANE.LIVE_INGEST_NEW;
        txQueue.push([{ id: 'review-1', review_content_hash: 'hash-current' }]);
        if (isCandidateLane) {
          txQueue.push([{ id: 'biz-1' }]); // businesses FOR UPDATE
          txQueue.push([]);                // acquireTierEntitlementLock advisory-lock statement
        }
        const outcome = await persistResponseAndNotify(mockSql, gateInput({
          loadedReviewContentHash: 'hash-loaded',
          originLane: lane,
          version: isCandidateLane ? 1 : 2,
        }));
        expect(outcome, `lane ${lane}`).toEqual({ kind: 'skipped_stale_content' });
        // Preamble statements only — nothing after the gate ran on any lane.
        expect(mockTx, `lane ${lane}`).toHaveBeenCalledTimes(isCandidateLane ? 3 : 1);
        expect(txQueue, `lane ${lane}`).toHaveLength(0);
        expect(findActiveReviewRun, `lane ${lane}`).not.toHaveBeenCalled();
      }
    } finally {
      delete process.env.AUTO_APPROVAL_ENABLED;
    }
  });

  it('gate skip logs stale_review_content with review_id, business_id, version, and origin_lane without raw hashes', async () => {
    txQueue.push([{ id: 'review-1', review_content_hash: 'hash-current' }]);
    const log = vi.fn();
    await persistResponseAndNotify(mockSql, gateInput({ loadedReviewContentHash: 'hash-loaded', logger: { log, warn: vi.fn() } }));
    expect(log).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      reason: OUTBOX_COMPLETION_REASON.STALE_REVIEW_CONTENT,
      review_id: 'review-1',
      business_id: expect.any(String),
      version: expect.any(Number),
      origin_lane: expect.any(String),
    }));
    const [, fields] = log.mock.calls[0]!;
    expect(JSON.stringify(fields)).not.toContain('hash-loaded');
    expect(JSON.stringify(fields)).not.toContain('hash-current');
  });

  it('persists when loaded hash is null (legacy pre-hash review passes the gate)', async () => {
    queuePersistRows({
      structural: true,
      reviewLockRows: [{ id: 'review-1', review_content_hash: 'hash-current' }],
    });
    const outcome = await persistResponseAndNotify(mockSql, gateInput({ loadedReviewContentHash: null }));
    expect(outcome).toEqual({ kind: 'persisted', responseId: 'deterministic-uuid-v7' });
    expect(txTexts().some((text) => text.includes('INSERT INTO responses'))).toBe(true);
  });

  it('persists when current hash is null', async () => {
    queuePersistRows({
      structural: true,
      reviewLockRows: [{ id: 'review-1', review_content_hash: null }],
    });
    const outcome = await persistResponseAndNotify(mockSql, gateInput({ loadedReviewContentHash: 'hash-loaded' }));
    expect(outcome).toEqual({ kind: 'persisted', responseId: 'deterministic-uuid-v7' });
    expect(txTexts().some((text) => text.includes('INSERT INTO responses'))).toBe(true);
  });

  it('persists when hashes match', async () => {
    queuePersistRows({
      structural: true,
      reviewLockRows: [{ id: 'review-1', review_content_hash: 'hash-1' }],
    });
    const outcome = await persistResponseAndNotify(mockSql, gateInput({ loadedReviewContentHash: 'hash-1' }));
    expect(outcome).toEqual({ kind: 'persisted', responseId: 'deterministic-uuid-v7' });
    expect(txTexts().some((text) => text.includes('INSERT INTO responses'))).toBe(true);
  });

  it('content-freshness gate skips iff both hashes are non-null and differ', () => {
    // fast-check house style: src/lib/reviews/__tests__/sentiment.test.ts "invariants" block
    fc.assert(fc.property(
      fc.option(fc.string(), { nil: null }),
      fc.option(fc.string(), { nil: null }),
      (loaded, current) => {
        expect(hasStaleReviewContent(loaded, current))
          .toBe(loaded !== null && current !== null && loaded !== current);
      },
    ));
  });
});

// ---------------------------------------------------------------------------
// #1079 — the kill switch decides whether the VOCABULARY runs at all.
//
// House style: `policy-gate-precedence.property.test.ts`'s `invariants` describe
// block, with the `invariants: ` prefix INSIDE the `it()` string so the gate's
// `promised-tests` exact match still works.
//
// It lives here, and not in a new property file, because this file already owns
// the stub-transaction harness (`mockSql`/`mockTx`/`txQueue`) and already
// imports fast-check. A second file would be a second owner of the persist
// fixture.
// ---------------------------------------------------------------------------

/** Every member of the gate's block vocabulary — 22 today, `null`-mapped included. */
const ALL_BLOCK_REASONS = Object.keys(POLICY_GATE_HELD_REFUSAL_CATEGORIES);

describe('invariants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    txQueue.length = 0;
    process.env.AUTO_APPROVAL_ENABLED = 'true';
    process.env.OPENAI_MODERATION_ENABLED = 'true';
    // RESET ON BOTH SIDES, deliberately. `gateOverride` is MODULE scope and this
    // block is declared LAST in the file, so an `afterEach`-only reset made the
    // ~51 cases ABOVE depend on this describe having already run — order
    // coupling that vitest's file order happens to satisfy and `--shard`,
    // `.only` or a re-order would not. The `afterEach` copy stays: it is what
    // protects a case in ANOTHER file's run from this block's last property.
    gateOverride.blockReasons = null;
  });

  afterEach(() => {
    delete process.env.AUTO_APPROVAL_ENABLED;
    delete process.env.OPENAI_MODERATION_ENABLED;
    delete process.env[REFUSAL_LEDGER_FLAG];
    gateOverride.blockReasons = null;
  });

  it('invariants: the flag decides the resolver call count — off yields zero calls, on yields exactly one receiving the generated block reasons verbatim and in order', async () => {
    // A BICONDITIONAL, and that is what makes it depend on the generated input.
    // The one-sided form ("off ⇒ zero calls") is a tautology here: with the flag
    // off the guard returns WITHOUT inspecting `blockReasons`, so no generator
    // over the 2^22 subsets can make the implementation branch. The ON arm is
    // what carries the mutation-killing power — it kills the `try/catch` swallow
    // AND the shape that inlines the precedence tuple into `persist.ts` and
    // never calls the vocabulary at all.
    //
    // NOT a transaction-query count. The persist issues the lock preamble, the
    // responses INSERT, the api_costs updates, the runtime-state reads and the
    // spine checkpoints long before the ledger, so "zero queries" is false by
    // construction and would fail on a correct implementation.
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.constantFrom(...ALL_BLOCK_REASONS), { minLength: 1 }),
        fc.boolean(),
        async (blockReasons, ledgerEnabled) => {
          mockTx.mockClear();
          mockSql.begin.mockClear();
          resolvePolicyGateRefusalSpy.mockClear();
          txQueue.length = 0;
          queuePersistRows();

          // The gate's verdict is DICTATED so the generated array survives to
          // the lane; every other field of the decision stays the real one.
          gateOverride.blockReasons = blockReasons;
          if (ledgerEnabled) delete process.env[REFUSAL_LEDGER_FLAG];
          else process.env[REFUSAL_LEDGER_FLAG] = 'false';

          await persistResponseAndNotify(mockSql, baseInput());

          if (!ledgerEnabled) {
            expect(resolvePolicyGateRefusalSpy).not.toHaveBeenCalled();
            return;
          }

          // EXACTLY ONE — never zero (the inline reimplementation) and never
          // two (a guard that resolved to decide whether to resolve).
          expect(resolvePolicyGateRefusalSpy).toHaveBeenCalledTimes(1);
          // VERBATIM AND IN ORDER. `toEqual` on an array is order-sensitive, so
          // this also pins `vocabulary.ts`'s "the input VERBATIM, in its own
          // order" against a caller that sorted or de-duplicated on the way in.
          expect(resolvePolicyGateRefusalSpy.mock.calls[0]![0]).toEqual(blockReasons);
        },
      ),
      { numRuns: 60 },
    );
  });

  it('invariants: with the ledger off, the warning fires exactly when every block reason maps to a real category', async () => {
    // THE ORACLE FOR THE WHOLE FINDING. Containment (#1079) moved the switch in
    // front of the resolve; the review that accepted it proved the lane could
    // KEEP its ledger-dark warning anyway, because map membership is decidable
    // with `Object.hasOwn` and `Object.hasOwn` cannot throw.
    //
    // A BICONDITIONAL, AND BOTH DIRECTIONS BITE — unlike the property above,
    // whose OFF arm is a tautology. Here the flag is off for every run and the
    // generated set is the only thing that moves the expectation, so the
    // generator does real work in both arms.
    //
    // IT IS THE `every`-VS-`some` DISCRIMINATOR. `wouldRecordRefusal` must be
    // `every`: one `null`-mapped member vetoes the entire row (#1003), so a
    // `some` implementation warns about a decision that was never going to be
    // recorded — noise on the one signal that says the ledger is dark. Any
    // generated set MIXING a mapped member with a `null`-mapped one is a
    // counterexample to `some`, and `uniqueArray` over the full 22-member
    // vocabulary reaches those sets easily.
    //
    // AND THE RESOLVER MUST STILL NEVER RUN. The warning is not allowed to buy
    // itself back by resolving; that is the fault the switch exists to contain.
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.constantFrom(...ALL_BLOCK_REASONS), { minLength: 1 }),
        async (blockReasons) => {
          mockTx.mockClear();
          mockSql.begin.mockClear();
          resolvePolicyGateRefusalSpy.mockClear();
          noteRefusalLedgerDarkSpy.mockClear();
          txQueue.length = 0;
          queuePersistRows();

          gateOverride.blockReasons = blockReasons;
          process.env[REFUSAL_LEDGER_FLAG] = 'false';

          await persistResponseAndNotify(mockSql, baseInput());

          // The EXPECTATION, computed from the map rather than from the
          // implementation: a row would have been written iff every member is
          // mapped to a NON-null category. `minLength: 1` keeps the empty set
          // out of the generator, and NOTHING ELSE COVERS THE MECHANISM the
          // empty set would exercise: the approved-draft cases above prove the
          // BEHAVIOUR ("an approved draft warns nothing") but reach it at guard
          // 2, which returns before guard 4, so no case anywhere executes
          // `wouldRecordRefusal`'s `blockReasons.length > 0` conjunct. Red team
          // measured it — dropping the conjunct survives 99/99. Guard 2 is what
          // makes that conjunct defence in depth against a future guard reorder,
          // and it is tested by nothing.
          const everyMemberRecords = blockReasons.every(
            (code) =>
              Object.hasOwn(POLICY_GATE_HELD_REFUSAL_CATEGORIES, code)
              && POLICY_GATE_HELD_REFUSAL_CATEGORIES[
                code as keyof typeof POLICY_GATE_HELD_REFUSAL_CATEGORIES
              ] !== null,
          );

          expect(noteRefusalLedgerDarkSpy).toHaveBeenCalledTimes(everyMemberRecords ? 1 : 0);
          // Containment is unchanged by the warning: the throwing resolver is
          // still never reached with the switch off.
          expect(resolvePolicyGateRefusalSpy).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 120 },
    );
  });

  // -------------------------------------------------------------------------
  // #1105 — the SECOND signal. An unmapped block reason with the switch off.
  //
  // THE HOLE THE PROPERTIES ABOVE CANNOT REACH. Both generate from
  // `ALL_BLOCK_REASONS`, which IS the compiled union, so every generated member
  // is mapped by construction and the unmapped arm is unreachable there. These
  // five cases inject a value that escaped the union — the only fault class that
  // can produce an unmapped code now that #1080's `_PrecedenceIsTotal` makes the
  // mapped-but-unranked case a `pnpm typecheck` failure.
  // -------------------------------------------------------------------------

  /** A member the map holds with a real category — read off the map, never typed out. */
  const mappedNonNullReason = (): string => {
    const found = ALL_BLOCK_REASONS.find(
      (code) =>
        POLICY_GATE_HELD_REFUSAL_CATEGORIES[
          code as keyof typeof POLICY_GATE_HELD_REFUSAL_CATEGORIES
        ] !== null,
    );
    if (found === undefined) throw new Error('the category map holds no non-null member');
    return found;
  };

  /** A member the map maps to `null` — the veto. One of these kills the whole row (#1003). */
  const vetoReason = (): string => {
    const found = ALL_BLOCK_REASONS.find(
      (code) =>
        POLICY_GATE_HELD_REFUSAL_CATEGORIES[
          code as keyof typeof POLICY_GATE_HELD_REFUSAL_CATEGORIES
        ] === null,
    );
    if (found === undefined) throw new Error('the category map holds no null-mapped member');
    return found;
  };

  /** One held-draft persist through the lane, with the gate's verdict dictated. */
  async function persistWithBlockReasons(blockReasons: readonly string[]): Promise<void> {
    txQueue.length = 0;
    queuePersistRows();
    gateOverride.blockReasons = blockReasons;
    await persistResponseAndNotify(mockSql, baseInput());
  }

  it('invariants: with the ledger off, an unmapped block reason signals the vocabulary hole and raises no ledger-dark warning', async () => {
    process.env[REFUSAL_LEDGER_FLAG] = 'false';

    await persistWithBlockReasons(['ghost_reason']);

    // THE SIGNAL, receiving the FILTERED subset. The CALL SITE owns the
    // membership test (`unmappedBlockReasons`) and hands the helper only codes
    // the map does not hold; the helper is a pure transport and re-tests
    // nothing. A single all-unmapped fixture cannot tell filtered from
    // unfiltered — they are equal here — which is exactly what the mixed case
    // below has to carry.
    expect(noteUnmappedBlockReasonsSpy).toHaveBeenCalledTimes(1);
    expect(noteUnmappedBlockReasonsSpy.mock.calls[0]![0]).toEqual(['ghost_reason']);
    // AND NOT the ledger-dark line. An unmapped member would have THROWN rather
    // than written, so no Refusal row was lost and there is no ledger GAP to
    // claim — `writeRefusalEvents`' contract forbids warning there.
    expect(noteRefusalLedgerDarkSpy, 'no gap, so no ledger-dark line').not.toHaveBeenCalled();
    // Containment is untouched: the throwing resolver stays unreached.
    expect(resolvePolicyGateRefusalSpy).not.toHaveBeenCalled();
  });

  it('invariants: with the ledger off, a fully mapped held decision warns ledger-dark and signals no vocabulary hole', async () => {
    process.env[REFUSAL_LEDGER_FLAG] = 'false';

    await persistWithBlockReasons([mappedNonNullReason()]);

    expect(noteRefusalLedgerDarkSpy, 'a real gap warns').toHaveBeenCalledTimes(1);
    expect(noteUnmappedBlockReasonsSpy, 'and no vocabulary hole exists').not.toHaveBeenCalled();
    expect(resolvePolicyGateRefusalSpy).not.toHaveBeenCalled();
  });

  it('invariants: with the ledger off, a veto-only decision raises neither signal', async () => {
    process.env[REFUSAL_LEDGER_FLAG] = 'false';

    // A `null`-mapped member is MAPPED — so it is not a vocabulary hole — and it
    // vetoes the row — so it is not a ledger gap either. Silence is the correct
    // answer, and it is the answer both predicates must agree on.
    await persistWithBlockReasons([vetoReason()]);

    expect(noteRefusalLedgerDarkSpy).not.toHaveBeenCalled();
    expect(noteUnmappedBlockReasonsSpy).not.toHaveBeenCalled();
    expect(resolvePolicyGateRefusalSpy).not.toHaveBeenCalled();
  });

  it('invariants: with the ledger off, a mixed mapped and unmapped decision signals the vocabulary hole only', async () => {
    process.env[REFUSAL_LEDGER_FLAG] = 'false';

    // THE MUTUAL EXCLUSIVITY, and it is the reason guard 4's off-arm uses two
    // independent `if`s rather than an `if`/`else`. An unmapped member makes
    // `wouldRecordRefusal` false on its own, so the exclusivity is a property of
    // the predicates and not of the control flow. This case is what asserts it,
    // which is what lets the `else` stay deleted.
    //
    // IT IS ALSO THE ONLY DISCRIMINATING INPUT FOR THE FILTER, AND ASSERTING
    // THE CALL COUNT ALONE LEFT THAT UNTESTED — red team's round 1 P0. Passing
    // `autoDecision.blockReasons` verbatim instead of the filtered subset
    // survived 59/59 cases: every OTHER case here feeds an all-unmapped set,
    // where filtered and unfiltered are the same array. Only a fixture that
    // MIXES a mapped member with an unmapped one can tell them apart, and only
    // an assertion on the ARGUMENT can read the difference.
    //
    // The consequence of that regression is not cosmetic: the operator's Sentry
    // event and the log line would name a healthy, mapped code as a vocabulary
    // hole, and `write.ts`'s "already-unmapped codes" contract would be a
    // comment nothing enforced.
    const mapped = mappedNonNullReason();
    await persistWithBlockReasons([mapped, 'ghost_reason']);

    expect(noteUnmappedBlockReasonsSpy).toHaveBeenCalledTimes(1);
    const handed = noteUnmappedBlockReasonsSpy.mock.calls[0]![0];
    expect(handed, 'the mapped member is filtered OUT').toEqual(['ghost_reason']);
    expect(handed, 'and specifically does not carry the healthy code').not.toContain(mapped);
    expect(noteRefusalLedgerDarkSpy).not.toHaveBeenCalled();
    expect(resolvePolicyGateRefusalSpy).not.toHaveBeenCalled();
  });

  it('invariants: with the ledger off, an inherited object key is treated as an unmapped block reason', async () => {
    // `Object.hasOwn`, NOT `in`. `POLICY_GATE_HELD_REFUSAL_CATEGORIES` is an
    // ordinary object, so `'toString'` resolves through `Object.prototype` — an
    // `in` test, or a bare truthiness check on the lookup, calls it MAPPED and
    // stays silent on a genuine escapee. An ordinary unknown string cannot tell
    // those implementations from the correct one; this is the only case that
    // can, and it belongs here because `unmappedBlockReasons` lives here.
    process.env[REFUSAL_LEDGER_FLAG] = 'false';

    await persistWithBlockReasons(['toString']);

    expect(noteUnmappedBlockReasonsSpy, 'an inherited key is not a mapping').toHaveBeenCalledTimes(
      1,
    );
    expect(noteUnmappedBlockReasonsSpy.mock.calls[0]![0]).toEqual(['toString']);
    expect(resolvePolicyGateRefusalSpy).not.toHaveBeenCalled();
  });

  it('invariants: with the ledger on, an unmapped block reason invokes no vocabulary-hole signal', async () => {
    // THE ON ARM IS ALREADY COVERED, and this branch may not soften it. With the
    // switch on, `resolvePolicyGateRefusal` runs, throws
    // `unmapped_auto_approval_block_reason`, and `withLedgerAttribution` raises
    // the Sentry issue and RETHROWS — aborting the response persist. That is
    // #1079's contract. The new signal belongs to the off-arm only, and a
    // version of it that also fired here would double-report the same fault.
    delete process.env[REFUSAL_LEDGER_FLAG];

    await expect(persistWithBlockReasons(['ghost_reason'])).rejects.toThrow(
      /unmapped_auto_approval_block_reason/,
    );

    expect(resolvePolicyGateRefusalSpy, 'the resolver runs on the on-arm').toHaveBeenCalledTimes(1);
    expect(noteUnmappedBlockReasonsSpy, 'the off-arm signal stays off').not.toHaveBeenCalled();
    expect(noteRefusalLedgerDarkSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// LEDGER ATTRIBUTION — the lane keeps ONE wrapper, narrowed (#1083).
//
// WHAT MOVED AND WHAT STAYED. Attribution for a ledger WRITE fault belongs to
// `src/lib/refusals/write.ts`, which is the single owner of the statement, and
// `write.test.ts` owns those twelve cases. What cannot move is the VOCABULARY
// fault: `resolvePolicyGateRefusal` throws BEFORE the writer is ever reached, so
// exactly one call site still needs a wrapper — this one, for that one fault, on
// that one lane. The `held_draft` invocation wrapped a write and nothing else,
// so it goes; the writer covers it.
//
// THE COUNT IS THE PROPERTY, and it is what these four cases are for. Leaving
// the write inside the surviving wrapper doubles every `policy_gate_held` write
// fault, and the twelve writer cases all still pass while it does — the
// vocabulary case never reaches the writer, and a `held_draft`-only one-capture
// case says nothing about this lane (plan round 1, finding F1).
//
// SO EACH CASE READS THE `extra` PAYLOAD, not just the count. The two fault
// classes are distinguishable only there: the wrapper carries `response_id`, the
// writer carries the five closed fields. A single capture with the WRONG payload
// is the surviving-wrapper-around-the-write shape, and a count alone cannot see
// it.
// ---------------------------------------------------------------------------
describe('ledger attribution (#1083)', () => {
  /** The statement the writer owns — matched by text, on `sqlText`'s terms. */
  const LEDGER_INSERT = 'INSERT INTO refusal_events';

  /** `uuid`'s `v7` is mocked at the top of this file, so the response id is fixed. */
  const RESPONSE_ID = 'deterministic-uuid-v7';

  interface LedgerCapture {
    error: unknown;
    level?: string;
    tags?: Record<string, string>;
    extra?: Record<string, unknown>;
  }

  function ledgerCaptures(): LedgerCapture[] {
    return (captureExceptionSpy.mock.calls as unknown[][]).map((call) => {
      const options = (call[1] ?? {}) as Omit<LedgerCapture, 'error'>;
      return { error: call[0], ...options };
    });
  }

  /**
   * The hoisted `mockTx` body, re-installed.
   *
   * `vi.clearAllMocks()` clears call history and KEEPS implementations, so a
   * case that armed a fault would leak it into every case that ran after it.
   * Re-installing on both sides is what keeps this block independent of file
   * order — the same reason `gateOverride` is reset twice above.
   */
  function restoreTx(): void {
    mockTx.mockImplementation((_strings: TemplateStringsArray, ..._values: unknown[]) =>
      Promise.resolve(txQueue.shift() ?? []));
  }

  /** Make the ledger INSERT — and only it — reject, wherever it lands in the flow. */
  function failLedgerWrite(error: Error): void {
    mockTx.mockImplementation((strings: TemplateStringsArray, ..._values: unknown[]) => {
      if (strings.join('?').includes(LEDGER_INSERT)) return Promise.reject(error);
      return Promise.resolve(txQueue.shift() ?? []);
    });
  }

  /** A block reason the category map really holds and does not veto. */
  function mappedNonNullBlockReason(): string {
    const found = ALL_BLOCK_REASONS.find(
      (code) =>
        POLICY_GATE_HELD_REFUSAL_CATEGORIES[
          code as keyof typeof POLICY_GATE_HELD_REFUSAL_CATEGORIES
        ] !== null,
    );
    if (found === undefined) throw new Error('the category map holds no non-null member');
    return found;
  }

  /** The high-severity moderation verdict that HOLDS a draft and writes `held_draft`. */
  const HELD_MODERATION: ModerationDecision = {
    ...CLEAN_MODERATION,
    flagged: true,
    severity: 'high',
    source: 'local_regex',
    reason: 'refund_discount',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    txQueue.length = 0;
    restoreTx();
    process.env.AUTO_APPROVAL_ENABLED = 'true';
    process.env.OPENAI_MODERATION_ENABLED = 'true';
    delete process.env[REFUSAL_LEDGER_FLAG];
    gateOverride.blockReasons = null;
  });

  afterEach(() => {
    restoreTx();
    delete process.env.AUTO_APPROVAL_ENABLED;
    delete process.env.OPENAI_MODERATION_ENABLED;
    delete process.env[REFUSAL_LEDGER_FLAG];
    gateOverride.blockReasons = null;
  });

  it('attributes a policy gate vocabulary fault without also attributing a write fault', async () => {
    // The fault class that keeps a wrapper: an unmapped block reason throws out
    // of `resolvePolicyGateRefusal`, which runs BEFORE the writer is reached. It
    // is not a CHECK violation and not a writer bug, and the writer can never
    // see it — so the narrowed wrapper is its only reporter.
    queuePersistRows();
    gateOverride.blockReasons = ['ghost_reason'];

    await expect(persistResponseAndNotify(mockSql, baseInput())).rejects.toThrow(
      /unmapped_auto_approval_block_reason/,
    );

    expect(captureExceptionSpy, 'ONE fault, ONE event').toHaveBeenCalledTimes(1);
    const [capture] = ledgerCaptures();
    expect(capture?.level).toBe('error');
    expect(capture?.tags).toEqual({
      subsystem: 'refusal_ledger',
      refusal_lane: 'policy_gate_held',
      fault: 'ledger_vocabulary',
      flag: REFUSAL_LEDGER_FLAG,
    });
    // THE WRAPPER'S PAYLOAD, not the writer's. This is what makes the two fault
    // classes tellable apart in Sentry, and it is the assertion that fails if
    // the write is left inside the wrapper and reports as a vocabulary fault.
    expect(capture?.extra).toEqual({ response_id: RESPONSE_ID });
    // …and the writer really was never reached, so there is no write fault to
    // attribute in the first place.
    expect(txTexts().some((text) => text.includes(LEDGER_INSERT))).toBe(false);
  });

  it('raises exactly one capture for a held draft write failure', async () => {
    queuePersistRows({ flaggedHigh: true, notify: false });
    const boom = new Error('23514: refusal_events_c4');
    failLedgerWrite(boom);

    await expect(
      persistResponseAndNotify(mockSql, baseInput({ moderation: HELD_MODERATION })),
    ).rejects.toBe(boom);

    // ONE, not two. The call-site wrapper on this lane wrapped a write and
    // nothing else; once the writer attributes its own faults, keeping it raises
    // two Sentry events for one failure.
    expect(captureExceptionSpy).toHaveBeenCalledTimes(1);
    const [capture] = ledgerCaptures();
    expect(capture?.error).toBe(boom);
    expect(capture?.tags?.refusal_lane).toBe('held_draft');
    // AND THE SURVIVOR IS THE WRITER'S, identified by its payload. A count of
    // one is also what a deleted writer guard plus a surviving wrapper gives,
    // and only the payload separates them.
    expect(capture?.extra).toEqual({
      subject_type: 'response',
      subject_id: RESPONSE_ID,
      account_id: 'acct-1',
      business_id: 'biz-1',
    });
  });

  it('raises exactly one capture for a policy gate write failure', async () => {
    // The case plan round 1 found missing (F1). The lane's OTHER fault class:
    // the vocabulary resolves cleanly and the WRITE fails. With the write left
    // inside the surviving wrapper this fault reports twice, and every one of
    // the twelve writer titles still passes.
    queuePersistRows();
    gateOverride.blockReasons = [mappedNonNullBlockReason()];
    const boom = new Error('23514: refusal_events_c5');
    failLedgerWrite(boom);

    await expect(persistResponseAndNotify(mockSql, baseInput())).rejects.toBe(boom);

    expect(captureExceptionSpy).toHaveBeenCalledTimes(1);
    const [capture] = ledgerCaptures();
    expect(capture?.error).toBe(boom);
    expect(capture?.tags?.refusal_lane).toBe('policy_gate_held');
    expect(capture?.extra).toEqual({
      subject_type: 'response',
      subject_id: RESPONSE_ID,
      account_id: 'acct-1',
      business_id: 'biz-1',
    });
    // …and it is the WRITE fault, not the vocabulary one. The lane tag is the
    // same on both, so before #1083's review round this pair was byte-identical
    // in every tag and only `extra` told them apart — which no Sentry alert rule
    // can filter on.
    expect(capture?.tags?.fault).toBe('ledger_write');
  });

  it('tags the policy gate vocabulary fault with its own fault class', async () => {
    // The two fault classes share a lane, a subsystem and a flag tag. `fault` is
    // the ONLY tag that separates them, and a Sentry alert rule can filter on
    // tags and nothing else — so without this the operator signal the ticket
    // exists to create cannot be routed. Standards and red team both found it.
    //
    // Asserted as a PAIR with the write-fault case above rather than alone: the
    // value matters less than the two being different, and a single-sided
    // assertion passes if both are set to the same constant.
    queuePersistRows();
    gateOverride.blockReasons = ['ghost_reason'];

    await expect(persistResponseAndNotify(mockSql, baseInput())).rejects.toThrow(
      /unmapped_auto_approval_block_reason/,
    );

    const [capture] = ledgerCaptures();
    expect(capture?.tags?.fault).toBe('ledger_vocabulary');
    expect(capture?.tags?.fault).not.toBe('ledger_write');
  });

  it('commits the response persist when the policy gate resolver would throw and the kill switch is off', async () => {
    // #1079's containment invariant, and it must hold BOTH before and after this
    // change. Guard 4 returns before the resolve, so the throwing resolver never
    // runs, nothing new can throw behind it, and the decision commits. A version
    // of ledger attribution that ran anything ahead of that guard would abort the
    // persist through the very lever the operator had already pulled.
    process.env[REFUSAL_LEDGER_FLAG] = 'false';
    queuePersistRows();
    gateOverride.blockReasons = ['ghost_reason'];

    await persistResponseAndNotify(mockSql, baseInput());

    expect(resolvePolicyGateRefusalSpy, 'containment is by NON-EXECUTION').not.toHaveBeenCalled();
    expect(txTexts().some((text) => text.includes('INSERT INTO responses'))).toBe(true);
    expect(txTexts().some((text) => text.includes(LEDGER_INSERT))).toBe(false);
    expect(sendNotificationPayloads(), 'the decision landed, unrecorded').toHaveLength(1);
    expect(captureExceptionSpy, 'nothing to attribute: nothing ran').not.toHaveBeenCalled();
  });
});

// ── Safety review, through REAL persistence (G4-F1) ────────────────────────
//
// Plan round-1 finding 5: module, gate and step tests can all be green while
// the worker threads the wrong verdict, routes not-cleared into the
// moderation-hold branch or drops the owner notification — separate branches
// in `persist.ts`. They are asserted here
// against real persistence rather than through a stub.
//
// Round-1 finding 11 bounds what may be promised: the content-freshness gate
// discards stale work with ZERO writes, and `recordDraftSpineCheckpoints` skips
// spine writes with no active run. So the DURABLE step is promised only for an
// active run; every EXECUTED check is accounted for by a sanitized completion
// log event instead. Moving a spine write ahead of the freshness gate would
// break ADR 0017 and is not the fix.

const NOT_CLEARED_VERDICT = {
  cleared: false,
  concern: 'implied_threat',
  source: 'llm',
  provider: 'openai',
} as const;

function safetySteps(): unknown[] {
  return (recordStep as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .map((call) => call[1])
    .filter(
      (arg): arg is { stepKey?: string } =>
        !!arg && typeof arg === 'object' && (arg as { stepKey?: string }).stepKey === 'safety_reviewed',
    );
}

function safetyLogRecords(logged: unknown[][]): Record<string, unknown>[] {
  return logged
    .map((call) => call[1])
    .filter(
      (arg): arg is Record<string, unknown> =>
        !!arg && typeof arg === 'object' && 'safety_verdict_source' in (arg as object),
    );
}

describe('persistResponseAndNotify — safety review', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    txQueue.length = 0;
    gateOverride.blockReasons = null;
    process.env.AUTO_APPROVAL_ENABLED = 'true';
    // BOTH flags, as all four sibling describes in this file set. Without the
    // moderation one, `provider_moderation_disabled` blocks unconditionally and
    // every case below passes for the wrong reason — deleting the safety row
    // from the gate left them green. (spec-correctness F2)
    process.env.OPENAI_MODERATION_ENABLED = 'true';
    (findActiveReviewRun as unknown as { mockResolvedValue: (v: unknown) => void })
      .mockResolvedValue({ id: 'run-1' });
  });

  afterEach(() => {
    delete process.env.AUTO_APPROVAL_ENABLED;
    delete process.env.OPENAI_MODERATION_ENABLED;
  });

  it('persists a not-cleared safety verdict as pending_approval with one owner notification and no moderation hold, approval audit, or publish outbox', async () => {
    // The four things a wrong branch would do, all asserted at once: a
    // moderation hold (invariant #4's lane, which this feature must NEVER
    // enter), an approval audit row, a publish outbox row, or a lost
    // notification. The draft is SAFE to show the owner — it just may not post
    // itself.
    queuePersistRows();

    await persistResponseAndNotify(mockSql, baseInput({ safetyVerdict: NOT_CLEARED_VERDICT }));

    assertManualNotificationFallback();
    expect(txTexts().some((text) => text.includes('INSERT INTO flagged_responses'))).toBe(false);
  });

  it('records a safety_reviewed step on the run spine when the draft persists with an active run', async () => {
    queuePersistRows();

    await persistResponseAndNotify(mockSql, baseInput({ safetyVerdict: NOT_CLEARED_VERDICT }));

    const steps = safetySteps();
    expect(steps).toHaveLength(1);
    // RT-02: the STATUS, not just the detail. `cleared ? 'completed' : 'failed'`
    // mutated to a constant 'completed' survived the whole suite, and this is
    // the value D12's `failedLabel: 'Held for you'` renders from.
    expect(steps[0]).toMatchObject({ status: 'failed' });
    // The payload carries the verdict and its provenance — never the draft
    // text (CLAUDE.md structured-logging rule, and ADR 0032's input rule).
    expect(steps[0]).toMatchObject({
      detail: expect.objectContaining({
        cleared: false,
        concern: 'implied_threat',
        source: 'llm',
        provider: 'openai',
      }),
    });
    expect(JSON.stringify(steps[0])).not.toContain(RESULT.responseText);
  });

  it('records the safety_reviewed step as completed when the verdict cleared', async () => {
    // The other half of RT-02. Without this, a constant 'failed' also survives,
    // and the timeline would show every cleared draft as "Held for you".
    //
    // `autoApprove: true` because a cleared verdict now genuinely reaches the
    // auto-approve commit — which is itself evidence that the missing
    // OPENAI_MODERATION_ENABLED was masking this whole describe.
    queuePersistRows({ autoApprove: true });

    await persistResponseAndNotify(
      mockSql,
      baseInput({
        safetyVerdict: { cleared: true, concern: null, source: 'llm', provider: 'openai' } as const,
      }),
    );

    const steps = safetySteps();
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ status: 'completed', detail: expect.objectContaining({ cleared: true }) });
  });

  it('a completed safety review followed by stale content creates no response, spine step, or follow-up work and records the discarded evaluation', async () => {
    // Round-1 finding 11. The check ran and was PAID FOR, then the review text
    // changed underneath it. ADR 0017's zero-write path stands — but the paid
    // evaluation must not vanish from the record.
    // The gate compares `loadedReviewContentHash` against the hash on the
    // review-lock row — the FIRST statement in the transaction.
    txQueue.push([{ id: 'rev-1', review_content_hash: 'hash-CHANGED-UNDER-US' }]);
    const logged: unknown[][] = [];
    const logger = {
      log: (...args: unknown[]) => logged.push(args),
      warn: (...args: unknown[]) => logged.push(args),
    };

    const outcome = await persistResponseAndNotify(
      mockSql,
      baseInput({ safetyVerdict: NOT_CLEARED_VERDICT, logger }),
    );

    expect(outcome.kind).toBe('skipped_stale_content');
    expect(txTexts().some((text) => text.includes('INSERT INTO responses'))).toBe(false);
    expect(safetySteps()).toHaveLength(0);
    expect(txArgs()).not.toContain(QUEUE_NAMES.SEND_NOTIFICATION);
    // The discard is recorded, with the verdict's provenance.
    expect(safetyLogRecords(logged)).not.toHaveLength(0);
  });

  it('a not-cleared safety review without an active run still notifies the owner and records its evaluation outside the spine', async () => {
    // A legacy review has no run row, so `recordDraftSpineCheckpoints` writes
    // no step. The
    // owner must still be told, and the paid check must still be accounted for.
    (findActiveReviewRun as unknown as { mockResolvedValue: (v: unknown) => void })
      .mockResolvedValue(null);
    queuePersistRows();
    const logged: unknown[][] = [];
    const logger = {
      log: (...args: unknown[]) => logged.push(args),
      warn: (...args: unknown[]) => logged.push(args),
    };

    await persistResponseAndNotify(
      mockSql,
      baseInput({ safetyVerdict: NOT_CLEARED_VERDICT, logger }),
    );

    expect(safetySteps()).toHaveLength(0);
    expect(sendNotificationPayloads()).toHaveLength(1);
    expect(safetyLogRecords(logged)).not.toHaveLength(0);
  });

  it('a safety_reviewed spine-write failure rolls back the response and follow-up outbox work and propagates the persistence error', async () => {
    // The no-retry rule is scoped to CHECK failures. A PERSISTENCE failure is
    // the opposite case: `recordStep`'s contract makes the write transactional, so
    // swallowing this to satisfy "does not retry" would leave a response with
    // no spine record and no retry to repair it.
    queuePersistRows();
    (recordStep as unknown as { mockImplementation: (fn: unknown) => void }).mockImplementation(
      async (_tx: unknown, step: { stepKey?: string }) => {
        if (step?.stepKey === 'safety_reviewed') throw new Error('spine write failed');
      },
    );

    await expect(
      persistResponseAndNotify(mockSql, baseInput({ safetyVerdict: NOT_CLEARED_VERDICT })),
    ).rejects.toThrow('spine write failed');
  });
});
