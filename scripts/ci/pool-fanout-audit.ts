// scripts/ci/pool-fanout-audit.ts
//
// The #773/#505 pool-fan-out invariant, enforced by a RULE instead of by a list
// of subjects someone remembered to add.
//
// ---------------------------------------------------------------------------
// Why this exists: the enumeration missed three times
// ---------------------------------------------------------------------------
//
// The guard was four hand-written pins with enumerated import lists
// (`src/lib/{admin,dashboard,locations}/__tests__/pool-fanout-sequential.test.ts`
// and `src/lib/admin/__tests__/admin-read-single-inflight.test.ts`). A pin can
// only fail for a service someone imported into it, so it is silent about every
// service nobody thought of. Three were found by three different passes, all in
// the directory the pins are supposed to cover:
//
//   1. `lookupSuppressions`     (2026-08-18 pass, suppressions-service.ts)
//   2. `getAdminNotifications`  (2026-08-22 pass, notifications-service.ts)
//   3. the cost-report rollup branch + `processRow` (2026-08-23, this change)
//
// An enumeration that misses three times is not an enumeration that needs three
// more entries. So the pins are left exactly as they are — deliberately NOT
// widened, per #893 — and this audit becomes the thing that cannot miss a
// subject, because it never names one.
//
// ---------------------------------------------------------------------------
// The hazard, in one paragraph
// ---------------------------------------------------------------------------
//
// These modules run on Vercel against the shared singleton whose pool is
// `DB_POOL_MAX` = 3 per Fluid Compute isolate (`src/lib/db/server.ts`), and an
// isolate serves overlapping requests, so a fan-out multiplies across callers.
// When a wave is wider than the pool, postgres.js pipelines the excess onto
// connections that are already open; over the Supabase Supavisor TRANSACTION
// pooler the pipelined response then parks server-side in `state=active,
// wait_event=ClientRead` and is never read. `statement_timeout` cannot heal it —
// in `ClientRead` the statement is not executing. Every wedge leaks a pool slot
// until the pool starves. Observed live: the admin portal, staging 2026-08-10.
//
// FAN-OUT ≤ POOL IS NOT THE SAFE CONDITION. `/api/admin/flagged` wedged with a
// fan-out of TWO against the 3-connection pool (2026-08-13). The rule below is
// therefore "two or more", not "more than the pool".
//
// The #773 admission chokepoint (`src/lib/db/admission.ts`) bounds the damage
// today — cap == pool means queue rather than pipeline — and says in its own
// header that it is "not a substitute for" bounding per-request fan-out. This
// audit is the other half it names.
//
// ---------------------------------------------------------------------------
// What is a finding
// ---------------------------------------------------------------------------
//
// A `Promise.all` / `allSettled` / `race` / `any` under SCAN_DIRS whose element
// list contains TWO OR MORE DB-issuing elements. An element is DB-issuing when
// it is:
//
//   (a) a tagged template on a sql binding                — sql`…`
//   (b) a query method on one                             — sql.unsafe(…), tx.begin(…)
//   (c) a call that PASSES one as an argument             — getAccountById(sql, id)
//
// (c) is in the rule on purpose, and it is the form the pins could never have
// caught by inspection: `processRow` fanned out THREE reads built entirely from
// helper calls, so nothing in the expression mentioned `sql` twice. Indirection
// does not shrink a wave. A rule that counted only (a) would also have missed
// `getAdminNotifications`, which is two-thirds `sql.unsafe` — exactly as the
// tagged-template-shaped pins did.
//
// FAIL-CLOSED on an unreadable shape, the posture `ci:outbox-seam` and
// `ci:admin-aal2` take: a combinator whose argument is not a readable array
// literal (a spread, an identifier, a `.map(...)`) cannot have its elements
// counted, so it is REPORTED rather than passed. Silence on an unrecognized
// shape is how a guard becomes decorative.
//
// THAT COST IS ACCEPTED EXPLICITLY, not incidentally. `Promise.all(tasks)` with
// NO database work in it is reported too, because this audit cannot tell that
// from `Promise.all(ids.map(id => getThing(sql, id)))` — an UNBOUNDED fan-out,
// which is strictly worse than the two-element case the rule exists for. In
// these three directories there are zero such sites today, and a legitimate one
// costs a single `// pool-fanout-allow: <reason>` line with its reason. Scanning
// the argument's subtree instead would pass a bare `Promise.all(tasks)` whose
// array was built two lines up, which is the blind spot the posture exists to
// refuse. If this ever becomes noisy in practice, change it deliberately and
// record what the new rule cannot see.
//
// ---------------------------------------------------------------------------
// The escape, and its boundary
// ---------------------------------------------------------------------------
//
// `// pool-fanout-allow: <reason>` on the site's own line or on a comment-only
// line directly above it. The reason is REQUIRED — a bare pragma is its own
// finding, because an unexplained exemption is the enumeration problem wearing a
// different hat. Every allowed site is printed on the pass line, so an exemption
// stays visible instead of going quiet. There are ZERO uses today.
//
// ---------------------------------------------------------------------------
// Two scope boundaries, stated rather than implied
// ---------------------------------------------------------------------------
//
// 1. SCAN_DIRS is the three service directories #893 names, NOT `src/app/**`. A
//    composition root can still write `Promise.all([serviceA(sql),
//    serviceB(sql)])` in a route or a server component and this audit will not
//    see it; the mitigation there is the admission chokepoint plus review.
//    Widening the root is a one-line change to SCAN_DIRS and a separate review —
//    do it deliberately, not as a side effect.
//
//    ONE CONSEQUENCE IS A FORMAL DEVIATION FROM #893, and it is recorded on the
//    ticket rather than buried here: #893 asks for a named, reasoned allowlist
//    entry for `src/app/api/admin/jobs/route.ts:27`. That file is outside this
//    root, and its combinator is ONE database call plus one Redis call, so the
//    >= 2 rule could not report it even if the root were widened. The allowlist
//    MECHANISM ships; it has zero entries because there is nothing to exempt.
//
// 2. THE DEFERRED-AWAIT FORM IS NOT COVERED, and it is a genuine hole:
//
//        const rows = getA(sql);        // starts now
//        const count = getB(sql);       // also starts now — concurrent
//        return [await rows, await count];
//
//    There is no combinator to find, and the syntactic proxy that would catch it
//    ("a DB-issuing call that is not awaited") is unusable here because the
//    fragment builders have exactly that shape on purpose
//    (`optionalAccountPrefix(sql, accountId)` in cost-report-service builds a
//    VALUE, never a round trip). Every fan-out this repo has actually shipped
//    used a combinator, so the rule covers the observed form and says out loud
//    what it does not. The four runtime pins keep covering their eight named
//    subjects for this case — which is also why this change does not delete
//    them, only stops adding to them.
//
// NO NEW PER-SERVICE PINS. Sequencing four services and then writing four new
// single-in-flight tests would rebuild the enumeration in a new location, one
// file further apart. The services' own existing suites prove the sequencing
// changed no behaviour; this audit proves the shape cannot come back.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { SQL_TAG_NAMES } from './lib/sql-tag-scan';
import { walk } from './lib/ratchet-harness';

