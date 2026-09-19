import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// A26: one title owner per subtree, and the root layout's `title.template`
// ('%s · RepWorth') supplies the brand suffix — a page or layout that spells
// out "| RepWorth" or "· RepWorth" itself ends up doubled or mis-punctuated.
// File-content scan, same precedent as src/__tests__/page-metadata.test.ts.
//
// #1103 — WHAT THIS GUARD OWNS. The brand-suffix half is NOT here and never
// was: the app-wide scan `src/app/(public)/__tests__/page-titles.test.ts`
// covers it for the whole tree and names `src/app/mfa/layout.tsx` explicitly
// among the files it must reach. Both assertions below are this guard's alone
// — the exact title VALUE the subtree renders, and the claim that the child
// page adds no second owner for it. Neither is derivable from "does not end
// in the brand", so nothing here duplicates and nothing was removed.
const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf-8');

describe('/mfa titles (A26)', () => {
  it('mfa/layout.tsx titles the whole subtree, and the value is exactly "Security check"', () => {
    const src = read('src/app/mfa/layout.tsx');
    const [titleLine] = src.match(/^\s*title:.*$/m) ?? [];
    expect(titleLine).toMatch(/title:\s*'Security check',?$/);
  });

  it('mfa/challenge/page.tsx no longer overrides the layout title', () => {
    const src = read('src/app/mfa/challenge/page.tsx');
    expect(src).not.toMatch(/export const metadata/);
  });
});
