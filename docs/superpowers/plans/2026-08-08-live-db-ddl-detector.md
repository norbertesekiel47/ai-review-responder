# live-DB run-time DDL detector (#694) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `ci:live-db-suites`' R2 marker heuristic with AST extraction of EXECUTED SQL, so run-time DDL is detected by what a suite runs rather than by whether it happens to name `supabase/migrations`, and bring all seven real DDL sites into compliance.

**Architecture:** `auditLiveDbSuite(file, text) → findings[]` keeps its exact signature — this is a module DEEPENING, not a widening. Inside, the two string markers (`MIGRATION_DIR_MARKER`, `RAW_SQL_MARKER`) are deleted and replaced by a TypeScript AST walk that collects every tagged template and every `.unsafe()` call in the file, then runs a DDL-verb regex over the collected SQL only. In a file already proven to reach the live DB by `LIVE_DB_MARKERS`, every tagged template is SQL — so the extractor uses NO tag-name allowlist (see "Why presume-all" below). Two escape hatches: a file allowlist for suites whose DDL is sanctioned (enforced to hold a cross-process lock), and a per-line `live-db-ddl-ignore` pragma for DDL whose safety is invisible to static analysis.

**Tech Stack:** TypeScript compiler API (`typescript`, already a dependency and already used by 8 sibling audits), `tsx`, vitest, Postgres.js.

---

## Why presume-all (the decision that shapes Task 1)

A census of tag forms across all 78 live-DB suites:

```
 770  sql()          <- CallExpression tag
 265  tx  *          145  db  *        120  sql *        73  db!   <- NonNullExpression
  39  sqlA()          17  dbA           12  observerSql()   9  db()
   6  seed             2  client         2  exec *          2  observer
   1 each: sqlD() dbC tierSql() handle boundedSql recorder! dbB dbTier
                                          (* = in SQL_TAG_NAMES)
```

`SQL_TAG_NAMES` (`sql`, `tx`, `db`, `exec`) would see ~530 of 1469 templates and **miss `sql()` — the single most common executor in these files, 770 uses**. That is the #592 defect shape `sql-tag-scan.ts`'s own header warns about, and repeating it here would ship the same class of bug this ticket exists to fix.

All 21 distinct forms are DB handles. There is no `it.each`/`describe.each` table, no `css`, no `gql`, no `String.raw` in any of the 80 files. So: **every tagged template and every `.unsafe()` call in a live-DB suite is presumed SQL.** A future non-SQL tagged template containing a DDL verb is handled by the pragma.

Consequence: **`scripts/ci/lib/sql-tag-scan.ts` is NOT modified.** It is imported for `lineHasPragma` only. The four SQL vocabulary audits keep byte-identical behavior.

## Deliberate boundaries (verified, not assumed)

- **DCL (`GRANT`/`REVOKE`) is out of the verb set.** Every executed GRANT in the repo is `outreach-render.integration.test.ts:359-360` and `migration-091-send-mode-spine.integration.test.ts:1211-1212` — both files enter `DDL_PROBE_SUITES` in Task 1 and both already hold `acquireLiveDbLock`. `migration-076:137`'s `REVOKE` is a non-executed string constant in an expectation array. Adding DCL today would change no finding.
- **`CREATE TEMP TABLE` gets no structural carve-out.** It matches the verb set and takes a pragma like the two index builds beside it, so all three migration-080 sites read uniformly and the pg_temp reasoning sits where a reader needs it.
- **Fail-closed on opaque `.unsafe()`.** All 13 non-literal `.unsafe()` arguments in the repo are `readMigration0NNSql()` inside already-allowlisted suites (074/076/077/078/088), so fail-closed produces zero new findings today while keeping unreadable SQL from passing as safe.

## File structure

