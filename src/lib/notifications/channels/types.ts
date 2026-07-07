// src/lib/notifications/channels/types.ts
//
// Pluggable transport interface for approval notifications. Mirrors the
// ReviewSource pattern in src/lib/reviews/. Each implementation wraps exactly
// one provider (Resend, Twilio, Telegram Bot API, etc.) and produces a
// deterministic external_message_id for delivery tracking.
//
// See docs/plans/adding-communication-channels.md §1 for rationale.

import type { TriageIssue, TriageSeverity } from '@/lib/reviews/triage-schema';

/** The set of notification channels. Single owner — every enumeration of
 *  channels (dispatch order, SQL filters, eligibility records) derives from
 *  this. Declaration order IS the notification dispatch order. */
export const CHANNEL_IDS = ['email', 'telegram', 'whatsapp'] as const;
export type ChannelId = (typeof CHANNEL_IDS)[number];

export interface SendApprovalParams {
  /** Per-enrollment recipient: email address, E.164 phone, or telegram chat_id. */
  handle: string;
  /** Resolved location label: display_label ?? businesses.name. Used for template prefix. */
  locationLabel: string;
  businessName: string;
  reviewerName: string;
  starRating: number;
  reviewText: string | null;
  reviewDate: string;
  responsePreview: string;
  /**
   * Always provided. Link-based channels use this as the message body CTA.
   * Inline-capable channels use it as the "Edit" URL button target.
   * Contains the raw approval token in the URL path — legitimate for URLs
   * (matches existing email flow), but MUST NOT appear in inline-button
   * callback payloads.
   */
  approvalUrl: string;
  /**
   * UUIDv7 of the approval_links row. Used by inline-capable channels
   * (Telegram, WhatsApp) as the button callback payload. Non-secret.
   * Safe to persist in inbound_events.payload. See spec §3.2.
   *
   * Supersedes the original plan's `rawToken` field, which would have
   * leaked raw approval tokens into inbound_events via webhook bodies —
   * violating the "approval tokens NEVER stored raw" invariant.
   */
  approvalLinkId: string;
  /**
   * Stable provider idempotency key for this logical approval send (per response +
   * channel). Channels backed by a provider that supports it (email/Resend) pass
   * it through so a timeout-retry or failover re-send of the SAME approval dedupes
   * instead of double-sending. Channels without provider idempotency ignore it.
   */
  idempotencyKey?: string;
}

export interface SendApprovalResult {
  /** Provider-assigned message ID. Stored in notification_deliveries.external_message_id. */
  externalMessageId: string;
}

/**
 * Params for the auto-approved post FYI (Workstream B). NO approval fields —
 * the response is already posted to Google. The "View on Google" CTA routes
 * through the hardened `/r/google/<responseId>` redirect (`viewUrl`);
 * `responseId` is also the dynamic suffix for the WhatsApp template URL button.
 */
export interface SendAutoPostNoticeParams {
  /** Per-enrollment recipient: email address, E.164 phone, or telegram chat_id. */
  handle: string;
  locationLabel: string;
  businessName: string;
  reviewerName: string;
  starRating: number;
  /** Business-profile Google Maps URL, or null when unknown. Free-form channels omit the CTA when null. */
  googleMapsUrl: string | null;
  /** Stable redirect CTA target: `${APP_URL}/r/google/${responseId}`. */
  viewUrl: string;
  /** responseId — dynamic suffix for the WhatsApp template URL button. */
  responseId: string;
}

/**
 * Discriminated result so a channel can decline cleanly — e.g. WhatsApp without
 * its FYI template SID — without a fake success or a retry loop.
 */
export type SendAutoPostNoticeResult =
  | { status: 'sent'; externalMessageId: string }
  | { status: 'skipped'; reason: string };

/**
 * Params for the Guardian escalation notice (WS3). Content comes from the
 * persisted triage snapshot on review_escalations — no approval affordance,
 * no LLM call. Review text is legal in the MESSAGE (private owner channel);
 * it must never reach logs/step detail/outbox payloads.
 */
export interface SendEscalationNoticeParams {
  /** Per-enrollment recipient: email address, E.164 phone, or telegram chat_id. */
  handle: string;
  locationLabel: string;
  businessName: string;
  reviewerName: string;
  starRating: number | null;
  reviewText: string | null;
  severity: TriageSeverity;
  issues: TriageIssue[];
  /** triage_source === 'fallback_high_v1' ⇒ "couldn't assess" copy, no severity claim. */
  isFallback: boolean;
  /** `${APP_URL}/dashboard/reviews` — the acknowledge surface (spec §2.7). */
  dashboardUrl: string;
  /** review_escalations id — provider idempotency + WhatsApp template suffix. */
  escalationId: string;
}

export type SendEscalationNoticeResult =
  | { status: 'sent'; externalMessageId: string }
  | { status: 'skipped'; reason: string };

export interface NotificationChannel {
  readonly id: ChannelId;
  /** True if the channel supports inline buttons for approve/regenerate. */
  readonly supportsInlineActions: boolean;
  /** True if owner must initiate contact before we can send (Telegram, WhatsApp). */
  readonly requiresOptInHandshake: boolean;
  sendApprovalRequest(p: SendApprovalParams): Promise<SendApprovalResult>;
  /**
   * Send the per-event "your response was auto-approved & posted" FYI. NO
   * approval affordance (the post already happened). Returns a sent/skipped
   * union (see SendAutoPostNoticeResult).
   */
  sendAutoPostNotice(p: SendAutoPostNoticeParams): Promise<SendAutoPostNoticeResult>;
  /**
   * Send the Guardian escalation notice (WS3): "this review needs your
   * attention", with triage context and a dashboard CTA. Returns a
   * sent/skipped union (WhatsApp skips without its approved template SID).
   */
  sendEscalationNotice(p: SendEscalationNoticeParams): Promise<SendEscalationNoticeResult>;
}
