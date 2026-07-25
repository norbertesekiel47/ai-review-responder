import { beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createMockSql } from '../../../../worker/__tests__/helpers/mock-sql';
import {
  deriveRunDisplayState,
  getAgentTeamSummary,
  getReviewTimeline,
} from '../read';

describe('deriveRunDisplayState', () => {
  const now = new Date('2026-07-13T12:00:00.000Z');

  it('renders a completed run as completed', () => {
    expect(
      deriveRunDisplayState(
        { status: 'completed', startedAt: '2026-07-13T11:00:00.000Z' },
        null,
        now,
      ),
    ).toBe('completed');
  });

  it('renders a failed run as failed', () => {
    expect(
      deriveRunDisplayState(
        { status: 'failed', startedAt: '2026-07-13T11:00:00.000Z' },
        null,
        now,
      ),
    ).toBe('failed');
  });

  it('renders a running draft awaiting approval as waiting on the owner', () => {
    expect(
      deriveRunDisplayState(
        { status: 'running', startedAt: '2026-07-13T11:00:00.000Z' },
        { status: 'pending_approval' },
        now,
      ),
    ).toBe('waiting_on_owner');
  });

  it('renders a running draft awaiting owner connection as waiting on the owner', () => {
    expect(
      deriveRunDisplayState(
        { status: 'running', startedAt: '2026-07-13T11:00:00.000Z' },
        { status: 'awaiting_owner_connect' },
        now,
      ),
    ).toBe('waiting_on_owner');
  });

  it('prioritizes waiting on the owner over stalled for an old run', () => {
    expect(
      deriveRunDisplayState(
        { status: 'running', startedAt: '2026-06-22T12:00:00.000Z' },
        { status: 'pending_approval' },
        now,
      ),
    ).toBe('waiting_on_owner');
  });

  it('renders a running run older than 48 hours as stalled', () => {
    expect(
      deriveRunDisplayState(
        { status: 'running', startedAt: '2026-07-11T11:59:59.999Z' },
        { status: 'posted' },
        now,
      ),
    ).toBe('stalled');
  });

  it('does not call a run stalled at the exact 48-hour boundary', () => {
    expect(
      deriveRunDisplayState(
        { status: 'running', startedAt: '2026-07-11T12:00:00.000Z' },
        null,
        now,
      ),
    ).toBe('in_progress');
  });

  it('renders a fresh running run as in progress', () => {
    expect(
      deriveRunDisplayState(
        { status: 'running', startedAt: '2026-07-13T11:00:00.000Z' },
        null,
        now,
      ),
    ).toBe('in_progress');
  });

  it('renders a scheduled auto-post as in progress', () => {
    expect(
      deriveRunDisplayState(
        { status: 'running', startedAt: '2026-07-13T11:00:00.000Z' },
        {
          status: 'approved',
          approvalMethod: 'auto_policy',
          autoPostScheduledAt: '2026-07-13T12:15:00.000Z',
        },
        now,
      ),
    ).toBe('in_progress');
  });
});

