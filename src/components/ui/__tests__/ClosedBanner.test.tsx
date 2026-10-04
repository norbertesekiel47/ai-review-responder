// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClosedBanner } from '../ClosedBanner';

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) =>
    createElement('a', { href, ...props }, children),
}));

let mockPathname: string | null = '/';
vi.mock('next/navigation', () => ({ usePathname: () => mockPathname }));

afterEach(() => {
  mockPathname = '/';
});

describe('ClosedBanner', () => {
  it('names the closure and links to the /closed notice on a marketing page', () => {
    mockPathname = '/pricing';
    const html = renderToStaticMarkup(createElement(ClosedBanner));
    expect(html).toContain('<aside aria-label="Service notice"');
    expect(html).toContain('RepWorth has closed and is no longer taking sign-ups.');
    expect(html).toMatch(/href="\/closed"[^>]*>Read the notice</);
  });

  it('renders on the landing page too', () => {
    const html = renderToStaticMarkup(createElement(ClosedBanner));
    expect(html).toContain('href="/closed"');
  });

  it('renders nothing on /closed, where it would link to the page being read', () => {
    mockPathname = '/closed';
    expect(renderToStaticMarkup(createElement(ClosedBanner))).toBe('');
  });

  it('uses tokens, never hex literals', () => {
    const html = renderToStaticMarkup(createElement(ClosedBanner));
    expect(html).toContain('bg-rw-ink2');
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
  });
});
