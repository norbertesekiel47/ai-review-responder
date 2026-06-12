import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// 2026-05 launch audit P2 #28 (doc retired): review-star GLYPHS use brand teal #97B3AE, never
// yellow. Scoped to star call-sites so it never trips on legit yellow STATUS
// badges (e.g. admin past_due `bg-yellow-100 text-yellow-800`).
const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf-8');
const STAR = '#97B3AE';

describe('review stars are brand teal, never yellow (P2 #28)', () => {
  it('token is renamed --rw-star and no --rw-yellow-500 remains', () => {
    const tokens = read('src/app/(authenticated)/_styles/tokens.css');
    expect(tokens).toMatch(/--rw-star:\s*#97B3AE/);
    expect(tokens).not.toMatch(/--rw-yellow-500/);
  });

  it('no file still references --rw-yellow-500', () => {
    for (const p of [
      'src/app/(authenticated)/_styles/console.css',
      'src/app/(authenticated)/_styles/past-replies.css',
      'src/app/(authenticated)/dashboard/past-replies/PastRepliesClient.tsx',
    ]) {
      expect(read(p), `${p} still references --rw-yellow-500`).not.toMatch(/--rw-yellow-500/);
    }
  });

  it('CSS star selectors use teal, not #eab308', () => {
    const checks: [string, RegExp][] = [
      ['src/app/(authenticated)/_styles/console.css', /\.stars\s*\{[^}]*var\(--rw-star\)/],
      ['src/app/(authenticated)/_styles/past-replies.css', /\.pr-chip-stars\s*\{[^}]*var\(--rw-star\)/],
      ['src/app/globals.css', /\.rw-demo-stars\s*\{[^}]*#97B3AE/i],
      ['src/app/globals.css', /\.hiw-feed-stars\s*\{[^}]*#97B3AE/i],
      ['src/app/globals.css', /\.rw-bg-stars\s*\{[^}]*#97B3AE/i],
      ['src/components/auth/auth-island/auth-island.css', /\.rw-pcard-stars\s*\{[^}]*#97B3AE/i],
      ['src/components/auth/auth-island/auth-island.css', /\.rw-review-stars\s*\{[^}]*#97B3AE/i],
    ];
    for (const [p, re] of checks) {
      expect(read(p), `${p} star selector not teal`).toMatch(re);
    }
  });

  it('star-only TSX files have no yellow star classes/hex', () => {
    for (const p of [
      'src/components/sections/features/FeaturesContent.tsx',
      'src/components/sections/how-it-works/HowItWorksContent.tsx',
      'src/app/(authenticated)/dashboard/past-replies/PastRepliesClient.tsx',
      'src/components/dashboard/reviews/EditReplyDrawer.tsx',
      'src/components/approval/approval-client.tsx',
    ]) {
      const src = read(p);
      expect(src, `${p} has text-yellow-4xx star`).not.toMatch(/text-yellow-4\d0/);
      expect(src, `${p} has text-yellow-5xx star`).not.toMatch(/text-yellow-5\d0/);
      expect(src, `${p} has #eab308 star`).not.toMatch(/#eab308/i);
    }
  });

  it('admin star spans are teal (status badges untouched)', () => {
    for (const p of [
      'src/app/admin/businesses/[id]/_components/ReviewsList.tsx',
      'src/app/admin/businesses/[id]/_components/ZernioConnectionPanel.tsx',
    ]) {
      const src = read(p);
      expect(src, `${p} star span still yellow`).not.toMatch(/text-yellow-\d00">\s*\{(?:renderStars|formatStars)/);
      expect(src).toMatch(/text-\[#97B3AE\]">\s*\{(?:renderStars|formatStars)/);
    }
  });
});
