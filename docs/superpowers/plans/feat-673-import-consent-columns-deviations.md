# feat-673-import-consent-columns — deviations log

Entries the plan did not anticipate, with orchestrator verdicts. Review agents
receive this file triaged.

- **D1 (surface amendment #1, auto-approved rule: ≤2 files inside a covered
  tree).** `src/lib/shared/__tests__/helpers/schema-ready.ts` added to
  `allowed_edit_surface`. The post-#573 shape-suite pattern asserts schema via
  a `MIGRATION_*` registry entry in that helper (099 precedent); the intake's
  original 076-based reference predates #573 and missed it. Applied to BOTH
  intake copies before any Task 1 edit (plan-review round 1, finding 1).
  **VERDICT: ACCEPT.**
- **D2 (intake field correction, not an amendment).**
  `existing_patterns_to_follow`: the 076 suite reference replaced by the 099
  suite — 076 applies migration SQL at run time and never calls
  `assertSchemaReady`, so it is the wrong template (plan-review round 1,
  finding 12). **VERDICT: ACCEPT.**
- **D3 (tests_to_add extension, not an amendment — #643 rule).** Round-1
  adversarial review strengthened the eval: added the additive-only
  executable-SQL title, and hardened the four original test bodies (catalog
  default + exact constraint predicate via pg_get_constraintdef, absence of
  cross-column CHECKs via pg_constraint, integer data_type, asymmetric
  non-zero dual-write fixture 25/50/3/2, template-structure + INSERT-absence
  assertions, reconcile-failure dual-write assertion).
  `estimated_test_lines` re-estimated ~180 → ~260 accordingly.
  **VERDICT: ACCEPT.**
- **D4 (review finding rejected).** Round-1 finding 13 (add `pnpm build` to
  `verification_commands`) — REJECTED: the verify gate's own rule runs build
  only for ui surfaces; typecheck covers this backend diff and GitHub CI
  builds every PR as the backstop. **VERDICT: REJECT (recorded).**
- **D5 (2026-08-05, Task 1 step 3c — assertion form corrected).** The plan's
  3c block asserts `expect(reactivationJoined).not.toContain('skipped_count')`,
  but the reactivation INSERT branch legitimately names the legacy
  `gap_skipped_count` / `historical_skipped_count` columns, which CONTAIN that
  substring — so the literal assertion fails against the exact existing
  behavior 3c is meant to pin (contradicting the plan's own step-4 expectation
  that 3c passes red) and would stay red forever under locked decision 5
  (INSERT branches untouched). Replaced with a standalone-identifier match,
  `expect(reactivationJoined).not.toMatch(/(?<![A-Za-z0-9_])skipped_count/)`,
  which passes against the legacy-prefixed columns and still fails if the
  collapsed `skipped_count` is ever added to the column list. The
  `imported_count` absence check keeps the plan's plain `not.toContain` (no
  legacy column contains it). 3a's INSERT-absence assertions are unchanged —
  the initial branch names no counter columns at all, so the plan's literal
  form is correct there. **VERDICT: ACCEPT** — the regex form pins exactly the
  invariant locked decision 5 states (collapsed counters never join the INSERT
  column lists) without false-failing on legacy names; no intake decision
  touched.
- **D6 (2026-08-05, Task 2 step 1 — one semicolon removed from a COMMENT
  literal).** The plan's verbatim SQL for the
  `zernio_backfill_runs.skipped_count` COMMENT reads `…as imported_count;
  oldest_skipped_create_time is unchanged.` — a semicolon inside the literal,
  violating the plan's own authoring constraint (migration header + shape test
  4 split executable SQL on `';'`). Left as-is, the split yields a dangling
  fragment `oldest_skipped_create_time is unchanged.'` that fails the
  additive-only allowlist. Replaced the semicolon with an em dash
  (`…as imported_count — oldest_skipped_create_time is unchanged.`); no other
  byte of the plan's SQL changed. The CHECK-definition full-equality pin held
  as planned (PG16 rendered exactly the predicted literal), so no test-file
  change was needed. **VERDICT: ACCEPT** — plan-authoring slip, caught by the
  plan's own constraint; the fix restores the constraint with zero semantic
  change to the migration.
- **D7 (2026-08-05, step 7 adversarial review F2 — dual-write contract
  re-scoped, wording only).** "Dual-write until #680" over-promised: #675
  replaces selection with newest-100/12-month, after which no truthful
  gap/historical decomposition exists to dual-write. Corrected contract, in
  the migration COMMENT, migrations-log 100 entry, and intake invariant 3:
  the legacy WRITER contract ends at #675 (legacy counters freeze at DEFAULT
  0 for new runs), the legacy COLUMNS stay until #680, and the #680 DROP
  requires a reconciliation preflight (collapsed = legacy sums on every
  pre-#675 row, abort on mismatch). No code change — this PR's dual-write is
  correct under both phrasings. Companion constraints posted to #675/#680;
  adversarial F1 (version-skew) rejected for this PR (promotion procedure
  already orders migration-before-code, both envs empty, single-replica
  worker) with its reconciliation kernel folded into the #680 constraint;
  F3 (consent identity/transition races) rejected for this PR (additive
  unused columns foreclose nothing, transition contract deliberately
  deferred by the signed intake) with the archive→re-add loophole and the
  atomic transition predicates posted as constraints on #676/#677/#679.
  **VERDICT: ACCEPT (F2 wording); REJECT F1/F3 for this PR (recorded, with
  follow-up constraints posted).**
- **D8 (2026-08-05, step 8 staging apply — "zero businesses rows" premise
  stale at apply time).** The intake (non-goal 3), spec §8a R3, and the
  migration 100 header all state both environments hold zero `businesses`
  rows at migration time (staging fully reset 2026-08-05). At staging apply
  (2026-08-05 ~20:07Z), `businesses` held **2 rows** — smoke businesses
  created post-reset the same morning (15:45Z, 16:30Z). No consequence for
  the migration's decisions: the zero-rows premise was sufficient-but-not-
  necessary for "no backfill clause, no backdating" — DEFAULT `'pending'` is
  the truthful state for a location that never answered, both rows verified
  `pending` / NULL / NULL post-apply, and `zernio_backfill_runs` was empty as
  assumed. The immutable migration header keeps the stale sentence (guard
  re-armed at staging apply); the accurate apply-time record lives in the
  migrations-log 100 entry. **VERDICT: ACCEPT (record-only, no code or SQL
  change).**
