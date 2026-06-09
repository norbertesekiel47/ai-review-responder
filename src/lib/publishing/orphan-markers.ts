// src/lib/publishing/orphan-markers.ts
//
// SHARED RECOVERY-MARKER CONTRACT for the edit-publisher DELETE-before-POST
// flow (spec `docs/superpowers/specs/2026-05-01-edit-existing-replies-design.md`
// §4.5/§4.7). When a DELETE succeeds but the POST does not, the candidate row
// is left with a `posting_error` carrying the `_after_delete_succeeded` suffix
// so recovery can tell "Google's reply slot is empty" apart from a plain
// fresh-publish failure.
//
// This file is the SINGLE SOURCE OF TRUTH for those marker strings. The
// orphan-conversion failed-hook (Task 7) and the `/retry` path (Task 11) MUST
// import from here rather than re-typing the literals — a typo in either would
// silently break recovery (the marker would no longer match and the orphan
// would never be reconciled). Keep this module tiny and dependency-free.

/** Suffix every orphan (DELETE-succeeded-without-POST-success) marker ends in. */
export const ORPHAN_SUCCEEDED_SUFFIX = '_after_delete_succeeded';

/** Transient/indeterminate orphan: DELETE committed, POST pending a retry. */
export const PENDING_AFTER_DELETE = 'pending_after_delete_succeeded';

/** Auth failure with NO committed DELETE (old reply still on Google). */
export const ZERNIO_AUTH_ERROR = 'zernio_auth_error';

/** Auth failure AFTER a committed DELETE (orphan: Google's slot is empty). */
export const ZERNIO_AUTH_ERROR_AFTER_DELETE = 'zernio_auth_error_after_delete_succeeded';

/** Prefix for permanent DELETE failure markers (no DELETE committed; sibling unchanged). */
export const DELETE_FAILED_PREFIX = 'delete_failed_';

/** Prefix for permanent POST failure markers AFTER a committed DELETE (orphan forming). */
export const POST_AFTER_DELETE_FAILED_PREFIX = 'post_after_delete_failed_';

/** Permanent DELETE failure marker (no DELETE committed; sibling unchanged). */
export const deleteFailedMarker = (kind: string) => `${DELETE_FAILED_PREFIX}${kind}`;

/** Permanent POST failure marker AFTER a committed DELETE (orphan forming). */
export const postAfterDeleteFailedMarker = (kind: string) => `${POST_AFTER_DELETE_FAILED_PREFIX}${kind}`;

/**
 * Marker stamped by processReview when a customer edits a review AFTER a
 * recoverable edit-publisher failure. This invalidates the previously-recoverable
 * failed row — /retry must refuse to recover it (the draft was for old review text).
 */
export const STALE_AFTER_REVIEW_CHANGED = 'stale_after_review_changed';

/**
 * Returns true when a `posting_error` value belongs to the allowlist of
 * recoverable failed edit-publisher rows that /retry is permitted to act on.
 * Only `delete_failed_*` and `post_after_delete_failed_*` prefixes are
 * recoverable. `stale_after_review_changed` and all other values are NOT.
 * This intentionally includes `POST_AFTER_DELETE_FAILED_RETRY_EXHAUSTED` — it
 * shares the `post_after_delete_failed_` prefix and is recoverable via an
 * owner-driven /retry; callers must not add a separate branch for it.
 */
export const isRecoverableFailedPostingError = (postingError: string | null | undefined): boolean =>
  !!postingError &&
  (postingError.startsWith(DELETE_FAILED_PREFIX) ||
    postingError.startsWith(POST_AFTER_DELETE_FAILED_PREFIX));

/**
 * Terminal marker the failed-hook (Task 7) stamps when BullMQ exhausts retries
 * while the row is still in an orphan state (DELETE committed, POST never
 * succeeded). This is the recovery-visible `status='failed'` state the owner
 * `/retry` + `/restore-original` routes (Task 11) key off. Distinct from the
 * `postAfterDeleteFailedMarker(kind)` family (those are PERMANENT-error orphans
 * written by edit-publish itself); this one means "transient/indeterminate
 * orphan that ran out of automatic retries".
 */
export const POST_AFTER_DELETE_FAILED_RETRY_EXHAUSTED = 'post_after_delete_failed_retry_exhausted';

/** True when a `posting_error` denotes an orphan (DELETE committed, POST did not). */
export const isOrphanMarker = (postingError: string | null | undefined): boolean =>
  !!postingError && postingError.endsWith(ORPHAN_SUCCEEDED_SUFFIX);