/** The service directories whose reads run on the shared Vercel pool. */
export const SCAN_DIRS = ['src/lib/admin', 'src/lib/dashboard', 'src/lib/locations'] as const;

/** The per-site escape. A reason after the colon is mandatory. */
export const PRAGMA = 'pool-fanout-allow';

/**
 * Every `Promise` combinator that starts its elements CONCURRENTLY. `race` and
 * `any` are here for the same reason `all` is: they settle differently, but all
 * four dispatch every element in the same tick, which is the property that
 * pipelines a query onto a busy connection.
 */
const COMBINATORS: ReadonlySet<string> = new Set(['all', 'allSettled', 'race', 'any']);

/**
 * Type names that mark a binding as a Postgres.js client. Invariant #15 makes
 * this reliable: domain modules RECEIVE their client as an explicit typed
 * parameter, so the annotation is present at the only place that matters.
 */
const SQL_TYPE_RE = /\b(?:Sql|TransactionSql|ReservedSql|SqlExecutor|PendingQuery)\b/;

/**
 * Methods on a sql binding that build a VALUE rather than issue a query.
 * `sql.json(x)` inside a `Promise.all` element is not a round trip and must not
 * be counted as one.
 */
const NON_QUERY_METHODS: ReadonlySet<string> = new Set(['json', 'array', 'types', 'typed']);

/** Callback-taking methods whose parameter is itself a sql binding. */
const SCOPE_METHODS: ReadonlySet<string> = new Set(['begin', 'savepoint', 'reserve']);

export interface FanoutSite {
  /** 1-based line of the combinator call. */
  line: number;
  /** `all` | `allSettled` | `race` | `any`. */
  combinator: string;
  /** Count of DB-issuing elements, or -1 when the element list is unreadable. */
  dbElements: number;
}

