import { describe, it, expect } from 'vitest';
import {
  DELETE_FAILED_PREFIX,
  POST_AFTER_DELETE_FAILED_PREFIX,
  STALE_AFTER_REVIEW_CHANGED,
  POST_AFTER_DELETE_FAILED_RETRY_EXHAUSTED,
  ORPHAN_SUCCEEDED_SUFFIX,
  PENDING_AFTER_DELETE,
  deleteFailedMarker,
  postAfterDeleteFailedMarker,
  isRecoverableFailedPostingError,
  isOrphanMarker,
} from '../orphan-markers';

describe('orphan-markers — shared recovery-marker contract', () => {
  // ── constant values ────────────────────────────────────────────────────────

  describe('constant values', () => {
    it('DELETE_FAILED_PREFIX is byte-identical to the expected literal', () => {
      expect(DELETE_FAILED_PREFIX).toBe('delete_failed_');
    });

    it('POST_AFTER_DELETE_FAILED_PREFIX is byte-identical to the expected literal', () => {
      expect(POST_AFTER_DELETE_FAILED_PREFIX).toBe('post_after_delete_failed_');
    });

    it('STALE_AFTER_REVIEW_CHANGED is byte-identical to the expected literal', () => {
      expect(STALE_AFTER_REVIEW_CHANGED).toBe('stale_after_review_changed');
    });

    it('POST_AFTER_DELETE_FAILED_RETRY_EXHAUSTED is byte-identical to the expected literal', () => {
      expect(POST_AFTER_DELETE_FAILED_RETRY_EXHAUSTED).toBe('post_after_delete_failed_retry_exhausted');
    });

    it('ORPHAN_SUCCEEDED_SUFFIX is byte-identical to the expected literal', () => {
      expect(ORPHAN_SUCCEEDED_SUFFIX).toBe('_after_delete_succeeded');
    });

    it('PENDING_AFTER_DELETE is byte-identical to the expected literal', () => {
      expect(PENDING_AFTER_DELETE).toBe('pending_after_delete_succeeded');
    });
  });

  // ── factory functions ──────────────────────────────────────────────────────

  describe('deleteFailedMarker', () => {
    it('concatenates DELETE_FAILED_PREFIX + kind exactly', () => {
      expect(deleteFailedMarker('http_400')).toBe('delete_failed_http_400');
    });
  });

  describe('postAfterDeleteFailedMarker', () => {
    it('concatenates POST_AFTER_DELETE_FAILED_PREFIX + kind exactly', () => {
      expect(postAfterDeleteFailedMarker('http_400')).toBe('post_after_delete_failed_http_400');
    });
  });

  // ── isRecoverableFailedPostingError ───────────────────────────────────────

  describe('isRecoverableFailedPostingError', () => {
    it('returns true for delete_failed_http_400 (DELETE_FAILED_PREFIX)', () => {
      expect(isRecoverableFailedPostingError('delete_failed_http_400')).toBe(true);
    });

    it('returns true for post_after_delete_failed_http_400 (POST_AFTER_DELETE_FAILED_PREFIX)', () => {
      expect(isRecoverableFailedPostingError('post_after_delete_failed_http_400')).toBe(true);
    });

    it('returns true for POST_AFTER_DELETE_FAILED_RETRY_EXHAUSTED (shares prefix, intentionally recoverable)', () => {
      expect(isRecoverableFailedPostingError('post_after_delete_failed_retry_exhausted')).toBe(true);
    });

    it('returns false for stale_after_review_changed', () => {
      expect(isRecoverableFailedPostingError('stale_after_review_changed')).toBe(false);
    });

    it('returns false for zernio_permanent_4xx (no matching prefix)', () => {
      expect(isRecoverableFailedPostingError('zernio_permanent_4xx')).toBe(false);
    });

    it('returns false for null', () => {
      expect(isRecoverableFailedPostingError(null)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(isRecoverableFailedPostingError(undefined)).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(isRecoverableFailedPostingError('')).toBe(false);
    });
  });

  // ── isOrphanMarker ─────────────────────────────────────────────────────────

  describe('isOrphanMarker', () => {
    it('returns true for pending_after_delete_succeeded', () => {
      expect(isOrphanMarker('pending_after_delete_succeeded')).toBe(true);
    });

    it('returns true for zernio_auth_error_after_delete_succeeded', () => {
      expect(isOrphanMarker('zernio_auth_error_after_delete_succeeded')).toBe(true);
    });

    it('returns true for any x_after_delete_succeeded value', () => {
      expect(isOrphanMarker('some_custom_marker_after_delete_succeeded')).toBe(true);
    });

    it('returns false for delete_failed_http_400 (does not end with orphan suffix)', () => {
      expect(isOrphanMarker('delete_failed_http_400')).toBe(false);
    });

    it('returns false for null', () => {
      expect(isOrphanMarker(null)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(isOrphanMarker(undefined)).toBe(false);
    });
  });
});
