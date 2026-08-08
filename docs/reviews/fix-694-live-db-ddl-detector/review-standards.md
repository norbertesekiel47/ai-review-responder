# Review — standards & maintainability axis (round 1)

**Branch:** `fix-694-live-db-ddl-detector` · **Fork point:** `13212b5588b96de2a5c8fcd0430cc95d70271e50` (10 commits)
**Axis:** how the code is BUILT. Spec compliance, promised-test existence and edge-case coverage belong to the sibling report and are deliberately not touched here.
**Tool:** `/thermo-nuclear-code-quality-review` (agent-invocable; ran clean), supplemented with the seven RepWorth-specific checks.

---

## 1. Verification performed

Everything below was executed in the worktree, not inferred.

| Check | Result |
| --- | --- |
| `pnpm typecheck` | clean |
| `pnpm lint` | clean |
| `pnpm ci:live-db-suites` | `passed`, 0.70s wall |
| `npx vitest run scripts/ci/__tests__/live-db-suites-audit.test.ts` | 32/32 passed, 582ms |
| Diff grep for `any` / `: any` / silent `catch` | none (one `catch (error)` that assigns and re-asserts; one pre-existing-style `as unknown as Sql`) |
| Empirical Proxy behaviour test (standalone Node repro of `abortingExecutor`) | tagged-template `apply` path forwards untouched ✓; `begin(options, cb)` **drops `options`** ✗ |
| Independent AST recount of the docblock's empirical claims (`main` **and** HEAD) | 770 `sql()` ✓, 21 distinct tag forms ✓, **1470** templates (docblock says 1201) ✗, **80** live-DB suites (docblock says 78) ✗ |
| Grep for ACCESS-EXCLUSIVE verbs missing from `DDL_VERB` (`REINDEX`, `REFRESH MATERIALIZED`, `CREATE/ALTER SEQUENCE`, `LOCK TABLE`, `CLUSTER`) in test files **and** `supabase/migrations` | zero hits — the gap is theoretical, not live |
| Grep for non-SQL tagged templates in test files (`toMatchInlineSnapshot`, `it.each`, `String.raw`) | zero hits — the "every tagged template in a live-DB suite IS SQL" premise holds today |
| Grep for `live-db-ddl-ignore` outside `scripts/ci/` and the plan docs | 3 hits, all use sites; no documentation |

---

## 2. RepWorth-specific checks

### Check 1 — `codebase-design` deep-module discipline: **PASS**

The claim on record holds exactly.

- `auditLiveDbSuite(file: string, text: string): LiveDbSuiteFinding[]` — byte-identical signature to `main`.
- `interface LiveDbSuiteFinding { file; rule: 'naming' | 'runtime-ddl' | 'unlocked-ddl'; reason }` — unchanged, including the rule union. No fourth rule, no new field.
- The DDL line number is folded into `reason` via `firstAt` (`live-db-suites-audit.ts:243`), not surfaced on the interface. That is the deepening move: the module absorbed a new capability (AST extraction) and its callers learned nothing new.

The internal decomposition is the right cut. It is a four-stage pipeline where each stage has one job and a describable output:

```
extractExecutedSql(source) → ExecutedSql[]     // AST → what the suite EXECUTES
unpragmaedDdlLines(source, lines) → number[]   // executed SQL → DDL lines, minus escapes
auditLiveDbSuite(file, text) → Finding[]       // DDL lines → policy (allowlists, locks)
isUnsafeCall(node) → node is CallExpression    // a named predicate, not an inline conjunction
```

`isUnsafeCall` earns its name: inlining that three-clause type-guard into the visitor would have been the spaghetti version. `ExecutedSql`'s `text: string | null` is the honest encoding of "statically unreadable", and `unpragmaedDdlLines` resolves `null` to *flagged* — fail-closed at the right layer.

One small leak upward, filed as finding #9: `unpragmaedDdlLines` takes both `source` and `lines`, which are two representations of one string, and the `readonly` on the second forces a full array copy per finding.

### Check 2 — sibling-audit precedent: **PASS, no unjustified divergence**

Compared against `outbox-topics-audit.ts` and `outbox-seam-audit.ts`:

