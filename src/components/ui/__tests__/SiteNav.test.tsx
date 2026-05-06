import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SiteNav } from '../SiteNav';

describe('SiteNav', () => {
  it('hides owner auth links by default', () => {
    const html = renderToStaticMarkup(createElement(SiteNav));

    expect(html).not.toContain('href="/login"');
    expect(html).not.toContain('href="/signup"');
    expect(html).not.toContain('Log in');
    expect(html).not.toContain('Sign up');
  });

  it('hides owner auth links when self-serve signup is disabled', () => {
    const html = renderToStaticMarkup(createElement(SiteNav, { selfServeEnabled: false }));

    expect(html).not.toContain('href="/login"');
    expect(html).not.toContain('href="/signup"');
    expect(html).not.toContain('Log in');
    expect(html).not.toContain('Sign up');
  });

  it('shows owner auth links when self-serve signup is enabled', () => {
    const html = renderToStaticMarkup(createElement(SiteNav, { selfServeEnabled: true }));

    expect(html).toContain('href="/login"');
    expect(html).toContain('href="/signup"');
    expect(html).toContain('Log in');
    expect(html).toContain('Sign up');
  });
});
