// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsSidebar } from '../SettingsSidebar';

const push = vi.fn();
let mockPath = '/settings/voice';
vi.mock('next/navigation', () => ({
  usePathname: () => mockPath,
  useRouter: () => ({ push }),
}));

let mockDirty = false;
vi.mock('@/hooks/useUnsavedChangesGuard', () => ({
  useHasUnsavedChanges: () => mockDirty,
}));

describe('SettingsSidebar', () => {
  beforeEach(() => {
    push.mockClear();
    mockPath = '/settings/voice';
    mockDirty = false;
  });

  it('renders both group labels and all items when Locations is enabled', () => {
    render(<SettingsSidebar showLocations />);
    expect(screen.getByText('Responses')).toBeInTheDocument();
    expect(screen.getByText('Account')).toBeInTheDocument();
    for (const label of ['Brand Voice', 'Auto-approval', 'Notifications', 'Competitors', 'Locations', 'Profile', 'Billing', 'Security']) {
      expect(screen.getByRole('link', { name: new RegExp(label, 'i') })).toBeInTheDocument();
    }
  });

  // S1: with the multi-location feature off, /settings/locations 404s, so the
  // nav must not offer it — in the desktop list OR the mobile select.
  it('hides Locations from the list and the mobile select when the server says the tab is off', () => {
    render(<SettingsSidebar showLocations={false} />);
    expect(screen.queryByRole('link', { name: /locations/i })).not.toBeInTheDocument();
    const select = screen.getByRole('combobox', { name: /settings section/i });
    expect(within(select).queryByRole('option', { name: 'Locations' })).not.toBeInTheDocument();
    // The rest of the Account group survives the filter.
    expect(within(select).getByRole('option', { name: 'Profile' })).toBeInTheDocument();
  });

  // #1092: the **Review QR** surface moved under Requests. It is asserted here
  // as an ABSENCE rather than deleted, because a settings row silently
  // reappearing is exactly how two navigations start claiming the same surface.
  // Its presence under Requests is covered by Sidebar.test.tsx and
  // requests-tabs.test.tsx. The S28 glyph test went with it: there is no
  // settings row left to carry a glyph, and Locations keeps its own pin.
  it('no longer lists Review QR, which moved under Requests', () => {
    render(<SettingsSidebar showLocations />);
    expect(screen.queryByRole('link', { name: /review qr/i })).not.toBeInTheDocument();
    // Locations survives the removal and keeps its own glyph.
    const locationsLink = screen.getByRole('link', { name: /locations/i });
    expect(locationsLink.querySelector('svg')).not.toBeNull();
    expect(locationsLink.querySelector('svg[data-icon="qr"]')).toBeNull();
  });

  it('marks Brand Voice active on /settings/voice', () => {
    render(<SettingsSidebar showLocations />);
    expect(screen.getByRole('link', { name: /brand voice/i })).toHaveAttribute('aria-current', 'page');
  });

  it('treats the bare /settings index as Brand Voice active', () => {
    mockPath = '/settings';
    render(<SettingsSidebar showLocations />);
    expect(screen.getByRole('link', { name: /brand voice/i })).toHaveAttribute('aria-current', 'page');
  });

  it('marks Billing active on a nested billing path', () => {
    mockPath = '/settings/billing';
    render(<SettingsSidebar showLocations />);
    expect(screen.getByRole('link', { name: /billing/i })).toHaveAttribute('aria-current', 'page');
  });

  it('falls back to Brand Voice active on an unknown settings path', () => {
    mockPath = '/settings/nope';
    render(<SettingsSidebar showLocations />);
    expect(screen.getByRole('link', { name: /brand voice/i })).toHaveAttribute('aria-current', 'page');
  });

  it('mobile select navigates on change', () => {
    render(<SettingsSidebar showLocations />);
    fireEvent.change(screen.getByRole('combobox', { name: /settings section/i }), {
      target: { value: '/settings/billing' },
    });
    expect(push).toHaveBeenCalledWith('/settings/billing');
  });

  // S5: leaving a dirty form is confirmed, never silent.
  describe('with unsaved changes on the current page', () => {
    beforeEach(() => {
      mockDirty = true;
    });

    it('intercepts a sidebar link and asks before leaving; Keep editing stays put', async () => {
      const user = userEvent.setup();
      render(<SettingsSidebar showLocations />);

      await user.click(screen.getByRole('link', { name: /billing/i }));

      const dialog = await screen.findByRole('dialog', { name: 'Leave without saving?' });
      expect(within(dialog).getByText(/You have unsaved changes on this page/)).toBeInTheDocument();
      expect(push).not.toHaveBeenCalled();

      await user.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(push).not.toHaveBeenCalled();
    });

    it('Leave without saving navigates to the requested tab', async () => {
      const user = userEvent.setup();
      render(<SettingsSidebar showLocations />);

      await user.click(screen.getByRole('link', { name: /billing/i }));
      await user.click(await screen.findByRole('button', { name: 'Leave without saving' }));

      expect(push).toHaveBeenCalledWith('/settings/billing');
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('the mobile select also asks first and stays on the current tab meanwhile', async () => {
      const user = userEvent.setup();
      render(<SettingsSidebar showLocations />);

      fireEvent.change(screen.getByRole('combobox', { name: /settings section/i }), {
        target: { value: '/settings/profile' },
      });

      await screen.findByRole('dialog', { name: 'Leave without saving?' });
      expect(push).not.toHaveBeenCalled();
      expect(screen.getByRole('combobox', { name: /settings section/i })).toHaveValue('/settings/voice');

      await user.click(screen.getByRole('button', { name: 'Leave without saving' }));
      expect(push).toHaveBeenCalledWith('/settings/profile');
    });
  });
});
