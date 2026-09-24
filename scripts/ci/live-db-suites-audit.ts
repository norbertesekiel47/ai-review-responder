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
//      suite that misses it runs in the fully parallel project alongside every
//      other non-integration file, unsynchronized against every other live-DB
//      writer. (No count here, deliberately: it moves with every test file added
//      or renamed, and the copy that used to sit in this sentence had drifted
//      well away from the tree by the time anyone checked it — the same way the
//      figure removed from `listAuditedFiles`' BOUND had. Recount by subtracting
//      the `integration` project's files from vitest's matched set.)
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
// R3 — LOCK COVERAGE IS PER BLOCK (#958). An allowlisted file's DDL must run
//      inside a describe block whose own `beforeAll` acquires the suite lock
//      (`acquireLiveDbLock`), or under a file-scope `beforeAll` that does. The
//      check it replaces read the FILE for the identifier, so a second top-level
//      block — a `describe.skipIf` required-database sentinel beside a locked
//      `describeWithDb`, the onboarding-drip shape — could run DDL unlocked with
//      the audit green. `blockCoverage` owns the rule and its bound.
//
// R4 — NO LANE-KEY USE INSIDE A LANE (#958). The integration lane holds
//      `LIVE_DB_LANE_KEY` SHARED from its globalSetup for its whole run, so any
//      lane file that asks for that key exclusive waits on its own process until
//      the acquisition timeout. Only the protocol's owner module may name it.
//
// The two rules do not share a unit, and #706 made that explicit. A SUITE is a
// file NAMED `*.test.ts`/`*.test.tsx` — a suffix test, which is not the same
// question as whether vitest runs the file; a HELPER is any other `.ts`/`.tsx`
// under `__tests__/`. R1 applies to suites only; R2 and the lock check apply to
// every live-DB file, helpers included. `isSuite`'s JSDoc owns the argument for
// why, and names where the suffix test and vitest's include globs diverge.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { lineHasPragma } from './lib/sql-tag-scan';

export interface LiveDbFileFinding {
  file: string;
  rule: 'naming' | 'runtime-ddl' | 'unlocked-ddl' | 'lane-key';
  reason: string;
}

/**
 * Files that mention TEST_DATABASE_POOL_URL without connecting to it:
 * `describe-with-db.test.ts` manipulates the variable to exercise the DB-gating
 * helper, this audit's own test carries violating source as fixtures, and
 * `ci-audit-wiring.test.ts` asserts that ci.yml's `test` job SETS the variable —
 * it reads workflow YAML off disk and opens no connection. Renaming that last
 * one to `*.integration.test.ts` would be actively wrong: R1's serialization
 * exists to stop DB contention, so it would move a file that touches no
 * database into the serialized project for nothing.
 */
const NOT_LIVE_DB = new Set([
  'src/__tests__/helpers/describe-with-db.test.ts',
  'scripts/ci/__tests__/live-db-suites-audit.test.ts',
  'src/__tests__/ci-audit-wiring.test.ts',
  // Same class as `ci-audit-wiring.test.ts`, one step further out: it asserts
  // that the red-team mutation runner's ENVIRONMENT ALLOWLIST passes
  // `TEST_DATABASE_POOL_URL` through and refuses a non-local host. The variable
  // is the subject of the assertion, never a connection — the suite opens no
  // database at all, so serializing it would cost the `integration` project a
  // file for nothing.
  'scripts/ci/__tests__/red-team-mutation-runner.test.ts',
  // #958's lane-lease unit test: every lease in it runs on a FAKE session, and
  // it names the variable only to assert that Playwright's globalSetup passes
  // it to the lease. Its one real socket goes to 127.0.0.1:1, where nothing
  // listens, to pin the connection-refused skip; it never reaches Postgres.
  'src/lib/shared/__tests__/helpers/live-db-lane.test.ts',
]);

/**
 * Migration-shape files: applying the migration IS the subject. Each suite's
 * subject is one migration's shape (no count here — it moves with every suite
 * that converts from parsing SQL text to executing it, and a figure written in
 * prose goes stale the way R1's did). Every entry must hold the cross-process
 * suite lock around its DDL, block by block (R3, enforced below).
 *
 * Only SUITES belong here. `apply-migration-074.ts` — a helper that ran 074's
 * DDL conditionally for four suites under its own `repworth_migration_074_apply`
 * key, which provisioning never excluded — was retired by #958: the test DB is
 * at head by construction (the lane validates the provision marker before any
 * suite starts), so its three consumers assert the schema instead, and the 074
 * shape suite's rolled-back re-apply runs under the suite lock like every other
 * entry. A helper cannot hold a lock on its caller's behalf, and R3 reports one
 * that tries: it has no test block of its own for the lock to cover.
 */
