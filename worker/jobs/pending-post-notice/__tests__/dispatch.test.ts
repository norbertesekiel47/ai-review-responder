import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import type { ResolvedChannel } from '../../../../src/lib/notifications/resolve-channels';

const { sqlQueue, sqlCalls, mockSql, mockGetChannel, mockCreateApprovalLink } = vi.hoisted(() => {
  const sqlQueue: unknown[] = [];
  const sqlCalls: string[] = [];
  const mockSql = async (strings: TemplateStringsArray) => {
    sqlCalls.push(strings.join('?'));
    const next = sqlQueue.shift();
    if (next instanceof Error) throw next;
    return Array.isArray(next) ? next : [];
  };
  return { sqlQueue, sqlCalls, mockSql, mockGetChannel: vi.fn(), mockCreateApprovalLink: vi.fn() };
});

vi.mock('../../../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('../../../../src/lib/notifications/channels', () => ({ getChannel: mockGetChannel }));
vi.mock('../../../../src/lib/approval/create-link', () => ({ createApprovalLink: mockCreateApprovalLink }));

import { dispatchPendingPostNotice, type PendingPostNoticeDispatchInput } from '../dispatch';
import { WhatsAppRateLimitError } from '../../../../src/lib/notifications/channels/whatsapp-client';
import { resetWorkerConfigForTests } from '../../../../src/lib/config/worker';

const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

const DEADLINE = new Date('2026-07-09T18:00:00Z');
const RAW_TOKEN = 'raw-token-secret-1';

const INPUT: PendingPostNoticeDispatchInput = {
  responseId: 'resp-1',
  businessId: 'biz-1',
  accountId: 'acct-1',
  appUrl: 'https://app.example.com',
  business: { name: 'Acme Co', displayLabel: null, ownerEmailBounced: false },
  review: { reviewerName: 'Jane', starRating: 5, reviewText: 'great visit' },
  draft: { responsePreview: 'Thanks for the kind words!', scheduledPostAt: DEADLINE },
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
  mockCreateApprovalLink.mockReset();
  mockCreateApprovalLink.mockResolvedValue({
    rawToken: RAW_TOKEN,
    tokenHash: 'hash-1',
    approvalLinkId: 'link-1',
  });
  process.env.WHATSAPP_PENDING_POST_TEMPLATE_SID = 'HXsid';
  // dispatch reads WHATSAPP_PENDING_POST_TEMPLATE_SID via the memoized
  // getWorkerConfig(); clear the memo so each test's env (incl. the per-test
  // `delete` below) is re-parsed on the handler's first read.
  resetWorkerConfigForTests();
});

