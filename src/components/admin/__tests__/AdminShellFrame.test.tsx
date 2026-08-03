// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminShellFrame } from '../AdminShellFrame';

const { mockUsePathname } = vi.hoisted(() => ({ mockUsePathname: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: mockUsePathname }));

function renderFrame() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AdminShellFrame>
        <div>page content</div>
      </AdminShellFrame>
    </QueryClientProvider>,
  );
}

describe('AdminShellFrame', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ flaggedOpen: 0, failedJobs: 0 }), { status: 200 }),
    ));
  });

  it('renders bare children on auth pages, without mounting the sidebar or polling nav-counts', () => {
    mockUsePathname.mockReturnValue('/admin/login');
    renderFrame();

    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    expect(screen.queryByRole('banner')).not.toBeInTheDocument();
    expect(screen.getByText('page content')).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('renders the sidebar and children inside <main> on non-auth pages', () => {
    mockUsePathname.mockReturnValue('/admin/overview');
    renderFrame();

    expect(screen.getByRole('complementary')).toBeInTheDocument();
    const main = screen.getByRole('main');
    expect(main).toContainElement(screen.getByText('page content'));
  });
});
