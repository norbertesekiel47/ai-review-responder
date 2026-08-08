# Standards & maintainability — review round 2 (verification only)

Branch `fix-694-live-db-ddl-detector`. Fix commits `415c7d1c`, `1301455f`,
`d7671e53`; pre-fix baseline `91873792`. Scope is strictly the nine round-1
findings plus any defect a fix itself introduced. Nothing else was opened; two
unrelated observations are parked in the appendix.

**Verdict: PASS with one correction required.** Seven findings verified as fixed,
one verified-with-a-caveat, one (S8) NOT verified — the census correction landed
the wrong number, and the number it landed was invalidated by its own sibling fix
commit in the same batch.

## Commands run (all from the worktree root)

| command | result |
|---|---|
| `pnpm vitest run scripts/ci/__tests__/live-db-suites-audit.test.ts` | 35 passed |
| `pnpm ci:live-db-suites` | `live-db-suites-audit: passed` |
| `pnpm lint` | clean |
| `pnpm typecheck` | clean |
| `pnpm vitest run …/import-offer/__tests__/route.integration.test.ts` | 7 passed (verbose-confirmed **executed**, not skipped) |
| `pnpm vitest run …/import-offer-analytics.integration.test.ts` | 11 passed |
| standalone Node repro of the shipped `abortingExecutor` against the live DB | see §S1 |
| independent AST recount at 8 refs (`main`, `8b87c859^`, `8b87c859`, `db5b8dc5`, `91873792`, `415c7d1c`, `1301455f`, `HEAD`) | see §S8 |
| `psql` probe of `pg_constraint` on `job_outbox` (BEGIN → ALTER → ROLLBACK) | 1 → 2 → 1 |

## Per-finding verdicts

| id | verdict | evidence |
|---|---|---|
| **S1** Proxy dropped `begin(options, cb)` | **VERIFIED** | `src/lib/shared/__tests__/helpers/abort-injection.ts:73-82`. Re-run empirically, SQLSTATE **25006** reproduced, negative control clean — §S1 below. Zero / one / N leading arguments all forward; `get`-only trap still forwards the tagged-template `apply` path and non-`begin` methods; the cast is confined to the single forwarding call. |
| **S2** poison's justification comment was false | **VERIFIED** | `src/app/api/dashboard/import-offer/__tests__/route.integration.test.ts:143-146`. The 11-line `gbp_connected` paragraph is gone; the replacement is TRUE — `import_decision_recorded` is a member of `MIGRATION_102_IMPORT_CONSENT_EVENTS` (`src/lib/shared/__tests__/helpers/schema-ready.ts:439`) and `beforeAll` asserts it at `route.integration.test.ts:175` via `assertAnalyticsEventNamesRegistered`. Parameter question answered in §Judgement. |
| **S3** `String(fn)` DDL grep | **VERIFIED (with a comment caveat — finding R2-2)** | Locked title byte-identical at `route.integration.test.ts:241`. `jobOutboxConstraintCount` (`:105-110`) is read-only over `pg_constraint`. Non-vacuity reproduced independently: baseline is exactly 1 (`job_outbox_pkey`, `contype='p'`), and `ALTER TABLE job_outbox ADD CONSTRAINT … CHECK (true) NOT VALID` inside `BEGIN … ROLLBACK` moved it 1 → 2 → 1. |
| **S4** `CLAUDE.md` / lab-notes stated R2 as "apply migration SQL" | **VERIFIED** | `.claude/CLAUDE.md:192` now says "must NOT execute DDL at run time", names both allowlists, the `live-db-ddl-ignore` pragma, and `abort-injection.ts`. Lab-notes index entry updated; new `## 2026-08-08 — #694` section with five `###` entries, tone and length consistent with the adjacent #696 block. I spot-checked the load-bearing new claim: `env -u TEST_DATABASE_POOL_URL pnpm vitest run <suite>` gives **7 skipped, exit 0** — the entry is accurate. |
| **S5** `sql-tag-scan.ts` header omits its fifth consumer | **VERIFIED (rejection upheld)** | `git diff main...HEAD -- scripts/ci/lib/sql-tag-scan.ts` is 0 lines. The redirect carries the instruction verbatim at `.claude/reference/lab-notes.md:1776`: "If you ever edit `SQL_TAG_NAMES`, know that `live-db-suites-audit.ts` deliberately does not consume it." I agree with the rejection — see §Judgement. |
| **S6** cast instead of narrowing | **VERIFIED** | `route.integration.test.ts:255` → `rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION })`. Six house precedents (`settings.test.ts:914`, `migration-100-…:189,193`, `AutonomyGovernorScheduler.integration.test.ts:621,629`, `import-offer-analytics.integration.test.ts:613`). `rejects` fails loudly on resolution ("promise resolved instead of rejecting"), so the no-throw case is still red. |
| **S7** stale R2 sentence | **VERIFIED** | `scripts/ci/live-db-suites-audit.ts:26-50` reads consistently end to end: R2 is stated as executed DDL, the `.unsafe()` reach claim is bounded ("reachable without a type checker"), both escapes named. No residual narrow claim in the audit or its tests. The only surviving "apply migrations at run time" strings are in `schema-ready.ts:469,511` error messages, where that IS the subject. |
| **S8** census numbers | **NOT VERIFIED — the number is wrong again, the other way** | `770 of 1469` / `80 suites` was true at `91873792` and became false at `1301455f`, the sibling fix in the same batch. True at HEAD: **1470 templates / 771 `sql()` / 78 audit-visible suites**. Full recount and the mechanism in §S8. |
| **S9** redundant parameter + array copy | **VERIFIED** | `scripts/ci/live-db-suites-audit.ts:270-285`: `unpragmaedDdlLines(source)` derives `lines` from `source.getFullText().split('\n')`; the `[...lines]` spread at the `lineHasPragma` call is gone. `getFullText()` is byte-identical to the `text` the caller previously split, so no behavioural change — and the pragma still reads RAW lines, which is required and is documented. |

