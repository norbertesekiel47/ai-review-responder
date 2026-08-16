// scripts/ci/directory-map-audit.ts
//
// Keeps docs/directory.md honest for the two surfaces where "does a helper
// already exist?" decides whether a new file is a duplicate: `worker/` and
// `src/lib/`. The map calls itself the source of truth for file paths, and the
// "no new file — check docs/directory.md first" rule assumes it is complete;
// nothing enforced that, so by 2026-08-16 it was missing 178 production files
// under those two roots (all 11 account-offboarding workers, 18 of 19
// publisher helpers, and root modules that CLAUDE.md names by hand).
//
// Two checks, no baseline:
//   1. COVERAGE — every production `.ts`/`.tsx` under SCAN_DIRS (walk defaults:
//      `__tests__/` and `*.test.*` excluded) must be named by at least one ROW.
//   2. STALENESS — every row that resolves under SCAN_DIRS must name a file
//      that exists (a rename or delete must fix its row in the same change).
//
// What counts as a ROW (deliberately narrow — prose is not a row):
//   - a Markdown table row whose FIRST cell holds one or more code spans that
//     name a file: `x.ts`, `sub/x.ts`, `worker/x.ts`, or the brace form
//     `{a,b}.ts` (expanded); or
//   - a heading whose code span names a file (`### \`worker/env.ts\``).
//   A cross-reference inside a description ("shared with `dispatch.ts`") does
//   not count, so a helper mentioned in passing under another folder's table
//   cannot satisfy coverage for — or be flagged stale against — the wrong path.
//
// How a row's path resolves — against its SECTION:
//   - a heading's first code span is its folder token; `## \`src/lib/\`` is
//     absolute, deeper headings resolve relative to the nearest ancestor
//     heading that has a path (`### \`db/\`` → `src/lib/db/`) unless the token
//     itself starts with `src/` or `worker/` (`#### \`worker/jobs/publisher/\``);
//   - a heading with no code span opens a section with NO path — rows in it
//     count only when spelled absolutely;
//   - a row span starting with `src/` or `worker/` is absolute; anything else
//     is joined onto the section folder.
//
// Scope is `worker/` + `src/lib/` on purpose: `src/app/**` is route files the
// framework names, `src/components/**` is ~135 presentational components, and
// both are folder-level in the map by design. Widening is a SCAN_DIRS edit.
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { walk } from './lib/ratchet-harness';

const MAP_PATH = 'docs/directory.md';
const SCAN_DIRS = ['worker', 'src/lib'] as const;

