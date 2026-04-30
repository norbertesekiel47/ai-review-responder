import { describe, it, expect } from 'vitest';
import {
  MATCH_WINDOW_MS,
  fromZernioReview,
  matchesLocalRow,
} from '../zernio-field-match';
import type { ZernioReview } from '@/lib/zernio/types';

// ── Fixtures ─────────────────────────────────────────────────────────

function makeZernioReview(overrides: Partial<ZernioReview> = {}): ZernioReview {
  return {
    id: 'zr-1',
    name: 'accounts/acct/locations/loc/reviews/zr-1',
    reviewer: { displayName: 'Jane Doe', profilePhotoUrl: null, isAnonymous: false },
    rating: 5,
    starRating: 'FIVE',
    comment: 'Great service',
    createTime: '2026-04-26T12:00:00Z',
    updateTime: '2026-04-26T12:00:00Z',
    reviewReply: null,
    ...overrides,
  };
}

function makeLocalRow(overrides: Partial<{
  reviewer_name: string;
  star_rating: number;
  review_text: string | null;
  review_date: Date | string;
}> = {}) {
  return {
    reviewer_name: 'Jane Doe',
    star_rating: 5,
    review_text: 'Great service',
    review_date: '2026-04-26T12:00:00Z',
    ...overrides,
  };
}

// ── fromZernioReview ──────────────────────────────────────────────────

describe('fromZernioReview', () => {
  it('reduces a Zernio review to the canonical target shape', () => {
    const z = makeZernioReview();
    const target = fromZernioReview(z);
    expect(target).toEqual({
      reviewer_name: 'Jane Doe',
      star_rating: 5,
      review_text_trimmed: 'Great service',
      created_at_ms: new Date('2026-04-26T12:00:00Z').getTime(),
    });
  });

  it('falls back to "Anonymous" when displayName is empty string', () => {
    const z = makeZernioReview({ reviewer: { displayName: '', profilePhotoUrl: null, isAnonymous: true } });
    expect(fromZernioReview(z).reviewer_name).toBe('Anonymous');
  });

  it('trims whitespace from comment', () => {
    const z = makeZernioReview({ comment: '  Great service  ' });
    expect(fromZernioReview(z).review_text_trimmed).toBe('Great service');
  });

  it('handles null comment → empty string', () => {
    const z = makeZernioReview({ comment: null });
    expect(fromZernioReview(z).review_text_trimmed).toBe('');
  });
});

// ── matchesLocalRow corpus ────────────────────────────────────────────

describe('matchesLocalRow', () => {
  it('exact match — all fields align', () => {
    const target = fromZernioReview(makeZernioReview());
    const local = makeLocalRow();
    expect(matchesLocalRow(target, local)).toBe(true);
  });

  it('reviewer-name mismatch → no match', () => {
    const target = fromZernioReview(makeZernioReview());
    const local = makeLocalRow({ reviewer_name: 'John Smith' });
    expect(matchesLocalRow(target, local)).toBe(false);
  });

  it('rating mismatch → no match', () => {
    const target = fromZernioReview(makeZernioReview({ rating: 5 }));
    const local = makeLocalRow({ star_rating: 4 });
    expect(matchesLocalRow(target, local)).toBe(false);
  });

  it('text mismatch → no match', () => {
    const target = fromZernioReview(makeZernioReview({ comment: 'Great service' }));
    const local = makeLocalRow({ review_text: 'Terrible service' });
    expect(matchesLocalRow(target, local)).toBe(false);
  });

  it('date within 24h window → match', () => {
    const baseMs = new Date('2026-04-26T12:00:00Z').getTime();
    const withinWindow = new Date(baseMs + MATCH_WINDOW_MS - 1).toISOString();
    const target = fromZernioReview(makeZernioReview({ createTime: '2026-04-26T12:00:00Z' }));
    const local = makeLocalRow({ review_date: withinWindow });
    expect(matchesLocalRow(target, local)).toBe(true);
  });

  it('date just past 24h window → no match', () => {
    const baseMs = new Date('2026-04-26T12:00:00Z').getTime();
    const outsideWindow = new Date(baseMs + MATCH_WINDOW_MS).toISOString();
    const target = fromZernioReview(makeZernioReview({ createTime: '2026-04-26T12:00:00Z' }));
    const local = makeLocalRow({ review_date: outsideWindow });
    expect(matchesLocalRow(target, local)).toBe(false);
  });

  it('null review_text treated as empty string — matches empty comment', () => {
    const target = fromZernioReview(makeZernioReview({ comment: null }));
    const local = makeLocalRow({ review_text: null });
    expect(matchesLocalRow(target, local)).toBe(true);
  });

  it('local review_text with leading/trailing spaces still matches', () => {
    const target = fromZernioReview(makeZernioReview({ comment: 'Great service' }));
    const local = makeLocalRow({ review_text: '  Great service  ' });
    expect(matchesLocalRow(target, local)).toBe(true);
  });
});
