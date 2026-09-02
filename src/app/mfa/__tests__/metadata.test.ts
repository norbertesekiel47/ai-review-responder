import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// A26: one title owner per subtree, and the root layout's `title.template`
// ('%s · RepWorth') supplies the brand suffix — a page or layout that spells
// out "| RepWorth" or "· RepWorth" itself ends up doubled or mis-punctuated.
// File-content scan, same precedent as src/__tests__/page-metadata.test.ts.
const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf-8');

describe('/mfa titles (A26)', () => {
  it('mfa/layout.tsx owns the title and leaves the brand suffix to the root template', () => {
    const src = read('src/app/mfa/layout.tsx');
    const [titleLine] = src.match(/^\s*title:.*$/m) ?? [];
    expect(titleLine).toMatch(/title:\s*'Security check',?$/);
  });

  it('mfa/challenge/page.tsx no longer overrides the layout title', () => {
    const src = read('src/app/mfa/challenge/page.tsx');
    expect(src).not.toMatch(/export const metadata/);
  });
});
