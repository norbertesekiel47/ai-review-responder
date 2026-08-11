# #757 — deviations from the locked intake

Entries are things the intake/plan did not anticipate. Each gets a one-line
ACCEPT / RE-PLAN verdict at step 6 (deviations read-back) before review.

---

## D1 — `allowed_edit_surface` amendment #1: `scripts/ci/tenant-scope-allowlist.ts`

**When:** step 3, codex plan review round 1 (BLOCKER).

**What the intake missed:** `scripts/ci/tenant-scope-allowlist.ts` carries **seven** allowlist
entries whose `file` is `src/lib/kpi/service.ts` (under the `// --- KPI service ---` header at
~line 2258), plus `ALLOWLIST_BASELINE = 408`. The audit fails on a stale entry
(`UNUSED_ALLOWLIST_REASON = 'unused tenant scope allowlist entry'`) **and** on a baseline/count
mismatch. So deleting Stack A without touching this file breaks `pnpm ci:tenant-scope` — and the
file was outside the declared surface.

**Amendment:** added `scripts/ci/tenant-scope-allowlist.ts` to `allowed_edit_surface` in both
intake copies. One file, inside `scripts/ci/`, a tree the surface already reached into
(`scripts/ci/__tests__/db-imports-audit.test.ts`) — auto-approved under step 2's rule, recorded
here, and it **counts as amendment #1 of the 2 allowed** before abort criteria apply.

**Verdict:** ACCEPT — mandatory to keep the branch green; scope is one file and seven entries whose
only reason to exist is the file being deleted.

---

## D2 — `tests_to_add` extended by five titles (not an amendment)

**When:** step 3, codex plan review round 1 (six MAJOR findings about eval holes).

**What changed:** the eval suite could pass while the feature shipped wrong in five distinct ways.
Added to `tests_to_add` in both intake copies:

1. `avg star prior window and sample size bucket on the review-time anchor` — the prior bucket,
   `star_n_prior` and the delta were unproven; only `.current` was asserted.
2. `time-saved keys on approved_at so an imported review answered today still counts` — the
   original negative control selected the response-rate query by a string both queries share, so
   timeSaved was never inspected.
3. `aggregate windowedReceived and windowedResponded still count on detected_at` — the account
   response-rate counters had no live proof and could be re-anchored silently.
4. `a location with no reviews still gets a zero-filled velocity series in the aggregate slice` —
   nothing stopped an implementer moving the anchor from `LEFT JOIN … ON` into `WHERE`, which
   degenerates the outer join and drops empty locations entirely.
5. `the Review-time anchor is spelled only in kpi/fragments.ts` — every other test passes if
   Stack B hand-spells `LEAST(...)` and leaves `fragments.ts` dead, violating the intake's
   single-owner invariant.

Per step 5's rule, `tests_to_add` additions are owner-approved deviations-file entries, **not**
surface amendments — they do not count toward the abort budget.

**Verdict:** ACCEPT — each closes a demonstrated hole in the failable definition of done.

---

## D3 — Pathfinder P1 item 1 superseded (four fragments → two)

**When:** step 1 grilling (owner-adjudicated), re-raised by codex round 1 as an undocumented
reversal of a cited decision of record.

**What changed:** P1 required extracting `reviewTimeAnchor`, `reviewTimeWindowFilter`,
`detectedAtWindowFilter` and the TTR validity filter. Only the first two are extracted: once
Stack A is deleted the other two have **zero composers** (Stack B's response rate stays literal per
ADR 0019 D2 — P1 itself forbids touching it — and Stack B has no duration metric). The reversal is
now recorded explicitly in the plan header and the ADR 0019 addendum rather than left implicit.

**Verdict:** ACCEPT — the owner adjudicated this at intake; the defect was the missing written
adjudication, which is now written.

---

## D4 — plan review counted, phase record

