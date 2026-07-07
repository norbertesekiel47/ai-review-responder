import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import type { ResolvedChannel } from '../../../../src/lib/notifications/resolve-channels';

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

vi.mock('../../../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('../../../../src/lib/notifications/channels', () => ({ getChannel: mockGetChannel }));

import { dispatchEscalationNotice, type EscalationNoticeDispatchInput } from '../dispatch';
import { WhatsAppRateLimitError } from '../../../../src/lib/notifications/channels/whatsapp-client';
import { resetWorkerConfigForTests } from '../../../../src/lib/config/worker';

const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

const INPUT: EscalationNoticeDispatchInput = {
  escalationId: 'esc-1',
  businessId: 'biz-1',
  accountId: 'acct-1',
  dashboardUrl: 'https://app.example.com/dashboard/reviews',
  business: { name: 'Acme Co', displayLabel: null, ownerEmailBounced: false },
  review: { reviewerName: 'Jane', starRating: 1, reviewText: 'terrible visit' },
  triage: { severity: 'high', issues: ['safety_or_health'], isFallback: false },
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
  process.env.WHATSAPP_ESCALATION_TEMPLATE_SID = 'HXsid';
  // dispatch reads WHATSAPP_ESCALATION_TEMPLATE_SID via the memoized
  // getWorkerConfig(); clear the memo so each test's env (incl. the per-test
  // `delete` below) is re-parsed on the handler's first read.
  resetWorkerConfigForTests();
});

