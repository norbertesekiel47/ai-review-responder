import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Launch audit #19: auth surfaces must be noindex; public + legal pages must
// carry their own <title> (and stay crawlable). File-content scan (not import)
// mirrors the island-overflow.test.ts guard-test precedent and avoids pulling
// server-only page deps (supabase, next/headers) into vitest.
const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf-8');

const AUTH_NOINDEX = [
  'src/app/(public)/login/page.tsx',
  'src/app/(public)/signup/page.tsx',
  'src/app/(public)/signup/check-email/page.tsx',
  'src/app/(public)/signup/finish/page.tsx',
  'src/app/(public)/forgot-password/page.tsx',
  'src/app/(public)/reset-password/page.tsx',
  'src/app/mfa/layout.tsx',
];

describe('page metadata — auth surfaces are noindex (#19)', () => {
  it.each(AUTH_NOINDEX)('%s exports metadata using the shared noindexRobots fragment', (rel) => {
    const src = read(rel);
    expect(src).toMatch(/export const metadata/);
    expect(src).toMatch(/noindexRobots/);
    expect(src).toMatch(/title:/);
  });

  it('seo.ts owns a noindexRobots fragment that disables indexing', () => {
    const src = read('src/lib/seo.ts');
    expect(src).toMatch(/export const noindexRobots/);
    expect(src).toMatch(/index:\s*false/);
    expect(src).toMatch(/follow:\s*false/);
  });
});

const PUBLIC_INDEXABLE = [
  'src/app/(public)/page.tsx',
  'src/app/(public)/features/page.tsx',
  'src/app/(public)/how-it-works/page.tsx',
  'src/app/(public)/pricing/page.tsx',
  'src/app/(public)/book-a-demo/page.tsx',
  'src/app/(public)/security/page.tsx',
  'src/app/(public)/legal/aup/page.tsx',
  'src/app/(public)/legal/cookies/page.tsx',
  'src/app/(public)/legal/privacy/page.tsx',
  'src/app/(public)/legal/sub-processors/page.tsx',
  'src/app/(public)/legal/terms/page.tsx',
];

describe('page metadata — public + legal pages have titles and stay indexable (#19)', () => {
  it.each(PUBLIC_INDEXABLE)('%s exports metadata with a title and is not noindex', (rel) => {
    const src = read(rel);
    expect(src).toMatch(/export const metadata/);
    expect(src).toMatch(/title:\s*['"]/);
    expect(src).not.toMatch(/noindexRobots/);
    expect(src).not.toMatch(/index:\s*false/);
  });
});
