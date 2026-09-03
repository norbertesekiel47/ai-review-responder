import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Metadata } from 'next';
import { describe, expect, it } from 'vitest';

/**
 * Guard for #1078 B / A26. `src/app/layout.tsx` owns the brand suffix as a
 * title TEMPLATE (`'%s · RepWorth'`), so a page that also spells the brand at
 * the end of its own title renders it twice — "Log in · RepWorth · RepWorth".
 * Sixteen pages did.
 *
 * The value here is preventing the SEVENTEENTH, so this scans every
 * `page.tsx` under `src/app` rather than the sixteen that were wrong. It
 * lives under `(public)/__tests__/` because that is where every offender was
 * (and where the sibling text-scan guard `db-backed-pages-force-dynamic.test.ts`
 * lives), but its ROOT is `src/app` — a doubled title on an admin or
 * onboarding page is the same bug.
 *
 * FILE-CONTENT SCAN, not import. Importing a page module pulls `next/font`,
 * `next/headers` and the whole server render path into vitest; the precedent
 * for reading titles off the source is `src/__tests__/page-metadata.test.ts`
 * and `db-backed-pages-force-dynamic.test.ts`.
 *
 * The predicate is "ends with the brand", not "ends with ' · RepWorth'": a
 * title ending in the bare word (`'Welcome to RepWorth'`) doubles it just as
 * loudly, and the two stubs that were wrong used `'| RepWorth'` rather than
 * the middot. A title that merely CONTAINS the brand is fine — the landing
 * page's `'RepWorth: Automated Google review responses'` is deliberate.
 */
const APP_ROOT = join(process.cwd(), 'src', 'app');
const METADATA_EXPORT = 'export const metadata';
const TITLE_LITERAL = /title:\s*(['"`])((?:\\.|(?!\1).)*)\1/g;
const ENDS_WITH_BRAND = /RepWorth\s*$/;

interface Offender {
  file: string;
  title: string;
}

function pageFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('page.tsx'))
    .map((entry) => join(root, entry))
    .sort();
}

/**
 * Every quoted `title:` value declared inside a file's `export const metadata`
 * block. Slicing from the export keeps unrelated `title:` properties elsewhere
 * in a page (a locked-state card, a table column) out of the scan; keeping ALL
 * matches after it means a nested `openGraph.title` is covered too.
 */
function metadataTitles(source: string): string[] {
  const start = source.indexOf(METADATA_EXPORT);
  if (start === -1) return [];
  return [...source.slice(start).matchAll(TITLE_LITERAL)]
    .map((match) => match[2])
    .filter((title): title is string => title !== undefined);
}

function findOffenders(files: string[]): Offender[] {
  const offenders: Offender[] = [];
  for (const file of files) {
    for (const title of metadataTitles(readFileSync(file, 'utf8'))) {
      if (ENDS_WITH_BRAND.test(title)) {
        offenders.push({ file: relative(process.cwd(), file), title });
      }
    }
  }
  return offenders;
}

/**
 * The failure text. A guard that reports `false is not true` costs the next
 * person an afternoon, so every offender names its file AND the exact title
 * string to change.
 */
function describeOffenders(offenders: Offender[]): string[] {
  return offenders.map(({ file, title }) => `${file} → title: '${title}'`);
}

const files = pageFiles(APP_ROOT);

/**
 * The sixteen pages this change fixed, as MODULES. The scan above is the
 * regression signal for the seventeenth; this table is the resolved-value
 * check on the sixteen — it reads `metadata.title` as the object Next will
 * actually feed the template, so a title assembled from a constant, or one
 * whose source text and exported value disagree, cannot slip past.
 *
 * Importing a page MODULE is an established pattern here
 * (`src/app/__tests__/unsubscribe-landing.test.tsx` imports this very
 * `u/[token]` page and its `metadata`); what the intake warned against —
 * pulling `next/font` and the render path in — is a property of the root
 * LAYOUT, not of these pages. Nothing below renders a component.
 *
 * `noindex` records each page's existing `robots` directive, which this change
 * had to leave untouched.
 */
