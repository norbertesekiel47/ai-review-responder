// worker/jobs/response-generation/__tests__/triage.test.ts
//
// runTriagePhase behavior spec (WS2 spec §§2.1, 2.2, 2.3, 2.6): flag gate,
// positive-lane skip, durable idempotency (content hash + trustworthy source),
// transactional persist, and transient-error propagation for BullMQ retry.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TRIAGE_SOURCE } from '../../../../src/lib/reviews/triage-schema';

const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql } = await vi.hoisted(async () => {
  const { createMockSql } = await import('../../../__tests__/helpers/mock-sql');
  return { ...createMockSql() };
});

const triageEnabled = vi.hoisted(() => vi.fn(() => true));
vi.mock('../../../../src/lib/reviews/flags', () => ({ triageEnabled }));

const classifyReviewTriage = vi.hoisted(() => vi.fn());
const persistTriage = vi.hoisted(() => vi.fn());
vi.mock('../../../../src/lib/reviews/triage', () => ({ classifyReviewTriage, persistTriage }));

const isMockMode = vi.hoisted(() => vi.fn(() => false));
vi.mock('../../../../src/lib/shared/mock-mode', () => ({ isMockMode }));

import type { Sql } from 'postgres';
import { mkTaggedResult } from '../../../__tests__/helpers/mock-sql';
import { runTriagePhase } from '../triage';
import type { GenerationContext } from '../load-context';

function makeCtx(overrides: { starRating?: number; reviewText?: string | null } = {}): GenerationContext {
  return {
    accountId: 'acct-1',
    loadedReviewContentHash: 'hash-1',
    normalizedReview: {
      reviewerName: 'Jane',
      starRating: overrides.starRating ?? 1,
      reviewText: overrides.reviewText === undefined ? 'Awful service.' : overrides.reviewText,
      reviewDate: '2026-07-01',
      detectedLanguage: 'en',
    },
    businessContext: {
      id: 'biz-1',
      name: 'Cafe',
      category: 'cafe',
      tone: 'friendly',
      productsServices: null,
      staffNames: [],
      highlightFacts: [],
      avoidFacts: [],
      sampleResponses: [],
      subscriptionTier: 'standard',
    },
  } as GenerationContext;
}

const ids = { reviewId: 'rev-1', businessId: 'biz-1' };
const logger = { log: vi.fn(), warn: vi.fn() };
const sql = mockSql as unknown as Sql;

function staleState() {
  return mkTaggedResult([{
    triage_severity: null,
    triage_source: null,
    triage_content_hash: null,
    review_content_hash: 'hash-1',
  }]);
}

function llmClassification(severity: 'low' | 'medium' | 'high' = 'high') {
  return {
    output: { severity, issues: ['staff_conduct'], suggested_action: 'escalate' },
    source: TRIAGE_SOURCE.LLM,
    model: 'gpt-4o-mini-2024-07-18',
    latencyMs: 500,
  };
}

beforeEach(() => {
  resetMockSql();
  vi.clearAllMocks();
  triageEnabled.mockReturnValue(true);
  isMockMode.mockReturnValue(false);
});

