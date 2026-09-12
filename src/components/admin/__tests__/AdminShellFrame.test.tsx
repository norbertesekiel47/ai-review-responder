// @vitest-environment jsdom
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
  return render(
    <AdminShellFrame adminAppUrl="https://admin.example.com" {...props}>
      <div>page content</div>
    </AdminShellFrame>,
  );
}

describe('AdminShellFrame', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockUsePathname.mockReturnValue('/admin/impersonate');
    vi.stubGlobal('fetch', vi.fn());
  });

  it.each(['/admin/login', '/admin/forgot-password', '/admin/reset-password'])(
    'keeps %s bare without mounting identity, banner or navigation', (pathname) => {
      mockUsePathname.mockReturnValue(pathname);
      renderFrame({
        identity: { email: 'ops@repworth.com', aal2: true },
        impersonation: { sessionId: 's', expiresAt: '2026-09-02T12:45:00.000Z', accountLabel: 'X' },
      });
      expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
      expect(screen.queryByRole('banner')).not.toBeInTheDocument();
      expect(screen.queryByRole('status', { name: 'View-as session active' })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Open Admin app' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
      expect(screen.getByText('page content')).toBeInTheDocument();
      expect(global.fetch).not.toHaveBeenCalled();
    },
  );

  it.each(['/admin/impersonate', '/admin/impersonate/session/view', null])(
    'renders one external Admin app link and no sidebar at %s', (pathname) => {
      mockUsePathname.mockReturnValue(pathname);
      renderFrame({ adminAppUrl: 'https://admin.staging.example.com' });
      expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /open navigation/i })).not.toBeInTheDocument();
      const links = screen.getAllByRole('link', { name: 'Open Admin app' });
      expect(links).toHaveLength(1);
      expect(links[0]).toHaveAttribute('href', 'https://admin.staging.example.com');
      expect(screen.getByRole('main')).toContainElement(screen.getByText('page content'));
      expect(screen.queryByRole('status', { name: 'View-as session active' })).not.toBeInTheDocument();
      expect(global.fetch).not.toHaveBeenCalled();
    },
  );

  it('keeps the layout-provided identity controls in the header', () => {
    renderFrame({ identity: { email: 'ops@repworth.com', aal2: true } });
    expect(screen.getByRole('banner')).toHaveTextContent('ops@repworth.com');
    expect(screen.getByRole('banner')).toHaveTextContent('Step-up verified (AAL2)');
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('keeps the live-session banner and End button above the page inside main', () => {
    renderFrame({
      impersonation: { sessionId: 'sess-1', expiresAt: '2026-09-02T12:45:00.000Z', accountLabel: 'Bella Italia' },
    });
    const banner = screen.getByRole('status', { name: 'View-as session active' });
    expect(screen.getByRole('main')).toContainElement(banner);
    expect(banner.compareDocumentPosition(screen.getByText('page content')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('button', { name: /end session/i })).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
