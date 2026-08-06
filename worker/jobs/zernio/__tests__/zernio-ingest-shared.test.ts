import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/zernio/auth-error-fallback', () => ({
  applyIngestionAuthErrorFallback: vi.fn(),
}));
vi.mock('@/lib/shared/outbox', () => ({
  markOutboxCompleted: vi.fn(),
  markOutboxFailed: vi.fn(),
}));
vi.mock('@sentry/node', () => ({
  captureMessage: vi.fn(),
}));

import {
  handleZernioIngestError,
  liveIngestCutoff,
  openPhiReviewException,
  reconcileExternallyAnsweredReview,
} from '../zernio-ingest-shared';
import {
  ZernioAuthError,
  ZernioPermanentError,
  ZernioTransientError,
  ZernioValidationError,
} from '@/lib/zernio/errors';
import type { ZernioReview } from '@/lib/zernio/types';
import { resetWorkerConfigForTests } from '@/lib/config/worker';

const mkLogger = () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() });
const ctx = { business_id: 'B', zernio_account_id: 'A', zernio_location_id: 'L' };

/** sql is now an explicit leading param (spec §2.1) — build a minimal
 * `Sql`-shaped mock per test instead of mocking the `@/lib/db/server` module. */
function makeSqlMock() {
  return { begin: vi.fn() } as unknown as Parameters<typeof handleZernioIngestError>[0];
}

describe('handleZernioIngestError — dispatch matrix', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('ZernioAuthError → applyIngestionAuthErrorFallback + markOutboxFailed', async () => {
    const { applyIngestionAuthErrorFallback } = await import('@/lib/zernio/auth-error-fallback');
    const { markOutboxFailed } = await import('@/lib/shared/outbox');

    const sql = makeSqlMock();
    const err = new ZernioAuthError(401, 'expired token');
    await handleZernioIngestError(sql, err, 'outbox-1', 1, ctx, mkLogger() as any);

    expect(applyIngestionAuthErrorFallback).toHaveBeenCalledWith(sql, 'B', 'A', 'L', expect.stringContaining('401'));
    expect(markOutboxFailed).toHaveBeenCalledWith(sql, 'outbox-1', 'zernio_auth_error_on_ingest', 1);
  });

  it('ZernioPermanentError → markOutboxFailed permanent', async () => {
    const { markOutboxFailed } = await import('@/lib/shared/outbox');
    const err = new ZernioPermanentError('500 fatal', {});
    const sql = makeSqlMock();
    await handleZernioIngestError(sql, err, 'outbox-1', 1, ctx, mkLogger() as any);
    expect(markOutboxFailed).toHaveBeenCalledWith(sql, 'outbox-1', expect.stringContaining('zernio_permanent_error'), 1);
  });

  it('ZernioValidationError → markOutboxFailed permanent', async () => {
    const { markOutboxFailed } = await import('@/lib/shared/outbox');
    const err = new ZernioValidationError('bad_payload', { raw: 'data' });
    const sql = makeSqlMock();
    await handleZernioIngestError(sql, err, 'outbox-1', 1, ctx, mkLogger() as any);
    expect(markOutboxFailed).toHaveBeenCalledWith(sql, 'outbox-1', expect.stringContaining('zernio_validation_error'), 1);
  });

  it('ZernioTransientError → rethrow', async () => {
    await expect(
      handleZernioIngestError(
        makeSqlMock(), new ZernioTransientError('timeout', {}),
        'outbox-1', 1, ctx, mkLogger() as any,
      ),
    ).rejects.toBeInstanceOf(ZernioTransientError);
  });

  it('unknown Error → rethrow', async () => {
    await expect(
      handleZernioIngestError(
        makeSqlMock(), new Error('boom'), 'outbox-1', 1, ctx, mkLogger() as any,
      ),
    ).rejects.toThrow('boom');
  });
});

