import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ResolvedChannel } from '../../../../src/lib/notifications/resolve-channels';

const { sqlQueue, sqlCalls, mockGetChannel } = vi.hoisted(() => ({
  sqlQueue: [] as unknown[],
  sqlCalls: [] as string[],
  mockGetChannel: vi.fn(),
}));

vi.mock('../../../../src/lib/db/server', () => {
  const sqlFn = async (strings: TemplateStringsArray) => {
    sqlCalls.push(strings.join('?'));
    const next = sqlQueue.shift();
    if (next instanceof Error) throw next;
    return Array.isArray(next) ? next : [];
  };
  return { sql: sqlFn, jsonb: (v: unknown) => v };
});
vi.mock('../../../../src/lib/notifications/channels', () => ({ getChannel: mockGetChannel }));

import { dispatchAutoPostNotice, type AutoPostNoticeDispatchInput } from '../dispatch';
import { WhatsAppRateLimitError } from '../../../../src/lib/notifications/channels/whatsapp-client';

const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

const INPUT: AutoPostNoticeDispatchInput = {
  responseId: 'resp-1',
  businessId: 'biz-1',
  accountId: 'acct-1',
  viewUrl: 'https://app.example.com/r/google/resp-1',
  business: { name: 'Acme Co', displayLabel: null, googleMapsUrl: 'https://maps.google.com/x' },
  review: { reviewerName: 'Jane', starRating: 5 },
};
const email = (): ResolvedChannel => ({ channel: 'email', handle: 'o@x.com', location_id: null });
const whatsapp = (): ResolvedChannel => ({ channel: 'whatsapp', handle: '+15550000001', location_id: null });
const telegram = (): ResolvedChannel => ({ channel: 'telegram', handle: '123', location_id: null });

beforeEach(() => {
  sqlQueue.length = 0;
  sqlCalls.length = 0;
  mockGetChannel.mockReset();
  process.env.WHATSAPP_AUTOPOST_TEMPLATE_SID = 'HXsid';
});

describe('dispatchAutoPostNotice', () => {
  it('claims, sends, finalizes — and NEVER touches approval_links', async () => {
    const send = vi.fn(async () => ({ status: 'sent', externalMessageId: 'm1' }));
    mockGetChannel.mockReturnValue({ sendAutoPostNotice: send });
    sqlQueue.push([{ id: 'd1' }]); // claim INSERT ... RETURNING id
    sqlQueue.push([]);             // finalize UPDATE

    const res = await dispatchAutoPostNotice(INPUT, [email()], logger);

    expect(res.sent).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    // Zero approval_links rows (Codex R1 #4 regression guard).
    expect(sqlCalls.some((s) => s.includes('approval_links'))).toBe(false);
    // Claim-before-send: INSERT into notification_deliveries with ON CONFLICT.
    expect(
      sqlCalls.some((s) => /INSERT INTO\s+notification_deliveries/i.test(s) && /ON CONFLICT/i.test(s)),
    ).toBe(true);
  });

  it('dedups when the claim conflicts (already sent/claimed) — no send', async () => {
    mockGetChannel.mockReturnValue({ sendAutoPostNotice: vi.fn() });
    sqlQueue.push([]); // claim INSERT returns no rows (ON CONFLICT DO NOTHING)

    const res = await dispatchAutoPostNotice(INPUT, [email()], logger);

    expect(res.skipped).toBe(1);
    expect(res.sent).toBe(0);
    expect(mockGetChannel).not.toHaveBeenCalled();
  });

  it('re-throws when the claim INSERT itself fails (DB infra → whole job retries, FYI not dropped) [Codex review #5]', async () => {
    mockGetChannel.mockReturnValue({ sendAutoPostNotice: vi.fn() });
    sqlQueue.push(new Error('db down on claim INSERT'));

    await expect(dispatchAutoPostNotice(INPUT, [email()], logger)).rejects.toThrow(/db down/);
    // Never attempted a send on a failed claim, and did not silently swallow it.
    expect(mockGetChannel).not.toHaveBeenCalled();
  });

  it('pre-filters WhatsApp when WHATSAPP_AUTOPOST_TEMPLATE_SID is unset (no claim, no send)', async () => {
    delete process.env.WHATSAPP_AUTOPOST_TEMPLATE_SID;
    const res = await dispatchAutoPostNotice(INPUT, [whatsapp()], logger);

    expect(res.skipped).toBe(1);
    expect(mockGetChannel).not.toHaveBeenCalled();
    expect(sqlCalls.some((s) => s.includes('notification_deliveries'))).toBe(false);
  });

  it('RELEASES the claim on a retryable send error so a retry can re-send', async () => {
    const send = vi.fn(async () => { throw new WhatsAppRateLimitError(63017); });
    mockGetChannel.mockReturnValue({ sendAutoPostNotice: send });
    sqlQueue.push([{ id: 'd1' }]); // claim
    sqlQueue.push([]);             // release DELETE

    const res = await dispatchAutoPostNotice(INPUT, [whatsapp()], logger);

    expect(res.retryableFailed).toBe(1);
    expect(res.terminalFailed).toBe(0);
    expect(sqlCalls.some((s) => /DELETE FROM\s+notification_deliveries/i.test(s))).toBe(true);
  });

  it('writes a FAILED delivery row (not a release) on a terminal send error', async () => {
    const send = vi.fn(async () => { throw new Error('resend hard error'); });
    mockGetChannel.mockReturnValue({ sendAutoPostNotice: send });
    sqlQueue.push([{ id: 'd1' }]); // claim
    sqlQueue.push([]);             // terminal UPDATE

    const res = await dispatchAutoPostNotice(INPUT, [email()], logger);

    expect(res.terminalFailed).toBe(1);
    expect(res.retryableFailed).toBe(0);
    expect(sqlCalls.some((s) => /UPDATE\s+notification_deliveries/i.test(s) && s.includes('failed_at'))).toBe(true);
    expect(sqlCalls.some((s) => /DELETE FROM\s+notification_deliveries/i.test(s))).toBe(false);
  });

  it('releases the claim when the channel itself returns skipped', async () => {
    const send = vi.fn(async () => ({ status: 'skipped', reason: 'whatsapp_autopost_template_unset' }));
    mockGetChannel.mockReturnValue({ sendAutoPostNotice: send });
    sqlQueue.push([{ id: 'd1' }]); // claim
    sqlQueue.push([]);             // release DELETE

    const res = await dispatchAutoPostNotice(INPUT, [telegram()], logger);

    expect(res.skipped).toBe(1);
    expect(res.sent).toBe(0);
    expect(sqlCalls.some((s) => /DELETE FROM\s+notification_deliveries/i.test(s))).toBe(true);
  });
});
