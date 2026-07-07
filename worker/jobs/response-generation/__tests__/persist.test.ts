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
    ...overrides,
  };
}

function enabledPolicy(overrides = {}) {
  return {
    id: 'policy-1',
    account_id: 'acct-1',
    location_id: null,
    auto_approve_min_star: 4,
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
} = {}) {
  txQueue.push(
    [], // SELECT 1 FROM reviews … FOR UPDATE (lock ordering — FIRST tx statement)
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
    input.connection === null ? [] : [input.connection ?? { id: 'conn-1' }],
  );
  if (input.autoApprove) {
    txQueue.push(
      [], // UPDATE responses approved
      [{ account_id: 'acct-1' }], // audit account lookup
      [], // INSERT approval_audit_log
      [], // INSERT publish outbox
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
    logger: { log: () => {} },
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
  // txTexts()[0] is the review row lock; the responses INSERT follows it.
  expect(txTexts()[1]).toContain('approval_method');
  expect(txArgs()).toContain(QUEUE_NAMES.SEND_NOTIFICATION);
  expect(txArgs()).not.toContain(QUEUE_NAMES.PUBLISH_RESPONSE);
  expect(txArgs()).not.toContain('auto_approved_by_policy');
  expect(txArgs()).not.toContain('auto_policy');
  expect(sendNotificationPayloads()).toHaveLength(1);
}

type PersistInputOverrides = Partial<Parameters<typeof persistResponseAndNotify>[1]>;

interface ManualFallbackScenario {
  input?: PersistInputOverrides;
  state?: Record<string, unknown>;
  policies?: Record<string, unknown>[];
  connection?: Record<string, unknown> | null;
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
    expect(texts[1]).toContain('approval_method');
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
    });

    await persistResponseAndNotify(mockSql, baseInput(scenario.input ?? {}));

    assertManualNotificationFallback();
  });

  it('suppressed backfill fallback stays pending without owner notification or publish', async () => {
    queuePersistRows({ notify: false });

    await persistResponseAndNotify(mockSql, baseInput({ suppressNotification: true }));

    expect(txArgs()).not.toContain(QUEUE_NAMES.SEND_NOTIFICATION);
    expect(txArgs()).not.toContain(QUEUE_NAMES.PUBLISH_RESPONSE);
    expect(txArgs()).not.toContain('auto_approved_by_policy');
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
    const insertIndex = texts.findIndex((text) => text.includes('INSERT INTO responses'));
    // First statement of the tx: the responses INSERT's FK takes an implicit
    // FOR KEY SHARE on the reviews tuple, so a later FOR UPDATE would be a
    // deadlock-prone lock upgrade.
    expect(lockIndex).toBe(0);
    expect(insertIndex).toBeGreaterThan(lockIndex);

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
