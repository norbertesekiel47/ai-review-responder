import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// A26: onboarding titles used "| RepWorth" while every public page uses "·".
// The root layout's `title.template` ('%s · RepWorth') appends the brand, so a
// page title is the page name alone. File-content scan (precedent:
// src/__tests__/page-metadata.test.ts).
//
// #1103 — WHAT THIS GUARD OWNS, now that a third guard exists. The app-wide
// scan `src/app/(public)/__tests__/page-titles.test.ts` walks every `page.tsx`
// and every non-root `layout.tsx` under `src/app`, these four funnel pages
// included, and fails any title ENDING in the brand. That is a negative claim
// over the whole tree, so the `| RepWorth` assertion this file used to carry
// was a second copy of it and has been removed — one property, one owner.
//
// What no other guard makes is the POSITIVE claim below: that each of these
// four pages declares a title of its own at all. The app-wide scan cannot,
// because a page with no `metadata` export is not an offender there. A funnel
// page that silently loses its title falls back to the layout's and is caught
// only here.
const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf-8');

const FUNNEL_PAGES = [
  'src/app/onboarding/start/page.tsx',
  'src/app/onboarding/payment-success/page.tsx',
  'src/app/onboarding/pay/page.tsx',
  'src/app/onboarding/business/page.tsx',
];

describe('onboarding page titles (A26)', () => {
  it.each(FUNNEL_PAGES)('%s declares its own bare page title', (rel) => {
    // Bare = no separator inside the literal. The brand SUFFIX is the app-wide
    // scan's; the separator-free shape is this guard's, because a funnel title
    // carrying its own "·" reads as a breadcrumb the template then extends.
    expect(read(rel)).toMatch(/title:\s*'[^'|·]+'/);
  });
});
