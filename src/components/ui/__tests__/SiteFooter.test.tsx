import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SiteFooter } from '../SiteFooter';
import { NAV_LINKS, PRODUCT_BLURB } from '../marketing-links';
import { BLURB as LANDING_FOOTER_BLURB } from '@/components/sections/landing/footer/footer-copy';

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

  it('lists the Product column in the header-nav order', () => {
    const html = renderToStaticMarkup(createElement(SiteFooter));
    const product = html.slice(html.indexOf('aria-label="Product"'), html.indexOf('aria-label="Legal"'));
    const hrefs = [...product.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(NAV_LINKS.map((link) => link.href));
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

  it('renders the Daylight chrome layout: brand + blurb + hairline copyright row', () => {
    const html = renderToStaticMarkup(createElement(SiteFooter));

    expect(html).toContain('rw-foot-dl');
    expect(html).toContain('rw-foot-brand');
    expect(html).toContain('the gate you control');
    expect(html).toContain('rw-foot-copy');
  });

  it('describes the product with the same sentence as the landing footer, in the chrome noun', () => {
    const html = renderToStaticMarkup(createElement(SiteFooter));
    expect(html).toContain(PRODUCT_BLURB);
    expect(LANDING_FOOTER_BLURB).toBe(PRODUCT_BLURB);
    // "Fleet" is landing voice; the chrome says "team".
    expect(PRODUCT_BLURB).not.toMatch(/fleet/i);
    expect(PRODUCT_BLURB).toMatch(/team of AI agents/);
  });

  it('uses no legacy teal utilities or raw hex colours', () => {
    const html = renderToStaticMarkup(createElement(SiteFooter));
    // Daylight chrome: colour comes from the .rw-foot-dl classes (ink2 tokens
    // in island.css), never Tailwind teal utilities or literals.
    expect(html).not.toMatch(/text-rw-teal|bg-rw-teal|#[0-9a-fA-F]{6}/);
  });
});
