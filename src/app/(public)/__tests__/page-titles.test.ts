import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import type { Metadata } from 'next';
import { describe, expect, it } from 'vitest';

/**
 * Guard for #1078 B / A26. `src/app/layout.tsx` owns the brand suffix as a
 * title TEMPLATE (`'%s · RepWorth'`), so a page that also spells the brand at
 * the end of its own title renders it twice — "Log in · RepWorth · RepWorth".
 * Sixteen pages did.
 *
 * The value here is preventing the SEVENTEENTH, so this scans the tree rather
 * than the sixteen that were wrong. It lives under `(public)/__tests__/`
 * because that is where every offender was (and where the sibling text-scan
 * guard `db-backed-pages-force-dynamic.test.ts` lives), but its ROOT is
 * `src/app` — a doubled title on an admin or onboarding page is the same bug.
 *
 * SCANNED: every `page.tsx`, and every `layout.tsx` EXCEPT `src/app/layout.tsx`.
 * Nested layouts own titles here (`src/app/mfa/layout.tsx` titles that whole
 * subtree), and a nested layout spelling the suffix doubles it identically. The
 * root layout is the one file that legitimately declares the template.
 *
 * READ, not resolved-by-import. Importing a page module pulls `next/font`,
 * `next/headers` and the whole server render path into vitest; the precedent
 * for reading titles off the source is `src/__tests__/page-metadata.test.ts`
 * and `db-backed-pages-force-dynamic.test.ts`. So the scan reads the four
 * shapes a title can arrive in — a quoted literal, a template literal, a
 * `{ default | absolute | template }` object, and an identifier it resolves
 * through a same-file `const` or a one-hop relative/`@/` import — inside BOTH
 * `export const metadata` and `generateMetadata()`, which is the API a future
 * dynamic segment reaches for first. Known limits: a metadata object assembled
 * by a function call, a default-imported constant, and a title composed from
 * more than one hop are not readable this way; the resolved-value table at the
 * bottom is the backstop for the pages that exist today.
 *
 * NOT scanned: `openGraph.title` / `twitter.title`. `title.template` applies to
 * `metadata.title` only — the root declares `openGraph.title` with no
 * `openGraph.title.template`, so a correct per-page OG title has to spell the
 * brand itself. Flagging those would fight the deferred OG work.
 *
 * The predicate is "ends with the brand", not "ends with ' · RepWorth'": a
 * title ending in the bare word (`'Welcome to RepWorth'`) doubles it just as
 * loudly, and the two stubs that were wrong used `'| RepWorth'` rather than
 * the middot. A title that merely CONTAINS the brand still passes — a brand
 * PREFIX doubles the brand too, and the landing page did exactly that until
 * #1102 gave it a bare title. No page in the tree relies on that allowance
 * now; the control cases below keep the limit stated rather than latent.
 */
const APP_ROOT = join(process.cwd(), 'src', 'app');
const ENDS_WITH_BRAND = /RepWorth\s*$/;

const METADATA_FILE = /(?:^|\/)(?:page|layout)\.tsx$/;
const METADATA_ENTRY =
  /export\s+(?:const\s+metadata\b|(?:async\s+)?function\s+generateMetadata\b)/g;
