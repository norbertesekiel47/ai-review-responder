// src/lib/notifications/channels/whatsapp-body.ts
//
// Pure helpers for the WhatsApp channel. No I/O, no env reads at module scope
// (Phase 3 spec §2.0 sequencing rule 2 — side-effect-free at import). All inputs
// flow through function params; the template SID is passable in rather than
// read from config (getWorkerConfig()) so tests don't need to mutate env. The
// default-param config read evaluates at call time (send-time), never at import.
//
// Template shape authoritative reference: docs/runbooks/whatsapp-templates.md

import { getWorkerConfig } from '@/lib/config/worker';
import { TRIAGE_SEVERITY_LABELS, type TriageSeverity } from '@/lib/reviews/triage-schema';
import { formatScheduledPostTime } from './scheduled-post-time';
import type { SendApprovalParams } from './types';

export interface WhatsAppSendContent {
  contentSid: string;
  /** Keys "1".."9" per docs/runbooks/whatsapp-templates.md repworth_approval_request_v1. */
  contentVariables: Record<string, string>;
}

// Body of the Meta-approved repworth_approval_request_v1 whatsapp/card template.
// Authoritative copy lives in docs/runbooks/whatsapp-templates.md; this constant
// must stay byte-identical to the submitted template so the truncation budget
// below is computed against the REAL rendered length. A wording/whitespace/emoji
// change here requires a matching template edit and a fresh Meta review cycle.
const APPROVAL_CARD_BODY_TEMPLATE =
  'New ⭐{{3}} review for {{1}}\n\n' +
  'From: {{2}} · {{4}}\n\n' +
  '"{{5}}"\n\n' +
  'Draft reply:\n{{6}}';

const PLACEHOLDER_RE = /\{\{(\d+)\}\}/g;

// whatsapp/card body hard limit after variable substitution (Twilio 21656 on
// overflow). The safety margin absorbs any difference between JS `.length`
// (UTF-16 code units) and Meta's own character accounting for emoji/graphemes.
const WHATSAPP_CARD_BODY_LIMIT = 1024;
const BODY_SAFETY_MARGIN = 64;

// Fixed (non-variable) character count of the rendered body — computed from the
// template itself so it can never drift from the literal above.
const FIXED_BODY_OVERHEAD = APPROVAL_CARD_BODY_TEMPLATE.replace(PLACEHOLDER_RE, '').length;

// Bounded variables whose worst case we reserve against (docs maxes). The
// formatter clamps each so the free-text budget below is a provable upper bound.
const BUSINESS_NAME_MAX = 100;
const REVIEWER_NAME_MAX = 100;
const REVIEW_DATE_MAX = 12;
const STAR_RATING_MAX = 1;

// Whatever remains after the fixed text, the safety margin, and the bounded
// variables is shared between the two free-text variables ({{5}} review text,
// {{6}} draft reply). Derived as one budget then split so the two halves can
// never sum past the ceiling.
const FREE_TEXT_BUDGET =
  WHATSAPP_CARD_BODY_LIMIT -
  BODY_SAFETY_MARGIN -
  FIXED_BODY_OVERHEAD -
  STAR_RATING_MAX -
  BUSINESS_NAME_MAX -
  REVIEWER_NAME_MAX -
  REVIEW_DATE_MAX;
const RESPONSE_PREVIEW_MAX = Math.ceil(FREE_TEXT_BUDGET / 2);
const REVIEW_TEXT_MAX = FREE_TEXT_BUDGET - RESPONSE_PREVIEW_MAX;

export function truncate(text: string | null, limit: number): string {
  if (text === null) return '';
  if (text.length <= limit) return text;
  return text.slice(0, limit - 1) + '…';
}

/**
 * Render the approval card body exactly as Twilio/WhatsApp will after variable
 * substitution. Substitution is server-side at send time (we only pass the
 * `contentVariables` map), so this is not used to send — it is the single
 * authoritative reference for the template body, consumed by the length-budget
 * test that guards the 1024-char ceiling. Missing keys render as empty strings,
 * mirroring Twilio's behavior for unset variables.
 */
