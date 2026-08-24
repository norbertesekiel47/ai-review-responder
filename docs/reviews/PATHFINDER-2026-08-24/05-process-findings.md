# Process findings — Pathfinder 2026-08-24

About how the work is tracked and reviewed, not about the code.

---

## 1. The entropy counter is correct for the first time in five passes

Every prior pass found the counter wrong by its own rule: 2026-08-10 (3 missed
increments), 08-15 (PR #803 invisible), 08-18 (read 8, measured 11), 08-22 (the
log's own recurrence counter had the same defect as the thing it counted, and
four merges were missing).

**This pass measured the window independently and got the same answer the log
does.** 13 first-parent merges after `42a247b1`; 11 count; `b6f41dcf` (#948,
governance-only) and `6b7afa92` (#942, test-only) correctly excluded. The log's
derivation — 10 counted on 2026-08-23, plus #950 — agrees.

The reason is `ci:merge-ledger`, which landed **inside this window**
(`2f386c52`, PR #935). It fails a merging PR that rewrites the production or
governance surface and leaves no line in the log. #896's Part 1 was the fix for
exactly the blind spot the 08-18 and 08-22 passes named, and it worked on its
first full window.

**Record this as closed.** Four consecutive passes reported a broken counter;
the fifth reports a working one, with the mechanism named.

## 2. This pass published a wrong headline and corrected it before shipping

The re-verification subagent reported that issue #891 was closed with a **live
wire defect** on the approve path: the route would answer `closed: true` while
`send_closed_at` stayed NULL. The reasoning was sound and cited real lines, and
the orchestrator wrote it up as the pass's headline.

**It was wrong.** `no_send_parent` is unreachable from `approveBatch`, because
the function guards `send_parent_run_id === null` 130 lines earlier
(`approval.ts:305-308`), and that subquery (`:209-219`) uses the **identical**
predicate as `closeBatchIfSettled`'s parent lookup (`outreach.ts:430-439`).

**The mechanism that caught it:** the orchestrator re-derived the claim from
source before publishing, rather than relaying a well-cited subagent report. The
subagent had verified that the *code shape* was defective and asserted
reachability without checking the guard.

Two durable lessons:

- **A citation is not a verification.** Every line the subagent cited was real.
  The defect was in what it did *not* look for — an upstream guard that makes a
  reachable-looking branch dead.
- **"Is it reachable?" is a separate question from "is it wrong?"** and must be
  asked explicitly for any finding that will be ranked as a bug. This pass now
  asks it in the handoff prompts (H7 says plainly: *"do not describe it as a
  defect in the PR body"*).

The wrong reading is kept in `07-handoff-reverification.md` rather than deleted,
because the reasoning that produced it is the reasoning the next reader will
repeat.

## 3. Four of six seeds were wrong — which is the system working

| Seed | Outcome |
|---|---|
| 1 — notice family has four members | **WRONG.** Six. `autonomy-suspended-notice` is in CLAUDE.md's own worker list and was omitted; `worker/jobs/notification/` is the progenitor |
| 2 — solicitation size baseline | **WRONG** by 2 files / 28 lines at the measurement point that matters |
| 3 — four admin consolidations may conflict | **REFUTED.** Disjoint importer sets; they compose cleanly |
| 4 — one auto-approval runtime or two | **CONFIRMED.** Two, with four unprincipled divergences |
| 5 — `settings-guards.ts` cycle | **WRONG PATH AND WRONG FRAMING.** File is under `auto-approval/`, not `solicitation/`; the cycle never involved the Solicitation lane |
| 6 — migration lockstep | **CONFIRMED CLEAN.** All four indexes present in both databases |

The SCOPE.md instruction *"Do NOT trust these … refuting a seed is a result"*
did its job. A pass that confirmed every seed would be evidence the seeds were
written from the answers.

## 4. A spec parenthetical is not a tracker — six weeks and counting

`docs/superpowers/specs/2026-07-07-ws4-trust-dial-veto-window-design.md:258-262`
says pending-post-notice was cloned *"including the bounced-owner email skip from
day one (the WS3 parity fix — **known follow-up #3a** does not grow a third
instance)"*.

Two things are wrong with that sentence:

1. `auto-post-notice` has **no** bounced-owner skip to inherit. The claim is
   false, and it is the origin of BUG 1.
2. `grep -rn "#3a" docs/` returns **exactly that sentence and nothing else.** No
   ticket, no backlog row, no other reference anywhere in the repo.

So a real defect was identified on 2026-07-12, named with an identifier that
exists nowhere else, and left in a spec paragraph. **Six weeks later it is still
live, and two more notice members shipped past it.**

This is the same failure class the arch log's counter had — work that leaves no
trace outside the document that mentions it. `ci:merge-ledger` fixed it for
merges. Nothing fixes it for "known follow-up" prose. The cheapest countermeasure
is a rule: **a follow-up named in a spec gets an issue number in the same PR, or
it does not get named.**

## 5. Sequencing hazard: PR #951 is open and touches this pass's own file

`gh pr list` shows **#951 `docs(631): post-merge documentation sweep` still
OPEN**, and its file list includes `.claude/reference/arch-review-log.md` — the
file this pass must edit to reset the counter. It bumps the counter 10 → 11.

Its checks are green where they matter (`changes` and `lint` pass; the heavy jobs
correctly short-circuit for a docs-only PR).

**Order matters:** #951 merges first, then this pass's artifacts PR resets to 0.
Reversing it produces a conflict on the same lines, or silently drops the
increment.

## 6. Prior-pass handoffs: five of nine closed, three untouched across two windows

The 08-22 pass's three next-session PRs all landed (#932, #933, #934/#935) —
that is a fast, complete turnaround and worth noting positively.

The 08-18 pass's #892, #894 and #895 have now survived **two** consecutive
windows untouched. They are re-verified as still live and unchanged, not stale.
They are carried forward again as H7. **If they survive a third window, the right
response is to close them as won't-fix rather than re-verify them a fourth
time** — a backlog item that is re-derived every pass and never actioned is
costing more to track than to fix or drop.
