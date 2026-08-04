// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminSidebar } from '../AdminSidebar';
import { ADMIN_NAV_GROUPS } from '../nav-config';

const { mockUsePathname } = vi.hoisted(() => ({ mockUsePathname: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: mockUsePathname }));

function renderSidebar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AdminSidebar />
    </QueryClientProvider>,
  );
}

describe('AdminSidebar', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockUsePathname.mockReturnValue('/admin/overview');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ flaggedOpen: 3, failedJobs: 1 }), { status: 200 }),
    ));
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

  it('marks the current page active, including sub-routes', () => {
    mockUsePathname.mockReturnValue('/admin/businesses/abc-123');
    renderSidebar();
    expect(screen.getByRole('link', { name: /All businesses/ })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: /Overview/ })).not.toHaveAttribute('aria-current');
  });

  it('shows badge counts from nav-counts', async () => {
    renderSidebar();
    await waitFor(() => {
      expect(screen.getByText('3')).toBeInTheDocument(); // flagged
      expect(screen.getByText('1')).toBeInTheDocument(); // failed jobs
    });
  });

  it('Escape closes the mobile drawer, restoring body scroll and trigger focus', async () => {
    const user = userEvent.setup();
    const { container } = renderSidebar();

    const trigger = screen.getByRole('button', { name: /open navigation/i });
    await user.click(trigger);

    expect(screen.getByRole('button', { name: /close navigation/i })).toBeInTheDocument();
    const panel = container.querySelector('[tabindex="-1"]');
    expect(panel).not.toBeNull();
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
  '/admin/businesses/new': 'child of "All businesses"; reached from that page’s + Add Business action',
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
