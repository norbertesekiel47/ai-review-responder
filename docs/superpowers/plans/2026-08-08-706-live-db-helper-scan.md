# Live-DB helper scan (#706) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Widen `ci:live-db-suites` to scan non-suite files under `__tests__/`, so DDL built inside a helper and spliced into a suite as a Postgres.js fragment is no longer invisible.

**Architecture:** One module — `scripts/ci/live-db-suites-audit.ts` — is **deepened**, not widened. Its interface stays two functions with unchanged arity and shape; only the names stop lying (`auditLiveDbSuite`→`auditLiveDbFile`, `listTestFiles`→`listAuditedFiles`). Behind that surface the audit gains an *enforcement unit*: a **suite** (matches `*.test.{ts,tsx}`, vitest's runner entry glob) gets R1 naming + R2 DDL + the lock check; a **helper** (any other `.ts`/`.tsx` under `__tests__/`) gets R2 + the lock check but never R1, because a helper is not a runner entry point and cannot be renamed. Helpers are handed their DB handle as a parameter, so they name none of the suite-shaped `LIVE_DB_MARKERS`; the one thing they cannot avoid is *typing* that handle, so an import of `postgres` is the helper-only reachability marker.

**Tech Stack:** TypeScript, the `typescript` compiler API (AST walk, already in use), vitest, `git ls-files`.

---

## Context an implementer needs

**Read first:** `scripts/ci/live-db-suites-audit.ts` in full (394 lines, and its header is the spec for rules R1/R2). Then `.feature/intake.json` in this worktree.

**Why this rule exists at all.** The 45 `*.integration.test.ts` suites share ONE local Postgres. `vitest.config.ts` puts them in a serialized `integration` project; the other ~738 files run fully parallel. DDL takes `ACCESS EXCLUSIVE` on its target, so a suite that runs DDL deadlocks (40P01) against any sibling holding ordinary row locks in the opposite order — and Postgres picks the victim, so the failure lands somewhere unrelated and reads as flake. That is #573. #694 then found the *detector* was keying on an incidental marker and three suites were executing DDL invisibly; one stranded a temporary `CHECK` constraint on the shared container and cost 14 spurious failures across three unrelated suites.

**The residual hole this ticket closes.** Postgres.js does **not** always parameterise a tagged template's substitutions. `node_modules/postgres/src/types.js` routes a nested `Query` substitution through `fragment()`, splicing it in as raw SQL **text**. Proved live in #694's round-2 review:

```
sql`${sql.unsafe("select 42 as n")}`   -> [{"n":42}]     // inlined as SQL text
sql`select ${'40 + 2'} as n`           -> [{"n":"40 + 2"}] // bound, the normal case
```

The AST walk survives that because it visits the **producing** node — the inner `sql.unsafe(…)` is seen where it is built, not where it is spliced. But that only holds if the producing file is *scanned*. `listTestFiles()` globs `*.test.ts`/`*.test.tsx`, so a helper that exports a DDL fragment is never read:

```ts
// src/lib/shared/__tests__/helpers/some-helper.ts   <-- never scanned today
export const addCheck = sql`ALTER TABLE job_outbox ADD CONSTRAINT tmp_x CHECK (true) NOT VALID`;

// some.integration.test.ts                          <-- scanned, but holds no DDL text
await sql`${addCheck}`;
```

`live-db-suites-audit: passed` on a tree taking `ACCESS EXCLUSIVE` on `job_outbox`.

**Facts verified against the tree before this plan was written — do not re-derive, but do re-check if the tree moved:**

| Fact | Value |
|---|---|
| Files matched today (`*.test.ts`, `*.test.tsx`) | 904 |
| Files matched after widening | 917 (**+13**) |
| `git ls-files` dedupes across pathspecs | yes — `\| sort \| uniq -d` is empty |
| Non-suite `__tests__` files that fire `runtime-ddl` once the gate is opened | **exactly one**: `src/lib/shared/__tests__/helpers/apply-migration-074.ts` |
| Non-suite `__tests__` files importing `postgres` | 6 (`abort-injection`, `apply-migration-074`, `live-db-lock`, `outreach-fixture`, `schema-ready`, `live-db-tenant`) |
| Files referencing the renamed symbols | only the audit + its own test — **no external consumers, so no compat shim** |

**The 13 newly scanned files**, and what each does under the new rules:

```
--  clean   src/__tests__/helpers/describe-with-db.ts          (env-var marker, no DDL)
--  clean   src/lib/demos/__tests__/fixtures.ts                (no pg import -> not scanned)
PG  clean   src/lib/shared/__tests__/helpers/abort-injection.ts
PG  DDL     src/lib/shared/__tests__/helpers/apply-migration-074.ts   <-- allowlisted in Task 3
PG  clean   src/lib/shared/__tests__/helpers/live-db-lock.ts
PG  clean   src/lib/shared/__tests__/helpers/outreach-fixture.ts
PG  clean   src/lib/shared/__tests__/helpers/schema-ready.ts
PG  clean   src/lib/shared/__tests__/live-db-tenant.ts         <-- NOT under helpers/
--  clean   worker/__tests__/helpers/mock-sql.ts               (no pg import -> not scanned)
--  clean   worker/ingress/__tests__/helpers/stripe-webhook-harness.ts
--  clean   worker/ingress/__tests__/helpers/unsubscribe-app.ts
--  clean   worker/jobs/__tests__/summary-report-fixtures.ts
--  clean   worker/jobs/response-generation/__tests__/load-context-fixtures.ts
```

`live-db-tenant.ts` is why the enforcement unit is "non-suite file under `__tests__/`" and **not** the `__tests__/helpers/**` glob the ticket proposed: it is a live-DB tenant seeder that executes tagged templates against the shared DB and does not live in a `helpers/` directory.

**Anti-slop constraints for every task:**

- **Precedent:** the allowlist shape (`new Set([...])` of repo-relative paths + a JSDoc naming what is enforced in exchange) and the fixture style (`auditLiveDbFile(path, source)` → `expect(findings.map((finding) => finding.rule)).toEqual([...])`) both already exist in these two files. Follow them exactly.
- **No new file.** Everything lands in the two files that already exist.
- **No compat shim** for the renamed exports — verified zero external consumers.
- **Do not touch** `scripts/ci/lib/sql-tag-scan.ts`: it is shared with four SQL-vocabulary audits and must stay byte-identical.
- **Do not touch** `DDL_VERB`, `blankSqlComments`, `isUnsafeCall`, or `hidesStatementStart`'s *logic* — #694's precision heuristics are out of scope. Task 4 rewrites `hidesStatementStart`'s JSDoc only.
- This module's convention is that **every mechanism states its own blast radius** in a `BOUND:` paragraph. A new mechanism without one is an incomplete change.

**Blocking edges:** Task 1 → Task 2 → Task 3 → Task 4. Fully serial: all four touch the same two files, so none are mutually independent and none may be dispatched in parallel.

---

### Task 1: Eval — the eight promised tests, authored red

**Files:**
- Modify: `scripts/ci/__tests__/live-db-suites-audit.test.ts`

This is the spec in executable form. The eight titles are `tests_to_add` in `.feature/intake.json` and the step-5 gate checks each one exists **verbatim** — do not reword them.

They are authored against the *new* export names, which do not exist yet, so after this task the file fails to compile. That is the intended red: `pnpm vitest run scripts/ci/__tests__/live-db-suites-audit.test.ts` reports a transform/resolve error naming `auditLiveDbFile`. Task 2 makes it compile.

- [ ] **Step 1: Add the new fixture constants**

Insert after the existing `OPAQUE_UNSAFE` constant (currently line 24), keeping the existing JSDoc-comment style:

```ts
  /** A helper is handed its handle, so a `postgres` import is how it reaches the DB. */
  const HELPER_PG_IMPORT = "import type { Sql } from 'postgres';\n";
  /** The #706 shape: the helper BUILDS the statement, the suite only splices it. */
  const HELPER_FRAGMENT_DDL =
    'export const addCheck = sql`ALTER TABLE job_outbox ADD CONSTRAINT tmp_x CHECK (true) NOT VALID`;\n';
  const HELPER_PATH = 'src/lib/x/__tests__/helpers/frag.ts';
  const APPLY_074 = 'src/lib/shared/__tests__/helpers/apply-migration-074.ts';
```

- [ ] **Step 2: Write the eight failing tests**

Append inside the top-level `describe('live-db-suites-audit', …)` block, immediately before the existing repo-wide test (currently at line 307). Use `auditLiveDbFile` and `listAuditedFiles` — the names Task 2 introduces.

```ts
  // #706. The audit's file set came from `git ls-files '*.test.ts' '*.test.tsx'`,
  // which never reaches `__tests__/` modules that are not themselves suites. A
  // helper can therefore BUILD a DDL fragment that a scanned suite splices in as
  // raw SQL text (Postgres.js `fragment()`), and the audit sees neither half.
  //
  // The unit of enforcement is now explicit: a SUITE matches vitest's runner
  // entry glob and gets R1 (naming) + R2 (DDL) + the lock check; a HELPER is any
  // other `.ts`/`.tsx` under `__tests__/` and gets R2 + the lock check only —
  // it is not a runner entry point and cannot be renamed to *.integration.test.ts.
  describe('audits helpers as well as suites (#706)', () => {
    it('includes non-suite files under __tests__ in the audited file list', () => {
      const files = listAuditedFiles();
      expect(files).toContain(APPLY_074);
      // NOT under a helpers/ directory — why the unit is "non-suite file under
      // __tests__", not the `__tests__/helpers/**` glob the ticket proposed.
      expect(files).toContain('src/lib/shared/__tests__/live-db-tenant.ts');
      expect(files).toContain('scripts/ci/__tests__/live-db-suites-audit.test.ts');
      // git dedupes across pathspecs; assert it rather than trusting it, since a
      // double-listed file would double-report every finding it carries.
      expect(new Set(files).size).toBe(files.length);
    });

    it('flags DDL built in a helper module that a suite splices in as a fragment', () => {
      const helper = auditLiveDbFile(HELPER_PATH, HELPER_PG_IMPORT + HELPER_FRAGMENT_DDL);
      expect(helper.map((finding) => finding.rule)).toEqual(['runtime-ddl']);
      // The finding belongs to the file that BUILDS the statement. The suite
      // carries no DDL text and stays clean — correct, because the walk visits
      // the producing node, and cross-file provenance needs an import graph.
      const suite = auditLiveDbFile(
        'src/lib/x/__tests__/x.integration.test.ts',
        LIVE_DB + 'await sql`${addCheck}`;\n',
      );
      expect(suite).toEqual([]);
    });

    it('never reports the naming rule for a non-suite helper file', () => {
      // `describe-with-db.ts` names the env var and enters the scanned set with
      // this widening. It is a helper: no naming finding, and no DDL either.
      expect(auditLiveDbFile('src/__tests__/helpers/describe-with-db.ts', LIVE_DB)).toEqual([]);
      // A helper that DOES execute DDL reports runtime-ddl ALONE — never the
      // naming rule alongside it, however un-suite-like its filename.
      expect(
        auditLiveDbFile(HELPER_PATH, HELPER_PG_IMPORT + HELPER_FRAGMENT_DDL).map(
          (finding) => finding.rule,
        ),
      ).toEqual(['runtime-ddl']);
    });

    it('counts a type-only postgres import as a helper reaching the database', () => {
      // Four of the six DB-reaching helpers import the module type-only. A
      // value/type distinction here would re-open the hole immediately.
      const findings = auditLiveDbFile(
        HELPER_PATH,
        "import type postgres from 'postgres';\n" + OPAQUE_UNSAFE,
      );
      expect(findings.map((finding) => finding.rule)).toEqual(['runtime-ddl']);
    });

    it('ignores a non-suite helper that imports no DB handle at all', () => {
      // mock-sql.ts mocks the `sql` tag with vitest and touches no database. If
      // the gate did not hold, every mocked template would become a candidate
      // statement and the audit would flag pure unit-test scaffolding.
      expect(
        auditLiveDbFile(
          'worker/__tests__/helpers/mock-sql.ts',
          "import { vi } from 'vitest';\n" + HELPER_FRAGMENT_DDL,
        ),
      ).toEqual([]);
    });

    it('flags an allowlisted helper that executes DDL without its own apply lock', () => {
      const findings = auditLiveDbFile(APPLY_074, HELPER_PG_IMPORT + OPAQUE_UNSAFE);
      expect(findings.map((finding) => finding.rule)).toEqual(['unlocked-ddl']);
    });

    it('accepts the 074 apply helper on its own dedicated apply lock', () => {
      const findings = auditLiveDbFile(
        APPLY_074,
        HELPER_PG_IMPORT +
          'export async function withMigration074ApplyLock() {}\n' +
          OPAQUE_UNSAFE,
      );
      expect(findings).toEqual([]);
    });
  });
```

Then **retitle** the existing repo-wide test (currently line 307) — it is the eighth promised title:

```ts
  it('every live-DB file in the repository passes the widened detector', async () => {
```

- [ ] **Step 3: Rename every existing call site in this file**

`auditLiveDbSuite` → `auditLiveDbFile` and `listTestFiles` → `listAuditedFiles`, including the import on line 2. There are ~25 call sites; a whole-file replace of the two identifiers is correct — no other symbol shares those names.

- [ ] **Step 4: Run to verify it fails**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-706-live-db-helper-scan && pnpm vitest run scripts/ci/__tests__/live-db-suites-audit.test.ts`

Expected: FAIL — the module has no export named `auditLiveDbFile`.

- [ ] **Step 5: Commit**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-706-live-db-helper-scan
git add scripts/ci/__tests__/live-db-suites-audit.test.ts
git commit -m "test(#706): eval — helper-scan fixtures authored red against the new interface"
```

---

### Task 2: The file set and the enforcement unit

**Files:**
- Modify: `scripts/ci/live-db-suites-audit.ts`

Turns green: *includes non-suite files under __tests__ in the audited file list*, *never reports the naming rule for a non-suite helper file* (first assertion), and restores compilation for the whole suite.

Deliberately does **not** add the helper reachability marker — that is Task 3. After this task the widened glob scans 13 more files but only 2 pass the suite-shaped gate, both clean, so `pnpm ci:live-db-suites` stays green at this commit boundary.

- [ ] **Step 1: Widen and rename the file lister**

Replace `listTestFiles` (currently lines 366-370):

```ts
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
 * serialization premise — vitest's `integration` project against ~738 parallel
 * siblings — does not hold there. `e2e/**\/__tests__\/**\/*.test.ts` carries
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
```

- [ ] **Step 2: Add the enforcement-unit predicate**

Insert immediately above `auditLiveDbSuite` (currently line 310):

```ts
/**
 * A SUITE is a runner entry point — `vitest.config.ts` includes
 * `**\/__tests__\/**\/*.test.{ts,tsx}`, and `INTEGRATION_GLOB` narrows the
 * serialized project to `*.integration.test.ts` within it. Everything else this
 * audit scans is a HELPER: imported BY a suite, never run as one.
 *
 * The distinction is what makes R1 sound. Naming is a claim about which vitest
 * project a file lands in, so it can only be asked of a file vitest runs; a
 * helper renamed to `*.integration.test.ts` would be executed as an empty suite.
 * R2 and the lock check ask instead whether the file takes ACCESS EXCLUSIVE on a
 * shared relation, which is true of the statement wherever it was written.
 */
function isSuite(file: string): boolean {
  return file.endsWith('.test.ts') || file.endsWith('.test.tsx');
}
```

- [ ] **Step 3: Rename the exported audit and gate the naming rule on `isSuite`**

Rename `LiveDbSuiteFinding` → `LiveDbFileFinding` (interface at line 65 and both internal uses) and `auditLiveDbSuite` → `auditLiveDbFile`. Inside it, replace the naming block (currently lines 316-324):

```ts
  const suite = isSuite(file);

  if (suite && !file.endsWith('.integration.test.ts')) {
    findings.push({
      file,
      rule: 'naming',
      reason:
        'live-DB suite must be named *.integration.test.ts so vitest serializes it ' +
        'in the `integration` project (it currently runs in the parallel project)',
    });
  }
```

Note the `const findings` declaration must move above this block if it is not already there (it is at line 314 today — keep that order).

- [ ] **Step 4: Update the two remaining `listTestFiles` references**

`main()` (line 374) calls `listAuditedFiles()`.

- [ ] **Step 5: Run the audit's own suite**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-706-live-db-helper-scan && pnpm vitest run scripts/ci/__tests__/live-db-suites-audit.test.ts`

Expected: the file compiles; *includes non-suite files…* and *every live-DB file in the repository…* PASS. Still FAILING (Task 3's work): *flags DDL built in a helper module…*, *counts a type-only postgres import…*, *flags an allowlisted helper…*, *accepts the 074 apply helper…*.

- [ ] **Step 6: Prove the widening did not break the real tree**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-706-live-db-helper-scan && pnpm ci:live-db-suites`

Expected: `live-db-suites-audit: passed`.

- [ ] **Step 7: Commit**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-706-live-db-helper-scan
git add scripts/ci/live-db-suites-audit.ts
git commit -m "feat(#706): scan non-suite __tests__ files; R1 naming applies to suites only"
```

---

### Task 3: Helper reachability + the one real DDL helper

**Files:**
- Modify: `scripts/ci/live-db-suites-audit.ts`

Turns green: the remaining four — *flags DDL built in a helper module that a suite splices in as a fragment*, *counts a type-only postgres import as a helper reaching the database*, *ignores a non-suite helper that imports no DB handle at all*, *flags an allowlisted helper that executes DDL without its own apply lock*, *accepts the 074 apply helper on its own dedicated apply lock*.

The marker and the allowlist land in **one** task on purpose: opening the gate without sanctioning `apply-migration-074.ts` would leave the tree red at a commit boundary, and this is a tracer bullet, not a horizontal layer.

- [ ] **Step 1: Add the helper-only reachability marker**

Insert directly below the `LIVE_DB_MARKERS` / `SHARED_LOCK_MARKER` / `OWN_LOCK_MARKER` block (currently ending line 133):

```ts
/**
 * How a HELPER reaches the database. `LIVE_DB_MARKERS` above is suite-shaped —
 * the env var by name, or an import of the module that resolves it — and a
 * helper matches none of it, because it is HANDED its handle (`db: postgres.Sql`,
 * `tx: TransactionSql`). Widening the file glob alone would therefore have
 * reached 2 of the 13 new files and left the ticket's own hazard open.
 *
 * What a helper cannot avoid is TYPING that handle, and `postgres` is the only
 * module that supplies the type. Value and type-only imports both count: four of
 * the six DB-reaching helpers use `import type`, and a distinction there would
 * re-open the hole on the first one written.
 *
 * BOUND: a helper that types its handle as `unknown` and casts, or takes it
 * through a generic parameter, is invisible. The no-`any` invariant plus the
 * visible `Sql`/`TransactionSql` typings on all six make that a deliberate act
 * rather than an accident — same blast-radius honesty LIVE_DB_MARKERS carries.
 */
const HELPER_DB_MARKER = /\bfrom ['"]postgres['"]/;
```

- [ ] **Step 2: Branch the reachability gate on the unit**

In `auditLiveDbFile`, replace the marker check (currently line 312). `isSuite` must be computed before it, so hoist the `const suite = isSuite(file);` line Task 2 added to sit directly under the `NOT_LIVE_DB` guard:

```ts
export function auditLiveDbFile(file: string, text: string): LiveDbFileFinding[] {
  if (NOT_LIVE_DB.has(file)) return [];

  const suite = isSuite(file);
  const reachesDb =
    LIVE_DB_MARKERS.some((marker) => text.includes(marker)) ||
    (!suite && HELPER_DB_MARKER.test(text));
  if (!reachesDb) return [];
```

`HELPER_DB_MARKER` is deliberately not offered to suites: ~740 parallel unit tests import `postgres` types to shape a mock, and admitting them would fire R1 across the tree on files that reach no database.

- [ ] **Step 3: Rename both allowlists and sanction the 074 helper**

The sets no longer hold only suites, and a `_SUITES` name that contains a helper is exactly the false-claim defect class #694's review round 2 filed as R1. Rename `MIGRATION_SHAPE_SUITES` → `MIGRATION_SHAPE_FILES` (declaration line 85, use line 338) and `DDL_PROBE_SUITES` → `DDL_PROBE_FILES` (declaration line 101, use line 338). Replace the migration-shape block with:

```ts
/**
 * Migration-shape files: applying the migration IS the subject. Five suites test
 * a migration's shape; `apply-migration-074.ts` is the shared guarded apply that
 * five of them and the wider tree delegate to, and it executes the real file via
 * `db.unsafe(readMigration074Sql())` — an argument this walk cannot read, which
 * counts as DDL by design (#706 made it visible; it was never audited before).
 * Every entry must hold a cross-process lock (enforced below).
 */
const MIGRATION_SHAPE_FILES = new Set([
  'src/lib/shared/__tests__/migration-074-trust-dial-veto-window.integration.test.ts',
  'src/lib/shared/__tests__/migration-076-judge-verdicts-governor.integration.test.ts',
  'src/lib/shared/__tests__/migration-077-copilot-autopilot.integration.test.ts',
  'src/lib/shared/__tests__/migration-078-copilot-autopilot.integration.test.ts',
  'src/lib/shared/__tests__/migration-088-solicitation-batch-executor.integration.test.ts',
  'src/lib/shared/__tests__/helpers/apply-migration-074.ts',
]);
```

And extend `OWN_APPLY_LOCK` (line 111), updating its JSDoc:

```ts
/**
 * 074 predates the shared lock and serializes on its own dedicated apply lock
 * (`withMigration074ApplyLock`), which is equally cross-process. Accepted as an
 * alternative to `acquireLiveDbLock` for the 074 shape suite and for the helper
 * that DEFINES that lock — which is also the answer to "a helper cannot hold a
 * lock on its own behalf": this one does, and the check is on the file's OWN
 * text. Inheriting a caller's lock would need an import graph, so an allowlisted
 * file that does not name its lock marker is `unlocked-ddl`, never a pass.
 */
const OWN_APPLY_LOCK = new Set([
  'src/lib/shared/__tests__/migration-074-trust-dial-veto-window.integration.test.ts',
  'src/lib/shared/__tests__/helpers/apply-migration-074.ts',
]);
```

- [ ] **Step 4: Update the two finding reasons that say "suite"**

The `runtime-ddl` and `unlocked-ddl` reasons (lines 343 and 359) now fire on helpers too:

```ts
        `live-DB file executes DDL at run time (${firstAt}) — ACCESS EXCLUSIVE locks ` +
```

```ts
        `allowlisted file executes DDL (${firstAt}) without the cross-process live-DB ` +
```

The `naming` reason keeps the word "suite" — it can only fire on one.

- [ ] **Step 5: Run the audit's own suite**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-706-live-db-helper-scan && pnpm vitest run scripts/ci/__tests__/live-db-suites-audit.test.ts`

Expected: PASS, all cases including the four #694 precision fixtures (regex literal, `toContain`, comment, unexecuted constant) and the repo-wide zero-offenders case.

- [ ] **Step 6: Prove the new enforcement is load-bearing, not decorative**

The repo-wide test passes whether the detector works or has gone blind — that is the #694 failure mode. Mutate to prove reach, **in memory only, leaving the source untouched**:

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-706-live-db-helper-scan
npx tsx -e "
import { readFileSync } from 'node:fs';
import { auditLiveDbFile } from './scripts/ci/live-db-suites-audit';
const f = 'src/lib/shared/__tests__/helpers/apply-migration-074.ts';
const src = readFileSync(f, 'utf8');
console.log('as shipped   ->', JSON.stringify(auditLiveDbFile(f, src).map((x) => x.rule)));
console.log('lock stripped ->', JSON.stringify(
  auditLiveDbFile(f, src.replaceAll('withMigration074ApplyLock', 'withSomeOtherLock')).map((x) => x.rule)));
"
```

Expected exactly:
```
as shipped   -> []
lock stripped -> ["unlocked-ddl"]
```

If the second line is `[]`, the allowlist is silencing rather than enforcing — stop and report.

- [ ] **Step 7: Run the audit and the full type check**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-706-live-db-helper-scan && pnpm ci:live-db-suites && pnpm typecheck`

Expected: `live-db-suites-audit: passed`, typecheck clean.

- [ ] **Step 8: Commit**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-706-live-db-helper-scan
git add scripts/ci/live-db-suites-audit.ts
git commit -m "feat(#706): helper reachability via postgres import; sanction + lock-enforce the 074 apply helper"
```

---

### Task 4: Truth maintenance — every claim this change falsifies

**Files:**
- Modify: `scripts/ci/live-db-suites-audit.ts` (header + `hidesStatementStart` JSDoc)
- Modify: `.claude/reference/lab-notes.md`
- Modify: `.claude/CLAUDE.md`
- Modify: `docs/currents.md`
- Modify: `docs/progresstracking.md`

Turns green: nothing — and it is still mandatory. Four documents currently assert this hole is open, and one of them is the audit's own JSDoc. #694's review round 2 filed its only Medium finding against precisely this: a comment asserting something untrue, with no behaviour wrong. Shipping the fix while the prose still says "the ten `__tests__/helpers/*.ts` modules are never scanned" repeats that ticket's defect one release later.

- [ ] **Step 1: Rewrite the `hidesStatementStart` BOUND paragraph**

Replace the final paragraph (currently lines 188-194, beginning "BOUND, and it follows directly:"):

```
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
```

- [ ] **Step 2: Extend the module header with the enforcement unit**

Insert between the `R1 — NAMING` block and the `R2 — NO RUN-TIME DDL` block (currently line 25):

```
// The two rules do not share a unit, and #706 made that explicit. A SUITE is a
// file vitest runs (`*.test.{ts,tsx}`); a HELPER is any other `.ts`/`.tsx` under
// `__tests__/`. R1 asks which vitest project a file lands in, so it can only be
// asked of a suite. R2 and the lock check ask whether a statement takes ACCESS
// EXCLUSIVE on a shared relation, which is true of that statement wherever it was
// written — including in a helper whose fragment a suite splices in as raw SQL.
```

Also update the `R1 — NAMING.` opening sentence to read "A live-DB **suite**" and `R2`'s to read "A live-DB **file**".

- [ ] **Step 3: Sharpen the CLAUDE.md gotcha bullet**

In `.claude/CLAUDE.md`, the "Non-obvious gotchas" bullet currently opens: **"A live-DB suite must be named `*.integration.test.ts` and must NOT execute DDL at run time."** Those two halves now have different units. Rewrite the opening to:

```
- **A live-DB *suite* must be named `*.integration.test.ts`; no live-DB *file* — suite or `__tests__/` helper — may execute DDL at run time.**
```

Then, in the same bullet, after the "Detection is AST extraction of **executed SQL**…" sentence, append:

```
The audited set is every `.ts`/`.tsx` under `__tests__/`, not just the suites (#706): Postgres.js splices a nested `Query` substitution in as raw SQL text, so a helper can build a DDL fragment a suite executes — the finding lands on the file that BUILDS it. Helpers reach the DB by importing `postgres` (they are handed the handle, so they name no env var); the `e2e/` Playwright lane is deliberately out of scope.
```

- [ ] **Step 4: Update the lab-notes bullet**

`.claude/reference/lab-notes.md` line 22 carries the same two-halves-one-unit claim. Apply the same split, and add `#706` alongside the existing `#573`/`#694` references. Then add a dated entry in the `## 2026-07-26 — #573 live-DB suite deadlock under gate load` section's format:

```
- [2026-08-08] `ci:live-db-suites` audited only files matching `*.test.ts`, so DDL built inside a `__tests__/` helper was invisible → Postgres.js routes a nested `Query` substitution through `fragment()` and splices it in as raw SQL **text**, not as a bind value, so `` sql`${addCheck}` `` really executes a helper's `` sql`ALTER TABLE …` ``; the AST walk's "visits the producing node" guarantee held only within a scanned file → scan every `.ts`/`.tsx` under `__tests__/`, split the enforcement unit (naming = suites, DDL + lock = files), and gate helpers on a `postgres` import since they are handed their handle and name no env var (#706). `apply-migration-074.ts` was the one real occurrence and is now lock-enforced.
```

- [ ] **Step 5: Update currents.md and progresstracking.md**

`docs/currents.md:180` and `docs/progresstracking.md:2112` both state #706 as a known open bound. Both must now read as closed, naming what shipped: the widened file set, the suite/helper unit split, the `postgres`-import helper marker, the `apply-migration-074.ts` sanction, and the two remaining bounds (outside `__tests__/`, and the `e2e/` lane). `docs/currents.md`'s "Last updated" line and lead paragraph follow the file's existing convention.

- [ ] **Step 6: Verify no stale cross-reference survives**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-706-live-db-helper-scan && rg -n "never scanned|listTestFiles|auditLiveDbSuite|MIGRATION_SHAPE_SUITES|DDL_PROBE_SUITES" --glob '!node_modules' --glob '!docs/superpowers/plans/**' --glob '!docs/reviews/**'`

Expected: no hits outside historical review/deviations records under the excluded globs. A hit anywhere else is a claim this change falsified.

- [ ] **Step 7: Commit**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-706-live-db-helper-scan
git add scripts/ci/live-db-suites-audit.ts .claude/reference/lab-notes.md .claude/CLAUDE.md docs/currents.md docs/progresstracking.md
git commit -m "docs(#706): retire the helper-scan bound from the audit header, CLAUDE.md, lab notes, currents"
```

---

## Self-review

**Spec coverage.** Every `tests_to_add` title maps to a task: seven authored in Task 1 and turned green by Tasks 2–3, the eighth (`every live-DB file…`) a retitle in Task 1 that Task 2 restores. Every intake `edge_case` is covered — E1 (`live-db-tenant.ts`) Task 1 Step 2 assertion; E2 (074) Task 3; E3/E4 (parameter-handed handle, type-only import) Task 3 Step 1 + its test; E5 (`mock-sql.ts`) the *ignores a non-suite helper…* case; E6/E7 (`NOT_LIVE_DB`) unchanged and asserted by the file-list case; E8 (own-text lock) Task 3 Step 3 JSDoc + the two 074 cases; E9 (finding lands on the helper) the fragment case's second assertion; E10 (disjoint sets) `isSuite` being a pure filename predicate. Every `non_goal` is respected: no `e2e/` scanning, no precision-heuristic edits, `LIVE_DB_MARKERS` untouched for suites, no import-graph work, no ADR.

**Placeholder scan.** No TBDs; every code step carries the literal text to write, and every command carries its expected output.

**Type consistency.** `auditLiveDbFile`, `listAuditedFiles`, `LiveDbFileFinding`, `isSuite`, `HELPER_DB_MARKER`, `MIGRATION_SHAPE_FILES`, `DDL_PROBE_FILES`, `OWN_APPLY_LOCK` are spelled identically in Tasks 1–4 and in the test fixtures. The three `rule` values are unchanged from today, so no consumer of the finding shape moves.

**Known ordering hazard.** Task 2 introduces `const suite = isSuite(file);` inside the naming block's scope and Task 3 hoists it above the reachability gate. An implementer doing Task 3 without re-reading Task 2's output will get a `used before declared` typecheck error — Task 3 Step 2 shows the full function prologue for exactly that reason.