## S1 — the empirical check, re-run

Standalone `tsx` script against `TEST_DATABASE_POOL_URL`, importing the SHIPPED
`abortingExecutor` (not a restatement of it), poison = no-op, writer =
`UPDATE job_outbox SET topic = topic WHERE false`:

```
begin("read only", write)      -> 25006          <- one leading argument, forwarded
begin(write)                   -> no error       <- negative control: the option arrived
begin("read only","zz…",write) -> TypeError: fn is not a function
poison fires (0 leading)       -> 23502          <- real Postgres error through the proxy
tagged template through proxy  -> [{"x":1}]      <- get-only trap, apply path intact
proxied.unsafe()               -> [{"y":2}]      <- non-`begin` method through the trap
```

SQLSTATE **25006** (`read_only_sql_transaction`) confirmed, and the negative
control proves the option arrived rather than something else failing. The
three-argument row is postgres.js's own arity limit, not a helper defect: the
helper forwarded all three (`args.slice(0, -1)` is arity-agnostic) and
postgres.js then read `arguments[1]` as its callback. Callback-last holds for
both real signatures (`begin(fn)`, `begin(options, fn)`), so `args[args.length-1]`
is the right extraction. Typing: the `(target.begin as (...forwarded: unknown[])
=> Promise<unknown>)` cast is the minimum a variadic spread over an overload set
needs, is confined to one call, and does not leak — the Proxy is still typed
`Sql`, so callers typecheck against the shipped overloads.

## S8 — the recount

Independent AST walk with the audit's own extraction semantics
(`git ls-files '*.test.ts' '*.test.tsx'` → `LIVE_DB_MARKERS` filter →
`ts.isTaggedTemplateExpression`), `NOT_LIVE_DB` excluded:

| ref | suites | templates | `sql()` |
|---|---|---|---|
| `main` | 78 | **1470** | 770 |
| `8b87c859^` | 78 | 1468 | 770 |
| `8b87c859` (extract abort-injection) | 78 | **1469** | 770 |
| `db5b8dc5`, `91873792`, `415c7d1c` | 78 | 1469 | 770 |
| `1301455f` (S3 fix) | 78 | **1470** | **771** |
| `HEAD` | 78 | **1470** | **771** |

Two separate errors:

