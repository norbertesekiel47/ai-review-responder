import { describe, it, expect, vi, beforeEach } from 'vitest';

// All mock functions hoisted so they can be safely referenced in vi.mock() factories.
const {
  sqlQueue,
  sqlCalls,
  mockClaim,
  mockVerify,
  mockApprove,
  mockRegenerate,
  mockAck,
  mockSendMsg,
  mockEditText,
  mockEditMarkup,
} = vi.hoisted(() => {
  const sqlQueue: unknown[] = [];
  const sqlCalls: { sql: string }[] = [];

  const mockClaim = vi.fn();
  const mockVerify = vi.fn();
  const mockApprove = vi.fn();
  const mockRegenerate = vi.fn();
  const mockAck = vi.fn();
  const mockSendMsg = vi.fn();
  const mockEditText = vi.fn();
  const mockEditMarkup = vi.fn();

  return {
    sqlQueue,
    sqlCalls,
    mockClaim,
    mockVerify,
    mockApprove,
    mockRegenerate,
    mockAck,
    mockSendMsg,
    mockEditText,
    mockEditMarkup,
  };
});

vi.mock('../../../src/lib/db/server', () => ({
  sql: Object.assign(
    async (strings: TemplateStringsArray) => {
      sqlCalls.push({ sql: strings.join('?') });
      const next = sqlQueue.shift();
      if (Array.isArray(next)) return next;
      const arr: unknown[] & { count?: number } = [];
      arr.count = typeof next === 'number' ? next : 0;
      return arr;
    },
    {
      // tx consumes the shared sqlQueue in the same order as bare sql calls
      // so handleEnrollment's SELECT FOR UPDATE + UPDATE (now wrapped in
      // sql.begin) reads from the same fixture as pre-tx code.
      begin: async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = async (strings: TemplateStringsArray) => {
          sqlCalls.push({ sql: strings.join('?') });
          const next = sqlQueue.shift();
          if (Array.isArray(next)) return next;
          const arr: unknown[] & { count?: number } = [];
          arr.count = typeof next === 'number' ? next : 0;
          return arr;
        };
        return fn(tx);
      },
    },
  ),
  jsonb: (v: unknown) => v,
}));

vi.mock('../shared', () => ({ claimInboundEvent: mockClaim }));

vi.mock('../telegram-verify', () => ({ verifyTelegramSecret: mockVerify }));

vi.mock('../../../src/lib/approval/service', () => ({
  approveViaCallback: mockApprove,
  regenerateViaCallback: mockRegenerate,
}));

vi.mock('../../../src/lib/notifications/channels/telegram-client', async () => {
  const actual = await vi.importActual<typeof import('../../../src/lib/notifications/channels/telegram-client')>(
    '../../../src/lib/notifications/channels/telegram-client',
  );
  // Use a regular function so it can be used as a constructor (new TelegramClient()).
  function MockTelegramClient() {
    return {
      answerCallbackQuery: mockAck,
      sendMessage: mockSendMsg,
      editMessageText: mockEditText,
      editMessageReplyMarkup: mockEditMarkup,
    };
  }
  return {
    ...actual,
    TelegramClient: MockTelegramClient,
  };
});

import { handleTelegramWebhook } from '../telegram';
import {
  ConsumedLinkError,
  ChannelMismatchError,
  ExpiredLinkError,
  RevokedLinkError,
} from '../../../src/lib/approval/errors';

function mkRequest(body: unknown, secretHeader = 'good-secret') {
  return {
    body,
    headers: { 'x-telegram-bot-api-secret-token': secretHeader },
    ip: '1.2.3.4',
  } as unknown as Parameters<typeof handleTelegramWebhook>[0];
}

function mkReply() {
  const reply = {
    status: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    code: vi.fn().mockReturnThis(),
  };
  return reply as unknown as Parameters<typeof handleTelegramWebhook>[1];
}

beforeEach(() => {
  sqlQueue.length = 0; sqlCalls.length = 0;
  mockClaim.mockReset(); mockVerify.mockReset();
  mockApprove.mockReset(); mockRegenerate.mockReset();
  mockAck.mockReset(); mockSendMsg.mockReset();
  mockEditText.mockReset(); mockEditMarkup.mockReset();
  // sendMessage/ack/edit calls are awaited with .catch() — default to resolved Promise
  mockSendMsg.mockResolvedValue(undefined);
  mockAck.mockResolvedValue(undefined);
  mockEditText.mockResolvedValue(undefined);
  mockEditMarkup.mockResolvedValue(undefined);
  process.env.TELEGRAM_BOT_TOKEN = 'bot-test';
  process.env.TELEGRAM_WEBHOOK_SECRET = 'good-secret';
});

describe('telegram ingress — signature verification', () => {
  it('returns 401 when signature fails', async () => {
    mockVerify.mockReturnValueOnce(false);
    const reply = mkReply();
    await handleTelegramWebhook(mkRequest({ update_id: 1 }, 'bad'), reply);
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockAck).not.toHaveBeenCalled();
  });
});

