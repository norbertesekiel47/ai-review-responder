# Lab notes — Owner offboarding

## Summary

- **Owner offboarding** — `railway up` from a worktree ships stale worker code (`OutboxPoller: Unknown topic`); Stripe Basil/Dahlia moved `current_period_end` onto the subscription item; `approval_audit_log` has no `approval_link_id`/`user_agent` (mock-asserted SQL *text* hid the drift); keep-my-data must be exempt from the blanket `/api/account/*` owner-API proxy gate; the `purge_after` token-expiry trigger blocks shrinking the purge window while a keep-my-data token is live, and the purge poller's claim carries its own active-token `NOT EXISTS` because the window override widens the predicate without writing `purge_after` (#614, history/2026-09.md); **the purge VERIFIER is a gate, not a report** — it throws inside `finalizePurgeInTransaction`, so a blind predicate is an open gate and a newly-strict one BLOCKS a legitimate purge, and its `businesses` residue list has two shapes ("was cleared" vs "was set to X"), the second of which needs `IS DISTINCT FROM` on a nullable column or a nulled value passes silently — `archived_at IS NULL` is the only predicate that can catch a row the tombstone never touched at all (#665, 2026-08-18)

## Canonical entries

_None yet — the Summary bullet is the current rule; see History for the dated evidence._

## History

- history/2026-05.md § "A long-lived audit FK can block a prune (`ON DELETE SET NULL`)"
- history/2026-06.md § "2026-06-08 — Owner offboarding (staging dry-run + live E2E)"
- history/2026-06.md § "`railway up` from a nested git worktree ships STALE worker code → `OutboxPoller: Unknown topic`"
- history/2026-06.md § "`approval_audit_log` has NO `approval_link_id` / `user_agent` columns"
- history/2026-06.md § "keep-my-data must be EXEMPT from the blanket `/api/account/*` owner-API proxy gate"
- history/2026-06.md § "Shrinking `purge_after` for a test is blocked while a keep-my-data token is live"
- history/2026-07.md § "[2026-07-26] The `csv_ingest` advisory-lock contract is a STATUS-TRANSITION contract, not a table contract — the offboarding purge deletes unlocked, so a 0-row terminal write is tolerated on purpose (#582)"
- history/2026-08-13-to-21.md § "2026-08-18 — #665/#662 fix: a gate that could not see, and an audit that was never asked"
- history/2026-08-13-to-21.md § "[2026-08-18] A tombstone column that RESTORES a default needs `IS DISTINCT FROM`, not `<>` — and the residue-predicate idiom hides that"
- history/2026-08-13-to-21.md § "[2026-08-18] The purge verifier is a GATE, not a report — it throws inside the finalize transaction"
- history/2026-08-21-to-31.md § "2026-08-26 — #967 post-purge global opt-out"
- history/2026-09.md § "[2026-09-02] A mocked characterization test over emitted SQL is BLIND to foreign keys — and can pin a bug as correct"
- history/2026-09.md § "[2026-09-02] Deferred FKs make a delete order correct only INSIDE a transaction"
- history/2026-09.md § "2026-09-06 — #614: a trigger on `UPDATE OF purge_after` guards nothing when the window is widened by a predicate"
