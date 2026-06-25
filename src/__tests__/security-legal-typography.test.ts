import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// 2026-05 launch audit P2 #26 (doc retired): Security + Legal pages must follow the brand
// typography rubric — rubric h1 scale and #6a6a6a body (not text-3xl/#4a4a4a).
const SECURITY = resolve(process.cwd(), 'src/app/(public)/security/page.tsx');
const LEGAL = resolve(process.cwd(), 'src/components/legal/LegalPage.tsx');

describe('Security + Legal typography rubric (P2 #26)', () => {
  it('security h1 uses the rubric scale and no longer text-3xl', () => {
    const src = readFileSync(SECURITY, 'utf-8');
    expect(src).toMatch(/text-5xl md:text-6xl lg:text-7xl/);
    // Forbid the old non-responsive h1 `text-3xl`, but allow `md:text-3xl` on the h2.
    expect(src).not.toMatch(/(?<!md:)text-3xl/);
  });
  it('security body uses the brand body token (rw-ink-soft = #6a6a6a), not #4a4a4a', () => {
    const src = readFileSync(SECURITY, 'utf-8');
    expect(src).not.toMatch(/#4a4a4a/);
    expect(src).toMatch(/text-rw-ink-soft/);
  });
  it('legal h1 uses the rubric scale and body is no longer text-sm/#4a4a4a', () => {
    const src = readFileSync(LEGAL, 'utf-8');
    expect(src).toMatch(/text-5xl md:text-6xl lg:text-7xl/);
    expect(src).not.toMatch(/#4a4a4a/);
  });
});
