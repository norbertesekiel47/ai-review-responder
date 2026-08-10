// scripts/ci/dropped-columns-audit.ts
//
// STRICT (no-baseline) guard for the #719 failure class: a live SQL query
// referencing a column a migration has DROPPED. Migration 034 dropped
// `users.business_id` while three live queries still read it; every one threw
// Postgres 42703 at runtime, and the class is invisible to unit tests because
// worker suites mock `sql` as a positional queue that returns canned rows for
// ANY statement — a query naming a dead column passes exactly like one that
// doesn't. Filed as #739 after the step-7 review measured the audit at ~40
// lines of logic against the "epic-sized" framing that had deferred it.
//
// TWO PHASES, both pure and unit-tested (scripts/ci/__tests__):
//
// 1. LEDGER — replay `supabase/migrations/*.sql` in order and keep a running
//    set of (table, column) pairs that are dropped AT MIGRATION HEAD:
//    `DROP COLUMN` adds a pair; a later `ADD COLUMN` of the same name removes
//    it (re-add); `CREATE TABLE`/`DROP TABLE` reset the table's entry (the
//    schema is redefined / the failure class changes to missing-relation).
//    Comments are stripped first, so prose like 103's "DROP COLUMN takes
//    ACCESS EXCLUSIVE" never parses. `ALTER COLUMN … DROP NOT NULL/DEFAULT`
//    does not match — the regex requires the literal `DROP COLUMN`.
//
// 2. SCAN — walk src/ + worker/ (tests excluded by the shared walk defaults)
//    for SQL tagged templates (shared tag set: scripts/ci/lib/sql-tag-scan.ts)
//    and flag a template that references a dropped pair. Matching is
//    deliberately RELATION-ANCHORED to keep false positives near zero, because
//    the very column that caused #719 (`business_id`) is a live column on many
//    OTHER tables:
//      - the template must reference the dropped column's table as a relation
//        (FROM/JOIN/UPDATE/INTO);
//      - a QUALIFIED reference counts through the table name or any alias the
//        template binds to it (`users.business_id`, `u.business_id`);
//      - an UNQUALIFIED reference counts only when the template references
//        exactly ONE relation — then every bare column belongs to it.
//    Interpolations, SQL comments and quoted strings are blanked (same-length,
//    so finding offsets map to real lines) before matching — `payload->>
//    'drip_type'` string keys and commentary can never flag.
//
// Escape pragma (per line, reviewed): `-- dropped-column-ignore: <reason>`
// (SQL trailing comment) or `// dropped-column-ignore: <reason>` on the line
// above — for the rare template that names a dead column on purpose (e.g. an
// admin forensics query against pre-migration backups). None needed today.
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { escapeRegExp, isSqlTaggedTemplate, lineHasPragma } from './lib/sql-tag-scan';
import { walk } from './lib/ratchet-harness';

const MIGRATIONS_DIR = 'supabase/migrations';
const SCAN_DIRS = ['src', 'worker'] as const;
const IGNORE_PRAGMA = 'dropped-column-ignore';

/** Tokens that can follow `FROM <table>` without being an alias. */
const NON_ALIAS_KEYWORDS = new Set([
  'as', 'on', 'where', 'set', 'join', 'left', 'right', 'inner', 'outer',
  'cross', 'full', 'natural', 'using', 'group', 'order', 'limit', 'offset',
  'and', 'or', 'not', 'having', 'union', 'intersect', 'except', 'returning',
  'for', 'values', 'when', 'then', 'else', 'end',
]);

export interface DroppedColumn {
  table: string;
  column: string;
  /** Migration file that (last) dropped it — named in the finding. */
  migration: string;
}

/** Strip line (`--`) and block comments from migration SQL. */
function stripSqlComments(text: string): string {
  return text.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Last segment of a possibly schema-qualified relation name, lowercased. */
function bareTable(name: string): string {
  const segments = name.toLowerCase().split('.');
  return segments[segments.length - 1]!;
}

/**
 * Replays migration files IN ORDER and returns the pairs dropped at head.
 * Pure over (fileName, sql) tuples so the test suite feeds synthetic ledgers.
 */
export function extractDroppedColumns(
  migrations: readonly { file: string; sql: string }[],
): DroppedColumn[] {
  const dropped = new Map<string, DroppedColumn>(); // "table.column"
  const clearTable = (table: string): void => {
    for (const key of [...dropped.keys()]) {
      if (key.startsWith(`${table}.`)) dropped.delete(key);
    }
  };

  for (const { file, sql } of migrations) {
    const text = stripSqlComments(sql);

    for (const created of text.matchAll(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][\w.]*)/gi)) {
      clearTable(bareTable(created[1]!));
    }
    for (const droppedTable of text.matchAll(/\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([A-Za-z_][\w.]*)/gi)) {
      clearTable(bareTable(droppedTable[1]!));
    }

    for (const alter of text.matchAll(/\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([A-Za-z_][\w.]*)\s+([^;]*)/gi)) {
      const table = bareTable(alter[1]!);
      const body = alter[2]!;
      for (const add of body.matchAll(/\bADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_]\w*)/gi)) {
        dropped.delete(`${table}.${add[1]!.toLowerCase()}`);
      }
      for (const drop of body.matchAll(/\bDROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?([A-Za-z_]\w*)/gi)) {
        const column = drop[1]!.toLowerCase();
        dropped.set(`${table}.${column}`, { table, column, migration: file });
      }
    }
  }
  return [...dropped.values()];
}

/**
 * Blanks a region with same-length whitespace so every later match offset
 * still points at the original source position (and therefore the right line
 * for reporting and for the pragma check).
 */
function blank(match: string): string {
  return match.replace(/[^\n]/g, ' ');
}

