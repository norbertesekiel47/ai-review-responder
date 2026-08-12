# Recovery

Use this only when normal resume cannot identify one safe next action.

## Evidence order

Reconstruct state from strongest to weakest:

1. Git branch, merge-base, HEAD, status, and worktree registry.
2. `.feature/intake.json` and its durable intake copy.
3. `.feature/state.json` hashes and phase.
4. Current gate status and Codex fingerprint check.
5. Spec and plan.
6. Accepted/rejected review findings and deviations.
7. Handoff prose.
8. Conversation or prior summaries.

Never let a handoff override contradictory Git or machine state.

## Reconciliation rules

- Missing worktree: stop and ask. Do not silently recreate it.
- Unexpected dirty files: identify ownership and surface them. Do not absorb
  them into the feature contract.
- Intake copies differ: stop. Show the field-level difference and ask which is
  authoritative.
- `headSha` differs from HEAD: treat the recorded phase as stale and infer only
  from artifacts and Git.
- Fingerprint missing or stale: treat the gate as incomplete regardless of
  `.feature/gate-status.json`.
- Main drift: report the commit count and likely conflict surface before
  rebasing or merging. Do not update the branch without authorization.
- Review reports without root triage: resume review, not execution or shipping.
- State says `reviewed` but the fingerprint is stale: return to verification.
- State says `shipped`: verify the claimed external outcome before cleanup.

## Ambiguous state

When two phases remain plausible, state the evidence for each and ask one
focused question. Do not edit until the ambiguity is resolved. After deciding,
repair the phase through `transition-state.mjs` and record why in the handoff or
deviations artifact only if the reason matters to future work.
