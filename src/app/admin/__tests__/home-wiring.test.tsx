// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdminLayout from '../layout';
import AdminLoginPage from '../login/page';
import AdminError from '../error';
import AdminImpersonationViewPage from '../impersonate/[sessionId]/view/page';

const { loadShell, resolveView, loadLocations } = vi.hoisted(() => ({
  loadShell: vi.fn(),
  resolveView: vi.fn(),
  loadLocations: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [] }),
}));
vi.mock('next/navigation', () => ({
  redirect: (path: string) => { throw new Error(path); },
  notFound: () => { throw new Error('not-found'); },
}));
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: 'fixture-admin' } } }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({
          data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null,
        }),
      },
    },
  }),
}));
vi.mock('@/lib/db/server', () => ({ sql: vi.fn() }));
vi.mock('@/lib/admin/shell-context', () => ({ loadAdminShellContext: loadShell }));
vi.mock('@/lib/admin/impersonation/view', () => ({
  resolveImpersonationViewSession: resolveView,
  loadImpersonationAccountLocations: loadLocations,
}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('../providers', () => ({
  AdminProviders: ({ children }: { children: ReactNode }) => children,
}));
// The actual server components compose these boundaries. Their own suites
// cover navigation; these stubs make a missing/wrong server prop observable.
vi.mock('@/components/admin/AdminShellFrame', () => ({
  AdminShellFrame: ({ adminAppUrl, children }: { adminAppUrl: string; children: ReactNode }) => (
    <div><a href={adminAppUrl}>Shell home</a>{children}</div>
  ),
}));
vi.mock('@/components/auth/LoginFormClient', () => ({
  LoginFormClient: ({ defaultRoute, portal }: { defaultRoute: string; portal: string }) => (
    <a href={defaultRoute} data-portal={portal}>Login default</a>
  ),
}));
vi.mock('@/components/admin/EndImpersonationButton', () => ({
  EndImpersonationButton: ({ adminAppUrl }: { adminAppUrl: string }) => (
    <a href={adminAppUrl}>End-session destination</a>
  ),
}));
vi.mock('@/components/admin/ui/AdminPage', () => ({
  AdminPage: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../impersonate/[sessionId]/view/ImpersonationLocationsTable', () => ({
  ImpersonationLocationsTable: () => null,
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('MFA_ENFORCEMENT_ENABLED', 'true');
  loadShell.mockResolvedValue({ identity: null, impersonation: null });
  loadLocations.mockResolvedValue([]);
  resolveView.mockResolvedValue({
    status: 'ok',
    admin: { id: 'fixture-admin', email: 'admin@example.invalid' },
    session: {
      accountId: 'fixture-account', accountDisplayName: 'Fixture account',
      expiresAt: new Date('2026-09-11T12:00:00Z'),
      impersonatedEmail: 'owner@example.invalid', impersonatedUserId: 'fixture-owner',
      ticketId: 'fixture-ticket', reason: 'Fixture support context',
    },
  });
});
afterEach(() => vi.unstubAllEnvs());

describe.each(['https://configured-admin.example', 'http://localhost:4102'])(
  'Admin server wiring for %s',
  (destination) => {
    beforeEach(() => vi.stubEnv('ADMIN_APP_URL', destination + '/'));

    it('passes the configured home through the real server layout', async () => {
      render(await AdminLayout({ children: <p>Page body</p> }));
      expect(screen.getByRole('link', { name: 'Shell home' })).toHaveAttribute('href', destination);
      expect(screen.getByText('Page body')).toBeInTheDocument();
      expect(loadShell).toHaveBeenCalledOnce();
    });

    it('passes the configured default from the real Admin login page', () => {
      render(<AdminLoginPage />);
      const link = screen.getByRole('link', { name: 'Login default' });
      expect(link).toHaveAttribute('href', destination);
      expect(link).toHaveAttribute('data-portal', 'admin');
    });

    it('passes the configured home to the view page end-session button', async () => {
      render(await AdminImpersonationViewPage({
        params: Promise.resolve({ sessionId: 'fixture-session' }),
      }));
      expect(screen.getByRole('link', { name: 'End-session destination' }))
        .toHaveAttribute('href', destination);
      expect(resolveView).toHaveBeenCalledWith(expect.anything(), {
        routeSessionId: 'fixture-session',
        signedCookieValue: null,
        authUserId: 'fixture-admin',
        isAal2: true,
      });
    });
  },
);

it('keeps the real error boundary recovery link local even without Admin configuration', () => {
  vi.stubEnv('ADMIN_APP_URL', undefined);
  render(<AdminError error={new Error('Fixture failure')} reset={vi.fn()} />);
  expect(screen.getByRole('link', { name: 'Back to support access' }))
    .toHaveAttribute('href', '/admin/impersonate');
});
