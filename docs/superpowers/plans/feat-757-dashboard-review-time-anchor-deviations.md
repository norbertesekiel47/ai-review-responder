# #757 — deviations from the locked intake

Entries are things the intake/plan did not anticipate. Each gets a one-line
ACCEPT / RE-PLAN verdict at step 6 (deviations read-back) before review.

## Step 6 read-back — completed 2026-08-11, before review dispatch

All nine entries read end to end. **Verdict: 9 ACCEPT, 0 RE-PLAN.** No entry
invalidates a locked intake decision, so the abort criteria are not triggered.
D4 is a process note rather than a deviation; recorded ACCEPT for completeness.

> **Superseded after the first full gate run:** D10 consumed the second
> amendment. Budget is now **2 of 2** — any further surface change triggers the
> abort criteria. The paragraph below reflects the state at step 6 read-back.

**Amendment budget: 1 of 2 used** — only D1 amended `allowed_edit_surface`
(`scripts/ci/tenant-scope-allowlist.ts`). D7 and D8 also edit that file but
consume no further budget: it was already in surface. D2's five added
`tests_to_add` titles are owner-approved deviations, not amendments, per step 5's
rule.

**The two entries a reviewer should read first**, because they are defects the
plan actively caused rather than merely failed to foresee:

- **D7** — re-anchoring a query silently invalidated its *text-keyed*
  tenant-scope allowlist snippet, breaking `ci:tenant-scope` on a commit whose
  own verification step was vitest-only. The class is general and is the single
  most transferable lesson on this branch.
- **D5** — two "parallel-eligible" tasks were dispatched into ONE worktree, so
  disjoint *edited files* did not imply a disjoint *index*, and the plan's
  prescribed `git add -A` would have entangled the commits.

**D8 and D9 are the same defect twice**: the plan prescribed literal comment and
prose text containing the very token its own `CLEAN` grep searched for, so
following the plan verbatim made its own proof fail. Worth promoting at step 8 —
a proof command and the text it greps must be authored against each other.

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

---

## D7 — re-anchoring a query invalidates its text-keyed tenant-scope allowlist snippet

**When:** verify gate, resolving the four `src/lib/dashboard/service.ts` findings D6 handed upward.

