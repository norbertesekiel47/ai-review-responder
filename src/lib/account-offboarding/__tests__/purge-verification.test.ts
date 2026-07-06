import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PURGE_VERIFICATION_TABLES,
  TABLE_DISPOSITIONS,
} from '../table-disposition';

interface QueryCall {
  text: string;
  values: unknown[];
}

const { calls, mockSql } = vi.hoisted(() => {
  const calls: QueryCall[] = [];
  const mockSql: any = vi.fn(async (strings: any, ...values: unknown[]) => {
    if (!Array.isArray(strings)) return [];
    const text = strings.join('?');
    calls.push({ text, values });
    return [{ violation_count: 0 }];
  });
  return { calls, mockSql };
});

vi.mock('../../db/server', () => ({
  sql: mockSql,
}));

import {
  absentByBusiness,
  PURGE_VERIFICATION_SQL_TABLES,
  verificationQuery,
  verifyAccountOffboardingPurge,
} from '../purge-verification';

describe('purge verification fail-closed guards', () => {
  const noopExec = (() => Promise.resolve([])) as unknown as Parameters<typeof verificationQuery>[2];

  it('throws for a table with no verification branch so inventory drift is caught, not silently passed', () => {
    expect(() => verificationQuery(
      'a_future_unclassified_table',
      {
        accountId: 'acct-1',
        offboardingId: 'off-1',
        currentOutboxId: null,
        authUserId: null,
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        zernioAccountIds: null,
        zernioProfileIds: null,
      } as unknown as Parameters<typeof verificationQuery>[1],
      noopExec,
    )).toThrow('missing_purge_verification_sql:a_future_unclassified_table');
  });

  it('throws for an absent-by-business table that is not on the allowlist', () => {
    expect(() => absentByBusiness('a_future_unclassified_table', 'acct-1', noopExec))
      .toThrow('missing_absent_by_business_sql:a_future_unclassified_table');
  });
});

