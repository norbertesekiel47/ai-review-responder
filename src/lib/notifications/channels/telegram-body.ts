// src/lib/notifications/channels/telegram-body.ts
//
// Pure formatter for Telegram approval messages. No side effects — unit-testable
// without a network. HTML parse mode is used, so every dynamic field is escaped.
//
// VAL-NOTIF-011: Template prefix includes [locationLabel].
// VAL-NOTIF-014: locationLabel is resolved at the data layer via
//   getDisplayLabel({ display_label, name }) — display_label ?? name fallback.
// VAL-NOTIF-019: Template prefix escapes brackets, colons, long display_labels.

import { sanitizeLocationLabelForPrefix } from './template-prefix';

export interface TelegramApprovalParams {
  /** Resolved location label: display_label ?? businesses.name. Always non-null. */
  locationLabel: string;
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
  // VAL-NOTIF-019: Sanitize label before inserting into bracket prefix
  const safeLabel = sanitizeLocationLabelForPrefix(p.locationLabel);
  const location = escapeHtml(safeLabel);
  const reviewer = escapeHtml(p.reviewerName);
  const reviewBody = p.reviewText ? escapeHtml(truncate(p.reviewText, MAX_EMBED)) : '(no review text)';
  const preview = escapeHtml(truncate(p.responsePreview, MAX_EMBED));

  // VAL-NOTIF-011: Prefix format: [{locationLabel}] New {rating}★ from {reviewer}
  const text = [
    `<b>[${location}] New ⭐${p.starRating} from ${reviewer}</b>`,
    p.reviewDate,
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
