# Deviations — fix-694-live-db-ddl-detector

Entries the plan did not anticipate.

---

## D1 — step 9's predicted PASS/FAIL split was wrong in two places (task 0)

**What the plan said.** Step 9: "the three reach tests, the fail-closed test,
**all three pragma tests and both probe tests** FAIL. The four precision tests
may pass (vacuously) … The repo-wide test **reports as passing** because
`.fails` inverts it."

**What was observed.** 7 failed / 25 passed (32 total). The failures are:

- the three reach tests,
- the fail-closed test,
- **one** pragma test — `does not let a code line trailing the pragma exempt the
  DDL line below it`,
- **one** probe test — `flags an allowlisted DDL-probe suite that applies probe
  DDL without the cross-process lock`,
- the repo-wide `it.fails` test, which reports **FAIL** with
  `Error: Expect test to fail`.

**Why.** Two independent causes, neither a defect in the tests as written:

1. *Vacuous passes are broader than the plan assumed.* Pragma tests 1 and 2 and
   probe test 2 assert `toEqual([])`. The current detector returns `[]` for every
   fixture that lacks the `supabase/migrations` marker, so those three pass for
   the same reason the four precision tests do — the same "may pass vacuously"
   the plan already granted the precision group. Only the two tests in those
   groups that assert a *finding* can fail today.
2. *`.fails` does not keep this commit green — it cannot.* `pnpm
   ci:live-db-suites` is green on `main` today, so the repo-wide assertion
   `expect(offenders).toEqual([])` **passes**, and `it.fails` then reports the
   test as failed. The plan's stated rationale for `.fails` ("keeps this commit
   green") is therefore inverted for the Task 0 commit specifically.

**What was done.** Nothing changed — the tests are kept exactly as specified,
`.fails` included, and step 9's numbers are recorded as observed rather than as
predicted. `.fails` is still the right marker for the window the plan cares
about: once Task 1's tightened detector lands it will surface the real offenders,
the assertion will fail, and `.fails` will invert it to green until Task 4 fixes
them — at which point Task 5 drops `.fails`. Removing `.fails` now to make the
Task 0 commit green would invert the problem into the Task 1–4 window, which is
the longer one. A suite with expected failures is this task's deliverable.

**Verdict:** ACCEPT.

---

## D2 — T1–T4 run serially despite being marked mutually independent (orchestrator)

**What the plan said.** "T1–T4 are **mutually independent**: no blocking edges,
disjoint file sets," dispatched concurrently per `dispatching-parallel-agents`.

**What was found.** Independence holds for correctness and ordering, but three of
the four contend for a resource the plan did not model: T2, T3 and T4 each run
live-DB integration suites against the **shared local test container**. Running
them as concurrent vitest processes is precisely the cross-process interference
this ticket exists to prevent — the mechanism behind #573's 40P01 deadlocks.
Proving a DDL fix on a container a sibling task is concurrently mutating would
make any failure uninterpretable. Secondary: four subagents committing to one
worktree share a git index and can race on `index.lock`.

**What was done.** T1 → T2 → T3 → T4 dispatched serially. No plan edit — the
dependency graph in the plan is still correct, and a future run against isolated
databases could parallelise it unchanged. Cost is roughly eight minutes of wall
clock.

**Verdict:** ACCEPT.

---

## D3 — the superseded R2 exception paragraph was dropped, not kept alongside the new one (task 1)

**What the plan said.** Step 6: "update the R2 paragraph of the module header
(lines 26-36). Keep the existing deadlock rationale verbatim and append: …"

**What was found.** Lines 26-36 are two paragraphs, not one. The first is the
deadlock rationale (`ACCESS EXCLUSIVE` → 40P01 → flake → provision with
`test:db:setup`). The second describes the exception: "Migration-SHAPE suites are
the sanctioned exception … Each one is allowlisted below and must enrol in the
cross-process lock". The appended text restates that same fact more completely
under "Two escapes", and adds the second allowlist. Keeping both would leave the
header asserting there is ONE allowlist ("Each one is allowlisted below") three
lines above the text explaining there are two — a stale claim, and exactly the
sort of doc drift the working rules forbid.

