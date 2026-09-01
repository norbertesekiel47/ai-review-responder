# feat/1014-restraint-tab — handoff

A resumed session bootstraps from THIS file, then the paths it names. It never
needs the prior transcript. Nothing below is restated from another file; every
row is a pointer.

**Resume with:** `/feature-resume feat/1014-restraint-tab`

---

## Where the run is

| Fact | Value |
|---|---|
| Worktree | `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1014-restraint-tab` |
| Branch | `feat/1014-restraint-tab` |
| Fork point | `23facb7bf2371023e748a4918599299149c23b2f` (= `origin/main`, 0 behind at plan time) |
| HEAD at this handoff | `d0a74924` |
| Classification | `size=standard · risk=high · surface=ui` |
| Phase | **`plan_approved` — step 3 COMPLETE, step 4 is next** |
| Ladder | `.feature/progress.json` — 8 tracers registered, 0 done |
| Amendments used | 1 of 2 |
| Plan review rounds | **3 of 3 — spent. There is no round 4.** |
| Intake shape | 56 tests · 15 invariants · 19 edge cases · 21 surface entries |

## ⚠ THE RUN IS PARKED — re-arm before the first edit

`.feature/intake.json` was renamed to `.feature/intake.parked.json` so the
session could hand back with a red gate. **The edit-surface guard is therefore
DISARMED.** Re-arm before touching anything:

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1014-restraint-tab
mv .feature/intake.parked.json .feature/intake.json
bash scripts/arm-check.sh     # must print ARMED — if it does not, STOP
```

Do NOT re-run `scripts/feature-setup.sh` to re-arm: it re-initialises the ladder
and would discard the 8 registered tracers and the amendment counter.
`/feature-resume feat/1014-restraint-tab` handles this correctly; the manual
rename above is the equivalent.

**The gate is RED on `ci:feature-surface` alone, and that is correct** — 14
surface entries name files the tracers have not created yet. It cannot go green
before step 4. Do not chase it and do not narrow the surface to silence it.

### Plan round 1 — `REVISE`, 9 findings, all verified, all accepted

Full table with per-finding evidence: the plan's **Review appendix — plan
round 1**. Two outcomes a resumed session must not re-litigate:

- **Finding 4 was a design error, not a missing test** (deviations **D4**). The
  first plan keyed link authority on the **Refusal category**, which does not
  carry the lane. Two lanes share `unsafe_content` and both carry a response
  subject. Links now come from a server-resolved `linkKind`; `CATEGORY_COPY` has
  no `link` column so the mistake is not re-expressible.
- **Finding 5 fixes a pre-existing shared-module bug** (deviations **D5**).
  `DashboardStatePanel.tsx:61` gated `showError` on `hasData`. The fix reaches
  `/dashboard/analytics` and `/dashboard/reviews`; `blast-radius.sh` must list
  both and step 7 must look at both.

### Plan round 2 — `REVISE`, 8 of 9 closed, 1 rejected

Full table: the plan's **Review appendix — plan round 2**. Three of the four
open items were defects that MY ROUND-1 FIXES INTRODUCED — Task 2's module did
not typecheck, because the code block declared `RefusalLogEntry` a second time
and the `linkKind` edit reached only the shared-contract copy. That pattern is
the reason the round exists, and it is why round 3 was dispatched rather than
self-verified.

**One finding was REJECTED, and it is the only rejection across all rounds.**
Round 2 claimed the new `occurred_at <= windowEnd` bound re-triggers the #520
microsecond trap. It does not: `.claude/CLAUDE.md:210` scopes that trap to a row
compared against a window derived FROM that row, and both bounds come from one
`Date.now()`. The full argument is in the plan under Task 2, "Note on BOTH
bounds" — **read it before re-raising this**, and note the constructive half WAS
taken (the fixture seeds `+ interval '419 microseconds'`).

### Plan round 3 — `REVISE` on one word; resolved. **Plan APPROVED.**

Full table: the plan's **Review appendix — plan round 3**. Every substantive item
CLOSED, and the reviewer ran a virtual TypeScript compilation of the Task 2 and
Task 5 blocks that PASSED — so the typecheck failure round 2 found is genuinely
gone. The sole blocker was Task 7 step 3 reading "Write the 5 tests" against its
own turns-green line of 6. Fixed.

**The rejection of round-2 finding 1 HOLDS and the reviewer agreed.** Do not
re-raise the `occurred_at <= windowEnd` / #520 question; it is settled by both
sides, and the argument is in the plan under Task 2, "Note on BOTH bounds".

Outputs: `.feature/plan-review-r{1,2,3}.md`, prompts
`.feature/plan-review-r{2,3}-prompt.md`, round-1 brief
`.feature/plan-review-brief.md`. All gitignored — they do not survive a worktree
removal, which is why every conclusion that matters was copied into the plan's
review appendices and committed.

**Authoritative state lives on disk, never in a summary.** Re-read
`.feature/state.json`, `.feature/progress.json` and `.feature/gate-status.json`
rather than trusting any prose — including this table if it disagrees with them.

---

## The files that own this run

| What | Path |
|---|---|
| Intake (LOCKED, signed off 2026-09-01) | `docs/superpowers/plans/feat-1014-restraint-tab-intake.json` |
| Plan (8 tracers) | `docs/superpowers/plans/2026-09-01-1014-restraint-tab.md` |
| Deviations (D1–D3, all open) | `docs/superpowers/plans/feat-1014-restraint-tab-deviations.md` |
| Ticket | `gh issue view 1014` — and its ONE comment, which corrects the body |
| Parent map | `gh issue view 994` |
| Carry-forward findings (8) | `gh issue view 1000 --comments` — first comment, the triage table |
| Glossary (LOCKED) | `CONTEXT.md:155-165` — **Refusal**, **Refusal source**, **Refusal category**, **Restraint tab** |
| Schema contract | `supabase/migrations/116_refusal_events.sql` — the column comments ARE the read's contract |
| Redaction rule | `docs/adr/0023-refusal-log-owner-safe-projection.md` |
| Harvest source | branch `feat/refusal-log` @ `4e0d8086` — read via `git show feat/refusal-log:<path>` |

---

## Two owner decisions this run is built on

Both were taken at step 1 and are NOT reopenable without a new sign-off.
Their reasoning is in the intake and in `CONTEXT.md`; only the outcome is here.

1. **Coverage start = flag-driven disclosure.** One account-wide value, plus a
   line naming `policy_gate_held` as not-yet-recording while
   `AUTO_APPROVAL_ENABLED` is off. No activation marker is added. The <=90-day
   period after the eventual flip is a declared non-goal and needs its own
   ticket at step 8.
2. **The empty window is window-scoped and makes no absolute claim.** The parked
   branch's `RestraintReport.tsx:146` sentence stays retired permanently (#1000).

---

## The Codex plan-review session — RESUME IT, do not start cold

| Round | Session id | Brief |
|---|---|---|
| 1 (plan skeptic) | `01a05eee-b142-7410-a022-6e3dca104ea7` | `.feature/plan-review-brief.md` (115 KB, self-contained) |

Round 1 output lands in `.feature/plan-review-r1.md`.

**A verification round resumes that id and never starts fresh.** `resume` takes
`[SESSION_ID] [PROMPT]` and inherits the resumed session's sandbox and cwd — it
REJECTS `--sandbox` and `-C`, which is how the first round-2 attempt failed. Put
the prompt on stdin:

```bash
cat .feature/plan-review-r2-prompt.md \
  | codex exec resume 01a05eee-b142-7410-a022-6e3dca104ea7 - > .feature/plan-review-r2.md 2>&1