1. **The figure is stale at HEAD.** `1301455f` added `jobOutboxConstraintCount()`
   — one new `sql()` tagged template in a marker-passing suite — in the same
   commit that wrote `770 of 1469` into the header. The fix invalidated its own
   number.
2. **D4's mechanism is false.** D4 says `8b87c859` "moved tagged templates out of
   `route.integration.test.ts` into `abort-injection.ts`, which is not a
   `*.test.ts` file", giving 1470 → 1469. Measured, that commit moved the count
   1468 → **1469** (up, not down), and `abort-injection.ts` contains **zero**
   tagged templates — it is a `Proxy`, not SQL. The 1470 round 1 reported was the
   count at the review base `main`, not "one commit earlier". D4 then generalises
   the false observation into a rule for the next recount ("expect the total to
   drift by one whenever SQL moves between a suite and a non-test helper"), which
   will mislead whoever follows it.

`21 distinct tag forms` and the `db!` = 73 figure are exact at HEAD. `78` vs `80`:
80 is the marker-passing count *before* the `NOT_LIVE_DB` filter; 78 is the set
the audit actually extracts SQL from. The two excluded files contribute 0
templates, so every template figure belongs to 78 — and the audit's own docblock
(`live-db-suites-audit.ts:65-73`) declares those two are NOT live-DB suites. The
S8 fix changed `78 suites` → `80 suites` in the header while
`docs/superpowers/plans/2026-08-08-live-db-ddl-detector.md:15` still says "all 78
live-DB suites" four lines above its own "80 files" — the document now
contradicts itself.

The plan file's per-form census block (`:18-24`: `770 sql()`, `265 tx`, `145 db`,
`120 sql`) is a `main`-era snapshot: it sums to 1470, not to the 1469 its own
prose claims at `:26`, and HEAD's split is `771 / 266 / 144 / 119`.

Every site carrying a stale figure at HEAD:

- `scripts/ci/live-db-suites-audit.ts:41`, `:225` (`770 of 1469`), `:228` (`the 80 suites`)
- `scripts/ci/__tests__/live-db-suites-audit.test.ts:19` (`the 770-use sql() shape`), `:295` (`1469`)
- `.claude/reference/lab-notes.md:1776` (`1469` ×2, `770`, `all 80 marker-passing`)
- `docs/superpowers/plans/2026-08-08-live-db-ddl-detector.md:15,18,26,28,80,335,338,446,792`
- `docs/superpowers/plans/fix-694-live-db-ddl-detector-deviations.md` D4 (`:102-136`) and D6 (`:208-209`)
- `docs/superpowers/plans/fix-694-live-db-ddl-detector-handoff.md:24` — still the pre-fix `770 of 1201` / `78`
- `docs/superpowers/plans/fix-694-live-db-ddl-detector-intake.json:35` — still `770 of 1201`

The last two were never swept; `intake.json` was edited in this very range
(`observability[1]`), so the stale `key_facts` entry sat one line-group away from
an edit.

## Findings a fix introduced

