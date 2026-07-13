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
          approval_method: null,
          escalation_id: null,
          escalation_status: null,
          escalation_severity: null,
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
        approvalMethod: null,
        autoPostScheduledAt: null,
        escalation: null,
      },
    ]);
  });

  it('maps an open escalation row to the escalation object', () => {
    expect(
      mapRecentReviews([
        {
          id: 'review-1',
          reviewer_name: 'Pat',
          star_rating: 1,
          review_text: 'Terrible visit',
          review_date: '2026-05-20T12:34:56.000Z',
          status: 'pending_approval',
          response_text: 'Draft response',
          response_status: 'pending_approval',
          approval_method: null,
          escalation_id: 'esc-1',
          escalation_status: 'escalated',
          escalation_severity: 'high',
        },
      ]),
    ).toEqual([
      {
        id: 'review-1',
        reviewerName: 'Pat',
        starRating: 1,
        reviewText: 'Terrible visit',
        reviewDate: '2026-05-20T12:34:56.000Z',
        status: 'pending_approval',
        responseText: 'Draft response',
        responseStatus: 'pending_approval',
        approvalMethod: null,
        autoPostScheduledAt: null,
        escalation: { id: 'esc-1', status: 'escalated', severity: 'high' },
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
          approval_method: 'auto_policy',
          auto_post_scheduled_at: '2026-05-20T13:34:56.000Z',
          escalation_id: null,
          escalation_status: null,
          escalation_severity: null,
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
        approvalMethod: 'auto_policy',
        autoPostScheduledAt: '2026-05-20T13:34:56.000Z',
        escalation: null,
      },
    ]);
  });

  it('passes a Date auto-post deadline through without deriving or normalizing it', () => {
    const deadline = new Date('2026-05-20T13:34:56.000Z');

    const [mapped] = mapRecentReviews([
      {
        id: 'review-date-deadline',
        reviewer_name: 'Sam',
        star_rating: 5,
        review_text: null,
        review_date: '2026-05-20T12:00:00.000Z',
        status: 'responded',
        response_text: 'Thank you!',
        response_status: 'approved',
        approval_method: 'auto_policy',
        auto_post_scheduled_at: deadline,
        escalation_id: null,
      },
    ]);

    expect(mapped?.autoPostScheduledAt).toBe(deadline);
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
