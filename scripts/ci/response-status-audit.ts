import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { isSqlTaggedTemplate } from './lib/sql-tag-scan';

/**
 * Flags hardcoded response-status GROUP literals — 2+ distinct canonical
 * status values co-located in a JS/TS array literal, or in a SQL
 * `IN (...)` / `ANY (...)` predicate inside a `sql` / `tx` / `db` tagged
 * template — in TS files under `src/`, outside the two exempt modules.
 *
 * Counting/display READ callsites must import the named groups from
 * `@/lib/shared/response-status` and bind them via `statusArraySql()`
 * (`@/lib/shared/response-status-sql`). State-transition write guards and
 * one-off subsets that must stay inline carry a per-line `// status-audit-ignore`
 * (or trailing SQL `-- status-audit-ignore`) pragma — mirroring how the
 * static-policy / tenant-scope audits use explicit, reviewed escape hatches.
 *
 * Single-status equalities (`status === 'approved'`) are never flagged. Scope
 * is `src/` only; `worker/**` is handled in a later stage. Structure mirrors
 * `static-policy-audit.ts`: a pure `scanSource` (unit-tested) + a thin
 * filesystem `main`.
 *
 * SQL detection is scoped to `sql` / `tx` / `db` tagged templates so plain
 * template strings that merely mention statuses (UI copy, log lines) are NOT
 * false-flagged, and it counts canonical values across the WHOLE `IN(...)` / `ANY(...)`
 * predicate (balanced parens) so a group split across `ARRAY[...] || ARRAY[...]`
 * is still caught. Spread composition of array literals
 * (`[...['approved'], 'edited']`) is detected.
 *
 * Known boundary: a group assembled at runtime via `Array.prototype.concat`
 * (`['approved'].concat(['edited'])`) is NOT detected — it is a contrived way
 * to spell a constant group, absent from this codebase, and recognizing
 * arbitrary call-chains is disproportionate for a maintainability guard.
 */

const SCAN_DIR = 'src';
const SCAN_EXT = /\.(?:ts|tsx)$/;
const SKIP_DIRS = new Set(['node_modules', '__tests__', 'dist', '.next', 'coverage']);
const SKIP_FILE = /\.(?:test|spec)\.[cm]?tsx?$/;
const EXEMPT = new Set([
  'src/lib/shared/response-status.ts',
  'src/lib/shared/response-status-sql.ts',
]);
const IGNORE_PRAGMA = 'status-audit-ignore';

// SQL-tag detection (`sql` / `tx` / `db`, incl. property access like
// `sql.unsafe`) is shared with reviews-status-audit.ts and
// outbox-topics-audit.ts via ./lib/sql-tag-scan's isSqlTaggedTemplate — see
// that module for the full tag rationale, including the `db`-named
// SqlExecutor parameter convention this audit now also scans.

const CANONICAL_STATUSES = new Set([
  'pending_approval',
  'approved',
  'edited',
  'superseded',
  'awaiting_owner_connect',
  'posted',
  'failed',
]);

export type ResponseStatusRule = 'response-status-group';

export interface ResponseStatusFinding {
  file: string;
  line: number;
  rule: ResponseStatusRule;
  detail: string;
}

const ARRAY_DETAIL =
  'hardcoded response-status group literal (2+ canonical status values) — ' +
  'import the group from @/lib/shared/response-status and bind it via ' +
  'statusArraySql() for READ predicates. State-transition writes / one-off ' +
  'subsets that must stay inline need a `// status-audit-ignore` pragma.';

const SQL_DETAIL =
  'hardcoded response-status group in a SQL IN()/ANY() predicate — import the ' +
  'group from @/lib/shared/response-status and bind via statusArraySql(); add a ' +
  'trailing `-- status-audit-ignore` for intentionally-inline write guards.';

// Per-file scan context, threaded into the node matchers so each stays a small
// pure function instead of a closure inside one large visitor.
interface ScanContext {
  file: string;
  source: ts.SourceFile;
  lines: string[];
  lineOf: (pos: number) => number;
}

function normalizePath(file: string): string {
  return file.split(sep).join('/');
}

