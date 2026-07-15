import { describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createMockSql, type MockSqlHarness } from '../../../../worker/__tests__/helpers/mock-sql';

vi.mock('uuid', () => ({ v7: vi.fn(() => 'audit-uuid') }));

import { insertAuditLogAutoPolicy } from '../audit';

type TxClient = postgres.TransactionSql;

function asTx(harness: MockSqlHarness): TxClient {
  return harness.mockSql as unknown as TxClient;
}

function insertValues(harness: MockSqlHarness): unknown[] {
  return harness.mockSql.mock.calls[1]!.slice(1);
}

describe('insertAuditLogAutoPolicy', () => {
  it('writes an auto-policy audit row with no token, device, actor, or IP auth artifacts', async () => {
    const harness = createMockSql();
    harness.sqlReturnQueue.push([{ account_id: 'account-1' }]);
    harness.sqlReturnQueue.push([]);

    await insertAuditLogAutoPolicy(asTx(harness), {
      responseId: 'response-1',
      businessId: 'business-1',
      responseTextAtApproval: 'Approved response text',
      metadata: {
        policy_id: 'policy-1',
        policy_source: 'account_default',
        resolved_min_star: 5,
        star_rating: 5,
        origin_lane: 'live_ingest_new',
        provider_status: 'clean',
        review_content_hash_matched: true,
      },
    });

    expect(harness.mockSql).toHaveBeenCalledTimes(2);
    const values = insertValues(harness);
    expect(values[1]).toBe('response-1');
    expect(values[2]).toBe('business-1');
    expect(values[3]).toBe('account-1');
    expect(values[4]).toBeNull();
    expect(values[5]).toBeNull();
    expect(values[6]).toBe('auto_approved_by_policy');
    expect(values[7]).toBeNull();
    expect(values[9]).toBeNull();
    expect(values[10]).toBe('auto_policy');
    expect(values[11]).toBe('Approved response text');
  });

  it('persists only compact allowlisted metadata fields', async () => {
    const harness = createMockSql();
    harness.sqlReturnQueue.push([{ account_id: 'account-1' }]);
    harness.sqlReturnQueue.push([]);

    await insertAuditLogAutoPolicy(asTx(harness), {
      responseId: 'response-1',
      businessId: 'business-1',
      responseTextAtApproval: 'Approved response text',
      metadata: {
        policy_id: 'policy-1',
        resolved_min_star: 4,
        review_text: 'Raw customer review',
        response_text: 'Approved response text',
        review_content_hash: 'raw-review-hash',
        token: 'raw-token',
        policy: { auto_approve_min_star: 4 },
      } as never,
    });

    const metadata = insertValues(harness)[8] as Record<string, unknown>;
    expect(metadata).toEqual({
      policy_id: 'policy-1',
      resolved_min_star: 4,
    });
    expect(JSON.stringify(metadata)).not.toContain('Raw customer review');
    expect(JSON.stringify(metadata)).not.toContain('Approved response text');
    expect(JSON.stringify(metadata)).not.toContain('raw-review-hash');
    expect(JSON.stringify(metadata)).not.toContain('raw-token');
    expect(JSON.stringify(metadata)).not.toContain('auto_approve_min_star');
  });

  it('supports caller-provided auto-policy downgrade actions without a response snapshot', async () => {
    const harness = createMockSql();
    harness.sqlReturnQueue.push([{ account_id: 'account-1' }]);
    harness.sqlReturnQueue.push([]);

    await insertAuditLogAutoPolicy(asTx(harness), {
      responseId: 'response-1',
      businessId: 'business-1',
      action: 'auto_policy_revoked_by_kill_switch',
      responseTextAtApproval: null,
      metadata: {
        downgrade_reason: 'auto_approval_disabled',
        policy_id: 'policy-1',
        runtime_enabled: false,
        outbox_id: 'outbox-1',
        outbox_attempt: 3,
      },
    });

    const values = insertValues(harness);
    expect(values[6]).toBe('auto_policy_revoked_by_kill_switch');
    expect(values[8]).toEqual({
      downgrade_reason: 'auto_approval_disabled',
      outbox_attempt: 3,
      outbox_id: 'outbox-1',
      policy_id: 'policy-1',
      runtime_enabled: false,
    });
    expect(values[11]).toBeNull();
  });

  it('persists the dedicated tier-entitlement downgrade action without text', async () => {
    const harness = createMockSql();
    harness.sqlReturnQueue.push([{ account_id: 'account-1' }], []);

    await insertAuditLogAutoPolicy(asTx(harness), {
      responseId: 'response-1',
      businessId: 'business-1',
      action: 'auto_policy_revoked_tier_entitlement',
      responseTextAtApproval: null,
      metadata: { downgrade_reason: 'autopilot_entitlement_lost' },
    });

    const values = insertValues(harness);
    expect(values[6]).toBe('auto_policy_revoked_tier_entitlement');
    expect(values[8]).toEqual({ downgrade_reason: 'autopilot_entitlement_lost' });
    expect(values[11]).toBeNull();
  });

  it('rejects an auto_approved_by_policy row without a response snapshot', async () => {
    const harness = createMockSql();

    await expect(
      insertAuditLogAutoPolicy(asTx(harness), {
        responseId: 'response-1',
        businessId: 'business-1',
        action: 'auto_approved_by_policy',
        responseTextAtApproval: null,
      }),
    ).rejects.toThrow(/responseTextAtApproval is required/);

    // The guard fires before any DB work.
    expect(harness.mockSql).not.toHaveBeenCalled();
  });
});
