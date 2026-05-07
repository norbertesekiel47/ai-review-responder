import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: () => {},
    replace: () => {},
    refresh: () => {},
    back: () => {},
    forward: () => {},
    prefetch: () => {},
  }),
}));

const { SignupForm } = await import('../SignupForm');

describe('SignupForm', () => {
  it('renders the four required fields and Terms link', () => {
    const html = renderToStaticMarkup(createElement(SignupForm));
    expect(html).toContain('Your name');
    expect(html).toContain('Phone (optional)');
    expect(html).toContain('Work email');
    expect(html).toContain('Create a password');
    expect(html).toContain('href="/terms"');
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('Sign up with Google');
  });
  it('disables the submit CTA on first render (Terms unchecked)', () => {
    const html = renderToStaticMarkup(createElement(SignupForm));
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
  });
  it('renders the four strength bars', () => {
    const html = renderToStaticMarkup(createElement(SignupForm));
    const matches = html.match(/rw-strength-bar/g) ?? [];
    expect(matches).toHaveLength(4);
  });
});
