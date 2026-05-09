// @vitest-environment jsdom
// src/components/dashboard/__tests__/SubscriptionStatusBanner.test.tsx
//
// Tests for the CancelledBanner and PastDueBanner components.
// VAL-CROSS-011: Cancelled account read-only banner with grace period date.
// VAL-CROSS-012: Past-due account payment warning banner with billing portal link.

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CancelledBanner, PastDueBanner } from '../SubscriptionStatusBanner';

// Mock the Icon component
vi.mock('../Icon', () => ({
  Icon: ({ name }: { name: string }) => <span data-testid="icon">{name}</span>,
}));

describe('CancelledBanner (VAL-CROSS-011)', () => {
  it('renders read-only banner with grace period date', () => {
    render(
      <CancelledBanner
        businessName="Test Cafe"
        gracePeriodEndDate="2026-06-08T00:00:00Z"
        readAccess={true}
      />,
    );

    expect(screen.getByText('Your subscription has been cancelled')).toBeDefined();
    expect(screen.getByText(/Read-only access until/)).toBeDefined();
    expect(screen.getByText(/write actions.*disabled/)).toBeDefined();
  });

  it('renders grace-expired banner when readAccess is false', () => {
    render(
      <CancelledBanner
        businessName="Test Cafe"
        gracePeriodEndDate="2026-04-01T00:00:00Z"
        readAccess={false}
      />,
    );

    expect(screen.getByText(/grace period has ended/)).toBeDefined();
    expect(screen.getByText(/no longer accessible/)).toBeDefined();
  });

  it('handles null grace period date gracefully', () => {
    render(
      <CancelledBanner
        businessName="Test Cafe"
        gracePeriodEndDate={null}
        readAccess={true}
      />,
    );

    expect(screen.getByText(/Read-only access until/)).toBeDefined();
    expect(screen.getByText(/soon/)).toBeDefined();
  });
});

describe('PastDueBanner (VAL-CROSS-012)', () => {
  it('renders payment warning with billing portal link', () => {
    render(
      <PastDueBanner
        businessName="Test Cafe"
        billingPortalUrl="/api/billing/portal"
      />,
    );

    expect(screen.getByText('Payment overdue — please update your payment method')).toBeDefined();
    const link = screen.getByText('Update payment method →');
    expect(link).toBeDefined();
    expect(link.getAttribute('href')).toBe('/api/billing/portal');
  });

  it('renders support message when no billing portal URL', () => {
    render(
      <PastDueBanner
        businessName="Test Cafe"
        billingPortalUrl={null}
      />,
    );

    expect(screen.getByText('Payment overdue — please update your payment method')).toBeDefined();
    expect(screen.getByText(/Contact support to update your payment method/)).toBeDefined();
  });

  it('mentions 7-day grace period in the body', () => {
    render(
      <PastDueBanner
        businessName="Test Cafe"
        billingPortalUrl="/api/billing/portal"
      />,
    );

    expect(screen.getByText(/7-day grace period/)).toBeDefined();
  });
});
