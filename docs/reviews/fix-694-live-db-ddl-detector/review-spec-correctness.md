# Spec & correctness review — `fix-694-live-db-ddl-detector` (round 1)

Axis: spec faithfulness / correctness. Read-only on source.
Fork point `13212b5588b96de2a5c8fcd0430cc95d70271e50`, 10 commits, 13 files.
Contract of record: `.feature/intake.json` (checked field by field, not from memory).

---

## 0. Verification actually run (evidence, not assertion)

| Command | Result |
|---|---|
| `npx tsx scripts/ci/live-db-suites-audit.ts` | `live-db-suites-audit: passed` |
| `npx vitest run scripts/ci/__tests__/live-db-suites-audit.test.ts` | 32/32 pass |
| `npx tsc --noEmit -p tsconfig.json` | clean |
| `npx eslint` on the 4 largest changed files | clean |
| `route.integration.test.ts` (live DB, verbose) | 7/7 pass — confirmed **real** live-DB run, not a `describeWithDb` skip |
| `import-offer-analytics.integration.test.ts` | 11/11 pass |
| `NotificationFailoverPoller.integration.test.ts` | 9/9 pass |
| `health-alert/checks.integration.test.ts` | 11/11 pass |
| `migration-080-outbox-dedup.integration.test.ts` | 8/8 pass |
| `psql … SELECT conname FROM pg_constraint WHERE conname LIKE 'tmp_%'` | 0 rows — no stranded constraint after the five suites |
| `psql … analytics_events WHERE distinct_id='forced-abort'` | 0 rows — the poison strands nothing |

---

## 1. Per-field intake check

### `goal`
> Replace `ci:live-db-suites`' R2 marker heuristic with AST extraction of EXECUTED SQL … and bring all seven real DDL sites into compliance.

