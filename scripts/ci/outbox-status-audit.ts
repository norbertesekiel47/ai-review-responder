import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { isSqlTaggedTemplate, lineHasPragma } from './lib/sql-tag-scan';
import { normalize, walk } from './lib/ratchet-harness';
import {
  OUTBOX_DISTINCTIVE_STATUSES,
  OUTBOX_IN_FLIGHT_STATUSES,
} from '../../src/lib/shared/job-outbox-status';

/**
 * Guards the `job_outbox` in-flight status vocabulary
 * (`@/lib/shared/job-outbox-status`).
 *
 * Any `job_outbox` status group that names an in-flight status must spell the
 * canonical set EXACTLY — same members, same order. The set cannot be
 * parameterized away (a bind parameter inside an `ON CONFLICT … WHERE` breaks
 * partial-index inference), so ~26 SQL sites and ~19 migrations each re-spell
 * it by hand. Migration 018 exists only because 004 shipped the literal missing
 * `'dispatching'`; this audit is what stops the next one.
 *
 * ## Binding: how a group is identified as job_outbox's
 *
 * A `status IN (…)` predicate is only checked when BOTH hold:
 *
 *  1. The group names `'dispatching'` or `'dispatched'`. Those statuses exist
 *     nowhere but `job_outbox`, so they discriminate; `'pending'` does not (it
 *     is also a `responses` / `zernio_connections` / `account_offboardings` /
 *     `solicitation_contacts` status). This is what keeps the audit off the 32
 *     repo-wide `('approved','edited','awaiting_owner_connect')` groups, which
 *     frequently sit in the same template as a `job_outbox` subquery.
 *  2. The predicate binds to `job_outbox` — either qualified with an alias the
 *     statement gives to `job_outbox` (`jo.status`), or unqualified inside a
 *     statement that references `job_outbox` (the `ON CONFLICT … WHERE` and
 *     `CREATE INDEX … ON job_outbox … WHERE` forms, which have no alias to use).
 *
 * Requiring only (1) would already be sound today, since the vocabularies are
 * disjoint; (2) is kept so that a future table borrowing the word `dispatched`
 * cannot silently enrol itself into this audit.
 *
 * ## Escapes
 *
 * Per-line `-- outbox-status-audit-ignore` (SQL) / `// outbox-status-audit-ignore`
 * (TS), mirroring `ci:response-status`. Migrations are immutable once applied
 * (hook-enforced), so a migration that must diverge cannot be edited to carry a
 * pragma — those live in MIGRATION_ALLOWLIST below, each with its reason.
 *
 * Scope is `src/` + `worker/` + `supabase/migrations/`. Structure mirrors
 * `response-status-audit.ts`: pure scan functions (unit-tested) + a thin `main`.
 */

const TS_SCAN_DIRS = ['src', 'worker'] as const;
const MIGRATIONS_DIR = 'supabase/migrations';
const IGNORE_PRAGMA = 'outbox-status-audit-ignore';

/**
 * Migrations whose divergence from the canonical set is deliberate and
 * permanent. A migration cannot be edited after it is applied, so this is the
 * only available escape for one — hence a reason per entry rather than a bare
 * list.
 */
const MIGRATION_ALLOWLIST: ReadonlyMap<string, string> = new Map([
  [
    'supabase/migrations/004_sync_reviews_dedup_constraint.sql',
    "idx_jo_sync_reviews_inflight shipped missing 'dispatching' — the original " +
      'drift. Migration 018 supersedes it by rebuilding the index with the full ' +
      'set; 004 stays as-applied.',
  ],
  [
    'supabase/migrations/065_archival_watchdog_indexes.sql',
    "idx_jo_recovery is post-dispatch by design: 'pending' is excluded " +
      'deliberately so the index serves the dispatched_at watchdog scan, not an ' +
      'in-flight dedup predicate.',
  ],
]);

