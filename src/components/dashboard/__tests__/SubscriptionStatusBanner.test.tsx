// @vitest-environment jsdom
// src/components/dashboard/__tests__/SubscriptionStatusBanner.test.tsx
//
// Tests for the CancelledBanner and PastDueBanner components.
// VAL-CROSS-011: Cancelled account read-only banner with grace period date.
// VAL-CROSS-012: Past-due account payment warning banner with billing portal POST.

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CancelledBanner, openBillingPortal, PastDueBanner } from '../SubscriptionStatusBanner';

vi.mock('../Icon', () => ({
  Icon: ({ name }: { name: string }) => <span data-testid="icon">{name}</span>,
}));

describe('CancelledBanner (VAL-CROSS-011)', () => {
  it('renders read-only banner with grace period date', () => {
    render(
      <CancelledBanner
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
        gracePeriodEndDate={null}
        readAccess={true}
      />,
    );

    expect(screen.getByText(/Read-only access until/)).toBeDefined();
    expect(screen.getByText(/soon/)).toBeDefined();
  });
});

describe('PastDueBanner (VAL-CROSS-012)', () => {
  it('renders payment warning with billing portal button', () => {
    render(
      <PastDueBanner
        billingPortalUrl="/api/billing/portal"
      />,
    );

    expect(screen.getByText(/please update your payment method/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Update payment method' })).toBeDefined();
  });

  it('POSTs to the portal endpoint before navigating', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ url: 'https://billing.stripe.test/session' }),
    });
    const navigate = vi.fn();

    await openBillingPortal('/api/billing/portal', {
      fetchFn: fetchMock as unknown as typeof fetch,
      navigate,
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/billing/portal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(navigate).toHaveBeenCalledWith('https://billing.stripe.test/session');
  });

  it('clicking the banner button uses POST instead of a GET link', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ url: 'https://billing.stripe.test/session' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <PastDueBanner
        billingPortalUrl="/api/billing/portal"
        navigate={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Update payment method' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/billing/portal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
    });

    vi.unstubAllGlobals();
  });

  it('renders support message when no billing portal URL', () => {
    render(
      <PastDueBanner
        billingPortalUrl={null}
      />,
    );

    expect(screen.getByText(/please update your payment method/)).toBeDefined();
    expect(screen.getByText(/Contact support to update your payment method/)).toBeDefined();
  });

  it('mentions 7-day grace period in the body', () => {
    render(
      <PastDueBanner
        billingPortalUrl="/api/billing/portal"
      />,
    );

    expect(screen.getByText(/7-day grace period/)).toBeDefined();
  });
});
