# feat/1014-restraint-tab — handoff

A resumed session bootstraps from THIS file, then the paths it names. It never
needs the prior transcript. Every row is a pointer, not a restatement.

**Resume with:** `/feature-resume feat/1014-restraint-tab`

---

## Where the run is

| Fact | Value |
|---|---|
| Worktree | `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1014-restraint-tab` |
| Branch | `feat/1014-restraint-tab` |
| Fork point | `b55b0782`; `origin/main` merged at `8cfc03ae` — **0 behind** |
| Classification | `size=standard · risk=high · surface=ui` |
| Phase | **`gate_green`** — steps 0–7.5 DONE. See the warning below on why it is not `reviewed`. |
| Gate | **GREEN** at the merged HEAD, 33 rows, zero failures |
| Red team | **`CLEAR`** — 10 passes, 53 findings, 51 fixed, 2 rejected, **0 open** |
| Amendments | **2 of 2 — SPENT.** A third needs new owner sign-off; the tooling refuses without one. |
| Plan review rounds | 3 of 3 — spent |
| Tracers | 8 of 8 done |
| Next external action | **open the PR to `main`** (owner approved 2026-09-02; staging ride skipped, see D9) |

## ⚠ READ THIS BEFORE TRUSTING THE PHASE

`red-team-status.mjs` FAILS at HEAD with one issue: *"the tree moved since
`6b90d6b9` outside this run's own two artifacts"*. That is correct, expected, and
**not** a sign the pass is incomplete.

The tenth pass returned `CLEAR` at `6b90d6b9`. The report was committed at
`98cdbf7c`. The branch then merged `origin/main`. The staleness rule fires on any
commit, and a merge is one.

`git diff --name-only 98cdbf7c HEAD` lists 38 files and **none is owned by this
branch** — no `refusals`, no `restraint`, no `dashboard/analytics` path. The merge
changed nothing the red-team pass measured.

The phase was deliberately left at `gate_green` rather than stamped `reviewed`
over a failing checker. Full reasoning: **deviations D10**. If you need a green
checker at the merged HEAD, re-run the pass — do not hand-edit the sidecar.

---

## The files that own this run

| What | Path |
|---|---|
| Intake (LOCKED; amended twice) | `docs/superpowers/plans/feat-1014-restraint-tab-intake.json` |
| Plan (8 tracers; its ship order is superseded by D9) | `docs/superpowers/plans/2026-09-01-1014-restraint-tab.md` |
| Deviations **D1–D10, all ACCEPT** | `docs/superpowers/plans/feat-1014-restraint-tab-deviations.md` |
| Review wave reports (5 axes) | `docs/reviews/feat-1014-restraint-tab/` |
| **Red-team record — read this one** | `docs/reviews/red-team/feat-1014-restraint-tab-e8a3c4/findings.md` |
| Glossary (LOCKED) | `CONTEXT.md` § Refusal ledger — including **Coverage start**, coined by this run |
| Ticket | `gh issue view 1014` — and its ONE comment, which corrects the body |

---

## What the red-team record says, in three lines

Ten passes, not the skill's two — passes 3–10 ran under an explicit owner
override of the cap, recorded in the report rather than hidden.

Round 2 found seven real defects in shipped code. **Every round after it found
defects in the previous round's own fixes**, and the open-P0 count fell
7 → 4 → 3 → 0 and stayed at zero for six passes.

Two failure modes recurred and are both named in the report: a test that asserts
a *different statement* than the one it claims, and a narrower assertion
presented as a superset of what it replaced. The report also records **four false
claims made in this branch's own commit messages**.

## What remains

1. **Open the PR** — `gh pr create --draft`, then `gh pr ready`. Draft PRs run no
   CI on this repo; `changes` and `lint` gate on `draft == false`.
2. **The PR body owes a "Red-team findings rejected" section.** Both entries are
   written and ready to paste from `findings.md` § "Red-team findings rejected":
   **F12** (contradicted by `docs/directory.md:16-17`) and **F31** (true, deferred —
   disclosing `ARCHIVAL_EVENT_LIMIT` truncation needs a DTO field and a new
   owner-facing sentence, and both surface amendments are spent).
3. **PAUSE for explicit merge approval.** Do not merge on a general go-ahead.
4. **After merge, open two follow-up tickets:** the post-flip ≤90-day **Coverage
   start** window (an intake non-goal), and F31's truncation disclosure.
5. **No migration to promote.** 116 is already on both Supabase projects.
6. **No staging ride** — owner decision 2026-09-02, reasoning in D9.

**Authoritative state lives on disk, never in a summary.** Re-read
`.feature/state.json`, `.feature/progress.json` and `.feature/gate-status.json`
rather than trusting any prose — including this table if it disagrees with them.
