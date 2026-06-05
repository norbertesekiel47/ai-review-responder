import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerationResult } from '../../../../src/lib/responses/types';
import type { ModerationDecision } from '../../../../src/lib/moderation/output-filter';

const { mockSql, mockTx, txQueue } = vi.hoisted(() => {
  const txQueue: unknown[][] = [];
  const mockTx = vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => {
    return Promise.resolve(txQueue.shift() ?? []);
  });
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

import { persistResponseAndNotify } from '../persist';
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

function baseInput(overrides: Partial<Parameters<typeof persistResponseAndNotify>[0]> = {}) {
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
  expect(txTexts()[0]).toContain('approval_method');
  expect(txArgs()).toContain(QUEUE_NAMES.SEND_NOTIFICATION);
  expect(txArgs()).not.toContain(QUEUE_NAMES.PUBLISH_RESPONSE);
  expect(txArgs()).not.toContain('auto_approved_by_policy');
  expect(txArgs()).not.toContain('auto_policy');
  expect(sendNotificationPayloads()).toHaveLength(1);
}

type PersistInputOverrides = Partial<Parameters<typeof persistResponseAndNotify>[0]>;

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

    const responseId = await persistResponseAndNotify(baseInput());

    expect(responseId).toBe('deterministic-uuid-v7');
    const texts = txTexts();
    expect(texts[0]).toContain('approval_method');
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

    await persistResponseAndNotify(baseInput());

    assertManualNotificationFallback();
  });

  it('logs low-cardinality block reasons when an auto-eligible draft falls back', async () => {
    process.env.OPENAI_MODERATION_ENABLED = 'false';
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    queuePersistRows();

    await persistResponseAndNotify(baseInput({ logger } as never));

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

    await persistResponseAndNotify(baseInput({ originLane: 'regenerate', logger } as never));

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

    await persistResponseAndNotify(baseInput(scenario.input ?? {}));

    assertManualNotificationFallback();
  });

  it('suppressed backfill fallback stays pending without owner notification or publish', async () => {
    queuePersistRows({ notify: false });

    await persistResponseAndNotify(baseInput({ suppressNotification: true }));

    expect(txArgs()).not.toContain(QUEUE_NAMES.SEND_NOTIFICATION);
    expect(txArgs()).not.toContain(QUEUE_NAMES.PUBLISH_RESPONSE);
    expect(txArgs()).not.toContain('auto_approved_by_policy');
    expect(sendNotificationPayloads()).toHaveLength(0);
  });

  it('held high-severity moderation fallback writes a hold and skips owner notification', async () => {
    queuePersistRows({ flaggedHigh: true, notify: false });

    await persistResponseAndNotify(baseInput({
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
