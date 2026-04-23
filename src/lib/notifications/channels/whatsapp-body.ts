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
 *
 * REQUIRED shape: `<scheme>://<host>/approve/<token>` with no query string,
 * no hash fragment, and a non-empty token. Any deviation throws — staging /
 * local misconfiguration that generates a different URL base fails loud here
 * rather than shipping a broken URL button into a Meta-approved template
 * whose URL suffix variable is wired to the raw token only.
 */
export function extractTokenFromApprovalUrl(url: string): string {
  if (!url) throw new Error('extractTokenFromApprovalUrl: empty URL');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`extractTokenFromApprovalUrl: malformed URL: ${url}`);
  }
  if (parsed.search) {
    throw new Error(`extractTokenFromApprovalUrl: query string not permitted: ${url}`);
  }
  if (parsed.hash) {
    throw new Error(`extractTokenFromApprovalUrl: hash fragment not permitted: ${url}`);
  }
  // Expected pathname: /approve/<token> with exactly one segment after approve.
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length !== 2 || segments[0] !== 'approve') {
    throw new Error(`extractTokenFromApprovalUrl: expected /approve/<token> shape, got pathname: ${parsed.pathname}`);
  }
  const token = segments[1]!;
  if (!token) {
    throw new Error(`extractTokenFromApprovalUrl: empty token: ${url}`);
  }
  return token;
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
