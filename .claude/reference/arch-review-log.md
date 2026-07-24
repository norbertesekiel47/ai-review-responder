# Architecture review log

Entropy counter for the `/feature` workflow (feature.md step 8): every merged
feature increments the counter. At **≥ 5 merges** since the last architecture
pass, the orchestrator reminds the user to schedule an architecture review
session (the user's call — never started automatically). A completed pass
resets the counter to 0 and adds a row below.

**Merges since last architecture pass: 0**

| Date | Trigger | Scope reviewed | Outcome |
|------|---------|----------------|---------|
| 2026-07-17 | baseline (log created) | — | counter initialized |
| 2026-07-24 | 8 merges ≥ 5 threshold (#508, #514–#516, #551, #554, #561, #564) | Solicitation subsystem (restraint policy, ingest lane, planned executor #543) + the reliability wave | 6 findings, no blockers. **S1** csv_ingest advisory-lock key has two independent owners (`acquireCsvIngestLock` vs the inline literal in `worker/jobs/csv-ingest/failed-hook.ts:63`) — a rename silently splits the lock and the suite stays green; export one owner. **S2** `contact_csv_uploads` terminalization written 3× (ingest.ts:343, ingest.ts:377, failed-hook.ts:75); fold into one module during #543, which adds a 4th writer to that tx. **S3** (#543, pre-build) the working-tree D4 revision creates the batch row with `built_at = NULL` and filters owner reads to built rows, but D4 still forbids a status column and an expiry poller — a build that exhausts retries is permanently invisible with nowhere to record the failure. **S4** (#543, pre-build) D2's fan-out is bounded only by `MAX_DATA_ROWS`=5,000 → ~15k inserts in one job/tx; `BATCH_CAP`=25 caps sends, not evaluations. **R1** the single-replica invariant now carries 4 load-bearing mechanisms (`assertSingleConcurrencyWorker`, `assertSummedLlmWorkerSlots`, overage OVERAGE-F1, and — new in #515 — the in-process LLM circuit breaker) with zero mechanical guard; `railway.toml` has no `numReplicas` and nothing fails if one appears. **R2** outbox enqueue seam covers 13 typed helpers vs 28 production files hand-writing `INSERT INTO job_outbox`; `ci:outbox-topics` checks only the topic literal. Tracked already, not re-raised: #555 (restraint-policy date fail-open), #565 (contacts-lane complexity). Health: maintainability 92.3, duplication 1.6%, zero scope findings in repo-wide `fallow health` (local CRAP unavailable — `coverage-final.json` dated Jul 16 predates every reviewed PR). |