const MIGRATION_SHAPE_FILES = new Set([
  'src/lib/shared/__tests__/migration-074-trust-dial-veto-window.integration.test.ts',
  'src/lib/shared/__tests__/migration-076-judge-verdicts-governor.integration.test.ts',
  'src/lib/shared/__tests__/migration-077-copilot-autopilot.integration.test.ts',
  'src/lib/shared/__tests__/migration-078-copilot-autopilot.integration.test.ts',
  'src/lib/shared/__tests__/migration-088-solicitation-batch-executor.integration.test.ts',
  // 119 (#1171): applying the migration IS the subject, and here that is the
  // whole point rather than a convenience. Four independent red-team passes
  // each defeated a regex approximation of a SQL lexer — whitespace, then
  // `/**/`, then `--` inside a string literal, then a comment standing in as
  // evidence — and each fix closed one lexical class while the next pass found
  // a new instance of it. The suite therefore stops PARSING the checked-in file
  // and EXECUTES it: it degrades `job_outbox` to the pre-119 posture, asserts
  // that vulnerable state really exists so the case cannot pass vacuously,
  // applies the file verbatim through `db.unsafe`, and asserts the hardened
  // catalogue. Execution is immune to every lexical evasion at once.
  'src/lib/shared/__tests__/migration-119-job-outbox-rls.integration.test.ts',
  // 121 executes the real constraint extension and compares the public catalogue.
  'src/lib/shared/__tests__/migration-121-operator-refusals.integration.test.ts',
  // 122 (#1176) degrades every public table's client grants and the owner's
  // default ACL, executes the real file twice, then restores and verifies.
  'src/lib/shared/__tests__/migration-122-client-role-grant-sweep.integration.test.ts',
  // #1301 — the seven suites that stopped PARSING their migration's SQL text
  // and started EXECUTING it, on the shared `migration-guard.ts` helper. Each
  // degrades the objects its migration creates inside a rolled-back
  // transaction, proves the degrade landed, applies the checked-in file
  // verbatim, and diffs the whole `public` catalogue against the before-read.
  // The helper itself is NOT here: it only reads, compares and wraps the
  // transaction, so it executes no DDL and holds no lock — every `unsafe(ddl)`
  // call stays in the suite, which is what makes the lock check below
  // meaningful (it reads the file's OWN text).
  //
  // Entries for suites that do not exist yet are inert, not aspirational:
  // membership is read ONLY as `MIGRATION_SHAPE_FILES.has(file)` below, for a
  // file `listAuditedFiles()` actually found, so an entry naming a missing file
  // is never consulted and nothing iterates this set.
  //
  // 048 degrades impersonation_sessions: RLS off and its four indexes dropped,
  // including the partial one-active-session-per-actor unique.
  'src/lib/shared/__tests__/migration-048-impersonation-sessions.integration.test.ts',
  // 049 degrades analytics_events: row level security switched off, the one
  // thing the migration turns on.
  'src/lib/shared/__tests__/migration-049-analytics-events-rls.integration.test.ts',
  // 051 degrades flagged_responses: deny-all RLS off and both indexes dropped,
  // including the partial one-open-flag-per-response unique.
  'src/lib/shared/__tests__/migration-051-flagged-responses.integration.test.ts',
  // 053 degrades users: the users_role_check owner/admin allowlist CHECK
  // dropped — the migration's only object.
  'src/lib/shared/__tests__/migration-053-users-role-constraint.integration.test.ts',
  // 057 degrades FIVE columns the OTHER way: NOT NULL reinstated on
  // account_offboardings.zernio_account_ids and .zernio_profile_ids,
  // approval_audit_log.response_id, and impersonation_sessions.account_id and
  // .impersonated_user_id. (This said "four" and then listed five; the suite's
  // own title says five — #1301 RT-10/S-9.)
  'src/lib/shared/__tests__/migration-057-account-offboarding-tombstone-nullability.integration.test.ts',
  // 117 degrades admin_audit_log: deny-all RLS off, client-role privileges
  // granted back, and both actor/event indexes dropped.
  'src/lib/shared/__tests__/migration-117-admin-audit-log.integration.test.ts',
  // 118 degrades poller_heartbeats TOTALLY, and it is the only suite here that
  // does: `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO
  // anon, authenticated` followed by `DROP TABLE poller_heartbeats`. The
  // re-applied CREATE TABLE then inherits the permissive defaults, which is
  // what makes the migration's REVOKE a challenged assertion rather than a
  // restatement. It never disables RLS. (This said "deny-all RLS off and the
  // client-role privileges the migration revokes granted back", which hid the
  // one degrade in this set that reaches a SCHEMA-level object — #1301
  // RT-6/S-8.)
  'src/lib/shared/__tests__/migration-118-poller-heartbeats.integration.test.ts',
  // #1384 — the three RLS-policy guard suites the 2026-09-20 architecture pass
  // named as D8's actual priority (deny-all is a different mechanism, #1300):
  // 035 creates the owner_account_id()-predicate policies on every protected
  // table, 040+041 narrow the businesses/channel_enrollments write surface by
  // column-level GRANT/REVOKE, and 045 adds deny-by-default-then-one-policy RLS
  // to onboarding_demos. Each degrades the catalogue state its migration
  // establishes, proves the degrade landed, applies the checked-in file(s)
  // verbatim, and diffs the whole `public` catalogue.
  'src/lib/shared/__tests__/migration-035-rls-policies.integration.test.ts',
  'src/lib/shared/__tests__/migration-040-rls-tightening.integration.test.ts',
  'src/lib/shared/__tests__/migration-045-onboarding-demos-rls.integration.test.ts',
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

/** R4: the lane key's identifier and literal, and the one module that may name them. */
const LANE_KEY_IDENTIFIER = 'LIVE_DB_LANE_KEY';
const LANE_KEY_LITERAL = 'repworth_live_db_lane';
const LANE_KEY_OWNER = 'src/lib/shared/__tests__/helpers/live-db-lane.ts';

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
 * BOUND: the marker is a text match on those two spellings, so what escapes it
 * is a helper whose handle is typed WITHOUT the module being named in this
 * file — a bare generic parameter (`db: T`), a `Sql` imported from a module that
 * re-exports it, or a cast to a structural type declared locally. Casting
 * through `unknown` is not itself an escape: `as unknown as
 * import('postgres').Sql` names the module and is matched, which is the form
 * both in-tree sites use and what the inline-spelling test pins. The no-`any`
 * invariant plus the visible `Sql`/`TransactionSql` typings on all six make
 * reaching for one of the escaping shapes a deliberate act rather than an
 * accident — same blast-radius honesty LIVE_DB_MARKERS carries.
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
  /** The executing node itself — R3 walks its ancestors to find the covering block. */
  node: ts.Node;
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
        node,
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
        node,
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
function unpragmaedDdl(source: ts.SourceFile): { line: number; node: ts.Node }[] {
  const lines: string[] = source.getFullText().split('\n');
  const hits = new Map<number, ts.Node>();
  for (const sql of extractExecutedSql(source)) {
    if (sql.text === null) {
      if (!hits.has(sql.line)) hits.set(sql.line, sql.node);
      continue;
    }
    for (const match of blankSqlComments(sql.text).matchAll(DDL_VERB)) {
      const line = source.getLineAndCharacterOfPosition(sql.start + (match.index ?? 0)).line;
      if (!hits.has(line)) hits.set(line, sql.node);
    }
  }
  return [...hits.entries()]
    .sort(([a], [b]) => a - b)
    .filter(([line]) => !lineHasPragma(lines, line, DDL_PRAGMA))
    .map(([line, node]) => ({ line, node }));
}

// ---------------------------------------------------------------------------
// R3 — block-level lock coverage (#958).

const DESCRIBE_ROOTS = new Set(['describe', 'describeWithDb', 'suite']);
const TEST_ROOTS = new Set(['it', 'test']);
const HOOK_NAMES = new Set(['beforeAll', 'afterAll', 'beforeEach', 'afterEach']);

/**
 * The identifier a call chain starts from: `describe` for `describe(…)`,
 * `describe.skipIf(x)(…)`, `describe.each(rows)(…)` and `describe.sequential(…)`
 * alike — which is how a sentinel block and a table-driven block are recognised
 * as blocks without listing vitest's modifiers.
 */
function calleeRoot(expression: ts.Expression): string | undefined {
  let current: ts.Expression = expression;
  for (;;) {
    if (ts.isIdentifier(current)) return current.text;
    if (ts.isCallExpression(current) || ts.isPropertyAccessExpression(current)) {
      current = current.expression;
    } else if (ts.isElementAccessExpression(current) || ts.isNonNullExpression(current)) {
      current = current.expression;
    } else if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
    } else {
      return undefined;
    }
  }
}

function isDescribeCall(node: ts.Node): node is ts.CallExpression {
  return ts.isCallExpression(node) && DESCRIBE_ROOTS.has(calleeRoot(node.expression) ?? '');
}

function isBlockCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const root = calleeRoot(node.expression) ?? '';
  return DESCRIBE_ROOTS.has(root) || TEST_ROOTS.has(root);
}

