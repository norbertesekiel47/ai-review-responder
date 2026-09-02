// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import SettingsLayout from '../layout';

// The layout is a server component; the flag read is what is under test, so the
// client sidebar is replaced with a probe that records the boolean it was given.
const sidebarProps = vi.fn();
vi.mock('@/components/dashboard/settings/SettingsSidebar', () => ({
  SettingsSidebar: (props: { showLocations: boolean }) => {
    sidebarProps(props);
    return <nav data-testid="sidebar" />;
  },
}));
vi.mock('@/app/(authenticated)/_styles/settings.css', () => ({}));

let flagOn = false;
vi.mock('@/lib/locations/flags', () => ({
  multiLocationEnabled: () => flagOn,
}));

describe('SettingsLayout', () => {
  beforeEach(() => {
    sidebarProps.mockClear();
  });

  // S1 + invariants #9b/#13: the VISIBILITY check runs here on the server and the
  // browser receives a boolean, never the flag.
  it('passes showLocations=false to the sidebar when MULTI_LOCATION_ENABLED is off', () => {
    flagOn = false;
    render(<SettingsLayout><div /></SettingsLayout>);
    expect(sidebarProps).toHaveBeenCalledWith({ showLocations: false });
  });

  it('passes showLocations=true when the feature is on', () => {
    flagOn = true;
    render(<SettingsLayout><div /></SettingsLayout>);
    expect(sidebarProps).toHaveBeenCalledWith({ showLocations: true });
  });
});