/** A path token in a heading or row cell — the file/folder shapes the map uses. */
const PATH_TOKEN = /^[\w@().[\]{},/-]+$/;
const FILE_TOKEN = /\.(?:ts|tsx)$/;
const CODE_SPAN = /`([^`]+)`/g;
const HEADING = /^(#{2,4})\s+(.*)$/;
const ABSOLUTE_PREFIX = /^(?:src|worker)\//;

export interface MappedRow {
  /** Repo-relative path the row resolves to. */
  path: string;
  /** 1-based line in docs/directory.md. */
  line: number;
}

/** `{a,b}.ts` → `[a.ts, b.ts]`; a token with no braces is returned as-is. */
export function expandBraces(token: string): string[] {
  const match = /^([^{}]*)\{([^{}]+)\}([^{}]*)$/.exec(token);
  if (!match) return [token];
  const [, head, body, tail] = match as unknown as [string, string, string, string];
  return body.split(',').map((part) => `${head}${part.trim()}${tail}`);
}

/** True for tokens that never count: the test lane is out of scope. */
function isTestToken(token: string): boolean {
  return token.includes('__tests__') || /\.(?:test|spec)\./.test(token);
}

/** A row/heading token → repo-relative path, or null when it cannot resolve. */
function resolveToken(token: string, sectionDir: string | null): string | null {
  if (!FILE_TOKEN.test(token) || isTestToken(token)) return null;
  if (ABSOLUTE_PREFIX.test(token)) return token;
  return sectionDir === null ? null : `${sectionDir}${token}`;
}

/** The path-shaped code spans in a cell or heading, brace-expanded. */
function pathTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const [, raw] of text.matchAll(CODE_SPAN)) {
    const span = raw!.trim();
    if (PATH_TOKEN.test(span)) tokens.push(...expandBraces(span));
  }
  return tokens;
}

/**
 * The file paths named by code spans in one cell/heading, resolved against
 * `sectionDir` (a folder path with trailing slash, or null). Globs, test
 * paths and non-path spans are skipped: `*` is a glob, `__tests__`/`.test.`
 * are the test lane (out of scope), and `handleCsvIngest` is not a path.
 */
function pathsInText(text: string, sectionDir: string | null): string[] {
  const out: string[] = [];
  for (const token of pathTokens(text)) {
    const path = resolveToken(token, sectionDir);
    if (path !== null) out.push(path);
  }
  return out;
}

/** The first path-shaped code span in a heading, or null. */
function headingToken(text: string): string | null {
  return pathTokens(text)[0] ?? null;
}

/**
 * The folder a heading's token resolves to (trailing slash), against the
 * nearest ancestor path. A file token (`worker/env.ts`) resolves to its
 * dirname so relative rows in its body still land beside it.
 */
function resolveHeadingDir(token: string, parentDir: string | null): string {
  const joined = ABSOLUTE_PREFIX.test(token) || parentDir === null ? token : `${parentDir}${token}`;
  if (FILE_TOKEN.test(joined)) {
    const dir = dirname(joined);
    return dir === '.' ? '' : `${dir}/`;
  }
  return joined.endsWith('/') ? joined : `${joined}/`;
}

interface HeadingFrame {
  level: number;
  /** null when the heading has no path token. */
  dir: string | null;
}

/** The nearest enclosing heading path, or null when no ancestor has one. */
function nearestDir(stack: readonly HeadingFrame[]): string | null {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const dir = stack[index]!.dir;
    if (dir !== null) return dir;
  }
  return null;
}

/**
 * Push a heading onto the stack (popping siblings/descendants first) and
 * return the base its OWN spans resolve against. A heading naming a file IS a
 * row (`### \`worker/env.ts\``) and resolves against its parent — its dir is
 * derived FROM that file; a folder heading resolves against itself.
 */
function pushHeading(stack: HeadingFrame[], level: number, text: string): string | null {
  while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
  const parentDir = nearestDir(stack);
  const token = headingToken(text);
  const dir = token === null ? null : resolveHeadingDir(token, parentDir);
  stack.push({ level, dir });
  return token !== null && FILE_TOKEN.test(token) ? parentDir : dir;
}

/**
 * The first cell of a table row (between the leading `|` and the next `|`),
 * or null for non-rows and header-separator rows.
 */
function firstCell(line: string): string | null {
  if (!line.startsWith('|')) return null;
  const cellEnd = line.indexOf('|', 1);
  if (cellEnd === -1) return null;
  const cell = line.slice(1, cellEnd);
  return /^\s*:?-+:?\s*$/.test(cell) ? null : cell;
}

/**
 * The base a table row resolves against: null when the innermost heading has
 * no path (only absolute rows count there), else the nearest enclosing path.
 */
function rowBase(stack: readonly HeadingFrame[]): string | null {
  const innermost = stack[stack.length - 1];
  return innermost !== undefined && innermost.dir === null ? null : nearestDir(stack);
}

/**
 * Every ROW in the map, resolved to a repo-relative path. Pure — unit-tested.
 * Duplicates are kept (two rows may name one file; coverage is a set check).
 */
