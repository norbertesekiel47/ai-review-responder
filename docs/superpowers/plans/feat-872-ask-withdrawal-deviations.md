# feat-872-ask-withdrawal — deviations

Entries the plan did not anticipate. Each gets a one-line ACCEPT / RE-PLAN
verdict at step 6 (deviations read-back) before any review agent sees this file.

---

## D1 — Surface overlap with `feat-865-admin-halt-surface` (step 2, owner-agreed)

`scripts/feature-setup.sh` reported one code-pair overlap with the armed
worktree `feat-865-admin-halt-surface`:

- `src/lib/solicitation/approval.ts` — both surfaces name the file.

(plus two test-glob overlaps, not itemised by the script.)

**State of feat-865 at the time of arming (2026-08-18):** its branch is
docs-only against `origin/main` (plan, intake, handoff, three Codex plan-review
rounds). No source file is touched yet. Its approved plan intends to reshape
`haltBatch` (a `latchHalt` extraction) and add `adminHaltBatch` in
`approval.ts`, plus an admin read projection in `batch-view.ts` and a
`HALT_BODY` totality change in `ApprovalPanel.tsx`.

**What #872 changes in the shared file:** a pure APPEND of
`WithdrawAskInput` / `WithdrawAskResult` / `withdrawAsk` after
`requestAskRegeneration`, sharing `lockBatchForAction` and `canonicalBatchId`
unchanged. `haltBatch` is not edited.

**Agreed merge order (owner decision, step 2): feat-865 lands first; #872
rebases onto it.** Rationale: feat-865 is further along (plan approved,
executing) and its refactor touches `haltBatch`'s body; #872's append rebases
cleanly over it. If feat-865's `latchHalt` extraction yields a helper a
withdraw could reuse, that reuse is a follow-up, not a reason to widen this
surface.

Recorded in feat-865's deviations file as its D3.

**Verdict:** ACCEPT (step 6, 2026-08-18) — owner-agreed at step 2; still holds: feat-865 has no PR yet, and #872's `approval.ts` diff is header + append only (`haltBatch` byte-identical to base at `12a6e4bb`), so the step-8 rebase onto feat-865 is expected clean.

---

## D2 — Cross-worktree note bound this session to feat-865's stop gate (step 2/3, owner-agreed)

Writing D1's mirror entry INTO feat-865's deviations file made the edit-surface
guard record this session's id in `feat-865-admin-halt-surface/.feature/sessions`,
so the stop gate then required feat-865 to be green for THIS session. feat-865
is mid-execution in its own session (eval tests red by design), so that could
never be satisfied from here.

**Owner decision:** remove this session's id from feat-865's `.feature/sessions`
(one line; feat-865's own two session ids untouched; backup in this session's
scratchpad). The other session had already committed the D3 note at
`02649884`, so nothing of #872's lives only there.

**Lesson (promote to lab-notes at step 8):** record a cross-worktree collision
in your OWN deviations file only, citing the sibling by absolute path — the way
feat-865's D1 cites #860. Editing the sibling's file binds your session to its
stop gate. `scripts/feature-setup.sh`'s "note the collision in both deviations
files" wording should say this.

**Verdict:** ACCEPT (step 6, 2026-08-18) — owner-agreed; process-only, no code effect. The lesson (record a cross-worktree collision in your OWN deviations file only) is promoted to lab-notes at step 8.

---

## D3 — intake revised after plan review round 1 (NOT a surface amendment)

