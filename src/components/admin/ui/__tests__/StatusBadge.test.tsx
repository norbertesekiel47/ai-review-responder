// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import { OUTBOX_IN_FLIGHT_STATUSES } from '@/lib/shared/job-outbox-status';
import { StatusBadge, STATUS_BADGE_STYLES } from '../StatusBadge';

describe('StatusBadge', () => {
  it('has an explicit style for every subscription status (no fallthrough)', () => {
    for (const status of Object.values(SubscriptionStatus)) {
      expect(STATUS_BADGE_STYLES[status], `missing style for ${status}`).toBeDefined();
    }
  });

  it('has an explicit style for every outbox status (no fallthrough)', () => {
    for (const status of [...OUTBOX_IN_FLIGHT_STATUSES, 'completed', 'failed']) {
      expect(STATUS_BADGE_STYLES[status], `missing style for ${status}`).toBeDefined();
    }
  });

  it('renders the status text', () => {
    render(<StatusBadge status={SubscriptionStatus.PAST_DUE} />);
    expect(screen.getByText('past_due')).toBeInTheDocument();
  });

  it('renders unknown statuses with the neutral style instead of crashing', () => {
    render(<StatusBadge status="some_future_status" />);
    const badge = screen.getByText('some_future_status');
    expect(badge.className).toContain('bg-gray-100');
  });
});
