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
        status: 'new',
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

  it('restores a deleted review that reappears unchanged at the source', async () => {
    const monitored = makeMonitoredReview({ contentHash: 'same-hash' });

    tx
      .mockResolvedValueOnce(withCount([{
        id: 'existing-rev',
        review_content_hash: 'same-hash',
        status: 'deleted',
      }], 1))
      .mockResolvedValueOnce(withCount([], 0));

    const result = await processReview(monitored, 'biz-1', 'corr-1');

    expect(result).toBe('updated');
    const restoreSql = (tx.mock.calls[1]?.[0] as TemplateStringsArray | undefined)?.join('?') ?? '';
    expect(restoreSql).toContain("status = 'new'");
    expect(restoreSql).toContain('WHERE id =');
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

  it('content change on awaiting_owner_connect response: supersedes response + opens review_exception', async () => {
    const monitored = makeMonitoredReview({ contentHash: 'new-hash' });

    // tx call sequence for existing row with content change + awaiting_owner_connect:
    //   1. SELECT FOR UPDATE existing → found with DIFFERENT hash
    //   2. UPDATE reviews SET review_text/hash
    //   3. SELECT active response FOR UPDATE → awaiting_owner_connect
    //   4. INSERT review_exceptions → count=1 (new exception opened)
    //   5. INSERT job_outbox (notify_admin_review_exception)
    //   6. UPDATE responses SET status = 'superseded'
    tx
      .mockResolvedValueOnce(withCount([{ id: 'existing-rev', review_content_hash: 'old-hash' }], 1))
      .mockResolvedValueOnce(withCount([], 0))  // UPDATE reviews
      .mockResolvedValueOnce(withCount([{ id: 'resp-1', status: 'awaiting_owner_connect', version: 1 }], 1))
      .mockResolvedValueOnce(withCount([{ id: 'exc-1' }], 1))  // INSERT review_exceptions
      .mockResolvedValueOnce(withCount([], 0))  // INSERT job_outbox
      .mockResolvedValueOnce(withCount([], 0)); // UPDATE responses superseded

    const result = await processReview(monitored, 'biz-1', 'corr-1');

    expect(result).toBe('updated');

    const allSqls = tx.mock.calls.map(
      (call) => ((call[0] as TemplateStringsArray | undefined)?.join('?') ?? ''),
    );

    // review_exception must be inserted with type='review_edited_after_post'
    expect(allSqls.some((s) => s.includes('review_edited_after_post'))).toBe(true);

    // Response must be superseded with posting_error='review_content_changed_during_park'
    const supersedeCall = allSqls.find((s) => s.includes('review_content_changed_during_park'));
    expect(supersedeCall).toBeDefined();
    expect(supersedeCall).toContain('superseded');
  });

  it('content change on posted response: opens review_exception but does NOT supersede', async () => {
    const monitored = makeMonitoredReview({ contentHash: 'new-hash' });

    // tx call sequence for existing row with content change + posted:
    //   1. SELECT FOR UPDATE existing → found with DIFFERENT hash
    //   2. UPDATE reviews
    //   3. SELECT active response FOR UPDATE → posted
    //   4. INSERT review_exceptions → count=1
    //   5. INSERT job_outbox
    //   (NO UPDATE responses SET superseded — posted is terminal)
    tx
      .mockResolvedValueOnce(withCount([{ id: 'existing-rev', review_content_hash: 'old-hash' }], 1))
      .mockResolvedValueOnce(withCount([], 0))  // UPDATE reviews
      .mockResolvedValueOnce(withCount([{ id: 'resp-1', status: 'posted', version: 1 }], 1))
      .mockResolvedValueOnce(withCount([{ id: 'exc-1' }], 1))  // INSERT review_exceptions
      .mockResolvedValueOnce(withCount([], 0));  // INSERT job_outbox

    const result = await processReview(monitored, 'biz-1', 'corr-1');

    expect(result).toBe('updated');

    const allSqls = tx.mock.calls.map(
      (call) => ((call[0] as TemplateStringsArray | undefined)?.join('?') ?? ''),
    );

    // review_exception must be inserted
    expect(allSqls.some((s) => s.includes('review_edited_after_post'))).toBe(true);

    // Response must NOT be superseded — 'posted' is terminal
    expect(allSqls.some((s) => s.includes('review_content_changed_during_park'))).toBe(false);
    // Only 5 tx calls — no 6th UPDATE responses call
    expect(tx).toHaveBeenCalledTimes(5);
  });
});
