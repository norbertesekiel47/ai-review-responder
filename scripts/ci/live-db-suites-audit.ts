// Guards the two live-DB test conventions that #573 was caused by breaking.
//
// A "live-DB file" is any file this audit scans that reaches the shared local
// Postgres — whether it names TEST_DATABASE_POOL_URL itself, gets there through
// the shared helpers (`resolveTestDatabaseUrl`, `describeWithDb`,
// `acquireLiveDbLock`), or — being a HELPER, handed its handle rather than
// resolving one — merely types that handle with an import of `postgres`
// (`HELPER_DB_MARKER` below, and why that third route is offered to helpers only).
//
// The first cut recognised ONLY the literal `TEST_DATABASE_POOL_URL`, and bailed
// on anything else before running a single rule. Five suites read the DB purely
// through the helpers and were therefore invisible — including
// `batch-builder.integration.test.ts`, the suite whose deadlock IS #573, and
// `migration-088-…`, which sits in MIGRATION_SHAPE_FILES below expressly so its
// lock enrolment gets checked. That check could never run.
//
// Detection is therefore keyed on the helper IMPORT SPECIFIERS as well as the
// literal. A specifier is the stable seam: reaching this database without
// importing one of these modules or naming the variable is not a thing a suite
// can do. (Same defect shape as #592, where the SQL vocabulary audits keyed on
// a tag-name list that the codebase's own `exec` convention had outgrown.)
//
// R1 — NAMING. A live-DB **suite** must be named `*.integration.test.ts`. That
//      glob is what puts it in vitest's serialized `integration` project; a
//      suite that misses it runs in the fully parallel project alongside ~740
//      other files, unsynchronized against every other live-DB writer.
//
// R2 — NO RUN-TIME DDL. A live-DB **file** must not execute DDL — not merely "apply
//      migration SQL", but any statement taking ACCESS EXCLUSIVE on a shared
//      relation, whatever its provenance. A sibling suite holding ordinary row
//      locks on the same relations in the opposite order deadlocks against it
//      (40P01), and the victim is whichever transaction Postgres picks — so the
//      failure lands somewhere unrelated and reads as flake. The schema is
//      provisioned once by `pnpm test:db:setup`; suites assert it with
//      `assertSchemaReady`.
//
//      Detection is on EXECUTED SQL, extracted from the AST — every tagged
//      template, and every `.unsafe()` call reachable without a type checker
//      (`isUnsafeCall` states that bound) — not on the file mentioning a
//      migration path. The first cut keyed on `supabase/migrations` AND
//      `.unsafe(`, an incidental marker: DDL run without naming that path was
//      invisible, which is how three sites shipped (#694). There is no tag-NAME
//      allowlist: `sql()` alone is the PLURALITY of tagged templates in these
//      files — roughly 770 of ~1470 at the time of writing — and its tag is a
//      CallExpression, so a name list would miss more than it caught (the #592
//      shape, one layer down). Treat the figures as a point-in-time census, not
//      a constant: they drift by one whenever a template is added or moves
//      between files, and an exact count written here went stale twice inside
//      #694's own review. Recount with: walk every git-tracked `*.test.ts` that
//      contains a LIVE_DB_MARKERS string, counting TaggedTemplateExpressions.
//
//      Two escapes. A file allowlist for sanctioned DDL — MIGRATION_SHAPE_FILES
//      (applying the migration IS the subject) and DDL_PROBE_FILES (session-
//      scoped `auth.uid()` redefinition inside a rolled-back tx); both are
//      enforced to hold the cross-process lock. And a per-line
//      `-- live-db-ddl-ignore: <reason>` pragma for DDL whose safety is invisible
//      statically — a CREATE INDEX on a pg_temp table reads exactly like one on
//      the shared table.
//
// The two rules do not share a unit, and #706 made that explicit. A SUITE is a
// file vitest runs (`*.test.{ts,tsx}`); a HELPER is any other `.ts`/`.tsx` under
// `__tests__/`. R1 applies to suites only; R2 and the lock check apply to every
// live-DB file, helpers included. `isSuite`'s JSDoc owns the argument for why.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { lineHasPragma } from './lib/sql-tag-scan';

