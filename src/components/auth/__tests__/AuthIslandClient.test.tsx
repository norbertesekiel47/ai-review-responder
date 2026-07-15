import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

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

const { AuthIslandClient } = await import('../auth-island/AuthIslandClient');

describe('AuthIslandClient', () => {
  it('renders Sign in heading when initialMode is login', () => {
    const html = renderToStaticMarkup(
      createElement(AuthIslandClient, { initialMode: 'login' }),
    );
    expect(html).toContain('Sign in to RepWorth');
    expect(html).toContain('Pick up where you left off.');
  });
  it('renders Create account heading when initialMode is signup', () => {
    const html = renderToStaticMarkup(
      createElement(AuthIslandClient, { initialMode: 'signup' }),
    );
    expect(html).toContain('Create your account');
    expect(html).toContain('Create your account, then choose your monthly plan explicitly.');
    expect(html).not.toContain('14 days');
    expect(html).not.toContain('No credit card');
  });
});
