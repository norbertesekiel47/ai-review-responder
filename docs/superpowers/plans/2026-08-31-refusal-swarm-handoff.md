# Handoff — the Refusal ledger swarm (#1010, #1011, #1012)

**Written 2026-08-31.** The originating session is bloated and stops here. This
document plus the on-disk artifacts are sufficient; **do not go looking for the
prior transcript.**

## One-line status

Three RISK=high branches are at **phase `reviewed`**, rebased onto `main` at
`cfddfad4`, clean, and GREEN with current fingerprints. None is pushed, none has
a PR, none has ridden staging, none is merged.

**The next action is push + draft PR** (step 4), and it is owner-gated.

> **CORRECTION, 2026-08-31 — the sentence this section used to carry was FALSE.**
> It said the `reviewed` transition was the next action and would just run. It
> would not: `red-team-status.mjs` refused **all three** branches. #1010 had an
> `accepted-risk` finding with an empty `authorizations` array, plus a stale
> `intake_sha256` and a stale `head_sha` (both left behind by the P1-B revert);
> #1011 was `OPEN_P1` with all three findings still `open` and every reason
> `null`, although the fix for its P1 was already at HEAD; #1012's `head_sha`
> was pinned one commit before its own round-2 fix. Step 4 of the red-team
> ordering rule — *re-run the gate after the report commit* — was skipped on all
> three, so no run ever re-derived the sidecars. All are now closed, recorded in
> per-branch closure sections in each `findings.md`.

## The three branches

| Ticket | Branch / worktree (`…/RepWorth-worktrees/<dir>`) | HEAD | Gate | Test DB |
|---|---|---|---|---|
| #1010 | `feat/1010-refusal-solicitation-singles` | `d65e3ac8` | 33/33 | `test_1010` |
| #1011 | `feat/1011-refusal-outreach-render` | `9b1b077d` | 29/29 | `test_1011` |
| #1012 | `feat/1012-refusal-auto-post-revoked` | `902f5516` | 29/29 | `test_1012` |

The SHAs above are POST-rebase onto `cfddfad4`. Every SHA named in the
per-branch reports predates that rebase and no longer resolves; each report
carries a § Rebase note with the mapping.

