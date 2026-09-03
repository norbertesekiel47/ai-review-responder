// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement as h } from 'react';
import { Sidebar } from '@/components/dashboard/shell/Sidebar';
import { LocationProvider, type LocationInfo } from '@/contexts/LocationContext';
import { OwnerIdentityProvider } from '@/contexts/OwnerIdentityContext';
import type { LocationId } from '@/lib/shared/ids';

vi.mock('@/lib/db/browser', () => ({
  createBrowserSupabaseClient: () => ({
    auth: { signOut: vi.fn().mockResolvedValue({ error: null }) },
  }),
}));

const { pathnameMock } = vi.hoisted(() => ({
  pathnameMock: vi.fn<() => string>(() => '/dashboard'),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => pathnameMock(),
}));

vi.mock('@/contexts/PendingCountContext', () => ({
  usePendingCount: () => 0,
}));

const LOC_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' as LocationId;

function wrapWithProvider(
  ui: React.ReactElement,
  overrides?: { locations?: LocationInfo[]; multiLocationEnabled?: boolean },
) {
  const locations = overrides?.locations ?? [
    { id: LOC_A, name: 'Bristol Bay Coffee', displayLabel: null, isPrimary: true },
  ];
  return h(
    OwnerIdentityProvider,
    {
      name: 'Maya Chen',
      email: 'maya@bristolbay.co',
      children: h(
        LocationProvider,
        {
          locations,
          initialScope: LOC_A,
          multiLocationEnabled: overrides?.multiLocationEnabled ?? false,
          children: ui,
        },
      ),
    },
  );
}

