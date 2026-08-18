# feat-872 — branch review round 1 — adversarial approach (codex)

codex thread id: `01a01383-9393-7fc1-ac89-867399b6c9bd` (resumed from plan rounds 1–3)
brief: session scratchpad `codex-872-branch-review-round1-brief.md` · HEAD reviewed: `621aee35` · base `d89c112f`

---

I’m using the `code-review` skill because this is a fixed-point branch review. I’ll keep the review strictly on the adversarial/approach axis: plan promises, lifecycle design, ADR assumptions, and the feat-865 rebase seam—leaving ordinary correctness and maintainability findings to the other reviewers.

---

The worktree is dirty only because `docs/reviews/feat-872-ask-withdrawal/blast-radius.md` is currently untracked; I’ll treat it as review input, not branch implementation. The review skill normally launches standards/spec reviewers, but your two parallel agents already own those axes, so I’m intentionally not duplicating them and will inspect this approach axis directly.

---

So far, the implemented seams match the approved approach: the UI count is server-derived, the read-only list remains structurally control-free, `readBatchAsk` has exactly two same-shaped callers, and the render-time disarm’s guard writes only when an armed ask disappears. I’m now tracing the database tests and the feat-865 `latchHalt` rebase seam for any promise that passed review but drifted in implementation.

---

I’ve finished the main promise-to-code trace. I’m doing one last branch-wide write-path scan and the feat-865 overlap comparison so the ADR and merge-order conclusions are based on the complete production diff, not just the new withdrawal function.

---

The final scan found only the intended production write: withdrawal changes the selected outreach row’s delivery/disposition fields; it does not touch rendered bytes or `solicitation_asks`. The feat-865 version still uses the same batch lock and `rendered`/`queued` predicate, so I’m checking whether the remaining duplication is an actual rebase defect or only a future drift risk.

---

I checked, in order, the accepted plan promises against production code and tests; the resulting module/UI boundaries; ADR 0021’s assumptions via a branch-wide production write scan; the feat-865 `latchHalt` overlap; and D5’s diff accounting. This was a read-only static review of the fixed diff and touched files; I did not rerun the already-recorded green test suite.

## Findings table

| # | severity (blocker / major / minor) | file:line | finding (one line: what + the promise/assumption it breaks + the concrete consequence) |
|---|---|---|---|

## Promise audit

| plan round / finding | promise | status (KEPT / DROPPED / CHANGED) | where in code |
|---|---|---|---|
| R1 / #1 | Withdrawal decisions live in pure `classifyWithdrawal`. | KEPT | [approval.ts:758](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal/src/lib/solicitation/approval.ts:758); full matrix property at [approval.test.ts:179](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal/src/lib/solicitation/__tests__/approval.test.ts:179). |
| R1 / #2 | Remaining-live count and closure fact come from the server and travel on the wire. | KEPT | Count at [approval.ts:916](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal/src/lib/solicitation/approval.ts:916), projection at [route.ts:38](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal/src/app/api/dashboard/solicitation/batch/withdraw/route.ts:38), copy at [ApprovalPanel.tsx:692](</Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal/src/app/(authenticated)/dashboard/requests/ApprovalPanel.tsx:692>), including a `sending`-row test at [approval-panel.test.tsx:1025](</Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal/src/app/(authenticated)/dashboard/requests/__tests__/approval-panel.test.tsx:1025>). |
| R2 / #1 | `already_withdrawn` outranks the state gate, including after last-row settlement. | KEPT | Precedence at [approval.ts:775](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal/src/lib/solicitation/approval.ts:775); attempt read precedes classification at [approval.ts:837](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal/src/lib/solicitation/approval.ts:837); closed-batch retry test at [approval.integration.test.ts:1453](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal/src/lib/solicitation/__tests__/approval.integration.test.ts:1453). |
| R2 / #4 | Refusals prove no partial write across batch, outreach, asks, and steps. | KEPT | Full-surface helper at [approval.integration.test.ts:479](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal/src/lib/solicitation/__tests__/approval.integration.test.ts:479), used for state, row-status, idempotence, scope, and abort cases. |
| R3 / property scope | The lifecycle property honestly models only relevant NULL implications, not chronology. | KEPT | The limitation is explicit and enforced with `fc.pre` at [approval.test.ts:139](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal/src/lib/solicitation/__tests__/approval.test.ts:139). |
| ADR 0021 / claim 1 | No per-ask approval state is needed; approval columns remain untouched. | KEPT | The sole branch production outreach write changes only delivery status, disposition, and `updated_at` at [approval.ts:893](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal/src/lib/solicitation/approval.ts:893); integration pin at [approval.integration.test.ts:1578](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal/src/lib/solicitation/__tests__/approval.integration.test.ts:1578). |
| ADR 0021 / claim 2 | The “no migration needed” premise remains rejected; post-approval withdrawal receives an honest, distinct reason. | KEPT | Migration 109 admits `owner_withdrawn` only in the cancelled arm at [109_outreach_owner_withdrawn_disposition.sql:27](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal/supabase/migrations/109_outreach_owner_withdrawn_disposition.sql:27). |
| ADR 0021 / claim 3 | Withdrawal adds no coordination class beyond Halt. | KEPT | It shares `lockBatchForAction` at [approval.ts:833](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal/src/lib/solicitation/approval.ts:833), Halt’s exact `rendered`/`queued` predicate at [approval.ts:902](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal/src/lib/solicitation/approval.ts:902), then records the step and calls the settlement owner in the promised order. Feat-865’s `latchHalt` retains that predicate. |
| ADR 0021 / contact retention | Withdrawal must not release the contact. | KEPT | No production `solicitation_asks` write exists in the branch diff; the integration assertion is at [approval.integration.test.ts:1578](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal/src/lib/solicitation/__tests__/approval.integration.test.ts:1578). |
| ADR 0021 / rollback condition | Reapplying 108 is legal only while no `owner_withdrawn` row exists. | KEPT | The conditional claim remains explicit at [109_outreach_owner_withdrawn_disposition.sql:10](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal/supabase/migrations/109_outreach_owner_withdrawn_disposition.sql:10); the widened CHECK would correctly prevent rollback after such rows exist. |
| D4a | Refetch disarming must clear state, without the lint-rejected effect. | CHANGED | Replaced by a guarded render-time adjustment at [ApprovalPanel.tsx:973](</Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal/src/app/(authenticated)/dashboard/requests/ApprovalPanel.tsx:973>); it writes only when a non-null armed row disappeared and converges on the immediate rerender. |
| Task 4 structure | The ordinary `AskList` remains structurally incapable of rendering controls. | KEPT | Read-only component at [AskList.tsx:238](</Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal/src/app/(authenticated)/dashboard/requests/AskList.tsx:238>); withdrawal controls are isolated in the sibling beginning at [AskList.tsx:256](</Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal/src/app/(authenticated)/dashboard/requests/AskList.tsx:256>). |
| Task 3 interface | Hoisting `readBatchAsk` should remain a narrow parser for the two per-ask routes. | KEPT | It returns exactly `{batchId, askId}` and is documented for regenerate/withdraw at [scoped-batch-route.ts:70](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal/src/app/api/dashboard/solicitation/batch/_shared/scoped-batch-route.ts:70). |

