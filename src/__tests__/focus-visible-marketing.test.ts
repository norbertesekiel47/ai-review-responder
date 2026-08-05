import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// P1 #18: keyboard users must get a visible focus ring on the marketing
// interactive controls.
//
// Two palettes, deliberately: Island surfaces (pricing) are light, so they ring
// in the accessible strong teal. The landing page is light-on-dark (PRODUCT.md
// unlocks `/` from the Island system), where `--rw-teal-strong` (#557069) would
// be nearly invisible against the ink — it rings in `--rw-lp-accent` instead.
// Do NOT "fix" the landing rows back to the teal token; that regresses them.
const CSS = readFileSync(resolve(process.cwd(), 'src/app/globals.css'), 'utf-8');
const LANDING_CSS = readFileSync(
  resolve(process.cwd(), 'src/components/sections/landing/landing-experience.css'),
  'utf-8',
);
const HERO_CSS = readFileSync(
  resolve(process.cwd(), 'src/components/sections/landing/hero/hero.css'),
  'utf-8',
);
const FUTURE_CSS = readFileSync(
  resolve(process.cwd(), 'src/components/sections/landing/future/future.css'),
  'utf-8',
);
const CTA_CSS = readFileSync(
  resolve(process.cwd(), 'src/components/sections/landing/cta/cta.css'),
  'utf-8',
);
const FOOTER_CSS = readFileSync(
  resolve(process.cwd(), 'src/components/sections/landing/footer/footer.css'),
  'utf-8',
);
const SCROLL_CSS = readFileSync(
  resolve(process.cwd(), 'src/components/sections/landing/scroll/scroll-experience.css'),
  'utf-8',
);
const FLEET_CSS = readFileSync(
  resolve(process.cwd(), 'src/components/sections/landing/fleet/fleet.css'),
  'utf-8',
);
const LIGHTBOX_CSS = readFileSync(
  resolve(process.cwd(), 'src/components/sections/landing/fleet/video-lightbox.css'),
  'utf-8',
);

const FOCUS_RULES = [
  { css: LANDING_CSS, selector: '.rw-lp-wordmark:focus-visible', token: '--rw-lp-accent', offset: '3px' },
  { css: LANDING_CSS, selector: '.rw-lp-nav-link:focus-visible', token: '--rw-lp-accent', offset: '3px' },
  { css: LANDING_CSS, selector: '.rw-lp-menu-button:focus-visible', token: '--rw-lp-accent', offset: '3px' },
  { css: LANDING_CSS, selector: '.rw-lp-menu-link:focus-visible', token: '--rw-lp-accent', offset: '3px' },
  { css: LANDING_CSS, selector: '.rw-lp-nav-signup:focus-visible', token: '--rw-lp-accent', offset: '3px' },
  // The WCAG 2.2.2 pause control. Rings on its own rather than joining the
  // grouped rule below it, because that rule squares the corner off with
  // `border-radius: 2px` and this button is round.
  { css: LANDING_CSS, selector: '.rw-lp-motion-toggle:focus-visible', token: '--rw-lp-accent', offset: '3px' },
  { css: FOOTER_CSS, selector: '.rw-lp-foot-link:focus-visible', token: '--rw-lp-accent', offset: '3px' },
  { css: FOOTER_CSS, selector: '.rw-lp-foot-mail:focus-visible', token: '--rw-lp-accent', offset: '3px' },
  { css: FOOTER_CSS, selector: '.rw-lp-foot-brand-name:focus-visible', token: '--rw-lp-accent', offset: '3px' },
  { css: SCROLL_CSS, selector: '.rw-lp-rail-dot:focus-visible', token: '--rw-lp-accent', offset: '3px' },
  { css: FLEET_CSS, selector: '.rw-lp-fleet-play:focus-visible', token: '--rw-lp-accent', offset: '4px' },
  { css: LIGHTBOX_CSS, selector: '.rw-lp-lightbox-close:focus-visible', token: '--rw-lp-accent', offset: '3px' },
  { css: HERO_CSS, selector: '.rw-lp-hero-cta:focus-visible', token: '--rw-lp-hero-accent', offset: '6px' },
  { css: FUTURE_CSS, selector: '.rw-lp-future-flip:focus-visible', token: '--rw-lp-accent', offset: '5px' },
  { css: CTA_CSS, selector: '.rw-lp-cta-action:focus-visible', token: '--rw-lp-cta-accent', offset: '6px' },
  { css: CSS, selector: '.pr-plan-cta:focus-visible', token: '--rw-teal-strong', offset: '3px' },
  { css: CSS, selector: '.pr-faq-q:focus-visible', token: '--rw-teal-strong', offset: '2px' },
] as const;

function ruleBody(css: string, selector: string): string {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1]?.split(',').map((candidate) => candidate.trim()) ?? [];
    if (selectors.includes(selector) && match[2] !== undefined) {
      return match[2];
    }
  }
  throw new Error(`focus-visible rule missing for ${selector}`);
}

describe('marketing controls declare a focus-visible outline (P1 #18)', () => {
  it.each(FOCUS_RULES)('$selector declares an outline', (rule) => {
    const body = ruleBody(rule.css, rule.selector);
    expect(body).toContain(`outline: 2px solid var(${rule.token})`);
    expect(body).toContain(`outline-offset: ${rule.offset}`);
  });
});
