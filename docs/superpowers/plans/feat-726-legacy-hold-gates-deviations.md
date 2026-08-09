# Deviations — feat-726-legacy-hold-gates

- **D1** [2026-08-09, plan round 1] Codex adversarial review returned REVISE
  (`.feature/plan-review-round1.log`, session transcript therein). Accepted:
  (a) POST existing-draft SELECT gains `FOR UPDATE` — the gate must be
  post-lock on the response row per the held-draft.ts contract; the original
  plan violated the intake's own invariant (genuine HIGH catch);
  (b) whole-body sentinel assertions (`JSON.stringify(body)` excludes seeded
  draft text/ids; refusal bodies asserted exact) replacing named-field checks;
  (c) SQL-text assertions on new gate queries (correlated EXISTS +
  `status='open'`, `FOR UPDATE` presence, bound response id) — house
  technique from `held-draft.test.ts`, closing the queue-mock fidelity gap;
  (d) poller tenant-precedence test (held + cross-tenant → 403, no heldness
  signal); (e) wording: test 2 is a green characterization test; admin
  disposition locks the response row only for `requires_regeneration`
  (fail-safe residual race); held-gate precedence clarified (earlier
  text-free refusals may win — invariant #4 holds under every precedence).
  **Rejected with reasoning** (plan Review appendix): live-DB matrix (lane
  change; predicate owned+tested in held-draft.ts; publish precedent),
  `last_error` draft-text sentinel (speculative — worker error text never
  contains draft text; a failed outbox persisted no draft), replacing the
  fast-check property with `it.each` (workflow mandates fc for approval-path
  invariants; strengthened to exact-body instead). VERDICT: ACCEPT (plan v2).
- **D2** [2026-08-09] `tests_to_add` revised 6 → 8 titles (two retitles for
  the strengthened assertions, two additions: poller SQL-shape + poller
  tenant-precedence) and the observability field softened to
  HTTP-status-level claims. Intake-field corrections, not surface
  amendments (per #643 rule) — both intake copies updated in lockstep;
  `allowed_edit_surface` unchanged, amendment count remains 0.
  VERDICT: ACCEPT.
