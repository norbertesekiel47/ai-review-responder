// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const {
  mockMaybeSingle,
  mockSignInWithPassword,
  mockSignOut,
  mockGetAuthenticatorAssuranceLevel,
  routerPush,
  routerRefresh,
} = vi.hoisted(() => ({
  mockMaybeSingle: vi.fn(),
  mockSignInWithPassword: vi.fn(),
  mockSignOut: vi.fn(),
  mockGetAuthenticatorAssuranceLevel: vi.fn(),
  routerPush: vi.fn(),
  routerRefresh: vi.fn(),
}));

// next/navigation hooks throw outside an app/ router context. Stub them so
// LoginFormInner can be rendered with renderToStaticMarkup. We render the
// inner component directly because the public LoginFormClient wraps it in a
// Suspense boundary that, without a real router, only emits the fallback.
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({
    push: routerPush,
    replace: () => {},
    refresh: routerRefresh,
    back: () => {},
    forward: () => {},
    prefetch: () => {},
  }),
}));

vi.mock('@/lib/db/browser', () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      signInWithPassword: mockSignInWithPassword,
      signOut: mockSignOut,
      mfa: {
        getAuthenticatorAssuranceLevel: mockGetAuthenticatorAssuranceLevel,
      },
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          limit: () => ({
            maybeSingle: mockMaybeSingle,
          }),
        }),
      }),
    }),
  }),
}));

// Imported after vi.mock so the mock is in place when the module loads.
const { LoginFormInner } = await import('../LoginFormClient');

describe('LoginFormClient (admin)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSignInWithPassword.mockResolvedValue({
      data: { user: { id: 'auth-sales' } },
      error: null,
    });
    mockMaybeSingle.mockResolvedValue({
      data: { role: 'sales_partner' },
      error: null,
    });
    mockSignOut.mockResolvedValue({ error: null });
    mockGetAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: 'aal1', nextLevel: 'aal1' },
      error: null,
    });
  });

  it('does not render the Google button when showGoogleButton is false', () => {
    const html = renderToStaticMarkup(
      createElement(LoginFormInner, {
        portal: 'admin',
        brandName: 'RepWorth Admin',
        showGoogleButton: false,
        defaultRoute: '/admin/overview',
        allowedRoles: ['admin'] as const,
      }),
    );
    expect(html).toContain('RepWorth Admin');
    expect(html).not.toContain('Continue with Google');
  });

  it('signs out sales_partner password login and shows an unsupported-role message', async () => {
    render(
      createElement(LoginFormInner, {
        portal: 'admin',
        brandName: 'RepWorth Admin',
        showGoogleButton: false,
        defaultRoute: '/admin/overview',
        allowedRoles: ['admin'] as const,
      }),
    );

    await userEvent.type(screen.getByLabelText('Email'), 'sales@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'password123');
    await userEvent.click(screen.getByRole('button', { name: 'Sign In' }));

    await waitFor(() => {
      expect(mockSignOut).toHaveBeenCalledTimes(1);
    });
    expect(routerPush).not.toHaveBeenCalled();
    expect(screen.getByText(/no longer supported/i)).toBeInTheDocument();
  });

  it('renders the Google button when showGoogleButton is true', () => {
    const html = renderToStaticMarkup(
      createElement(LoginFormInner, {
        portal: 'owner',
        brandName: 'RepWorth',
        showGoogleButton: true,
        defaultRoute: '/dashboard',
        allowedRoles: ['owner'] as const,
      }),
    );
    expect(html).toContain('Continue with Google');
  });

  it('redirects enrolled MFA sessions to the challenge screen after password login', async () => {
    mockSignInWithPassword.mockResolvedValue({
      data: { user: { id: 'auth-admin' } },
      error: null,
    });
    mockMaybeSingle.mockResolvedValue({
      data: { role: 'admin' },
      error: null,
    });
    mockGetAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: 'aal1', nextLevel: 'aal2' },
      error: null,
    });

    render(
      createElement(LoginFormInner, {
        portal: 'admin',
        brandName: 'RepWorth Admin',
        showGoogleButton: false,
        defaultRoute: '/admin/overview',
        allowedRoles: ['admin'] as const,
      }),
    );

    await userEvent.type(screen.getByLabelText('Email'), 'admin@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'password123');
    await userEvent.click(screen.getByRole('button', { name: 'Sign In' }));

    await waitFor(() => {
      expect(routerPush).toHaveBeenCalledWith('/mfa/challenge?next=%2Fadmin%2Foverview');
    });
    expect(routerRefresh).not.toHaveBeenCalled();
  });
});