**What was done.** The deadlock-rationale paragraph is kept verbatim as
instructed; the superseded exception paragraph is replaced by the appended text,
which subsumes it. No fact was lost — MIGRATION_SHAPE_SUITES, "applying the
migration IS the subject", and the lock enrolment requirement all survive in the
"Two escapes" paragraph.

**Verdict:** ACCEPT. Replacing a superseded paragraph is the correct reading of
"update the R2 paragraph"; carrying both would have shipped the doc drift the
working rules forbid.

---

## D4 — the corrected census is 1469 templates, not 1470 (review round 1, A6)

**What the plan said.** A6 gave the recounted figures as "**1470** tagged
templates across **80** marker-passing suites", replacing the header's wrong
"770 of 1201 templates" / "78 suites".

**What was found.** 80 marker-passing suites and 21 distinct tag forms both
reproduce exactly. The template count does not: an AST walk over every
`git ls-files '*.test.ts' '*.test.tsx'` file that passes `LIVE_DB_MARKERS`,
counting `ts.isTaggedTemplateExpression`, returns **1469** at this branch's HEAD
— stable across the `NOT_LIVE_DB` exclusion (which removes 2 suites but 0
templates) and across the TS/TSX `ScriptKind` split.

The missing one is accounted for. Commit `8b87c859` ("extract the non-DDL abort
injection") moved tagged templates out of `route.integration.test.ts` into
`src/lib/shared/__tests__/helpers/abort-injection.ts`, which is not a `*.test.ts`
file and so leaves the census. 1470 is the count as it stood one commit earlier;
1469 is the count as it stands now. `770` and `21 distinct forms` are unaffected.

**What was done.** The two header sites read `770 of 1469` and `the 80 suites`.
The number is a point-in-time census either way — the load-bearing claim is that
`sql()` is the plurality, which a smaller denominator only strengthens — but a
figure this audit's own header presents as exact should be reproducible from the
tree it describes. Method recorded here so the next recount does not re-derive
it: walk marker-passing test files, count tagged templates, expect the total to
drift by one whenever SQL moves between a suite and a non-test helper.

`docs/superpowers/plans/2026-08-08-live-db-ddl-detector.md` carries the stale
`1201` in four places (lines 26, 335, 446, 792) and `78 files` at line 28; it is
outside this batch's edit surface and was left for the orchestrator.

**Verdict:** ~~ACCEPT~~ → **ACCEPT the count, REJECT the mechanism. Superseded by
D7.** Review round 2 recounted independently and both axes agree HEAD is **1470
templates / 771 `sql()`**, not 1469/770 — and the explanation above is FALSE:
`8b87c859` moved the count 1468 → 1469 (UP, not down), and `abort-injection.ts`
holds ZERO tagged templates. The orchestrator accepted a plausible-sounding
mechanism without checking it, which then wrote a bogus drift rule into this file
instructing the next recount to reproduce the error. Corrected in D7; the
numbers are no longer stated exactly anywhere, which removes the failure mode
rather than re-deriving it a fourth time.

---

## D5 — `job_outbox` carries exactly ONE constraint, so the new strands-nothing counter has a baseline of 1 (review round 1, B3)

**What the review said.** B3: replace the `Function.toString()` DDL grep with a
`pg_constraint` count on `job_outbox` taken before and after the aborted
transaction, "the exact regression the old temporary-constraint approach caused".

**What was found.** The count works, but its baseline is smaller than the phrase
"job_outbox's constraints" suggests: on the provisioned test database
`SELECT conname, contype FROM pg_constraint WHERE conrelid = 'job_outbox'::regclass`
returns a single row, `job_outbox_pkey` (`contype = 'p'`). That matches the DDL:
`001_initial_schema.sql:301-318` declares the table with no FK and no CHECK —
`status` and `topic` are plain `TEXT` whose vocabularies live in SQL COMMENTS,
enforced in application code and by `ci:outbox-status` rather than by the
database. So the assertion is `1 === 1` on green, and a strand takes it to `2`.

That is non-vacuous, and it was verified rather than assumed: adding
`CHECK (true) NOT VALID` inside an explicit `BEGIN … ROLLBACK` moved the count
`1 → 2` inside the transaction and back to `1` after the rollback. A discriminator
with a baseline of 1 is still a discriminator, and the *shape* of the regression
it pins — an object surviving on the shared relation after the injection returns —
is exactly right.

**What was done.** The assertion ships as B3 specified. The helper is named
`jobOutboxConstraintCount` and its docblock names `job_outbox` as "the relation
the replaced temporary CHECK constraint used to strand on", so the low baseline
reads as the intended narrow scope rather than as an oversight. NOT broadened to
count `pg_class`/`pg_index` too: the stranded object this pair actually produced
was a CHECK constraint on this relation, and a wider counter would pick up
unrelated churn from sibling suites sharing the container and flake.

`FOREIGN_KEY_VIOLATION` is still asserted, via `rejects.toMatchObject` (B4), so
the "raises a real Postgres error" half of the locked title keeps its teeth; the
title itself is unchanged.

**Verdict:** ACCEPT, and the reasoning for NOT broadening the counter is the
better half of this entry. A `pg_class`/`pg_index` counter would pick up sibling
suites' churn on a shared container and flake — trading a real assertion for an
unreliable one. Narrow and verified beats broad and noisy.

---

## D6 — three orchestrator corrections from review round 1 (F4, S5, A6)

**What the reviews said.** Three findings landed on artifacts no implementation
batch owned.

**F4 — the repo-wide test's rationale was inverted, and so was the intake's.**
`observability[1]` claimed the repo-wide test makes a REACH regression loud. It
cannot: it asserts the offender list is empty, so a detector that goes blind
produces an empty list and the test PASSES. This was the orchestrator's own error,
written into the plan and propagated into a Task 5 commit message and code
comment. Corrected in BOTH intake copies (committed audit copy and `.feature`
arming copy) with the finding id recorded, and in the test's comment by batch A.
Reach is pinned by the reach fixtures, which assert a finding IS produced.

**S5 — `sql-tag-scan.ts`'s header does not mention its fifth consumer.** The
standards axis wanted a cross-reference so a future `SQL_TAG_NAMES` edit learns
that `live-db-suites-audit.ts` deliberately opts out. REJECTED as a source edit:
the file is outside `allowed_edit_surface`, a locked invariant requires its
behavior byte-identical, and its existing claim ("the four SQL vocabulary guards
… All four walk the AST for tagged templates whose tag identifier is in
SQL_TAG_NAMES") is still TRUE — merely incomplete. Editing it would spend a
surface amendment to add a cross-reference. REDIRECTED instead: the opt-out and
its reason are now recorded in the `.claude/reference/lab-notes.md` #694 entry,
which ends with the explicit instruction that anyone editing `SQL_TAG_NAMES`
should know this audit does not consume it. Discoverability closed, invariant and
surface intact.

**A6 — the plan file's census.** Fixed the five stale sites (`1201` ×4 → `1469`,
`78 files` → `80 files`, `78 suites` → `80 suites`).

**What was done.** All three above. None is a surface amendment, so the
amendment budget is untouched at 0 of 2; F4 and A6 are corrections to
descriptive fields, and S5 was rejected with its concern satisfied elsewhere.

**Verdict:** ACCEPT (self-triaged; F4 was the orchestrator's error and is the
most useful finding of the round — it invalidated a claim in three places).

---

## D7 — review round 2: two false CLAIMS shipped by round 1's fixes (R1, R2/R2-1, R2-2)

**What round 2 found.** All 14 round-1 findings VERIFIED, several with
mutation-proofs (pragmas removed → `runtime-ddl` fires; lock markers stripped →
both allowlists fire; `rejects.toMatchObject` still red on resolve). But the
fixes introduced three defects, and every one is a COMMENT asserting something
untrue — no behaviour was wrong.

**R1 — the tagged-template exclusion was justified by a false premise.** The
round-1 fix wrote: "Postgres.js parameterises a tagged template's substitutions,
so a substitution there arrives as a bind value and cannot carry a statement."
That is wrong. Postgres.js splices a nested `Query` substitution as raw SQL via
`fragment()`, proved live by the reviewer: `` sql`${sql.unsafe('select 42 as n')}` ``
returns `[{n:42}]`, which no bind value could do. The exclusion is still CORRECT,
for a different reason — the walk visits the PRODUCING node, so the inner
`.unsafe()` is caught where it is built rather than where it is spliced.

Following the true reason exposed a real bound the false one hid:
`listTestFiles()` globs `*.test.ts`/`*.test.tsx`, so the ten
`__tests__/helpers/*.ts` modules are never scanned. A helper exporting
`` sql`ALTER TABLE job_outbox …` `` that a suite interpolates as `` sql`${addCheck}` ``
audits clean.

**What was done.** The comment now states the true reason and names the bound.
The glob is NOT widened: helper files do not match `*.integration.test.ts` and
would immediately trip R1's naming rule, so closing it needs naming carve-outs
and a `NOT_LIVE_DB` expansion — a behaviour change, on a ticket about the DDL
detector rather than the file glob, at round 2 of a cap of 3. Filed as its own
issue so the hole does not evaporate with this branch.

**R2 / R2-1 — the census went stale AGAIN, inside the same review.** Round 1's S8
fix corrected `1201` → `1469`; round 1's OTHER fix commit (`1301455f`) then added
a `sql()` template (`jobOutboxConstraintCount`) and invalidated it in the same
round. Round 2 also found pre-fix `1201`/`78` still in `handoff.md` and both
intake copies, which the S8 sweep missed.

**What was done.** Stopped stating exact figures anywhere. The load-bearing claim
is that `sql()` is the PLURALITY, which no drift can falsify; the numbers are now
approximate ("~770 of ~1470"), explicitly labelled a point-in-time census, and
paired with the recount method. Three strikes (S8 → R2 → this) is enough evidence
that an exact count in a comment is a maintenance trap. Also settled the 80-vs-78
disagreement between the two axes, which was an ambiguity in the orchestrator's
own wording, not a discrepancy: **80 marker-passing files, 78 audit-visible**
after `NOT_LIVE_DB`, and those 2 excluded files hold zero templates — so template
counts are definition-independent. Both reviewers were right.

**R2-2 — the strands-nothing comment overclaimed.** It said counting constraints
"pins directly" the vitest-TIMEOUT stranding. It cannot: on a timeout the
assertion never executes. Corrected to say what is true — the assertion pins the
COMMITTED-leak half, and the timeout case is ruled out STRUCTURALLY (the
injection holds no schema on any path, so a skipped `finally` has nothing to
strand). The design guarantees it; the assertion guards it.

**Standings on the two judgement calls round 2 was asked to re-examine.** S2:
both axes agree the `poison` parameter should stay (inlining it would give a
generically-named helper knowledge of `analytics_events` and migration 102); the
standards axis proposed a third fixture module owning poison + SQLSTATE, declined
as abstraction with no second shape to justify it — two callers each owning their
own fixture is the correct arrangement. S5: rejection upheld by the reviewer with
no reservation.

**Verdict:** ACCEPT. The pattern across both rounds is worth stating once: every
single finding in this review — 14 in round 1, 3 in round 2 — was either a claim
that was false or a test that proved less than its name promised. The executable
parts were right from the first pass. On a feature whose entire subject is "an
audit that asserted something it did not check", that is the fitting result.
