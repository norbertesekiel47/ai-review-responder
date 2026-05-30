// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsTabs } from '../SettingsTabs';

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

describe('SettingsTabs', () => {
  it('uses the existing single-location tabs when locations settings are disabled', () => {
    render(<SettingsTabs activeTab="general" />);

    expect(screen.getByRole('link', { name: /general/i })).toHaveAttribute('href', '/settings');
    expect(screen.queryByRole('link', { name: /locations/i })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /brand voice/i })).toHaveAttribute('href', '/settings#brand-voice');
  });

  it('uses Account as the settings home tab when Locations is exposed', () => {
    render(
      <SettingsTabs
        activeTab="account"
        locationsSettingsEnabled
        multiLocationEnabled={false}
      />,
    );

    expect(screen.getByRole('link', { name: /^account$/i })).toHaveAttribute('href', '/settings');
    expect(screen.getByRole('link', { name: /locations/i })).toHaveAttribute('href', '/settings/locations');
    expect(screen.getByRole('link', { name: /brand voice/i })).toHaveAttribute('href', '/settings#brand-voice');
    expect(screen.queryByRole('link', { name: /general/i })).not.toBeInTheDocument();
  });

  it('uses the multi-location account tabs for true multi-location accounts', () => {
    render(
      <SettingsTabs
        activeTab="account"
        locationsSettingsEnabled
        multiLocationEnabled
      />,
    );

    expect(screen.getByRole('link', { name: /^account$/i })).toHaveAttribute('href', '/settings');
    expect(screen.getByRole('link', { name: /locations/i })).toHaveAttribute('href', '/settings/locations');
    expect(screen.getByRole('link', { name: /^voice$/i })).toHaveAttribute('href', '/settings/voice');
    expect(screen.getByRole('link', { name: /notifications/i })).toHaveAttribute('href', '/settings/channels');
  });

  it('shows the Security tab for account settings layouts', () => {
    render(
      <SettingsTabs
        activeTab="security"
        locationsSettingsEnabled
        multiLocationEnabled
      />,
    );

    expect(screen.getByRole('link', { name: /security/i })).toHaveAttribute('href', '/settings/security');
    expect(screen.getByRole('link', { name: /security/i })).toHaveAttribute('aria-current', 'page');
  });
});

describe('SettingsTabs — route-nav ARIA (P2 #27)', () => {
  it('marks the active tab with aria-current="page" and not role=tab', () => {
    render(<SettingsTabs activeTab="security" locationsSettingsEnabled multiLocationEnabled />);
    const active = screen.getByRole('link', { name: /security/i });
    expect(active).toHaveAttribute('aria-current', 'page');
    expect(active).not.toHaveAttribute('role', 'tab');
  });
  it('uses roving tabindex (active 0, others -1)', () => {
    render(<SettingsTabs activeTab="security" locationsSettingsEnabled multiLocationEnabled />);
    expect(screen.getByRole('link', { name: /security/i })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('link', { name: /notifications/i })).toHaveAttribute('tabindex', '-1');
  });
  it('ArrowRight moves focus to the next tab', async () => {
    const user = userEvent.setup();
    render(<SettingsTabs activeTab="general" />);
    const first = screen.getByRole('link', { name: /general/i });
    first.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('link', { name: /brand voice/i })).toHaveFocus();
  });
});
