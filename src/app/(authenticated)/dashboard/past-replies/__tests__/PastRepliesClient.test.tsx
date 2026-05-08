// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PastRepliesClient } from '../PastRepliesClient';

function row(overrides: Partial<Parameters<typeof PastRepliesClient>[0]['gapRows'][number]> = {}) {
  return {
    review_id: overrides.review_id ?? 'review-1',
    review_text: overrides.review_text ?? 'A thoughtful review',
    review_date: overrides.review_date ?? '2026-05-01T10:00:00Z',
    reviewer_name: overrides.reviewer_name ?? 'Alex',
    star_rating: overrides.star_rating ?? 5,
    response_id: overrides.response_id ?? 'response-1',
    approved_text: overrides.approved_text ?? 'A thoughtful reply',
    posted_at: overrides.posted_at ?? '2026-05-02T10:00:00Z',
    external_reply_ingested_at: overrides.external_reply_ingested_at ?? null,
  };
}

describe('PastRepliesClient', () => {
  it('uses the current page denominator when an active-period filter is active', async () => {
    const user = userEvent.setup();

    render(
      <PastRepliesClient
        gapRows={[
          row({ review_id: 'gap-1', response_id: 'response-1', star_rating: 5 }),
          row({ review_id: 'gap-2', response_id: 'response-2', star_rating: 5 }),
          row({ review_id: 'gap-3', response_id: 'response-3', star_rating: 1 }),
        ]}
        histRows={[]}
        gapTotal={47}
        histTotal={0}
        avgStarRating={4.4}
        isPremium
        hasHistoricalSection={false}
        page={1}
        totalPages={5}
      />,
    );

    expect(screen.getByText('3 of 47')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /5/ }));

    expect(screen.getByText('2 of 3')).toBeInTheDocument();
    expect(screen.queryByText('2 of 47')).not.toBeInTheDocument();
  });
});