describe('dispatchEscalationNotice', () => {
  it('claims, sends, finalizes — and NEVER touches approval_links', async () => {
    const send = vi.fn(async () => ({ status: 'sent', externalMessageId: 'm1' }));
    mockGetChannel.mockReturnValue({ sendEscalationNotice: send });
    sqlQueue.push([{ id: 'd1' }]); // claim INSERT ... RETURNING id
    sqlQueue.push([]);             // finalize UPDATE

    const res = await dispatchEscalationNotice(mockSql as unknown as Sql, INPUT, [email()], logger as never);

    expect(res.sent).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    // Escalation notice params carry the triage snapshot + dashboard CTA.
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      escalationId: 'esc-1',
      dashboardUrl: INPUT.dashboardUrl,
      severity: 'high',
      isFallback: false,
    }));
    // Zero approval_links rows (regression guard vs the approval dispatcher).
    expect(sqlCalls.some((s) => s.includes('approval_links'))).toBe(false);
    // Claim-before-send: INSERT into notification_deliveries with ON CONFLICT.
    expect(
      sqlCalls.some((s) => /INSERT INTO\s+notification_deliveries/i.test(s) && /ON CONFLICT/i.test(s)),
    ).toBe(true);
  });

  it('dedups when the claim conflicts (already sent/claimed) — no send', async () => {
    mockGetChannel.mockReturnValue({ sendEscalationNotice: vi.fn() });
    sqlQueue.push([]); // claim INSERT returns no rows (ON CONFLICT DO NOTHING)

    const res = await dispatchEscalationNotice(mockSql as unknown as Sql, INPUT, [email()], logger as never);

    expect(res.skipped).toBe(1);
    expect(res.sent).toBe(0);
    expect(mockGetChannel).not.toHaveBeenCalled();
  });

  it('re-throws when the claim INSERT itself fails (DB infra → whole job retries, notice not dropped)', async () => {
    mockGetChannel.mockReturnValue({ sendEscalationNotice: vi.fn() });
    sqlQueue.push(new Error('db down on claim INSERT'));

    await expect(dispatchEscalationNotice(mockSql as unknown as Sql, INPUT, [email()], logger as never)).rejects.toThrow(/db down/);
    // Never attempted a send on a failed claim, and did not silently swallow it.
    expect(mockGetChannel).not.toHaveBeenCalled();
  });

  it('pre-filters email when owner_email_bounced is set (no claim, no send) — other channels unaffected', async () => {
    const send = vi.fn(async () => ({ status: 'sent', externalMessageId: 'm1' }));
    mockGetChannel.mockReturnValue({ sendEscalationNotice: send });
    sqlQueue.push([{ id: 'd1' }]); // telegram claim
    sqlQueue.push([]);             // telegram finalize

    const bounced = { ...INPUT, business: { ...INPUT.business, ownerEmailBounced: true } };
    const res = await dispatchEscalationNotice(mockSql as unknown as Sql, bounced, [email(), telegram()], logger as never);

    expect(res.skipped).toBe(1);
    expect(res.sent).toBe(1); // telegram still delivers
    expect(send).toHaveBeenCalledTimes(1);
    expect(mockGetChannel).toHaveBeenCalledTimes(1);
    expect(mockGetChannel).toHaveBeenCalledWith('telegram');
    // Skipped BEFORE any claim: exactly one notification_deliveries touch (telegram's).
    expect(sqlCalls.filter((s) => s.includes('notification_deliveries'))).toHaveLength(2); // claim + finalize
    expect(logger.log).toHaveBeenCalledWith(
      'escalation_notice skipped channel=email reason=owner_email_bounced escalation=esc-1',
    );
  });

  it('pre-filters WhatsApp when WHATSAPP_ESCALATION_TEMPLATE_SID is unset (no claim, no send)', async () => {
    delete process.env.WHATSAPP_ESCALATION_TEMPLATE_SID;
    const res = await dispatchEscalationNotice(mockSql as unknown as Sql, INPUT, [whatsapp()], logger as never);

    expect(res.skipped).toBe(1);
    expect(mockGetChannel).not.toHaveBeenCalled();
    expect(sqlCalls.some((s) => s.includes('notification_deliveries'))).toBe(false);
  });

  it('RELEASES the claim on a retryable send error so a retry can re-send', async () => {
    const send = vi.fn(async () => { throw new WhatsAppRateLimitError(63017); });
    mockGetChannel.mockReturnValue({ sendEscalationNotice: send });
    sqlQueue.push([{ id: 'd1' }]); // claim
    sqlQueue.push([]);             // release DELETE

    const res = await dispatchEscalationNotice(mockSql as unknown as Sql, INPUT, [whatsapp()], logger as never);

    expect(res.retryableFailed).toBe(1);
    expect(res.terminalFailed).toBe(0);
    expect(sqlCalls.some((s) => /DELETE FROM\s+notification_deliveries/i.test(s))).toBe(true);
  });

  it('writes a FAILED delivery row (not a release) on a terminal send error', async () => {
    const send = vi.fn(async () => { throw new Error('resend hard error'); });
    mockGetChannel.mockReturnValue({ sendEscalationNotice: send });
    sqlQueue.push([{ id: 'd1' }]); // claim
    sqlQueue.push([]);             // terminal UPDATE

    const res = await dispatchEscalationNotice(mockSql as unknown as Sql, INPUT, [email()], logger as never);

    expect(res.terminalFailed).toBe(1);
    expect(res.retryableFailed).toBe(0);
    expect(sqlCalls.some((s) => /UPDATE\s+notification_deliveries/i.test(s) && s.includes('failed_at'))).toBe(true);
    expect(sqlCalls.some((s) => /DELETE FROM\s+notification_deliveries/i.test(s))).toBe(false);
  });

  it('releases the claim when the channel itself returns skipped', async () => {
    const send = vi.fn(async () => ({ status: 'skipped', reason: 'whatsapp_escalation_template_unset' }));
    mockGetChannel.mockReturnValue({ sendEscalationNotice: send });
    sqlQueue.push([{ id: 'd1' }]); // claim
    sqlQueue.push([]);             // release DELETE

    const res = await dispatchEscalationNotice(mockSql as unknown as Sql, INPUT, [telegram()], logger as never);

    expect(res.skipped).toBe(1);
    expect(res.sent).toBe(0);
    expect(sqlCalls.some((s) => /DELETE FROM\s+notification_deliveries/i.test(s))).toBe(true);
  });

  const recordedLogLines = () =>
    [...logger.log.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls].map((c) => String(c[0]));

  it('never logs review text (escalation id only)', async () => {
    const send = vi.fn(async () => ({ status: 'sent', externalMessageId: 'm1' }));
    mockGetChannel.mockReturnValue({ sendEscalationNotice: send });
    sqlQueue.push([{ id: 'd1' }]);
    sqlQueue.push([]);

    await dispatchEscalationNotice(mockSql as unknown as Sql, INPUT, [email()], logger as never);

    const allLogLines = recordedLogLines();
    expect(allLogLines.some((line) => line.includes('terrible visit'))).toBe(false);
    expect(allLogLines.some((line) => line.includes('escalation=esc-1'))).toBe(true);
  });

  it('never logs review text even when a terminal provider error echoes it in err.message', async () => {
    // The warn lines interpolate the classified reason — a provider error that
    // echoes the message body is the risky path; dispatch must redact it.
    const send = vi.fn(async () => { throw new Error('provider rejected body: "terrible visit" is too long'); });
    mockGetChannel.mockReturnValue({ sendEscalationNotice: send });
    sqlQueue.push([{ id: 'd1' }]); // claim
    sqlQueue.push([]);             // terminal UPDATE

    const res = await dispatchEscalationNotice(mockSql as unknown as Sql, INPUT, [email()], logger as never);

    expect(res.terminalFailed).toBe(1);
    const allLogLines = recordedLogLines();
    expect(allLogLines.some((line) => line.includes('terrible visit'))).toBe(false);
    expect(allLogLines.some((line) => line.includes('terminal-failed'))).toBe(true);
  });
});
