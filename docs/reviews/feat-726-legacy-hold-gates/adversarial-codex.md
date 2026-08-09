# Codex Adversarial Review

Target: branch diff against bea12e68c9d4fc7514347beb1bc31d9d2aff4092
Verdict: needs-attention

No-ship: the hold is misrepresented as terminal failure, and enforcement remains opt-in at route call sites—the same omission class that caused #726.

Findings:
- [high] Persisted held drafts are falsely reported as failed (src/app/api/dashboard/past-replies/draft-status/route.ts:149-154)
  The poller maps a successfully persisted held response to `status: 'failed'`. Its consumer explicitly treats `failed` as proof that no response row exists, drops the outbox ID, and renders a closable error with a “Try again” button. Retrying reaches the regeneration rate limiter before the hold gate, producing a useless loop that can consume the owner's quota. It also violates invariant #4's no-affordance rule even though no draft text leaks.
  Recommendation: Introduce a first-class `held` poll result and client state with explanatory text and no regeneration affordance. Handle it consistently across both draft-status pollers and add client contract tests.
- [medium] The invariant remains optional at every route (src/app/api/dashboard/past-replies/draft/route.ts:149-155)
  The branch manually invokes `hasOpenFlag` in each mutation route and re-spells the predicate in the poller. This does not make the hold invariant structural: every future release or disclosure path must still remember the correct post-lock call, which is exactly how these legacy holes arose. It also leaves failure behavior in route handlers despite the repository rule that entry points orchestrate and domain modules own failure behavior. Inference: #730 may centralize the predicate, but that alone will not prevent omitted enforcement calls.
  Recommendation: Move actionable-draft loading, required locking, hold refusal, and mutation eligibility behind shared domain operations. Keep route-specific HTTP mapping at the route; use a composable shared held projection for read queries rather than middleware that runs before locks.
- [medium] Queue mocks do not validate the new serialization contract (docs/superpowers/plans/feat-726-legacy-hold-gates.md:175-184)
  The plan classifies the change as non-DB-touching and explicitly rejects live-DB coverage, relying on SQL-text assertions that merely prove `FOR UPDATE` was spelled. Those mocks cannot demonstrate blocking order, visibility during concurrent admin dispositions, or absence of deadlocks—the central reason the lock was added. A wrong concurrency assumption could release or strand a held draft while every current test remains green.
  Recommendation: Set `db_touching` true and add live-Postgres concurrency cases covering POST/PATCH/DELETE racing each admin disposition, including rollback, lock ordering, and the expected fail-safe stale refusal.

Next steps:
- Replace the generic failed poll result with a named held contract and client state.
- Choose and document a shared post-lock domain enforcement seam before #730 consolidates predicates.
- Run live-DB concurrency tests against the admin disposition workflow before shipping.
