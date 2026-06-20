// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SettingsShell } from '@/components/dashboard/settings/SettingsShell';

describe('SettingsShell announcements (P1 #18)', () => {
  it('announces "Settings saved" in a polite status region when savedFlash is true', () => {
    render(<SettingsShell savedFlash>body</SettingsShell>);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent('Settings saved');
  });

  it('keeps the polite status region empty when not flashing', () => {
    render(<SettingsShell>body</SettingsShell>);
    expect(screen.getByRole('status')).toHaveTextContent('');
  });

  it('announces a save error in an assertive alert region', () => {
    render(<SettingsShell saveError="Network error">body</SettingsShell>);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('aria-live', 'assertive');
    expect(alert).toHaveTextContent('Network error');
  });
});
