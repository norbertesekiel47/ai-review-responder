import { describe, it, expect, vi, beforeEach } from 'vitest';

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

  it('SQL filter excludes awaiting_manual_post status (regression for §6.12b)', async () => {
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
