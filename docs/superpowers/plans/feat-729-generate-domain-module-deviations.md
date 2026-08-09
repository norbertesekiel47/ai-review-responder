# feat-729-generate-domain-module — deviations

Entries the plan did not anticipate. Each gets an orchestrator verdict
(ACCEPT / RE-PLAN) at step 6.

## D1 — surface overlap with feat-719-drip-dropped-column (setup, step 2)

`scripts/ci/tenant-scope-allowlist.ts` is in both worktrees' surfaces. Both
branches change the entry count, so both touch `ALLOWLIST_BASELINE` —
guaranteed conflict on whichever lands second.

**Agreed merge order:** #729 lands first (small, unblocked,
behaviour-preserving). feat-719 (gate-red, parked on its own audit blocker)
rebases onto main afterward and recomputes its baseline as part of resolving
its existing allowlist work. Mirror note written to feat-719's deviations
file. Owner can veto asynchronously.

VERDICT: ACCEPT (coordination note, no plan impact beyond merge order)
