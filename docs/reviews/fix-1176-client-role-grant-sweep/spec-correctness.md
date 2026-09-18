# Spec & correctness review — fix-1176-client-role-grant-sweep

- Head SHA reviewed: `e791f2bb194e746e195bf215e06806068c2271aa`
- Merge-base: `889c8be6e479e4b6eae4b729cb1f6eeceafb9343`
- Every file was read with `git show <head>:<path>`; the diff was read with `git diff <base> <head>`. The working tree was not trusted. No tests or gates were run, and no database was contacted.
- Inputs: the intake JSON, the plan (including its review appendix), the deviations (D1–D3, all ACCEPT), blast-radius.md (no changed production source files), and the accepted-findings checklist `docs/reviews/finding-checklists/spec-correctness.md`.

## Findings (confidence at least 80%)

| # | Severity | file:line | Finding |
|---|---|---|---|
| F1 | medium | .claude/reference/migrations-log.md:2903-2904 | The recorded rollback inverse `GRANT ALL ON <the twenty> TO anon, authenticated` is not an inverse. It would give `authenticated` INSERT, UPDATE and DELETE on `auto_approval_policies` and `judge_verdicts`, which it did not hold before 122. |
| F2 | low | docs/superpowers/plans/fix-1176-client-role-grant-sweep-plan.md:163 | The code fence that closes the step-8 evidence SQL has text on the same line. The fence therefore never closes, a sentence about the arch-review-log is garbled into it, and the whole "Plan review appendix" renders as code. |
| F3 | low | docs/superpowers/plans/fix-1176-client-role-grant-sweep-handoff.md:17 | The handoff is stale. Its Codex sessions table stops at plan round 2, but the plan appendix records a round 3 that returned APPROVED. |

### F1 — the rollback inverse would grant more than it restores (medium)