function isHookCall(node: ts.Node, name?: string): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    HOOK_NAMES.has(node.expression.text) &&
    (name === undefined || node.expression.text === name)
  );
}

function containsLockAcquisition(node: ts.Node): boolean {
  if (ts.isCallExpression(node) && calleeRoot(node.expression) === SHARED_LOCK_MARKER) return true;
  return ts.forEachChild(node, containsLockAcquisition) ?? false;
}

/** Statement list of a block call's callback (the last function-like argument). */
function blockStatements(call: ts.CallExpression): readonly ts.Statement[] {
  const callback = [...call.arguments]
    .reverse()
    .find(
      (argument): argument is ts.ArrowFunction | ts.FunctionExpression =>
        ts.isArrowFunction(argument) || ts.isFunctionExpression(argument),
    );
  if (callback === undefined) return [];
  return ts.isBlock(callback.body) ? callback.body.statements : [];
}

/** A `beforeAll` among `statements` (not nested deeper) that acquires the suite lock. */
function acquiresInBeforeAll(statements: readonly ts.Statement[]): boolean {
  return statements.some(
    (statement) =>
      ts.isExpressionStatement(statement) &&
      isHookCall(statement.expression, 'beforeAll') &&
      containsLockAcquisition(statement.expression),
  );
}