describe('purge verification', () => {
  beforeEach(() => {
    calls.length = 0;
    mockSql.mockClear();
    mockSql.mockImplementation(async (strings: any, ...values: unknown[]) => {
      if (!Array.isArray(strings)) return [];
      const text = strings.join('?');
      calls.push({ text, values });
      return [{ violation_count: 0 }];
    });
  });

  it('has explicit verification SQL for every disposition table that requires purge verification', () => {
    const expected = PURGE_VERIFICATION_TABLES.map((entry) => entry.table).sort();
    expect(PURGE_VERIFICATION_SQL_TABLES.toSorted()).toEqual(expected);
  });

  it('reports only tables with remaining verification violations', async () => {
    mockSql.mockImplementation(async (strings: any, ...values: unknown[]) => {
      if (!Array.isArray(strings)) return [];
      const text = strings.join('?');
      calls.push({ text, values });
      if (text.includes('FROM responses')) return [{ violation_count: 2 }];
      if (text.includes('FROM approval_audit_log')) return [{ violation_count: 1 }];
      return [{ violation_count: 0 }];
    });

    const result = await verifyAccountOffboardingPurge({
      accountId: '00000000-0000-7000-8000-000000000001',
      offboardingId: '00000000-0000-7000-8000-000000000002',
    }, mockSql);

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        table: 'responses',
        purgeVerification: 'must_be_absent',
        violationCount: 2,
      }),
      expect.objectContaining({
        table: 'approval_audit_log',
        purgeVerification: 'must_be_scrubbed',
        violationCount: 1,
      }),
    ]);
  });

  it('uses explicit account, business, offboarding, and compliance retention scopes', async () => {
    await verifyAccountOffboardingPurge({
      accountId: '00000000-0000-7000-8000-000000000001',
      offboardingId: '00000000-0000-7000-8000-000000000002',
      currentOutboxId: '00000000-0000-7000-8000-000000000003',
      authUserId: 'auth-user-1',
      stripeCustomerId: 'cus_123',
      stripeSubscriptionId: 'sub_123',
      zernioAccountIds: ['zernio-account-1'],
      zernioProfileIds: ['zernio-profile-1'],
    }, mockSql);

    const sqlText = calls.map((call) => call.text).join('\n');
    expect(sqlText).toContain('WITH account_businesses AS');
    expect(sqlText).toContain('UNION ALL SELECT ?::text');
    expect(sqlText).toContain('UNION ALL SELECT UNNEST(?::text[])');
    expect(sqlText).toContain('FROM account_offboarding_tokens');
    expect(sqlText).toContain('google_maps_url IS NOT NULL');
    // D3 regression: verify the REAL approval_audit_log PII columns; never the
    // phantom columns approval_link_id / user_agent. Scoped to the
    // approval_audit_log query so a real user_agent column elsewhere can't mask it.
    const approvalVerify = calls.find((call) => call.text.includes('FROM approval_audit_log'));
    expect(approvalVerify?.text).toContain('response_text_at_approval IS NOT NULL');
    expect(approvalVerify?.text).toContain('token_hash IS NOT NULL');
    expect(approvalVerify?.text).not.toContain('approval_link_id');
    expect(approvalVerify?.text).not.toContain('user_agent');
    expect(sqlText).toContain("scope.value->>'type' = 'job_outbox_scrub_scope'");
    expect(sqlText).toContain("scope.value->>'type' = 'impersonation_session_scrub_scope'");
    expect(sqlText).toContain('jsonb_array_elements(ao.provider_dispositions)');
    // M1: analytics verification mirrors the FK-independent scrub, so a residual
    // raw-UUID distinct_id with no FK stays in scope and fails verification closed.
    expect(sqlText).toContain('distinct_id IN (?, ?)');
    expect(sqlText).not.toContain('digest(');
    expect(sqlText).not.toContain('SELECT *');
  });

  it('checks payload-control tables against the full raw identifier scope', async () => {
    await verifyAccountOffboardingPurge({
      accountId: '00000000-0000-7000-8000-000000000001',
      offboardingId: '00000000-0000-7000-8000-000000000002',
      currentOutboxId: '00000000-0000-7000-8000-000000000003',
      authUserId: 'auth-user-1',
      stripeCustomerId: 'cus_123',
      stripeSubscriptionId: 'sub_123',
      zernioAccountIds: ['zernio-account-1'],
      zernioProfileIds: ['zernio-profile-1'],
    }, mockSql);

    const payloadQueries = calls
      .filter((call) =>
        call.text.includes('FROM inbound_events') ||
        call.text.includes('FROM job_outbox')
      )
      .map((call) => call.text)
      .join('\n');

    expect(payloadQueries).toContain('offboarding_scope AS');
    expect(payloadQueries).toContain('job_outbox_id');
    expect(payloadQueries).toContain('job_outbox_scrub_scope AS');
    expect(payloadQueries).toContain('UNION ALL SELECT UNNEST(?::text[])');
    expect(payloadQueries).toContain('payload::text LIKE');
    expect(payloadQueries).toContain('last_error LIKE');
    expect(payloadQueries).toContain('length(btrim(s.identifier)) > 0');
    expect(payloadQueries).toContain('id <> ?::uuid');
    expect(payloadQueries).toContain("status NOT IN ('completed', 'failed')");
  });

  it('fails purge verification for any retained notification delivery linked to the account or its businesses', async () => {
    await verifyAccountOffboardingPurge({
      accountId: '00000000-0000-7000-8000-000000000001',
      offboardingId: '00000000-0000-7000-8000-000000000002',
    }, mockSql);

    const notificationQuery = calls.find((call) => call.text.includes('FROM notification_deliveries'));
    expect(notificationQuery?.text).toContain('account_id =');
    expect(notificationQuery?.text).toContain('business_id IN');
    expect(notificationQuery?.text).not.toContain("recipient <> '[redacted]'");
    expect(notificationQuery?.text).not.toContain('external_message_id IS NOT NULL');
  });

  it('does not silently add disposition tables without verification coverage', () => {
    const uniqueTables = new Set(TABLE_DISPOSITIONS.map((entry) => entry.table));
    expect(uniqueTables.size).toBe(TABLE_DISPOSITIONS.length);
    expect(PURGE_VERIFICATION_TABLES.length).toBeGreaterThan(20);
  });
});