/** Strips the wrappers that sit between an array element and its real expression. */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  for (;;) {
    if (ts.isParenthesizedExpression(current) || ts.isAwaitExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isAsExpression(current) || ts.isNonNullExpression(current) || ts.isTypeAssertionExpression(current)) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

/** The root identifier of `sql`, `sql.unsafe`, `a.b.c` — or null. */
function rootIdentifier(node: ts.Expression): string | null {
  let current: ts.Expression = node;
  for (;;) {
    if (ts.isIdentifier(current)) return current.text;
    if (ts.isPropertyAccessExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    return null;
  }
}

/**
 * Every name in this file that holds a Postgres.js client.
 *
 * Two sources, and both are needed. The TYPE annotation catches the parameter
 * convention invariant #15 mandates, whatever it is spelled. `SQL_TAG_NAMES`
 * catches the inferred cases the annotation cannot reach — chiefly a
 * `sql.begin(tx => …)` callback parameter — and it is safe to trust because
 * `ci:static-policy`'s `sql-executor-tag-name` rule already fails a
 * SqlExecutor-typed parameter used under a name outside that set.
 */
export function collectSqlBindings(source: ts.SourceFile): Set<string> {
  const names = new Set<string>(SQL_TAG_NAMES);

  const visit = (node: ts.Node): void => {
    if ((ts.isParameter(node) || ts.isVariableDeclaration(node)) && node.type && ts.isIdentifier(node.name)) {
      if (SQL_TYPE_RE.test(node.type.getText(source))) names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  // Second pass: a callback parameter of `<known>.begin(cb)` is itself a client,
  // and its type is inferred rather than annotated.
  const expand = (node: ts.Node): void => {
    for (const name of scopeCallbackBindings(node, names)) names.add(name);
    ts.forEachChild(node, expand);
  };
  expand(source);

  return names;
}

/**
 * The callback-parameter names a `<known sql>.begin(cb)` (or `savepoint`,
 * `reserve`) introduces — each of which is itself a Postgres client whose type
 * is inferred rather than written, so `collectSqlBindings`'s annotation pass
 * cannot see it.
 *
 * Split out of that pass rather than nested inside it: four guards deep, the
 * intent stops being readable, and a name this returns wrongly is a name the
 * whole audit then trusts.
 */
function scopeCallbackBindings(node: ts.Node, names: ReadonlySet<string>): string[] {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return [];
  if (!SCOPE_METHODS.has(node.expression.name.text)) return [];
  const root = rootIdentifier(node.expression.expression);
  if (root === null || !names.has(root)) return [];

  return node.arguments.flatMap((arg) => {
    if (!ts.isArrowFunction(arg) && !ts.isFunctionExpression(arg)) return [];
    const first = arg.parameters[0];
    return first && ts.isIdentifier(first.name) ? [first.name.text] : [];
  });
}

/**
 * True when this array element issues at least one query on a sql binding
 * ANYWHERE in its subtree.
 *
 * A SUBTREE SCAN, not a hand-listed set of shapes, and that is the second thing
 * branch review corrected. The first version matched three top-level forms —
 * a tagged template, a query method, a call passing the binding — plus a
 * conditional. Every other wrapper slipped through as ZERO:
 *
 *   Promise.all([enabled && sql`…`, sql`…`])        // logical operand
 *   Promise.all([withTimeout(sql`…`), sql`…`])      // query wrapped in a call
 *   Promise.all([memoize(() => sql`…`), sql`…`])    // query inside a thunk
 *
 * Each counted ONE and passed, against a ticket that asks for "any Promise.all
 * with >= 2 query calls". Enumerating shapes is the same mistake as enumerating
 * subjects, one level down, so the shapes are gone: find the query wherever it
 * is.
 *
 * FUNCTION BODIES ARE INCLUDED, which reverses the first version. The carve-out
 * existed for `settledInOrder`, the sanctioned sequential analog, which takes
 * thunks — but `settledInOrder` is not a `Promise` combinator and never reaches
 * this scan at all (pinned below). So skipping thunks bought nothing and cost
 * the memoize form above. A literal `Promise.all([() => sql`a`, () => sql`b`])`
 * is now reported; it is also broken code, since a combinator never invokes a
 * thunk.
 *
 * `sql.json(x)` still counts for nothing at any depth: it builds a VALUE, and
 * the fragment builders pass it around freely.
 */
export function isDbIssuing(element: ts.Expression, sqlNames: ReadonlySet<string>): boolean {
  let found = false;

  const visit = (node: ts.Node): void => {
    if (found) return;

    if (ts.isTaggedTemplateExpression(node)) {
      const root = rootIdentifier(node.tag);
      if (root !== null && sqlNames.has(root)) {
        found = true;
        return;
      }
    }

    if (ts.isCallExpression(node)) {
      // (b) a query method on a sql binding.
      if (ts.isPropertyAccessExpression(node.expression)) {
        const root = rootIdentifier(node.expression.expression);
        if (root !== null && sqlNames.has(root) && !NON_QUERY_METHODS.has(node.expression.name.text)) {
          found = true;
          return;
        }
      }
      // (c) a call that hands a sql binding to someone else.
      if (
        node.arguments.some((arg) => {
          const inner = unwrap(arg);
          return ts.isIdentifier(inner) && sqlNames.has(inner.text);
        })
      ) {
        found = true;
        return;
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(element);
  return found;
}

/**
 * Every `Promise` combinator site in one file, with its DB-issuing element
 * count. `dbElements === -1` marks a shape this audit could not read, which the
 * evaluator treats as a finding rather than a pass.
 */
export function findFanoutSites(text: string, fileName = 'file.ts'): FanoutSite[] {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const sqlNames = collectSqlBindings(source);
  const sites: FanoutSite[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'Promise' &&
      COMBINATORS.has(node.expression.name.text)
    ) {
      const arg = node.arguments[0];
      if (arg) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        let dbElements: number;
        if (!ts.isArrayLiteralExpression(arg)) {
          dbElements = -1;
        } else if (arg.elements.some((element) => ts.isSpreadElement(element))) {
          dbElements = -1;
        } else {
          dbElements = arg.elements.filter((element) => isDbIssuing(element, sqlNames)).length;
        }
        sites.push({ line, combinator: node.expression.name.text, dbElements });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  return sites;
}

/**
 * The reason attached to a site's pragma, `''` for a pragma with no reason, or
 * null when there is no pragma. Same placement rule the SQL audits use: the
 * site's own line, or a comment-only line directly above it — a CODE line's
 * trailing pragma never blankets the line below.
 */
export function pragmaReason(lines: readonly string[], lineIndex: number): string | null {
  const candidates: string[] = [];
  const own = lines[lineIndex];
  if (own !== undefined) candidates.push(own);
  const previous = lineIndex > 0 ? lines[lineIndex - 1] : undefined;
  if (previous !== undefined && previous.trimStart().startsWith('//')) candidates.push(previous);

  for (const line of candidates) {
    const index = line.indexOf(PRAGMA);
    if (index === -1) continue;
    const rest = line.slice(index + PRAGMA.length);
    const match = rest.match(/^:\s*(\S.*?)\s*$/);
    return match ? match[1]! : '';
  }
  return null;
}

export interface FileSites {
  file: string;
  text: string;
  sites: readonly FanoutSite[];
}

export interface Evaluation {
  findings: string[];
  allowed: string[];
}

/** The message for a site whose element list this audit could not read. */
function unreadableMessage(at: string, combinator: string): string {
  return (
    `${at} — Promise.${combinator}'s argument is not a readable array literal, so its elements ` +
    `cannot be counted. Sequence it, or add \`// ${PRAGMA}: <reason>\` above it.`
  );
}

/** The message for a counted fan-out. */
function fanoutMessage(at: string, combinator: string, dbElements: number): string {
  return (
    `${at} — Promise.${combinator} fans out ${dbElements} DB-issuing elements on a pool of ` +
    'DB_POOL_MAX=3. Two is already enough to wedge a backend (#773). Sequence them, or add ' +
    `\`// ${PRAGMA}: <reason>\` above it.`
  );
}

/** One site's verdict: a finding, an allowance, or neither. */
export interface SiteVerdict {
  finding?: string;
  allowed?: string;
}

/**
 * The judgement for ONE site, pure and separately testable — the shape
 * `ci:outbox-seam`'s own `judgeSite` uses, for the same reason: the loop that
 * walks files should not also carry the policy.
 */
export function judgeSite(file: string, lines: readonly string[], site: FanoutSite): SiteVerdict {
  if (site.dbElements !== -1 && site.dbElements < 2) return {};

  const at = `${file}:${site.line}`;
  const reason = pragmaReason(lines, site.line - 1);

  if (reason === '') {
    return {
      finding:
        `${at} — \`${PRAGMA}\` with no reason. An unexplained exemption is the enumeration ` +
        'problem in a new shape; write why this fan-out is safe.',
    };
  }
  if (reason !== null) return { allowed: `${at} — ${reason}` };

  return {
    finding:
      site.dbElements === -1
        ? unreadableMessage(at, site.combinator)
        : fanoutMessage(at, site.combinator, site.dbElements),
  };
}

/**
 * One finding per offending site. STRICT — no baseline, the posture
 * `ci:db-imports` settled on. Pure, so the unit tests drive it directly.
 */
export function evaluateFindings(files: readonly FileSites[]): Evaluation {
  const findings: string[] = [];
  const allowed: string[] = [];

  for (const { file, text, sites } of files) {
    const lines = text.split('\n');
    for (const site of sites) {
      const verdict = judgeSite(file, lines, site);
      if (verdict.finding !== undefined) findings.push(verdict.finding);
      if (verdict.allowed !== undefined) allowed.push(verdict.allowed);
    }
  }

  return { findings, allowed };
}

export async function collectFanoutSites(root: string): Promise<FileSites[]> {
  const files = await walk(root, { scanDirs: [...SCAN_DIRS] });
  const collected: FileSites[] = [];
  for (const file of files.sort()) {
    const text = await readFile(resolve(root, file), 'utf8');
    if (!text.includes('Promise.')) continue;
    const sites = findFanoutSites(text, file);
    if (sites.length > 0) collected.push({ file, text, sites });
  }
  return collected;
}

/**
 * Proof, at audit time, that the classifier still classifies. A silent
 * detector reports success on a clean tree and on a broken one alike — the
 * #592/#604 failure mode, and the reason the pins carry their own
 * "guards the guard" case. Kept as a fixture rather than a test import so the
 * check runs in CI's `lint` job, where no test runner is present.
 */
const SELF_CHECK = `
import type { Sql } from 'postgres';
export async function probe(sql: Sql, id: string) {
  const [a, b] = await Promise.all([sql\`SELECT 1\`, sql.unsafe('SELECT 2', [])]);
  const c = await Promise.all([helper(sql, id), other(sql, id)]);
  return [a, b, c];
}
`;

export function selfCheckPasses(): boolean {
  const sites = findFanoutSites(SELF_CHECK, 'self-check.ts');
  return sites.length === 2 && sites.every((site) => site.dbElements === 2);
}

/**
 * The reason this run must ABORT before judging anything, or null.
 *
 * Both arms are blind-detector guards, and both refuse rather than pass: a
 * classifier that stopped classifying and a walk that found no files each
 * produce a clean, green, meaningless run.
 */
export function preflightBlocker(scannedCount: number): string | null {
  if (!selfCheckPasses()) {
    return (
      'pool-fanout-audit: fatal — the built-in self-check fixture no longer produces two ' +
      'two-element findings. The classifier is broken; a green run would mean nothing.'
    );
  }
  if (scannedCount === 0) {
    return `pool-fanout-audit: fatal — scanned 0 files under ${SCAN_DIRS.join(', ')}`;
  }
  return null;
}

/** One terminal report: what to print, and what to exit with. */
export interface AuditReport {
  text: string;
  exitCode: number;
}

/**
 * The run's terminal report. Separated from `main` so both arms are covered by
 * tests rather than by the one integration run CI happens to take — the same
 * split `ci:merge-ledger` uses.
 */
export function buildReport(input: {
  findings: readonly string[];
  allowed: readonly string[];
  scannedCount: number;
}): AuditReport {
  if (input.findings.length > 0) {
    return {
      text: ['pool-fanout-audit: failed', ...input.findings.map((f) => `  ${f}`)].join('\n'),
      exitCode: 1,
    };
  }
  const allowedNote =
    input.allowed.length === 0
      ? 'no exemptions'
      : `${input.allowed.length} exempted: ${input.allowed.join('; ')}`;
  return {
    text:
      `pool-fanout-audit: passed (${input.scannedCount} files under ` +
      `${SCAN_DIRS.join(', ')}; ${allowedNote})`,
    exitCode: 0,
  };
}

async function main(): Promise<void> {
  const root = process.cwd();
  const scanned = await walk(root, { scanDirs: [...SCAN_DIRS] });

  const blocker = preflightBlocker(scanned.length);
  if (blocker !== null) {
    console.error(blocker);
    process.exit(1);
  }

  const { findings, allowed } = evaluateFindings(await collectFanoutSites(root));
  const report = buildReport({ findings, allowed, scannedCount: scanned.length });

  if (report.exitCode !== 0) {
    console.error(report.text);
    process.exit(report.exitCode);
  }
  console.log(report.text);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((err) => {
    console.error('pool-fanout-audit: fatal error');
    console.error(err);
    process.exit(1);
  });
}
