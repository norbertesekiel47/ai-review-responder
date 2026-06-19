import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SiteShell } from '../SiteShell';

describe('SiteShell', () => {
  it('wraps children in the scoped island with nav, footer and marquee', () => {
    const html = renderToStaticMarkup(
      createElement(
        SiteShell,
        { scope: 'rw-test-scope' },
        createElement('p', null, 'INNER_CONTENT'),
      ),
    );

    expect(html).toContain('class="rw-test-scope"');
    expect(html).toContain('rw-marquee');
    expect(html).toContain('<div class="rw-island">');
    expect(html).toContain('<nav');
    expect(html).toContain('INNER_CONTENT');
    expect(html).toContain('class="rw-foot"');
  });

  it('renders the island as <main> when islandAs="main"', () => {
    const html = renderToStaticMarkup(
      createElement(
        SiteShell,
        { scope: 'rw-test-scope', islandAs: 'main' },
        createElement('p', null, 'INNER_CONTENT'),
      ),
    );

    expect(html).toContain('<main class="rw-island">');
  });

  it('renders the overlay between the marquee and the island', () => {
    const html = renderToStaticMarkup(
      createElement(
        SiteShell,
        { scope: 'rw-test-scope', overlay: createElement('nav', { className: 'test-overlay' }) },
        createElement('p', null, 'INNER_CONTENT'),
      ),
    );

    expect(html).toContain('class="test-overlay"');
    expect(html.indexOf('test-overlay')).toBeLessThan(html.indexOf('rw-island-wrap'));
  });
});