describe('openPhiReviewException', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('opens an operator exception without storing raw review text', async () => {
    const { captureMessage } = await import('@sentry/node');
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    // openPhiReviewException is invoked inside a caller-owned transaction; the
    // mock stands in for that tx handle and records both inserts.
    const db = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ sql: strings.join('?'), values });
      return Promise.resolve(calls.length === 1 ? [{ id: 'exc-1' }] : []);
    });
    (db as unknown as { json: ReturnType<typeof vi.fn> }).json = vi.fn((v: unknown) => v);
    const logger = mkLogger();
    const review: ZernioReview = {
      id: 'rev-phi',
      name: 'accounts/A/locations/L/reviews/rev-phi',
      reviewer: { displayName: 'Jane', profilePhotoUrl: '', isAnonymous: false },
      rating: 5,
      starRating: 'FIVE',
      comment: 'Patient MRN 12345 needs diabetes treatment follow up',
      createTime: '2026-04-01T00:00:00Z',
      updateTime: '2026-04-01T00:00:00Z',
      reviewReply: null,
    };

    await openPhiReviewException(db as any, {
      businessId: 'B',
      accountId: 'A',
      locationId: 'L',
      review,
      reasons: ['mrn', 'self_referenced_medical_context'],
      source: 'webhook',
    }, logger as any);

    expect(calls[0]?.sql).toContain('INSERT INTO review_exceptions');
    expect(calls[1]?.sql).toContain('INSERT INTO job_outbox');
    // Topic is an interpolated QUEUE_NAMES value, not a template literal —
    // check the bound values, not the raw strings array.
    expect(calls[1]?.values).toContain('notify_admin_review_exception');
    expect(JSON.stringify(calls)).toContain('provider_review_id');
    expect(JSON.stringify(calls[1])).not.toContain('MRN 12345');
    expect(captureMessage).toHaveBeenCalledWith(
      'zernio_likely_phi_review_blocked',
      expect.objectContaining({
        level: 'warning',
        tags: expect.objectContaining({ kind: 'likely_phi', source: 'webhook' }),
      }),
    );
  });

  it('is a no-op when an open exception already exists (ON CONFLICT)', async () => {
    const { captureMessage } = await import('@sentry/node');
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    // First INSERT ... ON CONFLICT DO NOTHING returns no row — a still-open
    // exception already exists, so neither the outbox nor the alert should fire.
    const db = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ sql: strings.join('?'), values });
      return Promise.resolve([]);
    });
    (db as unknown as { json: ReturnType<typeof vi.fn> }).json = vi.fn((v: unknown) => v);
    const logger = mkLogger();
    const review: ZernioReview = {
      id: 'rev-phi-dup',
      name: 'accounts/A/locations/L/reviews/rev-phi-dup',
      reviewer: { displayName: 'Jane', profilePhotoUrl: '', isAnonymous: false },
      rating: 5,
      starRating: 'FIVE',
      comment: 'Patient MRN 12345 needs diabetes treatment follow up',
      createTime: '2026-04-01T00:00:00Z',
      updateTime: '2026-04-01T00:00:00Z',
      reviewReply: null,
    };

    await openPhiReviewException(db as any, {
      businessId: 'B',
      accountId: 'A',
      locationId: 'L',
      review,
      reasons: ['mrn'],
      source: 'backfill',
    }, logger as any);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain('INSERT INTO review_exceptions');
    expect(calls.some((call) => call.values.includes('notify_admin_review_exception'))).toBe(false);
    expect(captureMessage).not.toHaveBeenCalled();
  });
});

describe('reconcileExternallyAnsweredReview', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  const mkReview = (overrides: Partial<ZernioReview> = {}): ZernioReview => ({
    id: 'rev-1',
    name: 'accounts/A/locations/L/reviews/rev-1',
    reviewer: { displayName: 'Jane', profilePhotoUrl: '', isAnonymous: false },
    rating: 5,
    starRating: 'FIVE',
    comment: 'Great!',
    createTime: '2026-04-01T00:00:00Z',
    updateTime: '2026-04-01T00:00:00Z',
    reviewReply: { comment: 'Thanks for the review!', updateTime: '2026-04-02T00:00:00Z' },
    ...overrides,
  });

  const mkTaggedResult = <T = unknown>(rows: T[]) => {
    const arr = rows as unknown as T[] & { count: number };
    arr.count = rows.length;
    return arr;
  };

  it('no matched review rows → log + early return', async () => {
    const sql = makeSqlMock();
    const tx = vi.fn(() => Promise.resolve(mkTaggedResult([])));
    (sql as any).begin = vi.fn(async (cb: any) => cb(tx));
    const logger = mkLogger();
    await reconcileExternallyAnsweredReview(sql, mkReview(), 'B', 'A', 'L', logger as any);
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('previously-unseen'));
  });

  it('all-protected (canonicalized text matches all active responses) → no supersession', async () => {
    const sql = makeSqlMock();
    let callIdx = 0;
    const tx = vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => {
      callIdx += 1;
      // Call 1: SELECT matchedRows → 1 zernio row.
      if (callIdx === 1) return Promise.resolve(mkTaggedResult([{ id: 'rev-row-1', provider: 'zernio' }]));
      // Call 2: SELECT activeResponses → 1 'approved' with matching approved_text.
      if (callIdx === 2) return Promise.resolve(mkTaggedResult([
        { id: 'resp-1', status: 'approved', approved_text: 'Thanks for the review!' },
      ]));
      return Promise.resolve(mkTaggedResult([]));
    });
    (sql as any).begin = vi.fn(async (cb: any) => cb(tx));
    const logger = mkLogger();
    await reconcileExternallyAnsweredReview(sql, mkReview(), 'B', 'A', 'L', logger as any);
    // Only 2 tx calls: SELECT matchedRows + SELECT activeResponses. NO UPDATE.
    expect(callIdx).toBe(2);
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('matches every active response'));
  });

  it('all-stale (no active response matches external reply) → supersedes all', async () => {
    const sql = makeSqlMock();
    let callIdx = 0;
    const tx = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
      callIdx += 1;
      if (callIdx === 1) return Promise.resolve(mkTaggedResult([{ id: 'rev-row-1', provider: 'zernio' }]));
      if (callIdx === 2) return Promise.resolve(mkTaggedResult([
        { id: 'resp-1', status: 'approved', approved_text: 'Different reply text' },
      ]));
      // UPDATE returning supersededRows
      return Promise.resolve(mkTaggedResult([{ id: 'resp-1' }]));
    });
    (sql as any).begin = vi.fn(async (cb: any) => cb(tx));
    const logger = mkLogger();
    await reconcileExternallyAnsweredReview(sql, mkReview(), 'B', 'A', 'L', logger as any);
    expect(callIdx).toBe(3);  // SELECT matched, SELECT active, UPDATE supersede
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('Superseded 1 active response'));
  });

  it('pending_approval response (approved_text=NULL) is always superseded when external reply detected', async () => {
    const sql = makeSqlMock();
    let callIdx = 0;
    const tx = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
      callIdx += 1;
      if (callIdx === 1) return Promise.resolve(mkTaggedResult([{ id: 'rev-row-1', provider: 'zernio' }]));
      if (callIdx === 2) return Promise.resolve(mkTaggedResult([
        { id: 'resp-1', status: 'pending_approval', approved_text: null },
      ]));
      return Promise.resolve(mkTaggedResult([{ id: 'resp-1' }]));
    });
    (sql as any).begin = vi.fn(async (cb: any) => cb(tx));
    const logger = mkLogger();
    await reconcileExternallyAnsweredReview(sql, mkReview(), 'B', 'A', 'L', logger as any);
    expect(callIdx).toBe(3);
  });

  it('SQL filter for active responses excludes awaiting_manual_post (decommissioned status)', async () => {
    const sql = makeSqlMock();
    let activeResponseSql = '';
    let callIdx = 0;
    const tx = vi.fn((strings: TemplateStringsArray, ..._v: unknown[]) => {
      callIdx += 1;
      if (callIdx === 1) return Promise.resolve(mkTaggedResult([{ id: 'rev-row-1', provider: 'zernio' }]));
      if (callIdx === 2) {
        activeResponseSql = strings.join('');
        return Promise.resolve(mkTaggedResult([]));
      }
      return Promise.resolve(mkTaggedResult([]));
    });
    (sql as any).begin = vi.fn(async (cb: any) => cb(tx));
    await reconcileExternallyAnsweredReview(sql, mkReview(), 'B', 'A', 'L', mkLogger() as any);
    expect(activeResponseSql).not.toContain('awaiting_manual_post');
    expect(activeResponseSql).toContain('pending_approval');
    expect(activeResponseSql).toContain('approved');
    expect(activeResponseSql).toContain('edited');
    expect(activeResponseSql).toContain('awaiting_owner_connect');
  });
});

