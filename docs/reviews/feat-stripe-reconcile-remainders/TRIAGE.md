# Step 7 dual-axis review — orchestrator triage verdicts

Branch `feat/stripe-reconcile-remainders` (#479). Reviewed the branch diff since
fork `96b4f28c`. Two fresh agents; full reports:
- `spec-correctness.md` — verdict: diff faithfully implements the intake contract.
- `standards-maintainability.md` — verdict: meets standards.

Confidence-filtered (≥80%) findings and their triage. Fix commit lands after this file.

| ID | Sev | Source | Verdict | Rationale / fix |
|---|---|---|---|---|
| S1 | MED | spec | **ACCEPT (comment fix)** | Comments at `StripeLocationsReconcilePoller.ts:128,253` + `constants.ts:29` said "a stall leaves it untouched", contradicting shipped FIX 2b (`reconcile-progress.ts:100` resets the counter on ANY non-truncated cycle, stall included). Stale-comment / one-authoritative-owner defect on a safety-relevant state machine. Fixed all three to "a drain OR a stall resets it (FIX 2b)". No behavior change. |
| S2 | LOW | spec | **ACCEPT (comment fix)** | `constants.ts:19` said the boot-load is "kicked from start()"; FIX 3 moved it to the lazy first-tick kick in `runOnce`. Fixed the comment. No behavior change. |
| S3 | LOW | spec | **ACCEPT (comment fix)** | Poller file-header (`:11`) scope comment omitted `trialing`, contradicting the query (`:373`) + the `reconcileCycle` docstring. Pre-existing inconsistency in a file this branch heavily edits; fixed the header to `'active', 'past_due', or 'trialing'`. |
| F1 | LOW | standards | **REJECT behavioral change; ACCEPT as doc gap** | Agent proposed removing `accountCursor = reseeded.cursor` at `:299`, claiming it discards a fresh advance. Premise doesn't hold: on the failed-boot path the cycle enters with `accountCursor=null`, and on a *truncated* cycle this cycle's advance (`nextCursor`, line ~465) runs in the **detached tail** *after* `finally` (the documented ADR 0006 lag), so `accountCursor` at persist time is null-or-racy, NOT a fresh mid-rotation id. Deterministically re-seeding it from the durable frontier (a) recovers real durably-recorded rotation progress the failed boot-load never observed, (b) is race-free w.r.t. the detached tail, (c) is safe under never-skip either way (a durable frontier only defers re-checks; the head is re-checked when the rotation wraps). Removing the line would DISCARD durable progress and make the persisted value timing-dependent — strictly worse. Valid residual: the code comment claimed the re-seed was "writeSeq only". Fixed the comment to document the intent + lag interaction, and added a lock-in test (`…test.ts` "restores the durable cursor FRONTIER") that fails if the line is ever removed. |

## Non-table note (from spec agent, no action)
Intake invariant #4's "persisted == in-memory **at all times**" wording overpromises;
ADR 0006 documents a bounded one-cycle lag on the truncation path (never-skip-safe,
explicitly accepted). Wording-only; no code change.

## Post-triage gate
`scripts/verify-gate.sh` re-run after the fixes → **GREEN** (16/16; 8703 tests pass,
0 fail). All triage changes are comment-only except the added lock-in test, so no
behavior changed. `.feature/gate-status.json` fresh (ts 1784344125).