**What the plan assumed:** Task 5 treated the tenant-scope allowlist as a **deletion**-only concern —
remove the seven `src/lib/kpi/service.ts` entries alongside Stack A (D1, amendment #1). The plan
carried no notion that *editing* allowlisted SQL could also break the audit, so nothing anticipated
that re-anchoring would invalidate the snippets of the two `dashboard/service.ts` `reviews` entries.

**What actually happened:** `tenantScopeAllowlist` entries are keyed on their **raw SQL snippet
text** — `getAllowlistEntry` matches via
`normalizeSql(stripSqlComments(sqlText)) === normalizeSql(stripSqlComments(entry.sqlSnippet))`. Both
entries exist because their `business_id = ${businessId}` scope sits inside a `LEFT JOIN (...)`
subquery, and `stripSelectSubqueries` removes it before predicate analysis, so each query reads as
unscoped. `ad3e4711` replaced `detected_at` with `${reviewTimeAnchor(sql, '')}` in three places per
query; the text no longer matched, so each entry went **unused** *and* its query went **unscoped** —
one edit, two findings each, four total. The queries were correctly tenant-scoped throughout. This is
the allowlist working as designed: any SQL edit forces a re-review.

**What was done:** refreshed the `sqlSnippet` of exactly those two entries (velocity ~line 1679,
sentiment trend ~line 606) to the current source text, deriving it mechanically rather than by
transcription — a scratchpad script imported the audit's own exported `extractSqlTemplates` and
printed the normalized text of both queries, which was pasted verbatim. Each `reason` was extended to
note the bucketing column is now the Review-time anchor `LEAST(review_date, detected_at)` (ADR 0019 /
#757) while the tenant scope is unchanged; the velocity entry's reason, previously generic, now also
states the LEFT-JOIN-stripping rationale. `category: 'tenant-root-lookup'` kept on both. No entry
added or removed, `ALLOWLIST_BASELINE` untouched, `tenant-scope-audit.ts` untouched, and
`service.ts` **not** edited — the allowlist follows the code, never the reverse. Result:
`tenant-scope-audit: passed — entries: 408 (baseline: 408)`, diff = 4 changed lines in one file.

**Lesson for future plans:** in this repo, editing the SQL of any query that carries a tenant-scope
allowlist entry **silently breaks `ci:tenant-scope`**, because entries are keyed on normalized raw
SQL text — the failure surfaces as the confusing pair "unused allowlist entry" + "missing
account_id or business_id scope" for the same file/table. Any plan that touches allowlisted SQL must
include an explicit **allowlist-snippet refresh** step, and should derive the new snippet from the
audit's own extractor rather than hand-transcribing it. Worth a grep of
`tenant-scope-allowlist.ts` for every file in `allowed_edit_surface` at planning time.

**Verdict:** ACCEPT — no new surface. `tenant-scope-allowlist.ts` was already added to
`allowed_edit_surface` as amendment #1 (D1); this is a snippet refresh within that surface, not a new
entry, so the amendment count is unchanged.

---

## D8 — Task 5's own `CLEAN` proof collides with two comments that name the deleted path

**When:** Task 5, step 5 (prove nothing references the deleted surface).

**What the plan assumed:** that after the deletions, `rg "kpi/service|…" src worker scripts e2e`
prints `CLEAN`. Two *comments* — neither of them code — defeat that grep:

1. `src/lib/kpi/fragments.ts:4` opened with "Extracted from kpi/service.ts so the RENDERED
   dashboard stack …". Task 2 wrote that provenance line while Stack A was still alive; after
   Task 5 it is a comment pointing at a file that no longer exists.
2. The plan's **own** Step 2 text prescribes the baseline comment
   `// was 408 — seven kpi/service.ts entries removed with the file (#757)`, which contains the
   very string Step 5 then greps for. The plan contradicts itself here.

**What was done:** both comments were reworded to keep the history without spelling a dead path —
fragments.ts now says "Extracted from the consumer-less Stack A KPI service — which #757 then
deleted —", and the baseline comment says "seven Stack A KPI-service entries removed with the file
(#757)". Same facts, no live cross-reference. `src/lib/kpi/**` is inside the declared Task 5
surface, so no amendment was needed; the repo's own working rule ("when deleting … grep the
filename to clean every cross-reference in the same change") points the same way. Also added the
`408 → 401 (#757), a SHRINK` line to the `ALLOWLIST_BASELINE` changelog block, the file's existing
convention for every prior baseline move — it is the one place that block would otherwise go stale.

**Lesson for future plans:** a plan that prescribes both a literal comment string and a `rg` clean
sweep for that same string must reconcile them at planning time; and an extraction task (T2 here)
should write provenance in prose ("extracted from the Stack A service") rather than as a path when
a later task is scheduled to delete that path.

**Verdict:** ACCEPT — comment wording only, inside the declared surface, no behavior and no
allowlist entry changed. Both greps print `CLEAN`.

---

## D9 — Task 6 repeats D8's shape: Step 3's verbatim text defeats Step 5's own `CLEAN` grep

**When:** Task 6, step 5 (verify), by the T6 implementer.

**What the plan assumed:** that pasting Step 3's `.claude/CLAUDE.md` bullet verbatim and then running
Step 5's `rg -n "kpi/service|api/dashboard/kpis" docs/directory.md CONTEXT.md .claude/CLAUDE.md`
prints `CLEAN`.

**What actually happened:** Step 3's prescribed text ends `… + \`GET /api/dashboard/kpis\` were
deleted in #757.` — a tombstone naming the very route Step 5 greps for. Pasted verbatim, the grep
returns that line instead of `CLEAN`. This is exactly D8's failure mode (a plan prescribing a literal
string it later sweeps for), recurring one task later in the same plan.

**What was done instead:** the same resolution D8 chose — keep the fact, drop the live path. The
clause now reads "the consumer-less `getLocationKpiSummary`/`getAccountKpiSummary` and their
dedicated KPI route were deleted in #757." Nothing else in the bullet changed; the four/two
metric split, the fragment owner path and the `detected_at` list are verbatim per Step 3. The
ADR 0019 addendum was **not** reworded — `docs/adr/**` is deliberately outside the Step 5 grep set
(an ADR is a historical decision record, and naming what was deleted is its job), and the addendum
is verbatim per Step 1.

**Lesson for future plans:** D8's lesson was scoped to Task 5 and so did not prevent the identical
defect in Task 6. When a plan contains BOTH a prescribed literal string and a `rg` clean sweep, the
reconciliation must be done once across **every** task in the plan, not per task.

**Verdict:** ACCEPT — doc prose only, inside the declared surface, same facts, no plan surface
changed. The grep prints `CLEAN`.

---

## D10 — amendment #2: a second, non-fragment-aware `sql` mock asserts on dashboard SQL text

**When:** step 5, first full verify-gate run. The ONLY red row in an otherwise
23/24 green gate.

**What the plan assumed:** that the fragment-aware `createMockSql` harness
(`worker/__tests__/helpers/mock-sql.ts`) is how dashboard SQL text gets asserted, so
composing a fragment is invisible to existing tests as long as the shape suites are updated.

**What actually happened:** `src/app/api/dashboard/__tests__/route.test.ts` defines its **own**
inline `vi.mock('@/lib/db/server', …)` proxy. It renders every interpolation as `?` and returns a
nested fragment as an inert `{ fragmentText, values }` object rather than flattening it into the
parent text. So once the rating-breakdown query composed `reviewTimeWindowFilter`, its captured
text became `AND ?` and the pre-existing assertion
`expect(breakdownSql).toContain('make_interval(days => ?)')` (line 493) failed.

**Not a production defect.** The SQL is correct and proven three independent ways: the live-DB
suite (13/13 against real Postgres), the fragment-aware shape pins (exact anchor counts), and
`service.rating-breakdown.test.ts` — which asserts the *same string* and passes, because its
harness flattens fragments.

**Amendment:** added `src/app/api/dashboard/__tests__/route.test.ts` to `allowed_edit_surface` in
both intake copies. **This is amendment #2 of 2** — the abort criteria's trigger — so it was
surfaced to the owner as a stop-and-decide rather than applied unilaterally. Owner granted it,
choosing the minimal one-assertion fix over refactoring that file's mock.

**What was done:** the assertion now reads through the captured fragment object — one level down —
so BOTH halves of the #403 claim survive rather than being traded away: `make_interval(days => ?)`
is asserted against the fragment's own `fragmentText` (plus a negative check that no
`INTERVAL '<n> days'` literal appears), and `30` is asserted against its flattened bound values.
The net assertion is *stronger* than the original, which only checked the text.

**Lesson:** the repo has **two** SQL mocks with different fidelity. The shared `createMockSql`
harness flattens nested fragments; the bespoke proxy in the dashboard route test does not. Any
change that pushes SQL text down into a composed fragment is invisible to the first and breaking
to the second. Before composing a fragment into an existing query, grep for every test asserting on
that query's text, not just the ones using the shared harness.

**Verdict:** ACCEPT — owner-approved, one assertion, no production change, and the invariant it
guards is now better covered than before.