export interface LiveDbFileFinding {
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
 * Migration-shape files: applying the migration IS the subject. Five suites test
 * a migration's shape; `apply-migration-074.ts` is the shared guarded apply that
 * the 074 shape suite and three further integration suites delegate to, and it
 * executes the real file via `db.unsafe(readMigration074Sql())` — an argument
 * this walk cannot read, which counts as DDL by design (#706 made it visible; it
 * was never audited before). Every entry must hold a cross-process lock
 * (enforced below).
 */
const MIGRATION_SHAPE_FILES = new Set([
  'src/lib/shared/__tests__/migration-074-trust-dial-veto-window.integration.test.ts',
  'src/lib/shared/__tests__/migration-076-judge-verdicts-governor.integration.test.ts',
  'src/lib/shared/__tests__/migration-077-copilot-autopilot.integration.test.ts',
  'src/lib/shared/__tests__/migration-078-copilot-autopilot.integration.test.ts',
  'src/lib/shared/__tests__/migration-088-solicitation-batch-executor.integration.test.ts',
  'src/lib/shared/__tests__/helpers/apply-migration-074.ts',
]);

/**
 * DDL-probe suites: the DDL redefines a SESSION-scoped object (`auth.uid()`) to
 * make an RLS assertion mean something in both directions, inside a transaction
 * that always rolls back. Safe by lock + rollback, not by target — so, like the
 * migration-shape suites, every entry is enforced to hold the cross-process lock
 * below. `migration-091` executes this DDL today and was on NO allowlist, so its
 * lock enrolment had never been checked (#694).
 */
const DDL_PROBE_FILES = new Set([
  'src/lib/solicitation/__tests__/outreach-render.integration.test.ts',
  'src/lib/shared/__tests__/migration-091-send-mode-spine.integration.test.ts',
]);

/**
 * 074 predates the shared lock and serializes on its own dedicated apply lock
 * (`withMigration074ApplyLock`), which is equally cross-process. Accepted as an
 * alternative to `acquireLiveDbLock` for the 074 shape suite and for the helper
 * that DEFINES that lock — which is also the answer to "a helper cannot hold a
 * lock on its own behalf": this one does, and the check is on the file's OWN
 * text. Inheriting a caller's lock would need an import graph, so an allowlisted
 * file that does not name its lock marker is `unlocked-ddl`, never a pass.
 *
 * BOUND: that last sentence is a live guarantee for the 074 shape SUITE, whose
 * marker is a genuine call site — and a vacuous one for `apply-migration-074.ts`,
 * which DEFINES `withMigration074ApplyLock` (its own `:23`), so the own-text
 * check is satisfied by the declaration and `unlocked-ddl` can never fire for
 * that file. It therefore detects DELETING the helper, not a refactor that moves
 * `db.unsafe(readMigration074Sql())` outside the wrapper — an inverted early
 * return, or a "fast path when the column already exists", would ship
 * unserialized DDL with this audit green. Proving the DDL sits INSIDE the
 * wrapper needs call-graph analysis, more machinery than a CI guard against
 * accidental DDL warrants. The guarantee genuinely differs between the two
 * members of this set; saying so is cheaper than a claim that it does not.
 */
const OWN_APPLY_LOCK = new Set([
  'src/lib/shared/__tests__/migration-074-trust-dial-veto-window.integration.test.ts',
  'src/lib/shared/__tests__/helpers/apply-migration-074.ts',
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
 * How a HELPER reaches the database. `LIVE_DB_MARKERS` above is suite-shaped —
 * the env var by name, or an import of the module that resolves it — and a
 * helper matches none of it, because it is HANDED its handle (`db: postgres.Sql`,
 * `tx: TransactionSql`). Widening the file glob alone would therefore have
 * reached 4 of the 13 new files — none of them the one that executes DDL — and
 * left the ticket's own hazard open.
 *
 * What a helper cannot avoid is TYPING that handle, and `postgres` is the only
 * module that supplies the type. Value and type-only imports both count: five of
 * the six DB-reaching helpers use `import type` (the exception is
 * `helpers/live-db-lock.ts`, which CONSTRUCTS a connection rather than being
 * handed one), and a distinction there would re-open the hole on the first one
 * written. Two SPELLINGS also both count: the `from 'postgres'` import clause,
 * and the inline `import('postgres').Sql` type, which carries no `from` clause
 * at all and is already the idiom this tree uses to hand a fake handle to
 * something (`escalations/__tests__/raise.test.ts`, `shared/__tests__/pool-wait.test.ts`
 * — both suites today, so nothing is invisible, but a helper written that way
 * would have been the #694 blindness mode reopened).
 *
 * Offered to HELPERS only, and that asymmetry is the consequential call here.
 * R1 is a claim about which vitest project a file lands in, so it is only
 * askable of a file vitest runs; a mock-shaping type import is not evidence that
 * a suite reaches a database. Admitting the marker to suites would fire the
 * naming rule across the tree on files that touch no DB: 186 of the 904 suites
 * match this marker today, and 112 of those are neither already visible through
 * `LIVE_DB_MARKERS` nor named `*.integration.test.ts`. Suites keep their own
 * reachability routes — they resolve a handle rather than being handed one, so
 * `LIVE_DB_MARKERS` can see them. (A census, not a constant; recount with the
 * marker against `listAuditedFiles()`.)
 *
 * BOUND: a helper that types its handle as `unknown` and casts, or takes it
 * through a generic parameter, is invisible. The inline import-type form is NOT
 * one of those escapes — it is matched. The no-`any` invariant plus the visible
 * `Sql`/`TransactionSql` typings on all six make the two remaining shapes a
 * deliberate act rather than an accident — same blast-radius honesty
 * LIVE_DB_MARKERS carries.
 */
const HELPER_DB_MARKER = /\bfrom ['"]postgres['"]|\bimport\(['"]postgres['"]\)/;

/**
 * DDL that takes ACCESS EXCLUSIVE on its target. DCL (GRANT/REVOKE) is
 * deliberately absent: every executed GRANT in the repo is inside a
 * DDL_PROBE_FILES file that already holds the lock, so including it would
 * change no finding today (#694).
 *
 * `g` is required by `matchAll`, which clones the regex rather than advancing
 * this one — `lastIndex` is never mutated, so no reset is needed.
 */
const DDL_VERB =
  /\b(?:alter|drop)\s+(?:table|index|type|schema|policy|view|function|trigger|materialized)\b|\bcreate\s+(?:or\s+replace\s+)?(?:unique\s+)?(?:temp(?:orary)?\s+)?(?:table|index|type|schema|policy|view|function|trigger|extension|materialized)\b|\btruncate\b/gi;

/** Per-line escape hatch, modelled on `outbox-seam-ignore` (#568). */
const DDL_PRAGMA = 'live-db-ddl-ignore';

/**
 * Replaces SQL comment bodies with spaces, preserving every offset so a
 * finding's reported line still matches the source. A DDL verb inside a `--` or
 * block comment is not executed DDL — the audit promises to ignore it, and
 * before #694's review it flagged it, because the raw template text was matched.
 *
 * BOUND: a `--` inside a SQL string literal (`WHERE note = '--'`) blanks the
 * rest of that line, so DDL after it on the SAME line would be missed. Closing
 * that needs a SQL lexer, which is more machinery than a CI guard against
 * accidental DDL warrants — recorded rather than silently tolerated, per this
 * audit's own convention of naming its blast radius.
 */
function blankSqlComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, (match) => ' '.repeat(match.length))
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '));
}

/**
 * A `.unsafe()` template with substitutions is only PARTIALLY readable: its
 * static spans are visible, but a substitution at a STATEMENT-START position
 * could be an entire DDL statement — `sql.unsafe(`${ddl}`)` reads as no DDL at
 * all. A DDL verb can only begin a statement, so that is the only position
 * where a hidden substitution can carry one past the verb match. Interpolation
 * MID-statement (the common `setConsent` shape, a test-controlled literal in an
 * UPDATE) leaves the verb visible and stays readable.
 *
 * Deliberately NOT applied to tagged templates — but NOT because Postgres.js
 * parameterises them. It does not always: a nested `Query` substitution is
 * spliced in as raw SQL text (`fragment()`), so `` sql`${sql.unsafe('select 42')}` ``
 * really executes, which no bind value could. Round 2 of #694's review proved
 * that live, against an earlier version of this comment that claimed otherwise.
 *
 * The real reason the check is unnecessary here is that this walk visits the
 * PRODUCING node: the inner `sql.unsafe('…')` is itself a `.unsafe()` call the
 * visitor sees on its own, so DDL smuggled through a fragment is caught at the
 * point it is built rather than the point it is spliced.
 *
 * That guarantee held only WITHIN a file until #706: `listAuditedFiles()` globbed
 * `*.test.ts`/`*.test.tsx` only, so a helper exporting `` sql`ALTER TABLE …` ``
 * that a suite spliced as `` sql`${addCheck}` `` audited clean at both ends. The
 * file set now covers every `.ts`/`.tsx` under `__tests__/`, so the producing
 * node is scanned wherever it was written.
 *
 * BOUND: a fragment built OUTSIDE `__tests__/` entirely — a `src/` module a suite
 * imports — is still invisible, as is the `e2e/` Playwright lane
 * (`listAuditedFiles`' own BOUND says why). Neither has an occurrence today, and
 * closing them means either scanning the production tree for test-only hazards or
 * resolving imports with a type checker, both of which cost more than a CI guard
 * against accidental DDL is worth.
 */
function hidesStatementStart(node: ts.TemplateExpression): boolean {
  let priorStatic = node.head.text;
  for (const span of node.templateSpans) {
    const trimmed = blankSqlComments(priorStatic).trimEnd();
    if (trimmed === '' || trimmed.endsWith(';')) return true;
    priorStatic += span.literal.text;
  }
  return false;
}

interface ExecutedSql {
  /** Absolute offset in the source where `text` begins. */
  start: number;
  /**
   * SQL source text, or null when a `.unsafe()` argument is not statically
   * readable — an opaque expression, or a template whose substitution sits where
   * a statement begins and could therefore BE the DDL.
   */
  text: string | null;
  /** Line of the executing node — used to report an unreadable argument. */
  line: number;
}

/**
 * `.unsafe()` reached through a property access (`db.unsafe(…)`) or a
 * string-keyed element access (`sql['unsafe'](…)`).
 *
 * BOUND: a receiver-less alias is invisible — `const { unsafe } = sql`,
 * `sql.unsafe.bind(sql)`, or the handle passed anywhere as a function value.
 * Resolving those needs a type checker; this walk has no symbol table, so it
 * cannot tell the Postgres.js method from an unrelated local of the same name.
 * Zero occurrences in the tree today (49 `.unsafe()` calls, every one a
 * property access), and a suite reaching for one of those forms is doing
 * something deliberate enough to be reviewed — same blast-radius honesty
 * LIVE_DB_MARKERS carries above.
 */
function isUnsafeCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text === 'unsafe';
  if (ts.isElementAccessExpression(callee)) {
    const key = callee.argumentExpression;
    return ts.isStringLiteralLike(key) && key.text === 'unsafe';
  }
  return false;
}

/**
 * Every statement a live-DB suite EXECUTES. No tag-name allowlist: `sql()` is the
 * plurality of tagged templates in these files (~770 of ~1470) and its tag is a
 * CallExpression, so a name list (SQL_TAG_NAMES) would miss more than it caught —
 * the #592 defect shape. In a file that reaches the live DB, a tagged template IS
 * SQL; all 21 distinct tag forms across the marker-passing suites are DB handles,
 * and none of those files carries a non-SQL tagged-template DSL. See the header
 * for why the counts are a census rather than a constant.
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
          (ts.isTemplateExpression(arg) && !hidesStatementStart(arg)));
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
 *
 * The lines are derived from `source` rather than passed in — one string, one
 * representation — and stay RAW: `blankSqlComments` applies only to the text the
 * DDL verb is matched against, because `lineHasPragma` has to see the pragma
 * comment it keys on.
 */
function unpragmaedDdlLines(source: ts.SourceFile): number[] {
  const lines: string[] = source.getFullText().split('\n');
  const hits = new Set<number>();
  for (const sql of extractExecutedSql(source)) {
    if (sql.text === null) {
      hits.add(sql.line);
      continue;
    }
    for (const match of blankSqlComments(sql.text).matchAll(DDL_VERB)) {
      hits.add(source.getLineAndCharacterOfPosition(sql.start + (match.index ?? 0)).line);
    }
  }
  return [...hits]
    .sort((a, b) => a - b)
    .filter((line) => !lineHasPragma(lines, line, DDL_PRAGMA));
}

/**
 * A SUITE, to this audit, is a file whose NAME ends `.test.ts`/`.test.tsx`. That
 * is a suffix test, not a check that vitest would run the file: every one of
 * `vitest.config.ts`' include globs additionally requires `__tests__/` in the
 * path, and `INTEGRATION_GLOB` narrows the serialized project to
 * `*.integration.test.ts` within that. Everything else this audit scans is a
 * HELPER: imported BY a suite, never run as one.
 *
 * The two disagree on exactly one tracked file today —
 * `src/lib/shared/index.test.ts`, an intentionally empty placeholder outside
 * `__tests__/`, which this predicate calls a suite and no vitest include
 * matches. The suffix test is deliberate all the same: that file has been in the
 * audited set since #573 and narrowing to `__tests__/` would shrink the scan for
 * no gain. The bound is that if such a file ever reached the DB, R1 would tell
 * its author to rename it for a serialization that never applies, and the real
 * hazard — a live-DB test nothing executes — would go unreported.
 *
 * The distinction is what makes R1 sound, and it is why the two rules do not
 * share a unit. Naming is a claim about which vitest project a file lands in, so
 * it can only be asked of a file vitest runs; a helper renamed to
 * `*.integration.test.ts` would be executed as an empty suite. R2 and the lock
 * check ask instead whether the file takes ACCESS EXCLUSIVE on a shared
 * relation, which is true of that statement wherever it was written — including
 * in a helper whose fragment a suite splices in as raw SQL.
 */
function isSuite(file: string): boolean {
  return file.endsWith('.test.ts') || file.endsWith('.test.tsx');
}

export function auditLiveDbFile(file: string, text: string): LiveDbFileFinding[] {
  if (NOT_LIVE_DB.has(file)) return [];

  const suite = isSuite(file);
  const reachesDb =
    LIVE_DB_MARKERS.some((marker) => text.includes(marker)) ||
    (!suite && HELPER_DB_MARKER.test(text));
  if (!reachesDb) return [];

  const findings: LiveDbFileFinding[] = [];

  if (suite && !file.endsWith('.integration.test.ts')) {
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
  const ddlLines = unpragmaedDdlLines(source);
  if (ddlLines.length === 0) return findings;

  const firstAt = `first at line ${(ddlLines[0] ?? 0) + 1}`;

  if (!MIGRATION_SHAPE_FILES.has(file) && !DDL_PROBE_FILES.has(file)) {
    findings.push({
      file,
      rule: 'runtime-ddl',
      reason:
        `live-DB file executes DDL at run time (${firstAt}) — ACCESS EXCLUSIVE locks ` +
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
        `allowlisted file executes DDL (${firstAt}) without the cross-process live-DB ` +
        'lock — call acquireLiveDbLock() in beforeAll and release it in afterAll',
    });
  }
  return findings;
}

/**
 * Every file the conventions apply to: the SUITES vitest runs, plus the
 * non-suite modules under `__tests__/` that suites import.
 *
 * The second pathspec is what #706 added. A helper is not a runner entry point,
 * so it never matched `*.test.ts` — yet Postgres.js splices a nested `Query`
 * substitution in as raw SQL text (`fragment()`), so a helper can BUILD a DDL
 * statement that a scanned suite executes with no DDL text of its own. Scanning
 * the producing file is what keeps the AST walk's "visits the producing node"
 * guarantee true across files rather than only within one.
 *
 * `git ls-files` dedupes across pathspecs, so a `__tests__/x.test.ts` matched by
 * both appears once (asserted by this audit's own test — a double-listed file
 * would double-report every finding it carries).
 *
 * BOUND: the `e2e/` Playwright lane is deliberately absent. Those specs run in
 * their own `pnpm test:e2e` process and own their database lifecycle, so R1's
 * serialization premise — vitest's `integration` project against the parallel
 * project — does not hold there. `e2e/**\/__tests__\/**\/*.test.ts` carries
 * vitest unit tests and IS matched, by the first pathspec, as it always was.
 */
export function listAuditedFiles(): string[] {
  return execFileSync(
    'git',
    ['ls-files', '*.test.ts', '*.test.tsx', '*__tests__/*.ts', '*__tests__/*.tsx'],
    { encoding: 'utf8' },
  )
    .split('\n')
    .filter(Boolean);
}

async function main(): Promise<void> {
  const findings: LiveDbFileFinding[] = [];
  for (const file of listAuditedFiles()) {
    findings.push(...auditLiveDbFile(file, await readFile(file, 'utf8')));
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
