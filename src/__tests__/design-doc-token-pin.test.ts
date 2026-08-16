import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cssDeclarations,
  cssFilesUnder,
  mergeDeclarations,
  normalizeCssValue,
  readCss,
} from './helpers/css-tokens';

// Doc ↔ code token pin (spec §2.7, decision D2 option A).
// Spec: docs/superpowers/specs/2026-08-16-design-system-three-tier-design.md
//
// Each system's Style Reference restates its tokens in markdown tables so the
// doc is readable. The README's first cross-system rule is that the token file
// — never the doc — is the source of truth; this test is what makes that true
// rather than aspirational. For every table row in a `DESIGN.md`:
//
//   · every `--rw-*` it names must be DECLARED in that system's token file(s);
//   · when the table has both a `Value` and a `Token` column, the value beside
//     the token must match the declaration.
//
// D2 rejected option B (generating the tables from CSS between markers). This
// is the cheap half: the tables stay hand-written and readable, and drift is a
// failing test instead of a wrong doc.

const GLOBALS = 'src/app/globals.css';
const CONSOLE_TOKENS = 'src/app/(authenticated)/_styles/tokens.css';
const CONSOLE_SCOPED = 'src/app/(authenticated)/_styles/console.css';
const LANDING_DIR = 'src/components/sections/landing';

// The font FAMILIES are brand-wide, not per-system: globals.css is their single
// owner and loads on every route, so a system doc may name `--rw-font-*` in its
// Families table without declaring it. The Console's Families table does
// exactly that — and its mono row points at the `.rw-console` override in
// console.css, which is why that file joins the Console's declaration set.
const BRAND_FONT_PREFIX = '--rw-font-';

const SYSTEMS = [
  {
    name: 'landing',
    doc: 'docs/design/landing/DESIGN.md',
    tokenFiles: cssFilesUnder(LANDING_DIR),
  },
  { name: 'island', doc: 'docs/design/island/DESIGN.md', tokenFiles: [GLOBALS] },
  {
    name: 'console',
    doc: 'docs/design/console/DESIGN.md',
    tokenFiles: [CONSOLE_TOKENS, CONSOLE_SCOPED],
  },
] as const;

const brandFontDeclarations = cssDeclarations(readCss(GLOBALS));

type TableRow = {
  /** The row's first cell — what the failure message quotes back. */
  label: string;
  cells: string[];
  header: string[];
};

/** Backtick-quoted spans in a markdown cell, backticks stripped. */
const codeSpans = (cell: string): string[] =>
  [...cell.matchAll(/`([^`]+)`/g)].map(([, span]) => span!);

const tokensIn = (cell: string): string[] =>
  codeSpans(cell).flatMap((span) => [...span.matchAll(/--rw-[a-z0-9-]+/g)].map(([token]) => token));

/**
 * Every data row of every markdown table in `markdown`, carrying its header so
 * a caller can ask which columns the table has. Fenced code blocks are skipped
 * — the Island doc's `tsx` recipes contain lines a naive parser would eat.
 */
const tableRows = (markdown: string): TableRow[] => {
  const lines = markdown.split('\n');
  const rows: TableRow[] = [];
  let header: string[] | null = null;
  let fenced = false;

  const cellsOf = (line: string): string[] =>
    line
      .trim()
      .slice(1, -1)
      .split('|')
      .map((cell) => cell.trim());

  for (const [index, line] of lines.entries()) {
    if (line.trimStart().startsWith('```')) {
      fenced = !fenced;
      continue;
    }
    const trimmed = line.trim();
    const isRow = !fenced && trimmed.startsWith('|') && trimmed.endsWith('|');
    if (!isRow) {
      header = null;
      continue;
    }
    const cells = cellsOf(trimmed);
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue; // separator

    const next = lines[index + 1]?.trim() ?? '';
    const nextIsSeparator =
      next.startsWith('|') &&
      next.endsWith('|') &&
      cellsOf(next).every((cell) => /^:?-{3,}:?$/.test(cell));
    if (nextIsSeparator) {
      header = cells;
      continue;
    }
    if (header) rows.push({ label: cells[0] ?? '', cells, header });
  }
  return rows;
};

const columnIndex = (header: string[], name: string): number =>
  header.findIndex((cell) => cell.toLowerCase() === name);

describe.each(SYSTEMS)('doc ↔ code token pin: $name', ({ doc, tokenFiles }) => {
  const declarations = mergeDeclarations(tokenFiles.map((file) => readCss(file)));
  const rows = tableRows(readFileSync(resolve(process.cwd(), doc), 'utf-8'));
  const filesLabel = tokenFiles.join(' + ');

  const declaredValues = (token: string): string[] | undefined =>
    declarations.get(token) ??
    (token.startsWith(BRAND_FONT_PREFIX) ? brandFontDeclarations.get(token) : undefined);

  it('parses the Style Reference into table rows', () => {
    // Guards against a parser change quietly turning every assertion below into
    // a no-op. Row counts at the time of writing: landing 22, island 77,
    // console 97 — 196 across the three.
    expect(rows.length).toBeGreaterThan(15);
    expect(tokenFiles.length).toBeGreaterThan(0);
  });

  it('names only tokens that exist in the system token file(s)', () => {
    const missing = rows.flatMap((row) =>
      [...new Set(row.cells.flatMap(tokensIn))]
        .filter((token) => declaredValues(token) === undefined)
        .map((token) => `${doc} row "${row.label}" names ${token} which is not declared in ${filesLabel}`),
    );

    expect(missing, missing.join('\n')).toEqual([]);
  });

  it('restates values that match the declaration', () => {
    const mismatched = rows.flatMap((row) => {
      const valueIndex = columnIndex(row.header, 'value');
      const tokenIndex = columnIndex(row.header, 'token');
      if (valueIndex === -1 || tokenIndex === -1) return []; // existence-only table

      const tokens = tokensIn(row.cells[tokenIndex] ?? '');
      if (tokens.length === 0) return []; // e.g. a `—` / utility-class row

      // The value is the first code span in the Value cell that is not itself a
      // token name, minus a trailing "(Npx)" reading aid.
      const documented = codeSpans(row.cells[valueIndex] ?? '')
        .find((span) => !/^--rw-[a-z0-9-]+$/.test(span.trim()));
      if (documented === undefined) return []; // no value stated — existence only

      const expected = normalizeCssValue(documented).replace(/\s*\(\d+px\)$/, '');
      const matches = tokens.some((token) =>
        (declaredValues(token) ?? []).some((declared) => {
          const actual = normalizeCssValue(declared);
          // `startsWith` because a composite `font:` shorthand or a gradient is
          // long and the doc is allowed to abbreviate its tail.
          return actual === expected || actual.startsWith(expected);
        }),
      );
      if (matches) return [];

      const declared = tokens
        .map((token) => `${token} = ${(declaredValues(token) ?? ['<undeclared>']).join(' | ')}`)
        .join('; ');
      return [`${doc} row "${row.label}" value "${documented}" ≠ declared ${declared}`];
    });

    expect(mismatched, mismatched.join('\n')).toEqual([]);
  });
});