const SUB_OBJECT = /\b(?:openGraph|twitter)\s*:\s*\{/;
const TITLE_KEY = /(?<![\w$.])title\s*:\s*/g;
const TITLE_OBJECT_VALUE = /\b(?:default|absolute|template)\s*:\s*(['"`])((?:\\.|(?!\1).)*)\1/g;
const IDENTIFIER = /^[A-Za-z_$][\w$]*/;

interface Offender {
  file: string;
  title: string;
}

/** The text inside the string or template literal starting at `start`. */
function readLiteral(source: string, start: number): { text: string; end: number } | null {
  const quote = source[start];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  for (let i = start + 1; i < source.length; i += 1) {
    if (source[i] === '\\') { i += 1; continue; }
    if (source[i] === quote) return { text: source.slice(start + 1, i), end: i + 1 };
  }
  return null;
}

/**
 * The balanced `{…}` (or `(…)`) span opening at `openIndex`, skipping over
 * comments and literals so a brace inside a description string or a `//` note
 * cannot end the block early.
 */
function readBalanced(
  source: string,
  openIndex: number,
  open = '{',
  close = '}',
): { body: string; end: number } {
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    if (source[i] === '/' && source[i + 1] === '/') {
      const eol = source.indexOf('\n', i);
      if (eol === -1) break;
      i = eol;
      continue;
    }
    if (source[i] === '/' && source[i + 1] === '*') {
      const closeComment = source.indexOf('*/', i + 2);
      if (closeComment === -1) break;
      i = closeComment + 1;
      continue;
    }
    const literal = readLiteral(source, i);
    if (literal !== null) { i = literal.end - 1; continue; }
    if (source[i] === open) depth += 1;
    else if (source[i] === close) {
      depth -= 1;
      if (depth === 0) return { body: source.slice(openIndex + 1, i), end: i + 1 };
    }
  }
  return { body: source.slice(openIndex + 1), end: source.length };
}

/**
 * The body of every metadata declaration in a file: the object literal of
 * `export const metadata`, and the function body of `generateMetadata` — whose
 * first `{` is its destructured params, not its body, so the parameter list is
 * skipped first.
 */
function metadataRegions(source: string): string[] {
  const regions: string[] = [];
  for (const match of source.matchAll(METADATA_ENTRY)) {
    const afterEntry = match[0].includes('function')
      ? readBalanced(source, source.indexOf('(', match.index + match[0].length), '(', ')').end
      : match.index + match[0].length;
    const open = source.indexOf('{', afterEntry);
    if (open === -1) continue;
    regions.push(readBalanced(source, open).body);
  }
  return regions;
}

/** Drops `openGraph: {…}` / `twitter: {…}` — the root template never touches them. */
function stripSubObjects(region: string): string {
  let remaining = region;
  for (let match = SUB_OBJECT.exec(remaining); match !== null; match = SUB_OBJECT.exec(remaining)) {
    const open = match.index + match[0].length - 1;
    remaining = remaining.slice(0, match.index) + remaining.slice(readBalanced(remaining, open).end);
  }
  return remaining;
}

/**
 * The literal a `const` identifier holds — declared in this file, or one hop
 * away through a named import.
 */
function resolveIdentifier(name: string, file: string, appRoot: string, hops = 0): string[] {
  const source = readFileSync(file, 'utf8');
  const declared = new RegExp(`\\bconst\\s+${name}\\s*(?::[^=;]*)?=\\s*`).exec(source);
  if (declared !== null) {
    const literal = readLiteral(source, declared.index + declared[0].length);
    return literal === null ? [] : [literal.text];
  }
  if (hops > 0) return [];
  const imported = new RegExp(
    `import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*(['"])([^'"]+)\\1`,
  ).exec(source);
  const target = imported === undefined || imported === null
    ? null
    : resolveModule(String(imported[2]), file, appRoot);
  return target === null ? [] : resolveIdentifier(name, target, appRoot, hops + 1);
}

/** `@/x` and `./x` only — a bare package specifier is not ours to read. */
function resolveModule(specifier: string, from: string, appRoot: string): string | null {
  const base = specifier.startsWith('@/')
    ? join(dirname(appRoot), specifier.slice(2))
    : specifier.startsWith('.')
      ? resolve(dirname(from), specifier)
      : null;
  if (base === null) return null;
  return [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].find((c) => existsSync(c)) ?? null;
}

/** Every title value a metadata region declares, in any of the four shapes. */
function regionTitles(region: string, file: string, appRoot: string): string[] {
  const body = stripSubObjects(region);
  return [...body.matchAll(TITLE_KEY)].flatMap((match) => {
    const at = match.index + match[0].length;
    const literal = readLiteral(body, at);
    if (literal !== null) return [literal.text];
    if (body[at] === '{') {
      return [...readBalanced(body, at).body.matchAll(TITLE_OBJECT_VALUE)]
        .map((nested) => String(nested[2]));
    }
    const identifier = IDENTIFIER.exec(body.slice(at));
    return identifier === null ? [] : resolveIdentifier(identifier[0], file, appRoot);
  });
}

function metadataTitles(file: string, appRoot: string): string[] {
  const source = readFileSync(file, 'utf8');
  return metadataRegions(source).flatMap((region) => regionTitles(region, file, appRoot));
}

/** Every `page.tsx`/`layout.tsx` under `appRoot` except the brand-owning root layout. */
function metadataFiles(appRoot: string): string[] {
  return readdirSync(appRoot, { recursive: true, encoding: 'utf8' })
    .filter((entry) => METADATA_FILE.test(entry))
    .map((entry) => join(appRoot, entry))
    .filter((file) => file !== join(appRoot, 'layout.tsx'))
    .sort();
}

function findOffenders(files: string[], appRoot: string): Offender[] {
  const projectRoot = dirname(dirname(appRoot));
  const offenders: Offender[] = [];
  for (const file of files) {
    for (const title of metadataTitles(file, appRoot)) {
      if (ENDS_WITH_BRAND.test(title)) {
        offenders.push({ file: relative(projectRoot, file), title });
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

/**
 * Runs the real scan over a throwaway app tree, so what a FAILING run reports
 * is asserted rather than hand-built. Both halves of an offender — the file and
 * the title — come out of `findOffenders` itself.
 */
function scanFixture(sources: Record<string, string>): string[] {
  const root = mkdtempSync(join(tmpdir(), 'repworth-page-titles-'));
  try {
    for (const [path, source] of Object.entries(sources)) {
      const target = join(root, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, source, 'utf8');
    }
    const appRoot = join(root, 'src', 'app');
    return describeOffenders(findOffenders(metadataFiles(appRoot), appRoot));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const files = metadataFiles(APP_ROOT);

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
 * A row carries no loader of its own: `PAGE_MODULES` is keyed by the same
 * `path` the row names, so a mis-pointed row cannot resolve to another page's
 * module. It could before — `(public)/privacy` and `(public)/legal/privacy`
 * share a title AND a robots directive, so a copy-pasted loader passed
 * everything.
 *
 * `noindex` records each page's existing `robots` directive, which this change
 * had to leave untouched.
 */
const PAGE_MODULES = new Map<string, () => Promise<{ metadata: Metadata }>>(
  Object.entries(import.meta.glob('../**/page.tsx')).map(([key, load]) => [
    // The segment slash is optional so the group's OWN page — glob key
    // `../page.tsx`, no segment in front of it — keys as `(public)` rather
    // than `(public)/page.tsx`, which addressed nothing (#1102).
    `(public)/${key.replace(/^\.\.\//, '').replace(/\/?page\.tsx$/, '')}`.replace(/\/$/, ''),
    // Vite types a glob loader as `() => Promise<unknown>`; every page module
    // matched here exports `metadata`, and the assertions below read it.
    load as () => Promise<{ metadata: Metadata }>,
  ]),
);

function loadPage(path: string): () => Promise<{ metadata: Metadata }> {
  const load = PAGE_MODULES.get(path);
  if (load === undefined) {
    throw new Error(`No page module for '${path}' — known: ${[...PAGE_MODULES.keys()].join(', ')}`);
  }
  return load;
}

const FIXED_PAGES: { path: string; title: string; noindex: boolean }[] = [
  { path: '(public)/features', title: 'Features', noindex: false },
  { path: '(public)/forgot-password', title: 'Reset your password', noindex: true },
  { path: '(public)/legal/aup', title: 'Acceptable Use Policy', noindex: false },
  { path: '(public)/legal/cookies', title: 'Cookie Policy', noindex: false },
  { path: '(public)/legal/privacy', title: 'Privacy Policy', noindex: false },
  { path: '(public)/legal/sub-processors', title: 'Sub-processors', noindex: false },
  { path: '(public)/legal/terms', title: 'Terms of Service', noindex: false },
  { path: '(public)/login', title: 'Log in', noindex: true },
  { path: '(public)/privacy', title: 'Privacy Policy', noindex: false },
  { path: '(public)/reset-password', title: 'Set a new password', noindex: true },
  { path: '(public)/security', title: 'Security', noindex: false },
  { path: '(public)/signup', title: 'Sign up', noindex: true },
  { path: '(public)/signup/check-email', title: 'Check your email', noindex: true },
  { path: '(public)/signup/finish', title: 'Finish signup', noindex: true },
  { path: '(public)/terms', title: 'Terms of Service', noindex: false },
  { path: '(public)/u/[token]', title: 'Unsubscribe', noindex: true },
];

const CLEAN_PAGE = `import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Log in', robots: { index: false, follow: false } };

export default function Page() { return null; }
`;

const ROOT_LAYOUT = `import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: { default: 'RepWorth', template: '%s · RepWorth' },
};

export default function RootLayout() { return null; }
`;

describe('page titles do not repeat the brand the root template appends (#1078 B)', () => {
  it('no page metadata title under src/app spells the RepWorth brand suffix', () => {
    // Non-vacuous: the scan really walked the app and really read titles, and
    // layouts other than the brand-owning root really are in scope.
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain(join(APP_ROOT, 'mfa', 'layout.tsx'));
    expect(files).not.toContain(join(APP_ROOT, 'layout.tsx'));
    expect(files.flatMap((file) => metadataTitles(file, APP_ROOT)).length).toBeGreaterThan(20);

    expect(
      describeOffenders(findOffenders(files, APP_ROOT)),
      "src/app/layout.tsx already appends ' · RepWorth' via title.template — "
      + 'each page below must carry a BARE name.',
    ).toEqual([]);
  });

  it('the title guard names every offending file and its title when it fails', () => {
    // Run against a fixture tree rather than a real regression, so the reporting
    // stays proven once the tree is clean — but run the REAL `findOffenders`, so
    // the file and the title it reports are both asserted.
    const described = scanFixture({
      'src/app/layout.tsx': ROOT_LAYOUT,
      'src/app/(public)/clean/page.tsx': CLEAN_PAGE,
      'src/app/(public)/login/page.tsx':
        "export const metadata = { title: 'Log in · RepWorth' };\n",
      'src/app/(public)/terms/page.tsx':
        "export const metadata = { title: 'Terms of Service | RepWorth' };\n",
    });

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
    // A brand PREFIX passes — the deliberate limit #1102 records. No page in
    // the tree spells one today.
    expect(ENDS_WITH_BRAND.test('RepWorth in the press')).toBe(false);
  });

  it('catches the page-17 spellings that are not a quoted literal after title:', () => {
    // None of these exist in the tree today, which is exactly why the scan was
    // blind to them: `generateMetadata` is the standard API for a dynamic
    // segment and the likeliest shape the seventeenth page uses.
    const described = scanFixture({
      'src/app/layout.tsx': ROOT_LAYOUT,
      'src/app/(public)/a-generate/[slug]/page.tsx': `import type { Metadata } from 'next';

export async function generateMetadata(
  { params }: { params: Promise<{ slug: string }> },
): Promise<Metadata> {
  const { slug } = await params;
  return { title: \`\${slug} · RepWorth\` };
}
`,
      'src/app/(public)/b-imported/page.tsx': `import { PAGE_TITLE } from '@/lib/seo/titles';

export const metadata = { title: PAGE_TITLE };
`,
      'src/lib/seo/titles.ts': "export const PAGE_TITLE = 'Imported · RepWorth';\n",
      'src/app/(public)/c-relative/page.tsx': `import { LOCAL_TITLE } from './titles';

export const metadata = { title: LOCAL_TITLE };
`,
      'src/app/(public)/c-relative/titles.ts': "export const LOCAL_TITLE = 'Relative · RepWorth';\n",
      'src/app/(public)/d-same-file/page.tsx': `const OWN_TITLE = 'Same file · RepWorth';

export const metadata = { title: OWN_TITLE, description: OWN_TITLE };
`,
      'src/app/(public)/e-title-object/page.tsx':
        "export const metadata = { title: { default: 'Object · RepWorth' } };\n",
      // Clean, and must stay clean: an unreadable specifier resolves to nothing
      // rather than guessing, and a brand PREFIX is outside the predicate (#1102).
      'src/app/(public)/f-external/page.tsx': `import { SOME_TITLE } from 'some-package';

export const metadata = { title: SOME_TITLE };
`,
      'src/app/(public)/g-prefix/page.tsx':
        "export const metadata = { title: 'RepWorth in the press' };\n",
    });

    expect(described).toEqual([
      "src/app/(public)/a-generate/[slug]/page.tsx → title: '${slug} · RepWorth'",
      "src/app/(public)/b-imported/page.tsx → title: 'Imported · RepWorth'",
      "src/app/(public)/c-relative/page.tsx → title: 'Relative · RepWorth'",
      "src/app/(public)/d-same-file/page.tsx → title: 'Same file · RepWorth'",
      "src/app/(public)/e-title-object/page.tsx → title: 'Object · RepWorth'",
    ]);
  });

  it('scans nested layouts but not the root layout that owns the template', () => {
    // The root layout's own title object would read as two offenders
    // ('RepWorth' and '%s · RepWorth') if it were in scope; a nested layout
    // titles its whole subtree and doubles the brand exactly like a page.
    const described = scanFixture({
      'src/app/layout.tsx': ROOT_LAYOUT,
      'src/app/(public)/clean/page.tsx': CLEAN_PAGE,
      'src/app/mfa/layout.tsx':
        "export const metadata = { title: 'Security check · RepWorth' };\n",
    });

    expect(described).toEqual([
      "src/app/mfa/layout.tsx → title: 'Security check · RepWorth'",
    ]);
  });

  it('leaves openGraph and twitter titles alone, which the root template never rewrites', () => {
    // `title.template` applies to `metadata.title` only, so a correct per-page
    // OG title HAS to spell the brand. Flagging it would fight the deferred OG
    // work — while the real `title:` beside it stays in scope.
    const described = scanFixture({
      'src/app/layout.tsx': ROOT_LAYOUT,
      'src/app/(public)/a-og-only/page.tsx': `export const metadata = {
  title: 'Pricing',
  openGraph: { title: 'Pricing · RepWorth', description: 'Plans { and } prices' },
  twitter: { title: 'Pricing · RepWorth' },
};
`,
      'src/app/(public)/b-og-and-page/page.tsx': `export const metadata = {
  title: 'Features · RepWorth',
  openGraph: { title: 'Features · RepWorth' },
};
`,
    });

    expect(described).toEqual([
      "src/app/(public)/b-og-and-page/page.tsx → title: 'Features · RepWorth'",
    ]);
  });

  it.each(FIXED_PAGES)(
    'src/app/$path/page.tsx exports the bare title $title and keeps its robots directive',
    async ({ path, title, noindex }) => {
      const { metadata } = await loadPage(path)();

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

  it('the landing page title leaves the brand to the root template (#1102)', async () => {
    // The predicate is suffix-only by design, so the landing page's former
    // `'RepWorth: …'` PREFIX passed the scan while the tab still read
    // 'RepWorth: … · RepWorth'. The predicate stays as it is; this pins the one
    // page in the tree that used the allowance.
    const { metadata } = await loadPage('(public)')();

    expect(metadata.title).toBe('The AI agent team for your reputation');
    expect(String(metadata.title)).not.toMatch(/RepWorth/);
    expect(metadata.robots).toBeUndefined();
  });

  it('the resolved-value table covers every page this change edited', () => {
    // A hand-written table can only rot in one direction: silently losing a
    // page. `allowed_edit_surface` fixed the count at sixteen.
    expect(FIXED_PAGES).toHaveLength(16);
    expect(new Set(FIXED_PAGES.map(({ path }) => path)).size).toBe(16);

    // And every row's path really addresses a module, so `path` is the loader
    // rather than a decorative label beside one.
    expect(PAGE_MODULES.size).toBeGreaterThan(16);
    for (const { path } of FIXED_PAGES) {
      expect(() => loadPage(path), `row '${path}' addresses no page module`).not.toThrow();
    }
    // …and a path that addresses nothing fails loudly rather than silently
    // skipping the row it was supposed to check.
    expect(() => loadPage('(public)/no-such-page')).toThrow(/No page module/);
  });
});
