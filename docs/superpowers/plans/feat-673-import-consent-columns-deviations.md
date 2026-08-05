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
