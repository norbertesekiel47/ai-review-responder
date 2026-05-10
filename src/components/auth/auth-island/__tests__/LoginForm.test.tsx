import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  useGoogleOAuth: vi.fn(() => ({
    start: vi.fn(),
    loading: false,
    error: '',
  })),
}));

// next/navigation hooks throw outside an app/ router context. Stub them so
// LoginForm can be rendered with renderToStaticMarkup. We re-read
// `mockSearchParams` on each call so tests can swap query params per case.
let mockSearchParams = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
  useRouter: () => ({
    push: () => {},
    replace: () => {},
    refresh: () => {},
    back: () => {},
    forward: () => {},
    prefetch: () => {},
  }),
}));

vi.mock('@/components/auth/hooks/useGoogleOAuth', () => ({
  useGoogleOAuth: mocks.useGoogleOAuth,
}));

// Imported after vi.mock so the mock is in place when the module loads.
const { LoginForm } = await import('../LoginForm');

describe('LoginForm', () => {
  it('renders email + password fields and Continue with Google', () => {
    mockSearchParams = new URLSearchParams();
    const html = renderToStaticMarkup(createElement(LoginForm));
    expect(html.toLowerCase()).toContain('autocomplete="email"');
    expect(html.toLowerCase()).toContain('autocomplete="current-password"');
    expect(html).toContain('Continue with Google');
    expect(html).toContain('Forgot password?');
    expect(html).not.toContain('Keep me signed in');
  });
  it('pre-fills the email input from the ?email query param', () => {
    mockSearchParams = new URLSearchParams('email=a%40b.co');
    const html = renderToStaticMarkup(createElement(LoginForm));
    expect(html).toContain('value="a@b.co"');
  });

  it('routes Google login through signup finish so new Google users can be provisioned', () => {
    mockSearchParams = new URLSearchParams();
    mocks.useGoogleOAuth.mockClear();
    renderToStaticMarkup(createElement(LoginForm));
    expect(mocks.useGoogleOAuth).toHaveBeenCalledWith({
      flow: 'owner',
      next: '/signup/finish',
    });
  });
});
