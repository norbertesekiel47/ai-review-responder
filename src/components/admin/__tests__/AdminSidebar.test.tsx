// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminSidebar } from '../AdminSidebar';
import { ADMIN_NAV_GROUPS } from '../nav-config';

const { mockUsePathname, pushMock, refreshMock, signOutMock } = vi.hoisted(() => ({
  mockUsePathname: vi.fn(),
  pushMock: vi.fn(),
  refreshMock: vi.fn(),
  signOutMock: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  usePathname: mockUsePathname,
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
}));
vi.mock('@/lib/db/browser', () => ({
  createBrowserSupabaseClient: () => ({ auth: { signOut: signOutMock } }),
}));

type SidebarProps = Parameters<typeof AdminSidebar>[0];

function renderSidebar(props: Partial<SidebarProps> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AdminSidebar adminAppUrl="https://admin.example.com" {...props} />
    </QueryClientProvider>,
  );
}

const IDENTITY = { email: 'ops@repworth.com', aal2: true };

describe('AdminSidebar', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    pushMock.mockClear();
    refreshMock.mockClear();
    signOutMock.mockReset().mockResolvedValue({ error: null });
    mockUsePathname.mockReturnValue('/admin/suppressions');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ flaggedOpen: 3, failedJobs: 1 }), { status: 200 }),
    ));
  });

  it('renders group labels at 11px in gray-400 — the legible floor on gray-900 (X31)', () => {
    renderSidebar();
    const label = screen.getByText(ADMIN_NAV_GROUPS[0].label);
    expect(label.className).toContain('text-[11px]');
    expect(label.className).toContain('text-gray-400');
    expect(label.className).not.toContain('text-[10px]');
  });

  it('renders every nav item from every group', () => {
    renderSidebar();
    for (const group of ADMIN_NAV_GROUPS) {
      expect(screen.getByText(group.label)).toBeInTheDocument();
      for (const item of group.items) {
        expect(screen.getByRole('link', { name: new RegExp(item.label) })).toHaveAttribute('href', item.href);
      }
    }
  });

  it('uses the server-provided Admin home in both desktop and mobile brand anchors', () => {
    renderSidebar();
    const homeLinks = screen.getAllByRole('link', { name: /RepWorth.*ADMIN/i });
    expect(homeLinks).toHaveLength(2);
    for (const link of homeLinks) expect(link).toHaveAttribute('href', 'https://admin.example.com');
  });

  it('marks the current page active, including sub-routes', () => {
    mockUsePathname.mockReturnValue('/admin/locations/csv-import/preview');
    renderSidebar();
    expect(screen.getByRole('link', { name: /Locations import/ })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: /Suppressions/ })).not.toHaveAttribute('aria-current');
  });

  it('Escape closes the mobile drawer, restoring body scroll and trigger focus', async () => {
    const user = userEvent.setup();
    const { container } = renderSidebar();

    const trigger = screen.getByRole('button', { name: /open navigation/i });
    await user.click(trigger);

    expect(screen.getByRole('button', { name: /close navigation/i })).toHaveAttribute('aria-expanded', 'true');
    const panel = container.querySelector('[tabindex="-1"]');
    expect(panel).not.toBeNull();
    // A focus-trapping, scroll-locking full-screen drawer is a modal dialog (X33).
    expect(panel).toHaveAttribute('role', 'dialog');
    expect(panel).toHaveAttribute('aria-modal', 'true');
    expect(panel).toHaveAttribute('aria-label', 'Admin navigation');
    expect(document.body.style.overflow).toBe('hidden');
    await waitFor(() => expect(panel).toHaveFocus());

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(container.querySelector('[tabindex="-1"]')).toBeNull();
    });
    expect(document.body.style.overflow).toBe('');
    expect(trigger).toHaveFocus();
  });
});

