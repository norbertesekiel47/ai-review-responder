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

import { formatApprovalTelegram, formatAutoPostNoticeTelegram, formatEscalationNoticeTelegram } from './telegram-body';
import { TelegramClient } from './telegram-client';
import type {
  NotificationChannel,
  ChannelId,
  SendApprovalParams,
  SendApprovalResult,
  SendAutoPostNoticeParams,
  SendAutoPostNoticeResult,
  SendEscalationNoticeParams,
  SendEscalationNoticeResult,
} from './types';

export class TelegramChannel implements NotificationChannel {
  readonly id: ChannelId = 'telegram';
  readonly supportsInlineActions = true;
  readonly requiresOptInHandshake = true;

  async sendApprovalRequest(p: SendApprovalParams): Promise<SendApprovalResult> {
    const { text, inline_keyboard } = formatApprovalTelegram({
      locationLabel: p.locationLabel,
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

  async sendAutoPostNotice(p: SendAutoPostNoticeParams): Promise<SendAutoPostNoticeResult> {
    const { text, inline_keyboard } = formatAutoPostNoticeTelegram({
      locationLabel: p.locationLabel,
      reviewerName: p.reviewerName,
      starRating: p.starRating,
      googleMapsUrl: p.googleMapsUrl,
      viewUrl: p.viewUrl,
    });
    const client = new TelegramClient();
    const result = await client.sendMessage({
      chat_id: p.handle,
      text,
      // No CTA when the destination is unknown — pass no reply_markup rather
      // than an empty keyboard (which the Bot API rejects).
      reply_markup: inline_keyboard.length > 0 ? { inline_keyboard } : undefined,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    return { status: 'sent', externalMessageId: `${result.chat.id}:${result.message_id}` };
  }

  async sendEscalationNotice(p: SendEscalationNoticeParams): Promise<SendEscalationNoticeResult> {
    const { text, inline_keyboard } = formatEscalationNoticeTelegram({
      locationLabel: p.locationLabel,
      reviewerName: p.reviewerName,
      starRating: p.starRating,
      reviewText: p.reviewText,
      severity: p.severity,
      issues: p.issues,
      isFallback: p.isFallback,
      dashboardUrl: p.dashboardUrl,
    });
    const client = new TelegramClient();
    const result = await client.sendMessage({
      chat_id: p.handle,
      text,
      reply_markup: { inline_keyboard },
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    return { status: 'sent', externalMessageId: `${result.chat.id}:${result.message_id}` };
  }
}