const FIXED_PAGES: {
  path: string;
  title: string;
  noindex: boolean;
  load: () => Promise<{ metadata: Metadata }>;
}[] = [
  { path: '(public)/features', title: 'Features', noindex: false, load: () => import('../features/page') },
  { path: '(public)/forgot-password', title: 'Reset your password', noindex: true, load: () => import('../forgot-password/page') },
  { path: '(public)/legal/aup', title: 'Acceptable Use Policy', noindex: false, load: () => import('../legal/aup/page') },
  { path: '(public)/legal/cookies', title: 'Cookie Policy', noindex: false, load: () => import('../legal/cookies/page') },
  { path: '(public)/legal/privacy', title: 'Privacy Policy', noindex: false, load: () => import('../legal/privacy/page') },
  { path: '(public)/legal/sub-processors', title: 'Sub-processors', noindex: false, load: () => import('../legal/sub-processors/page') },
  { path: '(public)/legal/terms', title: 'Terms of Service', noindex: false, load: () => import('../legal/terms/page') },
  { path: '(public)/login', title: 'Log in', noindex: true, load: () => import('../login/page') },
  { path: '(public)/privacy', title: 'Privacy Policy', noindex: false, load: () => import('../privacy/page') },
  { path: '(public)/reset-password', title: 'Set a new password', noindex: true, load: () => import('../reset-password/page') },
  { path: '(public)/security', title: 'Security', noindex: false, load: () => import('../security/page') },
  { path: '(public)/signup', title: 'Sign up', noindex: true, load: () => import('../signup/page') },
  { path: '(public)/signup/check-email', title: 'Check your email', noindex: true, load: () => import('../signup/check-email/page') },
  { path: '(public)/signup/finish', title: 'Finish signup', noindex: true, load: () => import('../signup/finish/page') },
  { path: '(public)/terms', title: 'Terms of Service', noindex: false, load: () => import('../terms/page') },
  { path: '(public)/u/[token]', title: 'Unsubscribe', noindex: true, load: () => import('../u/[token]/page') },
];

describe('page titles do not repeat the brand the root template appends (#1078 B)', () => {
  it('no page metadata title under src/app spells the RepWorth brand suffix', () => {
    // Non-vacuous: the scan really walked the app and really read titles.
    expect(files.length).toBeGreaterThan(50);
    expect(files.flatMap((file) => metadataTitles(readFileSync(file, 'utf8'))).length)
      .toBeGreaterThan(20);

    expect(
      describeOffenders(findOffenders(files)),
      "src/app/layout.tsx already appends ' · RepWorth' via title.template — "
      + 'each page below must carry a BARE name.',
    ).toEqual([]);
  });

  it('the title guard names every offending file and its title when it fails', () => {
    // Exercised on a fixture rather than on a real regression, so the reporting
    // stays proven once the tree is clean.
    const described = describeOffenders([
      { file: 'src/app/(public)/login/page.tsx', title: 'Log in · RepWorth' },
      { file: 'src/app/(public)/terms/page.tsx', title: 'Terms of Service | RepWorth' },
    ]);

    expect(described).toEqual([
      "src/app/(public)/login/page.tsx → title: 'Log in · RepWorth'",
      "src/app/(public)/terms/page.tsx → title: 'Terms of Service | RepWorth'",
    ]);

    // And the predicate the report is built from actually discriminates: both
    // separators are caught, a bare name is not, and a title that merely
    // contains the brand is not.
    expect(ENDS_WITH_BRAND.test('Log in · RepWorth')).toBe(true);
    expect(ENDS_WITH_BRAND.test('Terms of Service | RepWorth')).toBe(true);
    expect(ENDS_WITH_BRAND.test('Welcome to RepWorth')).toBe(true);
    expect(ENDS_WITH_BRAND.test('Log in')).toBe(false);
    expect(ENDS_WITH_BRAND.test('RepWorth: Automated Google review responses')).toBe(false);
  });

  it.each(FIXED_PAGES)(
    'src/app/$path/page.tsx exports the bare title $title and keeps its robots directive',
    async ({ title, noindex, load }) => {
      const { metadata } = await load();

      // The RESOLVED value, not the source text.
      expect(metadata.title).toBe(title);
      expect(ENDS_WITH_BRAND.test(String(metadata.title))).toBe(false);

      // Unchanged by this edit: a noindex page stays noindex, and an indexable
      // one gains no robots directive it did not have.
      if (noindex) {
        expect(metadata.robots).toEqual({ index: false, follow: false });
      } else {
        expect(metadata.robots).toBeUndefined();
      }
    },
  );

  it('the resolved-value table covers every page this change edited', () => {
    // A hand-written table can only rot in one direction: silently losing a
    // page. `allowed_edit_surface` fixed the count at sixteen.
    expect(FIXED_PAGES).toHaveLength(16);
    expect(new Set(FIXED_PAGES.map(({ path }) => path)).size).toBe(16);
  });
});