// A single quoted canonical-status literal, e.g. 'approved' or "posted".
const STATUS_LITERAL_RE =
  /(['"])(pending_approval|approved|edited|superseded|awaiting_owner_connect|posted|failed)\1/g;

function distinctCanonicalLiterals(text: string): number {
  const seen = new Set<string>();
  for (const match of text.matchAll(STATUS_LITERAL_RE)) {
    if (match[2]) seen.add(match[2]);
  }
  return seen.size;
}

// Distinct canonical statuses written directly in an array literal, descending
// into spread elements that are themselves array literals
// (`[...['approved'], 'edited']`). A spread of an identifier (`[...GROUP, x]`)
// is intentionally NOT descended — that imports the named group rather than
// re-spelling it inline, which is the desired pattern.
function canonicalInArray(node: ts.ArrayLiteralExpression): Set<string> {
  const seen = new Set<string>();
  for (const element of node.elements) {
    if (ts.isStringLiteral(element) && CANONICAL_STATUSES.has(element.text)) {
      seen.add(element.text);
    } else if (
      ts.isSpreadElement(element) &&
      ts.isArrayLiteralExpression(element.expression)
    ) {
      for (const value of canonicalInArray(element.expression)) seen.add(value);
    }
  }
  return seen;
}

// Each `IN (...)` / `ANY (...)` predicate body (balanced parens) in SQL text,
// with the byte offset of the keyword. Capturing the whole predicate — not each
// `ARRAY[...]` span — means a group split across `ARRAY[...] || ARRAY[...]` is
// counted as one group, while scoping to the predicate avoids miscounting two
// unrelated single-status equalities elsewhere in the same query.
function sqlPredicateGroups(sqlText: string): { body: string; index: number }[] {
  const groups: { body: string; index: number }[] = [];
  const keyword = /\b(?:in|any)\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = keyword.exec(sqlText)) !== null) {
    const open = match.index + match[0].length - 1; // index of '('
    let depth = 0;
    let end = open;
    for (; end < sqlText.length; end++) {
      const ch = sqlText[end];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    groups.push({ body: sqlText.slice(open + 1, end), index: match.index });
  }
  return groups;
}

function lineHasPragma(lines: string[], lineIndex: number): boolean {
  const current = lines[lineIndex] ?? '';
  const previous = lineIndex > 0 ? (lines[lineIndex - 1] ?? '') : '';
  return current.includes(IGNORE_PRAGMA) || previous.includes(IGNORE_PRAGMA);
}

// An array literal that hardcodes a 2+ status group (unless pragma'd).
function arrayFinding(
  node: ts.ArrayLiteralExpression,
  ctx: ScanContext,
): ResponseStatusFinding | null {
  if (canonicalInArray(node).size < 2) return null;
  const line = ctx.lineOf(node.getStart(ctx.source));
  if (lineHasPragma(ctx.lines, line)) return null;
  return { file: ctx.file, line: line + 1, rule: 'response-status-group', detail: ARRAY_DETAIL };
}

// Every hardcoded 2+ status group inside a `sql`/`tx` template's predicates.
function sqlFindings(
  node: ts.TaggedTemplateExpression,
  ctx: ScanContext,
): ResponseStatusFinding[] {
  const raw = node.getText(ctx.source);
  const nodeStart = node.getStart(ctx.source);
  const findings: ResponseStatusFinding[] = [];
  for (const group of sqlPredicateGroups(raw)) {
    if (distinctCanonicalLiterals(group.body) < 2) continue;
    const line = ctx.lineOf(nodeStart + group.index);
    if (lineHasPragma(ctx.lines, line)) continue;
    findings.push({ file: ctx.file, line: line + 1, rule: 'response-status-group', detail: SQL_DETAIL });
  }
  return findings;
}

/** Pure scan of one file's text. Exported for unit tests. */
export function scanSource(file: string, text: string): ResponseStatusFinding[] {
  const normalized = normalizePath(file);
  if (EXEMPT.has(normalized)) return [];

  const source = ts.createSourceFile(
    normalized,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const ctx: ScanContext = {
    file: normalized,
    source,
    lines: text.split('\n'),
    lineOf: (pos) => source.getLineAndCharacterOfPosition(pos).line,
  };

  const findings: ResponseStatusFinding[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isArrayLiteralExpression(node)) {
      const finding = arrayFinding(node, ctx);
      if (finding) findings.push(finding);
    } else if (ts.isTaggedTemplateExpression(node) && isSqlTaggedTemplate(node)) {
      findings.push(...sqlFindings(node, ctx));
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return findings;
}

async function collectFiles(dir: string, root: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // directory absent — nothing to scan
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await collectFiles(join(dir, entry.name), root, out);
    } else if (entry.isFile() && SCAN_EXT.test(entry.name) && !SKIP_FILE.test(entry.name)) {
      out.push(normalizePath(relative(root, join(dir, entry.name))));
    }
  }
}

async function main(): Promise<void> {
  const root = process.cwd();
  const files: string[] = [];
  await collectFiles(resolve(root, SCAN_DIR), root, files);

  const findings: ResponseStatusFinding[] = [];
  for (const file of files.sort()) {
    findings.push(...scanSource(file, await readFile(resolve(root, file), 'utf8')));
  }

  if (findings.length > 0) {
    console.error('response-status-audit: failed');
    for (const finding of findings) {
      console.error(`${finding.file}:${finding.line} [${finding.rule}] ${finding.detail}`);
    }
    process.exit(1);
  }
  console.log(`response-status-audit: passed (${files.length} files scanned)`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((err) => {
    console.error('response-status-audit: fatal error');
    console.error(err);
    process.exit(1);
  });
}
