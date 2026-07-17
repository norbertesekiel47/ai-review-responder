// @vitest-environment jsdom
import { it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { AccountSettingsData } from '@/hooks/useAccountData';
import { buildPlanPresentation } from '@/lib/payments/plan-presentation';
import { BillingClient } from '../BillingClient';

const accountData = {
  accountId: 'acc1',
  displayName: 'Acme',
  subscription: {
    tier: 'copilot',
    tierLabel: 'Copilot',
    priceVariant: 'list',
    status: 'active',
    statusLabel: 'Active',
    stripeCustomerId: 'cus_1',
    activatedAt: null,
    trialEndsAt: null,
  },
  quota: { activeLocations: 1, included: 1, paid: 0, overage: 0 },
  billing: {
    basePriceCents: 2900,
    overagePriceCents: 1500,
    overageUnits: 0,
    totalCents: 2900,
  },
  planPresentation: buildPlanPresentation({
    priceVariant: 'list',
    autopilotPurchasable: true,
    trialEnabled: false,
  }),
  timeZone: 'UTC',
} satisfies AccountSettingsData;
vi.mock('@/hooks/useAccountData', () => ({
  useAccountData: () => ({ data: accountData, loading: false, error: null, refetch: vi.fn() }),
}));
vi.mock('@/components/dashboard/settings/CancelSubscriptionPanel', () => ({
  CancelSubscriptionPanel: () => <div data-testid="cancel-sub" />,
}));

it('renders the plan + quota + cancel panel', () => {
  render(<BillingClient />);
  expect(screen.getByText(/subscription & billing/i)).toBeInTheDocument();
  expect(screen.getByText(/^location quota$/i)).toBeInTheDocument();
  expect(screen.getByTestId('cancel-sub')).toBeInTheDocument();
});
