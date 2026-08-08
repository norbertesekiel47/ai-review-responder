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
