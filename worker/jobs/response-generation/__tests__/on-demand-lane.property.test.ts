// worker/jobs/response-generation/__tests__/on-demand-lane.property.test.ts
//
// T1 EVAL suite for #678 — invariant #3 (no unapproved posting) for the
// **Origin lane** `on_demand_generate`.
//
// D-H: the whole production change is ONE entry in GENERATE_RESPONSE_ORIGIN_LANE.
// `isAutoApprovalCandidate` requires `live_ingest_new`, so a Generate
// draft — which IS version 1 — is excluded structurally. Everything here is an
// ASSERTION of that existing guard, never a second gate (ticket #678: "do NOT
// add a second auto-approval guard").
//
// #763: the two `fast-check` properties consume the production predicate from
// auto-approval.ts. The persist test runs through the REAL
// `persistResponseAndNotify` transaction split.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import {
  GENERATE_RESPONSE_ORIGIN_LANE,
  GENERATE_RESPONSE_ORIGIN_LANES,
} from '../../../../src/lib/shared/worker-types';
import { isAutoApprovalCandidate } from '../auto-approval';

describe('invariants', () => {
  beforeEach(() => {
    process.env.AUTO_APPROVAL_ENABLED = 'true';
  });

  afterEach(() => {
    delete process.env.AUTO_APPROVAL_ENABLED;
  });

  it('live_ingest_new version 1 without suppression is a candidate when AUTO_APPROVAL_ENABLED is true', () => {
    expect(isAutoApprovalCandidate({
      originLane: GENERATE_RESPONSE_ORIGIN_LANE.LIVE_INGEST_NEW,
      version: 1,
      suppressNotification: false,
    })).toBe(true);
  });

  it('property: isAutoApprovalCandidate is false for every origin lane other than live_ingest_new', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...GENERATE_RESPONSE_ORIGIN_LANES),
        fc.integer({ min: 1, max: 50 }),
        fc.boolean(),
        (lane, version, suppress) => {
          if (lane === GENERATE_RESPONSE_ORIGIN_LANE.LIVE_INGEST_NEW) return true;
          return isAutoApprovalCandidate({
            originLane: lane,
            version,
            suppressNotification: suppress,
          }) === false;
        },
      ),
    );
  });

  it('property: a suppress_notification draft is never an auto-approval candidate at any version', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...GENERATE_RESPONSE_ORIGIN_LANES),
        fc.integer({ min: 1, max: 50 }),
        (lane, version) => isAutoApprovalCandidate({
          originLane: lane,
          version,
          suppressNotification: true,
        }) === false,
      ),
    );
  });
});

// ── F1: the same invariant, through production ───────────────────────────────
//
// Mocking shape copied from worker/jobs/response-generation/__tests__/persist.test.ts.

