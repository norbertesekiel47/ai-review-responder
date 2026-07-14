import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';

const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql } = await vi.hoisted(async () => {
  const { createMockSql } = await import('../../../__tests__/helpers/mock-sql');
  return createMockSql();
});

import { loadAutonomySuspendedNoticeContext } from '../context';

const logger = { warn: vi.fn(), error: vi.fn() };
const account = {
  account_id: 'acct-1', display_name: 'Acme Group', subscription_status: 'active',
  account_past_due_at: null, account_flags: {}, suspended_at: new Date(),
  offboarding_id: null, offboarding_account_id: null, offboarding_mode: null,
  offboarding_status: null, offboarding_failed_step: null,
  offboarding_access_ends_at: null, offboarding_teardown_started_at: null,
  offboarding_purge_after: null, offboarding_purge_started_at: null,
  offboarding_purge_cancelled_at: null,
};
const business = { business_id: 'biz-1', name: 'Main Cafe', display_label: null, owner_email_bounced: false };
const audit = { trigger: 'judge_flag', suspension_event_id: 'event-1' };
const input = { accountId: 'acct-1', suspensionEventId: 'event-1', trigger: 'judge_flag' as const };

beforeEach(() => { resetMockSql(); logger.warn.mockReset(); logger.error.mockReset(); });

describe('loadAutonomySuspendedNoticeContext', () => {
  it('fails when the account is absent', async () => {
    sqlReturnQueue.push([]);
    await expect(loadAutonomySuspendedNoticeContext(mockSql as unknown as Sql, input, logger))
      .resolves.toEqual({ kind: 'fail', reason: 'account_not_found' });
  });

  it('skips a stale event after autonomy was unsuspended', async () => {
    sqlReturnQueue.push([{ ...account, suspended_at: null }]);
    await expect(loadAutonomySuspendedNoticeContext(mockSql as unknown as Sql, input, logger))
      .resolves.toEqual({ kind: 'skip', reason: 'not_suspended' });
  });

  it('fails when the exact audit event is missing or mismatched', async () => {
    sqlReturnQueue.push([account], [business], []);
    await expect(loadAutonomySuspendedNoticeContext(mockSql as unknown as Sql, input, logger))
      .resolves.toEqual({ kind: 'fail', reason: 'suspension_audit_not_found' });
  });

  it('skips an older suspension event when a newer transition exists', async () => {
    sqlReturnQueue.push([account], [business], [audit], [{
      event_type: 'autonomy_suspended', suspension_event_id: 'event-2',
    }]);
    await expect(loadAutonomySuspendedNoticeContext(mockSql as unknown as Sql, input, logger))
      .resolves.toEqual({ kind: 'skip', reason: 'stale_suspension_event' });
  });

  it('returns account, primary business, and canonical reason on the current event', async () => {
    sqlReturnQueue.push([account], [business], [audit], [audit]);
    const result = await loadAutonomySuspendedNoticeContext(mockSql as unknown as Sql, input, logger);
    expect(result).toEqual({
      kind: 'ok', account, business, audit: {
        ...audit,
        reason: 'A safety review flagged a recently auto-posted reply.',
      },
    });
    expect(sqlCalls[0]!.text).toContain('WHERE a.id =');
    expect(sqlCalls[2]!.text).toContain('account_id =');
    expect(sqlCalls[2]!.text).toContain("event_type = 'autonomy_suspended'");
  });
});
