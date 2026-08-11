# Architecture pass 2026-08-10 — process findings (adjudicated)

The counter file assigned this pass a process agenda alongside the code review.
Everything here was already evidenced in `.claude/reference/arch-review-log.md`
by the per-merge sweeps; this document **adjudicates** each item — no rediscovery.
Verdicts: **CLOSED** (already fixed), **FIX** (handoff in `04-handoff-prompts.md`),
**PROTOCOL** (workflow-doc change), **DEFER** (accepted open, with reason).

## Headline

Across ~24 merges: fallow health **77 B → 77 B**, maintainability **92.2 → 92.2**,
duplication **1.7% → 1.3%**, churn hotspots **0 → 0**. The codebase held its shape.
The entropy of this window accumulated in the **workflow layer**: three missed
counter increments, six staging-reconcile incidents, three fallow-surprise PRs,
two phase-rewind incidents, one shipped-wrong-CHECK migration (100→101) caused by
an amendment protocol gap. The code discipline (intake surfaces, eval-first,
adversarial review) is working; the meta-process that keeps *itself* honest is
the weak layer.

## 1. Counter reconciliation (assigned agenda item 1)

- **PR #712 (#678 Reviews list + on-demand generation) COUNTS.** 71 files, ~9.3k
  insertions, a new API route, cost-tracker and publisher changes — plainly
  architectural surface. It never counted because its post-merge sweep, **PR #713,
  was never merged** (still open 2026-08-10, two days stale).
- **PR #716 (#680, migration 103) COUNTS as a merge, weighted entropy-negative**
  (assigned agenda item 2). Verified at drop time: the four columns had zero
  production readers/writers — the worker wrote only the collapsed counters since
  #675, and the only remaining references were migration-shape suites. Class:
  **dead-column cleanup**, not a live-contract reshape. Its real significance is
  risk-posture, not architecture: it is the epic's declared point of no return
  (ADR 0015 §4 revert-only backout no longer suffices past it).
- **Reconciled figure: 24 merges since the 2026-07-27 pass (4.8×).** Counter
  resets to 0 with this pass's log row.
- **PR #713 disposition (FIX, owner action):** it holds the only copy of #678's
  build record for `progresstracking.md`/`lab-notes.md`, plus an
  `arch-review-log.md` hunk this pass supersedes. Rebase it, **drop the
  arch-review-log hunk**, merge the rest. Closing it unmerged loses #678's
  documentation trail.

## 2. Staging-reconcile trap — **CLOSED** (six occurrences, fixed before this pass)

`feature.md` step 8 (now lines 552–557) and CLAUDE.md §Environments both document
the truth: after a squash merge, `--ff-only` deterministically fails;
the procedure is `deployment-guide.md` §"Re-sync staging" (`reset --hard
origin/main` + `--force-with-lease`), sync merges forbidden. Verified today by
inspection. Nothing to hand off; recorded so the next pass doesn't re-litigate.

## 3. Sweep-miss — the entropy signal has no mechanical guard — **FIX**

