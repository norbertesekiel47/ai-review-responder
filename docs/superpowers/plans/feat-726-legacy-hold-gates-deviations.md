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
- **D3** [2026-08-09, step 4] Plan said "Task 2 runs alone" for the
  first-task enforcement spot check; Task 1 (eval) was in fact the first
  dispatched task and passed the spot check (3 in-surface files, clean
  tree), so Tasks 2/3/4 dispatched in parallel — disjoint file sets, all
  blocked only on Task 1. VERDICT: ACCEPT.
- **D4** [2026-08-09, Task 4] `edit-surface-guard.sh` blocked the in-surface
  edit to `src/app/api/dashboard/past-replies/draft/[responseId]/route.ts`:
  the hook matches with bash `[[ "$REL_PATH" == $GLOB ]]`, so the intake
  entry's `[responseId]` parses as a character class — the literal bracket
  path can never match its own entry (verified under bash: the entry instead
  matches e.g. `draft/r/route.ts`). Fix: re-spelled the SAME path in
  `.feature/intake.json` (gitignored) as
  `draft/\\[responseId\\]/route.ts`, which under bash matches exactly the
  literal path and nothing else (verified). Not a surface amendment — the
  file was already listed verbatim; amendment count stays 0. The docs intake
  copy keeps the human-readable literal spelling (it is not hook-consumed).
  Latent hook footgun for any future bracketed Next.js dynamic-route surface
  entry — worth a hook-side escape (e.g. literal compare before glob) in a
  follow-up outside this feature's scope.
- **D5** [2026-08-09, step 5 gate] `tenant-scope` audit RED: the allowlist
  keys entries on exact sqlSnippet fingerprints, and both changed queries
  moved out from under theirs (poller lookup gained the held EXISTS column;
  POST existing-draft SELECT gained FOR UPDATE) — "unused entry" + "missing
  scope" pairs for the two files. Resolution, owner-approved: **surface
  amendment #1** adds `scripts/ci/tenant-scope-allowlist.ts`; the two
  sqlSnippet strings updated to the new query text. No entries added or
  removed, ALLOWLIST_BASELINE stays 412, both reasons remain accurate (the
  routes' tenant-scoping story is unchanged). A 2nd amendment would trip the
  abort criteria. VERDICT: ACCEPT.
