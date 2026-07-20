# Plan review round 3 — Codex adversarial (resumed session 019f7dfa) — FINAL round

**VERDICT: REVISE** (3-round cap reached). Round-2 findings: **6, 10, 13, 14, 15 RESOLVED**; 2,3,4,8,11,12 PARTIAL (stale summary lines contradicting corrected detail). **One NEW blocker** — legitimate, Codex proved it with a Node diagnostic.

## New blocker (accepted — real crash bug)
`r.finally(() => { inflightReservation = null })` returns a DERIVED promise that re-adopts `r`'s rejection with no handler → `unhandledRejection` on a rejecting `reserve()` → the worker crash-net's fatal-exit path (`worker/index.ts:744-766`). FIX APPLIED: fold the latch-clear into the already-caught chain `r.then(release).catch(()=>{}).finally(clear)` so the only promise deriving from a rejected `r` is already handled; each caller still observes `r`'s rejection via its own `withTimeout` race. Regression test added (2 concurrent awaiters + `process.on('unhandledRejection')` assertion).

## Reconciliations applied (round-3 → round-4 plan)
- Architecture summary: Micro→Nano, "blessed"→staging-gate-blessed, draft-status "1"→"≤2 concurrent / ≤4 reads".
- Design summary threshold: "staging-calibrated"→PROVISIONAL (calibrated in Task 4 step 4.2).
- #12 mitigation contradiction: exceeding 16 isolates → raise compute tier OR lower DB_POOL_MAX (NOT lower DB_READ_POOL_MAX below its floor of 8).
- #4-wiring: `resolveOwnerScope` auth gate STAYS on write `sql` (shared helper); only route-body reads move to `sqlRead` (KPI + draft-status). Route tests align.
- Floor test cleanup → `finally` (nit).
- Intake: draft-status "1" ref + added the unhandled-rejection test.

## Cap decision
3 adversarial rounds reached; findings were legitimate + converging (9 → blockers → 1 new blocker), NOT a disagreement to arbitrate. All applied. Per workflow, do NOT auto-loop a 4th round — surface converged state to user for the call: proceed to sign-off/execute, or spend one confirmation round.
