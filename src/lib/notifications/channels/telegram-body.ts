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
import { formatScheduledPostTime } from './scheduled-post-time';
import { TRIAGE_ISSUE_LABELS, TRIAGE_SEVERITY_LABELS, type TriageIssue, type TriageSeverity } from '@/lib/reviews/triage-schema';

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

export interface TelegramAutoPostNoticeParams {
  /** Resolved location label: display_label ?? businesses.name. Always non-null. */
  locationLabel: string;
  reviewerName: string;
  starRating: number;
  /** null when the business has no known Google Maps URL — CTA omitted. */
  googleMapsUrl: string | null;
  /** Stable redirect CTA target: `${APP_URL}/r/google/${responseId}`. */
  viewUrl: string;
}

/**
 * Pure formatter for the auto-approved post FYI. No approve/regenerate buttons
 * (the post already happened). A single "View on Google" CTA is included ONLY
 * when the business has a known Google Maps URL — otherwise no button (don't
 * show a button that leads nowhere). `inline_keyboard` is `[]` in that case,
 * and the channel passes no `reply_markup`.
 */
export function formatAutoPostNoticeTelegram(p: TelegramAutoPostNoticeParams): FormattedApprovalMessage {
  const location = escapeHtml(sanitizeLocationLabelForPrefix(p.locationLabel));
  const reviewer = escapeHtml(p.reviewerName);

  const text = [
    `<b>[${location}] ✅ Auto-approved reply posted</b>`,
    `Your reply to ${reviewer}'s ⭐${p.starRating} review was approved by your auto-policy and posted to Google. No action needed.`,
  ].join('\n');

  const inline_keyboard: TelegramInlineButton[][] = p.googleMapsUrl !== null
    ? [[{ text: '🔗 View on Google', url: p.viewUrl }]]
    : [];

  return { text, inline_keyboard };
}

export interface TelegramEscalationNoticeParams {
  /** Resolved location label: display_label ?? businesses.name. Always non-null. */
  locationLabel: string;
  reviewerName: string;
  starRating: number | null;
  reviewText: string | null;
  severity: TriageSeverity;
  issues: TriageIssue[];
  /** triage_source === 'fallback_high_v1' ⇒ "couldn't assess" copy, no severity claim. */
  isFallback: boolean;
  /** `${APP_URL}/dashboard/reviews` — the acknowledge surface (spec §2.7). */
  dashboardUrl: string;
}

/**
 * Pure formatter for the Guardian escalation notice (WS3). No approve/
 * regenerate buttons — a single "Open dashboard" URL button is the
 * acknowledge surface. Fallback-sourced escalations (triage couldn't
 * classify) use "needs a look" copy and claim no severity.
 */
export function formatEscalationNoticeTelegram(
  p: TelegramEscalationNoticeParams,
): FormattedApprovalMessage {
  const location = escapeHtml(sanitizeLocationLabelForPrefix(p.locationLabel));
  const reviewer = escapeHtml(p.reviewerName);
  const stars = p.starRating !== null ? `⭐${p.starRating}` : 'no rating';
  const preview = p.reviewText
    ? escapeHtml(truncate(p.reviewText, MAX_EMBED))
    : '(no review text)';
  const assessment = p.isFallback
    ? "We couldn't assess this review automatically — please take a look."
    : `${TRIAGE_SEVERITY_LABELS[p.severity]}.${
        p.issues.length > 0
          ? ` Flagged for: ${escapeHtml(p.issues.map((i) => TRIAGE_ISSUE_LABELS[i]).join(', '))}.`
          : ''
      }`;

  const text = [
    `<b>[${location}] ${p.isFallback ? '⚠️ A review needs a look' : '🚨 A review needs your attention'}</b>`,
    assessment,
    `Review from ${reviewer} (${stars}):`,
    `<i>${preview}</i>`,
  ].join('\n');

  const inline_keyboard: TelegramInlineButton[][] = [
    [{ text: '📋 Open dashboard', url: p.dashboardUrl }],
  ];

  return { text, inline_keyboard };
}

export interface TelegramPendingPostNoticeParams {
  /** Resolved location label: display_label ?? businesses.name. Always non-null. */
  locationLabel: string;
  reviewerName: string;
  starRating: number;
  reviewText: string | null;
  /** The auto-approved draft reply text. */
  responsePreview: string;
  /** responses.auto_post_scheduled_at — the veto deadline the copy phrases. */
  scheduledPostAt: Date;
  /** Tokenized approve-page link — the single "Review or cancel" CTA. */
  approveUrl: string;
  /** Send-time clock for the relative phrasing; injectable for tests. */
  now?: Date;
}

/**
 * Pure formatter for the pending-post notice (WS4 veto window). A single
 * "Review or cancel" URL button leads to the approve page — no inline
 * approve/regenerate callbacks (the reply is already approved; the only
 * decision is view/edit/cancel before the deadline).
 */
export function formatPendingPostNoticeTelegram(
  p: TelegramPendingPostNoticeParams,
): FormattedApprovalMessage {
  const location = escapeHtml(sanitizeLocationLabelForPrefix(p.locationLabel));
  const reviewer = escapeHtml(p.reviewerName);
  const reviewBody = p.reviewText
    ? escapeHtml(truncate(p.reviewText, MAX_EMBED))
    : '(no review text)';
  const preview = escapeHtml(truncate(p.responsePreview, MAX_EMBED));
  const { phrase } = formatScheduledPostTime(p.scheduledPostAt, p.now ?? new Date());

  const text = [
    `<b>[${location}] ⏳ Reply will post automatically</b>`,
    `Your auto-approved reply to ${reviewer}'s ⭐${p.starRating} review will post automatically at ${phrase} unless you cancel.`,
    `—`,
    `"${reviewBody}"`,
    `—`,
    `<b>Draft reply:</b>`,
    preview,
  ].join('\n');

  const inline_keyboard: TelegramInlineButton[][] = [
    [{ text: '✏️ Review or cancel', url: p.approveUrl }],
  ];

  return { text, inline_keyboard };
}
