// ── Response status values ───────────────────────────────────────────
// responses.status column — keep in sync with CLAUDE.md and migration comments.

export const ResponseStatus = {
  PENDING_APPROVAL: 'pending_approval',
  APPROVED: 'approved',
  EDITED: 'edited',
  SUPERSEDED: 'superseded',
  AWAITING_OWNER_CONNECT: 'awaiting_owner_connect',
  POSTED: 'posted',
  FAILED: 'failed',
} as const;

export type ResponseStatus = (typeof ResponseStatus)[keyof typeof ResponseStatus];

// ── Subscription status values ──────────────────────────────────────
// businesses.subscription_status column

export const SubscriptionStatus = {
  PENDING_PAYMENT: 'pending_payment',
  ACTIVE: 'active',
  PAST_DUE: 'past_due',
  CANCELLED: 'cancelled',
} as const;

export type SubscriptionStatus = (typeof SubscriptionStatus)[keyof typeof SubscriptionStatus];

// ── Review exception types ──────────────────────────────────────────

export const ExceptionType = {
  REVIEW_EDITED_AFTER_POST: 'review_edited_after_post',
  IDENTITY_COLLISION: 'identity_collision',
  PLACE_ID_RESOLUTION_REQUIRED: 'place_id_resolution_required',
  PLACE_ID_RESOLUTION_FAILED: 'place_id_resolution_failed',
} as const;

// ── HTTP headers ────────────────────────────────────────────────────

export const NO_STORE_HEADERS = { 'Cache-Control': 'no-store, private' } as const;

// ── Google Maps URL ─────────────────────────────────────────────────

export function buildGoogleMapsUrl(placeId: string): string {
  return `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(placeId)}`;
}
