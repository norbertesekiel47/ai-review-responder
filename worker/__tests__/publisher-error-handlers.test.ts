import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/server', () => ({
  sql: { begin: vi.fn() },
  jsonb: (v: unknown) => v,
}));
vi.mock('@/lib/shared/outbox', () => ({
  markOutboxCompleted: vi.fn(),
}));

import {
  handlePublisherAuthErrorTerminal,
  handlePublisherPermanentErrorTerminal,
  PublisherTransientWithContext,
  ZernioReplyVerificationIndeterminateError,
} from '../jobs/publisher-error-handlers';
import { ZernioTransientError } from '@/lib/zernio/errors';

const mkLogger = () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() });

const mkTaggedResult = <T = unknown>(rows: T[]) => {
  const arr = rows as unknown as T[] & { count: number };
  arr.count = rows.length;
  return arr;
};

describe('PublisherTransientWithContext', () => {
  it('subclasses ZernioTransientError (instanceof check passes)', () => {
    const inner = new ZernioTransientError('timeout', { httpStatus: 504 });
    const wrapped = new PublisherTransientWithContext(inner, {
      response_id: 'R', business_id: 'B', account_id: 'A', location_id: 'L',
    });
    expect(wrapped instanceof ZernioTransientError).toBe(true);
  });

  it('forwards inner.kind to super constructor', () => {
    const inner = new ZernioTransientError('http_5xx', { httpStatus: 503 });
    const wrapped = new PublisherTransientWithContext(inner, {
      response_id: 'R', business_id: 'B', account_id: 'A', location_id: 'L',
    });
    expect(wrapped.kind).toBe('http_5xx');
  });

  it('exposes attemptContext for failed-hook unwrap', () => {
    const wrapped = new PublisherTransientWithContext(
      new ZernioTransientError('network_error', {}),
      { response_id: 'R', business_id: 'B', account_id: 'A', location_id: 'L' },
    );
    expect(wrapped.attemptContext).toEqual({
      response_id: 'R', business_id: 'B', account_id: 'A', location_id: 'L',
    });
  });
});

describe('ZernioReplyVerificationIndeterminateError', () => {
  it('carries meta with reason + ids + optional underlying_error', () => {
    const e = new ZernioReplyVerificationIndeterminateError({
      response_id: 'R', business_id: 'B', review_id: 'rev', account_id: 'A',
      location_id: 'L', zernio_review_id: 'zr', reason: 'verifier_unknown_error',
      underlying_error: 'connection refused',
    });
    expect(e.meta.reason).toBe('verifier_unknown_error');
    expect(e.meta.underlying_error).toBe('connection refused');
  });
});