**All three are rebased onto `main` at `cfddfad4`, at phase `reviewed`, with
GREEN gates, current fingerprints and clean trees** — 33 / 29 / 29 rows, 0 FAIL,
0 WARN. `main` moved once DURING this work (#1040, docs-only, zero overlap); the
rebase and a full serial re-gate followed, because a rebase voids the gate, the
fingerprint and the red-team pin as one act.

Both rebases were conflict-free by construction: `main`'s four new commits (WS8
docs PRs #1037–#1040) touch only `.claude/`, `docs/` and `railway.toml`, with
**zero file overlap** against any of the three branches.

**Re-verify drift yourself before doing anything** — this line went stale once
while the handoff was being written:

```
git -C <worktree> fetch origin && git -C <worktree> rev-list --count HEAD..origin/main
```

If it is non-zero: rebase, THEN gate. Rebasing after a gate voids that gate, the
fingerprint, the blast radius and the red-team sidecar together.

Each worktree has its **own** test database, already provisioned to migrations
head, set in its own `.env.local`. Do not point two worktrees at one database.

**That does NOT make concurrent full gates safe** — an earlier version of this
paragraph said it did, and step 2 below is the correction. Separate databases
remove DATABASE contention only; the environment-sensitive tests scan
machine-wide processes and the whole repo, and those are what break. **Run full
gates one at a time.**

## What is DONE

* Implementation of all eight write sites, plus `writeRefusalEvents` (the
  set-based arm) in `src/lib/refusals/write.ts` on #1010.
* Three adversarial plan rounds per branch (codex, read-only) — 40 findings, all
  accepted, none rejected. Recorded in each plan's review appendix.
* Review wave: spec/correctness per branch, ONE cross-branch standards review,
  red team per branch.
* **Red-team rounds 1 AND 2 on every branch.** The two-round cap is SPENT on all
  three — there is no third round available.
* Every finding triaged with a written verdict. Deviations files carry per-entry
  `**Verdict:** ACCEPT` lines, which the `reviewed` transition parses.
* All review reports committed under `docs/reviews/<branch>/` and
  `docs/reviews/red-team/<slug>/`.

## What is NOT done — the actual remaining work

~~1. Take `main` first.~~ **DONE** — all three sit on `cfddfad4`, 0 behind.
~~2. Re-run each gate serially.~~ **DONE** — twice: once after the sidecar
   closure commits, once after the rebase. Both passes GREEN.
~~3. `reviewed` transition.~~ **DONE** on all three, after the three sidecar
   defects above were closed.

The instructions below are kept because they stay true for the NEXT time `main`
moves.

1. **Take `main` FIRST** if it has moved. `git rebase origin/main` in each
   worktree, then re-pin each report's `head_sha` to the post-rebase HEAD — the
   rebase orphans it and `red-team-status.mjs` will refuse the branch.
2. **Then re-run each gate — SERIALLY, one worktree at a time.**
   `cd <worktree> && bash .agents/skills/feature/scripts/verified-gate.sh --review`

   **DO NOT run the three full gates concurrently.** An earlier version of this
   handoff said you could, and that was WRONG — proven wrong on this branch set.
   Three concurrent full gates produced six failures across three files that NONE
   of these branches touch (`scripts/ci/__tests__/red-team-mutation-runner.test.ts`,
   `scripts/ci/__tests__/live-db-suites-audit.test.ts`,
   `src/lib/locations/__tests__/review-qr.test.ts`); all 98 tests in those files
   pass when run serially.

   The per-worktree databases solve DATABASE contention only. They do not help
   the environment-sensitive tests: the red-team watcher precondition scans
   machine-wide processes, the live-DB detector scans the whole repo, and the QR
   suite contends elsewhere. `--baseline` gates on empty branches DO run
   concurrently — that is what misled me; a full gate is a different animal.
3. **`reviewed` transition** per branch:
   `node .agents/skills/feature/scripts/red-team-status.mjs` then
   `bash scripts/feature-state.sh set-phase reviewed`

   **The checker reports only its FIRST failing layer.** Schema errors mask SHA
   and staleness errors behind them. #1010 showed one issue, then two more the
   moment the first was fixed. Never read a single error as the whole list.
4. **Push + draft PR** ← **THE NEXT ACTION, owner-gated** per branch (`gh pr create --draft`, then `gh pr ready`).
5. **Staging ride** — all three are RISK=high. **Staging is ONE shared
   environment; they cannot ride together.** Also `staging` is behind `main` (a
   clean fast-forward, not yet pushed, because pushing auto-deploys).
6. **Merge**, owner-approved, one at a time.
7. **Post-merge follow-up** (below).

## Decisions already made — do NOT re-litigate

* **#1010 `ask_withheld` writes a SET, not a loop.** The ticket's "none is
  high-volume" is false: the candidate window is bounded at `MAX_DATA_ROWS` =
  5000 and a rebuild re-evaluates the whole pool.
* **#1010 dispatch lane stamps the GATE's own `now`**, threaded into
  `commitWithhold` — not the `'transaction_time'` sentinel, because the
  transaction waits on the advisory lock before it decides.
* **#1010 halt lane uses the sentinel**, because `NOW()` IS the `halted_at` the
  CAS writes, to the microsecond.
* **#1011 moved the render clock** ahead of the transaction and the advisory-lock
  wait, so `solicitation_outreach.rendered_at` now means DECISION time. Owner
  decision, after the plan-skeptic rejected the original framing as a false
  choice. A seven-reader audit found no reader depending on persist time.
* **#1012 gets `account_id` by widening the existing `businesses` FOR UPDATE
  select**, not by exporting `resolveAccountIdFromBusiness`.
* **#1012 duplicate semantics are first-write-wins** — the partial index is
  `(refusal_source, subject_id)` and the subject is the response.

## Open items the owner has already ruled on

* **RT-3 (#1010, P1) — DEFERRED, owner-authorized 2026-08-31.** Disposition is
  `accepted-risk` in the sidecar with the reason recorded, which is what lets
  `red-team-status.mjs` pass a high-risk branch. Do not "fix" it on a swarm
  branch; see the follow-up below.
* **#1010's P1-B was WITHDRAWN and reverted** after round 2 disproved its premise.
  `surfaceAmendments` stays at 2. **#1010 has NO amendments left** — any further
  surface widening aborts it.

## Post-merge follow-up — one coherent change, not scattered debt

All of these say the same thing: **the ledger now has two writers and its maps
have callers.** Every path is outside all three swarm surfaces by construction.

* `src/lib/refusals/vocabulary.ts` header — "five exported constants have no
  production caller" is false once any slice merges.
* `.claude/reference/env-vars.md`, `docs/eservices-variables.md`,
  `docs/runbooks/beta-launch-alerting.md` — all three attribute the kill switch
  and the disabled warning to `writeRefusalEvent` alone.
* `src/lib/solicitation/release.ts` — `selectRenderedOutreach` orders on
  `rendered_at ASC` with no tiebreak. Red team verified the hazard is currently
  unreachable (every shared-instant row is `withheld`, which its own
  `delivery_status = 'rendered'` filter excludes), so this is latent. One line:
  add `, o.id`.
* A cross-reference comment at the TWO `outreach_withheld` write sites
  (`dispatch.ts` and `ask-generation.ts`) so neither forgets the other exists —
  they key the partial unique index on the same `solicitation_outreach.id`, and
  only a `delivery_status` filter keeps them apart.
* Export `REFUSAL_LEDGER_ENABLED` from `write.ts`; it is re-spelled as a literal
  in six test files.

Invoke `document-feature` for the doc half.

## Escalations for the owner, not owned by any branch

1. **`evaluateAsk`'s `already_reviewed` gate has no producer.** `toCandidate`
   hard-codes `matchedReview: null`, so one of six `WITHHOLD_REASONS` can never
   fire. Either a gate to delete or a producer never wired. Not a ledger question.
2. **#1010's red-team round 1 ended `INCOMPLETE_BUDGET`** — 21 of 39 mutation
   candidates unrun at the 30-run cap. Recorded coverage debt, not a completeness
   claim.

## Tooling defects found this run — file these, do not work around them silently

1. **`red-team-status.mjs` mis-slices porcelain paths.** It `.trim()`s the whole
   blob, so the first line loses its leading space and `slice(3)` cuts into the
   path — an UNSTAGED report file is falsely reported as an unrestored mutation.
   Clears once the artifacts are staged. Hit on all three branches.
2. **The red-team `watchers` precondition false-positives on every swarm run.**
   Its machine-wide scan matches `…/RepWorth` as a string PREFIX of
   `…/RepWorth-worktrees/…`, so dev servers serving OTHER checkouts abort the
   gate. Every pass resolved it by `lsof` and documented rather than waived it.
3. **The harness blocks red-team subagents from writing report files.** Both
   round-2 passes reported `findings.md` unwritten; the orchestrator wrote those
   sections by hand. Budget for that.
4. **Three concurrent FULL gates are not safe on one machine**, though three
   concurrent `--baseline` gates are. Six failures appeared across three files
   unrelated to any branch; all passed serially. The distinguishing factor is
   environment-sensitive tests (machine-wide process scans, whole-repo scans),
   not the databases. Worth either serialising the gate in the swarm command or
   making those tests worktree-scoped.

## Recurring failure to watch for in the next session

**A fact corrected in one artifact and left stale in another.** It happened four
times this run — in the plans, in the intakes, in the arch-review-log rows, and
once inside the fix for a previous instance of it. The rule that works is
mechanical: **grep the fact across every artifact, fix, then RE-GREP.** The
re-grep is what catches the miss.

The sharpest single example: the fix for a comment that hijacked a test's line
resolution was itself written using the phrase it prohibited, so it re-broke the
same test one line lower.

## Parent checkout

Branch **`docs/ws8-phase-e`** (the handoff first said `docs/operating-cost-baseline`;
that PR has since merged as #1040 and the parent moved on), with unrelated
marketing files dirty. **It was already like that and is not this work's** — do
not absorb or clean it.

## What this session did — 2026-08-31, second pass

Closed the three sidecar defects above, committed one closure report per branch,
re-gated serially, rebased onto `cfddfad4`, re-pinned, re-gated serially again,
and took all three to `reviewed`. Six full gates, all GREEN, never two at once.
No production code changed: every edit landed in `docs/reviews/red-team/`, which
is inside all three `allowed_edit_surface` lists, so **no amendment was spent**
and #1010 still stands at 2 of 2.

**The one risk worth carrying forward:** #1010's round-2 mutation work landed
almost entirely on the poller code that `c4bfa647` then reverted. HEAD's live
surface therefore has round 1's coverage only — and round 1 ended
`INCOMPLETE_BUDGET`, 21 of 39 candidates unrun. The cap is spent. #1011's and
#1012's round-2 fixes are likewise verified by reading, not by a re-planted
mutant. All three are recorded in the per-branch closure sections.
