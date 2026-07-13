import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Sql } from 'postgres';

const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql } = await vi.hoisted(async () => {
  const { createMockSql } = await import('../../../__tests__/helpers/mock-sql');
  return { ...createMockSql() };
});

import { loadPendingPostNoticeContext, type PendingPostResponseRow } from '../context';

const logger = { warn: vi.fn(), error: vi.fn() };

const DEADLINE = new Date('2026-07-09T18:00:00Z');

const RESPONSE: PendingPostResponseRow = {
  id: 'resp-1',
  status: 'approved',
  approval_method: 'auto_policy',
  resp_business_id: 'biz-1',
  review_id: 'rev-1',
  approved_text: 'Thanks for the kind words!',
  auto_post_scheduled_at: DEADLINE,
  deadline_passed: false,
  reviewer_name: 'Jane',
  star_rating: 5,
  review_text: 'great visit',
};

const BUSINESS = {
  account_id: 'acct-1',
  name: 'Acme Co',
  display_label: null,
  owner_email_bounced: false,
  subscription_status: 'active',
  account_past_due_at: null,
  account_flags: {},
  archived_at: null,
  offboarding_id: null,
  offboarding_account_id: null,
  offboarding_mode: null,
  offboarding_status: null,
};

const INPUT = { responseId: 'resp-1', businessId: 'biz-1' };

const load = () => loadPendingPostNoticeContext(mockSql as unknown as Sql, INPUT, logger);

beforeEach(() => {
  resetMockSql();
  logger.warn.mockReset();
  logger.error.mockReset();
});

describe('loadPendingPostNoticeContext', () => {
  it('fails with response_not_found when the response row is missing', async () => {
    sqlReturnQueue.push([]);

    const res = await load();

    expect(res).toEqual({ kind: 'fail', reason: 'response_not_found' });
    // Only the response query ran — never the business query.
    expect(sqlCalls).toHaveLength(1);
    expect(sqlCalls[0]!.text).toContain('FROM responses');
  });

  it('fails with business_id_mismatch when the response belongs to another business', async () => {
    sqlReturnQueue.push([{ ...RESPONSE, resp_business_id: 'biz-OTHER' }]);

    const res = await load();

    expect(res).toEqual({ kind: 'fail', reason: 'business_id_mismatch' });
    expect(logger.error).toHaveBeenCalled();
    expect(sqlCalls).toHaveLength(1);
  });

  it('skips with not_approved when the response was posted meanwhile (guard a)', async () => {
    sqlReturnQueue.push([{ ...RESPONSE, status: 'posted' }]);

    const res = await load();

    expect(res).toEqual({ kind: 'skip', reason: 'not_approved' });
    expect(sqlCalls).toHaveLength(1);
  });

  it('skips with not_approved when the response was vetoed back to pending_approval (guard a)', async () => {
    sqlReturnQueue.push([{ ...RESPONSE, status: 'pending_approval', approval_method: null }]);

    const res = await load();

    expect(res).toEqual({ kind: 'skip', reason: 'not_approved' });
  });

  it('skips with not_auto_policy when the approval is owner-made (guard a)', async () => {
    sqlReturnQueue.push([{ ...RESPONSE, approval_method: 'owner' }]);

    const res = await load();

    expect(res).toEqual({ kind: 'skip', reason: 'not_auto_policy' });
    expect(sqlCalls).toHaveLength(1);
  });

  it('skips with no_scheduled_deadline when auto_post_scheduled_at is NULL (guard b)', async () => {
    sqlReturnQueue.push([{ ...RESPONSE, auto_post_scheduled_at: null, deadline_passed: null }]);

    const res = await load();

    expect(res).toEqual({ kind: 'skip', reason: 'no_scheduled_deadline' });
  });

  it('skips with deadline_passed when the deadline already elapsed — stale backlog (guard b)', async () => {
    sqlReturnQueue.push([{ ...RESPONSE, deadline_passed: true }]);

    const res = await load();

    expect(res).toEqual({ kind: 'skip', reason: 'deadline_passed' });
    expect(sqlCalls).toHaveLength(1);
  });

  it('fails with approved_text_missing when the draft is unexpectedly NULL', async () => {
    sqlReturnQueue.push([{ ...RESPONSE, approved_text: null }]);

    const res = await load();

    expect(res).toEqual({ kind: 'fail', reason: 'approved_text_missing' });
    expect(logger.error).toHaveBeenCalled();
  });

  it('fails with business_not_found when the business row is missing', async () => {
    sqlReturnQueue.push([RESPONSE]);
    sqlReturnQueue.push([]);

    const res = await load();

    expect(res).toEqual({ kind: 'fail', reason: 'business_not_found' });
  });

  it('skips with archived_location when the business is archived', async () => {
    sqlReturnQueue.push([RESPONSE]);
    sqlReturnQueue.push([{ ...BUSINESS, archived_at: new Date() }]);

    const res = await load();

    expect(res).toEqual({ kind: 'skip', reason: 'archived_location' });
  });

  it('skips with offboarding when the account has a blocking offboarding', async () => {
    sqlReturnQueue.push([RESPONSE]);
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

  it('returns ok with the response + business rows on the happy path', async () => {
    sqlReturnQueue.push([RESPONSE]);
    sqlReturnQueue.push([BUSINESS]);

    const res = await load();

    expect(res).toEqual({ kind: 'ok', response: RESPONSE, business: BUSINESS });
    // The response query joins reviews for the notice content, selects the
    // draft + deadline, and computes staleness on the DB clock (NOW()).
    expect(sqlCalls[0]!.text).toContain('JOIN reviews r ON resp.review_id = r.id');
    expect(sqlCalls[0]!.text).toContain('approved_text');
    expect(sqlCalls[0]!.text).toContain('auto_post_scheduled_at');
    expect(sqlCalls[0]!.text).toMatch(/auto_post_scheduled_at <= NOW\(\)/);
    // The business query projects the bounce flag the dispatcher's email
    // pre-filter consumes (skip email for a known-bounced owner).
    expect(sqlCalls[1]!.text).toContain('owner_email_bounced');
  });
});
