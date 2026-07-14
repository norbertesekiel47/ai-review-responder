import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { ResolvedChannel } from '@/lib/notifications/resolve-channels';

const { sqlQueue, mockSql, mockGetChannel, mockClassify } = vi.hoisted(() => {
  const sqlQueue: unknown[] = [];
  const mockSql = vi.fn(async () => {
    const next = sqlQueue.shift();
    if (next instanceof Error) throw next;
    return Array.isArray(next) ? next : [];
  });
  return { sqlQueue, mockSql, mockGetChannel: vi.fn(), mockClassify: vi.fn() };
});
vi.mock('@/lib/notifications/channels', () => ({ getChannel: mockGetChannel }));
vi.mock('../errors', () => ({ classifyAutonomySuspendedNoticeSendError: mockClassify }));

import { dispatchAutonomySuspendedNotice } from '../dispatch';
import { resetWorkerConfigForTests } from '@/lib/config/worker';

const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
const input = {
  accountId: 'acct-1', businessId: 'biz-1', suspensionEventId: 'event-1',
  accountName: 'Acme Group', ownerEmailBounced: false,
  reason: 'A safety review flagged a recently auto-posted reply.',
  settingsUrl: 'https://app.example.com/settings/auto-approval',
  supportUrl: 'mailto:support@repworth.net',
};
const channel = (id: 'email' | 'telegram' | 'whatsapp'): ResolvedChannel => ({ channel: id, handle: id === 'email' ? 'o@x.com' : '123', location_id: null });

beforeEach(() => {
  sqlQueue.length = 0; mockSql.mockClear(); mockGetChannel.mockReset();
  mockClassify.mockReset();
  mockClassify.mockImplementation((error: unknown) => ({
    retryable: false,
    reason: error instanceof Error ? error.message : String(error),
  }));
  logger.log.mockReset(); logger.warn.mockReset(); logger.error.mockReset();
  process.env.WHATSAPP_AUTONOMY_SUSPENDED_TEMPLATE_SID = 'HXnotice';
  resetWorkerConfigForTests();
});

