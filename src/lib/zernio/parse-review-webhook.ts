// src/lib/zernio/parse-review-webhook.ts
//
// Zernio review webhook payload shape (per Zernio docs as of 2026-04-29 — verify
// against current Zernio webhook spec during implementation):
//
//   {
//     event: 'review.new' | 'review.updated',
//     id: string,                              // event id (also in x-zernio-event-id)
//     account: { id: string },                 // Zernio account id (NOT Google's)
//     review: {
//       id: string,                            // Zernio review id (canonical)
//       name?: string,                         // 'accounts/{a}/locations/{l}/reviews/{r}'
//     },
//   }

export interface ParsedReviewWebhook {
  /** Top-level Zernio account.id from the webhook envelope. Used for the
   *  zernio_connections lookup and Zernio API calls. NOTE: this is distinct
   *  from the {accountResource} segment in any review resource-name path —
   *  the resource path segment is Google's account ID, a different ID space.
   *  Do NOT cross-check the two. */
  accountId: string;
  /** BARE review id (last path segment, never a slash-separated resource form).
   *  Compared directly to ZernioReview.id from listReviews. */
  reviewId: string;
  /** Location id extracted from a review resource-name path, if present.
   *  Optional — the ingest worker doesn't depend on this for routing
   *  (it fans out per active connection and filters by listReviews output),
   *  but logging it aids debugging multi-location fan-out. */
  locationIdFromPayload: string | null;
  /** Full resource-name form when supplied, retained for logging only. */
  fullReviewName: string | null;
}

/** Bound for the truncated raw-payload preview attached to parse errors.
 *  Webhook bodies don't typically contain secrets but reviewer names +
 *  addresses count as PII; capping the preview keeps Sentry breadcrumbs
 *  bounded. Full body still hits worker logs (governed by Sentry's
 *  global beforeSend scrubber). */
const RAW_PREVIEW_LIMIT = 500;

function truncateRaw(raw: unknown): string {
  let s: string;
  try {
    if (typeof raw === 'string') s = raw;
    else if (raw === undefined) s = 'undefined';
    else s = JSON.stringify(raw) ?? String(raw);
  } catch {
    s = String(raw);
  }
  if (s.length <= RAW_PREVIEW_LIMIT) return s;
  return `${s.slice(0, RAW_PREVIEW_LIMIT)}…[truncated, total=${s.length}]`;
}

export class ZernioReviewWebhookParseError extends Error {
  /** Length-bounded preview of the raw payload for debugging — NOT the
   *  full body, so Sentry breadcrumbs can't accidentally capture
   *  many-KB review payloads. */
  readonly rawPreview: string;
  constructor(reason: string, raw: unknown) {
    super(`[parse-review-webhook] ${reason}`);
    this.name = 'ZernioReviewWebhookParseError';
    this.rawPreview = truncateRaw(raw);
  }
}

// Resource-name shape per Google Business Profile API convention:
//   accounts/{accountResource}/locations/{locationResource}/reviews/{reviewResource}
// CRITICAL: the {accountResource} segment in this path is the Google Business
// account identifier — it is NOT the same ID space as the top-level Zernio
// `account.id` in the webhook envelope. Do NOT cross-check them.
const REVIEW_NAME_RE = /^accounts\/([^/]+)\/locations\/([^/]+)\/reviews\/([^/]+)$/;

function extractBareReviewId(value: string): { bareReviewId: string; locationFromPath: string | null } {
  const trimmed = value.trim();
  if (!trimmed) return { bareReviewId: '', locationFromPath: null };

  if (trimmed.includes('/')) {
    const m = trimmed.match(REVIEW_NAME_RE);
    if (m && m[2] && m[3]) {
      const locationSegment = m[2];
      const reviewSegment = m[3];
      return { bareReviewId: reviewSegment, locationFromPath: locationSegment };
    }
    return { bareReviewId: '', locationFromPath: null };
  }

  return { bareReviewId: trimmed, locationFromPath: null };
}

function extractValidatedAccountId(body: object): string {
  const account = (body as Record<string, unknown>).account;
  if (!account || typeof account !== 'object') {
    throw new ZernioReviewWebhookParseError('missing account object', body);
  }
  const accountId = (account as Record<string, unknown>).id;
  if (typeof accountId !== 'string' || accountId.trim().length === 0) {
    throw new ZernioReviewWebhookParseError('account.id missing or empty', body);
  }
  return accountId.trim();
}

// Merge a candidate id/segment into the value already resolved from another
// field (review.id vs review.name). A falsy candidate leaves the accumulator
// untouched; a non-matching candidate is a hard parse error.
function mergeOrConflict(
  existing: string | null,
  candidate: string | null,
  describeConflict: (existing: string, candidate: string) => string,
  body: unknown,
): string | null {
  if (!candidate) return existing;
  if (existing !== null && existing !== candidate) {
    throw new ZernioReviewWebhookParseError(describeConflict(existing, candidate), body);
  }
  return candidate;
}

interface ReviewIdentifiers {
  bareReviewId: string;
  locationIdFromPayload: string | null;
  fullReviewName: string | null;
}

function resolveReviewIdentifiers(body: object): ReviewIdentifiers {
  const review = (body as Record<string, unknown>).review;
  if (!review || typeof review !== 'object') {
    throw new ZernioReviewWebhookParseError('missing review object', body);
  }
  const r = review as Record<string, unknown>;

  let bareReviewId: string | null = null;
  let locationIdFromPayload: string | null = null;
  let fullReviewName: string | null = null;

  if (typeof r.id === 'string' && r.id.trim().length > 0) {
    const ext = extractBareReviewId(r.id);
    if (ext.bareReviewId) bareReviewId = ext.bareReviewId;
    if (ext.locationFromPath) locationIdFromPayload = ext.locationFromPath;
    if (r.id.includes('/')) fullReviewName = r.id.trim();
  }

  if (typeof r.name === 'string' && r.name.trim().length > 0) {
    const ext = extractBareReviewId(r.name);
    bareReviewId = mergeOrConflict(
      bareReviewId,
      ext.bareReviewId || null,
      (a, b) => `review.id and review.name yield different bare ids: ${a} vs ${b}`,
      body,
    );
    locationIdFromPayload = mergeOrConflict(
      locationIdFromPayload,
      ext.locationFromPath,
      (a, b) => `review.id and review.name yield different location segments: ${a} vs ${b}`,
      body,
    );
    fullReviewName = r.name.trim();
  }

  if (!bareReviewId) {
    throw new ZernioReviewWebhookParseError('could not extract bare review id from review.id or review.name', body);
  }

  return { bareReviewId, locationIdFromPayload, fullReviewName };
}

export function parseZernioReviewWebhook(body: unknown): ParsedReviewWebhook {
  if (!body || typeof body !== 'object') {
    throw new ZernioReviewWebhookParseError('body is not an object', body);
  }
  const accountId = extractValidatedAccountId(body);
  const { bareReviewId, locationIdFromPayload, fullReviewName } =
    resolveReviewIdentifiers(body);
  return { accountId, reviewId: bareReviewId, locationIdFromPayload, fullReviewName };
}
