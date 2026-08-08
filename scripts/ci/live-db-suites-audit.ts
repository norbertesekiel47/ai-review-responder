// Guards the two live-DB test conventions that #573 was caused by breaking.
//
// A "live-DB suite" is any test file that reaches the shared local Postgres —
// whether it names TEST_DATABASE_POOL_URL itself or, far more commonly now,
// gets there through the shared helpers (`resolveTestDatabaseUrl`,
// `describeWithDb`, `acquireLiveDbLock`).
//
// The first cut recognised ONLY the literal `TEST_DATABASE_POOL_URL`, and bailed
// on anything else before running a single rule. Five suites read the DB purely
// through the helpers and were therefore invisible — including
// `batch-builder.integration.test.ts`, the suite whose deadlock IS #573, and
// `migration-088-…`, which sits in MIGRATION_SHAPE_SUITES below expressly so its
// lock enrolment gets checked. That check could never run.
//
// Detection is therefore keyed on the helper IMPORT SPECIFIERS as well as the
// literal. A specifier is the stable seam: reaching this database without
// importing one of these modules or naming the variable is not a thing a suite
// can do. (Same defect shape as #592, where the SQL vocabulary audits keyed on
// a tag-name list that the codebase's own `exec` convention had outgrown.)
//
// R1 — NAMING. A live-DB suite must be named `*.integration.test.ts`. That glob
//      is what puts it in vitest's serialized `integration` project; a suite
//      that misses it runs in the fully parallel project alongside ~740 other
//      files, unsynchronized against every other live-DB writer.
//
// R2 — NO RUN-TIME DDL. A live-DB suite must not apply migration SQL. DDL takes
//      ACCESS EXCLUSIVE locks; a sibling suite holding ordinary row locks on the
//      same relations in the opposite order deadlocks against it (40P01), and
//      the victim is whichever transaction Postgres picks — so the failure lands
//      somewhere unrelated and reads as flake. The schema is provisioned once by
//      `pnpm test:db:setup`; suites assert it with `assertSchemaReady`.
//
//      Detection is on EXECUTED SQL, extracted from the AST — every tagged
//      template and every `.unsafe()` call — not on the file mentioning a
//      migration path. The first cut keyed on `supabase/migrations` AND
//      `.unsafe(`, an incidental marker: DDL run without naming that path was
//      invisible, which is how three sites shipped (#694). There is no tag-NAME
//      allowlist: `sql()` alone is 770 of 1201 templates in these files, so a
//      name list would miss the majority (the #592 shape, one layer down).
//
//      Two escapes. A file allowlist for sanctioned DDL — MIGRATION_SHAPE_SUITES
//      (applying the migration IS the subject) and DDL_PROBE_SUITES (session-
//      scoped `auth.uid()` redefinition inside a rolled-back tx); both are
//      enforced to hold the cross-process lock. And a per-line
//      `-- live-db-ddl-ignore: <reason>` pragma for DDL whose safety is invisible
//      statically — a CREATE INDEX on a pg_temp table reads exactly like one on
//      the shared table.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { lineHasPragma } from './lib/sql-tag-scan';

export interface LiveDbSuiteFinding {
  file: string;
  rule: 'naming' | 'runtime-ddl' | 'unlocked-ddl';
  reason: string;
}

/**
 * Files that mention TEST_DATABASE_POOL_URL without connecting to it:
 * `describe-with-db.test.ts` manipulates the variable to exercise the DB-gating
 * helper, and this audit's own test carries violating source as fixtures.
 */
const NOT_LIVE_DB = new Set([
  'src/__tests__/helpers/describe-with-db.test.ts',
  'scripts/ci/__tests__/live-db-suites-audit.test.ts',
]);

/**
 * Migration-shape suites: applying the migration is the thing under test.
 * Every entry must hold the cross-process live-DB lock (enforced below).
 */
const MIGRATION_SHAPE_SUITES = new Set([
  'src/lib/shared/__tests__/migration-074-trust-dial-veto-window.integration.test.ts',
  'src/lib/shared/__tests__/migration-076-judge-verdicts-governor.integration.test.ts',
  'src/lib/shared/__tests__/migration-077-copilot-autopilot.integration.test.ts',
  'src/lib/shared/__tests__/migration-078-copilot-autopilot.integration.test.ts',
  'src/lib/shared/__tests__/migration-088-solicitation-batch-executor.integration.test.ts',
]);