`docs/reviews/feat-872-ask-withdrawal/plan-round1-codex.md` returned
`VERDICT: REVISE` with 12 findings; 11 accepted (one partially), 1 rejected
(reasoning in that file's triage block). Two intake fields changed; **both
copies rewritten and verified byte-identical**, `scripts/arm-check.sh`
re-confirmed ARMED.

| Field | Before | After |
|---|---|---|
| `user_visible_behavior[1]` | "Withdrawn. N will send." (client count) | server's `remainingLive`/`closed`: "Withdrawn. N messages left to send." / "…this batch is finished." |
| `estimated_test_lines` | ±800 | **±1150** (13 cases added: state/attempt matrix, superseded ordering, no-attempt ask, sending-keeps-open, rollback via `abortingExecutor`, auto_policy, full-surface refusal snapshots, CHECK definition, tenant values, dual flag, panel status matrix, closed batch, disarm-on-refetch) |
| `tests_to_add` | 18 titles | 18 titles — **UNCHANGED** (the additions are extra cases, not retitles) |
| **`allowed_edit_surface`** | 24 globs | **24 globs — UNCHANGED** |

**This spends NO amendment.** Only `allowed_edit_surface` changes count toward
the abort budget; the surface is byte-for-byte what step 2 armed, so the budget
is still **0 of 2**.

**One design change from the review**, recorded in the plan and ADR 0021 is
untouched by it: the withdrawal DECISION is extracted as a pure
`classifyWithdrawal(state, currentAttempt)` in `approval.ts`, property-tested
over the whole Batch state × attempt-status matrix; `withdrawAsk` reads under
the lock, applies it, and writes only on `withdraw`. The route wire already
carried `remainingLive`/`closed`; the panel now READS them (`LaneOutcome.done`
gains the two fields) instead of subtracting one from the rows on screen —
the client cannot see an in-flight row, so its count was wrong exactly when it
mattered.

**Pre-existing misattribution surfaced (not ours to fix here):**
`halt/route.ts:26`, `approve/route.ts:104` and `regenerate/route.ts:50` cite
"ADR 0012" for the no-internal-id posture on the Requests surface; ADR 0012 is
the sentiment-blind withhold enum. #872 fixes the `regenerate` comment (that
file is in surface for the reader hoist) and cites the halt/approve `toWire`
precedent (#629 round-2 F10) in the new route; the other two are a docs
follow-up.

**Verdict:** ACCEPT (step 6, 2026-08-18) — surface unchanged (0 of 2 amendments spent); the 18 titles landed verbatim (gate `promised-tests` PASS). One consequence surfaced late: D3 re-estimated only the TEST bucket after the round-1 plan growth and left `estimated_prod_lines` at ±400 — see D5.

---

## D4 — Task 4: the armed-withdraw reset is a render-time adjust, not an effect; both armed buttons are `btn-secondary`

Two departures from the plan's Task 4 code, both mechanical; behaviour and
every promised test are unchanged (9/9 `withdraw control` green, 82/82 in the
requests `__tests__` dir).

**(a) `ApprovalPanel.tsx` Step 5 — the disarm.** The plan's `useEffect` that
clears `armedAskId` when a refetch drops the armed row fails
`react-hooks/set-state-in-effect` (`error` in `eslint.config.mjs`; the React
Compiler-era rule adopted repo-wide). Replaced with the same guard applied
DURING render — React's "adjust state when a prop changes" pattern, the
`src/components/dashboard/settings/ToneChipPicker.tsx` precedent named in the
eslint config's own comment ("prev-prop tracked in state"). Same clearing
semantics (a real state write, not a hidden derivation — the "reappears needs a
fresh first tap" case still passes) and it lands in the same commit as the
refetch, so no frame shows a confirm for a row that is gone. eslint clean;
`react-doctor --scope changed` reports no issues on the changed files.

**(b) `AskList.tsx` Step 1 — the confirm button's class.** The plan's
`btn btn-danger` on the armed confirm was conditional on the class existing "in
the app's button styles". `.btn-danger` exists only in
`src/app/(authenticated)/_styles/settings.css`, imported by `settings/layout.tsx`
and `dashboard/add-location/page.tsx` — never on the requests route, whose
sheets are `console.css` (via `(authenticated)/layout.tsx`) + `requests.css`.
On this route it would render as a bare `.btn` (transparent border, inherited
colour). Took the plan's own fallback: `btn btn-secondary` for both armed
buttons — the same class the **Halt latch**'s "Stop this batch" uses on this
surface. Noted in the `WithdrawableAskList` docblock.

Also, prose only: the panel's header docblock now says FOUR owned things / FOUR
kinds of control (the plan asked for the second; the first would otherwise have
been stale), and the `.rq-ask-withdraw*` CSS block sits after `.rq-ask-regen-count`
(the end of the regen block) rather than between `.rq-ask-regen-btn:disabled:active`
and that rule, so the regen block stays contiguous.

**Verdict:** ACCEPT (step 6, 2026-08-18) — (a) is forced by a repo-wide `error` lint rule and follows the named precedent (`ToneChipPicker.tsx`); the clearing semantics the eval pins (`a refetch that drops an armed ask permanently disarms it even if the ask later reappears`) are green. (b) is the plan's own stated fallback: `.btn-danger` is not loaded on the requests route, so the plan's primary choice would have rendered unstyled. Neither invalidates a locked intake decision. Both are review-agent inputs at step 7 (the spec agent should confirm the render-time adjust does not write state during render on every pass — only when the armed row is gone).

---

## D5 — gate `reclassify` WARN: production bucket 1020 vs `estimated_prod_lines` ±400 (step 5)

`scripts/verify-gate.sh --review` at `09ca11c9` was GREEN in full mode (lint,
typecheck, test with coverage, every `ci:*` audit, build, `promised-tests` 18/18,
integration suite RAN against the local DB, `diff-coverage` PASS) with ONE
WARN row: `RECLASSIFY: production 1020 > 2x estimated_prod_lines (400)`. The
test bucket (1116) is inside its ±1150 estimate.

**Where the 1020 comes from** (`git diff --numstat` vs the merge-base, insertions
+ deletions, workflow artifacts excluded — the gate's arithmetic):

| Bucket | Lines | Note |
|---|---|---|
| Docs the gate counts as "production" | 188 | ADR 0021 (115), ADR 0020 amendment (14), migrations-log entry (39), CONTEXT.md (5), CLAUDE.md row (2), directory rows (13) |
| Code + migration | 832 | insertions only: 748 |
| — `approval.ts` | 260 | est. ~120: the plan-review round-1 extraction of the pure `classifyWithdrawal` + `isWithdrawableState` + `CurrentAttempt`/`WithdrawalDecision` types (7 exports, each with the docblock the plan specifies verbatim) |
| — `ApprovalPanel.tsx` | 184 | est. ~70: server-count read on the wire, `withdrawnAnnounce`, disarm-on-refetch, refusal copy, render arm — all round-1 additions |
| — `AskList.tsx` | 134 | est. ~60: `WithdrawableAskList` as a SIBLING component (the "structurally no controls" property of the read-only list) rather than a flag |
| — route + reader + regenerate + CSS + migration + run-spine | 254 | route 95 (est. 90), reader 32 (est. 15), regenerate 25 changed (net −15: `readRegenerateRequest` deleted), CSS 48, migration 53 (est. 45), run-spine 1 |

**Cause:** the ±400 estimate was made at step 0, BEFORE plan review round 1
(D3) grew the design — `classifyWithdrawal` extraction, server count on the
wire, disarm-on-refetch, the status matrix. D3 re-estimated the TEST bucket
(±800 → ±1150) and left the production estimate untouched. Every production
line is plan-verbatim code (three review rounds); no task sprawled beyond its
ticket and `allowed_edit_surface` was never amended (0 of 2).

**Step 0 re-run with the real numbers (the trigger's required action):**
RISK = **high** (unchanged — migration + approval path). SURFACE = mixed.
SIZE: not trivial/small; the epic criteria do not fire — the surface is 24
explicit globs (unchanged, tighter than any directory), the work is ONE seam
(`approval.ts` verb + its route + its panel arm) plus ONE additive CHECK
widening (no billing/worker/schema-shape change), 5 tasks (< 8), and
`open_questions` is empty. **The lane that ran — RISK = high, full pipeline —
is the heaviest non-epic lane. The lane holds.** What the trigger caught is a
stale ESTIMATE, not a wrong lane; the fix for future runs is that a D3-style
plan-review re-estimate must revise BOTH buckets (promote to lab-notes at
step 8).

The WARN row is deliberately left standing (the estimate is not rewritten after
the fact) so it stays visible in `gate-status.json`, this file, and the PR
description; the owner's step-8 merge approval is where it is accepted or not.

**Verdict:** ACCEPT (step 6, 2026-08-18) — lane confirmed by re-classification; no locked decision invalidated; owner sees the WARN at the high-lane merge pause.

---

## D6 — step 8 integrated feat-865 by MERGE, not the handoff's rebase (2026-08-18)

D1's precondition came true while this branch was parked: feat-865 landed on
`main` as **#876**, followed by its post-merge sweep **#881**, and two unrelated
PRs (#875, #882 + sweep #884). The handoff's step-8 runbook said
`git rebase origin/main`.

**What the rebase did:** replaying 19 commits re-conflicted the SAME doc lines
in commit after commit (it stopped at 2/19 on `CONTEXT.md` alone). Every one of
this branch's commits touches `CONTEXT.md`, `docs/directory.md`,
`.claude/CLAUDE.md` or `approval.ts` — exactly the files #865 also rewrote — so
the replay would have demanded the same resolution up to seven times, each an
independent chance to resolve differently.

**What I did instead:** `git rebase --abort`, then `git merge origin/main` —
ONE resolution pass over six conflicted files, then a second trivial merge for
`dd868c92` (docs-only) so the branch is 0 behind. **The final tree is what
matters and it is identical:** the repo squash-merges every PR (CLAUDE.md,
"Environments & branches"), so `main` receives one commit either way and the
branch's own history is discarded at merge.

**The six resolutions, all "keep both sides"** (never "take ours"):

| File | Resolution |
|---|---|
| `src/lib/solicitation/approval.ts` | Header + 3 docblocks now say FIVE human-triggered verbs. `withdrawAsk` deliberately does NOT reuse #865's private `latchHalt`: the latch writes `halted_at` on the BATCH and withdrawal writes nothing there — same discipline, different body. That sentence is now in the header so the next reader does not "unify" them. |
| `approval.test.ts` | Both sides' cases live in `describe('invariants')`; imports merged (named imports + #865's namespace import for the admin arm). 10/10 green. |
| `approval.integration.test.ts` | Our `abortingExecutor` import + #865's delegating-spy block; both additive. |
| `CONTEXT.md` | **Halt latch** taken byte-identical from `origin/main` (verified programmatically — #865 more than doubled it); our **Owner approval** / **Ask exclusion** cross-references and the whole **Ask withdrawal** entry kept. |
| `docs/directory.md` | Main's `latchHalt`/`adminHaltBatch` prose + our `withdrawAsk` clause; "the two #629 verbs" → "the four approval/latch verbs"; main's two traps (relocated out of CLAUDE.md) kept. |
| `.claude/CLAUDE.md` | One lane row carrying both sides' verbs, LOCKED terms and traps, trimmed to stay inside `claude-md-shape.test.ts`'s word cap. Main had MOVED two traps into `directory.md`; that editorial choice is respected rather than reverted. |

**Lesson (promote to lab-notes at step 8):** when a parked feature branch has
many small commits that all touch the same living docs, integrate the base with
a MERGE, not a rebase — a rebase multiplies one resolution by the commit count,
and a squash-merged PR discards the linear history the rebase was preserving.

**Verdict:** ACCEPT (step 8, 2026-08-18) — no locked decision invalidated; D1's merge order was honoured (feat-865 first); the merged tree re-passes the full gate.
