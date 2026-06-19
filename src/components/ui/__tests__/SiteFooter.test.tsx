import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SiteFooter } from '../SiteFooter';

describe('SiteFooter', () => {
  it('renders the rw-foot footer with privacy and terms links', () => {
    const html = renderToStaticMarkup(createElement(SiteFooter));

    expect(html).toContain('class="rw-foot"');
    expect(html).toContain('RepWorth. All rights reserved.');
    expect(html).toContain('href="/legal/privacy"');
    expect(html).toContain('href="/legal/terms"');
    expect(html).toContain('Privacy');
    expect(html).toContain('Terms &amp; Conditions');
  });
});
