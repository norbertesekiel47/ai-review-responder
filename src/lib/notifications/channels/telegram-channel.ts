// src/lib/notifications/channels/telegram-channel.ts
//
// NotificationChannel implementation for Telegram.
//
// Cross-cutting concerns live in the dispatcher:
//   - Dispatcher classifies TelegramRecipientBlockedError → flip enrollment unsubscribed
//   - Dispatcher classifies TelegramChatNotFoundError → flip enrollment disabled
// This class only owns:
//   - Format the message (telegram-body.ts)
//   - Call Bot API sendMessage (telegram-client.ts)

import { formatApprovalTelegram } from './telegram-body';
import { TelegramClient } from './telegram-client';
import type { NotificationChannel, ChannelId, SendApprovalParams, SendApprovalResult } from './types';

export class TelegramChannel implements NotificationChannel {
  readonly id: ChannelId = 'telegram';
  readonly supportsInlineActions = true;
  readonly requiresOptInHandshake = true;

  async sendApprovalRequest(p: SendApprovalParams): Promise<SendApprovalResult> {
    const { text, inline_keyboard } = formatApprovalTelegram({
      businessName: p.businessName,
      reviewerName: p.reviewerName,
      starRating: p.starRating,
      reviewText: p.reviewText,
      reviewDate: p.reviewDate,
      responsePreview: p.responsePreview,
      approvalUrl: p.approvalUrl,
      approvalLinkId: p.approvalLinkId,
    });
    const client = new TelegramClient();
    const result = await client.sendMessage({
      chat_id: p.handle,
      text,
      reply_markup: { inline_keyboard },
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    return { externalMessageId: `${result.chat.id}:${result.message_id}` };
  }
}