/**
 * DDL-probe suites: the DDL redefines a SESSION-scoped object (`auth.uid()`) to
 * make an RLS assertion mean something in both directions, inside a transaction
 * that always rolls back. Safe by lock + rollback, not by target — so, like the
 * migration-shape suites, every entry is enforced to hold the cross-process lock
 * below. `migration-091` executes this DDL today and was on NO allowlist, so its
 * lock enrolment had never been checked (#694).
 */
const DDL_PROBE_SUITES = new Set([
  'src/lib/solicitation/__tests__/outreach-render.integration.test.ts',
  'src/lib/shared/__tests__/migration-091-send-mode-spine.integration.test.ts',
]);

/**
 * 074 predates the shared lock and serializes on its own dedicated apply lock
 * (`withMigration074ApplyLock`), which is equally cross-process. Accepted as an
 * alternative to `acquireLiveDbLock` for that file only.
 */
const OWN_APPLY_LOCK = new Set([
  'src/lib/shared/__tests__/migration-074-trust-dial-veto-window.integration.test.ts',
]);

/**
 * Every way a suite can reach the shared local Postgres: the env var by name,
 * or an import of one of the three helper modules that resolve/gate/lock it.
 * Import specifiers rather than function names — a rename inside a helper does
 * not silently shrink this audit's scope, and a new helper export is covered
 * the moment its module is imported.
 *
 * Adding a fourth route to the database means adding it here. `ci:live-db-suites`
 * enforces conventions on the suites it can SEE, so this set is the audit's real
 * blast radius (#573 shipped it seeing 49 of 54 suites).
 */
const LIVE_DB_MARKERS = [
  'TEST_DATABASE_POOL_URL',
  'helpers/live-db-lock',
  'helpers/describe-with-db',
  'helpers/schema-ready',
] as const;
const SHARED_LOCK_MARKER = 'acquireLiveDbLock';
const OWN_LOCK_MARKER = 'withMigration074ApplyLock';

/**
 * DDL that takes ACCESS EXCLUSIVE on its target. DCL (GRANT/REVOKE) is
 * deliberately absent: every executed GRANT in the repo is inside a
 * DDL_PROBE_SUITES file that already holds the lock, so including it would
 * change no finding today (#694).
 *
 * `g` is required by `matchAll`, which clones the regex rather than advancing
 * this one — `lastIndex` is never mutated, so no reset is needed.
 */
const DDL_VERB =
  /\b(?:alter|drop)\s+(?:table|index|type|schema|policy|view|function|trigger|materialized)\b|\bcreate\s+(?:or\s+replace\s+)?(?:unique\s+)?(?:temp(?:orary)?\s+)?(?:table|index|type|schema|policy|view|function|trigger|extension|materialized)\b|\btruncate\b/gi;

/** Per-line escape hatch, modelled on `outbox-seam-ignore` (#568). */
const DDL_PRAGMA = 'live-db-ddl-ignore';

interface ExecutedSql {
  /** Absolute offset in the source where `text` begins. */
  start: number;
  /** SQL source text, or null when a `.unsafe()` argument is not statically readable. */
  text: string | null;
  /** Line of the executing node — used to report an unreadable argument. */
  line: number;
}

function isUnsafeCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'unsafe'
  );
}

/**
 * Every statement a live-DB suite EXECUTES. No tag-name allowlist: `sql()` alone
 * accounts for 770 of the 1201 tagged templates in these files and is a
 * CallExpression, so a name list (SQL_TAG_NAMES) would miss the majority — the
 * #592 defect shape. In a file that reaches the live DB, a tagged template IS
 * SQL; all 21 distinct tag forms in the 78 suites are DB handles.
 */
