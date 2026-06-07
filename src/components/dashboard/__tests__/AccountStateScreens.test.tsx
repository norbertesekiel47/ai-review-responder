// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OffboardingStatusScreen } from '@/components/dashboard/account-state/AccountStateScreens';

describe('OffboardingStatusScreen', () => {
  it('renders delete-data status copy with server-owned account timezone deadlines', () => {
    render(
      <OffboardingStatusScreen
        accountTimeZone="America/New_York"
        activeOffboarding={{
          id: 'offboarding-row-id-should-not-render',
          accountId: 'account-id-should-not-render',
          mode: 'delete_data',
          status: 'purge_scheduled',
          failedStep: null,
          accessEndsAt: null,
          teardownStartedAt: '2026-07-01T16:00:00.000Z',
          purgeAfter: '2026-07-10T17:30:00.000Z',
          operationalUIBlocked: true,
        }}
      />,
    );

    expect(screen.getByText('Account deletion is scheduled')).toBeInTheDocument();
    expect(screen.getByText(/data is deleted or anonymized after the waiting period/i)).toBeInTheDocument();
    expect(screen.getByText(/limited billing, security, and compliance records may be retained/i)).toBeInTheDocument();
    expect(screen.getByText(/Deletion window ends Jul 10, 2026, 1:30 PM EDT/i)).toBeInTheDocument();
    expect(screen.queryByText(/offboarding-row-id-should-not-render/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/account-id-should-not-render/i)).not.toBeInTheDocument();
  });

  it('does not render raw failed-step values', () => {
    render(
      <OffboardingStatusScreen
        accountTimeZone="UTC"
        activeOffboarding={{
          mode: 'delete_data',
          status: 'failed',
          failedStep: 'billing',
          accessEndsAt: null,
          teardownStartedAt: null,
          purgeAfter: null,
          operationalUIBlocked: true,
        }}
      />,
    );

    expect(screen.getByText('Offboarding needs support review')).toBeInTheDocument();
    expect(screen.getByText('Paused for support review')).toBeInTheDocument();
    expect(screen.queryByText('Paused for billing review')).not.toBeInTheDocument();
  });
});