```

Ask first whether a round is owed at all:

```bash
bash scripts/feature-state.sh contract-changed docs/superpowers/plans/2026-09-01-1014-restraint-tab.md
```

`UNCHANGED` means self-verify and record the skip. Resume ONLY for verification
— never for round 1 and never for an independent axis.

---

## Known state a resumed session must not misread

**The baseline gate is RED on exactly one row, and that is correct.**
`ci:feature-surface` reports 14 `allowed_edit_surface` entries matching no file.
All 14 are files the tracers create; T1 alone creates 6. Zero typos — every path
cross-checks against the plan's file table, and all 5 pre-existing entries
matched. It cannot go green before step 4 and it is not a defect to chase. The
audit's own message names the case (#867). A WIP push before implementation
needs `git push --no-verify`.

**The `feat/refusal-log` surface overlap is not a live collision.** That
worktree is a STOPPED run left armed (its `.feature/intake.json` survived the
stop). The branch never merges; it is this run's read-only harvest source.
Nothing is written into it — see deviations D1 for why, including why its
deviations file is deliberately left untouched.

**The parent checkout is dirty with unrelated work** (marketing docs, a roadmap
doc, a PITR runbook, four untracked paths). None of it belongs to this run. Do
not absorb or discard it.

---

## Next actions, in order

Steps 0–3 are DONE. Start here.

1. **Re-arm** (see the parked-run box above). `arm-check.sh` must print ARMED.
2. **Step 4 — T1 ALONE.** It authors all 56 promised titles as failing tests.
   It runs alone deliberately: its completion is the enforcement spot check.
3. **After T1, diff `git status --porcelain` against `allowed_edit_surface`.**
   An out-of-surface path means the guard did not bind — STOP and report. Do not
   dispatch further tracers.
4. Only then may **T2 and T6 dispatch in parallel** — they are the one mutually
   independent pair (disjoint files, no shared edge). Every other tracer is
   serial: T3 and T4 follow T2 in the same file, T5 needs T2, T8 precedes T7.
5. **Step 5 gate.** `bash scripts/verify-gate.sh` — full, never `--fast`, at
   every boundary. The subagent barrier applies: no gate while a tracer subagent
   is in flight, and any HEAD move VOIDS the previous result.
6. **Step 6 deviations read-back.** D1–D5 each need a resolved `Verdict: ACCEPT`
   or the `reviewed` transition refuses. **D4 and D5 are the two that matter** —
   D4 is a design error round 1 caught, D5 changes two surfaces outside this
   ticket.
7. **Step 7 — take main BEFORE the wave, then freeze the fork.** One message,
   parallel: spec/correctness, `/thermo-nuclear-code-quality-review`,
   `/codex:adversarial-review --background`, and the red-team pass (RISK=high).
   `blast-radius.sh` must list `AnalyticsContent.tsx` and `ReviewsContent.tsx`
   because of D5.
8. **Step 7.5** owns the `reviewed` transition. **Step 8** ships.

## Step 8 needs the owner — two items

1. **Staging must be realigned BEFORE the ride, not before the start.**
   `origin/staging` is `5358bd82`, diverged from `main` at `914a797a` (8 ahead,
   25 behind). `git merge --ff-only main` aborts after a squash merge. The
   runbook's answer is a hard reset plus `--force-with-lease`. **Ask the owner
   for the exact command.** A ride against the diverged tip proves nothing.
2. **No migration to promote.** 116 is already on both Supabase projects.