const { mockSql, mockTx, txQueue } = vi.hoisted(() => {
  const txQueue: unknown[][] = [];
  const mockTx = vi.fn(
    (_strings: TemplateStringsArray, ..._values: unknown[]) =>
      Promise.resolve(txQueue.shift() ?? []),
  );
  (mockTx as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
  const mockSql = vi.fn() as unknown as {
    (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
    begin: (cb: (tx: typeof mockTx) => Promise<unknown>) => Promise<unknown>;
  };
  mockSql.begin = vi.fn(async (callback: (tx: typeof mockTx) => Promise<unknown>) =>
    callback(mockTx),
  );
  return { mockSql, mockTx, txQueue };
});

vi.mock('../../../../src/lib/db/server', () => ({
  sql: mockSql,
  jsonb: (value: unknown) => value,
}));

vi.mock('uuid', () => ({ v7: vi.fn(() => 'deterministic-uuid-v7') }));

vi.mock('../../../../src/lib/agents/run-spine', () => ({
  findActiveReviewRun: vi.fn(),
  recordStep: vi.fn(),
  recordOutcome: vi.fn(),
}));

import { persistResponseAndNotify } from '../persist';
import { findActiveReviewRun } from '../../../../src/lib/agents/run-spine';
import { QUEUE_NAMES } from '../../../../src/lib/shared/queue-names';
import type { GenerationResult } from '../../../../src/lib/responses/types';
import type { ModerationDecision } from '../../../../src/lib/moderation/output-filter';

const RESULT: GenerationResult = {
  responseText: 'Thanks so much for taking the time to write this.',
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

function sqlText(call: unknown[]): string {
  return (call[0] as TemplateStringsArray).join('?').replace(/\s+/g, ' ');
}

function txTexts(): string[] {
  return mockTx.mock.calls.map(sqlText);
}

function txArgs(): unknown[] {
  return mockTx.mock.calls.flat();
}

describe('persistResponseAndNotify on the on_demand_generate lane', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    txQueue.length = 0;
    process.env.AUTO_APPROVAL_ENABLED = 'true';
    process.env.OPENAI_MODERATION_ENABLED = 'true';
    vi.mocked(findActiveReviewRun).mockResolvedValue(null);
    // Structural non-candidate: persist.ts short-circuits BEFORE the businesses
    // FOR UPDATE and never runs loadAutoApprovalRuntimeState, so only the review
    // lock, the responses INSERT, the api_costs updates and the notification
    // enqueue consume rows.
    txQueue.push([{ id: 'rev-1' }], [], [], [], [], []);
  });

  afterEach(() => {
    delete process.env.AUTO_APPROVAL_ENABLED;
    delete process.env.OPENAI_MODERATION_ENABLED;
  });

  it('persistResponseAndNotify keeps an on_demand_generate v1 draft owner-only when AUTO_APPROVAL_ENABLED is true even if suppress_notification is false', async () => {
    // The lane value must EXIST — without this assertion the test passes
    // vacuously before Task 2 (an `undefined` originLane is also a
    // non-candidate, so every downstream expectation would already hold).
    expect(GENERATE_RESPONSE_ORIGIN_LANE.ON_DEMAND_GENERATE).toBe('on_demand_generate');

    // suppress_notification FALSE is deliberate: it isolates `origin_lane` as
    // the guard actually under test. Version 1 and the runtime flag ON mean
    // every other candidacy conjunct is satisfied.
    await persistResponseAndNotify(mockSql as never, {
      result: RESULT,
      retryCostId: undefined,
      reviewId: 'rev-1',
      businessId: 'biz-1',
      version: 1,
      correlationId: 'corr-1',
      suppressNotification: false,
      originLane: GENERATE_RESPONSE_ORIGIN_LANE.ON_DEMAND_GENERATE,
      loadedReviewContentHash: 'hash-1',
      moderation: CLEAN_MODERATION,
      accountId: 'acct-1',
      preLlmSubscriptionTier: 'autopilot',
      logger: { log: () => {}, warn: () => {} },
    });

    // approval_method stays null — the row is INSERTed pending_approval and the
    // guarded approve UPDATE never runs.
    const responsesInsert = txTexts().find((text) => text.includes('INSERT INTO responses'));
    expect(responsesInsert).toBeDefined();
    expect(responsesInsert).toContain('approval_method');
    expect(
      txTexts().some((text) => text.includes('UPDATE responses') && text.includes('approved_text')),
    ).toBe(false);
    expect(txArgs()).not.toContain('auto_policy');

    // No publish outbox row — nothing reaches Google without an owner action.
    expect(txArgs()).not.toContain(QUEUE_NAMES.PUBLISH_RESPONSE);
    expect(txArgs()).not.toContain(QUEUE_NAMES.PENDING_POST_NOTICE);

    // No auto-policy audit row.
    expect(txTexts().some((text) => text.includes('INSERT INTO approval_audit_log'))).toBe(false);

    // The candidate-only policy evaluation is SKIPPED entirely (findings 5/10):
    // no businesses FOR UPDATE, no migration-074 policy read, no runtime-state
    // projection.
    expect(
      txTexts().some((text) => text.includes('FROM businesses') && text.includes('FOR UPDATE')),
    ).toBe(false);
    expect(txTexts().some((text) => text.includes('auto_approval_policies'))).toBe(false);
    expect(
      txTexts().some((text) => text.includes('FROM reviews r') && text.includes('JOIN accounts a')),
    ).toBe(false);

    // …and the owner still gets told about their own draft.
    expect(txArgs()).toContain(QUEUE_NAMES.SEND_NOTIFICATION);
  });
});
