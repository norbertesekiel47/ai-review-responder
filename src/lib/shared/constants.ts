// ── Review exception types ──────────────────────────────────────────

export const ExceptionType = {
  REVIEW_EDITED_AFTER_POST: 'review_edited_after_post',
  IDENTITY_COLLISION: 'identity_collision',
  PLACE_ID_RESOLUTION_REQUIRED: 'place_id_resolution_required',
  PLACE_ID_RESOLUTION_FAILED: 'place_id_resolution_failed',
} as const;

// ── HTTP headers ────────────────────────────────────────────────────

export const NO_STORE_HEADERS = { 'Cache-Control': 'no-store, private' } as const;
