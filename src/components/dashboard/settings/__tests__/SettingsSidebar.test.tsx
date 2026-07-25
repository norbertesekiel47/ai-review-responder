// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SettingsSidebar } from '../SettingsSidebar';

const push = vi.fn();
let mockPath = '/settings/voice';
vi.mock('next/navigation', () => ({
  usePathname: () => mockPath,
  useRouter: () => ({ push }),
}));

describe('SettingsSidebar', () => {
  beforeEach(() => { push.mockClear(); mockPath = '/settings/voice'; });

  it('renders both group labels and all items', () => {
    render(<SettingsSidebar />);
    expect(screen.getByText('Responses')).toBeInTheDocument();
    expect(screen.getByText('Account')).toBeInTheDocument();
    for (const label of ['Brand Voice', 'Auto-approval', 'Notifications', 'Competitors', 'Locations', 'Profile', 'Billing', 'Security']) {
      expect(screen.getByRole('link', { name: new RegExp(label, 'i') })).toBeInTheDocument();
    }
  });

  it('marks Brand Voice active on /settings/voice', () => {
    render(<SettingsSidebar />);
    expect(screen.getByRole('link', { name: /brand voice/i })).toHaveAttribute('aria-current', 'page');
  });

  it('treats the bare /settings index as Brand Voice active', () => {
    mockPath = '/settings';
    render(<SettingsSidebar />);
    expect(screen.getByRole('link', { name: /brand voice/i })).toHaveAttribute('aria-current', 'page');
  });

  it('marks Billing active on a nested billing path', () => {
    mockPath = '/settings/billing';
    render(<SettingsSidebar />);
    expect(screen.getByRole('link', { name: /billing/i })).toHaveAttribute('aria-current', 'page');
  });

  it('falls back to Brand Voice active on an unknown settings path', () => {
    mockPath = '/settings/nope';
    render(<SettingsSidebar />);
    expect(screen.getByRole('link', { name: /brand voice/i })).toHaveAttribute('aria-current', 'page');
  });

  it('mobile select navigates on change', () => {
    render(<SettingsSidebar />);
    fireEvent.change(screen.getByRole('combobox', { name: /settings section/i }), {
      target: { value: '/settings/billing' },
    });
    expect(push).toHaveBeenCalledWith('/settings/billing');
  });
});