describe('Sidebar', () => {
  beforeEach(() => {
    pathnameMock.mockReturnValue('/dashboard');
  });

  it('leads with the account control, then the scope, and docks the wordmark', () => {
    render(
      wrapWithProvider(
        <Sidebar
          businessName="Bristol Bay Coffee"
          solicitationEnabled={false}
        />,
      ),
    );
    // Identity first: the account trigger carries the owner's name, and the
    // email now lives inside its menu rather than on a static chip.
    expect(screen.getByRole('button', { name: /maya chen/i })).toBeInTheDocument();
    expect(screen.queryByText('maya@bristolbay.co')).not.toBeInTheDocument();
    expect(screen.getByText('Bristol Bay Coffee')).toBeInTheDocument();
    // The wordmark survives, at the foot of the rail.
    expect(screen.getByText('RepWorth')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /dashboard/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /reviews/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /settings/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /help/i })).toHaveAttribute('href', '/help/contact');
  });

  it('hides the All Reviews child until the Reviews section is open', () => {
    render(
      wrapWithProvider(
        <Sidebar businessName="Coffee Co" solicitationEnabled={false} />,
      ),
    );
    expect(screen.queryByRole('link', { name: /all reviews/i })).not.toBeInTheDocument();
  });

  // UX audit D16: the child carries the tab's own name, never "Past replies".
  it('reveals the Reviews children on a reviews route, and marks the open child', () => {
    pathnameMock.mockReturnValue('/dashboard/reviews/history');
    render(
      wrapWithProvider(
        <Sidebar businessName="Coffee Co" solicitationEnabled={false} />,
      ),
    );
    expect(screen.queryByRole('link', { name: /past replies/i })).not.toBeInTheDocument();
    const history = screen.getByRole('link', { name: 'All Reviews' });
    expect(history).toHaveAttribute('href', '/dashboard/reviews/history');
    expect(history).toHaveAttribute('aria-current', 'page');
    // The parent row stays highlighted alongside the child.
    expect(screen.getByRole('link', { name: /^reviews$/i }).className).toContain('active');
    expect(screen.getByRole('link', { name: /needs action/i })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('marks active nav item based on usePathname', () => {
    render(
      wrapWithProvider(
        <Sidebar businessName="Coffee Co" solicitationEnabled={false} />,
      ),
    );
    const dash = screen.getByRole('link', { name: /dashboard/i });
    expect(dash.className).toContain('active');
    expect(dash).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: /reviews/i })).not.toHaveAttribute('aria-current');
  });

  it('renders the Reviews nav item (Insights/Past Replies removed)', () => {
    render(
      wrapWithProvider(
        <Sidebar businessName="Coffee Co" solicitationEnabled={false} />,
      ),
    );
    expect(screen.getByRole('link', { name: /reviews/i })).toHaveAttribute('href', '/dashboard/reviews');
    expect(screen.queryByRole('link', { name: /insights/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /past replies|all reviews/i })).not.toBeInTheDocument();
  });

  it('renders the Analytics nav item (final order: Dashboard · Reviews · Analytics · Settings)', () => {
    render(
      wrapWithProvider(
        <Sidebar businessName="Coffee Co" solicitationEnabled={false} />,
      ),
    );
    expect(screen.getByRole('link', { name: /analytics/i })).toHaveAttribute('href', '/dashboard/analytics');
  });

  it('marks Analytics active on /dashboard/analytics without lighting up Dashboard', () => {
    pathnameMock.mockReturnValue('/dashboard/analytics');
    render(
      wrapWithProvider(
        <Sidebar businessName="Coffee Co" solicitationEnabled={false} />,
      ),
    );
    expect(screen.getByRole('link', { name: /analytics/i }).className).toContain('active');
    expect(screen.getByRole('link', { name: /analytics/i })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: /^dashboard$/i }).className).not.toContain('active');
  });

  // Sign-out moved into the account menu; its success and both failure arms are
  // covered by shell/__tests__/AccountMenu.test.tsx.

  it('hides the Requests sidebar row when watch-mode is off', () => {
    render(
      wrapWithProvider(
        <Sidebar businessName="Coffee Co" solicitationEnabled={false} />,
      ),
    );
    expect(screen.queryByRole('link', { name: /requests/i })).not.toBeInTheDocument();
  });

  it('renders exactly one Requests row, between Reviews and Analytics, when watch-mode is on', () => {
    render(
      wrapWithProvider(
        <Sidebar businessName="Coffee Co" solicitationEnabled />,
      ),
    );
    const requests = screen.getAllByRole('link', { name: /requests/i });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toHaveAttribute('href', '/dashboard/requests');

    const navOrder = screen
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'));
    expect(navOrder.indexOf('/dashboard/reviews')).toBeLessThan(
      navOrder.indexOf('/dashboard/requests'),
    );
    expect(navOrder.indexOf('/dashboard/requests')).toBeLessThan(
      navOrder.indexOf('/dashboard/analytics'),
    );
  });

  it('marks Requests active on /dashboard/requests without lighting up Dashboard', () => {
    pathnameMock.mockReturnValue('/dashboard/requests');
    render(
      wrapWithProvider(
        <Sidebar businessName="Coffee Co" solicitationEnabled />,
      ),
    );
    const requests = screen.getByRole('link', { name: /requests/i });
    expect(requests.className).toContain('active');
    expect(requests).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: /^dashboard$/i }).className).not.toContain('active');
  });

  it('keeps Requests active on the nested /dashboard/requests/contacts route', () => {
    pathnameMock.mockReturnValue('/dashboard/requests/contacts');
    render(
      wrapWithProvider(
        <Sidebar businessName="Coffee Co" solicitationEnabled />,
      ),
    );
    expect(screen.getByRole('link', { name: /requests/i }).className).toContain('active');
    expect(screen.getByRole('link', { name: /^dashboard$/i }).className).not.toContain('active');
  });

  it('shows LocationPicker instead of static businessName for multi-location accounts', () => {
    const LOC_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' as LocationId;
    render(
      wrapWithProvider(
        <Sidebar businessName="Bristol Bay Coffee" solicitationEnabled={false} />,
        {
          locations: [
            { id: LOC_A, name: 'Bristol Bay Coffee', displayLabel: null, isPrimary: true },
            { id: LOC_B, name: 'Westside Bakery', displayLabel: null, isPrimary: false },
          ],
          multiLocationEnabled: true,
        },
      ),
    );
    // The LocationPicker trigger button should be visible
    expect(screen.getByRole('button', { name: /bristol bay coffee/i })).toBeInTheDocument();
    // The static businessName div should NOT be present
    expect(screen.queryByText('Bristol Bay Coffee', { selector: '.brand-biz' })).not.toBeInTheDocument();
  });

  it('supports arrow navigation and restores focus when the location menu closes', async () => {
    const user = userEvent.setup();
    const LOC_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' as LocationId;
    render(
      wrapWithProvider(
        <Sidebar businessName="Bristol Bay Coffee" solicitationEnabled={false} />,
        {
          locations: [
            { id: LOC_A, name: 'Bristol Bay Coffee', displayLabel: null, isPrimary: true },
            { id: LOC_B, name: 'Westside Bakery', displayLabel: null, isPrimary: false },
          ],
          multiLocationEnabled: true,
        },
      ),
    );
    const trigger = screen.getByRole('button', { name: /bristol bay coffee/i });

    trigger.focus();
    await user.keyboard('{ArrowDown}');
    expect(await screen.findByRole('menu')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('menuitemradio', { name: /all locations/i })).toHaveFocus());

    await user.keyboard('{End}');
    expect(screen.getByRole('menuitem', { name: /add location/i })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});