function extractExecutedSql(source: ts.SourceFile): ExecutedSql[] {
  const out: ExecutedSql[] = [];
  const lineOf = (node: ts.Node): number =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line;

  const visit = (node: ts.Node): void => {
    if (ts.isTaggedTemplateExpression(node)) {
      out.push({
        start: node.template.getStart(source),
        text: node.template.getText(source),
        line: lineOf(node),
      });
    } else if (isUnsafeCall(node)) {
      const arg = node.arguments[0];
      const readable =
        arg !== undefined &&
        (ts.isStringLiteral(arg) ||
          ts.isNoSubstitutionTemplateLiteral(arg) ||
          ts.isTemplateExpression(arg));
      out.push({
        start: readable ? arg.getStart(source) : node.getStart(source),
        text: readable ? arg.getText(source) : null,
        line: lineOf(node),
      });
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return out;
}

/**
 * 0-based lines carrying executed DDL, minus pragma'd ones. An unreadable
 * `.unsafe()` argument counts as DDL: unresolvable SQL must never pass as safe.
 */
function unpragmaedDdlLines(source: ts.SourceFile, lines: readonly string[]): number[] {
  const hits = new Set<number>();
  for (const sql of extractExecutedSql(source)) {
    if (sql.text === null) {
      hits.add(sql.line);
      continue;
    }
    for (const match of sql.text.matchAll(DDL_VERB)) {
      hits.add(source.getLineAndCharacterOfPosition(sql.start + (match.index ?? 0)).line);
    }
  }
  return [...hits]
    .sort((a, b) => a - b)
    .filter((line) => !lineHasPragma([...lines], line, DDL_PRAGMA));
}

export function auditLiveDbSuite(file: string, text: string): LiveDbSuiteFinding[] {
  if (NOT_LIVE_DB.has(file)) return [];
  if (!LIVE_DB_MARKERS.some((marker) => text.includes(marker))) return [];

  const findings: LiveDbSuiteFinding[] = [];

  if (!file.endsWith('.integration.test.ts')) {
    findings.push({
      file,
      rule: 'naming',
      reason:
        'live-DB suite must be named *.integration.test.ts so vitest serializes it ' +
        'in the `integration` project (it currently runs in the parallel project)',
    });
  }

  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const ddlLines = unpragmaedDdlLines(source, text.split('\n'));
  if (ddlLines.length === 0) return findings;

  const firstAt = `first at line ${(ddlLines[0] ?? 0) + 1}`;

  if (!MIGRATION_SHAPE_SUITES.has(file) && !DDL_PROBE_SUITES.has(file)) {
    findings.push({
      file,
      rule: 'runtime-ddl',
      reason:
        `live-DB suite executes DDL at run time (${firstAt}) — ACCESS EXCLUSIVE locks ` +
        'deadlock sibling suites (#573). Provision with `pnpm test:db:setup` and assert ' +
        'with assertSchemaReady() instead, or add a `-- live-db-ddl-ignore: <reason>` ' +
        'pragma if the target provably cannot be a shared relation',
    });
    return findings;
  }

  const locked = OWN_APPLY_LOCK.has(file)
    ? text.includes(OWN_LOCK_MARKER)
    : text.includes(SHARED_LOCK_MARKER);
  if (!locked) {
    findings.push({
      file,
      rule: 'unlocked-ddl',
      reason:
        `allowlisted suite executes DDL (${firstAt}) without the cross-process live-DB ` +
        'lock — call acquireLiveDbLock() in beforeAll and release it in afterAll',
    });
  }
  return findings;
}

export function listTestFiles(): string[] {
  return execFileSync('git', ['ls-files', '*.test.ts', '*.test.tsx'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

async function main(): Promise<void> {
  const findings: LiveDbSuiteFinding[] = [];
  for (const file of listTestFiles()) {
    findings.push(...auditLiveDbSuite(file, await readFile(file, 'utf8')));
  }

  if (findings.length > 0) {
    console.error('live-db-suites-audit: failed');
    for (const finding of findings) {
      console.error(`${finding.file} [${finding.rule}]: ${finding.reason}`);
    }
    process.exit(1);
  }
  console.log('live-db-suites-audit: passed');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((err) => {
    console.error('live-db-suites-audit: fatal error');
    console.error(err);
    process.exit(1);
  });
}
