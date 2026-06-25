import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

/**
 * Flags hardcoded response-status GROUP literals — 2+ distinct canonical
 * status values co-located in a JS/TS array literal, or in a SQL
 * `IN (...)` / `ANY(ARRAY[...])` list inside a template literal — in TS files
 * under `src/`, outside the two exempt modules.
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
  'hardcoded response-status group in a SQL IN()/ANY(ARRAY[]) list — import the ' +
  'group from @/lib/shared/response-status and bind via statusArraySql(); add a ' +
  'trailing `-- status-audit-ignore` for intentionally-inline write guards.';

function normalizePath(file: string): string {
  return file.split(sep).join('/');
}

// A single quoted canonical-status literal, e.g. 'approved' or "posted".
const STATUS_LITERAL_RE =
  /(['"])(pending_approval|approved|edited|superseded|awaiting_owner_connect|posted|failed)\1/g;

// One SQL IN(...) / ARRAY[...] parenthetical or bracket span (no nesting).
const SQL_GROUP_RE = /\b(?:in|array)\s*[([][^)\]]*[)\]]/gi;

function distinctCanonicalLiterals(text: string): number {
  const seen = new Set<string>();
  for (const match of text.matchAll(STATUS_LITERAL_RE)) {
    if (match[2]) seen.add(match[2]);
  }
  return seen.size;
}

function lineHasPragma(lines: string[], lineIndex: number): boolean {
  const current = lines[lineIndex] ?? '';
  const previous = lineIndex > 0 ? (lines[lineIndex - 1] ?? '') : '';
  return current.includes(IGNORE_PRAGMA) || previous.includes(IGNORE_PRAGMA);
}

/** Pure scan of one file's text. Exported for unit tests. */
export function scanSource(file: string, text: string): ResponseStatusFinding[] {
  const normalized = normalizePath(file);
  if (EXEMPT.has(normalized)) return [];

  const findings: ResponseStatusFinding[] = [];
  const lines = text.split('\n');
  const source = ts.createSourceFile(
    normalized,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );

  const lineOf = (pos: number): number =>
    source.getLineAndCharacterOfPosition(pos).line;

  const visit = (node: ts.Node): void => {
    if (ts.isArrayLiteralExpression(node)) {
      const canonical = new Set(
        node.elements
          .filter(
            (element): element is ts.StringLiteral =>
              ts.isStringLiteral(element) && CANONICAL_STATUSES.has(element.text),
          )
          .map((element) => element.text),
      );
      if (canonical.size >= 2) {
        const line = lineOf(node.getStart(source));
        if (!lineHasPragma(lines, line)) {
          findings.push({
            file: normalized,
            line: line + 1,
            rule: 'response-status-group',
            detail: ARRAY_DETAIL,
          });
        }
      }
    } else if (
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateExpression(node)
    ) {
      const raw = node.getText(source);
      const nodeStart = node.getStart(source);
      for (const match of raw.matchAll(SQL_GROUP_RE)) {
        if (distinctCanonicalLiterals(match[0]) < 2) continue;
        const line = lineOf(nodeStart + (match.index ?? 0));
        if (lineHasPragma(lines, line)) continue;
        findings.push({
          file: normalized,
          line: line + 1,
          rule: 'response-status-group',
          detail: SQL_DETAIL,
        });
      }
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
