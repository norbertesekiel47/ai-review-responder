import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// P1 #18: keyboard users must get a visible focus ring on the marketing
// interactive controls. Links on paper use accessible strong teal; filled
// strong-teal CTAs use the contrasting cream token.
const CSS = readFileSync(resolve(process.cwd(), 'src/app/globals.css'), 'utf-8');
const LANDING_CSS = readFileSync(
  resolve(process.cwd(), 'src/components/sections/landing/landing-experience.css'),
  'utf-8',
);

const FOCUS_RULES = [
  { css: LANDING_CSS, selector: '.rw-le-brand:focus-visible', token: '--rw-teal-strong', offset: '3px' },
  { css: LANDING_CSS, selector: '.rw-le-nav-links a:focus-visible', token: '--rw-teal-strong', offset: '3px' },
  { css: LANDING_CSS, selector: '.rw-le-btn-ghost:focus-visible', token: '--rw-teal-strong', offset: '3px' },
  { css: LANDING_CSS, selector: '.rw-le-footer-links a:focus-visible', token: '--rw-teal-strong', offset: '3px' },
  { css: LANDING_CSS, selector: '.rw-le-cta:focus-visible', token: '--rw-cream', offset: '2px', outerRing: '0 0 0 6px var(--rw-ink)' },
  { css: LANDING_CSS, selector: '.rw-le-btn-primary:focus-visible', token: '--rw-cream', offset: '2px', outerRing: '0 0 0 6px var(--rw-ink)' },
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
    if ('outerRing' in rule) {
      expect(body).toContain(`box-shadow: ${rule.outerRing}`);
    }
  });
});
