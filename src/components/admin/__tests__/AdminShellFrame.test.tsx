// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminShellFrame } from '../AdminShellFrame';

const { mockUsePathname } = vi.hoisted(() => ({ mockUsePathname: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: mockUsePathname,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/lib/db/browser', () => ({
  createBrowserSupabaseClient: () => ({ auth: { signOut: vi.fn() } }),
}));

function renderFrame(props: Partial<Parameters<typeof AdminShellFrame>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AdminShellFrame {...props}>
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
    renderFrame({
      impersonation: { sessionId: 's', expiresAt: '2026-09-02T12:45:00.000Z', accountLabel: 'X' },
    });

    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    expect(screen.queryByRole('banner')).not.toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'View-as session active' })).not.toBeInTheDocument();
    expect(screen.getByText('page content')).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('renders the sidebar and children inside <main> on non-auth pages', () => {
    mockUsePathname.mockReturnValue('/admin/overview');
    renderFrame();

    expect(screen.getByRole('complementary')).toBeInTheDocument();
    const main = screen.getByRole('main');
    expect(main).toContainElement(screen.getByText('page content'));
    expect(screen.queryByRole('status', { name: 'View-as session active' })).not.toBeInTheDocument();
  });

  it('passes the identity through to the sidebar footer (X7)', () => {
    mockUsePathname.mockReturnValue('/admin/overview');
    renderFrame({ identity: { email: 'ops@repworth.com', aal2: true } });

    expect(screen.getByRole('complementary')).toHaveTextContent('ops@repworth.com');
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('mounts the view-as banner inside <main>, above the page, while a session is live (X25)', () => {
    mockUsePathname.mockReturnValue('/admin/jobs');
    renderFrame({
      impersonation: {
        sessionId: 'sess-1',
        expiresAt: '2026-09-02T12:45:00.000Z',
        accountLabel: 'Bella Italia',
      },
    });

    const banner = screen.getByRole('status', { name: 'View-as session active' });
    const main = screen.getByRole('main');
    expect(main).toContainElement(banner);
    expect(banner.compareDocumentPosition(screen.getByText('page content')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
