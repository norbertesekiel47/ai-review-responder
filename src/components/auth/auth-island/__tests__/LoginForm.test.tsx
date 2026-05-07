import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// next/navigation hooks throw outside an app/ router context. Stub them so
// LoginForm can be rendered with renderToStaticMarkup.
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
const { LoginForm } = await import('../LoginForm');

describe('LoginForm', () => {
  it('renders email + password fields and Continue with Google', () => {
    const html = renderToStaticMarkup(
      createElement(LoginForm, { initialEmail: '' }),
    );
    expect(html.toLowerCase()).toContain('autocomplete="email"');
    expect(html.toLowerCase()).toContain('autocomplete="current-password"');
    expect(html).toContain('Continue with Google');
    expect(html).toContain('Forgot password?');
    expect(html).toContain('Keep me signed in');
  });
  it('pre-fills the email input from initialEmail', () => {
    const html = renderToStaticMarkup(
      createElement(LoginForm, { initialEmail: 'a@b.co' }),
    );
    expect(html).toContain('value="a@b.co"');
  });
});
