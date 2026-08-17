# Plan review round 2 — Codex verification-only (read-only)

**Target:** the round-1 fix delta, `git diff c0076d09..HEAD`
**Scope:** verify each of the 12 round-1 findings; no new fronts.
**Verdict:** `REVISE` — one finding not fixed.

## Per-finding verification

| # | Codex verdict | Evidence |
|---|---|---|
| 1 | FIXED | exclusions validated before mutation (plan 624–636); no-partial-cancellation test at 760 |
| 2 | FIXED | readiness permits a completed withheld attempt (590–595); UI retitle (268–270) |
| 3 | FIXED | replacement-attempt readiness case at 764 |
| **4** | **NOT FIXED** | `persistChildRender` **does** open a per-child transaction (`ask-generation.ts:714`) that takes the batch lock before inserting, so the interleaving test is feasible. Refuse-then-succeed does not cover it. |
| 5 | SCOPED-OUT-ACCEPTABLY | deferred-regenerate constraint honestly recorded; no owner entry point enqueues one today |
| 6 | FIXED | close disposition asserted at 756 |
| 7 | FIXED | same-account sibling-business scope at 899 |
| 8 | FIXED | both flag directions at 1188 |
| 9 | FIXED | halt cross-origin at 1193 |
| 10 | FIXED | property asserts distinct elapsed-veto / elapsed-window outcomes (151–157); ignoring either deadline fails it |
| 11 | FIXED | lifecycle-generated halt-reason property falsifiable against `sending_started_at` (162–185) |
| 12 | FIXED | tenant predicates in both readiness subqueries (605–610 writer, 994–998 read model) |

## Finding 4 — accepted, not disputed

Codex is right and my round-1 reasoning was wrong. I argued the test was
unwritable because "generation is not a single transaction"; the premise is true
and the conclusion does not follow, because `persistChildRender` holds the
advisory batch lock across its per-child insert. That per-child transaction is
precisely what a test can hold.

**Applied:** Task 3 gains `blocks approval on the batch lock until an in-flight
render commits, then counts it` — a two-connection test that holds the lock,
asserts the approval has not settled, releases, and asserts the committed render
is counted. Intake updated in both copies; deviations D2 rewritten to record the
overturned reasoning rather than quietly deleting it.

## Disregarded

Codex emitted a second `VERDICT: REVISE` because it could not run
`scripts/verify-gate.sh` under its read-only sandbox (the gate writes
`.feature/logs/` and `.feature/gate-status.json`). That is a harness artifact of
the read-only brief, not a plan finding. The gate is the orchestrator's to run,
and it is **GREEN** in docs-only mode at `bbd72340`.

## Round budget

`planReviewRounds` reads 3: round 1 (substantive), a dispatch that timed out with
no output (stdin block), and round 2 (substantive). Two substantive rounds ran.
Per the workflow's cap, no further round is dispatched — the single open finding
was accepted outright rather than disputed, so there is nothing to arbitrate;
the owner's go-ahead substitutes for `APPROVED`.