describe('reconcileExternallyAnsweredReview — flag-gated import branches', () => {
  const ORIGINAL_FLAG = process.env.EXTERNAL_REPLY_IMPORT_ENABLED;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    if (ORIGINAL_FLAG === undefined) {
      delete process.env.EXTERNAL_REPLY_IMPORT_ENABLED;
    } else {
      process.env.EXTERNAL_REPLY_IMPORT_ENABLED = ORIGINAL_FLAG;
    }
  });

  const mkReview = (overrides: Partial<ZernioReview> = {}): ZernioReview => ({
    id: 'rev-1',
    name: 'accounts/A/locations/L/reviews/rev-1',
    reviewer: { displayName: 'Jane', profilePhotoUrl: '', isAnonymous: false },
    rating: 5,
    starRating: 'FIVE',
    comment: 'Great!',
    createTime: '2026-04-01T00:00:00Z',
    updateTime: '2026-04-01T00:00:00Z',
    reviewReply: { comment: 'Thanks for the review!', updateTime: '2026-04-02T00:00:00Z' },
    ...overrides,
  });

  const mkTaggedResult = <T = unknown>(rows: T[]) => {
    const arr = rows as unknown as T[] & { count: number };
    arr.count = rows.length;
    return arr;
  };

  // Helper that records every tx`…` invocation as { sql, values } so each
  // assertion can introspect what statements ran in what order.
  type Recorded = { sql: string; values: unknown[] };
  const mkRecordingTx = (handlers: Array<(rec: Recorded) => unknown[]>) => {
    const calls: Recorded[] = [];
    let idx = 0;
    const tx = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      const rec: Recorded = { sql: strings.join('?'), values };
      calls.push(rec);
      const handler = handlers[idx];
      idx += 1;
      const rows = handler ? handler(rec) : [];
      return Promise.resolve(mkTaggedResult(rows));
    });
    // Identity pass-through for the openPhiReviewException PHI branches'
    // `db.json(...)` bind (mirrors mock-sql.ts's createMockSql().json).
    (tx as unknown as { json: ReturnType<typeof vi.fn> }).json = vi.fn((v: unknown) => v);
    return { tx, calls };
  };

  it('flag OFF + no-match: silent no-op (today\'s behavior unchanged)', async () => {
    delete process.env.EXTERNAL_REPLY_IMPORT_ENABLED;
    const sql = makeSqlMock();
    const { tx, calls } = mkRecordingTx([
      // 1. SELECT matched rows → none.
      () => [],
    ]);
    (sql as any).begin = vi.fn(async (cb: any) => cb(tx));
    const logger = mkLogger();
    await reconcileExternallyAnsweredReview(sql, mkReview(), 'B', 'A', 'L', logger as any);
    // Only 1 SELECT — no INSERTs at all.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain('SELECT');
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('previously-unseen'));
  });

  it('flag ON + no-match: INSERTs reviews row + posted response + bumps counter', async () => {
    process.env.EXTERNAL_REPLY_IMPORT_ENABLED = 'true';
    const sql = makeSqlMock();
    const { tx, calls } = mkRecordingTx([
      // 1. SELECT matched rows → none.
      () => [],
      // 2. INSERT INTO reviews … RETURNING id.
      () => [{ id: 'new-review-uuid' }],
      // 3. INSERT INTO responses … RETURNING 1 (rowcount=1 means actually inserted).
      () => [{}],
      // 4. UPDATE zernio_backfill_runs … (counter bump — only fires when insertImportedResponse returned true).
      () => [],
    ]);
    (sql as any).begin = vi.fn(async (cb: any) => cb(tx));
    const logger = mkLogger();
    await reconcileExternallyAnsweredReview(sql, mkReview(), 'B', 'A', 'L', logger as any);

    expect(calls).toHaveLength(4);
    // INSERT into reviews with provider='zernio' and external_reply_ingested_at NOT NULL.
    expect(calls[1]!.sql).toContain('INSERT INTO reviews');
    expect(calls[1]!.sql).toContain('external_reply_ingested_at');
    expect(calls[1]!.sql).toContain('ON CONFLICT');
    expect(calls[1]!.sql).toContain('provider_review_name');
    // The 'zernio' literal is hard-coded into the SQL fragment, not a binding.
    expect(calls[1]!.sql).toContain("'zernio'");
    // INSERT into responses with status='posted', version=1 (no priors), all 3 text cols.
    expect(calls[2]!.sql).toContain('INSERT INTO responses');
    expect(calls[2]!.sql).toContain("'posted'");
    expect(calls[2]!.sql).toContain('response_text');
    expect(calls[2]!.sql).toContain('approved_text');
    expect(calls[2]!.sql).toContain('original_draft_text');
    expect(calls[2]!.sql).toContain('MAX(version)');
    // Counter bump.
    expect(calls[3]!.sql).toContain('UPDATE zernio_backfill_runs');
    expect(calls[3]!.sql).toContain('external_reply_ingested_count');
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('Imported external reply'));
  });

  it('flag ON + no-match + likely PHI review text: skips review and response inserts', async () => {
    process.env.EXTERNAL_REPLY_IMPORT_ENABLED = 'true';
    const sql = makeSqlMock();
    const { tx, calls } = mkRecordingTx([
      // 1. SELECT matched rows → none.
      () => [],
    ]);
    (sql as any).begin = vi.fn(async (cb: any) => cb(tx));
    const logger = mkLogger();

    await reconcileExternallyAnsweredReview(
      sql,
      mkReview({ comment: 'Patient MRN 12345 needs diabetes treatment follow up' }),
      'B',
      'A',
      'L',
      logger as any,
    );

    expect(calls).toHaveLength(2);
    expect(calls[1]!.sql).toContain('INSERT INTO review_exceptions');
    expect(calls.every((c) => !c.sql.includes('INSERT INTO reviews'))).toBe(true);
    expect(calls.every((c) => !c.sql.includes('INSERT INTO responses'))).toBe(true);
    expect(calls.every((c) => !c.sql.includes('UPDATE zernio_backfill_runs'))).toBe(true);
    expect(JSON.stringify(calls[1])).not.toContain('MRN 12345');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Likely PHI detected'));
    expect(logger.warn).toHaveBeenCalledWith(expect.not.stringContaining('MRN 12345'));
  });

  it('flag ON + matched but no active responses: INSERTs response only, version > 1 if prior terminals exist', async () => {
    process.env.EXTERNAL_REPLY_IMPORT_ENABLED = 'true';
    const sql = makeSqlMock();
    const { tx, calls } = mkRecordingTx([
      // 1. SELECT matched rows → 1 row.
      () => [{ id: 'rev-row-1', provider: 'zernio' }],
      // 2. SELECT active responses → none (prior 'failed' is terminal, excluded).
      () => [],
      // 3. INSERT INTO responses … RETURNING 1 (rowcount=1 means actually inserted).
      () => [{}],
      // 4. UPDATE zernio_backfill_runs … (counter bump — only fires when insertImportedResponse returned true).
      () => [],
    ]);
    (sql as any).begin = vi.fn(async (cb: any) => cb(tx));
    const logger = mkLogger();
    await reconcileExternallyAnsweredReview(sql, mkReview(), 'B', 'A', 'L', logger as any);

    expect(calls).toHaveLength(4);
    // No INSERT INTO reviews (the row already exists).
    expect(calls.every((c) => !c.sql.includes('INSERT INTO reviews'))).toBe(true);
    // INSERT INTO responses targeting the existing review id.
    expect(calls[2]!.sql).toContain('INSERT INTO responses');
    expect(calls[2]!.values).toContain('rev-row-1');
    // version is COALESCE(MAX(version), 0) + 1 — handled server-side.
    expect(calls[2]!.sql).toContain('MAX(version)');
    // Counter bump.
    expect(calls[3]!.sql).toContain('UPDATE zernio_backfill_runs');
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('Imported external reply onto existing review'));
  });

  it('flag ON + matched but no active responses + likely PHI review text: skips response import', async () => {
    process.env.EXTERNAL_REPLY_IMPORT_ENABLED = 'true';
    const sql = makeSqlMock();
    const { tx, calls } = mkRecordingTx([
      // 1. SELECT matched rows → 1 row.
      () => [{ id: 'rev-row-1', provider: 'zernio' }],
      // 2. SELECT active responses → none.
      () => [],
    ]);
    (sql as any).begin = vi.fn(async (cb: any) => cb(tx));
    const logger = mkLogger();

    await reconcileExternallyAnsweredReview(
      sql,
      mkReview({ comment: 'Patient MRN 12345 needs diabetes treatment follow up' }),
      'B',
      'A',
      'L',
      logger as any,
    );

    expect(calls).toHaveLength(3);
    expect(calls[2]!.sql).toContain('INSERT INTO review_exceptions');
    expect(calls.every((c) => !c.sql.includes('INSERT INTO responses'))).toBe(true);
    expect(calls.every((c) => !c.sql.includes('UPDATE zernio_backfill_runs'))).toBe(true);
    expect(JSON.stringify(calls[2])).not.toContain('MRN 12345');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Likely PHI detected'));
    expect(logger.warn).toHaveBeenCalledWith(expect.not.stringContaining('MRN 12345'));
  });

  it('flag ON + matched WITH active response: today\'s supersede/protect logic, no new INSERTs, no counter bump', async () => {
    process.env.EXTERNAL_REPLY_IMPORT_ENABLED = 'true';
    const sql = makeSqlMock();
    const { tx, calls } = mkRecordingTx([
      // 1. SELECT matched rows → 1 row.
      () => [{ id: 'rev-row-1', provider: 'zernio' }],
      // 2. SELECT active responses → 1 'approved' with non-matching text.
      () => [{ id: 'resp-1', status: 'approved', approved_text: 'Different reply text' }],
      // 3. UPDATE responses SET status='superseded' RETURNING id.
      () => [{ id: 'resp-1' }],
    ]);
    (sql as any).begin = vi.fn(async (cb: any) => cb(tx));
    const logger = mkLogger();
    await reconcileExternallyAnsweredReview(sql, mkReview(), 'B', 'A', 'L', logger as any);

    expect(calls).toHaveLength(3);
    // Existing supersede behavior preserved — no INSERTs added.
    expect(calls.every((c) => !c.sql.includes('INSERT INTO reviews'))).toBe(true);
    expect(calls.every((c) => !c.sql.includes('INSERT INTO responses'))).toBe(true);
    expect(calls.every((c) => !c.sql.includes('UPDATE zernio_backfill_runs'))).toBe(true);
    expect(calls[2]!.sql).toContain('UPDATE responses');
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('Superseded 1 active response'));
  });

  it('reply text is canonicalized (BOM, NFC, CRLF stripped)', async () => {
    process.env.EXTERNAL_REPLY_IMPORT_ENABLED = 'true';
    const sql = makeSqlMock();
    const { tx, calls } = mkRecordingTx([
      // 1. SELECT matched rows → none (forces the import branch).
      () => [],
      // 2. INSERT INTO reviews … RETURNING id.
      () => [{ id: 'new-review-uuid' }],
      // 3. INSERT INTO responses.
      () => [],
      // 4. counter bump.
      () => [],
    ]);
    (sql as any).begin = vi.fn(async (cb: any) => cb(tx));
    const dirtyReply = '﻿Thanks!\r\nWe appreciate it.\r\n';
    const logger = mkLogger();
    await reconcileExternallyAnsweredReview(
      sql,
      mkReview({ reviewReply: { comment: dirtyReply, updateTime: '2026-04-02T00:00:00Z' } }),
      'B', 'A', 'L', logger as any,
    );
    // The response INSERT call binds the canonicalized reply 3× (response_text,
    // approved_text, original_draft_text).
    const responseInsert = calls[2]!;
    const stringValues = responseInsert.values.filter((v): v is string => typeof v === 'string');
    const canonicalized = stringValues.find((s) => s.includes('Thanks!'));
    expect(canonicalized).toBeDefined();
    expect(canonicalized!).not.toContain('﻿');
    expect(canonicalized!).not.toContain('\r');
    expect(canonicalized!).toContain('\n');
  });

  it('idempotent: re-running on same Zernio review is a no-op AND skips counter bump', async () => {
    process.env.EXTERNAL_REPLY_IMPORT_ENABLED = 'true';
    const sql = makeSqlMock();
    // Simulate the second run: the reviews row now exists (matched) AND a
    // 'posted' response already exists (NOT in active set). Today's flag-ON
    // behavior on this state goes through the "matched + no active" branch
    // and tries to INSERT a posted response, which is no-op'd by the partial
    // unique index (ON CONFLICT DO NOTHING).
    //
    // The Low-1 fix returns whether the INSERT actually fired and gates the
    // counter bump on it — so a no-op INSERT does NOT bump the counter
    // (preventing inflated metrics on retries).
    const logger = mkLogger();
    const { tx, calls } = mkRecordingTx([
      () => [{ id: 'rev-row-1', provider: 'zernio' }], // matched
      () => [],                                        // no active responses
      () => [],                                        // INSERT INTO responses RETURNING 1 — empty (ON CONFLICT fired)
      // (no counter-bump call expected — the gate skipped it)
    ]);
    (sql as any).begin = vi.fn(async (cb: any) => cb(tx));
    await reconcileExternallyAnsweredReview(sql, mkReview(), 'B', 'A', 'L', logger as any);

    // Only 3 calls — counter bump is skipped because INSERT was a no-op.
    expect(calls).toHaveLength(3);
    // The response INSERT must guard against duplicate 'posted' rows.
    const respInsert = calls[2]!;
    expect(respInsert.sql).toContain('INSERT INTO responses');
    expect(respInsert.sql).toContain('ON CONFLICT');
    expect(respInsert.sql).toContain("status = 'posted'");
    expect(respInsert.sql).toContain('DO NOTHING');
    expect(respInsert.sql).toContain('RETURNING 1');
    // Logger explains why no counter bump fired.
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('already imported'));
  });

  it('does not fire when reviewReply === null', async () => {
    process.env.EXTERNAL_REPLY_IMPORT_ENABLED = 'true';
    const sql = makeSqlMock();
    // The calling workers (ingest + backfill) only invoke this helper when
    // reviewReply !== null. We assert the helper itself does not crash if
    // that contract is violated AND does not insert anything when reviewReply
    // is null. Because reviewReply is null and the matched branch is empty,
    // we expect the import branch to be SKIPPED.
    const { tx, calls } = mkRecordingTx([
      // 1. SELECT matched rows → none.
      () => [],
    ]);
    (sql as any).begin = vi.fn(async (cb: any) => cb(tx));
    const logger = mkLogger();
    await reconcileExternallyAnsweredReview(
      sql,
      mkReview({ reviewReply: null }),
      'B', 'A', 'L', logger as any,
    );
    // Only the SELECT — no INSERTs.
    expect(calls).toHaveLength(1);
    expect(calls.every((c) => !c.sql.includes('INSERT INTO'))).toBe(true);
    expect(calls.every((c) => !c.sql.includes('UPDATE zernio_backfill_runs'))).toBe(true);
  });

  it('insertImportedReview INSERT includes sentiment columns derived from star rating', async () => {
    // A 5-star review (rating=5) → label='positive', source='deterministic_star_v1'.
    // Uses the no-match path (flag ON) which invokes insertImportedReview directly.
    process.env.EXTERNAL_REPLY_IMPORT_ENABLED = 'true';
    const sql = makeSqlMock();
    const { tx, calls } = mkRecordingTx([
      // 1. SELECT matched rows → none.
      () => [],
      // 2. INSERT INTO reviews … RETURNING id.
      () => [{ id: 'new-review-uuid' }],
      // 3. INSERT INTO responses.
      () => [{}],
      // 4. counter bump.
      () => [],
    ]);
    (sql as any).begin = vi.fn(async (cb: any) => cb(tx));
    const logger = mkLogger();
    await reconcileExternallyAnsweredReview(
      sql,
      // rating=5 maps to label='positive'
      mkReview({ rating: 5, starRating: 'FIVE' }),
      'B', 'A', 'L', logger as any,
    );

    const reviewInsert = calls[1]!;
    expect(reviewInsert.sql).toContain('INSERT INTO reviews');
    expect(reviewInsert.sql).toContain('sentiment_label');
    expect(reviewInsert.sql).toContain('sentiment_source');
    expect(reviewInsert.sql).toContain('sentiment_classified_at');
    // sentiment values are bound as parameters
    expect(reviewInsert.values).toContain('positive');
    expect(reviewInsert.values).toContain('deterministic_star_v1');
    // rating=5 → score = (5−3)/2 = 1
    expect(reviewInsert.values).toContain(1);
  });
});

