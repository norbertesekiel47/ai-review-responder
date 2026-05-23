// worker/jobs/publisher/orphan-markers.ts
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

/** Permanent DELETE failure marker (no DELETE committed; sibling unchanged). */
export const deleteFailedMarker = (kind: string) => `delete_failed_${kind}`;

/** Permanent POST failure marker AFTER a committed DELETE (orphan forming). */
export const postAfterDeleteFailedMarker = (kind: string) => `post_after_delete_failed_${kind}`;

/** True when a `posting_error` denotes an orphan (DELETE committed, POST did not). */
export const isOrphanMarker = (postingError: string | null | undefined): boolean =>
  !!postingError && postingError.endsWith(ORPHAN_SUCCEEDED_SUFFIX);
