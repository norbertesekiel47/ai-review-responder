# Step 7 — Dual-review triage verdicts

Two parallel fresh agents on `git diff 880435ba...HEAD`. Full reports:
`step7-spec-correctness.md`, `step7-standards.md`. Triaged in-session with
`superpowers:receiving-code-review`. Owner decided ST-3 (2026-07-21).

| # | Axis | Sev | Finding | Verdict | Resolution |
|---|------|-----|---------|---------|------------|
| SC-1 | spec | Low | `env-vars.md:420` row described pre-fix semantics (read-at-construction, `recordOutcome` no-op, `reset()` re-reads) | **ACCEPT** | Fixed row to live-per-call + `recordAttempt` + disable-clears-state. Commit follows. |
| ST-1 | standards | Med | `Admission.bypass` dead field (never read) + misleading JSDoc | **ACCEPT** | Removed `bypass` from the interface + disabled-mint token; corrected JSDoc/comment. |
| ST-2 | standards | Low-Med | `sawBlocked` threw contextless `LlmCircuitOpenError` even when a real transient cause existed | **ACCEPT** | Added `throwBlocked(attemptErrors)` helper preferring the real transient cause; 2 regression tests (preserve real cause; marker only when both blocked). |
| ST-3 | standards | Med (structural) | Fold `shouldAttempt`→call→`recordAttempt` into `breaker.run(provider, thunk)` (remove temporal coupling + exported `Admission`) | **DEFER (owner)** | Legitimate deep-module improvement; deferred as a fast-follow — module is correct + green with extensive epoch tests, single caller, and the refactor would churn crown-jewel concurrency tests right before a high-risk ship. See "Fast-follow" below. |

Spec agent: everything else PASS (state machine, epoch/stale-outcome correlation,
disable-clears-state, 8-row failover matrix, blocked⇒retryable contract,
spend-safety, all `tests_to_add` mapped, all 6 edge cases handled, edit surface
respected). Standards agent: no correctness blockers, no `any`, no silent
catches, glossary + invariant #13 intact.

## Fast-follow (ST-3) — to file as a ticket
**Refactor `LlmCircuitBreaker` to a `run(provider, thunk)` interface** that
encapsulates admission→call→record, returning the `Attempt` discriminated union
and deleting the exported `Admission` surface. Removes the temporal-coupling
footgun (a caller that admits but forgets to record leaks `probeInFlight`).
Deferred from the F3/P9 run on 2026-07-21 (owner decision) to avoid churning
just-verified concurrency tests before ship. Not a correctness issue — the
current token API is correct and fully tested.
</content>