// ── #675 Task 4 — consentedImport option ──────────────────────────────────
// D5: the consented Review import lane imports answered rows UNCONDITIONALLY;
// EXTERNAL_REPLY_IMPORT_ENABLED continues to govern only the live lane's
// posture. All tests below run with the flag unset/false to prove the
// `{ consentedImport: true }` option — not the flag — drives the behavior.
describe('reconcileExternallyAnsweredReview — consentedImport option (#675)', () => {
  const ORIGINAL_FLAG = process.env.EXTERNAL_REPLY_IMPORT_ENABLED;

  beforeEach(() => {
    vi.resetAllMocks();
    delete process.env.EXTERNAL_REPLY_IMPORT_ENABLED;
  });

  afterEach(() => {
    if (ORIGINAL_FLAG === undefined) {
      delete process.env.EXTERNAL_REPLY_IMPORT_ENABLED;
    } else {
      process.env.EXTERNAL_REPLY_IMPORT_ENABLED = ORIGINAL_FLAG;
    }
  });

  const mkReview = (overrides: Partial<ZernioReview> = {}): ZernioReview => ({
    id: 'rev-1',
    name: 'accounts/A/locations/L/reviews/rev-1',
    reviewer: { displayName: 'Jane', profilePhotoUrl: '', isAnonymous: false },
    rating: 5,
    starRating: 'FIVE',
    comment: 'Great!',
    createTime: '2026-04-01T00:00:00Z',
    updateTime: '2026-04-01T00:00:00Z',
    reviewReply: { comment: 'Thanks for the review!', updateTime: '2026-04-02T00:00:00Z' },
    ...overrides,
  });

  const mkTaggedResult = <T = unknown>(rows: T[]) => {
    const arr = rows as unknown as T[] & { count: number };
    arr.count = rows.length;
    return arr;
  };

  type Recorded = { sql: string; values: unknown[] };
  const mkRecordingTx = (handlers: Array<(rec: Recorded) => unknown[]>) => {
    const calls: Recorded[] = [];
    let idx = 0;
    const tx = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      const rec: Recorded = { sql: strings.join('?'), values };
      calls.push(rec);
      const handler = handlers[idx];
      idx += 1;
      const rows = handler ? handler(rec) : [];
      return Promise.resolve(mkTaggedResult(rows));
    });
    // Identity pass-through for openPhiReviewException's `db.json(...)` bind.
    (tx as unknown as { json: ReturnType<typeof vi.fn> }).json = vi.fn((v: unknown) => v);
    return { tx, calls };
  };

  it('(a) previously-unseen answered review + consentedImport:true → review row inserted + imported posted response inserted', async () => {
    const sql = makeSqlMock();
    const { tx, calls } = mkRecordingTx([
      () => [],                          // 1. SELECT matched rows → none.
      () => [{ id: 'new-review-uuid' }], // 2. INSERT INTO reviews … RETURNING id.
      () => [{}],                        // 3. INSERT INTO responses … RETURNING 1.
      () => [],                          // 4. UPDATE zernio_backfill_runs (counter bump).
    ]);
    (sql as any).begin = vi.fn(async (cb: any) => cb(tx));
    const logger = mkLogger();

    await reconcileExternallyAnsweredReview(
      sql, mkReview(), 'B', 'A', 'L', logger as any, { consentedImport: true },
    );

    expect(calls).toHaveLength(4);
    expect(calls[1]!.sql).toContain('INSERT INTO reviews');
    expect(calls[2]!.sql).toContain('INSERT INTO responses');
    expect(calls[2]!.sql).toContain("'posted'");
    expect(calls[3]!.sql).toContain('UPDATE zernio_backfill_runs');
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('Imported external reply'));
  });

  it('(b) matched row with no active responses + consentedImport:true → imported response inserted onto the existing row', async () => {
    const sql = makeSqlMock();
    const { tx, calls } = mkRecordingTx([
      () => [{ id: 'rev-row-1', provider: 'zernio' }], // 1. SELECT matched rows.
      () => [],                                        // 2. SELECT active responses → none.
      () => [{}],                                       // 3. INSERT INTO responses … RETURNING 1.
      () => [],                                        // 4. UPDATE zernio_backfill_runs (counter bump).
    ]);
    (sql as any).begin = vi.fn(async (cb: any) => cb(tx));
    const logger = mkLogger();

    await reconcileExternallyAnsweredReview(
      sql, mkReview(), 'B', 'A', 'L', logger as any, { consentedImport: true },
    );

    expect(calls).toHaveLength(4);
    expect(calls.every((c) => !c.sql.includes('INSERT INTO reviews'))).toBe(true);
    expect(calls[2]!.sql).toContain('INSERT INTO responses');
    expect(calls[2]!.values).toContain('rev-row-1');
    expect(calls[3]!.sql).toContain('UPDATE zernio_backfill_runs');
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('Imported external reply onto existing review'));
  });

  it('(c) no opts passed → existing silent no-op behavior preserved (regression guard)', async () => {
    const sql = makeSqlMock();
    const { tx, calls } = mkRecordingTx([
      () => [], // 1. SELECT matched rows → none.
    ]);
    (sql as any).begin = vi.fn(async (cb: any) => cb(tx));
    const logger = mkLogger();

    await reconcileExternallyAnsweredReview(sql, mkReview(), 'B', 'A', 'L', logger as any);

    expect(calls).toHaveLength(1);
    expect(calls.every((c) => !c.sql.includes('INSERT INTO'))).toBe(true);
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('previously-unseen'));
  });

  it('(e) matched row with active draft + PHI-flagged review text + consentedImport:true → PHI exception opened, no response insert', async () => {
    const sql = makeSqlMock();
    const { tx, calls } = mkRecordingTx([
      () => [{ id: 'rev-row-1', provider: 'zernio' }],                                     // 1. SELECT matched rows.
      () => [{ id: 'resp-1', status: 'pending_approval', approved_text: 'Different text' }], // 2. SELECT active responses (stale, non-matching).
      () => [{ id: 'resp-1' }],                                                             // 3. UPDATE responses (supersede).
      // 4. INSERT INTO review_exceptions — handler left undefined so it
      //    returns [] (mirrors the "already-open exception" shortcut used
      //    by the existing branch-2 PHI tests above).
    ]);
    (sql as any).begin = vi.fn(async (cb: any) => cb(tx));
    const logger = mkLogger();

    await reconcileExternallyAnsweredReview(
      sql,
      mkReview({ comment: 'Patient MRN 12345 needs diabetes treatment follow up' }),
      'B', 'A', 'L', logger as any, { consentedImport: true },
    );

    expect(calls).toHaveLength(4);
    expect(calls[3]!.sql).toContain('INSERT INTO review_exceptions');
    expect(calls.every((c) => !c.sql.includes('INSERT INTO responses'))).toBe(true);
    expect(calls.every((c) => !c.sql.includes('UPDATE zernio_backfill_runs'))).toBe(true);
    expect(JSON.stringify(calls[3])).not.toContain('MRN 12345');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Likely PHI detected'));
    expect(logger.warn).toHaveBeenCalledWith(expect.not.stringContaining('MRN 12345'));
  });

  it('(f) mixed protected + stale active responses + consentedImport:true → stale superseded, protected kept, NO imported response inserted', async () => {
    const sql = makeSqlMock();
    const { tx, calls } = mkRecordingTx([
      () => [{ id: 'rev-row-1', provider: 'zernio' }], // 1. SELECT matched rows.
      () => [                                          // 2. SELECT active responses.
        { id: 'resp-protected', status: 'approved', approved_text: 'Thanks for the review!' },
        { id: 'resp-stale', status: 'approved', approved_text: 'Old draft text' },
      ],
      () => [{ id: 'resp-stale' }],                     // 3. UPDATE responses (supersede stale only — protected is excluded).
    ]);
    (sql as any).begin = vi.fn(async (cb: any) => cb(tx));
    const logger = mkLogger();

    await reconcileExternallyAnsweredReview(
      sql, mkReview(), 'B', 'A', 'L', logger as any, { consentedImport: true },
    );

    expect(calls).toHaveLength(3);
    expect(calls[2]!.sql).toContain('UPDATE responses');
    expect(calls[2]!.values).toContainEqual(['resp-stale']);
    expect(calls.every((c) => !c.sql.includes('INSERT INTO responses'))).toBe(true);
    expect(calls.every((c) => !c.sql.includes('UPDATE zernio_backfill_runs'))).toBe(true);
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('Superseded 1 active response'));
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('Protected 1'));
  });
});