| File | Responsibility | Change |
|---|---|---|
| `scripts/ci/live-db-suites-audit.ts` | R1 naming + R2 no-run-time-DDL rules | **Deepen**: AST extraction replaces two string markers; add `DDL_PROBE_SUITES` + pragma |
| `scripts/ci/__tests__/live-db-suites-audit.test.ts` | Proves reach AND precision | Extend: 18 titles |
| `scripts/ci/lib/sql-tag-scan.ts` | Shared scan primitives | **None** — `lineHasPragma` imported only |
| `src/lib/shared/__tests__/helpers/abort-injection.ts` | Non-DDL transaction-abort injection | **New** (second use; #679 built it inline) |
| `src/lib/shared/__tests__/helpers/schema-ready.ts` | Assert-never-apply schema contract | Add `MIGRATION_083_OUTBOX_OWNER_UNREACHABLE` |
| `src/lib/reviews/__tests__/import-offer-analytics.integration.test.ts` | #679's rollback + emission coverage | Migrate to the shared helper (caller 1) |
| `src/app/api/dashboard/import-offer/__tests__/route.integration.test.ts` | Route-level consent rollback | Replace DDL injection with the helper (caller 2) |
| `worker/background/pollers/__tests__/NotificationFailoverPoller.integration.test.ts` | Owner-unreachable arm | Delete bootstrap ALTER → assert 083 |
| `worker/background/pollers/health-alert/__tests__/checks.integration.test.ts` | Owner-unreachable health check | Delete bootstrap ALTER → assert 083 |
| `worker/background/schedulers/__tests__/migration-080-outbox-dedup.integration.test.ts` | 080 preflight + index semantics | 3 pragmas |

## Task graph

```
T0 (eval, alone — also the enforcement spot check)
     |
     +-- T1 detector  --+
     +-- T2 bootstrap --+
     +-- T3 injection --+--> T5 repo-wide green --> T6 docs
     +-- T4 pragmas   --+
```

T1–T4 are **mutually independent**: no blocking edges, disjoint file sets. The pragma token `live-db-ddl-ignore` is locked HERE so T4 does not have to wait on T1.

---

### Task 0: Eval — the failable definition of done

**Files:**
- Modify: `scripts/ci/__tests__/live-db-suites-audit.test.ts`

Write all 18 audit titles as real tests against the CURRENT `auditLiveDbSuite`. Most fail immediately (the current detector cannot see plain-template DDL and has no `DDL_PROBE_SUITES` export). Two — `still flags run-time migration DDL in a suite that is on no allowlist` and `still ignores a file that never reaches the live test DB` — pass today and are regression guards; that is intended.

- [ ] **Step 1: Add the fixture constants at the top of the describe block**

```ts
/** A plain tagged template — no `.unsafe(`, no `supabase/migrations` anywhere. */
const PLAIN_TEMPLATE_DDL = "await db`ALTER TABLE job_outbox ADD COLUMN IF NOT EXISTS x TEXT`;\n";
/** `.unsafe()` on a call-form receiver — the 770-use `sql()` shape. */
const CALL_FORM_UNSAFE_DDL = "await sql().unsafe('ALTER TABLE job_outbox DROP CONSTRAINT c');\n";
/** A non-null-asserted tag — the 73-use `db!` shape. */
const NON_NULL_TAG_DDL = "await db!`CREATE INDEX idx_x ON job_outbox (topic)`;\n";
/** `.unsafe()` whose argument cannot be read statically. */
const OPAQUE_UNSAFE = 'await db.unsafe(readMigrationSql());\n';
```

- [ ] **Step 2: Write the three reach tests**

```ts
it('flags DDL executed through a plain tagged template in a file containing no .unsafe( at all', () => {
  const source = LIVE_DB + PLAIN_TEMPLATE_DDL;
  expect(source).not.toContain('.unsafe(');
  expect(source).not.toContain('supabase/migrations');
  const findings = auditLiveDbSuite('src/lib/x/__tests__/x.integration.test.ts', source);
  expect(findings.map((finding) => finding.rule)).toEqual(['runtime-ddl']);
});

it('flags DDL executed through .unsafe() on a call-form receiver such as sql()', () => {
  const findings = auditLiveDbSuite(
    'src/lib/x/__tests__/x.integration.test.ts',
    LIVE_DB + CALL_FORM_UNSAFE_DDL,
  );
  expect(findings.map((finding) => finding.rule)).toEqual(['runtime-ddl']);
});

it('flags DDL executed through a tagged template whose tag is a non-null assertion such as db!', () => {
  const findings = auditLiveDbSuite(
    'src/lib/x/__tests__/x.integration.test.ts',
    LIVE_DB + NON_NULL_TAG_DDL,
  );
  expect(findings.map((finding) => finding.rule)).toEqual(['runtime-ddl']);
});
```

- [ ] **Step 3: Write the four precision tests**

Each fixture is drawn from a REAL suite that must stay clean — cite it in a comment.

```ts
// migration-102-import-consent-analytics-events.integration.test.ts:56
it('ignores a DDL verb that appears only inside a regex literal', () => {
  const source =
    LIVE_DB +
    'expect(sql).toMatch(/ALTER TABLE analytics_events\\s+DROP CONSTRAINT x/i);\n';
  expect(auditLiveDbSuite('src/lib/x/__tests__/x.integration.test.ts', source)).toEqual([]);
});

// migration-096-solicitation-suppressions.integration.test.ts:610
it('ignores a DDL verb that appears only inside an expect().toContain() assertion', () => {
  const source = LIVE_DB + "expect(globalIndex).toContain('CREATE UNIQUE INDEX');\n";
  expect(auditLiveDbSuite('src/lib/x/__tests__/x.integration.test.ts', source)).toEqual([]);
});

// migration-079-agent-run-spine-archival.integration.test.ts:6
it('ignores a DDL verb that appears only inside a comment', () => {
  const source = LIVE_DB + '// Migration 079 adds two CREATE INDEX CONCURRENTLY scan indexes.\n';
  expect(auditLiveDbSuite('src/lib/x/__tests__/x.integration.test.ts', source)).toEqual([]);
});

// migration-076-judge-verdicts-governor.integration.test.ts:115-142
it('ignores a DDL verb that appears only in a string constant that is never executed', () => {
  const source =
    LIVE_DB +
    "const EXPECTED = ['CREATE TABLE IF NOT EXISTS judge_verdicts (', 'ALTER TABLE judge_verdicts ENABLE ROW LEVEL SECURITY;'];\n";
  expect(auditLiveDbSuite('src/lib/x/__tests__/x.integration.test.ts', source)).toEqual([]);
});
```

- [ ] **Step 4: Write the fail-closed test**

```ts
it('treats .unsafe() with a non-literal argument as applied DDL rather than as safe', () => {
  const source = LIVE_DB + OPAQUE_UNSAFE;
  expect(source).not.toContain('supabase/migrations');
  const findings = auditLiveDbSuite('src/lib/x/__tests__/x.integration.test.ts', source);
  expect(findings.map((finding) => finding.rule)).toEqual(['runtime-ddl']);
});
```

- [ ] **Step 5: Write the three pragma tests**

The third is the fail-OPEN guard: a CODE line carrying a trailing pragma must not blanket the DDL line below it.

```ts
it('exempts a DDL line carrying a trailing live-db-ddl-ignore pragma', () => {
  const source =
    LIVE_DB +
    "await tx`CREATE UNIQUE INDEX i ON job_outbox (topic)`; // live-db-ddl-ignore: temp table\n";
  expect(auditLiveDbSuite('src/lib/x/__tests__/x.integration.test.ts', source)).toEqual([]);
});

it('exempts a DDL line whose immediately preceding comment-only line carries the pragma', () => {
  const source =
    LIVE_DB +
    'await tx`\n' +
    '  -- live-db-ddl-ignore: ON COMMIT DROP temp job_outbox, pg_temp shadows public\n' +
    '  CREATE UNIQUE INDEX i ON job_outbox (topic)\n' +
    '`;\n';
  expect(auditLiveDbSuite('src/lib/x/__tests__/x.integration.test.ts', source)).toEqual([]);
});

