# Independent database / tenancy review

VERDICT: PASS — no actionable introduced database or tenancy defect found at 80% confidence or higher.

Fixed comparison: `87591310acb2a0a6edddd2bc8b5ff0cd24c9e301` → `2ac6ff871b4496f996c37aaaaade9bdc7eee9a62`. Read committed source and diff only. No tests, DB operations, implementation edits or external writes were performed.

## Evidence

- Apply retains one sql.begin per settings-domain execution. Voice locks its account-scoped active business before Proposal; policy locks the account before Proposal. No extracted helper begins a second transaction, imports a singleton, catches new errors, or executes outside the original transaction.
- Voice's current token still uses locked updated_at text. Policy still compares current/prepared/client tokens after reading under the parent lock. Location tokens retain both account-default and location row identities, including absent-row semantics; microsecond-preserving representations are unchanged.
- Voice writer, committed-state read, owner text, Receipt UPDATE and sibling invalidation use the same tx. Policy writer, post-write snapshot, retained-veto read, Receipt and sibling invalidation likewise remain together. A thrown writer/read/Receipt error still propagates through the adopted promise and rolls back; only the unchanged allowlisted pre-mutation writer refusals commit terminal status.
- Applied replay returns the existing stored Receipt before another mutation. Pre-transaction contract rejection retains its pending-only predicate, so a concurrent applied Receipt is not overwritten.
- Restore preparation retains business then account FOR NO KEY UPDATE, followed by source selection/lock and current-state read. Reusable pending Restores are searched under those locks in unchanged order, preserving first matching reuse and old owning-turn identity. Fresh preparation and older-Restore staling remain in one transaction.
- All moved SQL predicates retain account binding and exact location scope. No schema, migration, RLS policy, unique key, outbox topic or audit-writer change is present. Hydrated proposal lookups remain account-scoped.
- Fenced completion still returns before materialization on a lost turn fence, and couples Proposal/Restore/refusal/supersession writes to its existing outbox-completion call. The existing handling of an outbox-ownership miss is untouched.

## Findings

None.

## Limits / uncertain appendix

No live database verification was executed by this reviewer. The supplied full-suite and tenant/RLS audit results were not independently rerun. No plausible introduced race or tenant-scope change remained after comparing the moved branches and query sequence.
