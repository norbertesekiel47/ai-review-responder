// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { LocationChange } from '@/components/dashboard/settings/LocationsPanel';

const { mockRefresh, mockToast } = vi.hoisted(() => ({ mockRefresh: vi.fn(), mockToast: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh, push: vi.fn() }),
}));
vi.mock('@/components/dashboard/shell/toast/ToastProvider', () => ({
  useToast: () => ({ toast: mockToast, dismiss: vi.fn() }),
}));
// The panel's own behaviour is covered in its component tests; here it is a
// stub that lets the test fire the callback the way a row would.
vi.mock('@/components/dashboard/settings/LocationsPanel', () => ({
  LocationsPanel: ({ onLocationChange }: { onLocationChange: (change: LocationChange) => void }) => (
    <button type="button" onClick={() => onLocationChange('archived')}>simulate archive</button>
  ),
}));

import { LocationsClient, locationChangeToast } from '../LocationsClient';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const props = {
  locations: [],
  archivedLocations: [],
  activeCount: 0,
  accountId: 'acct',
  addLocationState: { kind: 'enabled' as const },
  voiceHref: '/settings/voice',
};

// S32: no full-page reload — router.refresh() keeps scroll and state, and the
// owner gets a confirmation.
describe('LocationsClient', () => {
  it('refreshes the server tree and toasts instead of reloading the window', () => {
    const reloadSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload: reloadSpy },
    });

    render(<LocationsClient {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'simulate archive' }));

    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(mockToast).toHaveBeenCalledWith(locationChangeToast('archived'));
    expect(reloadSpy).not.toHaveBeenCalled();
  });
});

describe('locationChangeToast', () => {
  it('has a success toast for every change, and the archive one points at the Archived list', () => {
    const changes: LocationChange[] = ['archived', 'reactivated', 'promoted', 'renamed'];
    for (const change of changes) {
      expect(locationChangeToast(change).tone).toBe('success');
      expect(locationChangeToast(change).title.length).toBeGreaterThan(0);
    }
    expect(locationChangeToast('archived').body).toMatch(/archived list/i);
  });
});