it('does not let a code line trailing the pragma exempt the DDL line below it', () => {
  const source =
    LIVE_DB +
    'await tx`SELECT 1`; // live-db-ddl-ignore: unrelated\n' +
    'await tx`ALTER TABLE job_outbox ADD COLUMN y TEXT`;\n';
  const findings = auditLiveDbSuite('src/lib/x/__tests__/x.integration.test.ts', source);
  expect(findings.map((finding) => finding.rule)).toEqual(['runtime-ddl']);
});
```

- [ ] **Step 6: Write the two DDL-probe allowlist tests**

```ts
it('flags an allowlisted DDL-probe suite that applies probe DDL without the cross-process lock', () => {
  const findings = auditLiveDbSuite(
    'src/lib/solicitation/__tests__/outreach-render.integration.test.ts',
    LIVE_DB + "await tx.unsafe('CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid AS $$ $$');\n",
  );
  expect(findings.map((finding) => finding.rule)).toEqual(['unlocked-ddl']);
});

it('allows an allowlisted DDL-probe suite that holds the cross-process lock', () => {
  const findings = auditLiveDbSuite(
    'src/lib/solicitation/__tests__/outreach-render.integration.test.ts',
    LIVE_DB +
      "await tx.unsafe('CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid AS $$ $$');\n" +
      'await acquireLiveDbLock(url);\n',
  );
  expect(findings).toEqual([]);
});
```

- [ ] **Step 7: Keep the four existing-behavior guards, retitled to the locked titles**

Rewrite the current tests at lines 23-37 and 55-67 under these exact titles, keeping their existing bodies and the `APPLIES_DDL` fixture:

```ts
it('still flags run-time migration DDL in a suite that is on no allowlist', () => { /* body of the current line-23 test */ });
it('reports naming and runtime-ddl together for the #573 offender shape', () => { /* body of the current line-31 test */ });
it('still accepts 074 on its own dedicated apply lock rather than the shared one', () => { /* body of the current line-55 test */ });
it('still ignores a file that never reaches the live test DB', () => { /* body of the current line-14 test */ });
```

- [ ] **Step 8: Write the repo-wide test as `.fails` for now**

It cannot pass until T1–T4 all land. Marking it `.fails` keeps T0 committable green and makes T5's job unambiguous: flip it to `it(...)`.

```ts
// Precedent for a unit test that reads the repository: src/__tests__/ci-audit-wiring.test.ts
it.fails('every live-DB suite in the repository passes the tightened detector', async () => {
  const { readFile } = await import('node:fs/promises');
  const offenders: string[] = [];
  for (const file of listTestFiles()) {
    const findings = auditLiveDbSuite(file, await readFile(file, 'utf8'));
    offenders.push(...findings.map((finding) => `${finding.file} [${finding.rule}]`));
  }
  expect(offenders).toEqual([]);
});
```

Add `listTestFiles` to the import on line 2.

- [ ] **Step 9: Run and record which fail**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-694-live-db-ddl-detector && pnpm vitest run scripts/ci/__tests__/live-db-suites-audit.test.ts`
Expected: the three reach tests, the fail-closed test, all three pragma tests and both probe tests FAIL; the four precision tests may pass or fail (the current detector's `.unsafe(` conjunction makes some vacuously green); the four guards PASS; the repo-wide test passes as `.fails`.

- [ ] **Step 10: Commit**

```bash
git add scripts/ci/__tests__/live-db-suites-audit.test.ts
git commit -m "test(#694): eval — 18 titles pinning detector reach and precision"
```

---

### Task 1: Detector — AST extraction of executed SQL

**Blocked by:** T0. **Independent of:** T2, T3, T4.

**Files:**
- Modify: `scripts/ci/live-db-suites-audit.ts`

Turns green: the three reach tests, the fail-closed test, the four precision tests, all three pragma tests, both probe tests, and keeps the four guards green.

- [ ] **Step 1: Replace the imports and the two dead markers**

Delete `MIGRATION_DIR_MARKER` (line 97) and `RAW_SQL_MARKER` (line 98). Add to the import block:

```ts
import ts from 'typescript';
import { lineHasPragma } from './lib/sql-tag-scan';
```

- [ ] **Step 2: Add the probe allowlist next to `MIGRATION_SHAPE_SUITES`**

```ts
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
```

- [ ] **Step 3: Add the verb set and the pragma token**

```ts
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
```

- [ ] **Step 4: Add the extractor**

```ts
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
 * accounts for 770 of the 1469 tagged templates in these files and is a
 * CallExpression, so a name list (SQL_TAG_NAMES) would miss the majority — the
 * #592 defect shape. In a file that reaches the live DB, a tagged template IS
 * SQL; all 21 distinct tag forms in the 80 suites are DB handles.
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
```

- [ ] **Step 5: Rewrite the rule body (replaces lines 118-145)**

```ts
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
```

- [ ] **Step 6: Update the R2 paragraph of the module header (lines 26-36)**

State what changed and why the marker died. Keep the deadlock rationale verbatim; append:

```
//      Detection is on EXECUTED SQL, extracted from the AST — every tagged
//      template and every `.unsafe()` call — not on the file mentioning a
//      migration path. The first cut keyed on `supabase/migrations` AND
//      `.unsafe(`, an incidental marker: DDL run without naming that path was
//      invisible, which is how three sites shipped (#694). There is no tag-NAME
//      allowlist: `sql()` alone is 770 of 1469 templates in these files, so a
//      name list would miss the majority (the #592 shape, one layer down).
//
//      Two escapes. A file allowlist for sanctioned DDL — MIGRATION_SHAPE_SUITES
//      (applying the migration IS the subject) and DDL_PROBE_SUITES (session-
//      scoped `auth.uid()` redefinition inside a rolled-back tx); both are
//      enforced to hold the cross-process lock. And a per-line
//      `-- live-db-ddl-ignore: <reason>` pragma for DDL whose safety is invisible
//      statically — a CREATE INDEX on a pg_temp table reads exactly like one on
//      the shared table.
```

- [ ] **Step 7: Run the audit's own tests**

Run: `pnpm vitest run scripts/ci/__tests__/live-db-suites-audit.test.ts`
Expected: 17 PASS, 1 `.fails` still passing-as-failing (the repo-wide test — T2/T3/T4 have not landed).

- [ ] **Step 8: Confirm the detector now sees exactly the expected files**

Run: `pnpm ci:live-db-suites`
Expected: FAIL naming exactly these three, and no others:
```
src/app/api/dashboard/import-offer/__tests__/route.integration.test.ts [runtime-ddl]
worker/background/pollers/__tests__/NotificationFailoverPoller.integration.test.ts [runtime-ddl]
worker/background/pollers/health-alert/__tests__/checks.integration.test.ts [runtime-ddl]
worker/background/schedulers/__tests__/migration-080-outbox-dedup.integration.test.ts [runtime-ddl]
```
If ANY other file appears, that is a precision defect — stop and write it to the deviations file before continuing.

- [ ] **Step 9: Commit**

```bash
git add scripts/ci/live-db-suites-audit.ts
git commit -m "fix(#694): detect run-time DDL by extracting executed SQL from the AST"
```

---

### Task 2: Bootstrap ALTERs → assertSchemaReady

**Blocked by:** T0. **Independent of:** T1, T3, T4.

**Files:**
- Modify: `src/lib/shared/__tests__/helpers/schema-ready.ts`
- Modify: `worker/background/pollers/__tests__/NotificationFailoverPoller.integration.test.ts:169-173`
- Modify: `worker/background/pollers/health-alert/__tests__/checks.integration.test.ts:223-227`

Both suites run `ALTER TABLE job_outbox ADD COLUMN IF NOT EXISTS completion_reason TEXT` as self-healing drift bootstrap. Migration `083_outbox_owner_unreachable.sql` has owned that column since it landed, and `pnpm test:db:setup` applies it — so the statement is a no-op that still takes ACCESS EXCLUSIVE on the most contended relation in the live-DB set.

- [ ] **Step 1: Add the schema requirement**

Insert after `MIGRATION_074_TRUST_DIAL_VETO_WINDOW` (line 193-197), keeping numeric order:

```ts
export const MIGRATION_083_OUTBOX_OWNER_UNREACHABLE: SchemaRequirement = {
  migration: '083_outbox_owner_unreachable',
  columns: ['job_outbox.completion_reason'],
};
```

Note the `columns` shape is `'table.column'` STRINGS, not tuples — see `MIGRATION_088` at line 204.

- [ ] **Step 2: Replace the ALTER in NotificationFailoverPoller**

Delete lines 169-173 (the four-line comment plus the ALTER) and put the requirement in the existing `assertSchemaReady` call if one exists, or add one:

```ts
    await assertSchemaReady(sql as unknown as Sql, [MIGRATION_083_OUTBOX_OWNER_UNREACHABLE]);
```

Add `MIGRATION_083_OUTBOX_OWNER_UNREACHABLE` (and `assertSchemaReady` if absent) to the imports from `@/lib/shared/__tests__/helpers/schema-ready`.

- [ ] **Step 3: Replace the ALTER in health-alert/checks**

Same edit. This file ALREADY calls `assertSchemaReady(db, [MIGRATION_071_RUN_SPINE, MIGRATION_091_SEND_MODE_SPINE_LIFECYCLE])` at lines 218-224 — append the new requirement to that existing array rather than adding a second call:

```ts
    await assertSchemaReady(db, [
      MIGRATION_071_RUN_SPINE,
      MIGRATION_091_SEND_MODE_SPINE_LIFECYCLE,
      MIGRATION_083_OUTBOX_OWNER_UNREACHABLE,
    ]);
```

- [ ] **Step 4: Run both suites against the live DB**

Run: `pnpm vitest run worker/background/pollers/__tests__/NotificationFailoverPoller.integration.test.ts worker/background/pollers/health-alert/__tests__/checks.integration.test.ts`
Expected: PASS. A behind-head DB now fails loudly in `assertSchemaReady` naming `083_outbox_owner_unreachable` instead of silently self-healing — that is the point.

- [ ] **Step 5: Commit**

```bash
git add src/lib/shared/__tests__/helpers/schema-ready.ts worker/background/pollers/__tests__/NotificationFailoverPoller.integration.test.ts worker/background/pollers/health-alert/__tests__/checks.integration.test.ts
git commit -m "fix(#694): assert migration 083 instead of bootstrapping it with ALTER TABLE"
```

---

### Task 3: Extract the non-DDL abort injection, use it from both callers

**Blocked by:** T0. **Independent of:** T1, T2, T4.

**Files:**
- Create: `src/lib/shared/__tests__/helpers/abort-injection.ts`
- Modify: `src/lib/reviews/__tests__/import-offer-analytics.integration.test.ts:196-266`
- Modify: `src/app/api/dashboard/import-offer/__tests__/route.integration.test.ts:150-180`

**New-file justification:** the alternatives are `helpers/schema-ready.ts` (owns the assert-never-apply contract) and `live-db-tenant.ts` (owns tenant seeding). Transaction-abort injection is a third concern; adding it to either widens a focused module's interface for an unrelated reason. `src/lib/shared/__tests__/helpers/` already holds one concern per file (`live-db-lock`, `describe-with-db`, `schema-ready`), so a fourth file follows the established pattern rather than inventing one.

- [ ] **Step 1: Create the helper with the mechanism only**

The Proxy-over-`begin` mechanism is what both callers share; the poisoning statement is caller-owned, because a deterministic SQLSTATE depends on which constraints the caller's fixture satisfies. Port the docblock from `import-offer-analytics.integration.test.ts:201-234` — it carries the reasoning that must not be lost.

```ts
// Non-DDL transaction-abort injection for live-DB suites.
//
// Forcing a writer's transaction to abort used to be done by adding a temporary
// CHECK constraint and dropping it in a `finally`. A vitest TIMEOUT skips the
// `finally`, so the constraint strands on the shared container — one such
// stranded `tmp_block_import_topic_analytics` blocked every sibling suite that
// enqueues `zernio_initial_backfill` and produced 14 spurious failures across
// three suites (#679 deviations D20, ticket #694). It also took ACCESS EXCLUSIVE
// on the most contended relation in the live-DB set, against suites in other
// vitest processes that nothing serializes it against.
//
// This injection holds no schema, takes no ACCESS EXCLUSIVE lock, and leaves
// nothing behind whether its test passes, fails, or times out.
//
// THE FAILURE MUST ORIGINATE IN POSTGRES, not in JS. A plain JS throw does not
// poison a Postgres transaction, so a test built on one proves nothing about a
// transaction that is actually in aborted state — the state the real hazard
// produces. Callers supply a `poison` that raises a REAL Postgres error.
//
// Test-helper only — never imported by production code.
import type postgresType from 'postgres';

/**
 * Wraps `base` so that `.begin(cb)` runs `cb` to completion and THEN runs
 * `poison` on the same transaction, aborting it after the writer's work.
 *
 * A `Proxy` over a REAL `Sql`, never a `{ begin } as unknown as Sql` cast: a
 * bare object cast would typecheck the caller against a local restatement of
 * the interface instead of the shipped one (#679 deviations D22). A `get`-only
 * trap does not intercept `apply`, so the tagged-template call form forwards
 * untouched.
 */
export function abortingExecutor(
  base: postgresType.Sql,
  poison: (tx: postgresType.TransactionSql) => Promise<unknown>,
): postgresType.Sql {
  return new Proxy(base, {
    get(target, prop) {
      if (prop !== 'begin') {
        const value: unknown = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (...args: unknown[]) => {
        const callback = args[args.length - 1] as (
          tx: postgresType.TransactionSql,
        ) => Promise<unknown>;
        return target.begin(async (tx) => {
          const result = await callback(tx);
          await poison(tx);
          return result;
        });
      };
    },
  });
}
```

- [ ] **Step 2: Migrate the analytics suite to the helper (caller 1)**

Delete the local `abortingExecutor` (lines 235-266) and import the shared one. Keep `FOREIGN_KEY_VIOLATION` and the INSERT in the suite as its `poison` — the event name and the FK it violates are that suite's fixture, not shared vocabulary:

```ts
import { abortingExecutor } from '@/lib/shared/__tests__/helpers/abort-injection';

/** `analytics_events_business_id_fkey`. Asserted, so a lock timeout cannot pass for it. */
const FOREIGN_KEY_VIOLATION = '23503';

const foreignKeyPoison = async (tx: postgresType.TransactionSql): Promise<void> => {
  // The event name is one migration 102 registered (asserted in beforeAll), so
  // the ONLY constraint this row violates is the foreign key — the SQLSTATE is
  // deterministic. `account_id` is left NULL, so the row could not satisfy
  // `readAnalytics`'s account predicate even if it somehow survived.
  await tx`
    INSERT INTO analytics_events (id, event_key, event_name, distinct_id, business_id)
    VALUES (
      ${randomUUID()}::uuid, ${`forced-abort-${randomUUID()}`},
      'import_decision_recorded', 'forced-abort', ${randomUUID()}::uuid
    )
  `;
};
```

Update its call site to `abortingExecutor(sql(), foreignKeyPoison)`.

- [ ] **Step 3: Replace the DDL injection in the route suite (caller 2)**

Delete the `ALTER TABLE … ADD CONSTRAINT tmp_block_import_topic` / `finally … DROP CONSTRAINT` pair (lines 160-170) and drive the same test through `abortingExecutor`. The test title and all three assertions stay byte-identical — this changes HOW the abort is forced, never what is proven.

**Requirement on the poison choice:** its SQLSTATE must be deterministic WITHOUT adding a migration-102 precondition to this suite (102 is unrelated to its subject). Read `supabase/migrations/102_import_consent_analytics_events.sql` and pick an `event_name` the CHECK admitted BEFORE 102, so the foreign key is the only constraint violated on any DB at or past migration 100. Record the chosen name and why in a comment. If no such name exists, write the finding to the deviations file and use a poison targeting a different table with an unconditional FK.

- [ ] **Step 4: Write the helper's own test**

Add to the route suite (it already has a live DB and the writer under test):

```ts
it('the shared abort injection raises a real Postgres error without executing any DDL', async () => {
  await setOffer("now() + interval '3 days'");
  let raised: unknown;
  try {
    await recordImportDecisionAndEnqueue(
      abortingExecutor(sql(), foreignKeyPoison), businessId, tenant!.accountId, 'accepted',
    );
  } catch (error) {
    raised = error;
  }
  // Originates in Postgres — a JS throw would not poison the transaction.
  expect((raised as { code?: string }).code).toBe(FOREIGN_KEY_VIOLATION);
  // Non-DDL by construction: the injection is the only thing this suite runs
  // that could strand an object, and it holds no schema.
  expect(String(foreignKeyPoison)).not.toMatch(/\b(?:ALTER|CREATE|DROP)\s+\w/i);
});
```

- [ ] **Step 5: Run both suites**

Run: `pnpm vitest run src/lib/reviews/__tests__/import-offer-analytics.integration.test.ts src/app/api/dashboard/import-offer/__tests__/route.integration.test.ts`
Expected: PASS, including the pre-existing `live DB: accept rolls back the import consent write when the job_outbox INSERT fails`.

- [ ] **Step 6: Prove nothing stranded**

Run: `psql "$TEST_DATABASE_POOL_URL" -c "\d job_outbox" | rg -i 'tmp_block' || echo CLEAN`
Expected: `CLEAN`.

- [ ] **Step 7: Commit**

```bash
git add src/lib/shared/__tests__/helpers/abort-injection.ts src/lib/reviews/__tests__/import-offer-analytics.integration.test.ts src/app/api/dashboard/import-offer/__tests__/route.integration.test.ts
git commit -m "fix(#694): extract the non-DDL abort injection, drop the last temp-constraint DDL"
```

---

### Task 4: Pragmas for the three temp-table DDL sites

**Blocked by:** T0. **Independent of:** T1, T2, T3.

**Files:**
- Modify: `worker/background/schedulers/__tests__/migration-080-outbox-dedup.integration.test.ts:80,180,188`

All three target the session-local `CREATE TEMP TABLE job_outbox (LIKE public.job_outbox …) ON COMMIT DROP` — pg_temp shadows `public` in the search_path, so the unqualified `job_outbox` in the migration-copy SQL resolves to the temp copy. `CREATE UNIQUE INDEX … ON job_outbox(...)` is textually identical to shared-table DDL; only this surrounding context makes it safe, which is precisely why it takes a pragma rather than a structural carve-out.

- [ ] **Step 1: Pragma the temp-table creation (line 80)**

```ts
  // live-db-ddl-ignore: pg_temp, ON COMMIT DROP — locks no shared relation
  await tx`CREATE TEMP TABLE job_outbox (LIKE public.job_outbox INCLUDING DEFAULTS) ON COMMIT DROP`;
```

- [ ] **Step 2: Pragma both index builds (lines 180, 188)**

Inside the template, so the reason sits with the SQL:

```ts
  await tx`
    -- live-db-ddl-ignore: builds on the pg_temp job_outbox above, not public
    CREATE UNIQUE INDEX uniq_outbox_weekly_summary_week
      ON job_outbox(aggregate_id, (payload->>'week_start_date'))
      WHERE topic = 'weekly_summary' AND status IN ('pending','dispatching','dispatched')
  `;
```

Same for `uniq_outbox_monthly_impact_month` at line 188.

- [ ] **Step 3: Verify the suite still passes**

Run: `pnpm vitest run worker/background/schedulers/__tests__/migration-080-outbox-dedup.integration.test.ts`
Expected: PASS. A SQL `--` comment inside the template is inert.

- [ ] **Step 4: Commit**

```bash
git add worker/background/schedulers/__tests__/migration-080-outbox-dedup.integration.test.ts
git commit -m "test(#694): pragma the three pg_temp DDL sites in the 080 preflight"
```

---

### Task 5: Repo-wide green

**Blocked by:** T1, T2, T3, T4.

**Files:**
- Modify: `scripts/ci/__tests__/live-db-suites-audit.test.ts` (the `.fails` marker only)

- [ ] **Step 1: Run the audit across the repo**

Run: `pnpm ci:live-db-suites`
Expected: `live-db-suites-audit: passed`. If any file is named, do NOT pragma it reflexively — decide fix vs exempt against the four-class taxonomy and record the reasoning in the deviations file.

- [ ] **Step 2: Flip the repo-wide test on**

Change `it.fails('every live-DB suite in the repository passes the tightened detector', …)` to `it(…)`.

- [ ] **Step 3: Run the audit's tests**

Run: `pnpm vitest run scripts/ci/__tests__/live-db-suites-audit.test.ts`
Expected: 18 PASS, 0 skipped, 0 failed.

- [ ] **Step 4: Run the full gate**

Run: `bash scripts/verify-gate.sh`
Expected: every row PASS. `db_touching` is true, so the gate provisions the test DB serially first and runs the changed integration suites.

- [ ] **Step 5: Commit**

```bash
git add scripts/ci/__tests__/live-db-suites-audit.test.ts
git commit -m "test(#694): repo-wide detector cleanliness is now asserted, not aspirational"
```

---

### Task 6: Documentation sweep

**Blocked by:** T5.

**Files:**
- Modify: `.claude/reference/lab-notes.md`
- Modify: `.claude/CLAUDE.md`

- [ ] **Step 1: Extend the lab-notes "#573" entry**

Append, in the house `- [DATE] WHAT FAILED → WHY → CORRECT APPROACH` format:

```
- [2026-08-08] `ci:live-db-suites` R2 passed suites that ran DDL → the detector
  keyed on `text.includes('supabase/migrations') && text.includes('.unsafe(')`,
  an incidental marker rather than DDL, so any suite doing run-time DDL without
  naming a migration path was invisible; three shipped that way, and one
  stranded a `tmp_block_import_topic_analytics` CHECK that caused 14 spurious
  failures across three suites → detection is now AST extraction of EXECUTED SQL
  (every tagged template + every `.unsafe()` call) with a DDL-verb match over
  the extracted text only. NO tag-name allowlist: `sql()` is 770 of 1469
  templates in live-DB suites and is a CallExpression, so `SQL_TAG_NAMES` would
  miss the majority (the #592 shape one layer down). Escapes: file allowlists
  MIGRATION_SHAPE_SUITES / DDL_PROBE_SUITES (both lock-enforced) and a per-line
  `-- live-db-ddl-ignore: <reason>` pragma for DDL whose safety is statically
  invisible — a CREATE INDEX on a pg_temp table reads exactly like one on the
  shared table. Forcing a transaction abort: use
  `helpers/abort-injection.ts`, never a temporary constraint — a vitest timeout
  skips the `finally` that would drop it.
```

- [ ] **Step 2: Update the CLAUDE.md gotcha**

The bullet beginning "**A live-DB suite must be named `*.integration.test.ts` and must NOT apply migration SQL.**" — change "apply migration SQL" to "execute DDL" (the rule is no longer migration-specific), and add one clause naming the pragma and `abort-injection.ts` as the sanctioned alternative to a temporary constraint. Keep it to the existing bullet's length; do not add a new bullet.

- [ ] **Step 3: Run the docs-only gate**

Run: `bash scripts/verify-gate.sh`
Expected: green (`"mode":"docs_only"` if this commit is docs-only).

- [ ] **Step 4: Commit**

```bash
git add .claude/reference/lab-notes.md .claude/CLAUDE.md
git commit -m "docs(#694): record the executed-SQL detector and the abort-injection rule"
```

---

## Self-review

**Spec coverage.** Ticket scope line 1 (replace marker heuristic with real DDL detection, excluding migration-shape suites) → T1. Line 2 (fix or exempt the two pre-existing sites) → T2 (`NotificationFailoverPoller`) and T3 (`route.integration.test.ts`); the investigation added `health-alert/checks` (T2), `outreach-render` + `migration-091` (T1 allowlist), and `migration-080` (T4). Line 3 (keep the migration-shape carve-out with its lock requirement) → T1 Step 5 preserves `MIGRATION_SHAPE_SUITES`, `OWN_APPLY_LOCK` and both lock markers unchanged, and T0 Step 7 keeps the 074 guard.

**Placeholder scan.** No TBD/TODO/"similar to Task N". Every code step carries the code. The one judgement call deliberately left open — T3 Step 3's poison choice — states its acceptance criterion (deterministic SQLSTATE without a migration-102 precondition), the file to read, and the fallback, so it is verifiable rather than vague.

**Type consistency.** `auditLiveDbSuite(file: string, text: string): LiveDbSuiteFinding[]` and the `{file, rule, reason}` finding shape are unchanged throughout — `line` is folded into `reason`, not added to the interface. `abortingExecutor(base, poison)` has the same arity at all three references (helper, caller 1, caller 2). `ExecutedSql.start/text/line` is used exactly as defined by `unpragmaedDdlLines`. `MIGRATION_083_OUTBOX_OWNER_UNREACHABLE` uses `columns: readonly string[]` in `'table.column'` form, matching `MIGRATION_088`, not the tuple form.