| Dimension | House pattern | This audit |
| --- | --- | --- |
| Source construction | `ts.createSourceFile(name, text, Latest, true, ScriptKind)` | same, and passes the **real** path instead of `'scan.tsx'` — strictly better |
| Visitor | recursive `visit` + `ts.forEachChild(node, visit)` | same |
| Position → line | `node.getStart(source)` + `getLineAndCharacterOfPosition` | same, incl. the `nodeStart + match.index` offset idiom from `outbox-topics-audit.ts:75-76` |
| Pragma | `lineHasPragma(lines, line, PRAGMA)` from `lib/sql-tag-scan` | same, shared, not re-implemented |
| Exported surface | pure `scan*`/`audit*` returning `Finding[]`, unit-tested | same |
| Entry point | `main()` behind the `pathToFileURL(...) === import.meta.url` guard | same |
| File discovery | `walk(root, { scanDirs })` from `lib/ratchet-harness` | `execFileSync('git', ['ls-files', …])` — **pre-existing on `main`**, not this branch's choice |

I verified the offset arithmetic by hand: `node.template.getStart(source)` and `node.template.getText(source)` share an origin (`getText` substrings from `getStart()`), so `sql.start + match.index` is sound for both the template and the `.unsafe()`-argument branch.

Notably it does **not** copy `response-status-audit.ts:153`'s mistake of re-declaring a local `lineHasPragma`.

### Check 3 — the `sql-tag-scan.ts` boundary: **boundary correct, documentation misplaced**

The boundary itself is drawn in the right place, and I reproduced the evidence for it independently: in the 80 live-DB suites there are 1470 tagged templates across 21 distinct tag forms, of which `sql()` alone is 770 — a `CallExpression`, invisible to `SQL_TAG_NAMES`/`isSqlTaggedTemplate`, which only handle a bare `Identifier` or a `PropertyAccessExpression` rooted in one. Add `db!` (73, a `NonNullExpression`), `sqlA()` (39) and `observerSql()` (12) and a name allowlist misses well over half. Reusing it would have shipped the #592 defect one layer down. The implied duplication — this audit walking templates its own way — is not duplication at all: it is a *different predicate* (all templates vs. named templates) over a *different scope* (test files vs. `src`/`worker`). Sharing it would require a union type nobody wants.

The problem is *where* the decision is written down. It is documented twice on the consumer side (`live-db-suites-audit.ts:37-39` and `:158-163`) and zero times on the shared-module side, whose own header enumerates its consumers and now enumerates them wrongly. Filed as finding #5.

### Check 4 — new-file justification: **justification holds; implementation has one defect**

The stated justification is accurate. `src/lib/shared/__tests__/helpers/` contains exactly five files for five concerns — `live-db-lock.ts`, `schema-ready.ts`, `outreach-fixture.ts`, `apply-migration-074.ts`, and now `abort-injection.ts`. `schema-ready.ts` is already 21KB and owns assert-never-apply; bolting transaction-abort injection onto it would widen a focused module for an unrelated reason. Two callers, so the "no abstraction for a single caller" rule is satisfied. Correct call.

**Proxy soundness — verified empirically, not reasoned about.** I built a standalone repro with a callable stand-in `Sql` and exercised every call form:

```
p`SELECT 1`                    → ["tag", ["SELECT 1"]]        ✓ apply forwards untouched
p.unsafe('SELECT 2')           → ["unsafe", "SELECT 2"]       ✓
p.begin(cb)                    → ["begin", "<no-options>"]    ✓
p.begin('isolation …', cb)     → ["begin", "<no-options>"]    ✗ options SILENTLY DROPPED
```

So the docblock's load-bearing claim — "A `get`-only trap does not intercept `apply`, so the tagged-template call form forwards untouched" — is **true**. A proxy is callable iff its target is, and with no `apply` trap the call forwards via `Reflect.apply(target, …)`. Good claim, correctly reasoned.

The `begin` override is the defect. It reads the callback as `args[args.length - 1]` — proving the author knew there may be more than one argument — then discards everything before it. Filed as finding #1.

### Check 5 — repo rules: **PASS on the hard rules**