export type OutboxStatusRule = 'outbox-status-group';

export interface OutboxStatusFinding {
  file: string;
  line: number;
  rule: OutboxStatusRule;
  detail: string;
}

const CANONICAL = OUTBOX_IN_FLIGHT_STATUSES.join(',');
const DISTINCTIVE: ReadonlySet<string> = new Set(OUTBOX_DISTINCTIVE_STATUSES);

const quoteList = (members: string): string =>
  members.split(',').map((member) => `'${member}'`).join(', ');

function detailFor(found: string): string {
  return (
    `job_outbox in-flight status group is \`${quoteList(found)}\` but must be ` +
    `\`${quoteList(CANONICAL)}\` — same members, same order. The literal ` +
    'backs partial-index inference for `ON CONFLICT` and cannot be parameterized; see ' +
    '@/lib/shared/job-outbox-status. Deliberate divergence needs a ' +
    `\`${IGNORE_PRAGMA}\` pragma (migrations: the allowlist in this audit).`
  );
}

/**
 * Blanks `--` line comments with spaces, preserving every byte offset so
 * reported line numbers stay correct. Single-quoted strings are honoured so a
 * `--` inside a literal does not eat the rest of the line.
 */
export function blankSqlComments(text: string): string {
  const out = text.split('');
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === "'") inString = false;
      continue;
    }
    if (ch === "'") {
      inString = true;
      continue;
    }
    if (ch === '-' && text[i + 1] === '-') {
      while (i < text.length && text[i] !== '\n') {
        out[i] = ' ';
        i += 1;
      }
    }
  }
  return out.join('');
}

// Reserved words that can follow a table name, so `FROM job_outbox WHERE …` is
// not read as aliasing the table to `WHERE`.
const NOT_AN_ALIAS = new Set([
  'where', 'set', 'on', 'using', 'join', 'inner', 'left', 'right', 'full', 'cross',
  'group', 'order', 'limit', 'offset', 'returning', 'values', 'select', 'as',
  'do', 'union', 'having', 'window', 'for', 'and', 'or', 'not', 'with',
]);

/** Every name `job_outbox` answers to in this SQL text — the table plus its aliases. */
export function jobOutboxAliases(sqlText: string): Set<string> {
  const aliases = new Set<string>(['job_outbox']);
  const re = /\bjob_outbox\b(?:\s+(?:as\s+)?([a-z_][a-z0-9_]*))?/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(sqlText)) !== null) {
    const candidate = match[1]?.toLowerCase();
    if (candidate && !NOT_AN_ALIAS.has(candidate)) aliases.add(candidate);
  }
  return aliases;
}

interface StatusGroup {
  /** Ordered, comma-joined status literals inside the predicate. */
  members: string;
  /** Byte offset of the `IN` / `ANY` keyword, for line attribution. */
  index: number;
  /** Table qualifier on the `status` column, lowercased; empty when unqualified. */
  qualifier: string;
}

/**
 * Every `<qualifier.>status IN (…)` / `= ANY (…)` group in `sqlText`, with its
 * literal members in source order. Balanced-paren scan so a nested subquery
 * inside the predicate cannot truncate it.
 */
export function statusGroups(sqlText: string): StatusGroup[] {
  const groups: StatusGroup[] = [];
  // `status` (optionally qualified), then IN / = ANY, then the open paren.
  const re = /(?:\b([a-z_][a-z0-9_]*)\s*\.\s*)?\bstatus\b\s*(?:in|=\s*any)\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(sqlText)) !== null) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let end = open;
    for (; end < sqlText.length; end += 1) {
      const ch = sqlText[end];
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const body = sqlText.slice(open + 1, end);
    const members = [...body.matchAll(/'([a-z_][a-z0-9_]*)'/gi)].map((m) => m[1] ?? '');
    if (members.length === 0) continue;
    groups.push({ members: members.join(','), index: match.index, qualifier: (match[1] ?? '').toLowerCase() });
  }
  return groups;
}

