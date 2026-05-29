import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// P1 #18: keyboard users must get a visible focus ring on the marketing
// interactive controls. Lock the three CSS-class controls to the canonical
// teal outline treatment (the same one .pr-matrix already uses).
const CSS = readFileSync(resolve(process.cwd(), 'src/app/globals.css'), 'utf-8');

const FOCUS_SELECTORS = [
  '.rw-dot-nav button:focus-visible',
  '.pr-toggle button:focus-visible',
  '.pr-faq-q:focus-visible',
];

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = CSS.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  if (!match || match[1] === undefined) {
    throw new Error(`focus-visible rule missing for ${selector}`);
  }
  return match[1];
}

describe('marketing controls declare a focus-visible outline (P1 #18)', () => {
  it.each(FOCUS_SELECTORS)('%s declares an outline', (selector) => {
    expect(ruleBody(selector)).toMatch(/outline\s*:\s*2px solid var\(--rw-teal\)/);
  });
});
