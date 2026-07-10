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

import { persistResponseAndNotify } from '../persist';
import { findActiveReviewRun, recordStep, recordOutcome } from '../../../../src/lib/agents/run-spine';
import { QUEUE_NAMES } from '../../../../src/lib/shared/queue-names';

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
} = {}) {
  txQueue.push(
    // SELECT id FROM reviews … FOR UPDATE (lock ordering — FIRST tx statement)
    input.reviewLockRows ?? [{ id: 'rev-1' }],
    // SELECT id FROM businesses … FOR UPDATE (statement #2 — must precede the
    // responses INSERT, whose business_id FK takes an implicit FOR KEY SHARE)
    [{ id: 'biz-1' }],
    [], // INSERT responses
    [], // UPDATE api_costs response_id
    [], // UPDATE api_costs moderation metadata
  );
  if (input.flaggedHigh) {
    txQueue.push([]); // INSERT flagged_responses
  }
  txQueue.push(
    [currentState(input.state)],
    input.policies ?? [enabledPolicy()],
    [{ id: 'biz-1' }], // loader's same-tx businesses FOR UPDATE re-take
    [{ auto_approved_today: input.autoApprovedToday ?? 0 }], // daily-cap count
    input.connection === null ? [] : [input.connection ?? { id: 'conn-1' }],
  );
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
    accountId: 'acct-1',
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

function assertManualNotificationFallback() {
  // txTexts()[0] is the review row lock, [1] the businesses lock; the
  // responses INSERT follows them.
  expect(txTexts()[2]).toContain('approval_method');
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
  env?: {
    OPENAI_MODERATION_ENABLED?: string;
  };
}

const manualFallbackCases: Array<[string, ManualFallbackScenario]> = [
  ['bad lane', { input: { originLane: 'regenerate' } }],
  ['version > 1', { input: { version: 2 } }],
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

    const responseId = await persistResponseAndNotify(mockSql, baseInput());

    expect(responseId).toBe('deterministic-uuid-v7');
    const texts = txTexts();
    expect(texts[2]).toContain('approval_method');
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
    queuePersistRows({ reviewLockRows: [] });

    await persistResponseAndNotify(mockSql, baseInput({ logger } as never));

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]![0]).toContain('review lock no-oped');
    assertManualNotificationFallback();
  });

  it('falls back to pending approval and notification when the runtime flag is disabled', async () => {
    process.env.AUTO_APPROVAL_ENABLED = 'false';
    queuePersistRows();

    await persistResponseAndNotify(mockSql, baseInput());

    assertManualNotificationFallback();
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
    queuePersistRows();

    await persistResponseAndNotify(mockSql, baseInput({ originLane: 'regenerate', logger } as never));

    expect(logger.log).not.toHaveBeenCalled();
    assertManualNotificationFallback();
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
    });

    await persistResponseAndNotify(mockSql, baseInput(scenario.input ?? {}));

    assertManualNotificationFallback();
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
    queuePersistRows({ notify: false });

    await persistResponseAndNotify(mockSql, baseInput({ suppressNotification: true }));

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
    queuePersistRows();

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

  it('locks the review row FOR UPDATE as the FIRST tx statement, before the responses INSERT and spine writes', async () => {
    vi.mocked(findActiveReviewRun).mockResolvedValue(ACTIVE_RUN);
    queuePersistRows();

    await persistResponseAndNotify(mockSql, baseInput());

    const texts = txTexts();
    const lockIndex = texts.findIndex(
      (text) => text.includes('FROM reviews') && text.includes('FOR UPDATE'),
    );
    const businessLockIndex = texts.findIndex(
      (text) => text.includes('FROM businesses') && text.includes('FOR UPDATE'),
    );
    const insertIndex = texts.findIndex((text) => text.includes('INSERT INTO responses'));
    // First statement of the tx: the responses INSERT's FK takes an implicit
    // FOR KEY SHARE on the reviews tuple, so a later FOR UPDATE would be a
    // deadlock-prone lock upgrade. Statement #2 is the businesses FOR UPDATE
    // for exactly the same reason (the INSERT's business_id FK) — taking it
    // only inside the loader (after the INSERT) reproduces a 40P01 against a
    // concurrent persist for the same business.
    expect(lockIndex).toBe(0);
    expect(businessLockIndex).toBe(1);
    expect(insertIndex).toBeGreaterThan(businessLockIndex);

    // And the lock precedes the first spine write (cross-mock global order).
    const lockInvocation = mockTx.mock.invocationCallOrder[lockIndex]!;
    const firstSpineWriteInvocation = vi.mocked(recordStep).mock.invocationCallOrder[0]!;
    expect(lockInvocation).toBeLessThan(firstSpineWriteInvocation);
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
    queuePersistRows();

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
    queuePersistRows();

    const responseId = await persistResponseAndNotify(mockSql, baseInput());

    expect(responseId).toBe('deterministic-uuid-v7');
    expect(recordStep).not.toHaveBeenCalled();
    expect(recordOutcome).not.toHaveBeenCalled();
    expect(txArgs()).toContain(QUEUE_NAMES.SEND_NOTIFICATION);
  });
});
