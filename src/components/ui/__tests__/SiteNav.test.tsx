// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SiteNav } from '../SiteNav';

const islandCss = readFileSync(
  resolve(process.cwd(), 'src/app/(public)/_styles/island.css'),
  'utf-8',
);

// Render Next's Link as a plain anchor so these tests don't need an App Router
// context (matches the pattern in DemoStatusIsland.test.tsx).
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) =>
    createElement('a', { href, ...props }, children),
}));

// usePathname needs an App Router context; mock it so the active-link logic is
// deterministic. mockPathname is reassigned per-test.
let mockPathname: string | null = '/';
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}));

afterEach(() => {
  mockPathname = '/';
});

const MENU_ID = 'site-nav-mobile-menu';

describe('SiteNav', () => {
  describe('owner auth links', () => {
    it('hides owner auth links by default', () => {
      const html = renderToStaticMarkup(createElement(SiteNav));
      expect(html).not.toContain('href="/login"');
      expect(html).not.toContain('href="/signup"');
      expect(html).not.toContain('Log in');
      expect(html).not.toContain('Start free trial');
    });

    it('hides owner auth links when self-serve signup is disabled', () => {
      const html = renderToStaticMarkup(createElement(SiteNav, { selfServeEnabled: false }));
      expect(html).not.toContain('href="/login"');
      expect(html).not.toContain('href="/signup"');
      expect(html).not.toContain('Log in');
      expect(html).not.toContain('Start free trial');
    });

    it('shows owner auth links when self-serve signup is enabled', () => {
      const html = renderToStaticMarkup(
        createElement(SiteNav, { selfServeEnabled: true, trialEnabled: true }),
      );
      expect(html).toContain('href="/login"');
      expect(html).toContain('href="/signup"');
      expect(html).toContain('Log in');
      expect(html).toContain('Start free trial');
    });

    it('drops the trial claim from the CTA label when the trial flag is off', () => {
      const html = renderToStaticMarkup(createElement(SiteNav, { selfServeEnabled: true }));
      expect(html).toContain('Create account');
      expect(html).not.toContain('Start free trial');
    });
  });

  describe('landmark + active page', () => {
    it('wraps the nav in a header labelled "Primary"', () => {
      const html = renderToStaticMarkup(createElement(SiteNav));
      expect(html).toContain('<header aria-label="Primary"');
      expect(html).toContain('rw-navwrap');
      expect(html).toContain('<nav');
    });

    it('marks the matching nav link with aria-current="page" and an active style', () => {
      mockPathname = '/features';
      const html = renderToStaticMarkup(createElement(SiteNav));
      // The Features link is active.
      expect(html).toMatch(/href="\/features"[^>]*aria-current="page"/);
      expect(html).toMatch(/href="\/features"[^>]*class="is-active"/);
      // Pricing is not active.
      expect(html).not.toMatch(/href="\/pricing"[^>]*aria-current="page"/);
    });

    it('treats descendant routes as active (e.g. /features/x)', () => {
      mockPathname = '/how-it-works/detail';
      const html = renderToStaticMarkup(createElement(SiteNav));
      expect(html).toMatch(/href="\/how-it-works"[^>]*aria-current="page"/);
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

    it('gives the toggle a >=44px touch target via its chrome class', () => {
      const html = renderToStaticMarkup(createElement(SiteNav));
      expect(html).toContain('rw-nav-toggle');
      expect(islandCss).toMatch(/\.rw-nav-toggle \{[\s\S]{0,200}?width: 44px;[\s\S]{0,200}?height: 44px;/);
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

    it('moves focus to the first menu link on open', async () => {
      const user = userEvent.setup();
      const { container } = render(createElement(SiteNav));

      await user.click(screen.getByRole('button', { name: 'Open menu' }));

      const panel = container.querySelector(`#${MENU_ID}`) as HTMLElement;
      const firstLink = within(panel).getByRole('link', { name: 'Features' });
      expect(firstLink).toHaveFocus();
    });

    it('restores focus to the toggle when closed via Escape', async () => {
      const user = userEvent.setup();
      render(createElement(SiteNav));

      const toggle = screen.getByRole('button', { name: 'Open menu' });
      await user.click(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', 'true');

      await user.keyboard('{Escape}');

      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(toggle).toHaveFocus();
    });

    it('includes auth links in the menu when self-serve is enabled', async () => {
      const user = userEvent.setup();
      const { container } = render(
        createElement(SiteNav, { selfServeEnabled: true, trialEnabled: true }),
      );

      await user.click(screen.getByRole('button', { name: 'Open menu' }));

      const panel = container.querySelector(`#${MENU_ID}`) as HTMLElement;
      expect(within(panel).getByRole('link', { name: 'Log in' })).toBeInTheDocument();
      expect(within(panel).getByRole('link', { name: 'Start free trial' })).toBeInTheDocument();
    });

    it('omits auth links from the menu when self-serve is disabled', async () => {
      const user = userEvent.setup();
      const { container } = render(createElement(SiteNav, { selfServeEnabled: false }));

      await user.click(screen.getByRole('button', { name: 'Open menu' }));

      const panel = container.querySelector(`#${MENU_ID}`) as HTMLElement;
      expect(within(panel).queryByRole('link', { name: 'Log in' })).toBeNull();
      expect(within(panel).queryByRole('link', { name: 'Start free trial' })).toBeNull();
    });

    it('closes the menu and restores focus when a nav link is clicked', async () => {
      const user = userEvent.setup();
      const { container } = render(createElement(SiteNav));

      const toggle = screen.getByRole('button', { name: 'Open menu' });
      await user.click(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', 'true');

      const panel = container.querySelector(`#${MENU_ID}`) as HTMLElement;
      await user.click(within(panel).getByRole('link', { name: 'Pricing' }));

      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(toggle).toHaveFocus();
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

    it('covers every nav control with the chrome focus-visible rule', () => {
      // Daylight chrome: one `.rw-navwrap :focus-visible` rule in island.css
      // gives all nav controls (logo, links, Log in, the CTA pill, hamburger)
      // the forest outline — no per-element Tailwind ring utilities.
      expect(islandCss).toMatch(/\.rw-navwrap :focus-visible[\s\S]{0,120}?outline: 2px solid var\(--rw-forest\)/);
      const html = renderToStaticMarkup(createElement(SiteNav, { selfServeEnabled: true }));
      expect(html).toContain('rw-navwrap');
    });

    it('suppresses auth links when comingSoon overrides self-serve', () => {
      const html = renderToStaticMarkup(
        createElement(SiteNav, { selfServeEnabled: true, comingSoon: true }),
      );
      expect(html).not.toContain('href="/login"');
      expect(html).not.toContain('href="/signup"');
    });
  });

  it('renders the CTA pill in the action colour with the arrow disc', () => {
    const html = renderToStaticMarkup(
      createElement(SiteNav, { selfServeEnabled: true, trialEnabled: true }),
    );
    expect(html).toMatch(/href="\/signup"[^>]*class="rw-pill rw-pill-forest"/);
    expect(html).toContain('rw-pill-circ');
  });

  it('uses no legacy teal utilities or raw hex colours', () => {
    const html = renderToStaticMarkup(createElement(SiteNav, { selfServeEnabled: true }));
    // Daylight chrome: colour comes from the .rw-nav* classes (ink2 / forest
    // tokens in island.css), never Tailwind teal utilities or literals.
    expect(html).not.toMatch(/text-rw-teal|bg-rw-teal|#[0-9a-fA-F]{6}/);
  });
});
