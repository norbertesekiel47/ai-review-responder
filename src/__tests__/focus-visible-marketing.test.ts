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
// The two Island rows below are pricing-page rules; PR 3b moved the marketing
// page CSS out of globals.css (now the Island TOKEN file) into (public)/_styles.
const PRICING_CSS = readFileSync(
  resolve(process.cwd(), 'src/app/(public)/_styles/pricing.css'),
  'utf-8',
);
const ISLAND_CSS = readFileSync(
  resolve(process.cwd(), 'src/app/(public)/_styles/island.css'),
  'utf-8',
);
const LANDING_CSS = readFileSync(
  resolve(process.cwd(), 'src/components/sections/landing/landing-experience.css'),
  'utf-8',
);
const HERO_CSS = readFileSync(
  resolve(process.cwd(), 'src/components/sections/landing/hero/hero.css'),
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
const LIGHTBOX_CSS = readFileSync(
  resolve(process.cwd(), 'src/components/sections/landing/fleet/video-lightbox.css'),
  'utf-8',
);
const SCOPES_CSS = readFileSync(
  resolve(process.cwd(), 'src/components/sections/landing/section-scopes.css'),
  'utf-8',
);
const TIERS_CSS = readFileSync(
  resolve(process.cwd(), 'src/components/sections/landing/tiers/tiers.css'),
  'utf-8',
);
const FUTURE_CSS = readFileSync(
  resolve(process.cwd(), 'src/components/sections/landing/future/future.css'),
  'utf-8',
);

const FOCUS_RULES = [
  { css: LANDING_CSS, selector: '.rw-lp-wordmark:focus-visible', token: '--rw-lp-accent', offset: '3px' },
  { css: LANDING_CSS, selector: '.rw-lp-nav-link:focus-visible', token: '--rw-lp-accent', offset: '3px' },
  { css: LANDING_CSS, selector: '.rw-lp-menu-button:focus-visible', token: '--rw-lp-accent', offset: '3px' },
  { css: LANDING_CSS, selector: '.rw-lp-menu-link:focus-visible', token: '--rw-lp-accent', offset: '3px' },
  { css: LANDING_CSS, selector: '.rw-lp-nav-cta:focus-visible', token: '--rw-lp-accent', offset: '3px' },
  // The WCAG 2.2.2 pause control. Rings on its own rather than joining the
  // grouped rule below it, because that rule squares the corner off with
  // `border-radius: 2px` and this button is round.
  { css: LANDING_CSS, selector: '.rw-lp-motion-toggle:focus-visible', token: '--rw-lp-accent', offset: '3px' },
  { css: FOOTER_CSS, selector: '.rw-lp-foot-link:focus-visible', token: '--rw-lp-accent', offset: '3px' },
  { css: FOOTER_CSS, selector: '.rw-lp-foot-mail:focus-visible', token: '--rw-lp-accent', offset: '3px' },
  { css: FOOTER_CSS, selector: '.rw-lp-foot-brand-name:focus-visible', token: '--rw-lp-accent', offset: '3px' },
  { css: LIGHTBOX_CSS, selector: '.rw-lp-lightbox-close:focus-visible', token: '--rw-lp-accent', offset: '3px' },
  // The middle sections ring by scope, one rule per scope: the fleet film,
  // station links and agent controls (loop); the watchdogs section's door to
  // /how-it-works (model). 3px, pushed 5px out past the controls' borders.
  { css: SCOPES_CSS, selector: '.rw-lp-synthesis-loop :is(a, button):focus-visible', token: '--rw-lp-accent', offset: '5px', width: 3 },
  { css: SCOPES_CSS, selector: '.rw-lp-synthesis-model :is(a,button):focus-visible', token: '--rw-lp-accent', offset: '5px', width: 3 },
  // The owner controls sit on light paper, so the Copilot/Autopilot buttons
  // and the section's two links ring in a darker brass than the landing
  // accent.
  { css: TIERS_CSS, selector: '.rw-lp-final-owner :is(button,a):focus-visible', color: '#b17f30', offset: '5px', width: 3 },
  // The roadmap's chapter tabs, map stops and ledger rows: one rule.
  { css: FUTURE_CSS, selector: '.rw-lp-final-roadmap button:focus-visible', token: '--rw-lp-accent', offset: '5px', width: 3 },
  // The three gold pills ring at 3px: outward, past the pill's own fill.
  { css: HERO_CSS, selector: '.rw-lp-hero-cta:focus-visible', token: '--rw-lp-hero-accent', offset: '3px' },
  { css: CTA_CSS, selector: '.rw-lp-cta-action:focus-visible', token: '--rw-lp-cta-accent', offset: '3px' },
  // Daylight Gallery II (2026-08 rebrand): Island marketing surfaces ring in
  // forest — the system's single action colour, high-contrast on bone/paper.
  { css: PRICING_CSS, selector: '.pr-plan-cta:focus-visible', token: '--rw-forest', offset: '3px' },
  // The pricing FAQ now renders the shared `.rw-dl-faq*` accordion (island.css),
  // the same one /how-it-works uses — its ring lives with the primitive.
  { css: ISLAND_CSS, selector: '.rw-dl-faq-q:focus-visible', token: '--rw-forest', offset: '3px' },
] as const;

/** Split a selector list on its top-level commas only, so `:is(a, button)`
 *  stays one selector. */
function splitSelectors(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of list) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current.trim());
  return parts;
}

function ruleBody(css: string, selector: string): string {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = splitSelectors(match[1] ?? '');
    if (selectors.includes(selector) && match[2] !== undefined) {
      return match[2];
    }
  }
  throw new Error(`focus-visible rule missing for ${selector}`);
}

describe('marketing controls declare a focus-visible outline (P1 #18)', () => {
  it.each(FOCUS_RULES)('$selector declares an outline', (rule) => {
    const body = ruleBody(rule.css, rule.selector);
    const width = 'width' in rule ? rule.width : 2;
    const color = 'color' in rule ? rule.color : `var(${rule.token})`;
    expect(body).toContain(`outline: ${width}px solid ${color}`);
    expect(body).toContain(`outline-offset: ${rule.offset}`);
  });
});