- **Contract fields:** `rollback_plan` (copied into the migrations-log entry) and `invariants` (#14 "strengthened").
- **Repository evidence:**
  - `supabase/migrations/055_auto_approval_policy.sql:72`: `REVOKE INSERT, UPDATE, DELETE ON auto_approval_policies FROM authenticated;`
  - `supabase/migrations/076_judge_verdicts_governor.sql:61`: `REVOKE INSERT, UPDATE, DELETE ON judge_verdicts FROM authenticated;`
  - No later migration grants these privileges back. `git grep` over `supabase/migrations` finds no GRANT on either table.
  - Both tables are among the twenty. Under the lockstep rule, both projects carry the 055 and 076 revokes. Before 122, `authenticated` therefore held SELECT and the four rights on those tables, but not I/U/D.
  - The entry at `migrations-log.md:2901-2907` (and intake `rollback_plan`) says "Inverse: `GRANT ALL ON <the twenty> TO anon, authenticated`". This line is not taken from the saved snapshot. Only the four-right line is ("taken from the saved snapshot — never `ON ALL TABLES`").
- **Failure scenario:** after the staging apply, a 42501 appears and someone writes migration 123 from this recorded inverse. That migration gives `authenticated` table-level INSERT, UPDATE and DELETE on `auto_approval_policies`, the invariant-#14 table. That privilege did not exist before 122. RLS with zero policies still denies rows, but the posture is now wider than the one being rolled back, the first-principles snapshot comparison fails, and the "one inverse serves both" claim is false.
- **Fix:** derive the twenty-table half of the inverse from the pre-apply snapshot as well, per table and per role. At minimum, carve out `authenticated` on `auto_approval_policies` and `judge_verdicts`. Update the entry and both intake copies.

### F2 — broken code fence in the plan (low)

- **Contract field:** the plan is the reviewed spec. The step-8 mandatory PG17 evidence query lives in this section (intake `observability[0]` points to "the exact query in the plan, step 8").
- **Evidence:** plan line 163 reads ``` `.claude/reference/arch-review-log.md` merge counter after merge. The line opens with a closing fence, but trailing text makes it an invalid close. Everything that follows, including the entire review appendix, stays inside the code block. The sentence itself is a fragment; its first half (probably "Step 8 also updates the …") was lost. This matches D3, where the file was rewritten through a python heredoc.
- **Failure scenario:** a reader at step 8 sees the evidence query merged into the review appendix and loses the step-8 obligation about the arch-review-log merge counter. The checklist class is "a durable doc says something unreadable or stale".

### F3 — stale handoff (low)

- **Contract field:** handoff and resume state. The checklist entry "the handoff still claims … never updated" is the same class.
- **Evidence:** the handoff table lists `plan 1` and `plan 2` only. Plan lines 184-188 record "Round 3 decision: `contract-changed` reported CHANGED, so round 3 ran" with VERDICT APPROVED and report `.feature/codex/plan-round-3-report.md`. The handoff also carries no T1/T2 status, although both tracers are committed (`10a10ff91`, `3be6bd34d`).
- **Failure scenario:** `/feature-resume` reads the handoff, finds plan review at round 2 (REVISE), and re-runs a plan-verification round that already returned APPROVED.

## Verified with no finding

- **Migration body matches the plan exactly.** Lines 67-115 of `122_client_role_grant_sweep.sql` are byte-identical to the plan's `sql` block, checked with `diff`.
- **Header claims hold at head:**
  - Only `users` is read through supabase-js. `git grep '\.from('` over `src` and `worker` (non-test) finds exactly `src/proxy.ts:252`, `src/app/api/auth/callback/route.ts:112` and `src/components/auth/hooks/useLoginSubmit.ts:94`. There are no `.rpc(` or `postgres_changes` calls.
  - Column grants exist only in `040_rls_tightening.sql:67,164`, on `businesses` and `channel_enrollments`. Neither is in the twenty.
  - The nine already-hardened tables are the `REVOKE ALL` sites in 056, 117, 118, 119 and 120, so the "49 tables" arithmetic in the inverse is right for the four rights.
- **All seven test titles** from `tests_to_add` exist verbatim (suite lines 477, 500, 511, 545, 558, 585, 589).
- **Assertions match the plan's test table row by row:**
  - Degrade landed: suite lines 483-491, 506, 512-522 and 561.
  - Exact client-set equality outside the twenty: 524-531.
  - Non-client ACL identical: 533-542.
  - rls, force, policies, columnAcl, sequenceAcl and functionAcl: 545-556.
  - defaultProbe plus exact `defaultAcl` delta: 558-583.
  - Idempotence deep-equal: 586.
  - Owner-guard message plus unchanged catalogue: 589-592.
  - Fail-open guards: `serverPrivileges >= 7`, `revokedRights >= 3`, non-empty tables.
- **Production mutants are caught:**
  - Deleting step 2 or dropping a table from it: test 2 fails, because `after` keeps the degraded DML.
  - Deleting step 3: test 5 fails.
  - Revoking `users` SELECT or `reviews` DML: test 3 fails.
  - Deleting the owner guard: test 7 fails on `ownerGuardError === null`.
  - A table-level `REVOKE ALL` hitting a 040 table: `columnAcl` in test 4 fails.
- **beforeAll cannot silently skip work.** The migration file is read first, so ENOENT throws. Every apply or degrade error is captured and rethrown after the restore. Restore failures are rethrown, and when both an apply and a restore fail the error combines both.
- **Restore meets plan step 8:** `ROLLBACK` first, then one transaction that revokes and re-grants the three roles' table, column and schema-public default entries (WITH GRANT OPTION preserved), drops both probes, and checks the table and column entries plus the FULL `pg_default_acl` against the originals.
- **migrations-log:**
  - The head moves 121 → 122 and next → 123.
  - The entry carries **LOCAL-ONLY** in the form the header convention requires.
  - It sits next to 121, the same placement as the existing 121/119 entries.
  - The baseline, "why safe", version-guard limit and "no SchemaRequirement" statements are accurate.
- **`MIGRATION_SHAPE_FILES`** gains the suite with a reason comment.
- **Allowed surface respected.** All 9 changed paths are inside `allowed_edit_surface`, including the handoff through the plans glob. There are no TypeScript production changes, and no non-goal files (rls-audit, tenant-scope, rls-inventory, older suites) were touched.

## Appendix — non-actionable or uncertain observations

1. **Raw `relacl` is not restored bit-for-bit.** Degrade and restore turn every `public` table whose `relacl` was NULL into an explicit owner-only ACL. Effective privileges and every coalesced comparison are identical. A 119-style `relacl IS NULL` check reads within one run, so it does not break. This is inherent to GRANT, and the plan did not promise NULL restoration.
2. **Test 2's degrade proof is weak.** It checks only `before.clientEffective.length > 0` on each deny-all table, and the four-right grant alone satisfies that. If a later edit removed the suite's `GRANT ALL ON <denyAll>` line (suite:431), test 2 would pass without proving that step 2's DML revoke works. This is a test-harness mutant, not a production one, and it matches the plan's wording. Asserting that `before` contains `anon:SELECT` and `authenticated:SELECT` on each of the twenty would close it.
3. **Production table ownership, global default ACL entries and views were marked "not read"** in the plan baseline. The owner guard fails closed if production has a non-`postgres`-owned table. A production-only global `pg_default_acl` entry would leave new tables still inheriting the four rights, which the goal forbids. The intake's step-8 `pg_default_acl` read on both projects is the detector, and it should include global (`defaclnamespace = 0`) rows, not only schema `public`.
4. **Pre-existing stale comment.** `scripts/ci/live-db-suites-audit.ts:109` says "Five suites test a migration's shape". With 119 and 121 there were already seven before this branch, and 122 makes eight. The branch did not create the drift, but it added an entry without fixing it.
5. **No MAINTAIN proof in the suite.** The claim that REVOKE takes no relation lock rests on the 119 header review. PG16 CI cannot exercise the MAINTAIN branch, which the plan and suite header disclose. The step-8 PG17 zero-count query remains the only proof.
