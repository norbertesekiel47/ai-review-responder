// @vitest-environment jsdom
import { it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BillingClient } from '../BillingClient';

const accountData = {
  accountId: 'acc1',
  displayName: 'Acme',
  subscription: { tier: 'copilot', tierLabel: 'Copilot', status: 'active', statusLabel: 'Active', stripeCustomerId: 'cus_1', activatedAt: null, trialEndsAt: null },
  quota: { activeLocations: 1, included: 3, paid: 3, overage: 0 },
  billing: { basePriceCents: 9900, overagePriceCents: 0, overageUnits: 0, totalCents: 9900 },
  timeZone: 'UTC',
};
vi.mock('@/hooks/useAccountData', () => ({
  useAccountData: () => ({ data: accountData, loading: false, error: null, refetch: vi.fn() }),
}));
vi.mock('@/components/dashboard/settings/CancelSubscriptionPanel', () => ({
  CancelSubscriptionPanel: () => <div data-testid="cancel-sub" />,
}));

it('renders the plan + quota + cancel panel', () => {
  render(<BillingClient />);
  expect(screen.getByText(/subscription & billing/i)).toBeInTheDocument();
  expect(screen.getByText(/locations quota/i)).toBeInTheDocument();
  expect(screen.getByTestId('cancel-sub')).toBeInTheDocument();
});
