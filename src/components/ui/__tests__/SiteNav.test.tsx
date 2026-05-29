// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SiteNav } from '../SiteNav';

// Render Next's Link as a plain anchor so these tests don't need an App Router
// context (matches the pattern in DemoStatusIsland.test.tsx).
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) =>
    createElement('a', { href, ...props }, children),
}));

const MENU_ID = 'site-nav-mobile-menu';

describe('SiteNav', () => {
  describe('owner auth links', () => {
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

  describe('mobile hamburger', () => {
    it('renders a closed, accessible toggle button by default', () => {
      const html = renderToStaticMarkup(createElement(SiteNav));
      expect(html).toContain('type="button"');
      expect(html).toContain('aria-expanded="false"');
      expect(html).toContain(`aria-controls="${MENU_ID}"`);
      expect(html).toContain('aria-label="Open menu"');
      // Panel is not rendered while closed.
      expect(html).not.toContain(`id="${MENU_ID}"`);
    });

    it('opens the menu and reveals the nav links on click', async () => {
      const user = userEvent.setup();
      const { container } = render(createElement(SiteNav));

      const toggle = screen.getByRole('button', { name: 'Open menu' });
      expect(toggle).toHaveAttribute('aria-expanded', 'false');

      await user.click(toggle);

      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      expect(toggle).toHaveAttribute('aria-label', 'Close menu');

      const panel = container.querySelector(`#${MENU_ID}`) as HTMLElement;
      expect(panel).not.toBeNull();
      const menu = within(panel);
      expect(menu.getByRole('link', { name: 'Features' })).toBeInTheDocument();
      expect(menu.getByRole('link', { name: 'How it works' })).toBeInTheDocument();
      expect(menu.getByRole('link', { name: 'Pricing' })).toBeInTheDocument();
    });

    it('includes auth links in the menu when self-serve is enabled', async () => {
      const user = userEvent.setup();
      const { container } = render(createElement(SiteNav, { selfServeEnabled: true }));

      await user.click(screen.getByRole('button', { name: 'Open menu' }));

      const panel = container.querySelector(`#${MENU_ID}`) as HTMLElement;
      expect(within(panel).getByRole('link', { name: 'Log in' })).toBeInTheDocument();
      expect(within(panel).getByRole('link', { name: 'Sign up' })).toBeInTheDocument();
    });

    it('omits auth links from the menu when self-serve is disabled', async () => {
      const user = userEvent.setup();
      const { container } = render(createElement(SiteNav, { selfServeEnabled: false }));

      await user.click(screen.getByRole('button', { name: 'Open menu' }));

      const panel = container.querySelector(`#${MENU_ID}`) as HTMLElement;
      expect(within(panel).queryByRole('link', { name: 'Log in' })).toBeNull();
      expect(within(panel).queryByRole('link', { name: 'Sign up' })).toBeNull();
    });

    it('closes the menu when a nav link is clicked', async () => {
      const user = userEvent.setup();
      const { container } = render(createElement(SiteNav));

      const toggle = screen.getByRole('button', { name: 'Open menu' });
      await user.click(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', 'true');

      const panel = container.querySelector(`#${MENU_ID}`) as HTMLElement;
      await user.click(within(panel).getByRole('link', { name: 'Pricing' }));

      expect(toggle).toHaveAttribute('aria-expanded', 'false');
    });

    it('closes the menu on Escape', async () => {
      const user = userEvent.setup();
      render(createElement(SiteNav));

      const toggle = screen.getByRole('button', { name: 'Open menu' });
      await user.click(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', 'true');

      await user.keyboard('{Escape}');

      expect(toggle).toHaveAttribute('aria-expanded', 'false');
    });

    it('applies focus-visible rings to all interactive elements', () => {
      const html = renderToStaticMarkup(createElement(SiteNav, { selfServeEnabled: true }));
      // SSR markup (panel is client-only/closed) renders 7 controls:
      // logo + 3 desktop nav links + Log in + Sign up + hamburger.
      // Uses the canonical teal outline treatment shared with PR #174 (P1 #18).
      const occurrences = (html.match(/focus-visible:outline-\[#97B3AE\]/g) || []).length;
      expect(occurrences).toBe(7);
    });

    it('suppresses auth links when comingSoon overrides self-serve', () => {
      const html = renderToStaticMarkup(
        createElement(SiteNav, { selfServeEnabled: true, comingSoon: true }),
      );
      expect(html).not.toContain('href="/login"');
      expect(html).not.toContain('href="/signup"');
    });
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
