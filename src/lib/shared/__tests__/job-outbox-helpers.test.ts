import { describe, expect, it, vi } from 'vitest';

vi.mock('uuid', () => ({ v7: vi.fn(() => 'outbox-uuid') }));

vi.mock('@/lib/db/server', () => ({
  jsonb: (value: unknown) => value,
}));

import {
  enqueueAccountOffboardingEmail,
  enqueueAccountOffboardingReactivation,
  enqueueAutoPostNotice,
  enqueueGenerateResponse,
  enqueuePublishResponse,
  enqueueValidatePlaceId,
  normalizeGenerateResponsePayload,
} from '../job-outbox-helpers';
import { QUEUE_NAMES } from '../queue-names';

function createMockTx() {
  return vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => Promise.resolve([])) as any;
}

function sqlText(call: unknown[]): string {
  return (
    (call[0] as TemplateStringsArray)
      .join('?')
      // SQL line comments (the audit's trailing `-- topic-audit-ignore`
      // pragma) are lexer trivia to Postgres — strip them BEFORE collapsing
      // whitespace so the byte-for-byte predicate assertions compare the
      // expression Postgres actually parses.
      .replace(/--[^\n]*/g, '')
      .replace(/\s+/g, ' ')
  );
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

  it('enqueues auto_post_notice with the in-flight conflict guard matching migration 067 byte-for-byte', async () => {
    const tx = createMockTx();

    await enqueueAutoPostNotice(tx, {
      responseId: 'response-1',
      businessId: 'business-1',
      correlationId: 'corr-1',
    });

    expect(tx).toHaveBeenCalledOnce();
    const text = sqlText(tx.mock.calls[0]!);
    expect(text).toContain('INSERT INTO job_outbox');
    expect(text).toContain('ON CONFLICT (topic, aggregate_id)');
    // Byte-for-byte the predicate of idx_jo_auto_post_notice_inflight (067).
    expect(text).toContain(
      "WHERE topic = 'auto_post_notice' AND status IN ('pending', 'dispatching', 'dispatched')",
    );
    expect(tx.mock.calls[0]).toContain(QUEUE_NAMES.AUTO_POST_NOTICE);

    // snake_case payload (Codex R2 HIGH) — matches the worker's job.data reads.
    const payload = objectArgs(tx).find((arg) => arg.response_id === 'response-1');
    expect(payload).toEqual({
      response_id: 'response-1',
      business_id: 'business-1',
      correlation_id: 'corr-1',
    });
  });

  it('enqueues validate_place_id with the in-flight WHERE NOT EXISTS dedup guard', async () => {
    // Single owner of the validate_place_id dedup rule — used by the
    // onboarding routes and addLocationTransaction (URL-mode adds).
    const tx = createMockTx();
    tx.mockResolvedValueOnce([{ id: 'outbox-uuid' }]);

    const inserted = await enqueueValidatePlaceId(tx, {
      businessId: 'business-1',
      googleMapsUrl: 'https://maps.google.com/?q=Cafe+Test',
      correlationId: 'corr-1',
    });

    expect(inserted).toBe(true);
    expect(tx).toHaveBeenCalledOnce();
    const text = sqlText(tx.mock.calls[0]!);
    expect(text).toContain('INSERT INTO job_outbox');
    expect(text).toContain('WHERE NOT EXISTS');
    expect(text).toContain('jo.topic = ?');
    expect(text).toContain("jo.status IN ('pending', 'dispatching', 'dispatched')");
    expect(text).toContain('RETURNING id');
    // Topic is an interpolated QUEUE_NAMES value, not a template literal —
    // check the bound values, not the raw strings array. Appears twice: once
    // in the INSERT's SELECT list, once in the WHERE NOT EXISTS dedup guard.
    const topicValues = tx.mock.calls[0]!.slice(1).filter((v: unknown) => v === QUEUE_NAMES.VALIDATE_PLACE_ID);
    expect(topicValues).toHaveLength(2);

    const payload = objectArgs(tx).find((arg) => arg.business_id === 'business-1');
    expect(payload).toEqual({
      business_id: 'business-1',
      google_maps_url: 'https://maps.google.com/?q=Cafe+Test',
      correlation_id: 'corr-1',
    });
  });

  it('returns false when an in-flight validate_place_id row already exists (deduped)', async () => {
    const tx = createMockTx(); // resolves [] → WHERE NOT EXISTS suppressed the insert

    const inserted = await enqueueValidatePlaceId(tx, {
      businessId: 'business-1',
      googleMapsUrl: 'https://maps.google.com/?q=Cafe+Test',
    });

    expect(inserted).toBe(false);
    // correlation_id defaults to a fresh uuid when not supplied.
    const payload = objectArgs(tx).find((arg) => arg.business_id === 'business-1');
    expect(payload?.correlation_id).toBe('outbox-uuid');
  });

  it('dedupes account offboarding email outbox rows by offboarding id and email type', async () => {
    const tx = createMockTx();

    const first = await enqueueAccountOffboardingEmail(tx, {
      accountOffboardingId: 'offboarding-1',
      accountId: 'account-1',
      idempotencyKeyHash: 'idem-hash-1',
      correlationId: 'corr-1',
      emailType: 'delete_data_confirmation',
    });
    const second = await enqueueAccountOffboardingEmail(tx, {
      accountOffboardingId: 'offboarding-1',
      accountId: 'account-1',
      emailType: 'delete_data_confirmation',
    });
    const differentType = await enqueueAccountOffboardingEmail(tx, {
      accountOffboardingId: 'offboarding-1',
      accountId: 'account-1',
      emailType: 'keep_my_data_confirmation',
    });

    expect(first).toBe(second);
    expect(differentType).not.toBe(first);
    expect(tx).toHaveBeenCalledTimes(3);
    for (const call of tx.mock.calls) {
      expect(sqlText(call)).toContain('ON CONFLICT (id) DO NOTHING');
      expect(call).toContain(QUEUE_NAMES.ACCOUNT_OFFBOARDING_EMAIL);
    }
    const payloads = objectArgs(tx).filter((arg) => arg.account_offboarding_id === 'offboarding-1');
    expect(payloads).toContainEqual({
      account_offboarding_id: 'offboarding-1',
      account_id: 'account-1',
      email_type: 'delete_data_confirmation',
      idempotency_key_hash: 'idem-hash-1',
      correlation_id: 'corr-1',
    });
    expect(payloads).toContainEqual({
      account_offboarding_id: 'offboarding-1',
      account_id: 'account-1',
      email_type: 'keep_my_data_confirmation',
    });
  });

  it('dedupes account offboarding reactivation outbox rows by offboarding id and idempotency hash', async () => {
    const tx = createMockTx();

    const first = await enqueueAccountOffboardingReactivation(tx, {
      accountOffboardingId: 'offboarding-1',
      accountId: 'account-1',
      actorUserId: 'user-1',
      idempotencyKeyHash: 'idem-hash-1',
      requestId: 'req-1',
      ip: '203.0.113.10',
      userAgent: 'vitest',
      correlationId: 'req-1',
    });
    const second = await enqueueAccountOffboardingReactivation(tx, {
      accountOffboardingId: 'offboarding-1',
      accountId: 'account-1',
      actorUserId: 'user-1',
      idempotencyKeyHash: 'idem-hash-1',
    });

    expect(first).toBe(second);
    expect(tx).toHaveBeenCalledTimes(2);
    for (const call of tx.mock.calls) {
      expect(sqlText(call)).toContain('ON CONFLICT (id) DO NOTHING');
      expect(call).toContain(QUEUE_NAMES.ACCOUNT_OFFBOARDING_REACTIVATION);
    }
    const payloads = objectArgs(tx).filter((arg) => arg.account_offboarding_id === 'offboarding-1');
    expect(payloads).toContainEqual({
      account_offboarding_id: 'offboarding-1',
      account_id: 'account-1',
      actor_user_id: 'user-1',
      idempotency_key_hash: 'idem-hash-1',
      request_id: 'req-1',
      ip: '203.0.113.10',
      user_agent: 'vitest',
      correlation_id: 'req-1',
    });
    expect(payloads).toContainEqual({
      account_offboarding_id: 'offboarding-1',
      account_id: 'account-1',
      actor_user_id: 'user-1',
      idempotency_key_hash: 'idem-hash-1',
    });
  });
});
