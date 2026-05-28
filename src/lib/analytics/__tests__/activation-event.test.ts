import { describe, expect, it } from 'vitest';
import { buildActivationCompletedEvent } from '../activation-event';

const BASE = {
  accountId: 'acct_1',
  accountCreatedAt: new Date('2026-05-01T00:00:00.000Z'),
  responseId: 'resp_1',
  businessId: 'biz_1',
  reviewId: 'rev_1',
  postedAt: new Date('2026-05-03T12:00:00.000Z'),
};

describe('buildActivationCompletedEvent', () => {
  it('builds the event for an activation within the 7-day window', () => {
    expect(buildActivationCompletedEvent(BASE)).toEqual({
      event: 'activation_completed',
      distinctId: 'acct_1',
      uuid: 'resp_1',
      properties: {
        account_id: 'acct_1',
        business_id: 'biz_1',
        response_id: 'resp_1',
        review_id: 'rev_1',
        days_to_activation: 2.5,
      },
    });
  });

  it('treats exactly 7.0 days as eligible (inclusive upper bound)', () => {
    const event = buildActivationCompletedEvent({
      ...BASE,
      postedAt: new Date('2026-05-08T00:00:00.000Z'),
    });
    expect(event?.properties?.days_to_activation).toBe(7);
  });

  it('returns null just past 7 days', () => {
    expect(
      buildActivationCompletedEvent({
        ...BASE,
        postedAt: new Date('2026-05-08T00:00:01.000Z'),
      }),
    ).toBeNull();
  });

  it('returns null when posted_at precedes account creation', () => {
    expect(
      buildActivationCompletedEvent({
        ...BASE,
        postedAt: new Date('2026-04-30T23:59:59.000Z'),
      }),
    ).toBeNull();
  });

  it('returns null for unparseable dates (non-finite)', () => {
    expect(buildActivationCompletedEvent({ ...BASE, postedAt: 'not-a-date' })).toBeNull();
  });

  it('returns null when accountCreatedAt is unparseable', () => {
    expect(
      buildActivationCompletedEvent({ ...BASE, accountCreatedAt: 'not-a-date' }),
    ).toBeNull();
  });

  it('rounds days_to_activation to 4 decimal places', () => {
    // created +2d12h43s => 216043s / 86400 = 2.50049768... => 2.5005
    const event = buildActivationCompletedEvent({
      ...BASE,
      postedAt: new Date('2026-05-03T12:00:43.000Z'),
    });
    expect(event?.properties?.days_to_activation).toBe(2.5005);
  });

  it('accepts ISO-string timestamps as well as Date objects', () => {
    const event = buildActivationCompletedEvent({
      ...BASE,
      accountCreatedAt: '2026-05-01T00:00:00.000Z',
      postedAt: '2026-05-03T12:00:00.000Z',
    });
    expect(event?.properties?.days_to_activation).toBe(2.5);
  });
});
