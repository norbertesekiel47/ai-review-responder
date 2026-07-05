// src/lib/reviews/__tests__/process-review.test.ts
//
// Unit tests for processReview's ON CONFLICT race-handling and
// suppressNotification propagation. sql.begin is mocked so no DB is required.
//
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

vi.mock('@/lib/analytics/enqueue', () => ({
  enqueueAnalyticsEvent: vi.fn(),
}));

// Imports after mocks are wired
import { processReview } from '../process-review';
import { sql } from '@/lib/db/server';
import { enqueueAnalyticsEvent } from '@/lib/analytics/enqueue';

// ── Fixtures ─────────────────────────────────────────────────────────

function makeMonitoredReview(overrides: Partial<{
  provider: 'zernio' | 'serpapi_poll';
  providerReviewId: string;
  providerReviewName: string;
  providerLocationName: string;
  googleReviewName: string | null;
  contentHash: string;
  starRating: number;
}> = {}) {
  const provider = overrides.provider ?? ('zernio' as const);
  const providerReviewName = overrides.providerReviewName ?? `${provider}://loc1/reviews/r1`;
  return {
    review: {
      reviewerName: 'Alice',
      starRating: overrides.starRating ?? 5,
      reviewText: 'Great!',
      reviewDate: '2026-04-28',
      detectedLanguage: 'en',
    },
    identity: {
      provider,
      providerReviewId: overrides.providerReviewId ?? 'r1',
      providerReviewName,
      providerLocationName: overrides.providerLocationName ?? `${provider}://loc1`,
      googleReviewName: overrides.googleReviewName ?? null,
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
      .mockResolvedValueOnce(withCount([], 0))
      .mockResolvedValueOnce(withCount([{ account_id: 'acct-1', earlier_exists: false }], 1));

    const result = await processReview(monitored, 'biz-1', 'corr-1');

    expect(result).toBe('new');
    expect(tx).toHaveBeenCalledTimes(4);

    // 3rd tx call is the job_outbox INSERT — queue name is bound via helper.
    const outboxSql = (tx.mock.calls[2]?.[0] as TemplateStringsArray | undefined)?.join('?') ?? '';
    expect(outboxSql).toContain('INSERT INTO job_outbox');
    expect(tx.mock.calls[2]).toContain('generate_response');
  });

  it('enqueues first_review_ingested for the first account-level review', async () => {
    const monitored = makeMonitoredReview();

    tx
      .mockResolvedValueOnce(withCount([], 0))
      .mockResolvedValueOnce(withCount([{ id: 'new-id' }], 1))
      .mockResolvedValueOnce(withCount([], 0))
      .mockResolvedValueOnce(withCount([{ account_id: 'acct-1', earlier_exists: false }], 1));

    const result = await processReview(monitored, 'biz-1', 'corr-1');

    expect(result).toBe('new');
    expect(enqueueAnalyticsEvent).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        eventName: 'first_review_ingested',
        eventKey: 'first_review_ingested:acct-1',
        distinctId: 'acct-1',
        accountId: 'acct-1',
        businessId: 'biz-1',
      }),
    );
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
      .mockResolvedValueOnce(withCount([], 0))
      .mockResolvedValueOnce(withCount([{ account_id: 'acct-1', earlier_exists: false }], 1));

    const result = await processReview(monitored, 'biz-1', 'corr-1', { suppressNotification: true });

    expect(result).toBe('new');

    // capturedJsonbPayloads[0] is the GenerateResponsePayload passed to jsonb()
    expect(capturedJsonbPayloads).toHaveLength(1);
    const payload = capturedJsonbPayloads[0] as Record<string, unknown>;
    expect(payload['origin_lane']).toBe('live_ingest_new');
    expect(payload['suppress_notification']).toBe(true);
  });

  it('live-ingest new review payload defaults to live_ingest_new and omits false suppress_notification', async () => {
    const monitored = makeMonitoredReview();

    tx
      .mockResolvedValueOnce(withCount([], 0))
      .mockResolvedValueOnce(withCount([{ id: 'new-id' }], 1))
      .mockResolvedValueOnce(withCount([], 0))
      .mockResolvedValueOnce(withCount([{ account_id: 'acct-1', earlier_exists: false }], 1));

    // No options argument — default is false
    const result = await processReview(monitored, 'biz-1');

    expect(result).toBe('new');
    expect(capturedJsonbPayloads).toHaveLength(1);
    const payload = capturedJsonbPayloads[0] as Record<string, unknown>;
    expect(payload['origin_lane']).toBe('live_ingest_new');
    expect(payload).not.toHaveProperty('suppress_notification');
  });

  it('backfill callers can force the backfill origin lane', async () => {
    const monitored = makeMonitoredReview();

    tx
      .mockResolvedValueOnce(withCount([], 0))
      .mockResolvedValueOnce(withCount([{ id: 'new-id' }], 1))
      .mockResolvedValueOnce(withCount([], 0))
      .mockResolvedValueOnce(withCount([{ account_id: 'acct-1', earlier_exists: false }], 1));

    const result = await processReview(monitored, 'biz-1', 'corr-1', {
      suppressNotification: true,
      originLane: 'backfill',
    } as never);

    expect(result).toBe('new');
    expect(capturedJsonbPayloads[0]).toMatchObject({
      origin_lane: 'backfill',
      suppress_notification: true,
    });
  });

  // ── Stale-marking (Task 8) ────────────────────────────────────────────
  //
  // How SQL capturing works in these tests:
  //   tx is a vi.fn() called as a tagged template literal: tx`SQL ${param}...`
  //   call[0]  = TemplateStringsArray  — the literal SQL parts (joined with '?')
  //   call.slice(1) = parameter values — the interpolated values in order
  //
  // Values like STALE_AFTER_REVIEW_CHANGED and the LIKE patterns are bound
  // as SQL parameters (interpolated), NOT embedded in the template strings.
  // We identify the stale-marking UPDATE by its template structure
  // ('UPDATE responses' + 'status = \'failed\'') and verify parameters separately.

  describe('stale-marking recoverable failed rows on content change (EDIT_REPLIES_ENABLED=true)', () => {
    beforeEach(() => {
      process.env['EDIT_REPLIES_ENABLED'] = 'true';
    });

    afterEach(() => {
      delete process.env['EDIT_REPLIES_ENABLED'];
    });

    // Helper: find the stale-marking UPDATE call from tx.mock.calls.
    // Identified by its template structure: UPDATE responses + status = 'failed'.
    function findStaleMarkingCall(calls: unknown[][]): unknown[] | undefined {
      return calls.find((call) => {
        const template = (call[0] as TemplateStringsArray | undefined)?.join('?') ?? '';
        return template.includes('UPDATE responses') && template.includes("status = 'failed'");
      });
    }

    it('marks failed rows with delete_failed_* prefix as stale_after_review_changed', async () => {
      // Scenario: review content changed, existing failed row with posting_error='delete_failed_inbox_addon_required'.
      // Expected: stale-marking UPDATE fires before the reviews UPDATE; the failed row is not the active response.
      const monitored = makeMonitoredReview({ contentHash: 'new-hash' });

      // tx call sequence (content change, no active response):
      //   1. SELECT FOR UPDATE existing → found with DIFFERENT hash
      //   2. UPDATE responses SET stale_after_review_changed (stale-marking sweep, flag on)
      //   3. UPDATE reviews SET reviewer_name/hash
      //   4. SELECT active response FOR UPDATE → none (failed row is excluded by NOT IN ('superseded','failed'))
      //   5. SELECT MAX(version) for nextVersion
      //   6. INSERT job_outbox (generate_response)
      tx
        .mockResolvedValueOnce(withCount([{ id: 'existing-rev', review_content_hash: 'old-hash', status: 'new' }], 1))
        .mockResolvedValueOnce(withCount([], 0))  // stale-marking UPDATE responses
        .mockResolvedValueOnce(withCount([], 0))  // UPDATE reviews
        .mockResolvedValueOnce(withCount([], 0))  // SELECT active response → none
        .mockResolvedValueOnce(withCount([{ next_version: 2 }], 1))  // SELECT MAX(version)
        .mockResolvedValueOnce(withCount([], 0));  // INSERT job_outbox

      const result = await processReview(monitored, 'biz-1', 'corr-1');

      expect(result).toBe('updated');
      expect(tx).toHaveBeenCalledTimes(6);

      const staleCall = findStaleMarkingCall(tx.mock.calls as unknown[][]);
      expect(staleCall).toBeDefined();

      // Parameters must include stale_after_review_changed as the SET value
      const params = (staleCall as unknown[]).slice(1);
      expect(params).toContain('stale_after_review_changed');
      // And the LIKE pattern for the delete_failed_ prefix
      expect(params.some((p) => typeof p === 'string' && p.startsWith('delete_failed_'))).toBe(true);

      // Stale-marking (call index 1) must precede the reviews UPDATE (call index 2)
      const staleIdx = (tx.mock.calls as unknown[][]).indexOf(staleCall!);
      const reviewsUpdateIdx = (tx.mock.calls as unknown[][]).findIndex(
        (call) => ((call[0] as TemplateStringsArray | undefined)?.join('?') ?? '').includes('reviewer_name'),
      );
      expect(staleIdx).toBeGreaterThanOrEqual(0);
      expect(reviewsUpdateIdx).toBeGreaterThan(staleIdx);
    });

    it('marks failed rows with post_after_delete_failed_* prefix as stale_after_review_changed', async () => {
      // Scenario: review content changed, existing failed row with posting_error='post_after_delete_failed_http_400'.
      // The active response SELECT excludes failed rows; this test verifies the sweep covers the orphan prefix too.
      const monitored = makeMonitoredReview({ contentHash: 'new-hash' });

      tx
        .mockResolvedValueOnce(withCount([{ id: 'existing-rev', review_content_hash: 'old-hash', status: 'new' }], 1))
        .mockResolvedValueOnce(withCount([], 0))  // stale-marking UPDATE responses
        .mockResolvedValueOnce(withCount([], 0))  // UPDATE reviews
        .mockResolvedValueOnce(withCount([], 0))  // SELECT active response → none
        .mockResolvedValueOnce(withCount([{ next_version: 2 }], 1))  // SELECT MAX(version)
        .mockResolvedValueOnce(withCount([], 0));  // INSERT job_outbox

      const result = await processReview(monitored, 'biz-1', 'corr-1');

      expect(result).toBe('updated');

      const staleCall = findStaleMarkingCall(tx.mock.calls as unknown[][]);
      expect(staleCall).toBeDefined();

      const params = (staleCall as unknown[]).slice(1);
      // Parameters include both the target marker and the post_after_delete_failed_ LIKE pattern
      expect(params).toContain('stale_after_review_changed');
      expect(params.some((p) => typeof p === 'string' && p.startsWith('post_after_delete_failed_'))).toBe(true);
    });

    it('does NOT touch failed rows with unrelated posting_error (negative case)', async () => {
      // A 'failed' row with posting_error='zernio_permanent_4xx' is NOT in the recoverable allowlist.
      // The UPDATE's WHERE clause limits to the two recoverable LIKE prefixes — 'zernio_permanent_4xx'
      // will not match and gets 0 rows affected. We verify the correct WHERE parameters are used.
      const monitored = makeMonitoredReview({ contentHash: 'new-hash' });

      tx
        .mockResolvedValueOnce(withCount([{ id: 'existing-rev', review_content_hash: 'old-hash', status: 'new' }], 1))
        .mockResolvedValueOnce(withCount([], 0))  // stale-marking UPDATE (0 rows — unrelated error not matched)
        .mockResolvedValueOnce(withCount([], 0))  // UPDATE reviews
        .mockResolvedValueOnce(withCount([], 0))  // SELECT active response → none
        .mockResolvedValueOnce(withCount([{ next_version: 2 }], 1))  // SELECT MAX(version)
        .mockResolvedValueOnce(withCount([], 0));  // INSERT job_outbox

      const result = await processReview(monitored, 'biz-1', 'corr-1');
      expect(result).toBe('updated');

      const staleCall = findStaleMarkingCall(tx.mock.calls as unknown[][]);
      expect(staleCall).toBeDefined();

      const params = (staleCall as unknown[]).slice(1);
      // Only delete_failed_ and post_after_delete_failed_ LIKE patterns are params — not any unrelated error
      expect(params.some((p) => typeof p === 'string' && p.startsWith('delete_failed_'))).toBe(true);
      expect(params.some((p) => typeof p === 'string' && p.startsWith('post_after_delete_failed_'))).toBe(true);
      // 'zernio_permanent_4xx' must NOT appear as a parameter
      expect(params).not.toContain('zernio_permanent_4xx');
    });
  });

  describe('stale-marking is inert when EDIT_REPLIES_ENABLED is off', () => {
    beforeEach(() => {
      delete process.env['EDIT_REPLIES_ENABLED'];
    });

    it('does NOT emit stale-marking UPDATE when flag is off (content change, no active response)', async () => {
      const monitored = makeMonitoredReview({ contentHash: 'new-hash' });

      // tx call sequence WITHOUT stale-marking (flag off):
      //   1. SELECT FOR UPDATE existing → found with DIFFERENT hash
      //   2. UPDATE reviews SET reviewer_name/hash
      //   3. SELECT active response FOR UPDATE → none
      //   4. SELECT MAX(version)
      //   5. INSERT job_outbox
      tx
        .mockResolvedValueOnce(withCount([{ id: 'existing-rev', review_content_hash: 'old-hash', status: 'new' }], 1))
        .mockResolvedValueOnce(withCount([], 0))  // UPDATE reviews (no stale-marking call before this)
        .mockResolvedValueOnce(withCount([], 0))  // SELECT active response → none
        .mockResolvedValueOnce(withCount([{ next_version: 2 }], 1))  // SELECT MAX(version)
        .mockResolvedValueOnce(withCount([], 0));  // INSERT job_outbox

      const result = await processReview(monitored, 'biz-1', 'corr-1');
      expect(result).toBe('updated');

      const allParams = (tx.mock.calls as unknown[][]).flatMap((call) => call.slice(1));
      // stale_after_review_changed must NOT appear in any tx call's parameters
      expect(allParams).not.toContain('stale_after_review_changed');
      // Exactly 5 tx calls (no extra stale UPDATE)
      expect(tx).toHaveBeenCalledTimes(5);

      const payload = capturedJsonbPayloads[0] as Record<string, unknown>;
      expect(payload['origin_lane']).toBe('live_ingest_update');
    });
  });

  // ── Existing content-change tests (flag off — stale UPDATE not injected) ──

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

  // ── Sentiment classification wiring ──────────────────────────────────

  it('new-review INSERT includes sentiment columns for a 5-star review', async () => {
    const monitored = makeMonitoredReview({ starRating: 5 });

    tx
      .mockResolvedValueOnce(withCount([], 0))
      .mockResolvedValueOnce(withCount([{ id: 'new-id' }], 1))
      .mockResolvedValueOnce(withCount([], 0))
      .mockResolvedValueOnce(withCount([{ account_id: 'acct-1', earlier_exists: false }], 1));

    const result = await processReview(monitored, 'biz-1', 'corr-1');
    expect(result).toBe('new');

    // The INSERT INTO reviews is the 2nd tx call (index 1).
    const insertSql = (tx.mock.calls[1]?.[0] as TemplateStringsArray | undefined)?.join('?') ?? '';
    expect(insertSql).toContain('sentiment_label');
    expect(insertSql).toContain('sentiment_source');
    expect(insertSql).toContain('sentiment_classified_at');

    const params = (tx.mock.calls[1] as unknown[]).slice(1);
    expect(params).toContain('positive');
    expect(params).toContain('deterministic_star_v1');
    // 5-star → score = (5−3)/2 = 1
    expect(params).toContain(1);
  });

  it('content-changed UPDATE includes sentiment columns for a 1-star review', async () => {
    // Existing row has old hash; incoming review is 1-star → label='negative'.
    const monitored = makeMonitoredReview({ contentHash: 'new-hash', starRating: 1 });

    tx
      .mockResolvedValueOnce(withCount([{ id: 'existing-rev', review_content_hash: 'old-hash', status: 'new' }], 1))
      .mockResolvedValueOnce(withCount([], 0))  // UPDATE reviews
      .mockResolvedValueOnce(withCount([], 0))  // SELECT active response → none
      .mockResolvedValueOnce(withCount([{ next_version: 2 }], 1))  // SELECT MAX(version)
      .mockResolvedValueOnce(withCount([], 0));  // INSERT job_outbox

    const result = await processReview(monitored, 'biz-1', 'corr-1');
    expect(result).toBe('updated');

    // The UPDATE reviews is the 2nd tx call (index 1).
    const updateSql = (tx.mock.calls[1]?.[0] as TemplateStringsArray | undefined)?.join('?') ?? '';
    expect(updateSql).toContain('sentiment_label');
    expect(updateSql).toContain('sentiment_classified_at');

    const params = (tx.mock.calls[1] as unknown[]).slice(1);
    expect(params).toContain('negative');
    expect(params).toContain('deterministic_star_v1');
    // 1-star → score = (1−3)/2 = −1
    expect(params).toContain(-1);
  });

  it('new-review INSERT persists google_review_name from identity', async () => {
    const monitored = makeMonitoredReview({
      googleReviewName: 'accounts/A/locations/L/reviews/r1',
    });

    tx
      .mockResolvedValueOnce(withCount([], 0))
      .mockResolvedValueOnce(withCount([{ id: 'new-id' }], 1))
      .mockResolvedValueOnce(withCount([], 0))
      .mockResolvedValueOnce(withCount([{ account_id: 'acct-1', earlier_exists: false }], 1));

    const result = await processReview(monitored, 'biz-1', 'corr-1');
    expect(result).toBe('new');

    // The INSERT INTO reviews is the 2nd tx call (index 1).
    const insertSql = (tx.mock.calls[1]?.[0] as TemplateStringsArray | undefined)?.join('?') ?? '';
    expect(insertSql).toContain('google_review_name');

    const params = (tx.mock.calls[1] as unknown[]).slice(1);
    expect(params).toContain('accounts/A/locations/L/reviews/r1');
  });

  it('content-changed UPDATE converges google_review_name without clobbering (COALESCE)', async () => {
    const monitored = makeMonitoredReview({
      contentHash: 'new-hash',
      googleReviewName: 'accounts/A/locations/L/reviews/r1',
    });

    tx
      .mockResolvedValueOnce(withCount([{ id: 'existing-rev', review_content_hash: 'old-hash', status: 'new' }], 1))
      .mockResolvedValueOnce(withCount([], 0))  // UPDATE reviews
      .mockResolvedValueOnce(withCount([], 0))  // SELECT active response → none
      .mockResolvedValueOnce(withCount([{ next_version: 2 }], 1))  // SELECT MAX(version)
      .mockResolvedValueOnce(withCount([], 0));  // INSERT job_outbox

    const result = await processReview(monitored, 'biz-1', 'corr-1');
    expect(result).toBe('updated');

    // The UPDATE reviews is the 2nd tx call (index 1).
    const updateSql = (tx.mock.calls[1]?.[0] as TemplateStringsArray | undefined)?.join('?') ?? '';
    expect(updateSql).toContain('google_review_name = COALESCE(');

    const params = (tx.mock.calls[1] as unknown[]).slice(1);
    expect(params).toContain('accounts/A/locations/L/reviews/r1');
  });

  it('status-only revival UPDATE (deleted row, same hash) does NOT include sentiment_label', async () => {
    // Same content hash → status-only path (restore to 'new') — must not touch sentiment.
    const monitored = makeMonitoredReview({ contentHash: 'same-hash' });

    tx
      .mockResolvedValueOnce(withCount([{
        id: 'existing-rev',
        review_content_hash: 'same-hash',
        status: 'deleted',
      }], 1))
      .mockResolvedValueOnce(withCount([], 0));  // UPDATE reviews SET status='new'

    const result = await processReview(monitored, 'biz-1', 'corr-1');
    expect(result).toBe('updated');

    // The UPDATE is the 2nd tx call (index 1).
    const updateSql = (tx.mock.calls[1]?.[0] as TemplateStringsArray | undefined)?.join('?') ?? '';
    expect(updateSql).toContain("status = 'new'");
    expect(updateSql).not.toContain('sentiment_label');
  });
});

describe('generate_response producer static guard', () => {
  it.each([
    'src/lib/reviews/process-review.ts',
    'src/lib/approval/token-mode.ts',
    'src/lib/approval/session-mode.ts',
    'src/lib/approval/callback-mode.ts',
    'src/app/api/admin/flagged/route.ts',
    'src/app/api/dashboard/past-replies/draft/route.ts',
  ])('routes %s through enqueueGenerateResponse', (file) => {
    const source = readFileSync(resolve(process.cwd(), file), 'utf8');
    expect(source).not.toMatch(/tx`\s*INSERT\s+INTO\s+job_outbox[\s\S]*?'generate_response'/);
    expect(source).toContain('enqueueGenerateResponse');
  });
});
