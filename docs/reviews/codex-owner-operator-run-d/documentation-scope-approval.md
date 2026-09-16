# Run D documentation-only scope correction

The committed T1/T2 candidate is c48bb6a6. Its complete preliminary gate passed all checks except merge-ledger: 15,926 tests passed, 11 skipped; build and E2E passed. The missing path was an intake omission by the agent.

Proposed change:

1. Add only `.claude/reference/arch-review-log.md` to D's allowed file list and identical intake copies. Record this as the second surface amendment.
2. Insert the exact entry below immediately after the ledger title. Do not change the counter; it remains 1 until D's separate post-merge closeout.
3. Run one additional, documentation-only Codex plan verification (round 4). Its scope is this single path, the entry's truthful status, and intake consistency. No new product design or implementation review is included. Further plan rounds remain blocked.
4. Commit the documentation correction and rerun the required gate, then continue the already-authorized staging work. D's normal two-round adversarial verification cap remains unchanged.

Exact ledger entry:

2026-09-13 — **Owner Operator Run D (staging candidate; not merged):** Couples dispatch exhaustion to the bound accepted/expired Operator turn in the winning outbox transaction. Live or contended claims retain a recoverable dispatched outbox; predecessor waits refresh the exact dispatch attempt atomically with claim release, including worker delivery before enqueue acknowledgement. Delay failures preserve retries. Adds `dispatch_exhausted` recovery wording and isolated real-DB crash/lock/rollback proofs. No migration or production flag flip. Full-day staging evidence and merge are pending; counter remains 1 until the separate post-merge closeout records this run.

Authority requested: this second file-list amendment and one narrowly scoped fourth plan verification for Run D. Existing C approval is not being reused to extend D's review budget.
