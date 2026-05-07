import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// next/navigation hooks throw outside an app/ router context. Stub them so
// LoginFormInner can be rendered with renderToStaticMarkup. We render the
// inner component directly because the public LoginFormClient wraps it in a
// Suspense boundary that, without a real router, only emits the fallback.
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({
    push: () => {},
    replace: () => {},
    refresh: () => {},
    back: () => {},
    forward: () => {},
    prefetch: () => {},
  }),
}));

// Imported after vi.mock so the mock is in place when the module loads.
const { LoginFormInner } = await import('../LoginFormClient');

describe('LoginFormClient (admin)', () => {
  it('does not render the Google button when showGoogleButton is false', () => {
    const html = renderToStaticMarkup(
      createElement(LoginFormInner, {
        portal: 'admin',
        brandName: 'RepWorth Admin',
        showGoogleButton: false,
        defaultRoute: '/admin/overview',
        allowedRoles: ['admin', 'sales_partner'] as const,
      }),
    );
    expect(html).toContain('RepWorth Admin');
    expect(html).not.toContain('Continue with Google');
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
});
