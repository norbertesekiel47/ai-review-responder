import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSendMessage } = vi.hoisted(() => ({ mockSendMessage: vi.fn() }));

vi.mock('../telegram-client', async () => {
  const actual = await vi.importActual<typeof import('../telegram-client')>('../telegram-client');
  return {
    ...actual,
    TelegramClient: class {
      sendMessage = mockSendMessage;
    },
  };
});

import { TelegramChannel } from '../telegram-channel';

function sampleParams() {
  return {
    handle: '123456789',
    locationLabel: 'Downtown Cafe',
    businessName: 'Acme',
    reviewerName: 'Jane',
    starRating: 4,
    reviewText: 'Nice',
    reviewDate: '2026-04-15',
    responsePreview: 'Thanks!',
    approvalUrl: 'https://app.repworth.net/approve/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    approvalLinkId: '01932b55-5555-7f60-9abc-abcdefabcdef',
  };
}

describe('TelegramChannel', () => {
  beforeEach(() => {
    mockSendMessage.mockReset();
    process.env.TELEGRAM_BOT_TOKEN = 'bot-token';
  });

  it('exposes the correct NotificationChannel identity flags', () => {
    const ch = new TelegramChannel();
    expect(ch.id).toBe('telegram');
    expect(ch.supportsInlineActions).toBe(true);
    expect(ch.requiresOptInHandshake).toBe(true);
  });

  it('returns externalMessageId formatted as chat_id:message_id', async () => {
    mockSendMessage.mockResolvedValueOnce({ message_id: 77, chat: { id: 123456789 } });
    const result = await new TelegramChannel().sendApprovalRequest(sampleParams());
    expect(result.externalMessageId).toBe('123456789:77');
  });

  it('sends the autonomy suspension message with an HTTPS settings button and support in text', async () => {
    mockSendMessage.mockResolvedValueOnce({ message_id: 88, chat: { id: 123456789 } });
    const result = await new TelegramChannel().sendAutonomySuspendedNotice({
      handle: '123456789', accountName: 'Acme Group', reason: 'Safety threshold.',
      settingsUrl: 'https://app.example.com/settings/auto-approval',
      supportUrl: 'mailto:support@repworth.net', suspensionEventId: 'event-1',
    });
    expect(result).toEqual({ status: 'sent', externalMessageId: '123456789:88' });
    const args = mockSendMessage.mock.calls[0]![0];
    expect(args.text).toContain('entire account');
    expect(args.text).toContain('support@repworth.net');
    expect(args.reply_markup.inline_keyboard.flat().map((button: { url: string }) => button.url)).toEqual([
      'https://app.example.com/settings/auto-approval',
    ]);
  });

  it('passes chat_id from handle and includes inline_keyboard in reply_markup', async () => {
    mockSendMessage.mockResolvedValueOnce({ message_id: 1, chat: { id: 1 } });
    await new TelegramChannel().sendApprovalRequest(sampleParams());
    const firstCall = mockSendMessage.mock.calls[0];
    if (!firstCall) throw new Error('expected sendMessage call');
    const [args] = firstCall;
    expect(args.chat_id).toBe('123456789');
    expect(args.reply_markup.inline_keyboard).toBeDefined();
    expect(args.reply_markup.inline_keyboard[0]).toHaveLength(2);
    expect(args.reply_markup.inline_keyboard[1]).toHaveLength(1);
  });

  it('propagates TelegramRecipientBlockedError from client', async () => {
    const { TelegramRecipientBlockedError } = await import('../telegram-client');
    mockSendMessage.mockRejectedValueOnce(new TelegramRecipientBlockedError());
    await expect(new TelegramChannel().sendApprovalRequest(sampleParams()))
      .rejects.toBeInstanceOf(TelegramRecipientBlockedError);
  });
});