describe('AdminSidebar footer (X7)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    pushMock.mockClear();
    refreshMock.mockClear();
    signOutMock.mockReset().mockResolvedValue({ error: null });
    mockUsePathname.mockReturnValue('/admin/suppressions');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ flaggedOpen: 0, failedJobs: 0 }), { status: 200 }),
    ));
  });

  it('renders no footer without an identity (signed-out shell renders)', () => {
    renderSidebar();
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  });

  it('shows the signed-in email and a verified step-up state', () => {
    renderSidebar({ identity: IDENTITY });
    const aside = screen.getByRole('complementary');
    expect(aside).toHaveTextContent('ops@repworth.com');
    expect(aside).toHaveTextContent('Step-up verified (AAL2)');
    expect(screen.queryByRole('link', { name: 'Verify' })).toBeNull();
  });

  it('offers a Verify link back to the current page when the session is not stepped up', () => {
    renderSidebar({ identity: { email: 'ops@repworth.com', aal2: false } });
    expect(screen.getByRole('complementary')).toHaveTextContent('Step-up not verified');
    expect(screen.getByRole('link', { name: 'Verify' })).toHaveAttribute(
      'href',
      '/mfa/challenge?next=%2Fadmin%2Fsuppressions',
    );
  });

  it('signs out through the Supabase browser client and lands on the ADMIN login', async () => {
    const user = userEvent.setup();
    renderSidebar({ identity: IDENTITY });

    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => expect(signOutMock).toHaveBeenCalledTimes(1));
    expect(pushMock).toHaveBeenCalledWith('/admin/login');
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('reports a failed sign-out inline and stays signed in', async () => {
    const user = userEvent.setup();
    signOutMock.mockResolvedValue({ error: new Error('network') });
    renderSidebar({ identity: IDENTITY });

    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Sign out failed');
    expect(pushMock).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeEnabled();
  });
});

/**
 * IA completeness, both directions (Phase 3 Task 10 Step 3). The suite above
 * already covers nav → DOM; this covers nav ⇄ FILESYSTEM, which is the half
 * that drifts silently — a new admin page that never reaches ADMIN_NAV_GROUPS
 * is reachable only by typing its URL, and a nav href whose page was deleted is
 * a 404 in the sidebar.
 */
// Widened to string: ADMIN_NAV_GROUPS is `as const`, so `item.href` narrows to
// a union of literals and every comparison against a filesystem-derived path
// would be a type error rather than a test.
const NAV_HREFS: string[] = ADMIN_NAV_GROUPS.flatMap((group) =>
  group.items.map((item) => item.href as string),
);

/**
 * Pages deliberately absent from the sidebar. Each needs a reason — this list
 * is the escape hatch, so an unexplained entry is the smell.
 */
const NON_NAV_PAGES: Record<string, string> = {
  '/admin/login': 'auth route, renders outside the shell (ADMIN_AUTH_ROUTES)',
  '/admin/forgot-password': 'auth route, renders outside the shell',
  '/admin/reset-password': 'auth route, renders outside the shell',
};

function adminPageRoutes(): string[] {
  const routes: string[] = [];
  const walk = (dir: string, route: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), `${route}/${entry.name}`);
      } else if (entry.name === 'page.tsx') {
        routes.push(route);
      }
    }
  };
  walk(resolve(process.cwd(), 'src/app/admin'), '/admin');
  // Dynamic segments are detail views of a nav page, never nav entries.
  return routes.filter((route) => !route.includes('[')).sort();
}

describe('admin IA: nav ⇄ filesystem', () => {
  it('lists every non-auth admin page exactly once', () => {
    const unlisted = adminPageRoutes().filter(
      (route) => !NAV_HREFS.includes(route) && !(route in NON_NAV_PAGES),
    );
    expect(unlisted, 'admin pages missing from ADMIN_NAV_GROUPS').toEqual([]);
  });

  it('has no duplicate nav hrefs', () => {
    expect(NAV_HREFS).toHaveLength(new Set(NAV_HREFS).size);
  });

  it('points every nav href at a real page', () => {
    const routes = adminPageRoutes();
    const broken = NAV_HREFS.filter((href) => !routes.includes(href));
    expect(broken, 'nav hrefs with no page.tsx behind them').toEqual([]);
  });

  it('keeps the excluded-page list honest — every exclusion still exists', () => {
    const routes = adminPageRoutes();
    const stale = Object.keys(NON_NAV_PAGES).filter((route) => !routes.includes(route));
    expect(stale, 'NON_NAV_PAGES entries whose page was deleted').toEqual([]);
  });
});
