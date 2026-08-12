import { describe, expect, it } from 'vitest';
import { mapRecentReviews, mapReviewVelocity, toIsoWeekStart } from '../active-mappers';

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

  // #791: postgres.js decodes a `date` column (OID 1082) with `new Date(x)`, so
  // production hands the mapper a JS Date, not the ISO string the fixtures above
  // use. `String(date)` produced "Mon May 18 2026 …", which sorts by month NAME.
  it('maps a postgres.js-decoded Date week_start to the ISO calendar day', () => {
    expect(mapReviewVelocity([{ week_start: new Date('2026-05-18'), count: 7 }])).toEqual([
      { weekStart: '2026-05-18', count: 7 },
    ]);
  });

  describe('toIsoWeekStart', () => {
    it('round-trips a Date at UTC midnight to the same calendar day', () => {
      expect(toIsoWeekStart(new Date('2026-06-22'))).toBe('2026-06-22');
    });

    it('is immune to the process timezone', () => {
      // The Date postgres.js builds is UTC midnight; reading LOCAL components
      // under a negative offset would report the previous day (here 2026-06-21).
      const original = process.env.TZ;
      try {
        process.env.TZ = 'America/Los_Angeles';
        expect(toIsoWeekStart(new Date('2026-06-22'))).toBe('2026-06-22');
      } finally {
        if (original === undefined) delete process.env.TZ;
        else process.env.TZ = original;
      }
    });

    it('passes an ISO date-only string through untouched', () => {
      expect(toIsoWeekStart('2026-06-22')).toBe('2026-06-22');
    });

    it('truncates a full ISO timestamp to its calendar day', () => {
      expect(toIsoWeekStart('2026-06-22T00:00:00.000Z')).toBe('2026-06-22');
    });

    it('yields ISO strings that sort chronologically across a month boundary', () => {
      const weeks = [
        new Date('2026-08-03'),
        new Date('2026-07-06'),
        new Date('2026-06-22'),
      ].map(toIsoWeekStart);

      expect([...weeks].sort()).toEqual(['2026-06-22', '2026-07-06', '2026-08-03']);
    });

    it('returns empty string for null, undefined, and unparseable values', () => {
      expect(toIsoWeekStart(null)).toBe('');
      expect(toIsoWeekStart(undefined)).toBe('');
      expect(toIsoWeekStart('not a date')).toBe('');
      expect(toIsoWeekStart(new Date('nope'))).toBe('');
    });
  });
});
