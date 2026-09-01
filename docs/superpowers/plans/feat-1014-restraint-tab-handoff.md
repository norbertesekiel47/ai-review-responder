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
| HEAD at this handoff | `029cbd08` (round-1 fixes) |
| Classification | `size=standard · risk=high · surface=ui` |
| Phase | `worktree_ready` → step 3 (round 2 verification in flight) |
| Ladder | `.feature/progress.json` — 8 tracers registered, 0 done |
| Amendments used | 1 of 2 |
| Plan review rounds | **2 of 3** |
| Intake shape | 56 tests · 15 invariants · 19 edge cases · 21 surface entries |

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

Round 2 is verification-only: it checks whether its OWN nine findings closed and
whether a fix regressed anything. It may not open new fronts. Its output lands
in `.feature/plan-review-r2.md`; the prompt is `.feature/plan-review-r2-prompt.md`.

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

1. Read `.feature/plan-review-r1.md`. Triage its findings table; fix what is
   real, reject the rest with stated reasoning recorded in the plan's review
   appendix.
2. On `VERDICT: APPROVED` (or after the owner's call at round 3):
   `bash scripts/feature-state.sh set-phase plan_approved` and
   `node .agents/skills/feature/scripts/progress.mjs step plan done`.
3. Step 4 — T1 ALONE first. After it completes, diff `git status --porcelain`
   against `allowed_edit_surface`; an out-of-surface path means enforcement did
   not bind, and the run STOPS there. Only then may T2 and T6 dispatch in
   parallel; every other tracer is serial.
4. Step 5 gate, step 6 deviations read-back (D1–D3 each need a `Verdict:`),
   step 7 the ONE-message review wave with the red-team pass.

## Step 8 needs the owner — two items

1. **Staging must be realigned BEFORE the ride, not before the start.**
   `origin/staging` is `5358bd82`, diverged from `main` at `914a797a` (8 ahead,
   25 behind). `git merge --ff-only main` aborts after a squash merge. The
   runbook's answer is a hard reset plus `--force-with-lease`. **Ask the owner
   for the exact command.** A ride against the diverged tip proves nothing.
2. **No migration to promote.** 116 is already on both Supabase projects.
