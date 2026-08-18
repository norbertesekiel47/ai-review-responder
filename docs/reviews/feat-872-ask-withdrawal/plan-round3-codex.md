# feat-872 — plan review round 3 (codex, verification-only, final)

codex thread id: `01a01383-9393-7fc1-ac89-867399b6c9bd`

---

I’m using `verify-spec` for this final delta audit. I’ll inspect only the four round-2 resolutions and any defect caused by those edits; unchanged plan sections are out of verdict scope.

---

The behavioral fixes are internally consistent: last-row retries now read the scoped attempt before the state decision, and both previously incomplete no-write cases use full-surface snapshots. One documentation inconsistency remains under examination: the revised property comment is honest, but the earlier review-appendix summary may still retain the superseded “fully 091-valid” claim.

---

| # | round-2 item | status (ADDRESSED / NOT ADDRESSED / REGRESSED) | note |
|---:|---|---|---|
| 1 | Idempotence after last-row settlement | ADDRESSED | Both classifier copies prioritize `cancelled/owner_withdrawn` before state. `withdrawAsk` reads the scoped current attempt before state refusal, and the property mirrors that precedence. The new integration case proves a retry after closure returns `already_withdrawn` with the full surface unchanged. |
| 4 | Full-surface refusal snapshots | ADDRESSED | The halted snapshot is taken after `haltBatch` and compared after refusal. Both ordinary and post-settlement `already_withdrawn` cases compare batch, outreach, asks, and steps. |
| 7 | Foreign-tenant test rejection and wording | ADDRESSED | The rejection is technically sound. `lockBatchForAction` proves batch ownership using batch ID plus both tenant keys; the attempt query repeats batch and tenant scoping. The foreign-account, sibling-location, cross-batch, and unknown probes exercise the distinct predicate boundaries. The inaccurate “both tenants” wording is corrected to “both owned batches.” |
| 2 | Generator-scope defect | ADDRESSED | [Task 1 Step 3](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal/docs/superpowers/plans/feat-872-ask-withdrawal.md:750) now claims only the relevant null-implication constraints, explicitly excludes chronology, and adds `closed ⇒ built`. Those preconditions eliminate the original false counterexample without claiming the generated timestamps are wholly schema-valid. |

Defects introduced by a fix: none found.

VERDICT: APPROVED

---

