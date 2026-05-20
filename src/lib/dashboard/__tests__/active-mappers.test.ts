import { describe, expect, it } from 'vitest';
import { mapRecentReviews, mapReviewVelocity } from '../active-mappers';

describe('dashboard active mappers', () => {
  it('maps recent review row nulls and dates to dashboard shape', () => {
    const reviewDate = new Date('2026-05-20T12:34:56.000Z');

    expect(
      mapRecentReviews([
        {
          id: 'review-1',
          reviewer_name: null,
          star_rating: 5,
          review_text: null,
          review_date: reviewDate,
          status: 'pending_approval',
          response_text: null,
          response_status: null,
        },
      ]),
    ).toEqual([
      {
        id: 'review-1',
        reviewerName: 'Anonymous',
        starRating: 5,
        reviewText: null,
        reviewDate: reviewDate.toISOString(),
        status: 'pending_approval',
        responseText: null,
        responseStatus: null,
      },
    ]);
  });

  it('normalizes string review dates to dashboard shape', () => {
    const reviewDateString = '2026-05-20T12:34:56.000Z';

    expect(
      mapRecentReviews([
        {
          id: 'review-1',
          reviewer_name: null,
          star_rating: 5,
          review_text: 'Useful review',
          review_date: reviewDateString,
          status: 'pending_approval',
          response_text: 'Draft response',
          response_status: 'approved',
        },
      ]),
    ).toEqual([
      {
        id: 'review-1',
        reviewerName: 'Anonymous',
        starRating: 5,
        reviewText: 'Useful review',
        reviewDate: reviewDateString,
        status: 'pending_approval',
        responseText: 'Draft response',
        responseStatus: 'approved',
      },
    ]);
  });

  it('maps review velocity week_start and count', () => {
    expect(
      mapReviewVelocity([
        {
          week_start: '2026-05-18',
          count: 7,
        },
      ]),
    ).toEqual([
      {
        weekStart: '2026-05-18',
        count: 7,
      },
    ]);
  });
});
