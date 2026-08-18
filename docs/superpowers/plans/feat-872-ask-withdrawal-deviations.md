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