Three instances (#712, #716, #746): the post-merge sweep is the only thing
keeping the counter honest, and it is the one step with no check.
Two-part fix, deliberately cheap:
1. `document-feature`'s verification table gains a **mandatory
   `arch-review-log.md` row** — the skill already enforces table completeness,
   so the miss becomes visible at the moment it happens.
2. The `/feature` step-8 checklist names the counter increment explicitly
   instead of bundling it under "sweep docs".
Rejected: a `gh`-querying CI audit reconciling merged `feat(#N)` PRs against log
entries — heavier than the defect, and the checklist row closes the observed
failure mode.

## 4. Phase ownership — the gate rewinds `reviewed` → `gate_green` — **FIX**

Confirmed live: `scripts/verify-gate.sh:414` runs `set-phase gate_green`
unconditionally, so a post-review gate re-run rewinds the phase and a resumed
session re-enters step 7 (hit twice in the #677 ship). Verdict from the log's
three options: **the gate records `lastGreenGateSha` and never writes `phase`.**
A measurement must not move workflow state; phase transitions belong to the
workflow steps alone. (The gate-freshness check the Stop hook needs is exactly
the SHA + timestamp, so nothing is lost.)

## 5. fallow preflight — three post-open surprises — **FIX**

#659, #689, #691 each went green locally and failed CI's fallow job, costing a
fix commit + gate re-run + (high lane) a staging re-ride. Lab-notes prescription
has failed twice as prose. Measured today: `pnpm ci:fallow` (diff-scoped,
new-only vs origin/main) runs in **0.6s** — there is no cost argument. Verdict:
**step 8's preflight RUNS it** before opening the PR; `verify-gate.sh` keeps
excluding `ci:fallow*` (that exclusion is correct — different baseline,
different gate), but the ship lane must not reach `gh pr create` without it.

## 6. Text-scan audits voidable by legal refactors — **FIX (one ticket)**

Proven instance: extracting three admin routes' shared preamble into
`withAal2JsonBody` typechecked, passed tests, and turned `ci:admin-aal2` RED on
genuinely-gated routes — the audit is a text scan for `requireAdminWithAal2`.
Same class, unproven but structural: `ci:static-policy`, `ci:tenant-scope`,
`ci:outbox-seam`. None has a self-test proving it still fires after its target
is wrapped, aliased, or re-exported. Verdict: **audit self-tests** — one fixture
per audit that wraps/aliases the guarded pattern and asserts the audit still
detects (or loudly rejects) it. This also answers the last pass's open question
of whether #590's meta-audit closed the "checks that appear to run but exercise
nothing" class: it did not — this is that class, one layer up.

## 7. `ci:live-db-suites` evidence-completeness — **FIX (one ticket, three parts)**

(a) require an `assertSchemaReady` call in every live-DB suite (the convention
is real — 32 callers — but unenforced, and `describeWithDb` gates only on env);
(b) print the inspected-file count on success (a passing run currently cannot
evidence what it inspected); (c) fail on untracked `*.integration.test.ts`
(enumeration via `git ls-files` silently skips new suites). All three are the
#590 class inside the check that was added to close the #590 class.

## 8. Intake amendment channel — the #673/#670 race — **PROTOCOL**

A locked intake has no delivery channel for post-lock amendments: #670's enum
amendment lived only as a ticket comment, three plan reviews and two branch
reviews validated against the intake (by design), and migration 100 shipped the
stale four-valued CHECK — corrected same-day by 101. Verdict: **an amendment to
a locked intake is a PR against the running feature's intake copies** (both the
committed audit copy and `.feature/intake.json`), opened by the *amending*
session; a comment is notification, never delivery. Receiving side re-reads the
intake at plan sign-off and at the step-8 preflight. One paragraph in
`feature.md` step 1/2.

## 9. Smaller items

- **`feature-cleanup.sh` cwd bug — FIX (small):** derive `MAIN_ROOT` from
  `git worktree list` head, not `rev-parse --show-toplevel`; run from a feature
  worktree it currently skips that worktree and exits 0.
- **Raw-request-line blind spots — FIX (test ticket):** `app.inject()`
  normalises targets, so signature verification, path-prefix auth, and the
  unsubscribe exemption resolution have no test against absolute-form request
  targets; #644's real-socket test covers only the limiter. One sweep ticket.
- **Plan-embedded code is invisible to every tool — DEFER:** the identifier-grep
  idea remains attractive but plans churn; eval-first (tests as executable spec)
  already caught the practical instances. Revisit if a plan-sourced defect ships
  again.
- **`migration-immutability-guard` false positives on local-only amendments —
  DEFER:** annoying, not dangerous (false positive, never false negative);
  per-entry applied marker recorded as the candidate fix.
- **Closed by prior work, recorded to stop re-raising:** gate DB provisioning
  now serial and owned by the gate; `reclassify` now buckets prod/test
  separately and excludes workflow artifacts; #590–#593, #581, #582, #587 all
  closed and verified closed on the tracker.
