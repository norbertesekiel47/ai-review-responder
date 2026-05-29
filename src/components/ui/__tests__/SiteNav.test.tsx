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

  it('gives nav links a teal focus-visible ring', () => {
    const html = renderToStaticMarkup(createElement(SiteNav));
    expect(html).toContain('focus-visible:outline-[#97B3AE]');
  });

  it('gives the owner-auth links a focus-visible ring when shown', () => {
    const html = renderToStaticMarkup(createElement(SiteNav, { selfServeEnabled: true }));
    // Both the Log in and Sign up links carry the teal focus ring.
    const ringCount = html.split('focus-visible:outline-[#97B3AE]').length - 1;
    // 3 nav links + Log in + Sign up = 5 ring occurrences.
    expect(ringCount).toBeGreaterThanOrEqual(5);
  });
});
