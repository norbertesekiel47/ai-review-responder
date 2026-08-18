# feat-872 — plan review round 2 (codex, verification-only, same thread)

codex thread id: `01a01383-9393-7fc1-ac89-867399b6c9bd`

---

I’m using the `verify-spec` workflow again because this is a spec-delta audit. I’ll keep it read-only and limit the verdict to the 12 prior findings plus defects introduced by their fixes.

---

I’ve confirmed the revision is substantial and the worktree is clean. I’m now checking the actual test/code snippets behind each claimed resolution; two areas need exact scrutiny rather than accepting the review appendix at face value: the constrained lifecycle generator and the new announcement/arming wiring.

---

The main unresolved delta is now concrete: the revised tenant test still never creates a foreign tenant’s batch/ask—it only applies a foreign account ID to the local batch—so it does not satisfy finding 7’s distinguishability case. I’m checking the remaining resolution details and whether the new pure classifier/property encodes any contradictory behavior.

---

| # | round-1 finding | status (ADDRESSED / NOT ADDRESSED / REGRESSED) | note |
|---:|---|---|---|
| 1 | Invalid property generator / wrong property-test investment | REGRESSED | The original `sending_started_at`-without-approval counterexample is filtered, and the full state × attempt property was added. However, the new classifier/property codifies incorrect idempotence precedence: non-withdrawable state wins before `cancelled/owner_withdrawn`. After withdrawing the last row, the batch is `closed`, so a retry returns `not_withdrawable`/409 instead of the intake-required `already_withdrawn`/200. The existing retry test uses two rows and misses this. |
| 2 | Server-authoritative count and truthful announcement | ADDRESSED | `LaneOutcome.done` now preserves `remainingLive`/`closed`; `withdrawnAnnounce` consumes them; a sending-row fixture proves the count is not re-derived client-side. The revised backlog wording is pinned by tests and intake D3. |
| 3 | Missing state/current-attempt matrix | ADDRESSED | Expired, queued, attempt ordering, no attempt, sending-keeps-open, and other-cancellation cases were added. The pure classifier property covers every `BatchState` and current-attempt status, including pending. |
| 4 | Refusals can commit partial writes | NOT ADDRESSED | `snapshotWithdrawSurface` and abort injection are good additions, but the claim “every refusal” is false. The halted refusal at [plan:357](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal/docs/superpowers/plans/feat-872-ask-withdrawal.md:357) has no post-withdraw full-surface assertion. The `already_withdrawn` no-op at [plan:511](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal/docs/superpowers/plans/feat-872-ask-withdrawal.md:511) snapshots batch/outreach and counts steps, but never snapshots `solicitation_asks`; a partial ask write still passes. |
| 5 | Migration-109 CHECK/precondition insufficient | ADDRESSED | The precondition now requires exactly one `owner_withdrawn` occurrence inside the cancelled arm, and the CHECK test verifies all 108 disposition members remain. A 108-only DB and an `owner_withdrawn` value in another status arm both fail. |
| 6 | Block-scoped `SCOPED` compile failure | ADDRESSED | Task 1 explicitly defines `WITHDRAW_SCOPED` inside the withdraw describe. |
| 7 | Foreign tenant distinguishability and route scope values | NOT ADDRESSED | The route-value assertions are fixed. The integration fix still does not create a foreign tenant’s batch or ask: `other` comes from the normal tenant-bound `seedRenderedBatch`, while `foreign.accountId` is merely applied to `mine`’s batch/ask at [plan:529](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal/docs/superpowers/plans/feat-872-ask-withdrawal.md:529). The snapshots therefore cover two same-tenant batches, not “both tenants.” A real foreign ask can remain distinguishable or writable while this test passes. |
| 8 | Missing approval/veto fields and auto-policy case | ADDRESSED | `readBatch` gains `approved_by_user_id` and `veto_deadline_at`; the full row is compared before/after; an `auto_policy` fixture proves approval method is not a gate. |
| 9 | Panel status matrix, closed state, and stale arming | ADDRESSED | The status matrix, closed-batch case, and drop-then-reappear test are present. The effect clears `armedAskId` rather than merely hiding it. |
| 10 | ADR 0020 contradicts ADR 0021 | ADDRESSED | [ADR 0020:126](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal/docs/adr/0020-regeneration-refused-after-approval.md:126) now recognizes withdrawal as a second recourse and distinguishes cancellation from replacement. |
| 11 | Missing skills / ADR 0012 misattribution | ADDRESSED | Per triage, the skill half was rejected as an orchestrator-catalog visibility issue. The accepted half is handled: the new route uses the `toWire` precedent, regenerate’s comment is repaired, and the two out-of-surface pre-existing comments are recorded as follow-up work. |
| 12 | Stale citations and shared-route documentation | ADDRESSED | The halt range is corrected to `:915-1076`; Task 3 updates both the shared route header and its `docs/directory.md` row for five routes and `readBatchAsk`. |

