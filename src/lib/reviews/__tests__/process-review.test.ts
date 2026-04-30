// src/lib/reviews/__tests__/process-review.test.ts
//
// Unit tests for processReview's ON CONFLICT race-handling and
// suppressNotification propagation. sql.begin is mocked so no DB is required.
//
import { describe, it, expect, vi, beforeEach } from 'vitest';

// We capture payloads passed to jsonb() via a module-level array.
// The array is declared here and the vi.mock factory closes over it.
// vi.clearAllMocks() (used in beforeEach) clears call counts but NOT
// closure state, so we splice the array manually in beforeEach.
const capturedJsonbPayloads: unknown[] = [];

vi.mock('@/lib/db/server', () => {
  const sqlBegin = vi.fn();
  const sqlObj = { begin: sqlBegin };
  const jsonbFn = vi.fn((v: unknown) => {
    capturedJsonbPayloads.push(v);
    return v;
  });
  return { sql: sqlObj, jsonb: jsonbFn };
});

// Imports after mocks are wired
import { processReview } from '../process-review';
import { sql } from '@/lib/db/server';

// ── Fixtures ─────────────────────────────────────────────────────────

function makeMonitoredReview(overrides: Partial<{
  provider: 'zernio' | 'serpapi_poll';
  providerReviewId: string;
  providerReviewName: string;
  providerLocationName: string;
  contentHash: string;
}> = {}) {
  const provider = overrides.provider ?? ('zernio' as const);
  const providerReviewName = overrides.providerReviewName ?? `${provider}://loc1/reviews/r1`;
  return {
    review: {
      reviewerName: 'Alice',
      starRating: 5,
      reviewText: 'Great!',
      reviewDate: '2026-04-28',
      detectedLanguage: 'en',
    },
    identity: {
      provider,
      providerReviewId: overrides.providerReviewId ?? 'r1',
      providerReviewName,
      providerLocationName: overrides.providerLocationName ?? `${provider}://loc1`,
      identityStrategy: 'zernio_id' as const,
    },
    contentHash: overrides.contentHash ?? 'hash-abc',
  };
}

// Attach a `.count` property to a result array, matching Postgres.js shape.
function withCount<T extends unknown[]>(arr: T, count: number): T & { count: number } {
  return Object.assign(arr, { count });
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('processReview', () => {
  let tx: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Drain the payloads array between tests
    capturedJsonbPayloads.splice(0);

    tx = vi.fn();

    // Make sql.begin invoke its callback synchronously with the tx stub.
    (sql as unknown as { begin: ReturnType<typeof vi.fn> }).begin =
      vi.fn().mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => cb(tx));
  });

  it('happy path new review — inserts review + outbox, result is new', async () => {
    const monitored = makeMonitoredReview();

    // tx call sequence (new-review, no-race path):
    //   1. SELECT FOR UPDATE existing → none
    //   2. INSERT reviews ON CONFLICT DO NOTHING RETURNING id → count=1 (won)
    //   3. INSERT job_outbox → done
    tx
      .mockResolvedValueOnce(withCount([], 0))
      .mockResolvedValueOnce(withCount([{ id: 'new-id' }], 1))
      .mockResolvedValueOnce(withCount([], 0));

    const result = await processReview(monitored, 'biz-1', 'corr-1');

    expect(result).toBe('new');
    expect(tx).toHaveBeenCalledTimes(3);

    // 3rd tx call is the job_outbox INSERT — verify topic string is present
    const outboxSql = (tx.mock.calls[2]?.[0] as TemplateStringsArray | undefined)?.join('?') ?? '';
    expect(outboxSql).toContain('generate_response');
  });

  it('race-loss (INSERT count=0) falls through to existing-row branch → unchanged', async () => {
    const monitored = makeMonitoredReview({ contentHash: 'same-hash' });

    // tx call sequence (race-loss → unchanged):
    //   1. SELECT FOR UPDATE existing → none (winner hasn't been seen yet)
    //   2. INSERT reviews ON CONFLICT DO NOTHING → count=0 (we lost the race)
    //   3. SELECT FOR UPDATE winner → found, hash matches input
    tx
      .mockResolvedValueOnce(withCount([], 0))
      .mockResolvedValueOnce(withCount([], 0))
      .mockResolvedValueOnce(withCount([{
        id: 'winner-id',
        review_content_hash: 'same-hash',
      }], 1));

    const result = await processReview(monitored, 'biz-1', 'corr-1');

    expect(result).toBe('unchanged');
    expect(tx).toHaveBeenCalledTimes(3);

    // No job_outbox INSERT should have occurred
    const wroteOutbox = tx.mock.calls.some(
      (call) => ((call[0] as TemplateStringsArray | undefined)?.join('?') ?? '').includes('job_outbox'),
    );
    expect(wroteOutbox).toBe(false);
  });

  it('suppressNotification=true is propagated into the generate_response outbox payload', async () => {
    const monitored = makeMonitoredReview();

    tx
      .mockResolvedValueOnce(withCount([], 0))
      .mockResolvedValueOnce(withCount([{ id: 'new-id' }], 1))
      .mockResolvedValueOnce(withCount([], 0));

    const result = await processReview(monitored, 'biz-1', 'corr-1', { suppressNotification: true });

    expect(result).toBe('new');

    // capturedJsonbPayloads[0] is the GenerateResponsePayload passed to jsonb()
    expect(capturedJsonbPayloads).toHaveLength(1);
    const payload = capturedJsonbPayloads[0] as Record<string, unknown>;
    expect(payload['suppress_notification']).toBe(true);
  });

  it('suppressNotification defaults to false when options is omitted', async () => {
    const monitored = makeMonitoredReview();

    tx
      .mockResolvedValueOnce(withCount([], 0))
      .mockResolvedValueOnce(withCount([{ id: 'new-id' }], 1))
      .mockResolvedValueOnce(withCount([], 0));

    // No options argument — default is false
    const result = await processReview(monitored, 'biz-1');

    expect(result).toBe('new');
    expect(capturedJsonbPayloads).toHaveLength(1);
    const payload = capturedJsonbPayloads[0] as Record<string, unknown>;
    expect(payload['suppress_notification']).toBe(false);
  });
});