describe('dispatchAutonomySuspendedNotice', () => {
  it('claims, sends account-only params, and finalizes', async () => {
    const send = vi.fn(async (_params: unknown) => ({ status: 'sent', externalMessageId: 'm1' }));
    mockGetChannel.mockReturnValue({ sendAutonomySuspendedNotice: send });
    sqlQueue.push([], [{ id: 'd1' }], Object.assign([], { count: 1 }));
    const out = await dispatchAutonomySuspendedNotice(mockSql as unknown as Sql, input, [channel('email')], logger as never);
    expect(out).toEqual({ sent: 1, skipped: 0, terminalFailed: 0, retryableFailed: 0 });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ accountName: 'Acme Group', suspensionEventId: 'event-1' }));
    expect(send.mock.calls[0]![0]).not.toHaveProperty('reviewText');
    expect(send.mock.calls[0]![0]).not.toHaveProperty('responsePreview');
  });

  it('pre-skips WhatsApp when its template SID is unset', async () => {
    delete process.env.WHATSAPP_AUTONOMY_SUSPENDED_TEMPLATE_SID;
    resetWorkerConfigForTests();
    const out = await dispatchAutonomySuspendedNotice(mockSql as unknown as Sql, input, [channel('whatsapp')], logger as never);
    expect(out.skipped).toBe(1);
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockGetChannel).not.toHaveBeenCalled();
  });

  it('pre-skips a known-bounced email without claiming', async () => {
    const out = await dispatchAutonomySuspendedNotice(
      mockSql as unknown as Sql,
      { ...input, ownerEmailBounced: true },
      [channel('email')],
      logger as never,
    );
    expect(out.skipped).toBe(1);
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockGetChannel).not.toHaveBeenCalled();
  });

  it('releases and counts a transient send failure', async () => {
    const providerError = new Error('provider rate limited');
    mockClassify.mockReturnValue({ retryable: true, reason: providerError.message });
    mockGetChannel.mockReturnValue({ sendAutonomySuspendedNotice: vi.fn(async () => { throw providerError; }) });
    sqlQueue.push([], [{ id: 'd1' }], []);
    const out = await dispatchAutonomySuspendedNotice(mockSql as unknown as Sql, input, [channel('whatsapp')], logger as never);
    expect(out.retryableFailed).toBe(1);
    expect(out.terminalFailed).toBe(0);
  });

  it.each([
    { state: 'sent', row: { id: 'existing-1', sent_at: new Date(), failed_at: null } },
    { state: 'terminal-failed', row: { id: 'existing-2', sent_at: null, failed_at: new Date() } },
  ])('dedups a conflicting $state claim without sending', async ({ row }) => {
    sqlQueue.push([], [], [row]);
    const out = await dispatchAutonomySuspendedNotice(mockSql as unknown as Sql, input, [channel('telegram')], logger as never);
    expect(out.skipped).toBe(1);
    expect(mockGetChannel).not.toHaveBeenCalled();
    expect(mockClassify).not.toHaveBeenCalled();
  });

  it('throws on a conflicting live pending claim so the outbox cannot complete', async () => {
    sqlQueue.push([], [], [{ id: 'pending-1', sent_at: null, failed_at: null }]);
    await expect(dispatchAutonomySuspendedNotice(
      mockSql as unknown as Sql, input, [channel('telegram')], logger as never,
    )).rejects.toThrow(/pending delivery claim/);
    expect(mockGetChannel).not.toHaveBeenCalled();
    expect(mockClassify).not.toHaveBeenCalled();
  });

  it('releases a claim when a channel declines the send', async () => {
    mockGetChannel.mockReturnValue({ sendAutonomySuspendedNotice: vi.fn(async () => ({
      status: 'skipped', reason: 'provider_template_unset',
    })) });
    sqlQueue.push([], [{ id: 'd1' }], []);
    const out = await dispatchAutonomySuspendedNotice(mockSql as unknown as Sql, input, [channel('telegram')], logger as never);
    expect(out.skipped).toBe(1);
    expect(out.sent).toBe(0);
    expect(mockSql).toHaveBeenCalledTimes(3);
  });

  it('rethrows a claim infrastructure failure so the whole job retries', async () => {
    sqlQueue.push([], new Error('claim database unavailable'));
    await expect(dispatchAutonomySuspendedNotice(
      mockSql as unknown as Sql, input, [channel('email')], logger as never,
    )).rejects.toThrow(/database unavailable/);
    expect(mockGetChannel).not.toHaveBeenCalled();
    expect(mockClassify).not.toHaveBeenCalled();
  });

  it('rethrows finalize DB failure after provider acceptance without classifying it', async () => {
    mockGetChannel.mockReturnValue({ sendAutonomySuspendedNotice: vi.fn(async () => ({
      status: 'sent', externalMessageId: 'provider-accepted-1',
    })) });
    sqlQueue.push([], [{ id: 'd1' }], new Error('finalize database unavailable'));
    await expect(dispatchAutonomySuspendedNotice(
      mockSql as unknown as Sql, input, [channel('email')], logger as never,
    )).rejects.toThrow(/finalize database unavailable/);
    expect(mockClassify).not.toHaveBeenCalled();
  });

  it('rethrows release DB failure after a channel skip without classifying it', async () => {
    mockGetChannel.mockReturnValue({ sendAutonomySuspendedNotice: vi.fn(async () => ({
      status: 'skipped', reason: 'provider_template_unset',
    })) });
    sqlQueue.push([], [{ id: 'd1' }], new Error('release database unavailable'));
    await expect(dispatchAutonomySuspendedNotice(
      mockSql as unknown as Sql, input, [channel('telegram')], logger as never,
    )).rejects.toThrow(/release database unavailable/);
    expect(mockClassify).not.toHaveBeenCalled();
  });

  it('rethrows release DB failure after a retryable provider error without reclassifying lifecycle infra', async () => {
    const providerError = new Error('provider timeout');
    mockClassify.mockReturnValue({ retryable: true, reason: providerError.message });
    mockGetChannel.mockReturnValue({ sendAutonomySuspendedNotice: vi.fn(async () => { throw providerError; }) });
    sqlQueue.push([], [{ id: 'd1' }], new Error('release database unavailable'));
    await expect(dispatchAutonomySuspendedNotice(
      mockSql as unknown as Sql, input, [channel('telegram')], logger as never,
    )).rejects.toThrow(/release database unavailable/);
    expect(mockClassify).toHaveBeenCalledTimes(1);
    expect(mockClassify).toHaveBeenCalledWith(providerError);
  });

  it('rethrows failDelivery DB failure after a terminal provider error without reclassifying lifecycle infra', async () => {
    const providerError = new Error('provider rejected recipient');
    mockClassify.mockReturnValue({ retryable: false, reason: providerError.message });
    mockGetChannel.mockReturnValue({ sendAutonomySuspendedNotice: vi.fn(async () => { throw providerError; }) });
    sqlQueue.push([], [{ id: 'd1' }], new Error('failure record database unavailable'));
    await expect(dispatchAutonomySuspendedNotice(
      mockSql as unknown as Sql, input, [channel('email')], logger as never,
    )).rejects.toThrow(/failure record database unavailable/);
    expect(mockClassify).toHaveBeenCalledTimes(1);
    expect(mockClassify).toHaveBeenCalledWith(providerError);
  });
});
