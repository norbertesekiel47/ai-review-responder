import { describe, expect, it, vi } from 'vitest';

vi.mock('uuid', () => ({ v7: vi.fn(() => 'outbox-uuid') }));

vi.mock('@/lib/db/server', () => ({
  jsonb: (value: unknown) => value,
}));

import {
  enqueueGenerateResponse,
  enqueuePublishResponse,
  normalizeGenerateResponsePayload,
} from '../job-outbox-helpers';
import { QUEUE_NAMES } from '../queue-names';

function createMockTx() {
  return vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => Promise.resolve([])) as any;
}

function sqlText(call: unknown[]): string {
  return (call[0] as TemplateStringsArray).join('?').replace(/\s+/g, ' ');
}

function objectArgs(tx: ReturnType<typeof createMockTx>): Record<string, unknown>[] {
  return tx.mock.calls
    .flat()
    .filter(
      (arg: unknown): arg is Record<string, unknown> =>
        !!arg && typeof arg === 'object' && !Array.isArray(arg),
    );
}

describe('normalizeGenerateResponsePayload', () => {
  it('accepts legacy missing origin lane and normalizes suppress_notification strictly', () => {
    expect(
      normalizeGenerateResponsePayload({
        review_id: 'review-1',
        business_id: 'business-1',
        version: 1,
        suppress_notification: 'true',
        extra_key: 'allowed',
      }),
    ).toEqual({
      reviewId: 'review-1',
      businessId: 'business-1',
      version: 1,
      suppressNotification: false,
      correlationId: undefined,
      originLane: null,
      unknownOriginLane: undefined,
    });
  });

  it('returns the typed origin lane for known lane values', () => {
    expect(
      normalizeGenerateResponsePayload({
        review_id: 'review-1',
        business_id: 'business-1',
        version: 2,
        suppress_notification: true,
        correlation_id: 'corr-1',
        origin_lane: 'live_ingest_new',
      }),
    ).toEqual({
      reviewId: 'review-1',
      businessId: 'business-1',
      version: 2,
      suppressNotification: true,
      correlationId: 'corr-1',
      originLane: 'live_ingest_new',
      unknownOriginLane: undefined,
    });
  });

  it('fails closed while returning a sanitized unknown non-empty lane', () => {
    expect(
      normalizeGenerateResponsePayload({
        review_id: 'review-1',
        business_id: 'business-1',
        version: 1,
        origin_lane: ' live ingest:surprise! ',
      }),
    ).toMatchObject({
      originLane: null,
      unknownOriginLane: 'live_ingest_surprise_',
    });
  });

  it('preserves required field fail-fast validation', () => {
    expect(() => normalizeGenerateResponsePayload({ business_id: 'business-1', version: 1 })).toThrow(
      /review_id/,
    );
    expect(() => normalizeGenerateResponsePayload({ review_id: 'review-1', version: 1 })).toThrow(
      /business_id/,
    );
    expect(() => normalizeGenerateResponsePayload({ review_id: 'review-1', business_id: 'business-1' })).toThrow(
      /version/,
    );
  });
});

describe('job outbox helpers', () => {
  it('enqueues generate_response with required origin lane and jsonb payload', async () => {
    const tx = createMockTx();

    await enqueueGenerateResponse(tx, {
      reviewId: 'review-1',
      businessId: 'business-1',
      version: 1,
      originLane: 'live_ingest_new',
      correlationId: 'corr-1',
      suppressNotification: true,
    });

    expect(tx).toHaveBeenCalledOnce();
    const text = sqlText(tx.mock.calls[0]!);
    expect(text).toContain('INSERT INTO job_outbox');
    expect(text).not.toContain('ON CONFLICT');

    expect(tx.mock.calls[0]).toContain(QUEUE_NAMES.GENERATE_RESPONSE);
    const payload = objectArgs(tx).find((arg) => arg.review_id === 'review-1');
    expect(payload).toEqual({
      review_id: 'review-1',
      business_id: 'business-1',
      version: 1,
      origin_lane: 'live_ingest_new',
      correlation_id: 'corr-1',
      suppress_notification: true,
    });
  });

  it('enqueues publish_response identifiers only with the in-flight conflict guard', async () => {
    const tx = createMockTx();

    await enqueuePublishResponse(tx, {
      responseId: 'response-1',
      businessId: 'business-1',
      correlationId: 'corr-1',
    });

    expect(tx).toHaveBeenCalledOnce();
    const text = sqlText(tx.mock.calls[0]!);
    expect(text).toContain('INSERT INTO job_outbox');
    expect(text).toContain('ON CONFLICT (topic, aggregate_id)');
    expect(text).toContain(
      "WHERE topic = 'publish_response' AND status IN ('pending', 'dispatching', 'dispatched')",
    );
    expect(tx.mock.calls[0]).toContain(QUEUE_NAMES.PUBLISH_RESPONSE);

    const payload = objectArgs(tx).find((arg) => arg.response_id === 'response-1');
    expect(payload).toEqual({
      response_id: 'response-1',
      business_id: 'business-1',
      correlation_id: 'corr-1',
    });
  });
});
