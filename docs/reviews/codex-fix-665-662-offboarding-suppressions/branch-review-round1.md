# Branch review round 1 — root triage

Branch review counter: 1. Fixed merge-base:
`d89c112ffa31a38dc64f7dcccf005f2927446f52`.

## Spec and correctness

Reviewer verdict: `APPROVED`. No finding at or above 80% confidence. The review
confirmed all four promised tests, every allowed path and non-goal, the five-column
fail-closed predicate, the readable-or-UUID actor contract, and the three correction
mutation outcomes.

## Database and tenancy

Reviewer verdict: `APPROVED`. No finding at or above 80% confidence. The review
confirmed account scoping, verifier-before-completion ordering, migration 099 tuple
compatibility, migration 098's handle/order index, users primary-key lookup, durable
missing-user fallback, and the unchanged tenant-scope baseline of 381.

## Security and authorization

Reviewer verdict: `APPROVED`. No finding at or above 80% confidence. The review
traced the only production caller through same-origin POST and
`requireAdminWithAal2`, confirmed the body-bound handle and no-store response, and
verified that the server-owned gate actor remains unspoofable.

## Standards and maintainability

Reviewer verdict: `REVISE` with one actionable finding.

### Finding 1 — recorder shutdown could skip fixture cleanup

- Verdict: **ACCEPT**.
- Severity: P2.
- Evidence: the new offboarding integration test awaited `recorder.end()` before
  `cleanupOwnerOffboardingSeed(seed)` in one flat `finally`. A recorder shutdown
  rejection would skip the seed sweep and leak account/postal data into the shared
  live test database. This conflicts with the repository's explicit cleanup and
  nested-`finally` precedent.
- Correction: nest recorder shutdown in a `try` whose `finally` always awaits
  `cleanupOwnerOffboardingSeed(seed)`. No production behavior or edit surface changes.

## Gate execution note

The first verified-gate attempt launched its built-in `pnpm build` and the intake's
explicit `pnpm build` concurrently. The built-in build passed; Next rejected the
duplicate with `Another next build process is already running`. The immutable gate was
rerun with `MAX_PARALLEL=1`, preserving every row while serializing the duplicate builds;
all rows passed and the fingerprint was current. This is a gate fan-out collision, not
an application failure or skipped check.