## Low-confidence appendix

- D1’s remaining drift watch is the duplicated SQL predicate `delivery_status IN ('rendered', 'queued')`: feat-865’s `latchHalt` and `withdrawAsk` currently match exactly, so the rebase introduces no defect, but a later Halt-predicate change would not propagate automatically.
- `isWithdrawableState` says the panel shares it, while the client instead reaches the same state set through `panelMode`. That is a documentation/future-drift concern, not a current lifecycle divergence; importing the server domain module into a client component would not itself be an obvious improvement.
- D5’s production-line increase is real, but the touched production files correspond to planned domain, route, UI, migration, projection, styling, and spine seams. I found no unrelated ticket expansion; much of the apparent bulk is contract documentation and explicit boundary adapters.

VERDICT: APPROVED

---

## Post-verdict sandbox noise (kept for fidelity; no file was changed)

After the verdict the codex session tried to run `scripts/verify-gate.sh` (a stop hook fired inside its session) and its read-only sandbox refused the writes to `.feature/`. `git status` after the run showed no source change. Raw JSONL: session scratchpad `codex-872-branch-round1.jsonl`.


---

The stop hook requires fresh gate evidence before the review can close. I’ll run the repository’s verification script exactly as requested; I won’t make manual file changes.

---

The mandated script cannot run under the review’s read-only constraint: it immediately tries to write `.feature/logs/db-provision.log` and `.feature/gate-status.json`, and the sandbox rejected both before checks started. I’m inspecting whether the script exposes a read-only-compatible output override; I won’t bypass the repository restriction.

---

There is no output-path override: the gate always writes `.feature` evidence and, for this DB-touching intake, provisions the configured test database. The hook requires that exact gate, so I’m requesting the narrow permission needed to run it outside the read-only sandbox; no source files will be changed.

---

Gate verification is blocked by the read-only constraint. `scripts/verify-gate.sh` writes `.feature` evidence and may drop/recreate the configured test database’s `public` schema. Please explicitly authorize those two side effects if you want the gate rerun. No source files were changed.

---


---

## Triage (orchestrator, step 7 round 1)

Findings table: EMPTY — nothing to triage. Promise audit: 12 KEPT, 1 CHANGED (D4a, justified: guarded render-time adjust writes only when the armed row disappeared). Low-confidence appendix (untriaged by default; noted for step 8 / lab-notes):

- Duplicated `rendered`/`queued` predicate vs feat-865 `latchHalt` — a future drift watch, not a defect; D1 rebase note carries it.
- `isWithdrawableState` docblock says "the panel shares it" while the panel reaches the same set via `panelMode` — docblock wording only.
- D5 bulk is contract docblocks + boundary adapters, no ticket expansion — consistent with the step-6 verdict.

`VERDICT: APPROVED` stands for this axis.