describe('telegram ingress — dedup', () => {
  it('returns 200 without ack when update is a duplicate', async () => {
    mockVerify.mockReturnValueOnce(true);
    mockClaim.mockResolvedValueOnce('duplicate');
    const reply = mkReply();
    await handleTelegramWebhook(mkRequest({
      update_id: 1,
      callback_query: { id: 'cb1', from: { id: 111 }, data: 'a:xyz', message: { chat: { id: 111 }, message_id: 9 } },
    }), reply);
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(mockAck).not.toHaveBeenCalled();
    expect(mockApprove).not.toHaveBeenCalled();
  });
});

describe('telegram ingress — callback_query happy path', () => {
  it('approve flow: ack → approveViaCallback → editMessageText', async () => {
    mockVerify.mockReturnValueOnce(true);
    mockClaim.mockResolvedValueOnce('claimed');
    // invariant check: SELECT approval_links + SELECT enrollment
    sqlQueue.push([{ id: 'link-1', business_id: 'biz-1', channel: 'telegram', consumed_at: null, revoked_at: null, expires_at: new Date(Date.now() + 60_000) }]);
    sqlQueue.push([{ handle: '111' }]);
    mockApprove.mockResolvedValueOnce(undefined);
    sqlQueue.push([]); // mark inbound_events processed

    const reply = mkReply();
    await handleTelegramWebhook(mkRequest({
      update_id: 2,
      callback_query: { id: 'cb2', from: { id: 111 }, data: 'a:link-1', message: { chat: { id: 111 }, message_id: 55 } },
    }), reply);

    const order = mockAck.mock.invocationCallOrder[0]!;
    const approveOrder = mockApprove.mock.invocationCallOrder[0]!;
    const editOrder = mockEditText.mock.invocationCallOrder[0]!;
    expect(order).toBeLessThan(approveOrder);
    expect(approveOrder).toBeLessThan(editOrder);
    expect(mockAck).toHaveBeenCalledTimes(1);
    expect(mockEditText).toHaveBeenCalledTimes(1);
    expect(mockSendMsg).not.toHaveBeenCalled();
  });

  it('regenerate flow: ack → regenerateViaCallback → editMessageText replaces stale draft', async () => {
    mockVerify.mockReturnValueOnce(true);
    mockClaim.mockResolvedValueOnce('claimed');
    sqlQueue.push([{ id: 'link-2', business_id: 'biz-1', channel: 'telegram', consumed_at: null, revoked_at: null, expires_at: new Date(Date.now() + 60_000) }]);
    sqlQueue.push([{ handle: '111' }]);
    mockRegenerate.mockResolvedValueOnce(undefined);
    sqlQueue.push([]);

    const reply = mkReply();
    await handleTelegramWebhook(mkRequest({
      update_id: 3,
      callback_query: { id: 'cb3', from: { id: 111 }, data: 'r:link-2', message: { chat: { id: 111 }, message_id: 56 } },
    }), reply);

    expect(mockAck).toHaveBeenCalledTimes(1);
    // editMessageText replaces the body with a status line; the inline
    // keyboard is implicitly dropped (reply_markup omitted).
    expect(mockEditText).toHaveBeenCalledWith(expect.objectContaining({
      chat_id: '111',
      message_id: 56,
      text: expect.stringMatching(/Regenerating/),
    }));
    expect(mockEditMarkup).not.toHaveBeenCalled();
    expect(mockSendMsg).not.toHaveBeenCalled();
  });
});

describe('telegram ingress — permanent link-state failures after ack', () => {
  it.each([
    ['consumed', new ConsumedLinkError()],
    ['revoked', new RevokedLinkError()],
    ['expired', new ExpiredLinkError()],
    ['channel-mismatch', new ChannelMismatchError('telegram', 'sms')],
  ])('%s → ack success, then sendMessage with friendly copy, processed (not failed)', async (_label, err) => {
    mockVerify.mockReturnValueOnce(true);
    mockClaim.mockResolvedValueOnce('claimed');
    sqlQueue.push([{ id: 'link-x', business_id: 'biz-1', channel: 'telegram', consumed_at: null, revoked_at: null, expires_at: new Date(Date.now() + 60_000) }]);
    sqlQueue.push([{ handle: '111' }]);
    mockApprove.mockRejectedValueOnce(err);
    sqlQueue.push([]);

    const reply = mkReply();
    await handleTelegramWebhook(mkRequest({
      update_id: 10,
      callback_query: { id: 'cb-x', from: { id: 111 }, data: 'a:link-x', message: { chat: { id: 111 }, message_id: 1 } },
    }), reply);

    expect(mockAck).toHaveBeenCalledTimes(1);
    expect(mockSendMsg).toHaveBeenCalledTimes(1);
    expect(mockEditText).not.toHaveBeenCalled();
    expect(mockEditMarkup).not.toHaveBeenCalled();
    const markProcessed = sqlCalls.find((c) => c.sql.includes('processed_at = NOW()'));
    expect(markProcessed).toBeDefined();
  });
});