/** The name a module-scope function or variable binds, when `node` is one. */
function moduleScopeBinding(source: ts.SourceFile, node: ts.Node): ts.Identifier | undefined {
  if (ts.isFunctionDeclaration(node) && node.parent === source) return node.name;
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.parent.parent.parent === source
  ) {
    return node.name;
  }
  return undefined;
}

/** Every place `binding` is USED in the file — its declaring name excluded. */
function referencesTo(source: ts.SourceFile, binding: ts.Identifier): ts.Identifier[] {
  const found: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isIdentifier(node) &&
      node !== binding &&
      node.text === binding.text &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
    ) {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * Whether the code at `node` runs under the suite lock.
 *
 * Walking up from the executing node:
 *  - an enclosing describe block whose OWN `beforeAll` acquires the lock covers
 *    it, and so does a file-scope `beforeAll` that does (vitest runs file-scope
 *    hooks for every block);
 *  - reaching a test or hook callback with no locked describe above it is
 *    uncovered — the onboarding-drip shape, a sentinel block beside the locked
 *    one;
 *  - reaching a module-scope helper FIRST (a function, or a variable holding a
 *    fragment or an arrow) defers to the places the helper is used: it is
 *    covered only if every reference to it is. A helper nobody references, and
 *    code executed at import time, are uncovered — the lock has to be taken
 *    where the test runs, which is also why a helper MODULE cannot be
 *    allowlisted on its own.
 *
 * DDL directly in a describe BODY runs at collection time, before any hook, and
 * is uncovered whatever that block acquires.
 *
 * BOUND: this is lexical and intra-file. A lock taken in a `beforeAll`
 * registered AFTER a sibling `beforeAll` that runs DDL is reported covered; a
 * function-valued local inside a describe body is assumed to run at test time;
 * and a helper passed to another module is followed only to where it is passed.
 * None of these shapes exists in an allowlisted suite; the last fails closed
 * when the passing site is itself uncovered.
 */
function isCoveredByLock(
  source: ts.SourceFile,
  node: ts.Node,
  visiting: Set<ts.Node> = new Set(),
): boolean {
  // `visiting` is the current reference PATH, not every node ever seen: two
  // sibling uses of one helper both walk through the same outer call site, and
  // only a helper that reaches itself (recursion) should read as uncovered.
  if (visiting.has(node)) return false;
  visiting.add(node);
  try {
    return walksToLockedBlock(source, node, visiting);
  } finally {
    visiting.delete(node);
  }
}

/** Every use of `binding` is itself covered — and there is at least one. */
function everyUseCovered(source: ts.SourceFile, binding: ts.Identifier, visiting: Set<ts.Node>): boolean {
  const uses = referencesTo(source, binding);
  return uses.length > 0 && uses.every((use) => isCoveredByLock(source, use, visiting));
}

/** The describe call `fn` is the body of, when it is one. */
function describeOwning(fn: ts.Node): ts.CallExpression | undefined {
  const owner = fn.parent;
  return owner !== undefined &&
    isDescribeCall(owner) &&
    owner.arguments.some((argument) => argument === fn)
    ? owner
    : undefined;
}

function walksToLockedBlock(source: ts.SourceFile, node: ts.Node, visiting: Set<ts.Node>): boolean {
  // Code runs at TEST time only once it sits inside a test or hook callback (or
  // a function something calls later). Directly in a describe body, it runs at
  // COLLECTION time — before any beforeAll, so no lock can cover it.
  let runsAtTestTime = false;
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    const binding = moduleScopeBinding(source, current);
    if (binding !== undefined) return everyUseCovered(source, binding, visiting);
    if (!ts.isFunctionLike(current)) continue;
    const describe = describeOwning(current);
    if (describe === undefined) {
      runsAtTestTime = true;
      continue;
    }
    if (!runsAtTestTime) return false;
    if (acquiresInBeforeAll(blockStatements(describe))) return true;
  }
  // Reached the file: a top-level test or hook is covered by a file-scope
  // beforeAll that takes the lock; import-time execution never is.
  return runsAtTestTime && acquiresInBeforeAll(source.statements);
}

