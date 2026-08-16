import { describe, expect, it } from 'vitest';
import {
  cssDeclarations,
  cssFilesUnder,
  cssVarReferences,
  readCss,
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
const CONSOLE_THEME_IMPORT = "@import './(authenticated)/_styles/theme.css';";

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
