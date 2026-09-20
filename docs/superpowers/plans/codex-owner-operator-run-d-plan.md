# Owner Operator Run D: outbox resilience and checkpoint closure

**Owner-approved amendment, September 14 at17:35Z:** “Hm actually everything looks good so far, you can stop the observability and proceed, go ahead.” The original full-day duration below is superseded by the actual recorded interval, ending with the final database capture at17:36:31.857381Z after19h50m14.857381s. All24 submitted requests completed; slots20–24 are cancelled. Keep the original duration visible as historical intent and report `full_24_hours_elapsed=false`. This changes only the observation duration; recovery verification, teardown, final gates/reviews, shipping, and separate docs closeout remain required. See `observation-owner-early-close.json` in the Run D evidence assets. No additional plan-review round, review budget, product behavior, or production flag change is authorized or needed for this explicit owner decision.

Base: `5927c3eb05c692fe25491e35f2cadf830fa7a5cb` (C closeout #1279). C feature #1278 and its separate closeout are merged before this run starts. Worktree: `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-owner-operator-run-d`. Intake: `codex-owner-operator-run-d-intake.json` beside this plan. Spec: `docs/roadmap/2026-09-11-owner-operator.md`, §5.2, §12.1 items 2/6/10, §14 CA1/CA4.

## 1. Locked intent, deltas and authority

The owner authorized completion and shipping of C, D and E in sequence. Preserve that authorization; no new shipping question is required. Development and independent reviews use native Codex only. The original Opus routing was explicitly superseded. Browser evidence uses the approved in-app Browser. Console (Harbor), all Run A/B decisions, the existing model/cost seam, and production Operator disabled remain locked.

CA1 uses the ticket's preferred coupled terminal transition. The poller has no rule forbidding topic-aware handling. CA4 keeps the generic watchdog unchanged: the worker already releases its claim and delays the same BullMQ job every 10 seconds; the missing behavior is a fenced refresh of the outbox's liveness timestamp during healthy waits. No waiting status, new scheduler, queue, dependency or migration is needed.

Supporting files are explicit in the initial intake: the closed failure vocabulary, UI wording/recovery test, existing poller and worker tests, and standard plan/review/evidence documentation. These are necessary to deliver the named failure reason and verify it. No separate product feature is added.

The surface overlap warning names C's completed worktree. Its feature state is shipped and its source already landed as #1278. There is no concurrent editing lease there. C → C closeout → D is the agreed merge order; keep C evidence intact.

## 2. Design and test seams

Use the existing `turns.ts` module for turn lifecycle writes; do not add another lifecycle module. Use the current OutboxPoller exhaustion owner and watchdog transaction. The `codebase-design` review favors small transaction-receiving operations over a generic hook framework. The public worker and poller phases are the behavior test seams.

Production churn is estimated at 160 lines and test churn at 420. Most added code is ownership/rollback coverage for two recovery paths; existing helpers and dispatch logic are modified in place. A new integration file is justified only if driving `pollOutbox` with mocked queue transport would contaminate the existing watchdog-only suite. No new production file is planned.

### CA1: recoverable live claims and coupled terminal exhaustion

`OutboxPoller.markDispatchFailed` currently updates exhausted `dispatching` rows with an exact ID/attempt CAS, but leaves `agent_turns` untouched. Wrap the exhausted branch in `sql.begin`, add `completed_at`, and obtain actual CAS winners from `RETURNING`. Only those stored rows can authorize the domain transition. Never trust the input entry list as proof of ownership.

For each winning row with topic/aggregate type `agent_turn`, match the accepted turn by stored aggregate ID, payload turn ID, account ID and conversation ID. Validate the account UUID before its typed tenant predicate and compare the other JSON identity strings to UUID text. A malformed or foreign identity matches nothing and cannot poison unrelated entries in the same batch. The same transaction sets the matched accepted turn to `failed`, reason `dispatch_exhausted`, clears its claim token, and stamps completion time. No migration is required: migration 120 stores unrestricted nullable failure text; `schema.ts` owns the closed application vocabulary.

Do not use `failTurnIfNonTerminal` unchanged: its accepted-or-running predicate could fail a live worker when an enqueue timed out after Redis actually accepted it. A valid nonterminal turn must retain a recoverable outbox unless both records terminalize in the same transaction. Read and lock the bound turn using `FOR UPDATE SKIP LOCKED` after the outbox CAS. An accepted turn fails atomically. A running turn whose existing 180-second lease expired may also fail while this lock owns its current claim; a live running turn survives and the same transaction restores its outbox to `dispatched`, clears completion time and refreshes `dispatched_at` without spending attempts. The poller passes the existing worker lease constant explicitly into the lifecycle helper. Completed and already failed turns retain their results.

If the bound turn cannot be locked, use a nonlocking, account-scoped identity read to distinguish temporary contention from absence. A matching nonterminal turn causes the same recoverable deferral; a missing or terminal turn needs no domain write. Never treat `SKIP LOCKED` as proof of absence. This avoids deadlocking against existing turn-to-outbox completion while preserving recovery after an enqueue timeout followed by a worker crash. Subsequent watchdog exhaustion revalidates the current claim under lock and terminalizes an expired lease. Its failed count excludes rows restored to dispatched.

Apply the same lifecycle decision to actual rows terminalized by the existing watchdog, in that watchdog transaction. Preserve its current retry/stale-dispatching behavior and bounded last_error preservation. Other topics stay unchanged. No separate sweeper is added.

The helper receives an open transaction, stored winning outbox identity and the lease duration. The poller phase stays the owner of retry/terminal decisions. Tests drive the production dispatch-failure phase with an explicit database client, following the existing watchdog seam. The first full-poller harness refused to run because it found ten unrelated pending billing fixtures; preserve those rows. Exporting `runOutboxDispatchFailure(db, entries, errorMsg, logger)` permits isolated real-database verification, while the existing poller unit test proves queue-failure wiring. T2 applies the same explicit-client seam to existing topic dispatch (`runOutboxTopicDispatch`), including all error and acknowledgement paths, so the actual worker can run inside a fake `addBulk` callback before acknowledgement. The intermediate dispatching timestamp is asserted before that callback returns; acknowledgement cannot mask a missing heartbeat. A narrow independent Codex seam consultation confirmed this design. This is phase integration with fake transport, not a real Redis delivery claim.

### CA4: healthy waiting proves liveness without spending retries

Make the existing `releaseTurnClaim` operation own its transaction, taking the claimed turn/account/token and this dispatch's outbox ID/attempt. Both existing callers (predecessor wait and transient error) use it; T2 adds a named option to refresh liveness for a healthy predecessor wait only. Return `released`, `failed`, or `lost` so callers cannot confuse a terminal reconciliation with a successful delay. A missing attempt is a no-op for this ownership-sensitive path; actual Operator dispatches always carry a number.

Inside one transaction, lock the exact current outbox attempt in `dispatching`, `dispatched`, or `failed`, then acquire the matching running turn using `FOR UPDATE SKIP LOCKED` with its account and token. `dispatching` is legitimate: BullMQ may start the worker before `addBulk` resolves and the poller marks the row dispatched. The nonblocking turn lock prevents the new outbox→turn path from deadlocking with existing turn→outbox fenced completion. If either ownership check loses, return `lost` without changing liveness or claim state. Bind the outbox payload/aggregate to this same turn/account/conversation as defense against a mismatched handle. Pending, completed, superseded or malformed handles authorize no release.

Only after both locks succeed, release the turn to accepted, decrement its claim attempt, and clear token/claimed_at. If the exact outbox is already failed, perform the accepted-only `dispatch_exhausted` transition in the same transaction and return `failed`; this is the owning worker yielding, not the poller killing live work. This reconciliation applies to both predecessor and transient release, preventing a failed outbox from leaving an accepted turn that the watchdog and failed hook can no longer recover. A worker that finishes successfully still keeps its fenced result.

For a dispatching/dispatched predecessor wait, refresh `dispatched_at = NOW()` without changing its status and return `released`. Normal transient releases do not refresh liveness and return `released`. All domain/liveness writes commit or roll back together. The predecessor caller delays only after `released`, using the existing `moveToDelayed(Date.now() + waitMs, job.token)` plus `DelayedError`; its `failed`/`lost` result returns without delay or model work. The transient error caller suppresses retry only for explicit `failed` reconciliation and rethrows the original error after either `released` or `lost`. This preserves retries when `moveToDelayed` fails after the predecessor path already cleared its token: the second yield returns `lost`, which must not turn a Redis scheduling failure into successful BullMQ completion.

This refresh occurs only when a real worker rechecks a nonterminal predecessor. It does not run independently and cannot keep a crashed job alive. A crash after the transaction but before Redis delay is recovered by BullMQ or the unchanged watchdog once the last refresh ages out. A rejected `moveToDelayed` follows the existing retry path; the released turn remains claimable. `attemptsMade` and outbox dispatch attempts are unchanged by healthy waits.

Keep the existing predecessor-stall check and its age definition. Test its limit independently of the heartbeat; refreshing this turn's outbox must not reset the predecessor's age. The 180-second lease, 1200-second predecessor stall, and 10000-ms wait remain provisional until T5 measures the full day.

## 3. Tracer sequence

T1 runs alone, including its tests and root diff review. T2 follows T1. T3/T4 depend on the verified T1/T2 candidate being deployed to staging. T5 records the full observation interval and constants decision. T6 closes documentation. At most six tracers. No Run E work starts before D and its docs closeout merge.

### T1 — Coupled dispatch exhaustion and owner recovery

Files: OutboxPoller, `turns.ts`, `schema.ts`, existing/new OutboxPoller integration tests within the intake glob, Operator wording and its existing component test. Add the dispatch failure sentence and fresh-conversation action using the current failure renderer; no layout redesign.

Red/green tests (exact intake titles):

- `dispatch exhaustion fails only the accepted turn owned by the winning outbox attempt`
- `dispatch exhaustion rolls back the outbox transition when its turn update fails`
- `dispatch exhaustion preserves running and terminal turns after an ambiguous enqueue failure`
- `dispatch exhaustion ignores mismatched account and aggregate identities`
- `watchdog exhaustion terminalizes an accepted Operator turn in the same transaction`
- `operator dispatch exhaustion renders a recovery action from the durable transcript`
- `a worker crash after ambiguous dispatch exhaustion remains recoverable by the watchdog`
- `dispatch exhaustion defers a locked turn without deadlocking fenced completion`

Cover stale attempt, retryable rows, other topics, malformed payload, completed timestamp, double invocation and competing worker claim. T1 also changes the existing claim-release operation and both callers to reconcile an exact failed outbox when a running worker yields, with the exact title `claim release reconciles dispatch exhaustion after a running worker yields`. Exercise predecessor and transient failures, later BullMQ exhaustion, stale token/attempt and rollback; keep healthy wait timestamps unchanged until T2. Use `abortingExecutor` for a real PostgreSQL aborted transaction without DDL. Follow schema-ready fixtures, `describeWithDb`, tenant cleanup and the existing cross-process local DB lock. Completion requires narrow tests green and root review of the entire T1 diff.

### T2 — Fenced predecessor waiting

Files: `turns.ts`, AgentTurnWorker, constants comments only until measurements, worker unit tests and `turn-worker.integration.test.ts`. Precedents: `releaseTurnClaim`, `lockDispatchedOutboxAttemptIfOwned`, current delayed-job handling.

Red/green tests:

- `healthy predecessor waits survive the watchdog window without redispatch or retry spending`
- `predecessor wait ignores a superseded outbox attempt and a stolen turn token`
- `predecessor wait rolls back both liveness and claim release on a database failure`
- `a crashed predecessor wait is recovered by the unchanged watchdog`
- `predecessor delay failure preserves a retryable turn and outbox`
- `predecessor wait handles a worker starting before dispatch acknowledgement`

Use database timestamps and a controlled clock rather than sleeping 15 minutes. Repeatedly drive the public worker, inspect unchanged attempt budgets and refreshed liveness, then invoke the actual watchdog. Age only the last refresh to prove crash recovery. Drive the real worker from a controlled `addBulk` callback before it resolves, proving claim release and same-job delay while the exact row is dispatching, followed by normal dispatch acknowledgement. The delay-failure case must assert that the public handler rejects with the scheduling error for BullMQ retry, not merely that the row is accepted. Also prove missing/mismatched handles are no-ops, the stall limit still applies, and a turn locked by fenced completion causes the wait to exit without deadlock. Completion requires relevant suites green.

### T3 — Tone Apply changes the next real staging draft

Open a runbook evidence file and teardown ledger before any fixture. Re-read staging flags and deployment SHAs. Use a unique synthetic two-location test account with no public posting connection; auto-approval remains off. Create its Auth identity via the sanctioned test helper, sign in through the in-app browser, and apply a clearly different tone to the first location via a real Operator Proposal. Record the receipt and voice row.

Then introduce one fictional review through a fixture runner calling the existing `processReview` ingest function with `suppressNotification: true`, triggering its real transactional outbox, response-generation worker and cost guard. This explicit option already exists in `process-review.ts:83–90` and suppresses notification enqueue in `response-generation/persist.ts:257–258`; auto-approval remains off. Record review, outbox, run-step, response and API-cost IDs. Preserve immutable synthetic fixture inputs and before/after voice configuration across generation, reconstruct the production prompt with the existing builder from those exact inputs, and record its dynamic tone line separately from the observed stored draft. The static `api_costs` system prompt hash explicitly excludes tone and is not dynamic-input proof. The reconstruction is labelled reconstruction, not a captured provider request. The fresh response/cost chain, stable changed configuration and recognizably matching draft establish the observable result together. Do not count a tone-column read alone as proof. No fabricated response, direct LLM probe, production record, external notification or public post qualifies. Drive the owner-visible receipt and draft at 390px and 1440px. Keep text and screenshots synthetic.

### T4 — Secondary location remains pinned

Use the same designated account's second location. Preflight the staging `agent_turn` BullMQ queue and prove it contains no unrelated active/waiting/delayed jobs. Record its paused baseline and teardown entry, then pause that queue for a bounded browser step (90-second ceiling). Send a real turn with the secondary location selected, read its accepted row with no claim, and move the selector before resuming the queue. Capture selector state and UTC while the turn is still accepted; then resume promptly in a `finally`-protected control path. If unrelated work appears, restore the queue immediately and retry the evidence step later. Never pause production or another queue. Verify the worker's later snapshot/Proposal targets the secondary location, both browser layouts and reload. Evidence must order selector movement before worker claim, not merely before the response appeared.

### T5 — Full-day observation and constants decision

Observe a full, continuously recorded 24-hour interval on a single verified Run D staging candidate. Start/end UTC, UI and worker SHAs, designated account IDs and flags are durable before the first sample. Use bounded synthetic owner turns through the actual authenticated UI distributed across the interval, approximately hourly (maximum 30 observation turns, in addition to the two checkpoint journeys). Use harmless status requests and controlled paired turns to exercise ordinary and predecessor paths. No direct provider test call or customer source/data is sent by the agent.

Retain every attempted turn ID and its status; report failures/retries separately rather than dropping them from the denominator. For completed turns compute accepted-to-completed p50/p95, sample count/min/max, hourly coverage, outbox wait and model durations from DB timestamps and existing API-cost metadata. State the percentile method (`percentile_cont`) and distinguish the latency of completed turns from success rate. Preserve source data needed to recompute the aggregate after teardown. Read infrastructure health periodically; log outages or redeploys and their effect on the observation rather than silently resetting the clock.

The earlier T8 five-turn sample and C campaigns are historical context only. Do not mark T5 complete before the measured end is at least 24 hours after start. Do not lower safety floors from a small percentile. The lease must cover bounded provider fallback/validation work, and predecessor stall stays above the unchanged recovery window. Retain constants when the sample does not justify a change; record the measured reason. A code-affecting constants change requires a fresh deployed check before closure.

### T6 — Evidence and documentation

Update §12.1 items 2/6/10 with exact observed proof; retain historical failures. Close CA1/CA4 in §14 with source/test references, correct the stale lease wording in §5.2 to the measured decision, and append §15. Add the dated lab-note lesson and relevant existing directory/glossary descriptions when changed. Record PASS/FAIL boundaries without claiming the COO pilot or production enablement.

Execute and verify every teardown row: sign out/delete only the synthetic Auth identity, delete fixture-owned records through account-scoped queries, remove only exact terminal queue jobs, prove zero residual IDs and restore/read back all baseline flags. Preserve the configured C Sentry rule. Stage/production projects are distinct; production is never a fixture target.

## 4. Verification and shipping sequence

All local execution uses `/private/tmp/run-d-local-check.py`, which validates a localhost:5499 disposable database and supplies CI dummy service configuration. No `.env.local` from the source worktree is copied. No live app or watcher may run during mutation verification. Tests use at most two workers. The gate already runs lint, typecheck, build and every `ci:*` audit; the intake extras add the full DB-enabled test run and E2E without duplicating built-in rows. Run the preliminary staging gate with `MAX_PARALLEL=1`, so build finishes before E2E serves it, and retain the wrapper's explicit local DB-write opt-in. These are execution details, not removed checks.

After T1/T2, run the narrow suites and required full build/checks, commit the implementation candidate and run the verified baseline gate. Push that candidate through normal pre-push hooks to staging for T3–T5. This is staging verification, not main promotion. The final PR follows the completed tracers, final gate and review wave.

Before the review wave, take current main, freeze the fork, commit the final candidate and run `bash .agents/skills/feature/scripts/verified-gate.sh --review` as the last serialized check. Required checks include lint, typecheck, full tests/build, tenant/RLS/static-policy/directory/DB audits and E2E. No eval is added for Run D's unchanged model contract. Verification is recorded against the exact committed tree and matching fingerprint.

Dispatch fresh Codex spec/correctness, maintainability and async/operations reviewers plus the high-risk adversarial pass in one bounded wave (four concurrent slots including root means the root may run the adversarial member while three reviewers run). Reviewers read the frozen commit with `git show`, write reports only in review staging, and receive their finding checklists. Root edits nothing until all finish and the root runs the mutation finalizer. Triage every finding, apply accepted fixes, and follow the scoped second adversarial round only when required. The normal two-round cap applies; C's scoped fourth-round exception grants nothing to D.

Commit review evidence, run the full review gate last to refresh its fingerprint, transition reviewed, then open a draft PR to main. Mark ready, wait for required CI, merge the exact reviewed head by squash, realign staging to main and verify deployed behavior. Open and merge a separate documentation closeout PR with architecture counter increment. Current architecture counter is 1; run the architecture pass if it reaches the owner's threshold before the next run.

## 5. Review record

The first preliminary gate passed31/32 checks, including15926tests, build and E2E; only the required merge-ledger entry was missing. The owner approved `/private/tmp/run-d-docs-scope-proposal.md` with “Go for it.” This authorizes the second file-list amendment adding only `.claude/reference/arch-review-log.md`, its exact pre-merge entry without a counter increment, and one fourth Codex plan verification limited to that documentation correction and intake consistency. Further plan rounds remain blocked. D's normal two-round adversarial cap is unchanged. No additional production behavior or path is included.

Formal round 3 APPROVED the revised crash-recovery contract; report `docs/reviews/codex-owner-operator-run-d/plan-review-round-3.md`. T1 and T2 local root-review records retain their red/green tests and full-build result. The final independent implementation wave and staging acceptance are still pending. Within-round documentation and test-seam clarifications leave the recorded plan contract unchanged (`contract-changed`: UNCHANGED); no additional plan round is claimed.

Plan revision 1 was reviewed by native Codex `/root/run_d_plan_skeptic`: REVISE. Root ACCEPTED D-PS-1 (dispatching handoff) and D-PS-2 (exact failed-outbox reconciliation on yield), verified against source, and implemented both in revision 2. T3's static-hash limitation and T4's concrete queue control are explicit. The directory owner correction was the first surface amendment. Formal round 2 APPROVED, including rethrowing transient errors after both released/lost outcomes. During T1, an independent crash audit found that preserving a live turn beside an already failed outbox still stranded it if the worker subsequently crashed. Revision 3 above preserves a recoverable outbox for live or contended claims and couples expired-lease failure; it also records the isolated dispatch-phase test seam. The new invariant and two regression titles require formal verification round 3 before this correction is implemented. Allowed paths are unchanged. Earlier reports and test evidence remain intact. Parent intake and shipping authority are inherited from the ticket and the owner's explicit C/D/E completion approval.
