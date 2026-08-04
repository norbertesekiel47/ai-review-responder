Round-2 verification found the accepted schema fixes sound, but MEDIUM-2 still has a residual gap.

| # | Result | Evidence |
|---|---|---|
| 1 | VERIFIED | `correctSuppression` remains one statement: `DELETE … RETURNING` feeds `INSERT … SELECT` with all three new columns. With no filter or conflict-ignore, zero returned rows means only that the PK delete matched nothing; constraint failures throw and roll back the delete. [suppressions-service.ts](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-645-manual-suppression-paths/src/lib/admin/suppressions-service.ts:200) |
| 2 | VERIFIED | `account_id UUID NULL`, `created_by_user_id UUID NULL`, and `note TEXT NULL` correctly mirror their source types and optionality. The correction table declares no foreign keys. [migration 098](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-645-manual-suppression-paths/supabase/migrations/098_solicitation_suppression_corrections.sql:64) |
| 3 | VERIFIED, limited | `retain_compliance_limited_pii` with whole-row retention is appropriate. The verifier is not vacuous: it detects an account-scoped correction whose `account_id` was wrongly nulled while its creator still identifies the offboarding account. It cannot prove retention after deletion, full scrubbing, or creator/note-only scrubbing—an acknowledged limitation of post-purge violation counting. [table-disposition.ts](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-645-manual-suppression-paths/src/lib/account-offboarding/table-disposition.ts:403), [purge-verification.ts](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-645-manual-suppression-paths/src/lib/account-offboarding/purge-verification.ts:665) |
| 4 | VERIFIED | No tenant-scoping hole found. The correction-history lookup is deliberately cross-tenant behind `requireAdminWithAal2`; the correction mutation has the same admin boundary. No owner-facing query reaches this table. The tenant-scope audit passed with 420 entries. [allowlist](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-645-manual-suppression-paths/scripts/ci/tenant-scope-allowlist.ts:3191) |
| 5 | VERIFIED | No real defect found in the lookup POST, bounded page-ledger probe, shared confirmation controller, or `withScopedContact`. The POST keeps the handle out of URLs; the probe is bounded by distinct handles on the fetched page; mutation URLs remain separate; and the wrapper preserves flag-first, auth, uniform-404, same-origin, and error-mapping behavior. |

The residual MEDIUM-2 gap is concrete:

- Marking persists `created_by_user_id` on the live suppression row. [contacts-repo.ts](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-645-manual-suppression-paths/src/lib/solicitation/contacts-repo.ts:250)
- An admin Correction-path deletion now snapshots that creator correctly.
- But the ordinary owner-clear path still uses `RETURNING id` only, then writes the clearer’s identity and the deleted ID. It does not retain the original marker or marking time. [contacts-repo.ts](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-645-manual-suppression-paths/src/lib/solicitation/contacts-repo.ts:294)
- Therefore MEDIUM-1’s snapshot closes admin correction, not owner clearing. After owner clearing, the original marking actor is still lost.

Verification: clean worktree; lint PASS; typecheck PASS; full test PASS—10,522 passed, 235 DB-gated skipped; focused regressions PASS—69 passed, 3 DB-gated skipped; tenant-scope PASS; static RLS audit PASS; build PASS. Live-DB validation was unavailable because `TEST_DATABASE_POOL_URL` was unset.

VERDICT: REVISE