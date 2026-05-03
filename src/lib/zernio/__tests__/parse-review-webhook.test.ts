import { describe, it, expect } from 'vitest';
import {
  parseZernioReviewWebhook,
  ZernioReviewWebhookParseError,
} from '../parse-review-webhook';

const buildBody = (overrides: Record<string, unknown> = {}) => ({
  event: 'review.new',
  id: 'evt_abc',
  account: { id: 'zernio-acct-A' },
  review: { id: 'AbFv0LXyz123' },
  ...overrides,
});

describe('parseZernioReviewWebhook', () => {
  it('extracts nested account.id', () => {
    const r = parseZernioReviewWebhook(buildBody());
    expect(r.accountId).toBe('zernio-acct-A');
  });

  it('extracts bare review.id', () => {
    const r = parseZernioReviewWebhook(buildBody());
    expect(r.reviewId).toBe('AbFv0LXyz123');
    expect(r.locationIdFromPayload).toBeNull();
    expect(r.fullReviewName).toBeNull();
  });

  it('extracts bare review id from resource-name review.id', () => {
    const r = parseZernioReviewWebhook(buildBody({
      review: { id: 'accounts/108472/locations/9876/reviews/AbFv0LXyz123' },
    }));
    expect(r.reviewId).toBe('AbFv0LXyz123');
    expect(r.locationIdFromPayload).toBe('9876');
    expect(r.fullReviewName).toBe('accounts/108472/locations/9876/reviews/AbFv0LXyz123');
  });

  it('extracts bare review id from resource-name review.name when review.id absent', () => {
    const r = parseZernioReviewWebhook(buildBody({
      review: { name: 'accounts/108472/locations/9876/reviews/AbFv0LXyz123' },
    }));
    expect(r.reviewId).toBe('AbFv0LXyz123');
    expect(r.locationIdFromPayload).toBe('9876');
  });

  it('accepts agreement between review.id and review.name', () => {
    const r = parseZernioReviewWebhook(buildBody({
      review: {
        id: 'AbFv0LXyz123',
        name: 'accounts/108472/locations/9876/reviews/AbFv0LXyz123',
      },
    }));
    expect(r.reviewId).toBe('AbFv0LXyz123');
    expect(r.locationIdFromPayload).toBe('9876');
  });

  it('throws on disagreement between review.id and review.name bare ids', () => {
    expect(() => parseZernioReviewWebhook(buildBody({
      review: {
        id: 'AbFv0LXyz123',
        name: 'accounts/108472/locations/9876/reviews/Different',
      },
    }))).toThrow(ZernioReviewWebhookParseError);
  });

  it('throws on disagreement between location segments', () => {
    expect(() => parseZernioReviewWebhook(buildBody({
      review: {
        id: 'accounts/X/locations/A/reviews/AbFv0LXyz123',
        name: 'accounts/X/locations/B/reviews/AbFv0LXyz123',
      },
    }))).toThrow(ZernioReviewWebhookParseError);
  });

  it('throws when account is missing', () => {
    expect(() => parseZernioReviewWebhook({ review: { id: 'r' } }))
      .toThrow(ZernioReviewWebhookParseError);
  });

  it('throws when account.id is empty string', () => {
    expect(() => parseZernioReviewWebhook({ account: { id: '' }, review: { id: 'r' } }))
      .toThrow(ZernioReviewWebhookParseError);
  });

  it('throws when review is missing', () => {
    expect(() => parseZernioReviewWebhook({ account: { id: 'A' } }))
      .toThrow(ZernioReviewWebhookParseError);
  });

  it('throws when slash-containing review.id has malformed shape', () => {
    expect(() => parseZernioReviewWebhook(buildBody({
      review: { id: 'foo/bar/baz' },
    }))).toThrow(ZernioReviewWebhookParseError);
  });

  it('does NOT cross-check top-level account.id against accounts/{...} resource-path segment (different ID spaces)', () => {
    // Round-4 regression: top-level account.id='zernio-acct-A' is Zernio's
    // account ID. The accounts/{...} segment in review.name is Google's
    // account ID — different ID space. Parser must NOT reject on mismatch.
    const r = parseZernioReviewWebhook(buildBody({
      account: { id: 'zernio-acct-A' },
      review: { name: 'accounts/google-acct-B/locations/9876/reviews/AbFv0LXyz123' },
    }));
    expect(r.accountId).toBe('zernio-acct-A');
    expect(r.reviewId).toBe('AbFv0LXyz123');
    expect(r.locationIdFromPayload).toBe('9876');
  });

  it('throws on null/undefined body', () => {
    expect(() => parseZernioReviewWebhook(null)).toThrow(ZernioReviewWebhookParseError);
    expect(() => parseZernioReviewWebhook(undefined)).toThrow(ZernioReviewWebhookParseError);
  });
});
