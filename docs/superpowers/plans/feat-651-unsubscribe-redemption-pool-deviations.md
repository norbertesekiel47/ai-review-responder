# #651 Deviations

## D1 — newly concurrent #652 overlaps the redemption caller

**Detected:** 2026-08-16, before implementation  
**Status:** coordinated; merge order revised before overlapping #651 edits

After #651's first plan revision, the surface guard discovered the newly armed
`feat/unsubscribe-transaction-boundary` worktree. It overlaps
`worker/ingress/unsubscribe.ts`, unsubscribe ingress tests, and
`docs/directory.md`. That branch is ticket #652: it moves transaction ownership
into `redeemUnsubscribeToken`, so its resulting interface directly changes the
caller shape #651 must wire to the dedicated client.

The initial order gave #652 edit priority. That became non-executable: #652 is
uncommitted by workflow design and cannot become #651's Git base without a
separate commit/merge authority boundary; its first full gate also remained red
on lint and promised-test-title bookkeeping even though behavior, type, build,
DB, and coverage checks passed.

**Final merge order:** #651 takes edit and landing priority against the current
caller-owned transaction interface. #652 preserves its uncommitted work without
further overlapping edits, then rebases/adapts its module-owned transaction
change after #651 lands. #651's production caller change remains the minimal
`sql.begin` → `sqlUnsubscribe.begin` substitution; #652 later replaces that
caller transaction with `redeemUnsubscribeToken(sqlUnsubscribe, input)`.

Both orders were communicated to the active Codex task titled **Implement
feature 652**. The matching #652 deviation record is owned by that task. No #652
work was deleted or overwritten.

## D2 — branch review added the zero-downtime rollout capacity case

**Detected:** 2026-08-16, independent branch-review round 1  
**Status:** accepted; owner approved the one-file edit-surface expansion

The initial #651 model counted one 24-slot Railway worker and therefore derived
15 warm Vercel isolates (`24 + 15×11 = 189`). The database/async reviewer found
that this was only a steady-state result: a normal Railway rolling deployment can
overlap two workers, making the deployment model `48 + isolates×11 < 200` and
the rollout-safe bound 13 (`48 + 13×11 = 191`; fourteen reaches 202).

The owner approved adding the authoritative `.claude/reference/env-vars.md` to
the locked edit surface. The intake, plan, ADR, in-code capacity comment, env
reference, and deterministic test now distinguish the 15-isolate steady-state
bound from the 13-isolate rollout bound. The staging gate also requires a real
old/new-worker overlap and a lock-backed positive admission proof; merely firing
three fast requests is no longer treated as evidence that the third queued.

This is a safer operational bound and documentation correction. It does not
change the fixed-two client, route behavior, or shipping authority boundaries.

## D3 — verify-spec audit found a latent tenant-scope coverage gap

**Detected:** 2026-08-17, independent `verify-spec` audit after review round 1  
**Status:** accepted; owner authorized the second edit-surface expansion and
the same-PR fix

`scripts/ci/tenant-scope-audit.ts` recognizes tagged-template queries only on
the db/server exports listed in `DB_SERVER_SQL_TAG_SOURCE_NAMES`, which was
`{sql, sqlRead}`. #651's `sqlUnsubscribe` was not in that set, so a future
`sqlUnsubscribe\`SELECT …\`` would have escaped the audit. No live gap existed —
the only production use is `sqlUnsubscribe.begin(tx => …)` and `tx` is a base
tag — but #477 added `sqlRead` to that set for exactly this reason
(`docs/superpowers/plans/feat-477-split-pg-pools-poolwait-handoff.md`).

The owner chose to fix it in this PR rather than a follow-up. The intake's
`allowed_edit_surface` gained `scripts/ci/tenant-scope-audit.ts`, its test
file, `.claude/CLAUDE.md`, `.claude/reference/lab-notes.md`, and
`docs/currents.md`; `tests_to_add` gained the verbatim extraction test. The
fix is one set member plus two regression tests (proven red against the old
set: 2 failed / 55 skipped; green after: 57/57). The same pass corrected the
three doc statements that still said the chokepoint wraps only `sql`/`sqlRead`
(CLAUDE.md gotcha, lab-notes #773 entry, currents.md) and sharpened the
`sqlRead` JSDoc in `server.ts` to say module-owned singletons are gated while
caller-owned poller clients are not.

No route behavior, client sizing, or capacity number changed.
