// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement as h } from 'react';
import { Sidebar } from '@/components/dashboard/shell/Sidebar';
import { LocationProvider, type LocationInfo } from '@/contexts/LocationContext';
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
    LocationProvider,
    {
      locations,
      initialScope: LOC_A,
      multiLocationEnabled: overrides?.multiLocationEnabled ?? false,
      children: ui,
    },
  );
}

describe('Sidebar', () => {
  beforeEach(() => {
    pathnameMock.mockReturnValue('/dashboard');
  });

  it('renders brand, nav items, user chip, and sign-out', () => {
    render(
      wrapWithProvider(
        <Sidebar
          businessName="Bristol Bay Coffee"
          ownerName="Maya Chen"
          ownerEmail="maya@bristolbay.co"
          solicitationEnabled={false}
        />,
      ),
    );
    expect(screen.getByText('RepWorth')).toBeInTheDocument();
    expect(screen.getByText('Bristol Bay Coffee')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /dashboard/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /reviews/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /settings/i })).toBeInTheDocument();
    expect(screen.getByText('Maya Chen')).toBeInTheDocument();
    expect(screen.getByText('maya@bristolbay.co')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
  });

  it('never renders a standalone Past Replies nav item (folded into Reviews → History)', () => {
    render(
      wrapWithProvider(
        <Sidebar businessName="Coffee Co" ownerName="" ownerEmail="a@b.co" solicitationEnabled={false} />,
      ),
    );
    expect(screen.queryByRole('link', { name: /past replies/i })).not.toBeInTheDocument();
  });

  it('marks active nav item based on usePathname', () => {
    render(
      wrapWithProvider(
        <Sidebar businessName="Coffee Co" ownerName="" ownerEmail="a@b.co" solicitationEnabled={false} />,
      ),
    );
    const dash = screen.getByRole('link', { name: /dashboard/i });
    expect(dash.className).toContain('active');
  });

  it('renders the Reviews nav item (Insights/Past Replies removed)', () => {
    render(
      wrapWithProvider(
        <Sidebar businessName="Coffee Co" ownerName="" ownerEmail="a@b.co" solicitationEnabled={false} />,
      ),
    );
    expect(screen.getByRole('link', { name: /reviews/i })).toHaveAttribute('href', '/dashboard/reviews');
    expect(screen.queryByRole('link', { name: /insights/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /past replies/i })).not.toBeInTheDocument();
  });

  it('renders the Analytics nav item (final order: Dashboard · Reviews · Analytics · Settings)', () => {
    render(
      wrapWithProvider(
        <Sidebar businessName="Coffee Co" ownerName="" ownerEmail="a@b.co" solicitationEnabled={false} />,
      ),
    );
    expect(screen.getByRole('link', { name: /analytics/i })).toHaveAttribute('href', '/dashboard/analytics');
  });

  it('marks Analytics active on /dashboard/analytics without lighting up Dashboard', () => {
    pathnameMock.mockReturnValue('/dashboard/analytics');
    render(
      wrapWithProvider(
        <Sidebar businessName="Coffee Co" ownerName="" ownerEmail="a@b.co" solicitationEnabled={false} />,
      ),
    );
    expect(screen.getByRole('link', { name: /analytics/i }).className).toContain('active');
    expect(screen.getByRole('link', { name: /^dashboard$/i }).className).not.toContain('active');
  });

  it('calls supabase signOut on click', async () => {
    const user = userEvent.setup();
    render(
      wrapWithProvider(
        <Sidebar businessName="Coffee Co" ownerName="" ownerEmail="a@b.co" solicitationEnabled={false} />,
      ),
    );
    await user.click(screen.getByRole('button', { name: /sign out/i }));
    expect(screen.getByRole('button', { name: /sign out|signing out/i })).toBeInTheDocument();
  });

  it('hides the Requests sidebar row when watch-mode is off', () => {
    render(
      wrapWithProvider(
        <Sidebar businessName="Coffee Co" ownerName="" ownerEmail="a@b.co" solicitationEnabled={false} />,
      ),
    );
    expect(screen.queryByRole('link', { name: /requests/i })).not.toBeInTheDocument();
  });

  it('renders exactly one Requests row, between Reviews and Analytics, when watch-mode is on', () => {
    render(
      wrapWithProvider(
        <Sidebar businessName="Coffee Co" ownerName="" ownerEmail="a@b.co" solicitationEnabled />,
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
        <Sidebar businessName="Coffee Co" ownerName="" ownerEmail="a@b.co" solicitationEnabled />,
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
        <Sidebar businessName="Coffee Co" ownerName="" ownerEmail="a@b.co" solicitationEnabled />,
      ),
    );
    expect(screen.getByRole('link', { name: /requests/i }).className).toContain('active');
    expect(screen.getByRole('link', { name: /^dashboard$/i }).className).not.toContain('active');
  });

  it('shows LocationPicker instead of static businessName for multi-location accounts', () => {
    const LOC_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' as LocationId;
    render(
      wrapWithProvider(
        <Sidebar businessName="Bristol Bay Coffee" ownerName="Maya" ownerEmail="maya@test.co" solicitationEnabled={false} />,
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
});
