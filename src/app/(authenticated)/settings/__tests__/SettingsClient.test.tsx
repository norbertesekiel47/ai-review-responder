// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SettingsClient } from '../SettingsClient';

const { mockUseSettingsForm, mockUseAccountData } = vi.hoisted(() => ({
  mockUseSettingsForm: vi.fn(),
  mockUseAccountData: vi.fn(),
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
  AccountPanel: () => <div>Account panel</div>,
}));

vi.mock('@/components/dashboard/settings/GeneralPanel', () => ({
  GeneralPanel: () => <div>General panel</div>,
}));

vi.mock('@/components/dashboard/settings/BrandVoicePanel', () => ({
  BrandVoicePanel: () => <div>Brand voice panel</div>,
}));

describe('SettingsClient', () => {
  beforeEach(() => {
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

  it('selects the general tab when locations settings are disabled', () => {
    render(<SettingsClient locationsSettingsEnabled={false} multiLocationEnabled={false} />);

    expect(screen.getByTestId('settings-shell')).toHaveAttribute('data-active-tab', 'general');
    expect(screen.getByText('General panel')).toBeInTheDocument();
    expect(screen.queryByText('Account panel')).not.toBeInTheDocument();
  });
});
