// @vitest-environment jsdom
//
// The screen every pending_payment owner now sees — admin-invited or
// self-serve, since `pending_payment_admin_handoff` and its dead-end screen are
// deleted. Its CTA must render whatever the SERVER decided (`resolveFunnelEntry`
// → `funnelUrl` on the dashboard payload), never a hardcoded /onboarding/pay:
// the browser cannot read ONBOARDING_DEMO_ENABLED (invariant #13), so a
// client-side guess would skip the pre-pay demo for the owners owed it.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PendingPaymentScreen } from '../PendingPaymentScreen';
import type { DashboardDataPendingPayment } from '@/lib/dashboard/types';

function payload(funnelUrl: string | null): DashboardDataPendingPayment {
  return {
    subscriptionStatus: 'pending_payment',
    businessId: 'biz-1',
    businessName: 'RepWorth Cafe',
    funnelUrl,
  };
}

describe('PendingPaymentScreen', () => {
  it('PendingPaymentScreen CTA links to the server-supplied funnelUrl', () => {
    for (const url of [
      '/onboarding/start',
      '/onboarding/demo',
      '/onboarding/pay',
    ]) {
      const { unmount } = render(<PendingPaymentScreen data={payload(url)} />);
      expect(screen.getByRole('link').getAttribute('href')).toBe(url);
      unmount();
    }
  });

  it('keeps the contact-support fallback when no funnelUrl is available', () => {
    render(<PendingPaymentScreen data={payload(null)} />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText(/contact support/i)).toBeTruthy();
  });
});