| id | sev | file:line | what |
|---|---|---|---|
| **R2-1** | Low-Medium | `scripts/ci/live-db-suites-audit.ts:41,225,228` (+ 6 more files, listed above) | Census is stale at HEAD and D4's justification for it is factually wrong. True: 1470 templates, 771 `sql()`, 78 audit-visible suites. **Standard violated:** the working rule that a corrected fact must be swept across every cross-reference in the same change, plus round 1's own "claims the code does not support" class. **Failure scenario:** the next recount does not reproduce 1469, and D4 explicitly instructs it to trust the drift rule that produced the error — a third round of the same finding. Cheapest correct fix: state the denominator as `~1.5k` / "the plurality" and keep the exact split in ONE place (the plan's census block, dated), rather than re-spelling exact counts in seven files that no test pins. |
| **R2-2** | Low | `src/app/api/dashboard/import-offer/__tests__/route.integration.test.ts:257-262` | The new comment claims the constraint count "pins that directly", where *that* is the vitest-TIMEOUT stranding it has just narrated. It cannot: on a timeout vitest fails the test and the trailing `expect(await jobOutboxConstraintCount())` never runs. The assertion is genuinely load-bearing for *committed schema surviving a completed run* (which is what a strand is), and that is worth having — but the historical trigger is structurally outside its reach. **Standard violated:** same "comment asserts more than the code does" class as S2 and S7, reintroduced by the S3 fix. One-line repair: say it pins "no committed object left on `job_outbox` by the time this test returns", and note the timeout case is covered by the *mechanism* holding no schema, not by this assertion. |

Neither is a behavioural defect; the detector, the helper and both suites are
correct and green.

## Judgement calls

**S2 — keeping the `poison` parameter.** Keep it; I agree with the orchestrator,
but the counter-argument is real and is not the one the docblock answers.

The repo rule "no abstraction before the second use" does not bite here — a
parameter is a seam, not an abstraction, and the alternative is worse: hardcoding
the `analytics_events` INSERT inside
`src/lib/shared/__tests__/helpers/abort-injection.ts` would give a generic
transaction-abort mechanism knowledge of one table's CHECK vocabulary, its FK
name and migration 102. That is a cohesion loss in a shared helper to save
duplication in two fixtures — the wrong trade. The helper's stated reason ("a
poison is the caller's fixture") is true *of the mechanism module*.

What the fix did not resolve is that unifying the event name removed the only
live variation, so the duplication is now literal: two byte-identical
`foreignKeyPoison` bodies, two `FOREIGN_KEY_VIOLATION` constants, and two ~25-line
docblocks each re-telling the #679/D20 narrative
(`route.integration.test.ts:114-160` and
`import-offer-analytics.integration.test.ts:199-243`) — the drift risk round 1
named, now with nothing justifying it. The resolution compatible with keeping the
parameter is a THIRD fixture module owning the poison, the SQLSTATE constant and
the one docblock, injected by both callers. That keeps `abortingExecutor(base,
poison)` exactly as shipped. Not urgent, and not a defect — but it should not be
recorded as "the parameter earns its keep because the callers differ", because
they no longer do.

**S5 — the rejection.** Upheld, no reservation. The file is outside
`allowed_edit_surface`, a locked invariant requires it byte-identical, its claim
is incomplete rather than false, and the discoverability risk is fully discharged
by the lab-notes instruction — which a maintainer editing `SQL_TAG_NAMES` reaches
through the same index they reach every other SQL-audit fact through. Spending a
surface amendment on a cross-reference would have been the wrong trade.

**D5 — not broadening the counter.** Right decision, but the stated reason is
stronger than the argument that carries it. A repo-wide `pg_class` count would
genuinely flake on the shared container. A `pg_index WHERE indrelid =
'job_outbox'::regclass` count would not: no allowlisted DDL suite touches
`job_outbox` at all (`MIGRATION_SHAPE_SUITES` = 074/076/077/078/088,
`DDL_PROBE_SUITES` = outreach-render + migration-091), so the scoping that makes
the constraint count safe would make an index count equally safe. It is still
correctly omitted, because the object this pair actually stranded was a CHECK
constraint and a `CREATE INDEX` never appears in a `pg_constraint` row — but the
reason is "the reach gained is nil", not "it would flake".

## Appendix — untriaged (out of this round's scope, no action requested)

1. `blankSqlComments` (`live-db-suites-audit.ts:157-161`) documents the `--`-in-a-
   string-literal bound but not its block-comment analogue: a `/*` inside a SQL
   string literal blanks forward to the next `*/`, which can span lines and so
   hide DDL on *later* lines, a strictly wider hole than the one recorded. No
   occurrence in the tree; contrived to trigger.
2. `.claude/CLAUDE.md:192` says allowlisted suites "must hold `acquireLiveDbLock`",
   which the code relaxes for migration-074 via `OWN_APPLY_LOCK` /
   `withMigration074ApplyLock`. Documented correctly in the audit's own docblock;
   the CLAUDE.md summary omits the carve-out.
3. `route.integration.test.ts:29` still restates the convention in the pre-#694
   narrow form ("NEVER applies migration SQL") in the suite's own header. True of
   that suite, but the narrow phrasing is what S4/S7 removed elsewhere.
4. `.claude/CLAUDE.md:192` carries "every tagged template and `.unsafe()` call"
   while the audit header was deliberately tightened to "every `.unsafe()` call
   reachable without a type checker". Summary-layer imprecision only.