/** Interpolations (one brace-nesting level), then comments, then strings. */
export function sanitizeSqlTemplate(raw: string): string {
  return raw
    .replace(/\$\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, blank)
    .replace(/--[^\n]*/g, blank)
    .replace(/'(?:[^'\n]|'')*'/g, blank);
}

export interface ColumnRef {
  /** Offset of the reference inside the text handed to findDroppedColumnRefs. */
  offset: number;
  dropped: DroppedColumn;
}

/** Every relation named after FROM/JOIN/UPDATE/INTO, lowercased. */
function relationsIn(sanitized: string): Set<string> {
  const relations = new Set<string>();
  for (const rel of sanitized.matchAll(/\b(?:from|join|update|into)\s+(?:only\s+)?([A-Za-z_]\w*)/gi)) {
    relations.add(rel[1]!.toLowerCase());
  }
  return relations;
}

/** The table name plus every alias the template binds to it. */
function tableQualifiers(sanitized: string, table: string): Set<string> {
  const qualifiers = new Set<string>([table]);
  const aliasRe = new RegExp(
    `\\b(?:from|join|update)\\s+${escapeRegExp(table)}\\s+(?:as\\s+)?([A-Za-z_]\\w*)`,
    'gi',
  );
  for (const alias of sanitized.matchAll(aliasRe)) {
    const candidate = alias[1]!.toLowerCase();
    if (!NON_ALIAS_KEYWORDS.has(candidate)) qualifiers.add(candidate);
  }
  return qualifiers;
}

/** Offsets of every match of `re` in `text`. */
function matchOffsets(text: string, re: RegExp): number[] {
  return [...text.matchAll(re)].map((hit) => hit.index!);
}

/**
 * References to ONE dropped column inside a template already known to name its
 * table as a relation. Qualified references count through the table name or
 * any bound alias; bare column names are attributable only when the template
 * touches a single relation — with several, a bare `business_id` might belong
 * to a table that legitimately still has one.
 */
function refsForDroppedColumn(
  sanitized: string,
  relations: ReadonlySet<string>,
  dropped: DroppedColumn,
): ColumnRef[] {
  const qualifiers = tableQualifiers(sanitized, dropped.table);
  const qualifiedRe = new RegExp(
    `\\b(?:${[...qualifiers].map(escapeRegExp).join('|')})\\.${escapeRegExp(dropped.column)}\\b`,
    'gi',
  );
  let offsets = matchOffsets(sanitized, qualifiedRe);
  if (offsets.length === 0 && relations.size === 1) {
    offsets = matchOffsets(sanitized, new RegExp(`(?<![.\\w])${escapeRegExp(dropped.column)}\\b`, 'gi'));
  }
  return offsets.map((offset) => ({ offset, dropped }));
}

/**
 * Relation-anchored reference search over ONE sanitized SQL text. Pure —
 * unit-tested with synthetic templates.
 */
export function findDroppedColumnRefs(
  sanitized: string,
  droppedColumns: readonly DroppedColumn[],
): ColumnRef[] {
  const relations = relationsIn(sanitized);
  return droppedColumns.flatMap((dropped) =>
    relations.has(dropped.table) ? refsForDroppedColumn(sanitized, relations, dropped) : [],
  );
}

export interface Finding {
  file: string;
  line: number; // 1-based
  detail: string;
}

/** All findings in one file's source text. Pure — unit-tested. */
export function findingsInFile(
  file: string,
  text: string,
  droppedColumns: readonly DroppedColumn[],
): Finding[] {
  const source = ts.createSourceFile('scan.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lines = text.split('\n');
  const findings: Finding[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isTaggedTemplateExpression(node) && isSqlTaggedTemplate(node)) {
      const nodeStart = node.getStart(source);
      const sanitized = sanitizeSqlTemplate(node.getText(source));
      for (const ref of findDroppedColumnRefs(sanitized, droppedColumns)) {
        const lineIndex = source.getLineAndCharacterOfPosition(nodeStart + ref.offset).line;
        if (lineHasPragma(lines, lineIndex, IGNORE_PRAGMA)) continue;
        findings.push({
          file,
          line: lineIndex + 1,
          detail:
            `references ${ref.dropped.table}.${ref.dropped.column}, ` +
            `dropped by ${ref.dropped.migration} — this query throws 42703 at runtime (the #719 class)`,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

export async function loadMigrationLedger(root: string): Promise<DroppedColumn[]> {
  const dir = resolve(root, MIGRATIONS_DIR);
  const files = (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort();
  const migrations = await Promise.all(
    files.map(async (file) => ({ file, sql: await readFile(join(dir, file), 'utf8') })),
  );
  return extractDroppedColumns(migrations);
}

export async function collectFindings(root: string): Promise<Finding[]> {
  const droppedColumns = await loadMigrationLedger(root);
  if (droppedColumns.length === 0) return [];
  const files = await walk(root, { scanDirs: SCAN_DIRS });
  const findings: Finding[] = [];
  for (const file of files.sort()) {
    const text = await readFile(resolve(root, file), 'utf8');
    findings.push(...findingsInFile(file, text, droppedColumns));
  }
  return findings;
}

async function main(): Promise<void> {
  const root = process.cwd();
  const droppedColumns = await loadMigrationLedger(root);
  const findings = await collectFindings(root);
  if (findings.length > 0) {
    console.error('dropped-columns-audit: failed');
    for (const finding of findings) {
      console.error(`  ${finding.file}:${finding.line}: ${finding.detail}`);
    }
    process.exit(1);
  }
  console.log(
    `dropped-columns-audit: passed (${droppedColumns.length} dropped columns at migration head; ` +
      'no live SQL template references any)',
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((err) => {
    console.error('dropped-columns-audit: fatal error');
    console.error(err);
    process.exit(1);
  });
}