describe('runTriagePhase', () => {
  it('classifies a negative-lane review, persists in a tx, and returns the severity', async () => {
    sqlReturnQueue.push(staleState());
    classifyReviewTriage.mockResolvedValue(llmClassification('high'));

    const severity = await runTriagePhase(sql, makeCtx(), ids, logger);

    expect(severity).toBe('high');
    expect(classifyReviewTriage).toHaveBeenCalledWith(mockSql, {
      businessId: 'biz-1',
      subscriptionTier: 'standard',
      accountId: 'acct-1',
      review: { starRating: 1, reviewText: 'Awful service.' },
    });
    expect(mockSql.begin).toHaveBeenCalledTimes(1);
    expect(persistTriage).toHaveBeenCalledWith(mockSql, expect.objectContaining({
      reviewId: 'rev-1',
      businessId: 'biz-1',
      contentHash: 'hash-1',
    }));
    expect(logger.log).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      review_id: 'rev-1',
      business_id: 'biz-1',
      severity: 'high',
      suggested_action: 'escalate',
      source: TRIAGE_SOURCE.LLM,
    }));
    const loggedObject = logger.log.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(JSON.stringify(loggedObject)).not.toContain('Awful service.');
  });

  it('returns null with zero DB reads when the flag is off', async () => {
    triageEnabled.mockReturnValue(false);

    const severity = await runTriagePhase(sql, makeCtx(), ids, logger);

    expect(severity).toBeNull();
    expect(sqlCalls).toHaveLength(0);
    expect(classifyReviewTriage).not.toHaveBeenCalled();
  });

  it('returns null with zero DB reads for the positive lane (5-star)', async () => {
    const severity = await runTriagePhase(sql, makeCtx({ starRating: 5 }), ids, logger);

    expect(severity).toBeNull();
    expect(sqlCalls).toHaveLength(0);
    expect(classifyReviewTriage).not.toHaveBeenCalled();
  });

  it('triages a 3-star neutral review', async () => {
    sqlReturnQueue.push(staleState());
    classifyReviewTriage.mockResolvedValue(llmClassification('medium'));

    const severity = await runTriagePhase(sql, makeCtx({ starRating: 3 }), ids, logger);

    expect(severity).toBe('medium');
    expect(classifyReviewTriage).toHaveBeenCalledTimes(1);
  });

  it('skips re-triage for an up-to-date LLM row and returns the stored severity', async () => {
    sqlReturnQueue.push(mkTaggedResult([{
      triage_severity: 'medium',
      triage_source: TRIAGE_SOURCE.LLM,
      triage_content_hash: 'hash-1',
      review_content_hash: 'hash-1',
    }]));

    const severity = await runTriagePhase(sql, makeCtx(), ids, logger);

    expect(severity).toBe('medium');
    expect(classifyReviewTriage).not.toHaveBeenCalled();
    expect(persistTriage).not.toHaveBeenCalled();
  });

  it('re-triages when the review content hash changed, persisting the CURRENT hash', async () => {
    sqlReturnQueue.push(mkTaggedResult([{
      triage_severity: 'low',
      triage_source: TRIAGE_SOURCE.LLM,
      triage_content_hash: 'old-hash',
      review_content_hash: 'new-hash',
    }]));
    classifyReviewTriage.mockResolvedValue(llmClassification('high'));

    const severity = await runTriagePhase(sql, makeCtx(), ids, logger);

    expect(severity).toBe('high');
    expect(classifyReviewTriage).toHaveBeenCalledTimes(1);
    expect(persistTriage).toHaveBeenCalledWith(mockSql, expect.objectContaining({
      contentHash: 'new-hash',
    }));
  });

  it('re-attempts a fallback row even when the hash matches (spec §2.6)', async () => {
    sqlReturnQueue.push(mkTaggedResult([{
      triage_severity: 'high',
      triage_source: TRIAGE_SOURCE.FALLBACK,
      triage_content_hash: 'hash-1',
      review_content_hash: 'hash-1',
    }]));
    classifyReviewTriage.mockResolvedValue(llmClassification('medium'));

    const severity = await runTriagePhase(sql, makeCtx(), ids, logger);

    expect(severity).toBe('medium');
    expect(classifyReviewTriage).toHaveBeenCalledTimes(1);
  });

  it('re-attempts a mock row when NOT in mock mode', async () => {
    sqlReturnQueue.push(mkTaggedResult([{
      triage_severity: 'low',
      triage_source: TRIAGE_SOURCE.MOCK,
      triage_content_hash: 'hash-1',
      review_content_hash: 'hash-1',
    }]));
    isMockMode.mockReturnValue(false);
    classifyReviewTriage.mockResolvedValue(llmClassification('high'));

    const severity = await runTriagePhase(sql, makeCtx(), ids, logger);

    expect(severity).toBe('high');
    expect(classifyReviewTriage).toHaveBeenCalledTimes(1);
  });

  it('skips re-triage for a mock row when in mock mode', async () => {
    sqlReturnQueue.push(mkTaggedResult([{
      triage_severity: 'low',
      triage_source: TRIAGE_SOURCE.MOCK,
      triage_content_hash: 'hash-1',
      review_content_hash: 'hash-1',
    }]));
    isMockMode.mockReturnValue(true);

    const severity = await runTriagePhase(sql, makeCtx(), ids, logger);

    expect(severity).toBe('low');
    expect(classifyReviewTriage).not.toHaveBeenCalled();
    expect(persistTriage).not.toHaveBeenCalled();
  });

  it('returns null when the review is gone (generation path owns reporting)', async () => {
    sqlReturnQueue.push(mkTaggedResult([]));

    const severity = await runTriagePhase(sql, makeCtx(), ids, logger);

    expect(severity).toBeNull();
    expect(classifyReviewTriage).not.toHaveBeenCalled();
  });

  it('propagates a transient classification error so BullMQ retries the job', async () => {
    sqlReturnQueue.push(staleState());
    const transientError = new Error('provider timeout');
    classifyReviewTriage.mockRejectedValue(transientError);

    await expect(runTriagePhase(sql, makeCtx(), ids, logger)).rejects.toBe(transientError);
    expect(persistTriage).not.toHaveBeenCalled();
  });
});
