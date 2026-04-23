// src/lib/notifications/channels/whatsapp-body.ts
//
// Pure helpers for the WhatsApp channel. No I/O, no env reads at module scope
// (Phase 3 spec §2.0 sequencing rule 2 — side-effect-free at import). All inputs
// flow through function params; the template SID is passable in rather than
// read from process.env so tests don't need to mutate env.
//
// Template shape authoritative reference: docs/whatsapp-templates.md

import type { SendApprovalParams } from './types';

export interface WhatsAppSendContent {
  contentSid: string;
  /** Keys "1".."9" per docs/whatsapp-templates.md repworth_approval_request_v1. */
  contentVariables: Record<string, string>;
}

const REVIEW_TEXT_MAX = 400;
const RESPONSE_PREVIEW_MAX = 400;

export function truncate(text: string | null, limit: number): string {
  if (text === null) return '';
  if (text.length <= limit) return text;
  return text.slice(0, limit - 1) + '…';
}

export function stripWaPrefix(from: string): string {
  return from.startsWith('whatsapp:') ? from.slice(9) : from;
}

export function toWaRecipient(handle: string): string {
  return handle.startsWith('whatsapp:') ? handle : `whatsapp:${handle}`;
}

/**
 * Parse the raw approval token from a dispatcher-constructed approval URL.
 * Uses the real URL parser — NOT a naive split('/').pop() — and rejects
 * empty / malformed / trailing-slash / query-string-corrupted inputs so the
 * send path fails loud on an upstream bug rather than silently shipping a
 * broken URL button.
 */
export function extractTokenFromApprovalUrl(url: string): string {
  if (!url) throw new Error('extractTokenFromApprovalUrl: empty URL');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`extractTokenFromApprovalUrl: malformed URL: ${url}`);
  }
  // Reject trailing-slash URLs before filtering: a pathname ending in '/'
  // means the last intended segment is empty (e.g. /approve/ → token missing).
  if (parsed.pathname.endsWith('/')) {
    throw new Error(`extractTokenFromApprovalUrl: empty path segment (trailing slash): ${url}`);
  }
  const last = parsed.pathname.split('/').filter(Boolean).at(-1);
  if (!last) throw new Error(`extractTokenFromApprovalUrl: empty path segment: ${url}`);
  return last;
}

/**
 * Format a SendApprovalParams into Twilio Content variables for the
 * repworth_approval_request_v1 template. Second param `contentSid` allows
 * tests to pass a deterministic SID; production callers omit it to fall
 * back to process.env.WHATSAPP_APPROVAL_TEMPLATE_SID.
 */
export function formatApprovalWhatsApp(
  params: SendApprovalParams,
  contentSid: string = process.env.WHATSAPP_APPROVAL_TEMPLATE_SID ?? '',
): WhatsAppSendContent {
  return {
    contentSid,
    contentVariables: {
      '1': params.businessName,
      '2': params.reviewerName || 'Reviewer',
      '3': String(params.starRating),
      '4': params.reviewDate,
      '5': truncate(params.reviewText ?? '(no comment)', REVIEW_TEXT_MAX),
      '6': truncate(params.responsePreview, RESPONSE_PREVIEW_MAX),
      '7': `a:${params.approvalLinkId}`,
      '8': `r:${params.approvalLinkId}`,
      '9': extractTokenFromApprovalUrl(params.approvalUrl),
    },
  };
}
