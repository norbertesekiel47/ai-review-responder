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
  form is correct there.
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
  change was needed.