// #1092 / #1089. Desktop navigation is sidebar CHILDREN; the in-page pill bars
// survive only below the sidebar breakpoint. Children follow the ACTIVE section,
// matching the existing Reviews behaviour — there is no stored disclosure state.
describe('Sidebar — section children', () => {
  it('the sidebar lists Needs Action and All Reviews under Reviews', () => {
    pathnameMock.mockReturnValue('/dashboard/reviews');
    render(
      wrapWithProvider(<Sidebar businessName="Coffee Co" solicitationEnabled={false} />),
    );
    expect(screen.getByRole('link', { name: 'Needs Action' })).toHaveAttribute(
      'href',
      '/dashboard/reviews',
    );
    expect(screen.getByRole('link', { name: 'All Reviews' })).toHaveAttribute(
      'href',
      '/dashboard/reviews/history',
    );
  });

  it('the sidebar lists Contacts and Review QR under Requests', () => {
    pathnameMock.mockReturnValue('/dashboard/requests');
    render(
      wrapWithProvider(<Sidebar businessName="Coffee Co" solicitationEnabled />),
    );
    expect(screen.getByRole('link', { name: 'Contacts' })).toHaveAttribute(
      'href',
      '/dashboard/requests/contacts',
    );
    // The Review QR surface moves out of Settings (#1092, item 3).
    expect(screen.getByRole('link', { name: 'Review QR' })).toHaveAttribute(
      'href',
      '/dashboard/requests/qr',
    );
  });

  it('the sidebar lists Metrics and Restraint under Analytics', () => {
    pathnameMock.mockReturnValue('/dashboard/analytics');
    render(
      wrapWithProvider(<Sidebar businessName="Coffee Co" solicitationEnabled={false} />),
    );
    expect(screen.getByRole('link', { name: 'Metrics' })).toHaveAttribute(
      'href',
      '/dashboard/analytics',
    );
    expect(screen.getByRole('link', { name: 'Restraint' })).toHaveAttribute(
      'href',
      '/dashboard/analytics/restraint',
    );
  });

  it('the Requests section and its children are hidden when solicitation is disabled', () => {
    // Invariant #13: the flag arrives as a prop. A child must never outlive the
    // parent it hangs from — a Review QR link under a hidden Requests row is a
    // route with no visible way back.
    pathnameMock.mockReturnValue('/dashboard/requests');
    render(
      wrapWithProvider(<Sidebar businessName="Coffee Co" solicitationEnabled={false} />),
    );
    expect(screen.queryByRole('link', { name: 'Requests' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Contacts' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Review QR' })).not.toBeInTheDocument();
  });

  it('opens only the ACTIVE section, so two child groups never show at once', () => {
    pathnameMock.mockReturnValue('/dashboard/analytics');
    render(
      wrapWithProvider(<Sidebar businessName="Coffee Co" solicitationEnabled />),
    );
    expect(screen.getByRole('link', { name: 'Restraint' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'All Reviews' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Contacts' })).not.toBeInTheDocument();
  });
});

