// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SettingsClient } from '../SettingsClient';

const { mockUseSettingsForm, mockUseAccountData, mockAccountPanel } = vi.hoisted(() => ({
  mockUseSettingsForm: vi.fn(),
  mockUseAccountData: vi.fn(),
  mockAccountPanel: vi.fn((_props: unknown) => <div>Account panel</div>),
}));

vi.mock('@/hooks/useSettingsForm', () => ({
  useSettingsForm: mockUseSettingsForm,
}));

vi.mock('@/hooks/useAccountData', () => ({
  useAccountData: mockUseAccountData,
}));

vi.mock('@/components/dashboard/settings/SettingsShell', () => ({
  SettingsShell: ({ activeTab, children }: { activeTab: string; children: ReactNode }) => (
    <div data-testid="settings-shell" data-active-tab={activeTab}>
      {children}
    </div>
  ),
}));

vi.mock('@/components/dashboard/settings/AccountPanel', () => ({
  AccountPanel: mockAccountPanel,
}));

vi.mock('@/components/dashboard/settings/GeneralPanel', () => ({
  GeneralPanel: () => <div>General panel</div>,
}));

vi.mock('@/components/dashboard/settings/BrandVoicePanel', () => ({
  BrandVoicePanel: () => <div>Brand voice panel</div>,
}));

describe('SettingsClient', () => {
  beforeEach(() => {
    mockAccountPanel.mockClear();
    mockUseSettingsForm.mockReturnValue({
      fetchError: null,
      data: {},
      form: {},
      set: vi.fn(),
      dirty: false,
      dirtyCount: 0,
      saving: false,
      save: vi.fn(),
      discard: vi.fn(),
      savedFlash: false,
      saveError: null,
    });
    mockUseAccountData.mockReturnValue({
      data: null,
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
  });

  it('selects the account tab when locations settings render the account panel', () => {
    render(<SettingsClient locationsSettingsEnabled multiLocationEnabled={false} />);

    expect(screen.getByTestId('settings-shell')).toHaveAttribute('data-active-tab', 'account');
    expect(screen.getByText('Account panel')).toBeInTheDocument();
    expect(screen.queryByText('General panel')).not.toBeInTheDocument();
  });

  it('passes account data and refetch through to the account panel', () => {
    const refetch = vi.fn();
    const accountData = {
      accountId: 'acct_1',
      displayName: 'RepWorth',
      subscription: {
        tier: 'standard',
        tierLabel: 'Standard',
        status: 'active',
        statusLabel: 'Active',
        stripeCustomerId: 'cus_test',
        activatedAt: null,
        trialEndsAt: null,
      },
      quota: {
        activeLocations: 1,
        included: 1,
        paid: 1,
        overage: 0,
      },
      billing: {
        basePriceCents: 7900,
        overagePriceCents: 2500,
        overageUnits: 0,
        totalCents: 7900,
      },
      timeZone: 'America/New_York',
    };
    mockUseAccountData.mockReturnValue({
      data: accountData,
      loading: false,
      error: null,
      refetch,
    });

    render(<SettingsClient locationsSettingsEnabled multiLocationEnabled={false} />);

    expect(mockAccountPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        accountData,
        accountLoading: false,
        accountError: null,
        onAccountRefetch: refetch,
      }),
      undefined,
    );
    const accountPanelProps = mockAccountPanel.mock.calls[0]?.[0] as {
      accountData?: { timeZone?: string };
    } | undefined;
    expect(accountPanelProps?.accountData?.timeZone).toBe('America/New_York');
  });

  it('prefers account tab when multi-location enabled even if locations settings are disabled', () => {
    render(<SettingsClient locationsSettingsEnabled={false} multiLocationEnabled />);

    expect(screen.getByTestId('settings-shell')).toHaveAttribute('data-active-tab', 'account');
    expect(screen.getByText('Account panel')).toBeInTheDocument();
    expect(screen.queryByText('General panel')).not.toBeInTheDocument();
  });

  it('selects the general tab when locations settings are disabled', () => {
    render(<SettingsClient locationsSettingsEnabled={false} multiLocationEnabled={false} />);

    expect(screen.getByTestId('settings-shell')).toHaveAttribute('data-active-tab', 'general');
    expect(screen.getByText('General panel')).toBeInTheDocument();
    expect(screen.queryByText('Account panel')).not.toBeInTheDocument();
  });
});
