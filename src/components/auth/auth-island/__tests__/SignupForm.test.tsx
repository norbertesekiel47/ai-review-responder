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
    expect(html).toContain('href="/legal/terms"');
    expect(html).toContain('href="/legal/privacy"');
    expect(html).toContain('Sign up with Google');
  });
  it('marks the submit CTA aria-disabled on first render (Terms unchecked) but keeps it clickable to surface the hint', () => {
    const html = renderToStaticMarkup(createElement(SignupForm));
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*aria-disabled="true"/);
    // It must NOT be hard-disabled, or the onSubmit hint could never fire.
    expect(html).not.toMatch(/<button[^>]*type="submit"[^>]*\sdisabled/);
  });
  it('renders the four strength bars', () => {
    const html = renderToStaticMarkup(createElement(SignupForm));
    const matches = html.match(/rw-strength-bar/g) ?? [];
    expect(matches).toHaveLength(4);
  });
  it('renders the password requirements list before submit', () => {
    const html = renderToStaticMarkup(createElement(SignupForm));
    expect(html).toContain('rw-req-list');
    expect(html).toContain('At least 8 characters');
    expect(html).toContain('Upper &amp; lowercase letters');
    expect(html).toContain('A number');
  });
});
