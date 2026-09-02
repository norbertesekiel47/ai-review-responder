import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// A26: onboarding titles used "| RepWorth" while every public page uses "·".
// The root layout's `title.template` ('%s · RepWorth') appends the brand, so a
// page title is the page name alone. File-content scan (precedent:
// src/__tests__/page-metadata.test.ts).
const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf-8');

const FUNNEL_PAGES = [
  'src/app/onboarding/start/page.tsx',
  'src/app/onboarding/payment-success/page.tsx',
  'src/app/onboarding/pay/page.tsx',
  'src/app/onboarding/business/page.tsx',
];

describe('onboarding page titles (A26)', () => {
  it.each(FUNNEL_PAGES)('%s sets a bare page title and never spells "| RepWorth"', (rel) => {
    const src = read(rel);
    expect(src).toMatch(/title:\s*'[^'|·]+'/);
    expect(src).not.toMatch(/\|\s*RepWorth/);
  });
});
