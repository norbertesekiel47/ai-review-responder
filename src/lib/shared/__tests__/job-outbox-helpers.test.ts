import { describe, expect, it, vi } from 'vitest';

vi.mock('uuid', () => ({ v7: vi.fn(() => 'outbox-uuid') }));

vi.mock('@/lib/db/server', () => ({
  jsonb: (value: unknown) => value,
}));

import {
  enqueueAutonomyAdminAlert,
  enqueueAutonomySuspendedNotice,
  enqueueAutoPostNotice,
  enqueueEscalationNotice,
  enqueueGenerateResponse,
  enqueueJudgeVerdict,
  enqueuePendingPostNotice,
  enqueuePublishResponse,
  enqueueStripeSubscriptionMirrorSync,
  enqueueValidatePlaceId,
  normalizeGenerateResponsePayload,
} from '../job-outbox-helpers';
import { QUEUE_NAMES } from '../queue-names';

function createMockTx() {
  const tx = vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => Promise.resolve([])) as any;
  // Production now binds JSONB via `tx.json(x)` (Postgres.js's identity JSONB
  // constructor) instead of the module-level `jsonb` helper. Mirror that with an
  // identity stub so the payload object flows through as a bound value and
  // objectArgs() still finds it — bind shape unchanged.
  tx.json = (value: unknown) => value;
  return tx;
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

  it('defaults publish_response available_at to NOW() via COALESCE when availableAt is omitted', async () => {
    // WS4 veto window: the delay column must be COALESCE(<bound param>, NOW())
    // with a NULL param so every pre-existing caller keeps immediate publish.
    const tx = createMockTx();

    await enqueuePublishResponse(tx, {
      responseId: 'response-1',
      businessId: 'business-1',
    });

    const text = sqlText(tx.mock.calls[0]!);
    expect(text).toContain('available_at');
    expect(text).toContain('COALESCE(?, NOW())');
    expect(tx.mock.calls[0]).toContain(null);
  });

  it('binds the supplied availableAt date for a delayed publish_response', async () => {
    const tx = createMockTx();
    const availableAt = new Date('2026-07-09T15:00:00.000Z');

    await enqueuePublishResponse(tx, {
      responseId: 'response-1',
      businessId: 'business-1',
      availableAt,
    });

    const text = sqlText(tx.mock.calls[0]!);
    expect(text).toContain('COALESCE(?, NOW())');
    expect(tx.mock.calls[0]).toContain(availableAt);
  });

  it('pins the publish_response ON CONFLICT predicate byte-for-byte (regression guard for the availableAt change)', async () => {
    const tx = createMockTx();

    await enqueuePublishResponse(tx, {
      responseId: 'response-1',
      businessId: 'business-1',
      availableAt: new Date('2026-07-09T15:00:00.000Z'),
    });

    const text = sqlText(tx.mock.calls[0]!);
    // Byte-for-byte the predicate of the publish in-flight partial unique
    // index — the WS4 available_at addition must not perturb it.
    expect(text).toContain('ON CONFLICT (topic, aggregate_id)');
    expect(text).toContain(
      "WHERE topic = 'publish_response' AND status IN ('pending', 'dispatching', 'dispatched') DO NOTHING",
    );
  });

  it('enqueues pending_post_notice with the in-flight conflict guard matching migration 074 byte-for-byte', async () => {
    const tx = createMockTx();

    const outboxId = await enqueuePendingPostNotice(tx, {
      responseId: 'response-1',
      businessId: 'business-1',
      correlationId: 'corr-1',
    });

    expect(outboxId).toBe('outbox-uuid');
    expect(tx).toHaveBeenCalledOnce();
    const text = sqlText(tx.mock.calls[0]!);
    expect(text).toContain('INSERT INTO job_outbox');
    expect(text).toContain('ON CONFLICT (topic, aggregate_id)');
    // Byte-for-byte the predicate of idx_jo_pending_post_notice_inflight (074).
    expect(text).toContain(
      "WHERE topic = 'pending_post_notice' AND status IN ('pending', 'dispatching', 'dispatched') DO NOTHING",
    );
    expect(tx.mock.calls[0]).toContain(QUEUE_NAMES.PENDING_POST_NOTICE);
    // Aggregate vocabulary: the notice is about a response.
    expect(tx.mock.calls[0]).toContain('response');
    expect(tx.mock.calls[0]).toContain('response-1');
    expect(tx.mock.calls[0]).toContain('pending');

    // ids-only snake_case payload — the deadline is NOT duplicated here (it
    // lives on responses.auto_post_scheduled_at, WS4 spec §2.7).
    const payload = objectArgs(tx).find((arg) => arg.response_id === 'response-1');
    expect(payload).toEqual({
      response_id: 'response-1',
      business_id: 'business-1',
      correlation_id: 'corr-1',
    });
  });

  it('omits correlation_id from pending_post_notice payload when not provided and honors a supplied outboxId', async () => {
    const tx = createMockTx();

    const outboxId = await enqueuePendingPostNotice(tx, {
      outboxId: 'caller-supplied-id',
      responseId: 'response-1',
      businessId: 'business-1',
    });

    expect(outboxId).toBe('caller-supplied-id');
    expect(tx.mock.calls[0]).toContain('caller-supplied-id');
    const payload = objectArgs(tx).find((arg) => arg.response_id === 'response-1');
    expect(payload).toEqual({ response_id: 'response-1', business_id: 'business-1' });
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

  it('enqueues escalation_notice with the in-flight conflict guard matching migration 073 byte-for-byte', async () => {
    const tx = createMockTx();

    await enqueueEscalationNotice(tx, {
      escalationId: 'esc-1',
      businessId: 'biz-1',
      correlationId: 'corr-1',
    });

    expect(tx).toHaveBeenCalledOnce();
    const text = sqlText(tx.mock.calls[0]!);
    expect(text).toContain('INSERT INTO job_outbox');
    expect(text).toContain('ON CONFLICT (topic, aggregate_id)');
    // Byte-for-byte the predicate of idx_jo_escalation_notice_inflight (073).
    expect(text).toContain(
      "WHERE topic = 'escalation_notice' AND status IN ('pending', 'dispatching', 'dispatched')",
    );
    expect(tx.mock.calls[0]).toContain(QUEUE_NAMES.ESCALATION_NOTICE);
    // Aggregate vocabulary: aggregate_type 'escalation' keyed by the escalation id.
    expect(tx.mock.calls[0]).toContain('escalation');
    expect(tx.mock.calls[0]).toContain('esc-1');

    const payload = objectArgs(tx).find((arg) => arg.escalation_id === 'esc-1');
    expect(payload).toEqual({
      escalation_id: 'esc-1',
      business_id: 'biz-1',
      correlation_id: 'corr-1',
    });
  });

  it('omits correlation_id from escalation_notice payload when not provided', async () => {
    const tx = createMockTx();

    await enqueueEscalationNotice(tx, { escalationId: 'esc-1', businessId: 'biz-1' });

    const payload = objectArgs(tx).find((arg) => arg.escalation_id === 'esc-1');
    expect(payload).toEqual({ escalation_id: 'esc-1', business_id: 'biz-1' });
  });

  it('enqueues judge_verdict with the migration-076 in-flight predicate and exact payload', async () => {
    const tx = createMockTx();

    const outboxId = await enqueueJudgeVerdict(tx, {
      responseId: 'response-1',
      businessId: 'business-1',
      accountId: 'account-1',
      correlationId: 'corr-1',
    });

    expect(outboxId).toBe('outbox-uuid');
    const text = sqlText(tx.mock.calls[0]!);
    expect(text).toContain(
      "WHERE topic = 'judge_verdict' AND status IN ('pending', 'dispatching', 'dispatched') DO NOTHING",
    );
    expect(tx.mock.calls[0]).toContain(QUEUE_NAMES.JUDGE_VERDICT);
    expect(tx.mock.calls[0]).toContain('response-1');
    const payload = objectArgs(tx).find((arg) => arg.response_id === 'response-1');
    expect(payload).toEqual({
      response_id: 'response-1',
      business_id: 'business-1',
      account_id: 'account-1',
      correlation_id: 'corr-1',
    });
  });

  it('enqueues autonomy_suspended_notice keyed by the suspension event', async () => {
    const tx = createMockTx();

    await enqueueAutonomySuspendedNotice(tx, {
      accountId: 'account-1',
      suspensionEventId: 'event-1',
      trigger: 'governor_edit_rate',
      correlationId: 'corr-1',
    });

    const text = sqlText(tx.mock.calls[0]!);
    expect(text).toContain(
      "WHERE topic = 'autonomy_suspended_notice' AND status IN ('pending', 'dispatching', 'dispatched') DO NOTHING",
    );
    expect(tx.mock.calls[0]).toContain(QUEUE_NAMES.AUTONOMY_SUSPENDED_NOTICE);
    expect(tx.mock.calls[0]).toContain('event-1');
    const payload = objectArgs(tx).find((arg) => arg.suspension_event_id === 'event-1');
    expect(payload).toEqual({
      account_id: 'account-1',
      suspension_event_id: 'event-1',
      trigger: 'governor_edit_rate',
      correlation_id: 'corr-1',
    });
  });

  it('enqueues autonomy_admin_alert keyed by the same event with evidence', async () => {
    const tx = createMockTx();
    const evidence = { rate: 0.6, numer: 3, denom: 5, windowDays: 7 } as const;

    await enqueueAutonomyAdminAlert(tx, {
      accountId: 'account-1',
      suspensionEventId: 'event-1',
      trigger: 'governor_judge_signal_rate',
      evidence,
    });

    const text = sqlText(tx.mock.calls[0]!);
    expect(text).toContain(
      "WHERE topic = 'autonomy_admin_alert' AND status IN ('pending', 'dispatching', 'dispatched') DO NOTHING",
    );
    expect(tx.mock.calls[0]).toContain(QUEUE_NAMES.AUTONOMY_ADMIN_ALERT);
    expect(tx.mock.calls[0]).toContain('event-1');
    const payload = objectArgs(tx).find((arg) => arg.suspension_event_id === 'event-1');
    expect(payload).toEqual({
      account_id: 'account-1',
      suspension_event_id: 'event-1',
      trigger: 'governor_judge_signal_rate',
      evidence,
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

  it('enqueues a dedicated account-scoped Stripe subscription mirror sync', async () => {
    const tx = createMockTx();

    const outboxId = await enqueueStripeSubscriptionMirrorSync(tx, 'account-1');

    expect(outboxId).toBe('outbox-uuid');
    expect(tx).toHaveBeenCalledOnce();
    const text = sqlText(tx.mock.calls[0]!);
    expect(text).toContain('INSERT INTO job_outbox');
    expect(tx.mock.calls[0]).toContain(QUEUE_NAMES.STRIPE_SUBSCRIPTION_MIRROR_SYNC);
    expect(tx.mock.calls[0]).toContain('account-1');
    expect(objectArgs(tx)).toContainEqual({ account_id: 'account-1' });
  });
});