export function renderApprovalCardBody(vars: Record<string, string>): string {
  return APPROVAL_CARD_BODY_TEMPLATE.replace(PLACEHOLDER_RE, (_match, index: string) => vars[index] ?? '');
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

// WhatsApp template parameters reject newlines, tabs, and 4+ consecutive
// spaces (Meta policy → Twilio error 21656). Collapse every whitespace run to a
// single space so free-text values (review text, AI-generated draft) are valid
// as card-body variables. Only the WhatsApp *preview* copy is flattened — the
// stored response keeps its formatting for the Edit page and Google posting.
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Format a SendApprovalParams into Twilio Content variables for the
 * repworth_approval_request_v1 template. Second param `contentSid` allows
 * tests to pass a deterministic SID; production callers omit it to fall back
 * to WHATSAPP_APPROVAL_TEMPLATE_SID (read via getWorkerConfig() — default-param
 * evaluates at call time, i.e. send-time on the worker, never at module load).
 */
export function formatApprovalWhatsApp(
  params: SendApprovalParams,
  contentSid: string = getWorkerConfig().WHATSAPP_APPROVAL_TEMPLATE_SID ?? '',
): WhatsAppSendContent {
  return {
    contentSid,
    contentVariables: {
      '1': truncate(oneLine(params.businessName), BUSINESS_NAME_MAX),
      '2': truncate(oneLine(params.reviewerName || 'Reviewer'), REVIEWER_NAME_MAX),
      '3': String(params.starRating),
      '4': truncate(oneLine(params.reviewDate), REVIEW_DATE_MAX),
      '5': truncate(oneLine(params.reviewText ?? '(no comment)'), REVIEW_TEXT_MAX),
      '6': truncate(oneLine(params.responsePreview), RESPONSE_PREVIEW_MAX),
      '7': `a:${params.approvalLinkId}`,
      '8': `r:${params.approvalLinkId}`,
      '9': extractTokenFromApprovalUrl(params.approvalUrl),
    },
  };
}

export interface AutoPostNoticeWhatsAppParams {
  businessName: string;
  reviewerName: string;
  starRating: number;
  /** responseId — the URL button suffix for `/r/google/{{4}}`. */
  responseId: string;
}

/**
 * Format the auto-approved post FYI into Twilio Content variables for the
 * repworth_autopost_notice_v1 template (docs/runbooks/whatsapp-templates.md).
 * The template's single URL button is `<APP_URL>/r/google/{{4}}` — a fixed
 * prefix + dynamic responseId suffix (same shape as the approved approval
 * template's `/approve/{{9}}` button). Second param `contentSid` lets tests
 * pass a deterministic SID; production callers omit it to fall back to
 * WHATSAPP_AUTOPOST_TEMPLATE_SID (read via getWorkerConfig() — default-param
 * evaluates at call time, i.e. send-time on the worker, never at module load).
 */
export function formatAutoPostNoticeWhatsApp(
  params: AutoPostNoticeWhatsAppParams,
  contentSid: string = getWorkerConfig().WHATSAPP_AUTOPOST_TEMPLATE_SID ?? '',
): WhatsAppSendContent {
  return {
    contentSid,
    contentVariables: {
      // Same clamp as formatApprovalWhatsApp ({{1}}/{{2}}): oneLine() alone
      // strips newlines but leaves length unbounded — a pathological business
      // or reviewer name can still overflow the card body and trip Twilio
      // 21656, silently dropping the FYI. Cap both at the documented max.
      '1': truncate(oneLine(params.businessName), BUSINESS_NAME_MAX),
      '2': truncate(oneLine(params.reviewerName || 'Reviewer'), REVIEWER_NAME_MAX),
      '3': String(params.starRating),
      '4': params.responseId,
    },
  };
}

export interface EscalationNoticeWhatsAppParams {
  businessName: string;
  reviewerName: string;
  starRating: number | null;
  severity: TriageSeverity;
  /** triage_source === 'fallback_high_v1' ⇒ "Needs a look" label, no severity claim. */
  isFallback: boolean;
  escalationId: string;
}

/**
 * Format the Guardian escalation notice (WS3) into Twilio Content variables
 * for a future Meta-approved template (WHATSAPP_ESCALATION_TEMPLATE_SID). No
 * review text in the variables — business/reviewer/stars/severity/id only
 * (business-initiated WhatsApp send = approved template, never free-form).
 * Severity label is computed here (single owner: TRIAGE_SEVERITY_LABELS) —
 * the channel adapter passes the raw severity/isFallback through, it does
 * not humanize them itself.
 * Second param `contentSid` is required (no config default): the channel
 * self-protects by skipping the send entirely when the SID is unset, so
 * there is no meaningful "current call site" default to fall back to.
 */
export function formatEscalationNoticeWhatsApp(
  params: EscalationNoticeWhatsAppParams,
  contentSid: string,
): WhatsAppSendContent {
  return {
    contentSid,
    contentVariables: {
      '1': truncate(oneLine(params.businessName), BUSINESS_NAME_MAX),
      '2': truncate(oneLine(params.reviewerName || 'Reviewer'), REVIEWER_NAME_MAX),
      '3': params.starRating !== null ? String(params.starRating) : '–',
      '4': params.isFallback ? 'Needs a look' : TRIAGE_SEVERITY_LABELS[params.severity],
      '5': params.escalationId,
    },
  };
}

export interface PendingPostNoticeWhatsAppParams {
  businessName: string;
  reviewerName: string;
  starRating: number;
  reviewText: string | null;
  /** The auto-approved draft reply text. */
  responsePreview: string;
  /** responses.auto_post_scheduled_at — the veto deadline the copy phrases. */
  scheduledPostAt: Date;
  /** `/approve/<rawToken>` link — the token becomes the template URL-button suffix. */
  approveUrl: string;
  /** Send-time clock for the relative phrasing; injectable for tests. */
  now?: Date;
}

/**
 * Format the pending-post notice (WS4 veto window) into Twilio Content
 * variables for a future Meta-approved template
 * (WHATSAPP_PENDING_POST_TEMPLATE_SID; authoritative template content:
 * docs/runbooks/whatsapp-templates.md, "Pending-post notice" section). The
 * template's single URL button is `<APP_URL>/approve/{{7}}` — fixed prefix +
 * raw-token suffix, same shape as the approval template's `/approve/{{9}}`
 * button.
 *
 * Free-text budgets reuse the approval card's REVIEW_TEXT_MAX /
 * RESPONSE_PREVIEW_MAX split. Verified against the real template body in the
 * runbook section above (2026-07-09): fixed body text 59 chars + clamped
 * bounded vars + a ≤40-char time phrase + 350/350 free text = 1000 worst
 * case, ≤ WHATSAPP_CARD_BODY_LIMIT (1024) with 24 chars headroom. A body-copy
 * change, a budget-constant change, or a veto-window domain change that
 * lengthens the phrase requires re-running the runbook's budget arithmetic.
 *
 * Second param `contentSid` is required (no config default): the channel
 * self-protects by skipping the send entirely when the SID is unset
 * (escalation-notice precedent).
 */
export function formatPendingPostNoticeWhatsApp(
  params: PendingPostNoticeWhatsAppParams,
  contentSid: string,
): WhatsAppSendContent {
  const { phrase } = formatScheduledPostTime(params.scheduledPostAt, params.now ?? new Date());
  return {
    contentSid,
    contentVariables: {
      '1': truncate(oneLine(params.businessName), BUSINESS_NAME_MAX),
      '2': truncate(oneLine(params.reviewerName || 'Reviewer'), REVIEWER_NAME_MAX),
      '3': String(params.starRating),
      '4': phrase,
      '5': truncate(oneLine(params.reviewText ?? '(no comment)'), REVIEW_TEXT_MAX),
      '6': truncate(oneLine(params.responsePreview), RESPONSE_PREVIEW_MAX),
      '7': extractTokenFromApprovalUrl(params.approveUrl),
    },
  };
}

export interface AutonomySuspendedNoticeWhatsAppParams {
  accountName: string;
  reason: string;
  /** Dynamic suffix for the approved template's settings URL button. */
  settingsPath: string;
}

const AUTONOMY_SUSPENDED_NOTICE_WHATSAPP_BODY_TEMPLATE =
  'Auto-posting paused for {{1}}\n\n' +
  'Auto-posting was paused after a safety review. This pause applies to your entire account.\n\n' +
  'Drafts will continue, but you will need to review and approve them manually.\n\n' +
  'Reason: {{2}}\n\n' +
  'Need help? Contact support@repworth.net.';

export function renderAutonomySuspendedNoticeWhatsAppBody(
  variables: Record<string, string>,
): string {
  return AUTONOMY_SUSPENDED_NOTICE_WHATSAPP_BODY_TEMPLATE.replace(
    PLACEHOLDER_RE,
    (_match, index: string) => variables[index] ?? '',
  );
}

/**
 * Variables for the account-level safety template. The approved static body
 * carries the pause/account/manual-approval/support copy; these variables add
 * only account-safe context and the settings URL suffix.
 */
export function formatAutonomySuspendedNoticeWhatsApp(
  params: AutonomySuspendedNoticeWhatsAppParams,
  contentSid: string,
): WhatsAppSendContent {
  if (params.settingsPath !== 'settings/auto-approval') {
    throw new Error(
      'formatAutonomySuspendedNoticeWhatsApp: settingsPath must equal settings/auto-approval',
    );
  }
  return {
    contentSid,
    contentVariables: {
      '1': truncate(oneLine(params.accountName), BUSINESS_NAME_MAX),
      '2': truncate(oneLine(params.reason), 160),
      '3': oneLine(params.settingsPath),
    },
  };
}
