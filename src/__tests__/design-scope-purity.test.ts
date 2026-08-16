import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cssDeclarations,
  cssFilesUnder,
  cssVarReferences,
  readCss,
  stripCssComments,
  themeInlineBlock,
} from './helpers/css-tokens';

// Three-tier design system — scope purity guards.
// Spec: docs/superpowers/specs/2026-08-16-design-system-three-tier-design.md §2.7
// Router: docs/design/README.md
//
// RepWorth ships three visual systems, one per surface family, and the whole
// point of the arrangement is that redesigning one touches exactly one doc +
// one token file + one `@theme` block + the components under one selector.
// These two guards are what make "the other two were not touched" checkable:
//
//   1. Landing declares only `--rw-lp-*`  — it cannot grow a fourth palette or
//      re-declare an Island name under the `.rw-lp` scope.
//   2. The Island `@theme` block references only Island tokens — the Console's
//      utilities cannot creep back into globals.css, which is where they lived
//      until this change.
//
// The Console half of the contract (no Island color or font token re-declared
// in tokens.css; theme.css references only tokens.css tokens) lives in
// design-token-single-source.test.ts, beside the collision it descends from.

const GLOBALS = 'src/app/globals.css';
const LANDING_DIR = 'src/components/sections/landing';
const ISLAND_PAGE_DIR = 'src/app/(public)/_styles';
const CONSOLE_THEME_IMPORT = "@import './(authenticated)/_styles/theme.css';";

// The four Island page-CSS files, in the order globals.css must `@import` them
// — which is the order these blocks sat in inside globals.css before PR 3b
// split them out. See the closing comment in globals.css.
const ISLAND_PAGE_IMPORTS = [
  "@import './(public)/_styles/island.css';",
  "@import './(public)/_styles/features.css';",
  "@import './(public)/_styles/how-it-works.css';",
  "@import './(public)/_styles/pricing.css';",
] as const;

// Custom properties the page CSS is allowed to DECLARE despite the `--rw-`
// prefix: element-scoped locals that predate the split, not palette tokens.
// The list is closed — a new `--rw-*` declaration in page CSS is a finding, not
// a reason to extend it.
const PAGE_LOCAL_PROPERTIES: Record<string, readonly string[]> = {
  [`${ISLAND_PAGE_DIR}/island.css`]: ['--rw-marquee-speed'], // animation knob on .rw-landing
  [`${ISLAND_PAGE_DIR}/pricing.css`]: ['--rw-vh-night'], // local on the unused .rw-video-hero
};

describe('design scope purity: Landing declares only --rw-lp-* custom properties', () => {
  const landingCssFiles = cssFilesUnder(LANDING_DIR);

  it('finds the Landing token files to audit', () => {
    // A walk that silently returns nothing would make every assertion below
    // vacuously true, so the file list is asserted before it is used.
    expect(landingCssFiles).toContain(`${LANDING_DIR}/landing-experience.css`);
    expect(landingCssFiles).toContain(`${LANDING_DIR}/hero/hero.css`);
    expect(landingCssFiles.length).toBeGreaterThan(2);
  });

  it.each(cssFilesUnder(LANDING_DIR))('%s declares only --rw-lp-* tokens', (file) => {
    const foreign = [...cssDeclarations(readCss(file)).keys()].filter(
      (token) => !token.startsWith('--rw-lp-'),
    );

    expect(
      foreign,
      `${file} declares ${foreign.join(', ')}. Landing is scoped to \`.rw-lp\` and owns the ` +
        `--rw-lp-* namespace only (docs/design/landing/DESIGN.md). A non-prefixed declaration ` +
        `here either shadows an Island token or starts a fourth palette.`,
    ).toEqual([]);
  });
});

describe('design scope purity: the Island @theme block holds Island entries only', () => {
  const globals = readCss(GLOBALS);
  const islandTheme = themeInlineBlock(globals);
  // Declarations made anywhere in globals.css EXCEPT inside the @theme block —
  // i.e. the Island `:root` export the block is allowed to reference.
  const islandTokens = cssDeclarations(globals.replace(islandTheme, ''));

  it('imports the Console @theme file so the Console utilities cannot vanish silently', () => {
    // Tailwind v4 bundles local `@import`s itself and reads `@theme` across
    // them. Drop this line and the Console utilities stop generating — with no
    // build error, because nothing else references the file.
    expect(
      globals.includes(CONSOLE_THEME_IMPORT),
      `${GLOBALS} must contain \`${CONSOLE_THEME_IMPORT}\``,
    ).toBe(true);
  });

  it('references only tokens declared in globals.css itself', () => {
    const foreign = cssVarReferences(islandTheme).filter((token) => !islandTokens.has(token));

    expect(
      foreign,
      `The @theme inline block in ${GLOBALS} references ${foreign.join(', ')}, which ${GLOBALS} ` +
        `does not declare. Console utilities belong in ` +
        `src/app/(authenticated)/_styles/theme.css, beside the tokens.css values they name ` +
        `(docs/design/README.md rule 2).`,
    ).toEqual([]);
  });

  it('names no Console token, so a Console overhaul never edits the Island file', () => {
    const consoleTokens = cssDeclarations(readCss('src/app/(authenticated)/_styles/tokens.css'));
    const leaked = cssVarReferences(islandTheme).filter((token) => consoleTokens.has(token));

    expect(leaked, `${GLOBALS} @theme references Console-owned ${leaked.join(', ')}`).toEqual([]);
  });
});

