// Dispatch half of the veto-notice family (#631 Task 5,
// docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md). Mirrors
// pending-post-notice/__tests__/dispatch.test.ts's mocked-channels/sql style —
// no live DB. The notice is about a BATCH, not a response: claims key on
// (entity_id=batchId, channel, recipient), and the CTA is the tokenless
// `${appUrl}/dashboard/requests` link (decision 10), so there is no approval
// link to create.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import type { ResolvedChannel } from '../../../../src/lib/notifications/resolve-channels';
import type { SendSolicitationVetoNoticeParams } from '../../../../src/lib/notifications/channels/types';

const { sqlQueue, sqlCalls, mockSql, mockGetChannel } = vi.hoisted(() => {
  const sqlQueue: unknown[] = [];
  const sqlCalls: string[] = [];
  const mockSql = async (strings: TemplateStringsArray) => {
    sqlCalls.push(strings.join('?'));
    const next = sqlQueue.shift();
    if (next instanceof Error) throw next;
    return Array.isArray(next) ? next : [];
  };
  return { sqlQueue, sqlCalls, mockSql, mockGetChannel: vi.fn() };
});

vi.mock('../../../../src/lib/notifications/channels', () => ({ getChannel: mockGetChannel }));

import { dispatchSolicitationVetoNotice, type SolicitationVetoNoticeDispatchInput } from '../dispatch';
import { resetWorkerConfigForTests } from '../../../../src/lib/config/worker';

const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

const INPUT: SolicitationVetoNoticeDispatchInput = {
  batchId: 'batch-1',
  businessId: 'biz-1',
  accountId: 'acct-1',
  requestCount: 5,
  requestsUrl: 'https://app.example.com/dashboard/requests',
  business: { name: 'Acme Co', displayLabel: null, ownerEmailBounced: false },
};
const email = (): ResolvedChannel => ({ channel: 'email', handle: 'o@x.com', location_id: null });
const whatsapp = (): ResolvedChannel => ({ channel: 'whatsapp', handle: '+15550000001', location_id: null });
const telegram = (): ResolvedChannel => ({ channel: 'telegram', handle: '123', location_id: null });

beforeEach(() => {
  sqlQueue.length = 0;
  sqlCalls.length = 0;
  logger.log.mockReset();
  logger.warn.mockReset();
  logger.error.mockReset();
  mockGetChannel.mockReset();
  process.env.WHATSAPP_SOLICITATION_VETO_TEMPLATE_SID = 'HXsid';
  // dispatch reads WHATSAPP_SOLICITATION_VETO_TEMPLATE_SID via the memoized
  // getWorkerConfig(); clear the memo so each test's env (incl. the per-test
  // `delete` below) is re-parsed on the handler's first read.
  resetWorkerConfigForTests();
});

describe('solicitation veto notice dispatch', () => {
  it('dispatches the veto notice to enrolled channels and records notification_deliveries rows', async () => {
    const send = vi.fn(async () => ({ status: 'sent', externalMessageId: 'm1' }));
    mockGetChannel.mockReturnValue({ sendSolicitationVetoNotice: send });
    sqlQueue.push([]);             // self-reap DELETE (inside claim helper)
    sqlQueue.push([{ id: 'd1' }]); // claim INSERT ... RETURNING id
    sqlQueue.push([]);             // finalize UPDATE

    const res = await dispatchSolicitationVetoNotice(mockSql as unknown as Sql, INPUT, [email()], logger as never);

    expect(res.sent).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      handle: 'o@x.com',
      locationLabel: 'Acme Co',
      businessName: 'Acme Co',
      requestCount: 5,
      requestsUrl: 'https://app.example.com/dashboard/requests',
      batchId: 'batch-1',
    }));
    // Claim-before-send: INSERT into notification_deliveries with ON CONFLICT,
    // keyed by entity_id (the batch id) rather than response_id.
    expect(
      sqlCalls.some((s) => /INSERT INTO\s+notification_deliveries/i.test(s) && /ON CONFLICT/i.test(s)),
    ).toBe(true);
    expect(sqlCalls.some((s) => /entity_id/i.test(s))).toBe(true);
  });

  it('logs a systemic failure when zero veto-notice channels deliver', async () => {
    const send = vi.fn(async () => { throw new Error('resend hard error'); });
    mockGetChannel.mockReturnValue({ sendSolicitationVetoNotice: send });
    sqlQueue.push([]);             // self-reap DELETE (inside claim helper)
    sqlQueue.push([{ id: 'd1' }]); // claim
    sqlQueue.push([]);             // terminal UPDATE

    const res = await dispatchSolicitationVetoNotice(mockSql as unknown as Sql, INPUT, [email()], logger as never);

    expect(res.sent).toBe(0);
    expect(res.terminalFailed).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('systemic-failure'));
  });

  it('an unset WhatsApp veto template skips only WhatsApp while other channels continue', async () => {
    delete process.env.WHATSAPP_SOLICITATION_VETO_TEMPLATE_SID;
    const telegramSend = vi.fn(async () => ({ status: 'sent', externalMessageId: 'm2' }));
    mockGetChannel.mockImplementation((id: string) =>
      id === 'whatsapp'
        ? { sendSolicitationVetoNotice: vi.fn() }
        : { sendSolicitationVetoNotice: telegramSend },
    );
    sqlQueue.push([]);             // telegram self-reap DELETE
    sqlQueue.push([{ id: 'd1' }]); // telegram claim
    sqlQueue.push([]);             // telegram finalize

    const res = await dispatchSolicitationVetoNotice(
      mockSql as unknown as Sql,
      INPUT,
      [whatsapp(), telegram()],
      logger as never,
    );

    expect(res.skipped).toBe(1);
    expect(res.sent).toBe(1); // telegram still delivers
    expect(telegramSend).toHaveBeenCalledTimes(1);
    expect(mockGetChannel).toHaveBeenCalledTimes(1);
    expect(mockGetChannel).toHaveBeenCalledWith('telegram');
    expect(logger.log).toHaveBeenCalledWith(
      'solicitation_veto_notice skipped channel=whatsapp reason=template_unset batch=batch-1',
    );
    // Skipped BEFORE any claim: no notification_deliveries touch for whatsapp.
    expect(sqlCalls.filter((s) => s.includes('notification_deliveries'))).toHaveLength(3); // self-reap + claim + finalize (telegram only)
  });

  it('the veto-notice CTA links to /dashboard/requests and contains no approval token', async () => {
    const send = vi.fn(async (_p: SendSolicitationVetoNoticeParams) => ({ status: 'sent' as const, externalMessageId: 'm1' }));
    mockGetChannel.mockReturnValue({ sendSolicitationVetoNotice: send });
    sqlQueue.push([]);             // self-reap DELETE (inside claim helper)
    sqlQueue.push([{ id: 'd1' }]); // claim
    sqlQueue.push([]);             // finalize UPDATE

    await dispatchSolicitationVetoNotice(mockSql as unknown as Sql, INPUT, [email()], logger as never);

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      requestsUrl: 'https://app.example.com/dashboard/requests',
    }));
    const sentParams = send.mock.calls[0]?.[0];
    expect(sentParams?.requestsUrl.endsWith('/dashboard/requests')).toBe(true);
    // No approval-link machinery: no /approve/ path, no approveUrl/approvalUrl
    // field, and createApprovalLink is never imported by this dispatcher.
    expect(sentParams?.requestsUrl).not.toMatch(/\/approve\//);
    expect(sentParams).not.toHaveProperty('approveUrl');
    expect(sentParams).not.toHaveProperty('approvalUrl');
  });
});