describe('dispatchPendingPostNotice', () => {
  it('claims, creates ONE approval link, sends with the tokenized approve URL, finalizes', async () => {
    const send = vi.fn(async () => ({ status: 'sent', externalMessageId: 'm1' }));
    mockGetChannel.mockReturnValue({ sendPendingPostNotice: send });
    sqlQueue.push([]);             // self-reap DELETE (inside claim helper)
    sqlQueue.push([{ id: 'd1' }]); // claim INSERT ... RETURNING id
    sqlQueue.push([]);             // finalize UPDATE

    const res = await dispatchPendingPostNotice(mockSql as unknown as Sql, INPUT, [email()], logger as never);

    expect(res.sent).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    // One link per delivery, same helper + args as the approval dispatcher.
    expect(mockCreateApprovalLink).toHaveBeenCalledTimes(1);
    expect(mockCreateApprovalLink).toHaveBeenCalledWith(mockSql, {
      responseId: 'resp-1',
      businessId: 'biz-1',
      channel: 'email',
    });
    // Raw token goes ONLY into the message URL; deadline passes through raw
    // (channels own the formatting).
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      approveUrl: `https://app.example.com/approve/${RAW_TOKEN}`,
      scheduledPostAt: DEADLINE,
      responsePreview: 'Thanks for the kind words!',
      responseId: 'resp-1',
    }));
    // Claim-before-send: INSERT into notification_deliveries with ON CONFLICT.
    expect(
      sqlCalls.some((s) => /INSERT INTO\s+notification_deliveries/i.test(s) && /ON CONFLICT/i.test(s)),
    ).toBe(true);
  });

  it('dedups when the claim conflicts (already sent/claimed) — no link, no send', async () => {
    mockGetChannel.mockReturnValue({ sendPendingPostNotice: vi.fn() });
    sqlQueue.push([]); // self-reap DELETE (inside claim helper)
    sqlQueue.push([]); // claim INSERT returns no rows (ON CONFLICT DO NOTHING)

    const res = await dispatchPendingPostNotice(mockSql as unknown as Sql, INPUT, [email()], logger as never);

    expect(res.skipped).toBe(1);
    expect(res.sent).toBe(0);
    expect(mockCreateApprovalLink).not.toHaveBeenCalled();
    expect(mockGetChannel).not.toHaveBeenCalled();
  });

  it('re-throws when the claim INSERT itself fails (DB infra → whole job retries, notice not dropped)', async () => {
    mockGetChannel.mockReturnValue({ sendPendingPostNotice: vi.fn() });
    sqlQueue.push([]); // self-reap DELETE (inside claim helper)
    sqlQueue.push(new Error('db down on claim INSERT'));

    await expect(dispatchPendingPostNotice(mockSql as unknown as Sql, INPUT, [email()], logger as never)).rejects.toThrow(/db down/);
    expect(mockGetChannel).not.toHaveBeenCalled();
  });

  it('pre-filters email when owner_email_bounced is set (no claim, no link, no send) — other channels unaffected', async () => {
    const send = vi.fn(async () => ({ status: 'sent', externalMessageId: 'm1' }));
    mockGetChannel.mockReturnValue({ sendPendingPostNotice: send });
    sqlQueue.push([]);             // telegram self-reap DELETE (inside claim helper)
    sqlQueue.push([{ id: 'd1' }]); // telegram claim
    sqlQueue.push([]);             // telegram finalize

    const bounced = { ...INPUT, business: { ...INPUT.business, ownerEmailBounced: true } };
    const res = await dispatchPendingPostNotice(mockSql as unknown as Sql, bounced, [email(), telegram()], logger as never);

    expect(res.skipped).toBe(1);
    expect(res.sent).toBe(1); // telegram still delivers
    expect(send).toHaveBeenCalledTimes(1);
    expect(mockGetChannel).toHaveBeenCalledTimes(1);
    expect(mockGetChannel).toHaveBeenCalledWith('telegram');
    expect(mockCreateApprovalLink).toHaveBeenCalledTimes(1);
    expect(mockCreateApprovalLink).toHaveBeenCalledWith(mockSql, expect.objectContaining({ channel: 'telegram' }));
    // Skipped BEFORE any claim: exactly one notification_deliveries touch pair (telegram's).
    expect(sqlCalls.filter((s) => s.includes('notification_deliveries'))).toHaveLength(3); // self-reap + claim + finalize
    expect(logger.log).toHaveBeenCalledWith(
      'pending_post_notice skipped channel=email reason=owner_email_bounced response=resp-1',
    );
  });

  it('pre-filters WhatsApp when WHATSAPP_PENDING_POST_TEMPLATE_SID is unset (no claim, no send)', async () => {
    delete process.env.WHATSAPP_PENDING_POST_TEMPLATE_SID;
    const res = await dispatchPendingPostNotice(mockSql as unknown as Sql, INPUT, [whatsapp()], logger as never);

    expect(res.skipped).toBe(1);
    expect(mockGetChannel).not.toHaveBeenCalled();
    expect(mockCreateApprovalLink).not.toHaveBeenCalled();
    expect(sqlCalls.some((s) => s.includes('notification_deliveries'))).toBe(false);
  });

  it('RELEASES the claim and counts retryable when createApprovalLink fails (DB blip must not terminally suppress the channel)', async () => {
    mockCreateApprovalLink.mockRejectedValue(new Error('link tx failed'));
    mockGetChannel.mockReturnValue({ sendPendingPostNotice: vi.fn() });
    sqlQueue.push([]);             // self-reap DELETE (inside claim helper)
    sqlQueue.push([{ id: 'd1' }]); // claim
    sqlQueue.push([]);             // release DELETE

    const res = await dispatchPendingPostNotice(mockSql as unknown as Sql, INPUT, [email()], logger as never);

    expect(res.retryableFailed).toBe(1);
    expect(res.terminalFailed).toBe(0);
    expect(mockGetChannel).not.toHaveBeenCalled();
    expect(sqlCalls.some((s) => /DELETE FROM\s+notification_deliveries/i.test(s))).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('link-create-failed'));
  });

  it('per-channel isolation: one channel throwing terminal does not stop the others', async () => {
    const emailSend = vi.fn(async () => { throw new Error('resend hard error'); });
    const telegramSend = vi.fn(async () => ({ status: 'sent', externalMessageId: 'm2' }));
    mockGetChannel.mockImplementation((id: string) =>
      id === 'email' ? { sendPendingPostNotice: emailSend } : { sendPendingPostNotice: telegramSend },
    );
    sqlQueue.push([]);             // email self-reap DELETE
    sqlQueue.push([{ id: 'd1' }]); // email claim
    sqlQueue.push([]);             // email terminal UPDATE
    sqlQueue.push([]);             // telegram self-reap DELETE
    sqlQueue.push([{ id: 'd2' }]); // telegram claim
    sqlQueue.push([]);             // telegram finalize

    const res = await dispatchPendingPostNotice(mockSql as unknown as Sql, INPUT, [email(), telegram()], logger as never);

    expect(res.terminalFailed).toBe(1);
    expect(res.sent).toBe(1);
    expect(telegramSend).toHaveBeenCalledTimes(1);
  });

  it('RELEASES the claim on a retryable send error so a retry can re-send', async () => {
    const send = vi.fn(async () => { throw new WhatsAppRateLimitError(63017); });
    mockGetChannel.mockReturnValue({ sendPendingPostNotice: send });
    sqlQueue.push([]);             // self-reap DELETE (inside claim helper)
    sqlQueue.push([{ id: 'd1' }]); // claim
    sqlQueue.push([]);             // release DELETE

    const res = await dispatchPendingPostNotice(mockSql as unknown as Sql, INPUT, [whatsapp()], logger as never);

    expect(res.retryableFailed).toBe(1);
    expect(res.terminalFailed).toBe(0);
    expect(sqlCalls.some((s) => /DELETE FROM\s+notification_deliveries/i.test(s))).toBe(true);
  });

  it('writes a FAILED delivery row (not a release) on a terminal send error', async () => {
    const send = vi.fn(async () => { throw new Error('resend hard error'); });
    mockGetChannel.mockReturnValue({ sendPendingPostNotice: send });
    sqlQueue.push([]);             // self-reap DELETE (inside claim helper)
    sqlQueue.push([{ id: 'd1' }]); // claim
    sqlQueue.push([]);             // terminal UPDATE

    const res = await dispatchPendingPostNotice(mockSql as unknown as Sql, INPUT, [email()], logger as never);

    expect(res.terminalFailed).toBe(1);
    expect(res.retryableFailed).toBe(0);
    expect(sqlCalls.some((s) => /UPDATE\s+notification_deliveries/i.test(s) && s.includes('failed_at'))).toBe(true);
    // The claim helper's self-reap DELETE (created_at-guarded) always runs;
    // what must NOT happen on a terminal error is a claim RELEASE (id-scoped).
    expect(
      sqlCalls.some((s) => /DELETE FROM\s+notification_deliveries/i.test(s) && !s.includes('created_at')),
    ).toBe(false);
  });

  it('releases the claim when the channel itself returns skipped', async () => {
    const send = vi.fn(async () => ({ status: 'skipped', reason: 'whatsapp_pending_post_template_unset' }));
    mockGetChannel.mockReturnValue({ sendPendingPostNotice: send });
    sqlQueue.push([]);             // self-reap DELETE (inside claim helper)
    sqlQueue.push([{ id: 'd1' }]); // claim
    sqlQueue.push([]);             // release DELETE

    const res = await dispatchPendingPostNotice(mockSql as unknown as Sql, INPUT, [telegram()], logger as never);

    expect(res.skipped).toBe(1);
    expect(res.sent).toBe(0);
    expect(sqlCalls.some((s) => /DELETE FROM\s+notification_deliveries/i.test(s))).toBe(true);
  });

  const recordedLogLines = () =>
    [...logger.log.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls].map((c) => String(c[0]));

  it('never logs review text, draft text, or the raw token (response id only)', async () => {
    const send = vi.fn(async () => ({ status: 'sent', externalMessageId: 'm1' }));
    mockGetChannel.mockReturnValue({ sendPendingPostNotice: send });
    sqlQueue.push([]);             // self-reap DELETE (inside claim helper)
    sqlQueue.push([{ id: 'd1' }]);
    sqlQueue.push([]);

    await dispatchPendingPostNotice(mockSql as unknown as Sql, INPUT, [email()], logger as never);

    const allLogLines = recordedLogLines();
    expect(allLogLines.some((line) => line.includes('great visit'))).toBe(false);
    expect(allLogLines.some((line) => line.includes('Thanks for the kind words'))).toBe(false);
    expect(allLogLines.some((line) => line.includes(RAW_TOKEN))).toBe(false);
    expect(allLogLines.some((line) => line.includes('response=resp-1'))).toBe(true);
  });

  it('redacts review/draft text and raw token from warn lines when a terminal provider error echoes the body', async () => {
    const send = vi.fn(async () => {
      throw new Error(
        `provider rejected body: "great visit" / "Thanks for the kind words!" / https://app.example.com/approve/${RAW_TOKEN}`,
      );
    });
    mockGetChannel.mockReturnValue({ sendPendingPostNotice: send });
    sqlQueue.push([]);             // self-reap DELETE (inside claim helper)
    sqlQueue.push([{ id: 'd1' }]); // claim
    sqlQueue.push([]);             // terminal UPDATE

    const res = await dispatchPendingPostNotice(mockSql as unknown as Sql, INPUT, [email()], logger as never);

    expect(res.terminalFailed).toBe(1);
    const allLogLines = recordedLogLines();
    expect(allLogLines.some((line) => line.includes('great visit'))).toBe(false);
    expect(allLogLines.some((line) => line.includes('Thanks for the kind words'))).toBe(false);
    expect(allLogLines.some((line) => line.includes(RAW_TOKEN))).toBe(false);
    expect(allLogLines.some((line) => line.includes('terminal-failed'))).toBe(true);
  });

  it('never persists the raw token in notification_deliveries.failure_reason (invariant #5)', async () => {
    // mockSql joins template strings with '?' — bound values are invisible in
    // sqlCalls text. Assert via the recorded bind on failDelivery instead: the
    // dispatch must pass a token-redacted reason.
    const boundValues: unknown[][] = [];
    const trackingSql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      boundValues.push(values);
      return (mockSql as unknown as (s: TemplateStringsArray) => Promise<unknown[]>)(strings);
    };
    const send = vi.fn(async () => {
      throw new Error(`hard error echoing https://app.example.com/approve/${RAW_TOKEN}`);
    });
    mockGetChannel.mockReturnValue({ sendPendingPostNotice: send });
    sqlQueue.push([]);             // self-reap DELETE (inside claim helper)
    sqlQueue.push([{ id: 'd1' }]); // claim
    sqlQueue.push([]);             // terminal UPDATE

    await dispatchPendingPostNotice(trackingSql as unknown as Sql, INPUT, [email()], logger as never);

    const allBound = boundValues.flat().map(String);
    expect(allBound.some((v) => v.includes(RAW_TOKEN))).toBe(false);
    expect(allBound.some((v) => v.includes('[redacted]'))).toBe(true);
  });
});