describe('telegram ingress — unexpected tx failure', () => {
  it('sends fallback sendMessage without approval URL, marks inbound_events failed, returns 503', async () => {
    mockVerify.mockReturnValueOnce(true);
    mockClaim.mockResolvedValueOnce('claimed');
    sqlQueue.push([{ id: 'link-z', business_id: 'biz-1', channel: 'telegram', consumed_at: null, revoked_at: null, expires_at: new Date(Date.now() + 60_000) }]);
    sqlQueue.push([{ handle: '111' }]);
    mockApprove.mockRejectedValueOnce(new Error('DB timeout'));
    sqlQueue.push([]); // mark failed

    const reply = mkReply();
    await handleTelegramWebhook(mkRequest({
      update_id: 11,
      callback_query: { id: 'cb-z', from: { id: 111 }, data: 'a:link-z', message: { chat: { id: 111 }, message_id: 1 } },
    }), reply);

    expect(mockAck).toHaveBeenCalledTimes(1);
    expect(mockSendMsg).toHaveBeenCalledTimes(1);
    const text = (mockSendMsg.mock.calls[0]![0] as { text: string }).text;
    expect(text).not.toMatch(/https?:\/\//); // no URL embedded
    expect(text).toMatch(/Edit/i);
    expect(reply.code).toHaveBeenCalledWith(503);
  });
});

describe('telegram ingress — enrollment (/start)', () => {
  it('verifies token, flips status to verified, sends confirmation', async () => {
    mockVerify.mockReturnValueOnce(true);
    mockClaim.mockResolvedValueOnce('claimed');
    // SELECT channel_enrollments by hash
    sqlQueue.push([{ id: 'enrl-1', business_id: 'biz-1' }]);
    sqlQueue.push([]); // UPDATE enrollments
    sqlQueue.push([]); // mark processed

    const reply = mkReply();
    await handleTelegramWebhook(mkRequest({
      update_id: 20,
      message: { from: { id: 222 }, chat: { id: 222 }, text: '/start RAW-TOKEN-HERE' },
    }), reply);

    expect(mockSendMsg).toHaveBeenCalledTimes(1);
    const sendText = (mockSendMsg.mock.calls[0]![0] as { text: string }).text;
    expect(sendText).toMatch(/connected/i);
    expect(reply.code).toHaveBeenCalledWith(200);
  });

  it('unknown/expired token: sends failure message, no state change', async () => {
    mockVerify.mockReturnValueOnce(true);
    mockClaim.mockResolvedValueOnce('claimed');
    sqlQueue.push([]); // SELECT returns no matching enrollment
    sqlQueue.push([]); // mark processed

    const reply = mkReply();
    await handleTelegramWebhook(mkRequest({
      update_id: 21,
      message: { from: { id: 333 }, chat: { id: 333 }, text: '/start BAD-TOKEN' },
    }), reply);

    expect(mockSendMsg).toHaveBeenCalledTimes(1);
    const text = (mockSendMsg.mock.calls[0]![0] as { text: string }).text;
    expect(text).toMatch(/invalid|expired/i);
    expect(reply.code).toHaveBeenCalledWith(200);
  });
});

describe('telegram ingress — sendMessage failure does not reclassify permanent errors', () => {
  it('permanent error: if sendMessage throws AFTER a permanent link-state error, still marks processed (not failed)', async () => {
    mockVerify.mockReturnValueOnce(true);
    mockClaim.mockResolvedValueOnce('claimed');
    sqlQueue.push([{ id: 'link-q', business_id: 'biz-1', channel: 'telegram', consumed_at: null, revoked_at: null, expires_at: new Date(Date.now() + 60_000) }]);
    sqlQueue.push([{ handle: '111' }]);
    mockApprove.mockRejectedValueOnce(new ConsumedLinkError());
    sqlQueue.push([]); // mark processed (must happen BEFORE sendMessage throws)
    mockSendMsg.mockRejectedValueOnce(new Error('network down'));

    const reply = mkReply();
    await handleTelegramWebhook(mkRequest({
      update_id: 99,
      callback_query: { id: 'cb-q', from: { id: 111 }, data: 'a:link-q', message: { chat: { id: 111 }, message_id: 1 } },
    }), reply);

    // inbound_events must be marked processed even though sendMessage failed
    const markProcessedCall = sqlCalls.find((c) => c.sql.includes('processed_at = NOW()'));
    expect(markProcessedCall).toBeDefined();
    // and NOT marked failed
    const markFailedCall = sqlCalls.find((c) => c.sql.includes("status = 'failed'"));
    expect(markFailedCall).toBeUndefined();
    // Response should still be 200 (terminal state reached)
    expect(reply.code).toHaveBeenCalledWith(200);
  });
});
