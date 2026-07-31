// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
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

  it('renders nothing on auth pages', () => {
    mockUsePathname.mockReturnValue('/admin/login');
    const { container } = renderSidebar();
    expect(container).toBeEmptyDOMElement();
  });
});
