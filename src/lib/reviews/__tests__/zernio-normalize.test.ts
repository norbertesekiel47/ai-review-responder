import { describe, it, expect } from 'vitest';
import {
  zernioReviewToNormalized,
  buildZernioMonitoredReview,
  extractLocationFromReviewName,
  ZernioReviewNormalizationError,
} from '../zernio-normalize';
import type { ZernioReview } from '@/lib/zernio/types';

const baseReview: ZernioReview = {
  id: 'rev_abc',
  name: 'accounts/A/locations/L/reviews/rev_abc',
  rating: 4,
  starRating: 'FOUR',
  comment: 'Great place',
  createTime: '2026-04-15T10:00:00Z',
  updateTime: '2026-04-15T10:00:00Z',
  reviewer: { displayName: 'Alice', profilePhotoUrl: '', isAnonymous: false },
  reviewReply: null,
};

describe('zernioReviewToNormalized', () => {
  it('builds a NormalizedReview from a happy-path Zernio review', () => {
    const out = zernioReviewToNormalized(baseReview);
    expect(out.reviewerName).toBe('Alice');
    expect(out.starRating).toBe(4);
    expect(out.reviewText).toBe('Great place');
    expect(out.reviewDate).toBe('2026-04-15T10:00:00Z');
  });

  it('falls back to "Anonymous" when displayName is empty/whitespace', () => {
    const out = zernioReviewToNormalized({
      ...baseReview,
      reviewer: { displayName: '   ', profilePhotoUrl: '', isAnonymous: true },
    });
    expect(out.reviewerName).toBe('Anonymous');
  });

  it('returns reviewText=null when comment is empty/whitespace', () => {
    const out = zernioReviewToNormalized({ ...baseReview, comment: '   ' });
    expect(out.reviewText).toBeNull();
  });

  it('throws on missing review.id', () => {
    expect(() => zernioReviewToNormalized({ ...baseReview, id: '' as string }))
      .toThrow(ZernioReviewNormalizationError);
  });

  it('throws on out-of-range rating', () => {
    expect(() => zernioReviewToNormalized({ ...baseReview, rating: 0 as number }))
      .toThrow(ZernioReviewNormalizationError);
    expect(() => zernioReviewToNormalized({ ...baseReview, rating: 6 as number }))
      .toThrow(ZernioReviewNormalizationError);
  });

  it('throws on unparseable createTime', () => {
    expect(() => zernioReviewToNormalized({ ...baseReview, createTime: 'not-a-date' }))
      .toThrow(ZernioReviewNormalizationError);
  });
});

describe('buildZernioMonitoredReview', () => {
  it('constructs identity with location-scoped resource names', () => {
    const out = buildZernioMonitoredReview(baseReview, 'acct-X', 'loc-Y');
    expect(out.identity.provider).toBe('zernio');
    expect(out.identity.providerReviewId).toBe('rev_abc');
    expect(out.identity.providerReviewName).toBe('zernio://acct-X/locations/loc-Y/reviews/rev_abc');
    expect(out.identity.providerLocationName).toBe('zernio://acct-X/locations/loc-Y');
    expect(out.identity.identityStrategy).toBe('zernio_id');
    expect(out.contentHash).toEqual(expect.any(String));
    expect(out.contentHash).toHaveLength(64);  // SHA-256 hex
  });

  it('produces deterministic contentHash for same review', () => {
    const a = buildZernioMonitoredReview(baseReview, 'A', 'L');
    const b = buildZernioMonitoredReview(baseReview, 'A', 'L');
    expect(a.contentHash).toBe(b.contentHash);
  });

  it('produces different contentHash when star rating changes', () => {
    const a = buildZernioMonitoredReview(baseReview, 'A', 'L');
    const b = buildZernioMonitoredReview({ ...baseReview, rating: 5, starRating: 'FIVE' }, 'A', 'L');
    expect(a.contentHash).not.toBe(b.contentHash);
  });
});

describe('extractLocationFromReviewName', () => {
  it('extracts location from a canonical review.name', () => {
    expect(extractLocationFromReviewName('accounts/A/locations/L/reviews/R')).toBe('L');
  });

  it('returns null on malformed name', () => {
    expect(extractLocationFromReviewName('accounts/A/locations/L')).toBeNull();
    expect(extractLocationFromReviewName('foo/bar/baz')).toBeNull();
    expect(extractLocationFromReviewName('')).toBeNull();
  });
});
