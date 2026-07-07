import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Sql } from 'postgres';

const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql } = await vi.hoisted(async () => {
  const { createMockSql } = await import('../../../__tests__/helpers/mock-sql');
  return { ...createMockSql() };
});

import { loadEscalationNoticeContext, type EscalationRow } from '../context';

const logger = { warn: vi.fn(), error: vi.fn() };

const ESCALATION: EscalationRow = {
  id: 'esc-1',
  status: 'escalated',
  esc_business_id: 'biz-1',
  account_id: 'acct-1',
  review_id: 'rev-1',
  triage_severity: 'high',
  triage_source: 'llm_triage_v1',
  triage_suggested_action: 'escalate',
  triage_issues: ['safety_or_health'],
  reviewer_name: 'Jane',
  star_rating: 1,
  review_text: 'terrible visit',
};

const BUSINESS = {
  account_id: 'acct-1',
  name: 'Acme Co',
  display_label: null,
  subscription_status: 'active',
  account_past_due_at: null,
  account_flags: {},
  archived_at: null,
  offboarding_id: null,
  offboarding_account_id: null,
  offboarding_mode: null,
  offboarding_status: null,
};

const INPUT = { escalationId: 'esc-1', businessId: 'biz-1' };

const load = () => loadEscalationNoticeContext(mockSql as unknown as Sql, INPUT, logger);

beforeEach(() => {
  resetMockSql();
  logger.warn.mockReset();
  logger.error.mockReset();
});

describe('loadEscalationNoticeContext', () => {
  it('fails with escalation_not_found when the escalation row is missing', async () => {
    sqlReturnQueue.push([]);

    const res = await load();

    expect(res).toEqual({ kind: 'fail', reason: 'escalation_not_found' });
    // Only the escalation query ran — never the business query.
    expect(sqlCalls).toHaveLength(1);
    expect(sqlCalls[0]!.text).toContain('FROM review_escalations');
  });

  it('fails with business_id_mismatch when the escalation belongs to another business', async () => {
    sqlReturnQueue.push([{ ...ESCALATION, esc_business_id: 'biz-OTHER' }]);

    const res = await load();

    expect(res).toEqual({ kind: 'fail', reason: 'business_id_mismatch' });
    expect(logger.error).toHaveBeenCalled();
    expect(sqlCalls).toHaveLength(1);
  });

  it('skips with already_resolved when the escalation is resolved', async () => {
    sqlReturnQueue.push([{ ...ESCALATION, status: 'resolved' }]);

    const res = await load();

    expect(res).toEqual({ kind: 'skip', reason: 'already_resolved' });
    expect(sqlCalls).toHaveLength(1);
  });

  it('still loads (ok) when the escalation is acknowledged — only resolved is moot', async () => {
    sqlReturnQueue.push([{ ...ESCALATION, status: 'acknowledged' }]);
    sqlReturnQueue.push([BUSINESS]);

    const res = await load();

    expect(res.kind).toBe('ok');
  });

  it('fails with business_not_found when the business row is missing', async () => {
    sqlReturnQueue.push([ESCALATION]);
    sqlReturnQueue.push([]);

    const res = await load();

    expect(res).toEqual({ kind: 'fail', reason: 'business_not_found' });
  });

  it('skips with archived_location when the business is archived', async () => {
    sqlReturnQueue.push([ESCALATION]);
    sqlReturnQueue.push([{ ...BUSINESS, archived_at: new Date() }]);

    const res = await load();

    expect(res).toEqual({ kind: 'skip', reason: 'archived_location' });
  });

  it('skips with offboarding when the account has a blocking offboarding', async () => {
    sqlReturnQueue.push([ESCALATION]);
    sqlReturnQueue.push([{
      ...BUSINESS,
      offboarding_id: 'off-1',
      offboarding_account_id: 'acct-1',
      offboarding_mode: 'delete_data',
      offboarding_status: 'tearing_down',
    }]);

    const res = await load();

    expect(res).toEqual({ kind: 'skip', reason: 'offboarding' });
  });

  it('returns ok with the escalation + business rows on the happy path', async () => {
    sqlReturnQueue.push([ESCALATION]);
    sqlReturnQueue.push([BUSINESS]);

    const res = await load();

    expect(res).toEqual({ kind: 'ok', escalation: ESCALATION, business: BUSINESS });
    // The escalation query joins reviews for the notice content and does NOT
    // select google_maps_url (no Google CTA on the escalation notice).
    expect(sqlCalls[0]!.text).toContain('JOIN reviews r ON r.id = e.review_id');
    expect(sqlCalls[1]!.text).not.toContain('google_maps_url');
  });
});
