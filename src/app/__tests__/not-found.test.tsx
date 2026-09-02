// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The root 404 is a server component reading two server-authoritative flags;
// stub them so each posture renders deterministically.
const { mockSelfServe, mockTrial } = vi.hoisted(() => ({
  mockSelfServe: vi.fn<() => boolean>(() => false),
  mockTrial: vi.fn<() => boolean>(() => false),
}));
vi.mock('@/lib/auth/flags', () => ({ selfServeSignupEnabled: () => mockSelfServe() }));
vi.mock('@/lib/payments/flags', () => ({ trialEnabled: () => mockTrial() }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) =>
    createElement('a', { href, ...props }, children),
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/does-not-exist' }));

const { default: NotFound } = await import('../not-found');

describe('root NotFound', () => {
  beforeEach(() => {
    mockSelfServe.mockReturnValue(false);
    mockTrial.mockReturnValue(false);
  });

  it('renders the Island chrome: SiteShell island, SiteNav, one main landmark, SiteFooter', () => {
    const html = renderToStaticMarkup(createElement(NotFound));
    expect(html).toContain('class="rw-not-found"');
    expect(html).toContain('<div class="rw-island">');
    expect(html).toContain('<header aria-label="Primary"');
    expect(html.match(/<main /g)).toHaveLength(1);
    expect(html).toContain('id="main-content"');
    expect(html).toMatch(/<\/main><footer class="rw-foot rw-foot-dl"/);
    expect(html).toContain('href="/legal/privacy"');
  });

  it('uses the actionable teal, never the decorative one, for text and fills', () => {
    const html = renderToStaticMarkup(createElement(NotFound));
    expect(html).toContain('text-rw-teal-strong');
    expect(html).toContain('bg-rw-teal-strong');
    expect(html).not.toMatch(/(text|bg|border)-rw-teal["\s/]/);
    expect(html).not.toMatch(/#[0-9a-fA-F]{6}/);
  });

  it('offers home and contact, and no dashboard link to an anonymous visitor', () => {
    const html = renderToStaticMarkup(createElement(NotFound));
    expect(html).toContain('Page not found');
    expect(html).toMatch(/href="\/"[^>]*>Back to home</);
    expect(html).toContain('href="/help/contact"');
    expect(html).not.toContain('href="/dashboard"');
    expect(html).not.toContain('Go to dashboard');
    // Self-serve off: the nav's door is the early-access pill.
    expect(html).toContain('Get early access');
  });

  it('threads the flags into the nav so it offers the owner-auth pair when self-serve is on', () => {
    mockSelfServe.mockReturnValue(true);
    mockTrial.mockReturnValue(true);
    const html = renderToStaticMarkup(createElement(NotFound));
    expect(html).toContain('href="/login"');
    expect(html).toContain('Start free trial');
    expect(html).not.toContain('Get early access');
  });
});