**Delivered.** `MIGRATION_DIR_MARKER` and `RAW_SQL_MARKER` are gone
(`scripts/ci/live-db-suites-audit.ts`, formerly lines 97-98). Detection is now
`extractExecutedSql` (`:165-195`) → `DDL_VERB` match over extracted text only
(`:201-215`). Seven sites: 3 fixed (`NotificationFailoverPoller`,
`health-alert/checks`, `import-offer/route`), 3 exempted (`migration-080` ×3
pragma lines, `outreach-render` + `migration-091` via `DDL_PROBE_SUITES`), 1
already correct (`import-offer-analytics`, whose injection was made non-DDL on
the #679 branch and is here extracted to a helper).

### `user_visible_behavior` (7 entries)

| # | Behavior | Verdict |
|---|---|---|
| 1 | runtime-ddl for DDL through **any** tagged template or `.unsafe()`, regardless of `supabase/migrations` | **Mostly.** Every tagged-template *form* is caught (incl. `sql()`, `db!`, parenthesised conditional receivers). `.unsafe()` is matched only through a **PropertyAccessExpression** receiver — a destructured `const { unsafe } = sql`, an alias, or `sql['unsafe']` is invisible (F5). No such shape exists in the repo today. |
| 2 | no longer depends on `'supabase/migrations'` or `'.unsafe('` strings | **Delivered**, verified by the fixtures' own `expect(source).not.toContain(…)` guards at test lines 89-90 and 149. |
| 3 | NO finding for a DDL verb only in a regex literal / string assertion / **comment** / non-executed constant | **Partially.** Regex, `toContain`, TS `//` comment and non-executed constant all clean. A **SQL `--` or `/* */` comment INSIDE an executed template** is flagged (F2). |
| 4 | runtime-ddl for a `.unsafe()` argument that is **not a statically readable string** (fail-closed) | **Partially.** Identifier / call / ternary / `as`-cast / concatenation args all fail closed. A **`TemplateExpression` with substitutions** is classified `readable`, so `sql.unsafe(\`${ddl}\`)` passes clean (F1). |
| 5 | trailing or preceding-comment-only `-- live-db-ddl-ignore:` pragma exempts the line | **Delivered**, and the one-line blast radius verified empirically (§3, A18/A20). |
| 6 | unlocked-ddl for an allowlisted DDL-probe suite that stops calling `acquireLiveDbLock` | **Delivered** (`:245-269`), and both probe files really do hold it (`outreach-render:177`, `migration-091:298`). |
| 7 | passes clean on the repo at HEAD | **Delivered** — audit run above. |

### `invariants` (8 entries)

| Invariant | Verdict |
|---|---|
| R2 holds: no live-DB suite takes ACCESS EXCLUSIVE on a SHARED relation at run time | **Holds** for what the detector can see; the two escapes below are the residual reach gaps. |
| Every allowlist-exempted file must hold a cross-process lock | **Enforced** for both `MIGRATION_SHAPE_SUITES` and the new `DDL_PROBE_SUITES` (`:258-260`); `OWN_APPLY_LOCK` still carves out 074 only. Verified both probe files hold `acquireLiveDbLock`. |
| **Fail-closed: unresolvable SQL treated as DDL, never as safe** | **VIOLATED** for one arg shape — see F1. `.unsafe(\`${x}\`)` → `[]`. |
| Pragma exempts exactly one line; a code line's trailing pragma never blankets the line below | **Holds.** Reproduced: pragma inside a multi-line template exempts only the following line (A18); the second DDL line inside the same template is still flagged (A20); test at `:176` pins the code-line case. |
| Blast radius stays honest: any file reaching the DB via `LIVE_DB_MARKERS` is scanned; no tag-name allowlist narrows which statements are examined | **Holds** — no tag-name filter anywhere in `extractExecutedSql`. (Note: `LIVE_DB_MARKERS` itself is unchanged and out of scope per `non_goals`.) |
| **`scripts/ci/lib/sql-tag-scan.ts` behavior byte-identical** | **Holds.** `git diff main...HEAD -- scripts/ci/lib/sql-tag-scan.ts` → empty; `git diff --stat -- scripts/ci/lib/` → empty. `lineHasPragma` is imported, nothing else. `SQL_TAG_NAMES` untouched. |
| A forced abort raises in Postgres, not JS | **Holds.** `foreignKeyPoison` is an FK-violating INSERT; the new pinning test asserts `code === '23503'`. Verified live. |
| The abort injection holds no schema, takes no ACCESS EXCLUSIVE lock, strands nothing | **Holds.** `abort-injection.ts` contains no DDL; container was clean after the runs (§0). |

### `edge_cases` (14 entries) — checked against the real tree

| Edge case | Handled | Pinned by a test |
|---|---|---|
| `sql()` call-form tag (770/1201) | yes — no tag-name allowlist | yes (`:95`) |
| `db!` NonNullExpression + 21 forms | yes — `isTaggedTemplateExpression` is form-agnostic | yes for `db!` (`:103`); the other 19 forms only by the repo-wide scan |
| DDL verb in regex literal (093/095/096/100/102) | yes | yes (`:117`) |
| DDL verb in `expect().toContain()` (091/093/096) | yes | yes (`:125`) |
| DDL verb in prose comment (079/082) | yes for TS `//` comments; **no** for SQL comments inside an executed template | yes (`:131`) — but the fixture is a TS comment only |
| DDL verb in non-executed constant (076:115-142) | yes | yes (`:137`) |
| `.unsafe()` non-literal arg, 13 sites, all in 074/076/077/078/088 | yes, fail-closed; verified those 13 are all inside allowlisted files (audit green) | yes (`:147`) |
| `CREATE UNIQUE INDEX` on TEMP table (080:180,188) | pragma at `:180`/`:189` | indirectly by the repo-wide scan |
| `CREATE TEMP TABLE` (080:80) | pragma at `:80` | same |
| `CREATE OR REPLACE FUNCTION auth.uid()` (outreach-render:355, 091:1207) | `DDL_PROBE_SUITES` + lock enforced | yes (`:191`, `:199`) |
| migration-091 was on no allowlist → lock never checked | now in `DDL_PROBE_SUITES`; holds the lock at `:298` | yes |
| vitest TIMEOUT skips `finally` → stranded CHECK | removed; replaced by `abortingExecutor` | yes (`route…:236`) |
| Both bootstrap ALTERs no-op but still ACCESS EXCLUSIVE on `job_outbox` | replaced by `assertSchemaReady([MIGRATION_083_…])` in both suites | yes, both suites run green live |
| Audit's own test file must stay in `NOT_LIVE_DB` | yes (`:69`) | yes (`:81` covers the sibling entry) |

### `tests_to_add` (19 titles) — all present VERBATIM

Programmatic check across the three test files: **19/19 OK, 0 MISS.**

Non-vacuity (deviation D1 flagged several as vacuous *before* the detector
landed — re-checked NOW):

- The 4 precision fixtures still contain **no tagged template and no
  `.unsafe(`**, so `extractExecutedSql` returns `[]` for them. They are
  non-vacuous *against the regression they target* (a text-grep detector fails
  all four) but they do **not** exercise the AST walk. Acceptable: that is
  exactly the property they name.
- The 2 pragma "exempts" tests are now **non-vacuous** — both fixtures carry a
  real tagged-template DDL statement; deleting the `lineHasPragma` filter turns
  both red (confirmed by the sibling fail-open test at `:176`, which flags the
  same shape without a pragma).
- "allows an allowlisted DDL-probe suite that holds the cross-process lock" is
  now **non-vacuous** — the identical fixture minus the lock line yields
  `['unlocked-ddl']` (`:191`).
- "the shared abort injection raises a real Postgres error…" is
  **non-vacuous**: if nothing threw, `(undefined as {code?:string}).code`
  TypeErrors and the test fails.
- "still ignores a file that never reaches the live test DB" — the fixture is
  `'const a = 1;'`, which carries no DDL. It pins the marker gate for the
  *naming* rule (removing the gate flags `x.test.ts` as `naming`) but not for
  the DDL rule. Minor; noted in the appendix.
- "every live-DB suite in the repository passes the tightened detector" —
  `it.fails` was correctly dropped in commit `91873792`. It passes. Its stated
  rationale is inverted, though — see F4.

### `non_goals` — all respected
`sql-tag-scan.ts` / `SQL_TAG_NAMES` untouched; R1 and `LIVE_DB_MARKERS`
untouched; no migration file added/edited/renumbered (083 only asserted); no
CONTEXT.md section; no production source under `src/lib/**`, `src/app/**/route.ts`
or non-test `worker/**` touched (blast-radius.md correctly reports "No changed
production source files"); the #679 `import-consent.integration.test.ts` site is
untouched.

### `allowed_edit_surface` — no drift
All 13 changed paths are inside the declared surface. Two declared-but-untouched
files: `.claude/reference/lab-notes.md` and `.claude/CLAUDE.md` (F3).
`dependencies_added: []` holds — `typescript` was already a devDependency.

### `rollback_plan` / `observability`
Rollback claim is accurate (no schema change, 083 pre-exists, revert restores
detector + test bodies together). `observability` entry 2 is factually wrong —
see F4.

---

## 2. Blast radius — callers checked against changed semantics

`blast-radius.md` reports no changed production source. Semantic (not
signature) checks on the four changed exported surfaces:

- **`auditLiveDbSuite(file, text)`** — signature and `{file, rule, reason}`
  shape unchanged; `line` folded into `reason`, not into the interface. Two
  callers: `main()` in the same file (prints `reason` verbatim — fine) and the
  audit's own test (asserts on `.rule` only, so the reason-string rewording is
  safe). No caller parses `reason`.
- **`listTestFiles()`** — unchanged. Now also called from the test file's
  repo-wide case; `git ls-files` works in a worktree, and `readFile` is relative
  to the vitest root. Verified green.
- **`schema-ready.ts`** — pure addition of `MIGRATION_083_OUTBOX_OWNER_UNREACHABLE`.
  No existing export touched; `columns: ['job_outbox.completion_reason']` matches
  the `'table.column'` form the helper parses. Both new consumers run green live,
  proving the requirement resolves against the provisioned DB.
- **`abort-injection.ts` (new)** — two importers, both migrated in the same
  change. The `abortingExecutor(base)` → `abortingExecutor(base, poison)` arity
  change is caught by typecheck; behavior is identical to the inlined #679
  version (poison moved out, `get`-only trap and `apply`-passthrough preserved).
  The analytics suite still asserts `code: '23503'` and passes.
- The `route.integration.test.ts` poison uses `event_name: 'gbp_connected'`.
  Verified: `analytics_events.account_id` is **nullable** (migration 046:27), so
  no `23502` fires before the FK; `gbp_connected` is present in migration 046's
  original CHECK and in both 097 and 102's replacements. SQLSTATE is
  deterministic as claimed.

---

## 3. Adversarial cases run against the real detector

All run via `auditLiveDbSuite('src/lib/x/__tests__/x.integration.test.ts', LIVE_DB + fixture)`.

### Reach — false negatives (detector says clean)

| Fixture | Output | Assessment |
|---|---|---|
| `const { unsafe } = sql; await unsafe('DROP TABLE job_outbox')` | `[]` | hole (F5) — receiver must be a PropertyAccess |
| `const u = sql.unsafe.bind(sql); await u('DROP TABLE job_outbox')` | `[]` | same hole |
| `await sql['unsafe']('DROP TABLE job_outbox')` | `[]` | same hole (ElementAccess) |
| **`await sql.unsafe(\`${ddl}\`)`** | **`[]`** | **F1 — violates the fail-closed invariant** |
| **`await sql.unsafe(\`SET lock_timeout = 0; ${ddl}\`)`** | **`[]`** | **F1** |
| `await sql\`${sqlFragment}\`` | `[]` | same class as F1 (fragment source is elsewhere, usually itself a flagged template) |
| `await sql\`CREATE SEQUENCE s\`` | `[]` | verb-set gap; not present in repo |
| `await sql\`REFRESH MATERIALIZED VIEW mv\`` | `[]` | verb-set gap (takes ACCESS EXCLUSIVE); not present in repo |
| `execFileSync('psql', ['-c','DROP TABLE job_outbox'])` | `[]` | out of scope (not a SQL route the audit models) |
| `await runSql('CREATE INDEX …')` | `[]` | out of scope |

### Reach — correctly caught

`await (cond ? sqlA : sqlB)\`DROP TABLE x\`` → runtime-ddl ·
`sql.unsafe('DROP ' + 'TABLE x')` → runtime-ddl ·
`sql.unsafe(\`DROP TABLE ${name}\`)` → runtime-ddl ·
`sql.unsafe(ddl as string)` → runtime-ddl ·
`sql.unsafe(cond ? 'DROP TABLE x' : 'SELECT 1')` → runtime-ddl ·
`sql.unsafe?.('DROP TABLE x')` → runtime-ddl ·
`sql.unsafe()` (0-arg) → runtime-ddl ·
`sql\`alter table … add column …\`` (lowercase) → runtime-ddl ·
`sql\`TRUNCATE TABLE job_outbox\`` → runtime-ddl.

### Precision — false positives

| Fixture | Output | Assessment |
|---|---|---|
| **`sql\`\n  -- 083 added completion_reason via ALTER TABLE\n  SELECT completion_reason FROM job_outbox\n\``** | **`runtime-ddl`, line 3** | **F2** — contradicts `user_visible_behavior[2]` |
| **`sql\`\n  /* asserts the CREATE INDEX from 079 exists */\n  SELECT 1\n\``** | **`runtime-ddl`, line 3** | **F2** |
| `sql\`SELECT 1 WHERE $1 = 'ALTER TABLE x'\`` | `runtime-ddl` | fail-closed; a string literal inside real SQL is indistinguishable without a parser — acceptable |
| `const frag = sql\`ALTER TABLE … \`; void frag;` | `runtime-ddl` | acceptable — a postgres.js fragment is executable by construction |
| `dedent\`ALTER TABLE foo ADD COLUMN x\`` | `runtime-ddl` | acceptable bound, documented in the header ("all 21 tag forms are DB handles") |
| `sql\`SELECT 'created table' AS x\`` | `[]` | word boundaries hold |

### Pragma blast radius

| Fixture | Output | Assessment |
|---|---|---|
| pragma comment line inside a template, followed by a **second** template's DDL | second still flagged (line 6) | one-line radius holds |
| pragma comment line inside a template, **two** DDL lines in the same template | second still flagged (line 5) | holds |
| `// live-db-ddl-ignore: reviewed` on its own line above a DDL statement | `[]` | documented behavior |
| `await sql\`DROP TABLE a\`; await sql\`DROP TABLE b\`; // live-db-ddl-ignore: one reviewed` | `[]` | letter of the invariant respected (one *line*), but one pragma covers two statements. Appendix. |

Every pragma placement actually used on this branch is
`migration-080-outbox-dedup.integration.test.ts:80` (`//` line above a
single-line template), `:180` and `:189` (`--` line inside a multi-line
template, immediately above the `CREATE UNIQUE INDEX`). All three exempt exactly
their one intended line — no over-reach.

---

## 4. Findings (≥80% confidence)

| # | Severity | file:line | Finding |
|---|---|---|---|
| F1 | Medium | `scripts/ci/live-db-suites-audit.ts:179-183` | `ts.isTemplateExpression(arg)` counts as "statically readable", so a `.unsafe()` argument whose SQL arrives through a substitution passes clean. `await sql.unsafe(\`${ddl}\`)` → `[]` (verified). Violates `invariants[2]` "unresolvable SQL … treated as DDL, never as safe" and `user_visible_behavior[3]`. Failure scenario: refactoring the #694 stranded-constraint site into `const ddl = \`ALTER TABLE job_outbox ADD CONSTRAINT tmp_… \`; await sql.unsafe(\`${ddl}\`)` reproduces the original defect with a green gate. Fix: treat a `TemplateExpression` with ≥1 span as unreadable, or scan its literal chunks AND fail closed on the spans. No test pins this. |
| F2 | Medium | `scripts/ci/live-db-suites-audit.ts:172-176`, `:208` | `node.template.getText(source)` is matched raw, so a DDL verb inside a **SQL comment within an executed template** is flagged. `sql\`\n -- 083 added completion_reason via ALTER TABLE\n SELECT … \`` → `runtime-ddl` (verified; same for `/* */`). Contradicts `user_visible_behavior[2]` "reports NO finding for a DDL verb that appears only in … a comment" — the promised test (`:131`) covers only a TS `//` comment *outside* any template. Failure scenario: CI goes red on a suite that executes no DDL, and the reason string misdirects the author to `assertSchemaReady`. Fails closed, so it cannot hide a real violation. |
| F3 | Medium | `.claude/CLAUDE.md:192`; `.claude/reference/lab-notes.md:22`, `:1609` | Plan **Task 6 (Documentation sweep)** is unexecuted — both files are in `allowed_edit_surface`, the plan spells out the exact edits at `docs/superpowers/plans/2026-08-08-live-db-ddl-detector.md:772-816`, and no deviation records skipping it. The CLAUDE.md gotcha is now factually stale: it still says "must NOT **apply migration SQL**" (the rule is now "execute DDL"), and "Migration-**shape** suites are the sanctioned exception" (there are now two allowlists plus a per-line pragma). `non_goals[3]` explicitly names "the CLAUDE.md gotcha, and lab-notes" as this vocabulary's home. |
| F4 | Low | `scripts/ci/__tests__/live-db-suites-audit.test.ts:249-255` (and `.feature/intake.json` `observability[1]`) | The repo-wide test's stated rationale is inverted. It asserts the tree is clean, so a **reach** regression (detector stops seeing DDL the tree has) leaves it green — exactly the #694 failure mode it claims to catch. What it actually guards is precision plus new-offender hygiene. The comment ("only a scan of the real tree catches a change that narrows what the detector can SEE") will mislead a future maintainer into under-investing in the fixture reach tests, which are the real reach guard. |
| F5 | Low | `scripts/ci/live-db-suites-audit.ts:150-156` | `isUnsafeCall` requires a `PropertyAccessExpression` receiver, so `const { unsafe } = sql`, `const u = sql.unsafe.bind(sql)` and `sql['unsafe'](…)` are all invisible (verified `[]` for each with a `DROP TABLE`). Zero occurrences today, and the header's claim "every `.unsafe()` call" overstates it. Unlike `SQL_TAG_NAMES` — which `static-policy`'s `sql-executor-tag-name` rule keeps honest from the other side — nothing detects a new receiver form being introduced. Either widen to any callee named `unsafe` (incl. element access and bare identifier) or state the bound in the header. |

---

## 5. Low-confidence appendix (not findings)

- **`DDL_VERB` verb-set gaps.** `CREATE/ALTER/DROP SEQUENCE`, `REFRESH
  MATERIALIZED VIEW`, `REINDEX`, `CLUSTER`, `VACUUM FULL`, `CREATE/DROP ROLE`,
  `COMMENT ON`, `CREATE DOMAIN/RULE/AGGREGATE`, `ALTER DEFAULT PRIVILEGES` are
  absent. `REFRESH MATERIALIZED VIEW` and `REINDEX` do take ACCESS EXCLUSIVE.
  None occurs in an executed statement in any test file today (greped), so this
  changes no finding. `TRUNCATE` — the one that would realistically appear in
  cleanup code — *is* covered.
- **DCL exclusion.** Deliberate and documented at `:127-130`. Verified the claim:
  the only executed `GRANT`s are `outreach-render:359-360` and
  `migration-091:1211-1212`, both in `DDL_PROBE_SUITES`, both holding the lock;
  `migration-076:137`'s `REVOKE` is a non-executed constant. Accurate today,
  silently rots if someone adds a `GRANT` to a non-allowlisted suite.
- **One pragma can cover two statements on one line** (`sql\`DROP TABLE a\`;
  sql\`DROP TABLE b\`; // live-db-ddl-ignore: …` → `[]`). Within the letter of
  `invariants[3]` (line-scoped, matching `outbox-seam-ignore`), and lint/prettier
  make that formatting unlikely.
- **The pragma matches anywhere on the line**, including inside an executed SQL
  string — `sql.unsafe('ALTER TABLE x /* live-db-ddl-ignore */ …')` self-exempts.
  Inherited from `lineHasPragma`, which `non_goals` forbids changing.
- **Non-SQL tagged templates in a live-DB suite are treated as SQL.** Documented
  bound; `dedent`/`gql`/`String.raw` with a DDL word would false-positive. No
  test or audit keeps the "21 forms are all DB handles" claim honest as the tree
  evolves; the escape is the pragma.
- **`[...lines]` copies the whole file's line array per DDL hit**
  (`:214`). Irrelevant at this scale.
- **"still ignores a file that never reaches the live test DB"** uses
  `'const a = 1;'`, which contains no DDL — so it pins the `LIVE_DB_MARKERS`
  gate for the naming rule only, not for the DDL rule. Adding a DDL statement to
  that fixture would make it prove both.
- **`docs/directory.md`** does not list the `__tests__/helpers/` files
  individually, so the new `abort-injection.ts` creates no map drift; it is also
  outside `allowed_edit_surface`.
- **`findMissingColumns`** in `schema-ready.ts` matches `table_name IN (…) AND
  column_name IN (…)` (a cross product, not pairs). Pre-existing, and harmless
  for a single-pair requirement like 083.

---

## Verdict

`VERDICT: PASS with findings.` Goal, all 14 edge cases, 7 of 7 user-visible
behaviors (2 partially), and all 19 promised test titles are delivered; no drift
outside `allowed_edit_surface`; `sql-tag-scan.ts` is byte-identical; the pragma's
one-line radius holds; the audit and all five touched live-DB suites are green
and strand nothing. Two behavioral gaps (F1 fail-open on interpolated
`.unsafe()` args — a named invariant; F2 false positive on SQL comments inside
executed templates) and one unexecuted plan ticket (F3 docs) should be closed
before merge.