/**
 * Core rule, shared by the TS and migration scanners. `offsetToLine` maps a byte
 * offset within `sqlText` to a 0-indexed line in the FILE (they differ for a
 * `sql` template embedded in a .ts file).
 */
function findingsForSqlText(
  file: string,
  sqlText: string,
  lines: string[],
  offsetToLine: (offset: number) => number,
): OutboxStatusFinding[] {
  const aliases = jobOutboxAliases(sqlText);
  const findings: OutboxStatusFinding[] = [];
  for (const group of statusGroups(sqlText)) {
    const members = group.members.split(',');
    if (!members.some((member) => DISTINCTIVE.has(member))) continue; // not an outbox group
    const bound = group.qualifier
      ? aliases.has(group.qualifier)
      : aliases.has('job_outbox') && /\bjob_outbox\b/i.test(sqlText);
    if (!bound) continue;
    if (group.members === CANONICAL) continue;
    const line = offsetToLine(group.index);
    if (lineHasPragma(lines, line, IGNORE_PRAGMA)) continue;
    findings.push({ file, line: line + 1, rule: 'outbox-status-group', detail: detailFor(group.members) });
  }
  return findings;
}

/** Pure scan of one migration's SQL. Exported for unit tests. */
export function scanMigration(file: string, text: string): OutboxStatusFinding[] {
  const normalized = normalize(file);
  if (MIGRATION_ALLOWLIST.has(normalized)) return [];
  const lines = text.split(/\r?\n/);
  const blanked = blankSqlComments(text);
  // Offsets are preserved by blankSqlComments, so a line index can be derived
  // by counting newlines in the original text up to the offset.
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') lineStarts.push(i + 1);
  const offsetToLine = (offset: number): number => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if ((lineStarts[mid] ?? 0) <= offset) low = mid;
      else high = mid - 1;
    }
    return low;
  };
  return findingsForSqlText(normalized, blanked, lines, offsetToLine);
}

/** Pure scan of one TS file's `sql`/`tx`/`db` tagged templates. Exported for unit tests. */
export function scanSource(file: string, text: string): OutboxStatusFinding[] {
  const normalized = normalize(file);
  const source = ts.createSourceFile(normalized, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lines = text.split(/\r?\n/);
  const findings: OutboxStatusFinding[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isTaggedTemplateExpression(node) && isSqlTaggedTemplate(node)) {
      const start = node.getStart(source);
      const raw = node.getText(source);
      findings.push(
        ...findingsForSqlText(normalized, raw, lines, (offset) =>
          source.getLineAndCharacterOfPosition(start + offset).line,
        ),
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

async function main(): Promise<void> {
  const root = process.cwd();
  const findings: OutboxStatusFinding[] = [];

  const tsFiles = await walk(root, { scanDirs: TS_SCAN_DIRS });
  for (const file of tsFiles) {
    findings.push(...scanSource(file, await readFile(resolve(root, file), 'utf8')));
  }

  const migrations = await walk(root, {
    scanDirs: [MIGRATIONS_DIR],
    scanExt: /\.sql$/,
    skipFile: /a^/,
  });
  for (const file of migrations) {
    findings.push(...scanMigration(file, await readFile(resolve(root, file), 'utf8')));
  }

  if (findings.length > 0) {
    console.error('outbox-status-audit: failed');
    for (const finding of findings) {
      console.error(`${finding.file}:${finding.line} [${finding.rule}] ${finding.detail}`);
    }
    process.exit(1);
  }
  console.log(
    `outbox-status-audit: passed (${tsFiles.length} TS + ${migrations.length} migration files scanned; ` +
      `${MIGRATION_ALLOWLIST.size} migrations allowlisted)`,
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((err) => {
    console.error('outbox-status-audit: fatal error');
    console.error(err);
    process.exit(1);
  });
}