export function parseDirectoryMap(text: string): MappedRow[] {
  const rows: MappedRow[] = [];
  const stack: HeadingFrame[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const heading = HEADING.exec(line);
    const source = heading ? heading[2]! : firstCell(line);
    if (source === null) continue;
    const base = heading ? pushHeading(stack, heading[1]!.length, source) : rowBase(stack);
    for (const path of pathsInText(source, base)) rows.push({ path, line: index + 1 });
  }
  return rows;
}

export interface EvaluateInput {
  /** Production files under SCAN_DIRS (repo-relative). */
  files: ReadonlySet<string>;
  /** Every row the map resolves to. */
  rows: readonly MappedRow[];
  /** True when the repo-relative path exists as a file. */
  exists: (path: string) => boolean;
}

/** True when `path` sits under one of SCAN_DIRS. */
export function isInScope(path: string): boolean {
  return SCAN_DIRS.some((dir) => path.startsWith(`${dir}/`));
}

/**
 * Coverage + staleness findings. Pure — unit-tested. A file with no row is
 * an UNMAPPED finding; a row under SCAN_DIRS whose file is absent is a STALE
 * finding. Rows outside SCAN_DIRS are never judged (the map may describe
 * `src/app/**` at folder level and mention non-existent illustrative paths).
 */
export function evaluateFindings(input: EvaluateInput): string[] {
  const findings: string[] = [];
  const mapped = new Set(input.rows.map((row) => row.path));
  for (const file of [...input.files].sort()) {
    if (mapped.has(file)) continue;
    findings.push(
      `${file} has no row in ${MAP_PATH} — add a \`| \`${file.split('/').pop()}\` | … |\` row under the section for its folder (${dirname(file)}/), or if the folder has no section yet, add one. The map is CI-complete for worker/ + src/lib/.`,
    );
  }
  const seenStale = new Set<string>();
  for (const row of input.rows) {
    if (!isInScope(row.path) || input.exists(row.path) || seenStale.has(row.path)) continue;
    seenStale.add(row.path);
    findings.push(
      `${MAP_PATH}:${row.line} names ${row.path}, which does not exist — the file was renamed or deleted; fix or remove the row.`,
    );
  }
  return findings;
}

export async function collectFiles(root: string): Promise<Set<string>> {
  return new Set(await walk(root, { scanDirs: SCAN_DIRS }));
}

/** True when `path` is an existing regular file (any stat error → false). */
function isFile(path: string): Promise<boolean> {
  return stat(path).then((s) => s.isFile(), () => false);
}

/**
 * One existence probe per distinct IN-SCOPE row path (rows outside SCAN_DIRS
 * are never judged, so they are never stat'ed). Returns a lookup for
 * `evaluateFindings`. Unit-tested against real repo paths.
 */
export async function collectRowExistence(
  root: string,
  rows: readonly MappedRow[],
): Promise<(path: string) => boolean> {
  const existence = new Map<string, boolean>();
  for (const row of rows) {
    if (!isInScope(row.path) || existence.has(row.path)) continue;
    existence.set(row.path, await isFile(resolve(root, row.path)));
  }
  return (path) => existence.get(path) ?? false;
}

async function main(): Promise<void> {
  const root = process.cwd();
  const [files, mapText] = await Promise.all([collectFiles(root), readFile(resolve(root, MAP_PATH), 'utf8')]);
  const rows = parseDirectoryMap(mapText);
  const exists = await collectRowExistence(root, rows);
  const findings = evaluateFindings({ files, rows, exists });
  if (findings.length > 0) {
    console.error(`directory-map-audit: failed (${findings.length})`);
    for (const finding of findings) console.error(`  ${finding}`);
    process.exit(1);
  }
  console.log(
    `directory-map-audit: passed (${files.size} files under ${SCAN_DIRS.join(', ')} each have a row in ${MAP_PATH}; no stale rows)`,
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((err) => {
    console.error('directory-map-audit: fatal error');
    console.error(err);
    process.exit(1);
  });
}
