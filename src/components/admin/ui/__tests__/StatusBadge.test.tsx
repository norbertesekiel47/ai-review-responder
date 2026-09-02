// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import { SubscriptionTier } from '@/lib/accounts/tier-config';
import { OUTBOX_IN_FLIGHT_STATUSES } from '@/lib/shared/job-outbox-status';
import { SUPPRESSION_SCOPES, SUPPRESSION_SOURCES } from '@/lib/solicitation/suppression';
import {
  StatusBadge,
  STATUS_BADGE_VOCABULARIES,
  statusLabel,
  type StatusVocabulary,
} from '../StatusBadge';

// One badge per vocabulary (X8/X9). These tests pin the CONTRACT of the
// primitive — every registered member has a label and a colour, labels are
// humanized (never the raw token), and an unknown value is visibly marked —
// rather than any page's markup.

const RAW_TOKEN = /^[a-z]+(_[a-z]+)+$/;

describe('StatusBadge vocabularies', () => {
  const vocabularies = Object.keys(STATUS_BADGE_VOCABULARIES) as StatusVocabulary[];

  it.each(vocabularies)('%s has a label and a style for every member, and no raw-token label', (vocab) => {
    const { labels, styles } = STATUS_BADGE_VOCABULARIES[vocab] as {
      labels: Record<string, string>;
      styles: Record<string, string>;
    };
    expect(Object.keys(labels).sort()).toEqual(Object.keys(styles).sort());
    for (const [value, label] of Object.entries(labels)) {
      expect(label, `${vocab}.${value} has an empty label`).not.toBe('');
      expect(label, `${vocab}.${value} leaks the raw token`).not.toMatch(RAW_TOKEN);
      expect(styles[value], `${vocab}.${value} has no style`).toMatch(/\bbg-/);
    }
  });

  it('covers every subscription status from the const enum', () => {
    for (const status of Object.values(SubscriptionStatus)) {
      expect(STATUS_BADGE_VOCABULARIES.subscription.labels[status]).toBeDefined();
    }
  });

  it('covers every tier from the const enum', () => {
    for (const tier of Object.values(SubscriptionTier)) {
      expect(STATUS_BADGE_VOCABULARIES.tier.labels[tier]).toBeDefined();
    }
  });

  it('covers every outbox status (in-flight set + terminal pair)', () => {
    for (const status of [...OUTBOX_IN_FLIGHT_STATUSES, 'completed', 'failed'] as const) {
      expect(STATUS_BADGE_VOCABULARIES.outbox.labels[status]).toBeDefined();
    }
  });

  it('covers every suppression scope and source from their single owner', () => {
    for (const scope of SUPPRESSION_SCOPES) {
      expect(STATUS_BADGE_VOCABULARIES.suppressionScope.labels[scope]).toBeDefined();
    }
    for (const source of SUPPRESSION_SOURCES) {
      expect(STATUS_BADGE_VOCABULARIES.suppressionSource.labels[source]).toBeDefined();
    }
  });
});

describe('StatusBadge', () => {
  it('renders the humanized label, never the raw token', () => {
    render(<StatusBadge vocab="subscription" value={SubscriptionStatus.PAST_DUE} />);
    const badge = screen.getByText('Past due');
    expect(badge.className).toContain('bg-red-100');
    expect(badge).toHaveAttribute('data-vocab', 'subscription');
    expect(badge).not.toHaveAttribute('data-unmapped');
    expect(screen.queryByText('past_due')).not.toBeInTheDocument();
  });

  it('renders the same value differently under different vocabularies', () => {
    // `failed` is red for the outbox and red for a delivery — but `pending`
    // is yellow for a delivery and yellow for the outbox, while `completed`
    // exists only in the outbox vocabulary. The vocabulary, not the string,
    // decides.
    const { unmount } = render(<StatusBadge vocab="outbox" value="completed" />);
    expect(screen.getByText('Completed').className).toContain('bg-green-100');
    unmount();
    render(<StatusBadge vocab="delivery" value="completed" />);
    // Not a delivery status: neutral + marked.
    const unmapped = screen.getByText('Completed');
    expect(unmapped.className).toContain('bg-gray-100');
    expect(unmapped).toHaveAttribute('data-unmapped');
  });

  it('marks and humanizes an unknown value instead of crashing or passing it off as styled', () => {
    render(<StatusBadge vocab="subscription" value="some_future_status" />);
    const badge = screen.getByText('Some future status');
    expect(badge.className).toContain('bg-gray-100');
    expect(badge).toHaveAttribute('data-unmapped', '');
  });

  it('pulses only the running demo state', () => {
    render(<StatusBadge vocab="demo" value="running" />);
    expect(screen.getByText('Running').className).toContain('animate-pulse');
  });

  it('statusLabel echoes the badge label for selects and chips', () => {
    expect(statusLabel('subscription', SubscriptionStatus.PENDING_PAYMENT)).toBe('Pending payment');
    expect(statusLabel('marginRisk', 'none')).toBe('OK');
    expect(statusLabel('subscription', 'brand_new')).toBe('Brand new');
  });
});
