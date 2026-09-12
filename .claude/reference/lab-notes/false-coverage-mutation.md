# Lab notes — False coverage / mutation

## Summary

- **False coverage / mutation** — a test that passes whether or not the bug exists is the dominant defect mode on guard-shaped work; a fix for an "X is untested" finding must ITSELF be mutation-pinned or it reproduces the defect (happened twice in consecutive rounds at #679, and ~10 instances there were caught by mutation, none by reading); a JS `throw` does not poison a Postgres transaction, so savepoint-recovery tests need Postgres-side abort injection (#679, 2026-08-08); **Testing-Library's `rerender` PRESERVES component state, so it structurally cannot prove an UNMOUNT defect** — two promised tests passed against a panel that reset the owner's deselections on every refetch, through a full review round; a test for state that must SURVIVE a refetch belongs in the PARENT's suite driving the real mount boundary (#860, 2026-08-18); **a fail-open guard needs an oracle for the OPEN half** — pinning only the refusal left `budgetRemaining: null` (Redis down) undefended, and `(x ?? 0) <= 0` type-checks, keeps 29/30 green, and converts an Upstash outage into a dead lane (#860, 2026-08-18); **an all-or-nothing CHECK forces combined-restore tests, and a SQL-shape assertion then proves only that a predicate is PRESENT, never that its COMPARISON is right** — `IS DISTINCT FROM 'wrong literal'` satisfies `toContain` while detecting nothing, and a sibling column's violation carries the count; isolate each column (restore alone → expect 1 → revert → expect 0, labelled per column) wherever no constraint forbids it (#665, 2026-08-18); **a lint-on-stop hook cannot tell a MEASUREMENT from a mistake** — with a guard deleted on purpose, ESLint reports the orphaned import and its mechanically obvious remedy (delete the import) removes the guard PERMANENTLY, which is how invariant #3's auto-policy conjunct was nearly lost mid-census; declare the mutation with `touch .feature/mutation-in-progress` (git-ignored) — BOTH `.claude/hooks/` and `.codex/hooks/typecheck-on-stop.sh` then skip the eslint block only, typecheck still runs, and no green stamp is written — and remove it the moment the file is restored (#896, 2026-08-23) **The FIXTURE is the oracle (2026-08-30, #1008)**: a mocked `sql` that fabricates its own row cannot verify a query, and a fixture holding a dimension CONSTANT cannot catch a predicate that narrows on it — vary tenant/location/time/subject and assert an EXACT count.

## Canonical entries

_None yet — the Summary bullet is the current rule; see History for the dated evidence._

### [2026-09-12] Red-team round-2 inventory scope rule — CLEAR is a scope claim (#1270)
A verification round that carries round-1 `skipped-budget` rows forward computes `INCOMPLETE_BUDGET` even with zero open findings, and a 30-run cap over a 200+-row inventory can never clear it. The rule, decided with the owner and applied by the verifier: rows outside the round's scope (the fix hunks and their direct callers) become `excluded` with the reason "outside round-N scope by skill rule; never executed in any round of this run — not evidence of coverage" on EVERY row; rows inside scope stay `skipped-budget` and block. Never drop rows to reach CLEAR, and say in `findings.md` that CLEAR is a scope claim, not a coverage claim. Story: history/2026-09.md § 2026-09-12.

## History

- history/2026-08-08.md § "[2026-08-08] #679 — a fix for an untested-guard finding reproduces the defect unless the fix is itself mutation-pinned"
- history/2026-08-08.md § "[2026-08-08] #696 — a "is it wired?" test written against SOURCE TEXT is the same defect class as the bug it guards"
- history/2026-08-08.md § "[2026-08-08] #697 — `toMatchObject` cannot guard a "these fields and no others" invariant"
- history/2026-08-08.md § "[2026-08-08] #697 — mutation-test the ORDER of two statements, not just their presence"
- history/2026-08-08.md § "[2026-08-08] #678 — `diff-coverage` green and a file at 0% coverage are not contradictory; CRAP is the complementary signal"
- history/2026-08-08.md § "[2026-08-08] #695 — a shared mock recorder makes its optional field unassertable, so the eval passes while the feature is unbuilt"
- history/2026-08-08.md § "[2026-08-08] #680 — `String.match()` without the `/g` flag cannot count matches, so an "exactly one" assertion written with it is inert"
- history/2026-08-08.md § "[2026-08-08] #680 — a preflight that never fires is indistinguishable from a working one, so prove the FAILING branch or the gate is theatre"
- history/2026-08-13-to-21.md § "2026-08-15 — #831 portal-audit PR2: four ways a green test proved nothing"
- history/2026-08-13-to-21.md § "2026-08-15 — #833: two guards that passed for the wrong reason, and how the gate mis-sized a move"
- history/2026-08-13-to-21.md § "2026-08-18 — #860 ship: four tests that passed for the wrong reason, and a gate the local gate cannot see"
- history/2026-08-21-to-31.md § "[2026-08-21] A test that says it "mirrors" another suite may be mirroring it at the WRONG LEVEL"
- history/2026-08-21-to-31.md § "[2026-08-22] `it.fails` is not evidence, and unmasking without a sensitivity probe is a second false green"
- history/2026-08-21-to-31.md § "[2026-08-30] A mocked `sql` that fabricates its own row cannot verify a query → the FIXTURE is the oracle, and a fixture holding a dimension constant cannot catch a predicate that narrows on it"
- history/2026-08-21-to-31.md § "[2026-08-31] A comment asserting that a test CATCHES something is a claim to MEASURE, not to reason about → plant the mutant"
- history/2026-08-21-to-31.md § "[2026-08-31] The gate's `promised-tests` row proves a title EXISTS, never that it RUNS → an entire eval can be `it.todo` and pass"
- history/2026-09.md § "[2026-09-02] A mocked characterization test over emitted SQL is BLIND to foreign keys — and can pin a bug as correct"
- history/2026-09.md § "2026-09-04 — /feature #1105: the tests were the defect, four passes running"
- history/2026-09.md § "[2026-09-04] An unobservable invariant is an unasserted one"
- history/2026-09.md § "[2026-09-04] A mocked module boundary can make a lane-level contract untestable"
- history/2026-09.md § "[2026-09-04] Restoring a red-team mutation by re-invoking `mutate` re-plants it"
- history/2026-09.md § "[2026-09-04] A payload asserted by PRESENCE is not a closed payload"
