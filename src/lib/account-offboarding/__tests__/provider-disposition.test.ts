import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSql, mockJsonb, txCalls, txResults, mockTx } = vi.hoisted(() => {
  const txCalls: { text: string; values: unknown[] }[] = [];
  const txResults: unknown[] = [];
  const mockTx = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    txCalls.push({ text: strings.join('?'), values });
    return Promise.resolve(txResults.shift() ?? Object.assign([], { count: 1 }));
  });
  const mockSql: any = vi.fn();
  mockSql.begin = vi.fn(async (cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx));
  return {
    mockSql,
    mockJsonb: vi.fn((value: unknown) => ({ __jsonb: value })),
    txCalls,
    txResults,
    mockTx,
  };
});

const { mockWriteAccountAuditLog } = vi.hoisted(() => ({
  mockWriteAccountAuditLog: vi.fn(),
}));

vi.mock('@/lib/db/server', () => ({
  sql: mockSql,
  jsonb: mockJsonb,
}));

vi.mock('@/lib/audit/log', () => ({
  writeAccountAuditLog: mockWriteAccountAuditLog,
}));

import {
  buildAdminProviderDispositionRecord,
  hasConcreteAdminProviderDisposition,
  ProviderDispositionError,
  recordProviderDisposition,
} from '../provider-disposition';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const OFFBOARDING_ID = '22222222-2222-4222-8222-222222222222';
const ADMIN_ID = '33333333-3333-4333-8333-333333333333';
const RAW_RESOURCE_REFERENCE = 'zernio-account-secret-provider-id-123';
const RESOURCE_HASH = createHash('sha256').update(RAW_RESOURCE_REFERENCE).digest('hex');

function offboardingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: OFFBOARDING_ID,
    account_id: ACCOUNT_ID,
    mode: 'delete_data',
    status: 'failed',
    failed_step: 'teardown',
    terminal_at: null,
    purge_after: '2026-07-01T12:00:00.000Z',
    purge_cancelled_at: null,
    stripe_step: 'success',
    zernio_accounts_step: 'failed',
    zernio_profiles_step: 'not_applicable',
    location_archival_step: 'success',
    provider_dispositions: [],
    ...overrides,
  };
}

describe('buildAdminProviderDispositionRecord', () => {
  it('creates a concrete admin provider disposition and hashes the resource reference', () => {
    const record = buildAdminProviderDispositionRecord(
      {
        provider: 'zernio',
        resourceType: 'account',
        resourceReference: RAW_RESOURCE_REFERENCE,
        adminUserId: ADMIN_ID,
        reason: 'Zernio support confirmed remote account teardown with "client_secret":"sensitive-value".',
        ticket: '"api_key":"secret-ticket-key"',
        offboardingId: OFFBOARDING_ID,
      },
      new Date('2026-06-07T12:00:00.000Z'),
    );

    expect(record).toEqual({
      type: 'admin_provider_disposition',
      provider: 'zernio',
      resource_type: 'account',
      scrubbed_resource_reference: `sha256:${RESOURCE_HASH}`,
      admin_actor_user_id: ADMIN_ID,
      reason: 'Zernio support confirmed remote account teardown with client_secret=[redacted].',
      recorded_at: '2026-06-07T12:00:00.000Z',
      ticket: 'api_key=[redacted]',
    });
    expect(JSON.stringify(record)).not.toContain(RAW_RESOURCE_REFERENCE);
    expect(JSON.stringify(record)).not.toContain('sensitive-value');
    expect(JSON.stringify(record)).not.toContain('secret-ticket-key');
    expect(hasConcreteAdminProviderDisposition([record])).toBe(true);
  });

  it('does not treat scrub-scope records or generic provider objects as purge eligibility', () => {
    expect(hasConcreteAdminProviderDisposition([
      { provider: 'zernio', disposition: 'recorded' },
      { type: 'provider_disposition', provider: 'zernio', disposition: 'recorded' },
      { type: 'sms_opt_out_scrub_scope', scrubbed_handle: 'sha256:abc' },
      {
        type: 'admin_provider_disposition',
        provider: 'zernio',
        resource_type: 'account',
        scrubbed_resource_reference: `sha256:${RESOURCE_HASH}`,
        admin_actor_user_id: ADMIN_ID,
        recorded_at: '2026-06-07T12:00:00.000Z',
      },
    ])).toBe(false);
  });
});

