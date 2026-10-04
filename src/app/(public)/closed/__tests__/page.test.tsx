// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) =>
    createElement('a', { href, ...props }, children),
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/closed' }));

const { default: ClosedPage, metadata } = await import('../page');

describe('/closed notice', () => {
  const html = renderToStaticMarkup(createElement(ClosedPage));

  it('renders in the Island chrome with one main landmark and one h1', () => {
    expect(html).toContain('class="rw-closed-page"');
    expect(html).toContain('<div class="rw-island">');
    expect(html.match(/<main /g)).toHaveLength(1);
    expect(html).toContain('id="main-content"');
    expect(html.match(/<h1[ >]/g)).toHaveLength(1);
    expect(html).toContain('RepWorth has closed.');
  });

  it('routes data-access and deletion requests to the support mailbox', () => {
    expect(html).toContain('href="mailto:support@repworth.net"');
    expect(html).toMatch(/copy of your data, or for its deletion/);
  });

  it('says existing customers were contacted, and offers no form and no signup door', () => {
    expect(html).toContain('We contacted every existing customer directly before the shutdown.');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('href="/signup"');
    expect(html).not.toContain('href="/login"');
    expect(html).not.toContain('href="/book-a-demo"');
  });

  it('carries its own title and stays indexable', () => {
    expect(metadata.title).toBe('Service closed');
    expect(metadata.robots).toBeUndefined();
  });
});
