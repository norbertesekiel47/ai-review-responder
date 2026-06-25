import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SiteFooter } from '../SiteFooter';

describe('SiteFooter', () => {
  it('renders the self-contained rw-foot footer with the dynamic copyright', () => {
    const html = renderToStaticMarkup(createElement(SiteFooter));

    expect(html).toContain('class="rw-foot');
    expect(html).toContain('RepWorth. All rights reserved.');
    expect(html).toContain(String(new Date().getFullYear()));
  });

  it('renders the Product column links', () => {
    const html = renderToStaticMarkup(createElement(SiteFooter));

    expect(html).toContain('aria-label="Product"');
    expect(html).toContain('href="/features"');
    expect(html).toContain('href="/pricing"');
    expect(html).toContain('href="/how-it-works"');
  });

  it('renders the full Legal column links', () => {
    const html = renderToStaticMarkup(createElement(SiteFooter));

    expect(html).toContain('aria-label="Legal"');
    expect(html).toContain('href="/legal/privacy"');
    expect(html).toContain('href="/legal/terms"');
    expect(html).toContain('href="/security"');
    expect(html).toContain('href="/legal/sub-processors"');
    expect(html).toContain('href="/legal/cookies"');
    expect(html).toContain('href="/legal/aup"');
  });

  it('renders the Company column with the contact link', () => {
    const html = renderToStaticMarkup(createElement(SiteFooter));

    expect(html).toContain('aria-label="Company"');
    expect(html).toContain('href="/help/contact"');
  });

  it('uses the accessible-contrast text token for footer links (ADR 0004)', () => {
    const html = renderToStaticMarkup(createElement(SiteFooter));

    expect(html).toContain('text-rw-teal-strong');
    // boundary match: text-rw-teal-strong contains "text-rw-teal".
    expect(html).not.toMatch(/text-rw-teal(?![-\w])/);
  });
});