describe('getReviewTimeline', () => {
  const harness = createMockSql();

  beforeEach(() => {
    harness.resetMockSql();
  });

  it('returns null after the tenant-scoped review pre-read misses', async () => {
    harness.sqlReturnQueue.push([]);

    await expect(
      getReviewTimeline(harness.mockSql as unknown as Sql, {
        accountId: 'account-1',
        reviewId: 'review-1',
      }),
    ).resolves.toBeNull();

    expect(harness.sqlCalls).toHaveLength(1);
    expect(harness.sqlCalls[0]!.text).toMatch(/FROM reviews r\s+JOIN businesses b/);
    expect(harness.sqlCalls[0]!.text).toMatch(/r\.id = \?/);
    expect(harness.sqlCalls[0]!.text).toMatch(/b\.account_id = \?/);
    expect(harness.sqlCalls[0]!.text).toContain('b.archived_at IS NULL');
    expect(harness.sqlCalls[0]!.values).toEqual(['review-1', 'account-1']);
  });

  it('returns an honest empty timeline for a scoped legacy review', async () => {
    harness.sqlReturnQueue.push(
      [
        {
          id: 'review-1',
          star_rating: 4,
          reviewer_name: 'Ada',
          review_date: new Date('2026-07-10T09:30:00.000Z'),
          status: 'pending_approval',
        },
      ],
      [],
      [],
      [],
    );

    await expect(
      getReviewTimeline(harness.mockSql as unknown as Sql, {
        accountId: 'account-1',
        reviewId: 'review-1',
      }),
    ).resolves.toEqual({
      review: {
        id: 'review-1',
        rating: 4,
        reviewerName: 'Ada',
        submittedAt: '2026-07-10T09:30:00.000Z',
        status: 'pending_approval',
      },
      response: null,
      escalation: null,
      runs: [],
    });

    expect(harness.sqlCalls).toHaveLength(4);
    expect(harness.sqlCalls[1]!.text).toMatch(/FROM responses resp/);
    expect(harness.sqlCalls[1]!.text).toMatch(/b\.account_id = \?/);
    expect(harness.sqlCalls[2]!.text).toMatch(/FROM review_escalations e/);
    expect(harness.sqlCalls[2]!.text).toMatch(/e\.account_id = \?/);
    expect(harness.sqlCalls[3]!.text).toMatch(/FROM agent_runs ar/);
    expect(harness.sqlCalls[3]!.text).toContain('LIMIT 20');
  });

  it('batches steps and outcomes and maps stored attribution and JSONB fields', async () => {
    harness.sqlReturnQueue.push(
      [
        {
          id: 'review-1',
          star_rating: 5,
          reviewer_name: 'Grace',
          review_date: '2026-07-12T08:00:00.000Z',
          status: 'pending_approval',
        },
      ],
      [
        {
          id: 'response-1',
          status: 'pending_approval',
          approval_method: null,
          auto_post_scheduled_at: null,
          posted_at: null,
          response_text: 'Thanks, Grace!',
          version: 2,
        },
      ],
      [
        {
          id: 'escalation-1',
          status: 'acknowledged',
          triage_severity: 'high',
          triage_suggested_action: 'respond_and_escalate',
          created_at: '2026-07-12T08:02:00.000Z',
          acknowledged_at: '2026-07-12T08:05:00.000Z',
          resolved_at: null,
        },
      ],
      [
        {
          id: 'run-new',
          status: 'running',
          started_at: '2026-07-12T08:01:00.000Z',
          ended_at: null,
          error: null,
        },
        {
          id: 'run-old',
          status: 'failed',
          started_at: '2026-07-11T08:01:00.000Z',
          ended_at: '2026-07-11T08:03:00.000Z',
          error: '{"reason":"provider_terminal"}',
        },
      ],
      [
        {
          agent_run_id: 'run-new',
          step_index: 1,
          step_key: 'review_ingested',
          attributed_agent: 'system',
          status: 'completed',
          detail: '{"source":"zernio"}',
          latency_ms: 12,
          created_at: '2026-07-12T08:01:01.000Z',
        },
        {
          agent_run_id: 'run-new',
          step_index: 2,
          step_key: 'draft_generated',
          attributed_agent: 'guardian',
          status: 'completed',
          detail: { response_id: 'response-1' },
          latency_ms: null,
          created_at: '2026-07-12T08:01:02.000Z',
        },
        {
          agent_run_id: 'run-old',
          step_index: 1,
          step_key: 'policy_gate',
          attributed_agent: 'reply',
          status: 'failed',
          detail: '{}',
          latency_ms: 4,
          created_at: '2026-07-11T08:02:00.000Z',
        },
      ],
      [
        {
          agent_run_id: 'run-new',
          outcome_kind: 'reply_drafted',
          attributed_agent: 'insights',
          occurred_at: '2026-07-12T08:01:03.000Z',
        },
        {
          agent_run_id: 'run-old',
          outcome_kind: 'review_escalated',
          attributed_agent: 'guardian',
          occurred_at: '2026-07-11T08:02:01.000Z',
        },
      ],
    );

    const timeline = await getReviewTimeline(harness.mockSql as unknown as Sql, {
      accountId: 'account-1',
      reviewId: 'review-1',
    });

    expect(timeline?.response).toEqual({
      id: 'response-1',
      status: 'pending_approval',
      approvalMethod: null,
      autoPostScheduledAt: null,
      postedAt: null,
      responseText: 'Thanks, Grace!',
      version: 2,
    });
    expect(timeline?.escalation).toEqual({
      id: 'escalation-1',
      status: 'acknowledged',
      severity: 'high',
      suggestedAction: 'respond_and_escalate',
      createdAt: '2026-07-12T08:02:00.000Z',
      acknowledgedAt: '2026-07-12T08:05:00.000Z',
      resolvedAt: null,
    });
    expect(timeline?.runs).toHaveLength(2);
    expect(timeline?.runs[0]).toMatchObject({
      id: 'run-new',
      displayState: 'waiting_on_owner',
      error: null,
      steps: [
        expect.objectContaining({
          stepIndex: 1,
          attributedAgent: 'system',
          detail: { source: 'zernio' },
        }),
        expect.objectContaining({
          stepIndex: 2,
          attributedAgent: 'guardian',
          detail: { response_id: 'response-1' },
        }),
      ],
      outcomes: [
        {
          outcomeKind: 'reply_drafted',
          attributedAgent: 'insights',
          occurredAt: '2026-07-12T08:01:03.000Z',
        },
      ],
    });
    expect(timeline?.runs[1]).toMatchObject({
      id: 'run-old',
      displayState: 'failed',
      error: { reason: 'provider_terminal' },
    });

    expect(harness.sqlCalls).toHaveLength(6);
    expect(harness.sqlCalls[4]!.text).toMatch(/s\.agent_run_id = ANY\(\?::uuid\[\]\)/);
    expect(harness.sqlCalls[4]!.text).toContain('ORDER BY s.agent_run_id, s.step_index');
    expect(harness.sqlCalls[5]!.text).toMatch(/o\.agent_run_id = ANY\(\?::uuid\[\]\)/);
    expect(harness.sqlCalls[4]!.values[0]).toEqual(['run-new', 'run-old']);
    expect(harness.sqlCalls[5]!.values[0]).toEqual(['run-new', 'run-old']);
  });
});

