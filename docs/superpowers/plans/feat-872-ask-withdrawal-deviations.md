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

**Verdict:** _(pending step 6 read-back)_

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

**Verdict:** _(pending step 6 read-back)_

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

**Verdict:** _(pending step 6 read-back)_

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

**Verdict:** _(pending step 6 read-back)_
