# Architecture review log

Entropy counter for the `/feature` workflow (feature.md step 8): every merged
feature increments the counter. At **≥ 5 merges** since the last architecture
pass, the orchestrator reminds the user to schedule an architecture review
session (the user's call — never started automatically). A completed pass
resets the counter to 0 and adds a row below.

**Merges since last architecture pass: 3** (#640 — #625 consent ledger, 2026-08-01; #647 — #643 suppression ledger, 2026-08-03; #654 — #644 unsubscribe opt-out, 2026-08-03)

Scope the next pass should cover: the four findings this pass opened — **#590** (gate-wiring drift: `ci:*` set spelled out in three unsynchronised places), **#591** (two worker suites forked the shared `sql` mock), **#592** (`exec` blind spot in the SQL vocabulary audits), **#593** (`solicitation_asks.evidence` discriminant enforced at read, not write) — plus whether #590's meta-audit actually closed the "checks that appear to run but exercise nothing" class, and the still-open **#581**, **#582**, **#587**.

Added by #647 (#643), for the next pass to weigh — three workflow-mechanism
findings, none blocking, all recorded in `lab-notes.md` under "2026-08-03":

- **`verify-gate.sh` does not own its DB precondition.** An intake could declare
  `pnpm test:db:setup` — which DROPs schema `public` — as a `verification_command`,
  and the gate launches those in parallel with the `test` row. It produced a fully
  spurious RED. Candidate fix: run DB provisioning serially before the fan-out, or
  reject destructive commands from `verification_commands`.
- **`migration-immutability-guard.sh` keys on the migrations-log head, not on
  "applied".** Every in-place amendment of a local-only migration is a false
  positive, and this workflow produces that shape whenever the migrations-log task
  runs before the ship lane. Candidate fix: a per-entry applied marker.
- **`reclassify` counts workflow artifacts against the implementation they
  describe.** #643 fired at 2.94× with production code at 435 lines and 37/37 files
  in-surface; 1,537 of the counted lines were the plan, deviations, intake and
  handoff. Candidate fix: exclude `docs/superpowers/plans/**`, and budget
  production and test volume as two separate estimates.

Also carried, not a code finding: the RISK=high lane's staging ride makes
`git merge --ff-only main` structurally impossible afterwards — `main` gets a
squash commit while `staging` carries a real merge, so reconciling needs a
verified-identical-trees `reset --hard` + `--force-with-lease`. This will recur on
every high-risk feature; feature.md step 8's post-merge instruction should say so.

Added by #654 (#644), for the next pass to weigh. **The staging-reconcile item above
recurred exactly as predicted** — `staging` ended 61 ahead / 1 behind after the squash
merge and needed `reset --hard origin/main` + `--force-with-lease`. Second occurrence, so
it is no longer a hypothesis; `deployment-guide.md` step 5 does document the reset, but
feature.md step 8 still says "fast-forward `staging` onto `main`", which is the instruction
that cannot work. One code finding and two workflow-mechanism findings:

- **`inject`-only suites are structurally blind to the raw request line — and one such
  blind spot was hiding a live limiter bypass for all five ingress providers.** Absolute-form
  request targets (RFC 9112 §3.2.2) resolve normally through `find-my-way` while leaving
  `request.url` absolute, defeating the decoded-path arm of the ingress-scope test; a
  mutation run reported the surviving arm as dead logic because `app.inject()` normalises
  the target and every rate-limit test in the repo goes through it. Closed for #644 with a
  real-socket test. **The pass should ask what else assumes a normalised request line** —
  signature verification, path-prefix auth checks, and the WAF-adjacent rules are the
  candidates, and none of them has a raw-socket test today.
- **`feature-cleanup.sh` silently cleans nothing when run from inside a feature worktree.**
  It derives `MAIN_ROOT` from its own cwd and then skips `[ "$WT" = "$MAIN_ROOT" ]`, so the
  worktree you are standing in — the one that just merged — is the one it cannot remove. It
  reports SKIP/KEEP rows for everything else and exits 0, which reads as success. Candidate
  fix: resolve `MAIN_ROOT` from `git worktree list`'s first entry (the real main checkout)
  rather than `rev-parse --show-toplevel`, or refuse to run from a non-main checkout.
- **feature.md step 8's post-merge sweep is described as impossible from the shipping
  session, and it is not.** #643's lab note concluded the sweep "must run from the main
  checkout AFTER `feature-cleanup.sh` removes the worktree". That route was unavailable here
  (main checkout on an unrelated branch; cleanup skips its own worktree). Parking
  `.feature/intake.json` and branching the shipping worktree off `origin/main` satisfies both
  guard rules — same checkout for containment, no intake for arming — and needs no
  launch-time env var. Candidate fix: document park-and-branch as the sanctioned route, and
  note that the branch must come off `origin/main`, since local `main` lags every squash merge.

| Date | Trigger | Scope reviewed | Outcome |
|------|---------|----------------|---------|
| 2026-07-17 | baseline (log created) | — | counter initialized |
| 2026-07-24 | 8 merges ≥ 5 threshold (#508, #514–#516, #551, #554, #561, #564) | Solicitation subsystem (restraint policy, ingest lane, planned executor #543) + the reliability wave | 6 findings, no blockers. **S1** csv_ingest advisory-lock key has two independent owners (`acquireCsvIngestLock` vs the inline literal in `worker/jobs/csv-ingest/failed-hook.ts:63`) — a rename silently splits the lock and the suite stays green; export one owner. **S2** `contact_csv_uploads` terminalization written 3× (ingest.ts:343, ingest.ts:377, failed-hook.ts:75); fold into one module during #543, which adds a 4th writer to that tx. **S3** (#543, pre-build) the working-tree D4 revision creates the batch row with `built_at = NULL` and filters owner reads to built rows, but D4 still forbids a status column and an expiry poller — a build that exhausts retries is permanently invisible with nowhere to record the failure. **S4** (#543, pre-build) D2's fan-out is bounded only by `MAX_DATA_ROWS`=5,000 → ~15k inserts in one job/tx; `BATCH_CAP`=25 caps sends, not evaluations. **R1** the single-replica invariant now carries 4 load-bearing mechanisms (`assertSingleConcurrencyWorker`, `assertSummedLlmWorkerSlots`, overage OVERAGE-F1, and — new in #515 — the in-process LLM circuit breaker) with zero mechanical guard; `railway.toml` has no `numReplicas` and nothing fails if one appears. **R2** outbox enqueue seam covers 13 typed helpers vs 28 production files hand-writing `INSERT INTO job_outbox`; `ci:outbox-topics` checks only the topic literal. Tracked already, not re-raised: #555 (restraint-policy date fail-open), #565 (contacts-lane complexity). Health: maintainability 92.3, duplication 1.6%, zero scope findings in repo-wide `fallow health` (local CRAP unavailable — `coverage-final.json` dated Jul 16 predates every reviewed PR). |
| 2026-07-27 | 5 merges ≥ 5 threshold (#570, #571, #574, #575 — map-#528 completion wave; #583) + the #585/#586/#588/#589 debt sweep | map-#528 wave (run-engine executor, rival picker, Requests watch-mode, competitor delta digest), the debt sweep's four closures, and the CI/measurement surface (`ci:*` audits, fallow gate, `.claude/reference/*` allowlists) | 4 new findings, no blockers. **Carried-forward closures all confirmed.** R1 closed by #586 — `railway-replicas` rule at `scripts/ci/static-policy-audit.ts:790` + `worker/config/replica-identity.ts` wired from `worker/index.ts`/`worker/sentry.ts`; *detection without enforcement is the right posture* — Railway injects a per-replica id but no replica count, so no process can assert it is alone, and the one mechanically blockable path (config-as-code) IS blocked. #587 correctly scopes the residue. R2 closed by #588 — *verdict holds*: 15 typed helpers vs 29 files writing raw `INSERT INTO job_outbox`, and `src/lib/shared/job-outbox-status.ts` documents why a fragment seam would have been actively wrong (a bind parameter inside `ON CONFLICT … WHERE` defeats partial-index inference), so guarding the vocabulary is the correct seam. S1/S2 closed by #565 (`acquireCsvIngestLock` exported at `ingest.ts:380`; single terminal writer at `ingest.ts:394`). S3 shipped as built *with an answer* — `worker/jobs/solicitation-batch/failed-hook.ts` records an exhausted build on the run spine via `failSolicitationBatchRun`, so it is not "nowhere recorded"; not re-raised. **New: #590** (HIGH) `ci:live-db-suites` (`package.json:39`) is wired into neither `.github/workflows/ci.yml` nor `lefthook.yml` — the only one of 15 — while CLAUDE.md and #585's commit body both claim CI enforcement; the general defect is that the `ci:*` set is hand-spelled in three places with nothing forcing agreement, and `scripts/verify-gate.sh:60` already derives it correctly in the one place that does. This is the mechanism behind the #581 class (local vs gating signal divergence). **#591** (HIGH) `RankingTrackingWorker.test.ts:23` / `WeeklySummaryWorker.test.ts:34` fork the shared `createMockSql()` harness for a body-specific `jsonb_array_elements` string sniff, justified by a false claim that `vi.hoisted` cannot reach a shared helper (`worker/__tests__/helpers/mock-sql.ts:8-14` documents the async-import form; `judge-store.test.ts:3-7` uses it; 100 files consume it). **#592** (LOW) `sql-tag-scan.ts:17` omits the `exec` SqlExecutor spelling that the fragment builders now use — no violation today, expired precondition. **#593** (LOW) `solicitation_asks.evidence` discriminant enforced by a throw in `batch-view.ts:94` with no CHECK at `088:155`. Already tracked, not re-raised: #581, #582 (verified still open — `purge-stages.ts:256` deletes `contact_csv_uploads` unlocked), #587. Health: score 77 B, maintainability 92.2 (good), duplication 1.7%, 0 churn hotspots, dead files 0.3%; 14 refactoring targets (3 high), 153 high-complexity functions. Repo-wide CRAP is **not quotable** per #581 — fallow matched Istanbul coverage for only 5,665 of 24,082 functions, so unmatched functions are estimated from export references. |
