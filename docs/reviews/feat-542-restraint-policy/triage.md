# Step 7 triage verdicts — feat/542-restraint-policy

All 5 findings (3 spec-correctness, 3 standards — offset-skew found by both) ACCEPTED; 0 rejected. Fixed in commit `eda6f1a5`; gate re-run GREEN (34/34 tests).

1. ACCEPTED — offset ISO timestamps skewed UTC day arithmetic → `utcDayNumber` now `Date.parse`-based for timestamps; deterministic ±offset boundary test added.
2. ACCEPTED — partition property weaker than intake promise → now set-equality against the evaluateAsk-surviving pool.
3. ACCEPTED — missing over_contacted-beats-velocity_banked deterministic test → added (over-cap batch, sends exactly BATCH_CAP).
4. ACCEPTED — per-candidate RegExp recompilation → keyword matchers precompiled at module scope.
5. ACCEPTED — docs/directory.md missing solicitation/ entry → surface amended with user sign-off; entry added.