describe('getAgentTeamSummary', () => {
  const harness = createMockSql();

  beforeEach(() => {
    harness.resetMockSql();
  });

  it('counts each posted reply once — reply_auto_posted is a qualifier, not an extra post', async () => {
    // mark-posted records BOTH reply_posted and reply_auto_posted for one
    // auto-policy post; only reply_posted may count or auto-posts double.
    harness.sqlReturnQueue.push([
      { attributed_agent: 'reply', outcome_kind: 'reply_posted', n: 2 },
      { attributed_agent: 'reply', outcome_kind: 'reply_auto_posted', n: 3 },
      { attributed_agent: 'guardian', outcome_kind: 'review_escalated', n: 4 },
      { attributed_agent: 'insights', outcome_kind: 'digest_sent', n: 5 },
      { attributed_agent: 'guardian', outcome_kind: 'reply_posted', n: 99 },
    ]);

    await expect(
      getAgentTeamSummary(
        harness.mockSql as unknown as Sql,
        { kind: 'account', accountId: 'account-1' },
        '30d',
      ),
    ).resolves.toEqual({ reply: 2, guardian: 4, insights: 5 });

    expect(harness.sqlCalls).toHaveLength(1);
    expect(harness.sqlCalls[0]!.text).toMatch(/FROM agent_outcomes o/);
    expect(harness.sqlCalls[0]!.text).toMatch(/o\.account_id = \?/);
    expect(harness.sqlCalls[0]!.text).not.toMatch(/o\.business_id = \?/);
    expect(harness.sqlCalls[0]!.text).toContain('COUNT(*)::int AS n');
    expect(harness.sqlCalls[0]!.values[0]).toBe('account-1');
    expect(harness.sqlCalls[0]!.values[1]).toBeInstanceOf(Date);
  });

  it('agent team summary accepts persisted Solicitation outcomes without changing displayed totals', async () => {
    harness.sqlReturnQueue.push([
      {
        attributed_agent: 'solicitation',
        outcome_kind: 'solicitation_batch_built',
        n: 7,
      },
      { attributed_agent: 'reply', outcome_kind: 'reply_posted', n: 2 },
      { attributed_agent: 'guardian', outcome_kind: 'review_escalated', n: 3 },
      { attributed_agent: 'insights', outcome_kind: 'digest_sent', n: 4 },
    ]);

    await expect(
      getAgentTeamSummary(
        harness.mockSql as unknown as Sql,
        { kind: 'account', accountId: 'account-1' },
        '30d',
      ),
    ).resolves.toEqual({ reply: 2, guardian: 3, insights: 4 });
  });

  it('adds the business filter for a location-scoped summary', async () => {
    harness.sqlReturnQueue.push([
      { attributed_agent: 'reply', outcome_kind: 'reply_posted', n: 1 },
    ]);

    await expect(
      getAgentTeamSummary(
        harness.mockSql as unknown as Sql,
        { kind: 'location', accountId: 'account-1', businessId: 'business-1' },
        '7d',
      ),
    ).resolves.toEqual({ reply: 1, guardian: 0, insights: 0 });

    expect(harness.sqlCalls).toHaveLength(1);
    expect(harness.sqlCalls[0]!.text).toMatch(/o\.account_id = \?/);
    expect(harness.sqlCalls[0]!.text).toMatch(/o\.business_id = \?/);
    expect(harness.sqlCalls[0]!.values).toEqual([
      'account-1',
      'business-1',
      expect.any(Date),
    ]);
  });
});
