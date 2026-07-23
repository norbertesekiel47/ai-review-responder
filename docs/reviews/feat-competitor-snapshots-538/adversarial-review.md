# Adversarial review (step 6) — feat/competitor-snapshots-538

Reviewer: Codex (/codex:adversarial-review, branch diff vs main, 2026-07-23).
Note: a first run mistargeted the parent checkout's working tree (reviewed the
untracked brand-story.md — findings relayed to owner separately); this report
covers the corrected branch-targeted run. Codex's local command executions
failed on sandbox EPERM (temp IPC dirs) — our gate runs are the execution
evidence.

Verdict: needs-attention (2 findings).

## Finding 1 — [high] "Same-day location edits delete the previous location's pack"
(worker/jobs/RankingTrackingWorker.ts:275-277)

Claim: DELETE by (business_id, keyword, snapshot_date) without search_location
erases the prior-location pack after a same-day ranking_search_location edit;
intake says "old rows keep theirs".

**TRIAGE: REJECTED** — re-litigates plan-review round 1 (same reviewer),
resolved and APPROVED in round 3. The parent ranking_snapshots upsert key is
(business_id, keyword, snapshot_date) and OVERWRITES search_location on
same-day re-run; scoping the child DELETE by search_location would orphan a
same-day stale pack contradicting its parent row. "Old rows keep theirs" in
the intake means prior-DAY rows (which are untouched). Same-day replacement
mirrors the parent by design; #532's business+keyword+search_location key is
the read-side comparison filter.

**Accepted sub-actions:** (a) regression test pinning the replace-key shape
(DELETE carries exactly business_id, keyword, snapshot_date; reinserted rows
carry the new search_location); (b) intake edge-case wording sharpened to
"prior-day rows keep theirs; a same-day re-run replaces that date's pack under
the new location, mirroring the parent upsert".

## Finding 2 — [medium] "Migration cannot recover from partial or repeated application"
(supabase/migrations/084_competitor_snapshots.sql)

Claim: unguarded CREATE TABLE / CREATE INDEX; a partially applied manual run
cannot be retried; inconsistent with repo convention.

**TRIAGE: ACCEPTED — CONFIRMED.** Migrations 071/073/076/081 all use
CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS. Fixed by amending 084
(genuinely unapplied to staging/prod; local test DB compatible with IF NOT
EXISTS). Amendment performed under the immutability guard's documented
premature-log-bump provision: head reverted 084→083 in migrations-log, file
amended via Edit, head re-bumped — no Bash writes.