// PR 3b moved ~2,400 lines of marketing page CSS out of globals.css into
// (public)/_styles/. Two things have to stay true for that to be a pure move:
// the page files must consume tokens rather than declare them, and globals.css
// must pull them back in, in the original order, as CSS `@import`s.
describe('design scope purity: Island page CSS consumes tokens, never declares them', () => {
  const pageCssFiles = cssFilesUnder(ISLAND_PAGE_DIR);

  it('finds the four Island page-CSS files to audit', () => {
    // A walk that silently returned nothing would make the assertions below
    // vacuously true, so the file list is asserted before it is used.
    expect(pageCssFiles.sort()).toEqual([
      `${ISLAND_PAGE_DIR}/features.css`,
      `${ISLAND_PAGE_DIR}/how-it-works.css`,
      `${ISLAND_PAGE_DIR}/island.css`,
      `${ISLAND_PAGE_DIR}/pricing.css`,
    ]);
  });

  it.each(cssFilesUnder(ISLAND_PAGE_DIR))('%s declares no --rw-* token', (file) => {
    const allowed = PAGE_LOCAL_PROPERTIES[file] ?? [];
    const declared = [...cssDeclarations(readCss(file)).keys()].filter(
      (token) => token.startsWith('--rw-') && !allowed.includes(token),
    );

    expect(
      declared,
      `${file} declares ${declared.join(', ')}. Island tokens have ONE owner, the \`:root\` ` +
        `block in ${GLOBALS}; page CSS consumes them with var(). If the new property is an ` +
        `element-scoped local rather than a palette token, that is a design decision to make ` +
        `deliberately, not by adding a name to PAGE_LOCAL_PROPERTIES on reflex.`,
    ).toEqual([]);
  });
});

describe('design scope purity: globals.css owns the Island page-CSS load order', () => {
  const globals = stripCssComments(readCss(GLOBALS));

  it('imports the four page-CSS files in the order their blocks had inside globals.css', () => {
    const positions = ISLAND_PAGE_IMPORTS.map((line) => [line, globals.indexOf(line)] as const);
    const missing = positions.filter(([, at]) => at === -1).map(([line]) => line);

    expect(missing, `${GLOBALS} is missing ${missing.join(', ')}`).toEqual([]);
    expect(
      positions.map(([, at]) => at),
      `The four \`@import\`s in ${GLOBALS} are out of order. Tailwind inlines each file where ` +
        `its \`@import\` sits, so the order IS the cascade: island → features → how-it-works → ` +
        `pricing, exactly as those blocks were sequenced before PR 3b split them out.`,
    ).toEqual([...positions.map(([, at]) => at)].sort((a, b) => a - b));
  });

  it('imports them AFTER the :root token block, not at the top of the file', () => {
    const rootAt = globals.indexOf(':root {');
    expect(rootAt).toBeGreaterThan(-1);
    for (const line of ISLAND_PAGE_IMPORTS) {
      expect(
        globals.indexOf(line),
        `${line} must come after the \`:root\` block — hoisting it would move ~2,400 lines of ` +
          `page CSS ahead of the token and \`@theme\` blocks and change the cascade.`,
      ).toBeGreaterThan(rootAt);
    }
  });

  it('does not let layout.tsx import the page CSS instead', () => {
    // Load-bearing, and invisible in the source: a CSS `@import` keeps these
    // files inside the Tailwind entry, so `@tailwindcss/postcss` runs its
    // Lightning CSS pass over them. Imported from layout.tsx they become
    // separate stylesheets the plugin skips, and 47 of the
    // `@supports (color: color-mix(…))` fallbacks it generates stop being
    // emitted — a silent loss of the flat-colour fallback on browsers without
    // `color-mix()`. Measured on this tree; see the globals.css comment.
    const layout = readFileSync(resolve(process.cwd(), 'src/app/layout.tsx'), 'utf-8');
    expect(
      layout.includes('(public)/_styles'),
      'src/app/layout.tsx must not import the Island page CSS — globals.css `@import`s it so ' +
        'Tailwind still processes it. See the closing comment in src/app/globals.css.',
    ).toBe(false);
  });
});