- **No `any`:** clean. One `unknown`-then-cast that should be a narrow (finding #6).
- **No silent catches:** clean. The one new `catch` assigns to `raised` and immediately asserts on it.
- **No string literals where a constant exists:** clean. `DDL_PRAGMA`, `SHARED_LOCK_MARKER`, `FOREIGN_KEY_VIOLATION`, `MIGRATION_083_OUTBOX_OWNER_UNREACHABLE` all hoisted.
- **No abstraction for a single caller:** `abortingExecutor` has two.
- **No new top-level directory:** correct.
- **Net-negative bias:** source is roughly +330 net (`live-db-suites-audit.ts` 166 → 301; `abort-injection.ts` +66 new; −34 from the analytics suite; −14 DDL lines across five suites). The audit's growth carries its weight — a two-`includes` heuristic became a real extractor, and 301 lines is nowhere near the 1k threshold. The one place the additions do *not* carry their weight is the second caller's ~38-line docblock (`route.integration.test.ts:106-143`), which restates the `abort-injection.ts:1-30` incident narrative in a paragraph that itself says "The helper header carries the full reasoning." Two copies of the #679/D20 story now have to be kept in sync; finding #2 collapses one of them.

### Check 6 — glossary violations: **PASS, none found**

Every established term is used under its established name, and each has exactly one owner:

| Term | Where it lives, unrenamed |
| --- | --- |
| live-DB suite | `LIVE_DB_MARKERS`, `NOT_LIVE_DB`, every finding `reason` |
| migration-shape suite | `MIGRATION_SHAPE_SUITES` |
| DDL-probe suite | `DDL_PROBE_SUITES`, and the test's `// DDL-PROBE SUITES` block |
| executed SQL | `extractExecutedSql`, `interface ExecutedSql`, `// Detection is on EXECUTED SQL` |
| the pragma | `DDL_PRAGMA = 'live-db-ddl-ignore'`, `unpragmaedDdlLines` |
| abort injection | `abort-injection.ts`, "the shared abort injection" in the test title |
| poison | the `poison` parameter, `foreignKeyPoison` in both callers |
| assert-never-apply | quoted verbatim in the two suites that dropped their `ALTER TABLE` |
| pg_temp | both pragma reasons in the 080 preflight |

No competing coinage. `abortingExecutor` reuses the existing `SqlExecutor` vocabulary consistently (a thing that is a `Sql`), and `unpragmaedDdlLines` is derived from "the pragma" rather than inventing a rival word.

### Check 7 — comment quality: **mostly at the bar; three claims the code does not support**

At the bar, and genuinely regression-preventing:

- `live-db-suites-audit.ts:33-39` — names the *shape* of the old defect ("an incidental marker"), ties it to #694 and to #592 "one layer down", and states the counting evidence. A future reader tempted to add a tag allowlist is stopped by it.
- `live-db-suites-audit.ts:127-134` — explains why DCL is *deliberately* absent and states the consequence ("would change no finding today"). Naming an omission and its blast radius is the right form.
- `live-db-suites-audit.ts:132-134` — the `matchAll` / `lastIndex` note is exactly the kind of non-obvious mechanism that earns a comment.
- `abort-injection.ts:1-18` — carries the D20 incident, the timeout-skips-`finally` mechanism, and the ACCESS EXCLUSIVE angle. Load-bearing.
- `abort-injection.ts:36-42` — the `Proxy`-not-cast rationale and the `apply` claim; I verified the `apply` claim empirically and it is correct.
- `migration-080-outbox-dedup.integration.test.ts:80,182,191` — three pragmas that each state *why* the target cannot be a shared relation. This is what the escape hatch is supposed to look like.

Claims the code does not support — findings #2 (migration-102 coupling), #7 (R2's rule sentence), #8 (1201/78). Plus a title-vs-assertion mismatch inside finding #3: the test is titled "the **shared abort injection** raises a real Postgres error without executing any DDL", but its DDL assertion inspects only the local `foreignKeyPoison` and never `abortingExecutor`.

---

## 3. Findings

Only findings I would stake ≥80% on. Most severe first.

| # | Severity | file:line | Finding |
| --- | --- | --- | --- |
| 1 | Medium | `src/lib/shared/__tests__/helpers/abort-injection.ts:54-57` | `begin` override reads the callback as the last arg then calls `target.begin(cb)` with one arg — Postgres.js's supported `begin(options, cb)` form is silently dropped (verified empirically) |
| 2 | Medium | `src/app/api/dashboard/import-offer/__tests__/route.integration.test.ts:132-142` | "WHY `gbp_connected`" justifies the divergent poison on avoiding a migration-102 precondition the same `beforeAll` acquires at `:169` — the reason for the two poisons differing is false, and the `poison` parameter has no justified variation behind it |
| 3 | Medium | `src/app/api/dashboard/import-offer/__tests__/route.integration.test.ts:255` | `expect(String(foreignKeyPoison)).not.toMatch(…)` — a `Function.toString()` source grep that inspects only the poison (not the shared mechanism its title names), duplicates the branch's own static gate in the weaker place, and fails OPEN |
| 4 | Medium-Low | `.claude/CLAUDE.md:192` + `.claude/reference/lab-notes.md:22` | Both still state R2 as "must NOT apply migration SQL" with one sanctioned exception; the new `live-db-ddl-ignore` pragma and `DDL_PROBE_SUITES` are undocumented outside `scripts/ci/` |
| 5 | Low-Medium | `scripts/ci/lib/sql-tag-scan.ts:3-6` | Shared module's header enumerates its consumers and says "All four walk the AST for tagged templates whose tag identifier is in `SQL_TAG_NAMES`" — the deliberate opt-out is documented only consumer-side, not where a future `SQL_TAG_NAMES` edit is read |
| 6 | Low-Medium | `src/app/api/dashboard/import-offer/__tests__/route.integration.test.ts:243-251` | `try/catch` + `(raised as { code?: string }).code` casts `unknown` instead of narrowing, and dies with a bare `TypeError` if nothing throws; the canonical `rejects.toMatchObject({ code })` form is used three files away |
| 7 | Low | `scripts/ci/live-db-suites-audit.ts:26` | R2's rule sentence still reads "must not apply migration SQL" — the pre-#694 narrow statement — three lines above the text explaining detection is on all executed SQL |
| 8 | Low | `scripts/ci/live-db-suites-audit.ts:38-39`, `:161-163` | "770 of 1201 templates" / "the 78 suites": recounted on `main` and HEAD it is 1470 templates across 80 suites (770 and 21 are exact) |
| 9 | Low | `scripts/ci/live-db-suites-audit.ts:201,214,240` | `unpragmaedDdlLines(source, lines)` takes two representations of one string, and its `readonly string[]` forces `lineHasPragma([...lines], …)` to copy the whole array per finding |

### Finding details

**#1 — `begin(options, cb)` silently drops `options`.**
```ts
return (...args: unknown[]) => {
  const callback = args[args.length - 1] as (tx) => Promise<unknown>;
  return target.begin(async (tx) => { … });   // ← everything before `callback` is discarded
};
```
`postgres/types/index.d.ts:717-718` declares both overloads, and the repo uses the two-arg form at `src/lib/escalations/list.ts:43` (`sql.begin('isolation level repeatable read read only', …)`). My standalone repro confirms the options string never reaches the base client. Because the proxy is typed `postgresType.Sql`, the two-arg call typechecks and loses the isolation level silently.

Concrete failure scenario: a third suite — and extraction into a shared helper exists precisely to invite one — wraps a writer that opens `begin('isolation level repeatable read read only', …)`. The test runs the writer under READ COMMITTED while asserting behaviour the production path only exhibits under REPEATABLE READ. Nothing fails; the test just stops proving what it says it proves. This is the same class as the temporary-constraint hazard the helper was extracted to kill: an invisible divergence between the test's world and production's.

Fix: forward the leading arguments (`target.begin(...(args.slice(0, -1) as []), async (tx) => …)`), or make the contract explicit — type the parameter as the one-argument overload only and throw on `args.length > 1`. Either is better than a silent drop in a file whose whole premise is "the failure must originate in Postgres, not in JS."

**#2 — the migration-102 justification is contradicted 27 lines below it.**
The docblock:
> WHY `gbp_connected` AND NOT AN IMPORT EVENT NAME. The SQLSTATE has to be deterministic **without this suite acquiring a migration-102 precondition** — 102 registers the two Import offer names and is unrelated to this suite's subject, so **depending on it here would be gratuitous coupling**.

The suite's own `beforeAll`:
```
161:    await assertSchemaReady(db, [MIGRATION_100_IMPORT_CONSENT]);
169:    await assertAnalyticsEventNamesRegistered(db, MIGRATION_102_IMPORT_CONSENT_EVENTS);
```
The coupling is already there, deliberate, and load-bearing for the "self-heal records `import_offer_created`" title (`:162-168` explains at length why it must be). So the paragraph is not merely redundant — it asserts the opposite of the file it lives in, and it is the *sole* stated reason the two callers' poisons differ.

The code-judo move: put both callers on `'import_decision_recorded'`, and `poison` has no live variation behind it. `abortingExecutor` collapses to `abortingExecutor(base)` with one shared poison, the `:106-143` docblock (which restates `abort-injection.ts:1-30` while announcing it doesn't) disappears, and the #679/D20 narrative has one owner instead of two copies to keep in sync. That is ~40 lines deleted and one drift risk removed. If the two-parameter shape is kept anyway, the false paragraph still has to go.

**#3 — `Function.toString()` as an enforcement mechanism.**
```ts
expect(String(foreignKeyPoison)).not.toMatch(/\b(?:ALTER|CREATE|DROP)\s+\w/i);
```
Three problems, and the third is the one that matters:
1. Scope mismatch. The test is titled "the **shared abort injection** raises a real Postgres error without executing any DDL", but this line inspects only the local poison. DDL reintroduced into `abortingExecutor` — the shared mechanism — passes.
2. Wrong owner. "No DDL in this live-DB suite" is exactly what `ci:live-db-suites` now proves statically, repo-wide, in 0.7s, for all 80 suites. This branch built that. Re-asserting a strictly weaker version of it at runtime, in one file, against one function, is duplicated enforcement in the weaker place.
3. Fail-open. `not.toMatch` is vacuously true against an empty or mangled string. `Function.prototype.toString()` output is a property of the transform pipeline, not of the code — a change to vitest's transform can make this assertion permanently green without anyone noticing.

Delete the line. The static gate covers the property, and the two assertions above it (SQLSTATE `23503`, and the rollback title's three absences) are the ones that actually pin the injection.

**#4 — the new pragma is undiscoverable.**
`rg 'live-db-ddl-ignore'` outside `scripts/ci/` and the plan docs returns three hits, all use sites. Meanwhile `.claude/CLAUDE.md:192` and `.claude/reference/lab-notes.md:22` both still describe R2 in its pre-#694 form: "must NOT apply migration SQL", with migration-shape suites as *the* sanctioned exception. Neither mentions `DDL_PROBE_SUITES` or the escape hatch. A developer whose suite goes red has the audit's own `reason` string as their only pointer.

The precedent is explicit: the analogous `outbox-seam-ignore` pragma is documented in CLAUDE.md invariant #2 ("Escape hatch is a per-line `-- outbox-seam-ignore: <reason>` (one use today)"), including its use count. Same treatment is owed here, ideally with the three-use count.

Noted for triage: this repo does post-merge doc sweeps as separate PRs (`13212b55`, `8b9be2ca`). The orchestrator should decide whether that convention covers this or whether a new convention needs to land with its enforcement.

**#5 — the shared module doesn't know it has an opt-out consumer.**
`sql-tag-scan.ts:3-6` reads: "Shared SQL-tagged-template scanning primitives for **the four** SQL vocabulary guards — … **All four** walk the AST for tagged templates whose tag identifier is in `SQL_TAG_NAMES`". As of this branch that is wrong twice: `outbox-seam-audit.ts` is an undeclared fifth consumer (pre-existing), and `live-db-suites-audit.ts` is a sixth that imports `lineHasPragma` and *deliberately rejects* `SQL_TAG_NAMES`.

Why it matters: `sql-tag-scan.ts:16-20` invites future edits to `SQL_TAG_NAMES` ("Adding a spelling here is a deliberate edit"). Someone doing that reads a header claiming the name-allowlist approach is universal, with no signal that a consumer measured it at ~52% coverage over test files and opted out. Two sentences in the shared header — this module has *two* export groups, the `SQL_TAG_NAMES` pair for `src`/`worker` vocabulary guards and the scope-agnostic `lineHasPragma`, and `live-db-suites-audit.ts` uses only the second, on purpose — put the decision where the person who would break it is standing.

**#9 — two representations of one string, plus a copy per finding.**
```ts
function unpragmaedDdlLines(source: ts.SourceFile, lines: readonly string[]): number[] {
  …
  .filter((line) => !lineHasPragma([...lines], line, DDL_PRAGMA));
}
// caller: unpragmaedDdlLines(source, text.split('\n'))
```
`source` already carries the full text; `lines` is derivable from it. And `lineHasPragma(lines: string[], …)` never mutates, so the `readonly` annotation on the parameter is self-inflicted — it forces a fresh copy of every line in the file on each finding. `outbox-topics-audit.ts:71` shows the house form: derive `source.getFullText().split('\n')` inside. Either widen `lineHasPragma` to `readonly string[]` (correct signature for a pure reader, benefits all six consumers) or drop the parameter and derive locally. Both delete code.

---

## 4. Low-confidence appendix

Below the 80% bar. Recorded, not asserted.

- **`DDL_VERB` omits some ACCESS EXCLUSIVE verbs.** `REINDEX`, `CLUSTER`, `REFRESH MATERIALIZED VIEW`, `CREATE/ALTER/DROP SEQUENCE`, `ALTER DOMAIN`, `LOCK TABLE … IN ACCESS EXCLUSIVE MODE` are all absent, and the docblock introduces the set as "DDL that takes ACCESS EXCLUSIVE on its target". I grepped every test file *and* every migration: zero occurrences, so this is theoretical and changes no finding today — the same standard the docblock applies to DCL. Worth one clause in the DCL paragraph ("…and the ACCESS EXCLUSIVE verbs this codebase has never used") so the next reader knows the omission was measured rather than missed.

- **Precision holes the no-allowlist premise leaves open.** Because every tagged template counts, a DDL verb inside a `${…}` substitution, inside a SQL comment within a template, or inside a vitest `toMatchInlineSnapshot`/`it.each` template would flag. None exist today (verified). The premise is empirical and true now; it is not structural. A one-line note that the premise is measured, not guaranteed, would age better than the current "a tagged template IS SQL".

- **`await import('node:fs/promises')` inside the repo-wide test** (`scripts/ci/__tests__/live-db-suites-audit.test.ts:231`) where a top-level import would do. The cited precedent, `src/__tests__/ci-audit-wiring.test.ts:1`, imports `readFileSync` at the top. Cosmetic; the dynamic form works.

- **`unpragmaedDdlLines` sorts the full line array to consume only `[0]`.** `Math.min(...)` would do. The `?? 0` at `:243` looks like a masked invariant but is forced by `noUncheckedIndexedAccess: true` and is idiomatic here.

- **`assertSchemaReady(sql as unknown as Sql, …)`** at `NotificationFailoverPoller.integration.test.ts:176`. A double cast, but it matches the adjacent pre-existing `seedTenantAccount(sql as unknown as Sql, …)` in the same `beforeAll`. Consistent with the file; the fix belongs to whatever change unifies that file's client typing.

- **The repo-wide test duplicates `ci:live-db-suites` inside `pnpm test`.** Justified in-comment (it is what makes a *reach* regression loud, which fixture tests structurally cannot catch) and cheap (~0.7s, and it shares `listTestFiles` rather than re-deriving the file list). Reasonable; noted only because duplicated gates usually aren't.

- **`abort-injection.ts:20-25` lists three sibling helpers** but the directory holds four (`apply-migration-074.ts` is omitted). Does not affect the argument.

---

## 5. Verdict

**Approve with changes.** The main event — the detector rewrite — is the strongest part of the branch and I found nothing structural against it. Deep-module discipline held exactly as claimed (signature and finding shape byte-identical, line number folded into `reason`); the four-stage decomposition is the right cut with no complexity leaking upward; the house AST/pragma/entry-point pattern is matched rather than re-invented; the `sql-tag-scan` boundary is drawn correctly and I reproduced its evidence independently. No 1k-line file, no ad-hoc branching bolted into an existing flow, no `any`, no silent catch, no speculative abstraction. `typecheck`, `lint`, `ci:live-db-suites` and the 32-test unit suite are all green.

Every finding sits in the periphery: the extracted test helper and the second caller's prose. Findings #1-#3 should land before merge — #1 is a silent contract drop in newly-shared code, #2 is a comment asserting the opposite of the file it lives in (and taking a parameter's justification down with it), #3 is a fail-open assertion duplicating this branch's own static gate. #4 is a judgement call against the post-merge-sweep convention. #5-#9 are cheap and each deletes code or a drift risk.