Plan review rounds are counted in `.feature/state.json` (`planReviewRounds`), not in prose — a
resumed session continues the count rather than restarting at 1 (#628 lesson). Round 1 = full
eval-first review, rounds 2–3 verification-only, stop after 3.

---

## D5 — T3/T4 parallel dispatch shares ONE worktree, so `git add -A` is unsafe

**When:** Task 3 step 9 (commit), by the T3 implementer.

**What the plan assumed:** T3 and T4 are "eligible for parallel dispatch" because their *edited*
file sets are disjoint (`service.ts` vs `aggregate-queries.ts`). Both tasks' Step 9 then says
`git add -A`.

**What actually happened:** the two agents were dispatched into the **same** worktree
(`RepWorth-worktrees/feat-757-dashboard-review-time-anchor`), not one worktree each. Disjoint
*edited files* does not imply a disjoint *index*: at T3's commit point `aggregate-queries.ts` was
already dirty with the sibling's in-flight T4 edits, so `git add -A` would have swept a
possibly-half-finished Task 4 into the Task 3 commit under the Task 3 message — producing exactly
the entangled commit the disjoint-file-set design exists to prevent.

**What was done instead:** T3 staged only its own file
(`git add src/lib/dashboard/service.ts`) plus this deviations entry. Commit message verbatim per
Step 9; the change set is otherwise identical to the plan's.

**Lesson for future plans:** when a task graph marks two tasks as parallel-eligible, the commit
step must stage the task's declared **Files:** list explicitly, never `git add -A` — or the
dispatcher must give each parallel task its own worktree. `git add -A` is only safe for a task
that owns the tree.

**Verdict:** ACCEPT — narrower staging, same content, no plan surface changed.

---

## D6 — `pnpm ci:tenant-scope` is repo-wide, so T4 cannot use it as task-scoped verification

**When:** Task 4 step 6 (verify), by the T4 implementer.

**What the plan assumed:** T4 Step 6 prescribes `pnpm ci:tenant-scope` as one of T4's own
verification commands, with the rationale "the alias rename is the one edit that could disturb it —
prove it, don't assume it". That framing treats the audit as if it reported on T4's change.

**What actually happened:** the audit is repo-wide (`SCANNED_ROOTS = ['src', 'worker']`, no path
filter, no CLI argument). Run from the shared worktree it reported **four findings, all in
`src/lib/dashboard/service.ts`** — T3's surface, not T4's:

```
src/lib/dashboard/service.ts: reviews: unused tenant scope allowlist entry  (×2)
src/lib/dashboard/service.ts: reviews: missing account_id or business_id scope  (×2)
```

A naive reading of that red run would have sent T4 to edit `service.ts`, the one file its own task
statement forbids it to touch.

**What was done instead:** the T4 implementer isolated the signal rather than trusting or ignoring
the repo-wide verdict — `git archive <ref> src worker` into a scratchpad tree, overlay only
`aggregate-queries.ts`, run the audit script from that cwd:

- pre-T3 `HEAD` (`e9bf0389`) + T4's change only → **passed**, 408/408. The `rv`/`rev` → `r` rename
  is structurally invisible to `tableAliases`, exactly as the plan predicted.
- post-T3 `HEAD` (`ad3e4711`) with **no** T4 change → **the same four findings**. They are
  pre-existing relative to T4.

T4's delta therefore adds zero tenant-scope findings, and T4 left `service.ts` alone. The four
findings are reported upward as belonging to T3's landed commit; T3's Step 8 verification list is
vitest-only, which is why they were not caught there.

**Lesson for future plans:** a repo-wide CI audit prescribed as one task's verification is a
**gate-level** check, not a task-level one — in a shared worktree it reports on siblings' landed
work too. Either state the isolation procedure in the step (archive the base ref, overlay the
task's declared **Files:**, run from that cwd), or move the audit to the verify gate where the whole
tree is the subject. Never let a task "fix" a repo-wide finding that lands outside its surface.

**Verdict:** ACCEPT — no plan surface changed; the step's intent (prove the rename is invisible)
was met by isolating the run rather than by reading the repo-wide exit code.
