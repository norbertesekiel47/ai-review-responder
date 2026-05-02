import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/db/server', () => ({
  sql: { begin: vi.fn() },
  jsonb: (v: unknown) => v,
}));
vi.mock('@/lib/zernio/auth-error-fallback', () => ({
  applyIngestionAuthErrorFallback: vi.fn(),
}));
vi.mock('@/lib/shared/outbox', () => ({
  markOutboxCompleted: vi.fn(),
  markOutboxFailed: vi.fn(),
}));

import {
  handleZernioIngestError,
  reconcileExternallyAnsweredReview,
} from '../jobs/zernio-ingest-shared';
import {
  ZernioAuthError,
  ZernioPermanentError,
  ZernioTransientError,
  ZernioValidationError,
} from '@/lib/zernio/errors';
import type { ZernioReview } from '@/lib/zernio/types';

const mkLogger = () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() });
const ctx = { business_id: 'B', zernio_account_id: 'A', zernio_location_id: 'L' };

describe('handleZernioIngestError — dispatch matrix', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('ZernioAuthError → applyIngestionAuthErrorFallback + markOutboxFailed', async () => {
    const { applyIngestionAuthErrorFallback } = await import('@/lib/zernio/auth-error-fallback');
    const { markOutboxFailed } = await import('@/lib/shared/outbox');

    const err = new ZernioAuthError(401, 'expired token');
    await handleZernioIngestError(err, 'outbox-1', 1, ctx, mkLogger() as any);

    expect(applyIngestionAuthErrorFallback).toHaveBeenCalledWith('B', 'A', 'L', expect.stringContaining('401'));
    expect(markOutboxFailed).toHaveBeenCalledWith('outbox-1', 'zernio_auth_error_on_ingest', 1);
  });

  it('ZernioPermanentError → markOutboxFailed permanent', async () => {
    const { markOutboxFailed } = await import('@/lib/shared/outbox');
    const err = new ZernioPermanentError('500 fatal', {});
    await handleZernioIngestError(err, 'outbox-1', 1, ctx, mkLogger() as any);
    expect(markOutboxFailed).toHaveBeenCalledWith('outbox-1', expect.stringContaining('zernio_permanent_error'), 1);
  });

  it('ZernioValidationError → markOutboxFailed permanent', async () => {
    const { markOutboxFailed } = await import('@/lib/shared/outbox');
    const err = new ZernioValidationError('bad_payload', { raw: 'data' });
    await handleZernioIngestError(err, 'outbox-1', 1, ctx, mkLogger() as any);
    expect(markOutboxFailed).toHaveBeenCalledWith('outbox-1', expect.stringContaining('zernio_validation_error'), 1);
  });

  it('ZernioTransientError → rethrow', async () => {
    await expect(
      handleZernioIngestError(
        new ZernioTransientError('timeout', {}),
        'outbox-1', 1, ctx, mkLogger() as any,
      ),
    ).rejects.toBeInstanceOf(ZernioTransientError);
  });

  it('unknown Error → rethrow', async () => {
    await expect(
      handleZernioIngestError(
        new Error('boom'), 'outbox-1', 1, ctx, mkLogger() as any,
      ),
    ).rejects.toThrow('boom');
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
    const { sql } = await import('@/lib/db/server');
    const tx = vi.fn(() => Promise.resolve(mkTaggedResult([])));
    (sql as any).begin = vi.fn(async (cb: any) => cb(tx));
    const logger = mkLogger();
    await reconcileExternallyAnsweredReview(mkReview(), 'B', 'A', 'L', logger as any);
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('previously-unseen'));
  });

  it('all-protected (canonicalized text matches all active responses) → no supersession', async () => {
    const { sql } = await import('@/lib/db/server');
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
    await reconcileExternallyAnsweredReview(mkReview(), 'B', 'A', 'L', logger as any);
    // Only 2 tx calls: SELECT matchedRows + SELECT activeResponses. NO UPDATE.
    expect(callIdx).toBe(2);
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('matches every active response'));
  });

  it('all-stale (no active response matches external reply) → supersedes all', async () => {
    const { sql } = await import('@/lib/db/server');
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
    await reconcileExternallyAnsweredReview(mkReview(), 'B', 'A', 'L', logger as any);
    expect(callIdx).toBe(3);  // SELECT matched, SELECT active, UPDATE supersede
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('Superseded 1 active response'));
  });

  it('pending_approval response (approved_text=NULL) is always superseded when external reply detected', async () => {
    const { sql } = await import('@/lib/db/server');
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
    await reconcileExternallyAnsweredReview(mkReview(), 'B', 'A', 'L', logger as any);
    expect(callIdx).toBe(3);
  });

  it('SQL filter for active responses excludes awaiting_manual_post (decommissioned status)', async () => {
    const { sql } = await import('@/lib/db/server');
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
    await reconcileExternallyAnsweredReview(mkReview(), 'B', 'A', 'L', mkLogger() as any);
    expect(activeResponseSql).not.toContain('awaiting_manual_post');
    expect(activeResponseSql).toContain('pending_approval');
    expect(activeResponseSql).toContain('approved');
    expect(activeResponseSql).toContain('edited');
    expect(activeResponseSql).toContain('awaiting_owner_connect');
  });
});

