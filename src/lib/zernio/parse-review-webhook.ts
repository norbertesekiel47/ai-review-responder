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

export class ZernioReviewWebhookParseError extends Error {
  constructor(reason: string, readonly raw: unknown) {
    super(`[parse-review-webhook] ${reason}`);
    this.name = 'ZernioReviewWebhookParseError';
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

export function parseZernioReviewWebhook(body: unknown): ParsedReviewWebhook {
  if (!body || typeof body !== 'object') {
    throw new ZernioReviewWebhookParseError('body is not an object', body);
  }
  const b = body as Record<string, unknown>;

  const account = b.account;
  if (!account || typeof account !== 'object') {
    throw new ZernioReviewWebhookParseError('missing account object', body);
  }
  const accountId = (account as Record<string, unknown>).id;
  if (typeof accountId !== 'string' || accountId.trim().length === 0) {
    throw new ZernioReviewWebhookParseError('account.id missing or empty', body);
  }

  const review = b.review;
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
    if (ext.bareReviewId) {
      if (bareReviewId && bareReviewId !== ext.bareReviewId) {
        throw new ZernioReviewWebhookParseError(
          `review.id and review.name yield different bare ids: ${bareReviewId} vs ${ext.bareReviewId}`, body,
        );
      }
      bareReviewId = ext.bareReviewId;
    }
    if (ext.locationFromPath) {
      if (locationIdFromPayload && locationIdFromPayload !== ext.locationFromPath) {
        throw new ZernioReviewWebhookParseError(
          `review.id and review.name yield different location segments: ${locationIdFromPayload} vs ${ext.locationFromPath}`, body,
        );
      }
      locationIdFromPayload = ext.locationFromPath;
    }
    fullReviewName = r.name.trim();
  }

  if (!bareReviewId) {
    throw new ZernioReviewWebhookParseError('could not extract bare review id from review.id or review.name', body);
  }

  return { accountId: accountId.trim(), reviewId: bareReviewId, locationIdFromPayload, fullReviewName };
}