// ── #675 consented import — spec stubs (Tasks 2 & 4 flip these) ──────────
describe('consented import seams (#675)', () => {
  it('(d) stores the external posted response when a consented answered import supersedes an active draft', async () => {
    const sql = makeSqlMock();
    const mkTaggedResult = <T = unknown>(rows: T[]) => {
      const arr = rows as unknown as T[] & { count: number };
      arr.count = rows.length;
      return arr;
    };
    type Recorded = { sql: string; values: unknown[] };
    const calls: Recorded[] = [];
    const handlers: Array<() => unknown[]> = [
      () => [{ id: 'rev-row-1', provider: 'zernio' }],                                                  // 1. SELECT matched rows.
      () => [{ id: 'resp-1', status: 'pending_approval', approved_text: 'Draft text not sent yet' }],    // 2. SELECT active responses (stale draft).
      () => [{ id: 'resp-1' }],                                                                          // 3. UPDATE responses (supersede).
      () => [{}],                                                                                        // 4. INSERT INTO responses (imported posted reply).
      () => [],                                                                                          // 5. UPDATE zernio_backfill_runs (counter bump).
    ];
    let idx = 0;
    const tx = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ sql: strings.join('?'), values });
      const handler = handlers[idx];
      idx += 1;
      return Promise.resolve(mkTaggedResult(handler ? handler() : []));
    });
    (tx as unknown as { json: ReturnType<typeof vi.fn> }).json = vi.fn((v: unknown) => v);
    (sql as any).begin = vi.fn(async (cb: any) => cb(tx));

    const review: ZernioReview = {
      id: 'rev-1',
      name: 'accounts/A/locations/L/reviews/rev-1',
      reviewer: { displayName: 'Jane', profilePhotoUrl: '', isAnonymous: false },
      rating: 5,
      starRating: 'FIVE',
      comment: 'Great!',
      createTime: '2026-04-01T00:00:00Z',
      updateTime: '2026-04-01T00:00:00Z',
      reviewReply: { comment: 'Thanks for the review!', updateTime: '2026-04-02T00:00:00Z' },
    };
    const logger = mkLogger();

    await reconcileExternallyAnsweredReview(
      sql, review, 'B', 'A', 'L', logger as any, { consentedImport: true },
    );

    expect(calls).toHaveLength(5);
    expect(calls[2]!.sql).toContain('UPDATE responses');
    expect(calls[3]!.sql).toContain('INSERT INTO responses');
    expect(calls[3]!.sql).toContain("'posted'");
    expect(calls[4]!.sql).toContain('UPDATE zernio_backfill_runs');
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('Superseded 1 active response'));
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('Imported external reply'));
  });

  describe('liveIngestCutoff', () => {
    const ORIGINAL_GRACE = process.env.ZERNIO_RECENT_REVIEW_CONNECT_GRACE_MS;

    afterEach(() => {
      if (ORIGINAL_GRACE === undefined) {
        delete process.env.ZERNIO_RECENT_REVIEW_CONNECT_GRACE_MS;
      } else {
        process.env.ZERNIO_RECENT_REVIEW_CONNECT_GRACE_MS = ORIGINAL_GRACE;
      }
      resetWorkerConfigForTests();
    });

    it('honors configured ZERNIO_RECENT_REVIEW_CONNECT_GRACE_MS in liveIngestCutoff', () => {
      process.env.ZERNIO_RECENT_REVIEW_CONNECT_GRACE_MS = '120000';
      resetWorkerConfigForTests();

      const connectedAt = new Date('2026-05-10T06:28:15.000Z');
      const cutoff = liveIngestCutoff(connectedAt);

      // NOT the 5-minute default — the configured 120s grace.
      expect(cutoff).toEqual(new Date(connectedAt.getTime() - 120_000));
      expect(liveIngestCutoff(null)).toBeNull();
    });
  });
});