describe('recordProviderDisposition', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    txCalls.length = 0;
    txResults.length = 0;
    mockWriteAccountAuditLog.mockResolvedValue(undefined);
  });

  it('appends the concrete disposition and writes account audit in one transaction', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-07T12:00:00.000Z'));
    txResults.push([offboardingRow()]);

    const result = await recordProviderDisposition({
      offboardingId: OFFBOARDING_ID,
      adminUserId: ADMIN_ID,
      provider: 'zernio',
      resourceType: 'account',
      resourceReference: RAW_RESOURCE_REFERENCE,
      reason: 'Zernio support confirmed remote account teardown.',
      ticket: 'SUP-123',
      requestId: 'req-123',
      ip: '203.0.113.10',
      userAgent: 'vitest',
    });

    expect(result.transitionedToPurgeScheduled).toBe(true);
    expect(result.disposition.scrubbed_resource_reference).toBe(`sha256:${RESOURCE_HASH}`);
    expect(mockSql.begin).toHaveBeenCalledOnce();
    const combinedSql = txCalls.map((call) => call.text).join('\n');
    expect(combinedSql).toContain('FOR UPDATE');
    expect(combinedSql).toContain('provider_dispositions = provider_dispositions ||');
    expect(txCalls.flatMap((call) => call.values)).toContain('purge_scheduled');
    expect(mockJsonb).toHaveBeenCalledWith([result.disposition]);
    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: ACCOUNT_ID,
        actorUserId: ADMIN_ID,
        eventType: 'account_offboarding_provider_disposition_recorded',
        entityType: 'account_offboarding',
        entityId: OFFBOARDING_ID,
        ip: '203.0.113.10',
        userAgent: 'vitest',
        requestId: 'req-123',
        payload: expect.objectContaining({
          provider: 'zernio',
          resource_type: 'account',
          scrubbed_resource_reference: `sha256:${RESOURCE_HASH}`,
          ticket: 'SUP-123',
          transitioned_to_purge_scheduled: true,
        }),
      }),
      mockTx,
    );
    expect(JSON.stringify({
      values: txCalls.flatMap((call) => call.values),
      audit: mockWriteAccountAuditLog.mock.calls[0]?.[0],
    })).not.toContain(RAW_RESOURCE_REFERENCE);
    vi.useRealTimers();
  });

  it('does not transition to purge scheduled when the provider record does not cover the failed step', async () => {
    txResults.push([offboardingRow({ zernio_accounts_step: 'success', zernio_profiles_step: 'success' })]);

    const result = await recordProviderDisposition({
      offboardingId: OFFBOARDING_ID,
      adminUserId: ADMIN_ID,
      provider: 'zernio',
      resourceType: 'account',
      resourceReference: RAW_RESOURCE_REFERENCE,
      reason: 'Provider support confirmed teardown.',
    });

    expect(result.transitionedToPurgeScheduled).toBe(false);
  });

  it('throws not_found without writing audit when the offboarding row is absent', async () => {
    txResults.push([]);

    await expect(recordProviderDisposition({
      offboardingId: OFFBOARDING_ID,
      adminUserId: ADMIN_ID,
      provider: 'zernio',
      resourceType: 'account',
      resourceReference: RAW_RESOURCE_REFERENCE,
      reason: 'Zernio support confirmed remote account teardown.',
    })).rejects.toMatchObject(new ProviderDispositionError(404, 'offboarding_not_found'));

    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
  });
});
