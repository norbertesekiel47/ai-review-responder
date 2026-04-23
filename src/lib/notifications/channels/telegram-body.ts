// src/lib/notifications/channels/telegram-body.ts
//
// Pure formatter for Telegram approval messages. No side effects — unit-testable
// without a network. HTML parse mode is used, so every dynamic field is escaped.

export interface TelegramApprovalParams {
  businessName: string;
  reviewerName: string;
  starRating: number;
  reviewText: string | null;
  reviewDate: string;
  responsePreview: string;
  approvalUrl: string;
  approvalLinkId: string;
}

export interface TelegramInlineButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface FormattedApprovalMessage {
  text: string;
  inline_keyboard: TelegramInlineButton[][];
}

const MAX_EMBED = 400;

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function truncate(raw: string, max: number): string {
  if (raw.length <= max) return raw;
  return raw.slice(0, max - 1) + '…';
}

export function formatApprovalTelegram(p: TelegramApprovalParams): FormattedApprovalMessage {
  const business = escapeHtml(p.businessName);
  const reviewer = escapeHtml(p.reviewerName);
  const reviewBody = p.reviewText ? escapeHtml(truncate(p.reviewText, MAX_EMBED)) : '(no review text)';
  const preview = escapeHtml(truncate(p.responsePreview, MAX_EMBED));

  const text = [
    `<b>New ⭐${p.starRating} review — ${business}</b>`,
    `From: ${reviewer} · ${p.reviewDate}`,
    `—`,
    `"${reviewBody}"`,
    `—`,
    `<b>Draft reply:</b>`,
    preview,
  ].join('\n');

  const inline_keyboard: TelegramInlineButton[][] = [
    [
      { text: '✅ Approve', callback_data: `a:${p.approvalLinkId}` },
      { text: '🔄 Regenerate', callback_data: `r:${p.approvalLinkId}` },
    ],
    [{ text: '✏️ Edit / view full', url: p.approvalUrl }],
  ];

  return { text, inline_keyboard };
}
