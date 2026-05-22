// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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

    expect(screen.getByRole('tab', { name: /general/i })).toHaveAttribute('href', '/settings');
    expect(screen.queryByRole('tab', { name: /locations/i })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /brand voice/i })).toHaveAttribute('href', '/settings#brand-voice');
  });

  it('uses Account as the settings home tab when Locations is exposed', () => {
    render(
      <SettingsTabs
        activeTab="account"
        locationsSettingsEnabled
        multiLocationEnabled={false}
      />,
    );

    expect(screen.getByRole('tab', { name: /^account$/i })).toHaveAttribute('href', '/settings');
    expect(screen.getByRole('tab', { name: /locations/i })).toHaveAttribute('href', '/settings/locations');
    expect(screen.getByRole('tab', { name: /brand voice/i })).toHaveAttribute('href', '/settings#brand-voice');
    expect(screen.queryByRole('tab', { name: /general/i })).not.toBeInTheDocument();
  });

  it('uses the multi-location account tabs for true multi-location accounts', () => {
    render(
      <SettingsTabs
        activeTab="account"
        locationsSettingsEnabled
        multiLocationEnabled
      />,
    );

    expect(screen.getByRole('tab', { name: /^account$/i })).toHaveAttribute('href', '/settings');
    expect(screen.getByRole('tab', { name: /locations/i })).toHaveAttribute('href', '/settings/locations');
    expect(screen.getByRole('tab', { name: /^voice$/i })).toHaveAttribute('href', '/settings/voice');
    expect(screen.getByRole('tab', { name: /notifications/i })).toHaveAttribute('href', '/settings/channels');
  });
});