describe('handlePublisherAuthErrorTerminal', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('happy path: response → awaiting_owner_connect, both notify rows enqueued', async () => {
    const { sql } = await import('@/lib/db/server');
    const { markOutboxCompleted } = await import('@/lib/shared/outbox');

    let callIdx = 0;
    const tx = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
      callIdx += 1;
      // Call 1: UPDATE zernio_connections RETURNING 1 → 1 row.
      if (callIdx === 1) return Promise.resolve(mkTaggedResult([{ '?column?': 1 }]));
      // Call 2: UPDATE responses RETURNING review_id → 1 row.
      if (callIdx === 2) return Promise.resolve(mkTaggedResult([{ review_id: 'rev-1' }]));
      // Calls 3-4: INSERT job_outbox rows.
      return Promise.resolve(mkTaggedResult([]));
    });
    (sql as any).begin = vi.fn(async (cb: any) => cb(tx));

    await handlePublisherAuthErrorTerminal({
      response_id: 'R', business_id: 'B', account_id: 'A', location_id: 'L',
      error_body: '401 expired', outboxId: 'outbox-1', outboxAttempt: 1, logger: mkLogger() as any,
    });

    expect(callIdx).toBe(4);  // disconnect, park, notify_reconnect, notify_lost
    expect(markOutboxCompleted).toHaveBeenCalledWith('outbox-1', 1);
  });

  it('skips notify enqueue when response already terminal', async () => {
    const { sql } = await import('@/lib/db/server');
    let callIdx = 0;
    const tx = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
      callIdx += 1;
      if (callIdx === 1) return Promise.resolve(mkTaggedResult([{ '?column?': 1 }]));
      // Park returns empty (already terminal)
      if (callIdx === 2) return Promise.resolve(mkTaggedResult([]));
      return Promise.resolve(mkTaggedResult([]));
    });
    (sql as any).begin = vi.fn(async (cb: any) => cb(tx));

    await handlePublisherAuthErrorTerminal({
      response_id: 'R', business_id: 'B', account_id: 'A', location_id: 'L',
      error_body: '401', outboxId: 'outbox-1', outboxAttempt: 1, logger: mkLogger() as any,
    });
    expect(callIdx).toBe(2);  // disconnect + park; no notify enqueues
  });

  it('connection already disconnected → still parks response + reconnect notify, but NO connection_lost', async () => {
    const { sql } = await import('@/lib/db/server');
    let callIdx = 0;
    const tx = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
      callIdx += 1;
      // Disconnect returns count=0 (already disconnected)
      if (callIdx === 1) return Promise.resolve(mkTaggedResult([]));
      if (callIdx === 2) return Promise.resolve(mkTaggedResult([{ review_id: 'rev-1' }]));
      return Promise.resolve(mkTaggedResult([]));
    });
    (sql as any).begin = vi.fn(async (cb: any) => cb(tx));

    await handlePublisherAuthErrorTerminal({
      response_id: 'R', business_id: 'B', account_id: 'A', location_id: 'L',
      error_body: '401', outboxId: 'outbox-1', outboxAttempt: 1, logger: mkLogger() as any,
    });
    expect(callIdx).toBe(3);  // disconnect (no-op), park, notify_reconnect — NOT lost
  });

  it('disconnect SQL pins by account_id AND location_id (regression for round-10)', async () => {
    const { sql } = await import('@/lib/db/server');
    let disconnectSql = '';
    let callIdx = 0;
    const tx = vi.fn((strings: TemplateStringsArray, ..._v: unknown[]) => {
      callIdx += 1;
      if (callIdx === 1) disconnectSql = strings.join('');
      return Promise.resolve(mkTaggedResult([]));
    });
    (sql as any).begin = vi.fn(async (cb: any) => cb(tx));

    await handlePublisherAuthErrorTerminal({
      response_id: 'R', business_id: 'B', account_id: 'A', location_id: 'L',
      error_body: '401', outboxId: 'outbox-1', outboxAttempt: 1, logger: mkLogger() as any,
    });
    expect(disconnectSql).toContain('zernio_account_id');
    expect(disconnectSql).toContain('zernio_location_id');
    expect(disconnectSql).toContain('disconnect_reason');
    expect(disconnectSql).toContain("'auth_error_on_publish'");
  });
});

describe('handlePublisherPermanentErrorTerminal', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('happy path: response → failed, exception inserted, admin notify enqueued', async () => {
    const { sql } = await import('@/lib/db/server');
    const { markOutboxCompleted } = await import('@/lib/shared/outbox');
    let callIdx = 0;
    const tx = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
      callIdx += 1;
      if (callIdx === 1) return Promise.resolve(mkTaggedResult([{ '?column?': 1 }]));
      if (callIdx === 2) return Promise.resolve(mkTaggedResult([{ id: 'exc-1' }]));
      return Promise.resolve(mkTaggedResult([]));
    });
    (sql as any).begin = vi.fn(async (cb: any) => cb(tx));

    await handlePublisherPermanentErrorTerminal({
      response_id: 'R', business_id: 'B', review_id: 'rev', endpoint_kind: 'publish_reply',
      http_status: 422, error_body: { msg: 'bad' },
      outboxId: 'outbox-1', outboxAttempt: 1, logger: mkLogger() as any,
    });

    expect(callIdx).toBe(3);  // mark failed, insert exception, notify enqueue
    expect(markOutboxCompleted).toHaveBeenCalledWith('outbox-1', 1);
  });

  it('skips work when response already terminal (count=0)', async () => {
    const { sql } = await import('@/lib/db/server');
    let callIdx = 0;
    const tx = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
      callIdx += 1;
      if (callIdx === 1) return Promise.resolve(mkTaggedResult([]));
      return Promise.resolve(mkTaggedResult([]));
    });
    (sql as any).begin = vi.fn(async (cb: any) => cb(tx));

    await handlePublisherPermanentErrorTerminal({
      response_id: 'R', business_id: 'B', review_id: 'rev', endpoint_kind: 'x',
      http_status: 422, error_body: {},
      outboxId: 'outbox-1', outboxAttempt: 1, logger: mkLogger() as any,
    });
    expect(callIdx).toBe(1);  // only the UPDATE; no exception INSERT
  });
});
