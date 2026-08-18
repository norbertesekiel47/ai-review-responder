# Plan review round 1 — root triage

Plan review counter: 1. Reviewer verdict: `REVISE`.

## Finding 1 — whole-tuple behavior did not prove all five predicate names

- Verdict: **ACCEPT**.
- Evidence: migration 099's `businesses_solicitation_postal_address_attested`
  CHECK makes the five fields all-NULL or all-present. A live test that restores the
  complete tuple would also pass an implementation that probes only
  `solicitation_postal_address`, contradicting the intake invariant that all five stay
  explicit.
- Correction: the same approved offboarding integration file will use a recorder client
  for `verificationQuery('businesses', ...)`, assert all five column names in the executed
  SQL, and then prove zero-after-purge / one-after-restoration behavior. This is stronger
  than adding a separate mocked shape test and needs no edit-surface amendment.

## Finding 2 — stale error receipt was not covered

- Verdict: **ACCEPT**.
- Evidence: `ManualEntrySection` renders mutation success and mutation error through
  separate branches. A test covering only the duplicate-entry success could be satisfied
  by hiding that branch rather than resetting the mutation, leaving a contradictory red
  entry error after current state changes.
- Correction: the existing client suite will cover both the duplicate-entry success and
  failed-entry error receipts before a successful correction, while retaining the intake's
  exact promised success-case title. Both must disappear through `entry.reset()`; a
  genuine correction failure remains governed by the existing failure-state test.

No finding changes user-visible scope, allowed files, dependencies, architecture, or
external authority.