/** R4: does `node` name the lane key — its identifier, or its literal in a string or template span? */
function mentionsLaneKey(node: ts.Node): boolean {
  if (ts.isIdentifier(node)) return node.text === LANE_KEY_IDENTIFIER;
  const isTextNode =
    ts.isStringLiteralLike(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node);
  return isTextNode && node.text.includes(LANE_KEY_LITERAL);
}

/** R4: the 0-based line of the first mention of the lane key, if any. */
function namesLaneKey(source: ts.SourceFile): number | undefined {
  const find = (node: ts.Node): ts.Node | undefined =>
    mentionsLaneKey(node) ? node : ts.forEachChild(node, find);
  const found = find(source);
  return found === undefined
    ? undefined
    : source.getLineAndCharacterOfPosition(found.getStart(source)).line;
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

  // R4 applies to what runs INSIDE the integration lane: its suites, and the
  // helpers they import. A parallel-project unit test holds no lane lease.
  const inLane = !suite || file.endsWith('.integration.test.ts');
  const laneKeyLine = inLane && file !== LANE_KEY_OWNER ? namesLaneKey(source) : undefined;
  if (laneKeyLine !== undefined) {
    findings.push({
      file,
      rule: 'lane-key',
      reason:
        `names the lane key at line ${laneKeyLine + 1} — the integration lane already holds it ` +
        'SHARED for its whole run, so an exclusive request from inside the lane waits on its own ' +
        'process until it times out (#958). Take the suite lock with acquireLiveDbLock() instead',
    });
  }

  const ddl = unpragmaedDdl(source);
  if (ddl.length === 0) return findings;

  const lineOfFirst = (hits: readonly { line: number }[]): string =>
    `first at line ${(hits[0]?.line ?? 0) + 1}`;

  if (!MIGRATION_SHAPE_FILES.has(file) && !DDL_PROBE_FILES.has(file)) {
    findings.push({
      file,
      rule: 'runtime-ddl',
      reason:
        `live-DB file executes DDL at run time (${lineOfFirst(ddl)}) — ACCESS EXCLUSIVE locks ` +
        'deadlock sibling suites (#573). Provision with `pnpm test:db:setup` and assert ' +
        'with assertSchemaReady() instead, or add a `-- live-db-ddl-ignore: <reason>` ' +
        'pragma if the target provably cannot be a shared relation',
    });
    return findings;
  }

  const uncovered = ddl.filter((hit) => !isCoveredByLock(source, hit.node));
  if (uncovered.length > 0) {
    findings.push({
      file,
      rule: 'unlocked-ddl',
      reason:
        `allowlisted file executes DDL (${lineOfFirst(uncovered)}) outside every block that holds ` +
        'the cross-process suite lock — call acquireLiveDbLock() in a beforeAll of the describe ' +
        'block that runs it (every top-level block, when the DDL lives in a module-scope helper), ' +
        'and release it in afterAll',
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