describe('reconcileExternallyAnsweredReview — flag-gated import branches', () => {
  const ORIGINAL_FLAG = process.env.EDIT_EXISTING_REPLIES_ENABLED;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    if (ORIGINAL_FLAG === undefined) {
      delete process.env.EDIT_EXISTING_REPLIES_ENABLED;
    } else {
      process.env.EDIT_EXISTING_REPLIES_ENABLED = ORIGINAL_FLAG;
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
    return { tx, calls };
  };

  it('flag OFF + no-match: silent no-op (today\'s behavior unchanged)', async () => {
    delete process.env.EDIT_EXISTING_REPLIES_ENABLED;
    const { sql } = await import('@/lib/db/server');
    const { tx, calls } = mkRecordingTx([
      // 1. SELECT matched rows → none.
      () => [],
    ]);
    (sql as any).begin = vi.fn(async (cb: any) => cb(tx));
    const logger = mkLogger();
    await reconcileExternallyAnsweredReview(mkReview(), 'B', 'A', 'L', logger as any);
    // Only 1 SELECT — no INSERTs at all.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain('SELECT');
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('previously-unseen'));
  });

  it('flag ON + no-match: INSERTs reviews row + posted response + bumps counter', async () => {
    process.env.EDIT_EXISTING_REPLIES_ENABLED = 'true';
    const { sql } = await import('@/lib/db/server');
    const { tx, calls } = mkRecordingTx([
      // 1. SELECT matched rows → none.
      () => [],
      // 2. INSERT INTO reviews … RETURNING id.
      () => [{ id: 'new-review-uuid' }],
      // 3. INSERT INTO responses (no RETURNING).
      () => [],
      // 4. UPDATE zernio_backfill_runs … (counter bump).
      () => [],
    ]);
    (sql as any).begin = vi.fn(async (cb: any) => cb(tx));
    const logger = mkLogger();
    await reconcileExternallyAnsweredReview(mkReview(), 'B', 'A', 'L', logger as any);

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

  it('flag ON + matched but no active responses: INSERTs response only, version > 1 if prior terminals exist', async () => {
    process.env.EDIT_EXISTING_REPLIES_ENABLED = 'true';
    const { sql } = await import('@/lib/db/server');
    const { tx, calls } = mkRecordingTx([
      // 1. SELECT matched rows → 1 row.
      () => [{ id: 'rev-row-1', provider: 'zernio' }],
      // 2. SELECT active responses → none (prior 'failed' is terminal, excluded).
      () => [],
      // 3. INSERT INTO responses (version is computed via MAX subquery server-side).
      () => [],
      // 4. UPDATE zernio_backfill_runs … (counter bump).
      () => [],
    ]);
    (sql as any).begin = vi.fn(async (cb: any) => cb(tx));
    const logger = mkLogger();
    await reconcileExternallyAnsweredReview(mkReview(), 'B', 'A', 'L', logger as any);

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

  it('flag ON + matched WITH active response: today\'s supersede/protect logic, no new INSERTs, no counter bump', async () => {
    process.env.EDIT_EXISTING_REPLIES_ENABLED = 'true';
    const { sql } = await import('@/lib/db/server');
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
    await reconcileExternallyAnsweredReview(mkReview(), 'B', 'A', 'L', logger as any);

    expect(calls).toHaveLength(3);
    // Existing supersede behavior preserved — no INSERTs added.
    expect(calls.every((c) => !c.sql.includes('INSERT INTO reviews'))).toBe(true);
    expect(calls.every((c) => !c.sql.includes('INSERT INTO responses'))).toBe(true);
    expect(calls.every((c) => !c.sql.includes('UPDATE zernio_backfill_runs'))).toBe(true);
    expect(calls[2]!.sql).toContain('UPDATE responses');
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('Superseded 1 active response'));
  });

  it('reply text is canonicalized (BOM, NFC, CRLF stripped)', async () => {
    process.env.EDIT_EXISTING_REPLIES_ENABLED = 'true';
    const { sql } = await import('@/lib/db/server');
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

  it('idempotent: re-running on same Zernio review is a no-op', async () => {
    process.env.EDIT_EXISTING_REPLIES_ENABLED = 'true';
    const { sql } = await import('@/lib/db/server');
    // Simulate the second run: the reviews row now exists (matched) AND a
    // 'posted' response already exists (NOT in active set). Today's flag-ON
    // behavior on this state goes through the "matched + no active" branch
    // and tries to INSERT a posted response, which is no-op'd by the partial
    // unique index (ON CONFLICT DO NOTHING). The counter bump still runs but
    // touches 0 rows in the per-webhook ingest-worker case (no active backfill).
    //
    // To assert idempotency at the SQL level we verify the response INSERT
    // uses the partial unique index ON CONFLICT clause. A real pg test would
    // verify counts; here we assert the guard is in place.
    const { tx, calls } = mkRecordingTx([
      () => [{ id: 'rev-row-1', provider: 'zernio' }], // matched
      () => [],                                        // no active responses
      () => [],                                        // INSERT INTO responses (ON CONFLICT DO NOTHING)
      () => [],                                        // counter bump
    ]);
    (sql as any).begin = vi.fn(async (cb: any) => cb(tx));
    await reconcileExternallyAnsweredReview(mkReview(), 'B', 'A', 'L', mkLogger() as any);

    // The response INSERT must guard against duplicate 'posted' rows.
    const respInsert = calls[2]!;
    expect(respInsert.sql).toContain('INSERT INTO responses');
    expect(respInsert.sql).toContain('ON CONFLICT');
    expect(respInsert.sql).toContain("status = 'posted'");
    expect(respInsert.sql).toContain('DO NOTHING');
  });

  it('does not fire when reviewReply === null', async () => {
    process.env.EDIT_EXISTING_REPLIES_ENABLED = 'true';
    const { sql } = await import('@/lib/db/server');
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
      mkReview({ reviewReply: null }),
      'B', 'A', 'L', logger as any,
    );
    // Only the SELECT — no INSERTs.
    expect(calls).toHaveLength(1);
    expect(calls.every((c) => !c.sql.includes('INSERT INTO'))).toBe(true);
    expect(calls.every((c) => !c.sql.includes('UPDATE zernio_backfill_runs'))).toBe(true);
  });
});
