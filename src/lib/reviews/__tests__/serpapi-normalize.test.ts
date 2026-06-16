import { describe, it, expect } from 'vitest';
import { normalizeSerpApiReview } from '../serpapi-normalize';

describe('normalizeSerpApiReview — sanitization (F-10)', () => {
  const base = { rating: 5, iso_date: '2026-06-01T00:00:00Z' };

  it('strips bidi/zero-width/control chars from reviewer name', () => {
    const r = normalizeSerpApiReview({ ...base, user: { name: 'Jane‮Doe​' }, snippet: 'ok' });
    expect(r.reviewerName).toBe('JaneDoe');
  });
  it('strips dangerous chars from review text but preserves line breaks', () => {
    const r = normalizeSerpApiReview({ ...base, snippet: 'Great‮ stay.\n\nWould​ return.' });
    expect(r.reviewText).toBe('Great stay.\n\nWould return.');
  });
  it('normalizes a text of only formatting chars to null', () => {
    const r = normalizeSerpApiReview({ ...base, snippet: '​‮﻿' });
    expect(r.reviewText).toBeNull();
  });
  it('leaves a clean review unchanged', () => {
    const r = normalizeSerpApiReview({ ...base, user: { name: 'María' }, snippet: 'Lovely!' });
    expect(r.reviewerName).toBe('María');
    expect(r.reviewText).toBe('Lovely!');
  });
});
