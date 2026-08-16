import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Shared CSS-token parsing for the `design-*.test.ts` guards. Three suites read
// the same four files (globals.css, tokens.css, theme.css, the landing CSS) and
// need the same three questions answered — what does this file DECLARE, what
// does it REFERENCE, and what is inside its `@theme inline` block — so the
// parsing lives here rather than three times over.

export const readCss = (relativePath: string): string =>
  readFileSync(resolve(process.cwd(), relativePath), 'utf-8');

/**
 * Drop `/* … *\/` comments, so a token merely NAMED in prose is never read as a
 * declaration or a reference. Every helper below runs on the stripped text.
 */
export const stripCssComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Every custom-property DECLARATION in `css`, as name → the values declared for
 * it. A token can legitimately be declared more than once (a base value plus a
 * media-query override — `--rw-lp-edge` is), so the value is a list.
 *
 * Deliberately NOT line-anchored. `design-token-single-source.test.ts` matches
 * `^\s*<token>\s*:`, which silently misses the six Console spacing tokens
 * tokens.css writes three-per-line (`--rw-sp-2`, `-3`, `-6`, `-8`, `-16`,
 * `-20`) — a matcher that cannot see a declaration cannot guard it.
 *
 * `var(--x)` is not matched: a reference has `)` or `,` after the name, never
 * the `:` this pattern requires.
 */
export const cssDeclarations = (css: string): Map<string, string[]> => {
  const declarations = new Map<string, string[]>();
  for (const [, name, value] of stripCssComments(css).matchAll(
    /(--[A-Za-z0-9_-]+)\s*:\s*([^;}]+)[;}]/g,
  )) {
    const existing = declarations.get(name!);
    if (existing) existing.push(value!.trim());
    else declarations.set(name!, [value!.trim()]);
  }
  return declarations;
};

/**
 * The same declarations, grouped by the selector of the FLAT rule block they
 * sit in (whitespace in the selector collapsed). Deliberately flat: it assumes
 * no nested braces, which holds for a token file and is what keeps the parser
 * honest about what it can see — an `@media`/`@theme` wrapper would be reported
 * as one selector, not silently unwrapped.
 *
 * This is what lets a guard ask *where* a token is declared, not just whether:
 * the Console's tokens must sit inside `.rw-console`, never `:root` (spec D4).
 */
export const declarationsBySelector = (css: string): Map<string, Map<string, string[]>> => {
  const bySelector = new Map<string, Map<string, string[]>>();
  for (const [, selector, body] of stripCssComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const key = selector!.trim().replace(/\s+/g, ' ');
    const declarations = bySelector.get(key) ?? new Map<string, string[]>();
    // The captured body has no closing brace, and `cssDeclarations` needs a `;`
    // or `}` terminator to see the last declaration in the block.
    for (const [name, values] of cssDeclarations(`${body!}}`)) {
      declarations.set(name, [...(declarations.get(name) ?? []), ...values]);
    }
    bySelector.set(key, declarations);
  }
  return bySelector;
};

/** Merge several files' declarations into one lookup (system → its token files). */
export const mergeDeclarations = (sources: string[]): Map<string, string[]> => {
  const merged = new Map<string, string[]>();
  for (const css of sources) {
    for (const [name, values] of cssDeclarations(css)) {
      merged.set(name, [...(merged.get(name) ?? []), ...values]);
    }
  }
  return merged;
};

/** Every `var(--x)` name referenced in `css`, in source order, deduplicated. */
export const cssVarReferences = (css: string): string[] => [
  ...new Set(
    [...stripCssComments(css).matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)].map(([, name]) => name!),
  ),
];

/** The body of the file's single `@theme inline { … }` block. */
export const themeInlineBlock = (css: string): string => {
  const block = stripCssComments(css).match(/@theme\s+inline\s*\{([\s\S]*?)\n\}/)?.[1];
  if (block === undefined) throw new Error('No `@theme inline { … }` block found');
  return block;
};

/** Every `.css` file under `dir`, recursively, as repo-relative paths. */
export const cssFilesUnder = (dir: string): string[] => {
  const absolute = resolve(process.cwd(), dir);
  const walk = (current: string): string[] =>
    readdirSync(current)
      .sort()
      .flatMap((entry) => {
        const path = join(current, entry);
        if (statSync(path).isDirectory()) return walk(path);
        return path.endsWith('.css') ? [path.slice(absolute.length - dir.length)] : [];
      });
  return walk(absolute);
};

/** Collapse whitespace + lowercase so a doc value and a CSS value compare fairly. */
export const normalizeCssValue = (value: string): string =>
  value.replace(/`/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