Defects introduced by fixes:

- [plan:87](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal/docs/superpowers/plans/feat-872-ask-withdrawal.md:87), [plan:1466](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal/docs/superpowers/plans/feat-872-ask-withdrawal.md:1466), [plan:748](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal/docs/superpowers/plans/feat-872-ask-withdrawal.md:748): the new classifier/property entrenches the wrong retry behavior. A last-row withdrawal closes the batch; the next request exits on `closed` before reading the owner-withdrawn attempt. Move the scoped current-attempt read before the state refusal, return `already_withdrawn` first, and add `a second withdrawal after the first withdrawal settled the batch is already_withdrawn and writes nothing`.

- [plan:720](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal/docs/superpowers/plans/feat-872-ask-withdrawal.md:720): the revised generator’s “SCHEMA-VALID rows only” claim is still false. It checks three null implications but omits 091’s chronological constraints, `send_closed_at ⇒ built_at`, and closure/halt ordering. For example, `built_at=2026-02-01` and `approved_at=2026-01-01` passes these `fc.pre` calls but violates migration 091. Generate ordered lifecycle prefixes or add all 091 preconditions.

VERDICT: REVISE

---


---

## Triage (orchestrator) — 2026-08-18

| # | verdict | resolution |
|---|---|---|
| 1 (REGRESSED) | **ACCEPT** — verified: after a last-row close the batch is `closed`, so the state gate answered a retry `not_withdrawable`/409 against the intake's `already_withdrawn` edge case | `classifyWithdrawal` checks `cancelled`/`owner_withdrawn` BEFORE the state gate; `withdrawAsk` reads the current attempt before refusing on state (tenant already proven by `lockBatchForAction`); property updated; new case "a second withdrawal after the first withdrawal settled the batch is already_withdrawn and writes nothing". |
| 4 (NOT ADDRESSED) | **ACCEPT** | Halted refusal now snapshots the full surface (after the halt); the `already_withdrawn` case snapshots batch + outreach + asks + steps. |
| 7 (NOT ADDRESSED) | **REJECT** (seed a real foreign ask) / **ACCEPT** (wording) | This suite's own `describe('tenant scope')` precedent probes with the foreign ACCOUNT against an owned batch and the owner's OTHER location; its helpers are bound to the main tenant and seed no foreign batch. A foreign ask id takes `crossBatch`'s path by construction (the read is keyed on batch id + both tenant keys, and `ci:tenant-scope` proves the LATERAL block). Wording "both tenants" corrected to "both owned batches"; the comment now names the boundaries. |
| defect 2 (generator claim) | **ACCEPT** | Comment rewritten to the honest scope — the NULL-implication arms of 091, which are the only arms that change `deriveBatchState`'s answer; chronology never enters this property. Added `closed ⇒ built`. |
| 2, 3, 5, 6, 8, 9, 10, 11, 12 | ADDRESSED per reviewer | — |
