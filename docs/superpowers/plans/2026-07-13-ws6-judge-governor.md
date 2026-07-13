# WS6 — Judge + Governor (Autonomy Watchdog) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the autonomy watchdog — LLM judge over 100% of auto-posted replies, verdict storage, on-flag suspension + owner notice + admin alert, frozen-threshold governor over the outcome stream, admin-only unsuspend, and judge-down downgrade semantics — per the accepted spec.

**Spec (authoritative):** `docs/superpowers/specs/2026-07-13-ws6-judge-governor-design.md`. On any conflict, the spec wins; on conflict with CLAUDE.md invariants or WS4 spec §6 amendments (suspension semantics), those win over both.

**Architecture:** A `JudgeSweepPoller` scans posted auto-policy responses lacking verdicts and enqueues `judge_verdict` outbox jobs; `JudgeWorker` runs the guarded judge LLM call and persists the verdict (reviews-anchored tx), calling the single suspension writer on `flag`. An `AutonomyGovernorScheduler` re-evaluates per-account rolling rates against frozen constants and calls the same writer. The publisher gains a pre-post judge-health gate that downgrades to owner review when the judge is off or unhealthy. WS4's inert `policy_suspended` machinery does the enforcement.

**Tech stack:** Postgres.js (`sql`/`tx` param convention, invariant #15), BullMQ via the transactional outbox, `runLlmTask` seam + `withCostGuard`, Vitest (mocked-`sql` via `worker/__tests__/helpers/mock-sql.ts`; live-DB via `describeWithDb` against the LOCAL container `postgresql://test:test@localhost:5499/test_ws4` — apply 076 there first), migration 076.

**Branch:** work happens on `feat/ws6-judge-governor` (spec + this plan are its first commits). Never push to `main`.

**Every task, non-negotiable:**
- Read the spec section named in the task BEFORE coding.
- **Lock-order law (tripwire-enforced):** reviews → businesses → responses/child rows → agent_runs; "first" = before ANY implicit-FK-lock statement. The `judge_verdicts` INSERT takes implicit FK locks on reviews-lane tables → the JudgeWorker tx anchors `anchorReviewLockOrder` FIRST (spec §2.5). Governor/suspension-only txs take NO review-lane locks (spec §2.6) — keep it that way.
- Brittle allowlists (`tenant-scope-allowlist.ts` + baseline bump, static-policy, tripwire caller lists) land in the SAME commit as the change that needs them.
- `pnpm lint && pnpm typecheck` green before every commit; task-scoped tests green before commit.
- New LLM call sites: invoke the `cost-guard` skill first. Outbox-touching tasks: `outbox-pattern`. Admin UI: `repworth-brand-design`. DB-heavy tasks: `supabase-postgres-best-practices`.
- `ON CONFLICT` clauses byte-for-byte with their partial-index predicates.
- BullMQ job IDs use `_`, never `:`.

---

## File structure (locked)

| File | Responsibility |
|---|---|
| `supabase/migrations/076_judge_verdicts_governor.sql` (create) | `judge_verdicts` table (deny-all RLS), responses scan index, outbox in-flight indexes, `notification_deliveries.entity_id` + claim index |
| `src/lib/shared/__tests__/migration-076-judge-verdicts-governor.integration.test.ts` (create) | Shape suite + double-apply proof (074 precedent) |
| `src/lib/llm/tasks.ts` (modify) | Register the `judge` task (union member already exists) |
| `src/lib/responses/judge-policy.ts` (create) | `JUDGE_PROMPT_VERSION`, versioned system prompt, memoized hash |
| `src/lib/responses/judge.ts` (create) | `judgeResponse(sql, input)` — prompt build + `withCostGuard(runLlmTask('judge'))` + `recordApiCost` |
| `src/lib/responses/judge-store.ts` (create) | Verdict INSERT (`ON CONFLICT (response_id) DO NOTHING`), unjudged anti-join reads, run-id lookup |
| `src/lib/responses/judge-health.ts` (create) | `isJudgeHealthy(sql)` — staleness + error-density signals, frozen constants |
| `src/lib/responses/judge-flags.ts` (create) | `judgeEnabled()` via `readFlag('JUDGE_ENABLED')` |
| `src/lib/responses/__tests__/model-pinning.test.ts` (modify) | Judge task pinned-model block |
| `src/lib/auto-approval/suspension.ts` (create) | `suspendAccountAutonomy(tx, …)` + `unsuspendAccountAutonomy(tx, …)` — the ONLY `suspended_at` writers |
| `src/lib/auto-approval/governor.ts` (create) | Rolling-rate SQL + frozen constants + candidate scan |
| `src/lib/auto-approval/flags.ts` (modify) | `governorEnabled()` |
| `src/lib/approval/audit.ts` (modify) | `AUDIT_ACTION_AUTO_POLICY_REVOKED_JUDGE_UNAVAILABLE` |
| `src/lib/shared/queue-names.ts` (modify) | `JUDGE_VERDICT`, `AUTONOMY_SUSPENDED_NOTICE`, `AUTONOMY_ADMIN_ALERT` |
| `src/lib/shared/worker-types.ts` (modify) | `JudgeVerdictPayload`, `AutonomySuspendedNoticePayload`, `AutonomyAdminAlertPayload` |
| `src/lib/shared/job-outbox-helpers.ts` (modify) | `enqueueJudgeVerdict`, `enqueueAutonomySuspendedNotice`, `enqueueAutonomyAdminAlert` |
| `worker/background/pollers/JudgeSweepPoller.ts` (create) | Scan + enqueue (createGuardedPoll) |
| `worker/jobs/judge/JudgeWorker.ts` + `worker/jobs/judge/failed-hook.ts` (create) | Guarded judge call, reviews-anchored verdict tx, on-flag suspension; exhaustion → `error` verdict |
| `worker/jobs/publisher/judge-gate.ts` (create) + publisher auto-policy path (modify) | Pre-post judge gate → downgrade |
| `worker/background/schedulers/AutonomyGovernorScheduler.ts` (create) | Cadenced governor evaluation |
| `worker/jobs/autonomy-suspended-notice/{AutonomySuspendedNoticeWorker,context,dispatch,errors}.ts` (create) | 4th notice package |
| `worker/jobs/AutonomyAdminAlertWorker.ts` (create) | Internal email + best-effort Sentry |
| `src/lib/notifications/channels/types.ts` + 3 channel impls + `email/templates/autonomy-suspended-notice.ts` + telegram/whatsapp bodies (modify/create) | `sendAutonomySuspendedNotice` seam |
| `src/lib/notifications/delivery.ts` (modify) | `claimAutonomySuspendedNoticeDelivery` (entity_id-keyed, 15-min self-reap) |
| `worker/queues.ts` + `worker/index.ts` (modify) | 3 queues + 3 workers + poller + scheduler registration (injected-`sql` style) |
| `worker/config/startup-assert.ts` (modify) | `JUDGE_ENABLED`, `GOVERNOR_ENABLED` in `SERVER_ONLY_FEATURE_OPTIONAL_BOOLEAN_ENV` |
| `src/app/api/admin/autonomy/suspensions/route.ts` + `src/app/api/admin/autonomy/unsuspend/route.ts` (create) | Admin list + unsuspend composition roots |
| `src/app/admin/autonomy/page.tsx` (create) | Minimal admin queue page (flagged clone) |
| `tests/llm-eval/judge-eval-set.jsonl` + `judge-types.ts` + `judge-load.ts` + `judge-scorer.ts` + run.ts wiring + `__tests__/judge-*.test.ts` (create/modify) | Judge eval lane, offline + `--live` |
| `scripts/ci/tenant-scope-allowlist.ts` (modify, same-commit rule) | Sweep/governor/health scans (`background-global-scan`), admin routes (`admin-after-require-role`), baseline bump |
| `docs/directory.md`, `.claude/reference/env-vars.md`, `.claude/reference/migrations-log.md` (modify) | Contract rows |

---

### Task 1: Migration 076 — judge_verdicts + governor support objects

**Spec:** §2.3. **Files:** create `supabase/migrations/076_judge_verdicts_governor.sql`, `src/lib/shared/__tests__/migration-076-judge-verdicts-governor.integration.test.ts`; modify `.claude/reference/migrations-log.md`.

- [ ] **Step 1:** Read `.claude/reference/migrations-log.md` (mandatory; confirm head=075, next=076), `supabase/migrations/071_agent_run_spine.sql` (deny-all RLS + FK idiom), `074_trust_dial_veto_window.sql` (re-runnable + partial-index idiom).
- [ ] **Step 2:** Write the migration exactly per spec §2.3: `judge_verdicts` (columns/CHECK/`UNIQUE (response_id)`/two secondary indexes/deny-all RLS + `REVOKE INSERT, UPDATE, DELETE ON judge_verdicts FROM authenticated`), then:

```sql
CREATE INDEX IF NOT EXISTS idx_responses_auto_policy_posted
  ON responses (posted_at DESC)
  WHERE status = 'posted' AND approval_method = 'auto_policy';

CREATE UNIQUE INDEX IF NOT EXISTS idx_jo_judge_verdict_inflight
  ON job_outbox (topic, aggregate_id)
  WHERE topic = 'judge_verdict' AND status IN ('pending', 'dispatching', 'dispatched');

ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS entity_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS notification_deliveries_autonomy_suspended_claim
  ON notification_deliveries (entity_id, channel, recipient)
  WHERE entity_id IS NOT NULL AND template = 'autonomy_suspended_notice';

CREATE UNIQUE INDEX IF NOT EXISTS idx_jo_autonomy_suspended_notice_inflight
  ON job_outbox (topic, aggregate_id)
  WHERE topic = 'autonomy_suspended_notice' AND status IN ('pending', 'dispatching', 'dispatched');

CREATE UNIQUE INDEX IF NOT EXISTS idx_jo_autonomy_admin_alert_inflight
  ON job_outbox (topic, aggregate_id)
  WHERE topic = 'autonomy_admin_alert' AND status IN ('pending', 'dispatching', 'dispatched');
```

Fully re-runnable (074 conventions); transactional; no `CONCURRENTLY` (zero-row predicates / pre-launch sizes — state this in a header comment).
- [ ] **Step 3:** Apply to the local test container (`postgresql://test:test@localhost:5499/test_ws4`) TWICE — second apply must be NOTICE-only, zero errors.
- [ ] **Step 4:** Write the shape integration test (074 suite as template): table/columns/CHECK values, all five indexes with exact predicates (`pg_indexes`), RLS enabled + zero policies, `entity_id` present.
- [ ] **Step 5:** Run it: `TEST_DATABASE_POOL_URL=postgresql://test:test@localhost:5499/test_ws4 pnpm vitest run src/lib/shared/__tests__/migration-076-judge-verdicts-governor.integration.test.ts` → PASS.
- [ ] **Step 6:** Add the migrations-log **076** entry (what/why/indexes/apply-window analysis per spec §2.3, flip head to 076/next 077). Commit.

### Task 2: Judge LLM task — seam registration + prompt policy + guarded call

**Spec:** §2.4, §2.2. Invoke the `cost-guard` skill first. **Files:** modify `src/lib/llm/tasks.ts`, `src/lib/responses/__tests__/model-pinning.test.ts`; create `src/lib/responses/judge-policy.ts`, `src/lib/responses/judge.ts` + unit tests.

- [ ] **Step 1:** Read `src/lib/llm/tasks.ts`, `types.ts`, `run-task.ts`, `src/lib/reviews/triage.ts` (structured-output + cost-guard template), `src/lib/responses/prompt-policy.ts`, `src/lib/costs/cost-guard.ts`, `src/lib/costs/audit.ts`.
- [ ] **Step 2:** `judge-policy.ts`: export `JUDGE_PROMPT_VERSION = '2026-07-13.1'`, `JUDGE_SYSTEM_PROMPT` (safety rubric: no promises/compensation/discounts, no PII, no fabricated facts or claims not grounded in the review/business context, no hostility/defensiveness, brand-safe tone; output strict JSON only), memoized `judgeSystemPromptHash()` via `node:crypto` sha256 (prompt-policy.ts idiom).
- [ ] **Step 3:** `tasks.ts`: register `judge` — primary `{ provider: 'openai', model: OPENAI_MODEL }`, fallback `{ provider: 'anthropic', model: ANTHROPIC_MODEL }`, `maxTokens: 300`, `temperature: 0`, `outputSchema: JudgeOutputSchema`. Define `JudgeOutputSchema` (zod, in `judge.ts` or a small schema file next to it, triage-schema precedent): `{ verdict: z.enum(['pass','warn','flag']), reasons: z.array(z.enum([...category list…])).max(5), rationale: z.string().max(500) }`.
- [ ] **Step 4:** `judge.ts`: `judgeResponse(sql: Sql, input: { responseId; businessId; accountId; subscriptionTier; reviewRating; reviewText; postedReplyText }): Promise<JudgeCallResult>` — builds `ChatPrompt` from judge-policy + input, wraps in `withCostGuard({ businessId, subscriptionTier, withConcurrency: false, onFinalizeError: 'log-and-return-value' }, …)`, inside: `runLlmTask('judge', prompt)` → read `result.structured`, compute `calculateCostUsd(...)` → `Math.ceil(usd * 100)` cents; best-effort `recordApiCost` (try/catch log-and-swallow) with `endpoint: 'response-judge'`, `accountId`, `systemPromptHash: judgeSystemPromptHash()`, `promptVersion: JUDGE_PROMPT_VERSION`, `latencyMs`. Returns `{ verdict, reasons, rationale, model, promptVersion }`. Do NOT catch `CostInfraUnavailableError`/`TransientLLMError`/budget errors — they propagate to the worker (spec §2.4 classification).
- [ ] **Step 5:** `model-pinning.test.ts`: add the judge block asserting `LLM_TASKS.judge.primary/fallback` equal the pinned constants (existing per-task blocks as template).
- [ ] **Step 6:** Unit tests (mock `runLlmTask` + cost modules per triage test precedent): prompt contains review + reply + rubric, never logs raw text; structured verdict passthrough; cost-record fields (`endpoint`, hash, version); schema rejects out-of-enum verdicts; errors propagate unswallowed.
- [ ] **Step 7:** Run task tests + `pnpm lint && pnpm typecheck` → green. Commit.

### Task 3: Verdict store

**Spec:** §2.3, §2.5 (idempotence), §2.1 (anti-join). **Files:** create `src/lib/responses/judge-store.ts` + `__tests__/judge-store.test.ts` (+ integration).

- [ ] **Step 1:** `judge-store.ts` (all functions take `sql: Sql` or `tx: TransactionSql` — invariant #15):
  - `insertJudgeVerdict(tx, row): Promise<{ inserted: boolean }>` — INSERT with app-generated `uuidv7()`, `ON CONFLICT (response_id) DO NOTHING RETURNING id`.
  - `findLatestRunIdForReview(tx, reviewId): Promise<string | null>` — `SELECT id FROM agent_runs WHERE kind = 'review_handler' AND subject_type = 'review' AND subject_id = ${reviewId} ORDER BY started_at DESC LIMIT 1` (075 index; any status — runs are completed at post time).
  - `listUnjudgedAutoPosts(sql, { lookbackHours, limit })` — the sweep scan SELECT (spec §2.1 predicate: posted/auto_policy/lookback + `NOT EXISTS` verdict + `NOT EXISTS` in-flight `judge_verdict` outbox row + subscription-eligibility join). Keep the statement FLAT and top-level where the auditor needs predicates visible; allowlist what it can't see (`background-global-scan`) — entry + baseline bump in the SAME commit as the query lands (Task 5 wires the poller; the allowlist entry lands with THIS file's query).
- [ ] **Step 2:** Unit tests (mock-sql): conflict → `inserted: false`; scan SQL includes every predicate; run lookup orders by `started_at DESC`.
- [ ] **Step 3:** Integration (`describeWithDb`): two inserts same response → one row; anti-join excludes judged rows; eligibility join excludes a cancelled account's response.
- [ ] **Step 4:** Run tests + lint/typecheck → green. Commit (with allowlist entries + baseline bump).

### Task 4: Suspension writer + unsuspend + topics/payloads/enqueue helpers

**Spec:** §2.6, §2.12 (module half), §2.11/§2.10 (topic shapes). Invoke `outbox-pattern`. **Files:** create `src/lib/auto-approval/suspension.ts` + tests; modify `src/lib/shared/queue-names.ts`, `worker-types.ts`, `job-outbox-helpers.ts`.

- [ ] **Step 1:** Read `src/lib/auto-approval/settings.ts:440-660` (suspended-degrade + upsert idiom + ON CONFLICT targets), `src/lib/audit/log.ts`, `src/lib/shared/job-outbox-helpers.ts` (`enqueuePendingPostNotice` as template).
- [ ] **Step 2:** Add topics `JUDGE_VERDICT = 'judge_verdict'`, `AUTONOMY_SUSPENDED_NOTICE = 'autonomy_suspended_notice'`, `AUTONOMY_ADMIN_ALERT = 'autonomy_admin_alert'` to `queue-names.ts`; payload types to `worker-types.ts` (spec §2.1/§2.10/§2.11 — judge: `{ response_id, business_id, account_id, correlation_id? }`; notice: `{ account_id, suspension_event_id, trigger, correlation_id? }`; alert: `{ account_id, suspension_event_id, trigger, evidence }`).
- [ ] **Step 3:** Enqueue helpers with in-flight `ON CONFLICT` byte-for-byte with the 076 indexes (aggregate: judge → `response_id`; notice/alert → `suspension_event_id`).
- [ ] **Step 4:** `suspension.ts` — `suspendAccountAutonomy(tx, { accountId, trigger, suspensionEventId, evidence })` per spec §2.6:

```sql
INSERT INTO auto_approval_policies
  (id, account_id, location_id, persona, action_class, auto_approve_min_star,
   suspended_at, suspended_reason)
VALUES (${uuidv7()}, ${accountId}, NULL, 'reply', 'posting', NULL, NOW(), ${reason})
ON CONFLICT (account_id, persona, action_class) WHERE location_id IS NULL
DO UPDATE SET suspended_at = NOW(), suspended_reason = EXCLUDED.suspended_reason,
              updated_at = NOW()
WHERE auto_approval_policies.suspended_at IS NULL
RETURNING id
```

  0 rows ⇒ `{ newlySuspended: false }` (no audit, no enqueues). Else: `writeAccountAuditLog` (`event_type: 'autonomy_suspended'`, `entity_type: 'auto_approval_policy'`, payload `{ trigger, suspension_event_id, evidence }`) + `enqueueAutonomySuspendedNotice` + `enqueueAutonomyAdminAlert` — all in the caller's tx. `suspended_reason` = owner-appropriate string per trigger (constants here; surfaced in WS4's settings banner).
  Also `unsuspendAccountAutonomy(tx, { accountId, actorUserId, note })` per spec §2.12: guarded UPDATE (`… AND suspended_at IS NOT NULL RETURNING suspended_reason, auto_approve_min_star`), 0 rows ⇒ `{ unsuspended: false }`; else audit `autonomy_unsuspended` with `{ note, previous_reason }`; returns `{ unsuspended, rearmed: auto_approve_min_star !== null }`.
- [ ] **Step 5:** Unit tests (mock-sql): newly-suspended path enqueues both topics + audit; already-suspended is a total no-op; INSERT arm carries NULL threshold; unsuspend 0-rows path; rearmed derivation.
- [ ] **Step 6:** Integration (`describeWithDb`): suspend on rowless account creates the account-default row; suspend → WS4 `clear_account_default` degrades to threshold-NULL keeping suspension (settings.ts interplay); unsuspend → row stays with NULL threshold (manual, not re-armed); evaluator projection: after suspension, `resolveEffectivePolicy(...).suspended === true` for every location under the account.
- [ ] **Step 7:** Run tests + lint/typecheck → green. Commit.

### Task 5: Judge worker + failed-hook + sweep poller + queue registration

**Spec:** §2.1, §2.5. **Files:** create `worker/jobs/judge/JudgeWorker.ts`, `worker/jobs/judge/failed-hook.ts`, `worker/background/pollers/JudgeSweepPoller.ts`, `src/lib/responses/judge-flags.ts` + tests; modify `worker/queues.ts`, `worker/index.ts`.

- [ ] **Step 1:** Read `worker/jobs/pending-post-notice/PendingPostNoticeWorker.ts` (guard-and-return shape), `worker/jobs/publisher/failed-hook.ts` (exhaustion-hook shape), `worker/background/schedulers/WeeklySummaryScheduler.ts` (scan + outbox INSERT + createGuardedPoll), `src/lib/approval/outcomes.ts` (`anchorReviewLockOrder`).
- [ ] **Step 2:** `judge-flags.ts`: `judgeEnabled()` via `readFlag('JUDGE_ENABLED')`.
- [ ] **Step 3:** `JudgeWorker.ts` — `handleJudgeVerdict(sql, job)`:
  1. `extractOutboxHandle`; kill-switch first: `!judgeEnabled()` → `markOutboxCompleted`, return.
  2. Load response + review + account context (subscription status, tier). Worker-level subscription guard (invariant #11; `subscriptionGrantsFullAccess`) → ineligible: complete outbox, return.
  3. `judgeResponse(sql, …)` OUTSIDE the tx (never hold locks across the LLM call — production.md). Transient/`CostInfraUnavailableError` → rethrow (BullMQ retry). Terminal budget/structured-output errors → rethrow (failed-hook writes the `error` verdict).
  4. ONE tx: `anchorReviewLockOrder(tx, responseId, businessId)` FIRST (null → complete outbox, return); re-validate `status='posted' AND approval_method='auto_policy'` under the lock; `findLatestRunIdForReview`; `insertJudgeVerdict` (`inserted:false` → complete outbox, return); if `verdict === 'flag'` → `suspendAccountAutonomy(tx, { trigger: 'judge_flag', suspensionEventId: uuidv7(), evidence: { verdict_id } })`; `markOutboxCompleted` same tx.
- [ ] **Step 4:** `failed-hook.ts` (colocated, publisher precedent): on exhaustion, write the `error` verdict (`insertJudgeVerdict` with `verdict:'error'`, model/prompt_version from constants, rationale = bounded error class) in a reviews-anchored tx + mark outbox failed. Idempotent via the same `ON CONFLICT`.
- [ ] **Step 5:** `JudgeSweepPoller.ts` — `createGuardedPoll({ timeoutMs: 30_000, label: 'judge-sweep', intervalMs: () => getWorkerConfig().JUDGE_POLL_INTERVAL_MS ?? 60_000 })`; each cycle: `judgeEnabled()` gate → `listUnjudgedAutoPosts(sql, { lookbackHours: 24, limit: 50 })` → `enqueueJudgeVerdict` per row (single INSERT each; dedup via helper's `ON CONFLICT`).
- [ ] **Step 6:** Register: queue + `topicToQueue` in `worker/queues.ts`; in `worker/index.ts` — `new Worker(QUEUE_NAMES.JUDGE_VERDICT, withJobLogContext<JudgeVerdictPayload>((job) => handleJudgeVerdict(sql, job)), workerOpts)` + failed-hook wiring (publisher precedent) + `start/stopJudgeSweepPoller` (top-level static imports — `ci:db-imports` derives root status from exactly this registration shape).
- [ ] **Step 7:** Source-shape test (spec §2.5): the JudgeWorker source calls `anchorReviewLockOrder` before any `INSERT INTO judge_verdicts` (tripwire idiom; the file joins no spine-writer allowlist because it calls no spine writer).
- [ ] **Step 8:** Worker unit tests (mock-sql + mocked `judgeResponse`): flag-off completes; ineligible completes; transient rethrows; verdict tx order (anchor first); state re-validation branch; conflict branch; flag → suspension called with `judge_flag`; pass/warn → no suspension. Poller tests: flag-off no-op; enqueues per scan row; respects limit.
- [ ] **Step 9:** Run tests + lint/typecheck + `pnpm ci:db-imports` → green. Commit.

### Task 6: Publisher judge gate + judge health

**Spec:** §2.8. **Files:** create `src/lib/responses/judge-health.ts`, `worker/jobs/publisher/judge-gate.ts` + tests; modify `src/lib/approval/audit.ts`, the publisher auto-policy path (where the WS4 kill-switch/notice gates run), `scripts/ci/tenant-scope-allowlist.ts`.

- [ ] **Step 1:** Read `worker/jobs/publisher/veto-window-gate.ts` (gate placement + downgrade helper usage), WS4 spec §2.11 amendment, `src/lib/approval/audit.ts:39-51`.
- [ ] **Step 2:** `judge-health.ts` — frozen constants `JUDGE_STALENESS_LIMIT_MINUTES = 60`, `JUDGE_ERROR_DENSITY_MIN_COUNT = 3`, `JUDGE_ERROR_DENSITY_SHARE = 0.5`, `JUDGE_LOOKBACK_HOURS = 24`; `isJudgeHealthy(sql): Promise<boolean>` — two bounded queries per spec §2.8 (staleness applies the SAME subscription-eligibility filter as the sweep; error verdicts count as judged in staleness; error-density over the last 60 min of `judge_verdicts`). Query error → propagate (NOT a downgrade). Allowlist entries (`background-global-scan`) + baseline bump same commit.
- [ ] **Step 3:** `audit.ts`: add `AUDIT_ACTION_AUTO_POLICY_REVOKED_JUDGE_UNAVAILABLE = 'auto_policy_revoked_judge_unavailable'` to the constants + `AutoPolicyAuditAction` union.
- [ ] **Step 4:** `judge-gate.ts` — `applyJudgeGate(sql, ctx): Promise<'post' | 'downgraded'>`: `!judgeEnabled()` → downgrade (`downgrade_reason: 'judge_disabled'`); `!(await isJudgeHealthy(sql))` → downgrade (`'judge_unhealthy'`); both via the generalized WS4 downgrade helper with the new audit action + `posting_error` marker. Wire into the publisher auto-policy branch AFTER the WS4 gates, BEFORE any external call.
- [ ] **Step 5:** Tests: health-signal matrix (fresh unjudged young row → healthy; stale unjudged → unhealthy; stale-but-ineligible-account → healthy; poison single error verdict + otherwise judged → healthy; 3+ errors ≥50% share → unhealthy); gate branches (flag off / unhealthy / healthy / health-query throw propagates); downgrade writes audit action + marker; owner-approved path never consults the gate.
- [ ] **Step 6:** Run tests + lint/typecheck → green. Commit.

### Task 7: Governor — rates + scheduler

**Spec:** §2.7. **Files:** create `src/lib/auto-approval/governor.ts`, `worker/background/schedulers/AutonomyGovernorScheduler.ts` + tests; modify `src/lib/auto-approval/flags.ts`, `worker/index.ts`, `scripts/ci/tenant-scope-allowlist.ts`.

- [ ] **Step 1:** Read `src/lib/agents/run-spine.ts:24-33` (outcome kinds), migration 071 (indexes), WS5 spec §8 (counting semantics).
- [ ] **Step 2:** `governor.ts` — frozen constants exactly per spec §2.7 (`GOVERNOR_WINDOW_DAYS = 7`, `GOVERNOR_MIN_SAMPLE = 5`, thresholds 0.5/0.3/0.4). `listGovernorCandidates(sql, limit)`: accounts with an armed (`auto_approve_min_star IS NOT NULL`) policy row and an unsuspended account-default row. `computeGovernorRates(sql, accountId, windowStart)`: one query over `agent_outcomes` (kinds: `reply_edited_by_owner`, `reply_approved_no_edit`, `reply_vetoed_by_owner`, `reply_auto_posted`) + one over `judge_verdicts` (pass/warn/flag; `error` excluded). `windowStart = GREATEST(NOW() - 7 days, latest account_audit_log 'autonomy_unsuspended' event)` (spec: unsuspend-aware window). `evaluateAccount(...)`: returns first breached `{ trigger, evidence: { rate, numerator, denominator, windowDays } }` or null, floors enforced per-rate.
- [ ] **Step 3:** `flags.ts`: `governorEnabled()` via `readFlag('GOVERNOR_ENABLED')`.
- [ ] **Step 4:** `AutonomyGovernorScheduler.ts` — `createGuardedPoll({ timeoutMs: 60_000, intervalMs: () => … ?? 900_000 })`; cycle: flag gate → candidates → per account: rates → breach → `sql.begin(tx => suspendAccountAutonomy(tx, { trigger, suspensionEventId: uuidv7(), evidence }))` (own tx per account; NO review-lane locks — comment the cycle-free justification per spec §2.6). Register start/stop in `worker/index.ts`.
- [ ] **Step 5:** Unit tests: floor boundaries (4/4 edits → no trip; 3/5 edits → trip at 0.6 ≥ 0.5; exactly-at-threshold trips), veto denominator = vetoed + auto_posted, error verdicts excluded, unsuspend-aware window start, candidate scan excludes suspended/unarmed accounts, breach calls writer with rate-snapshot evidence.
- [ ] **Step 6:** Integration (`describeWithDb`): seed outcomes + verdicts → end-to-end evaluate → suspended row + audit + two outbox rows; re-run cycle → no-op (idempotent).
- [ ] **Step 7:** Allowlist entries + baseline bump same commit. Run tests + lint/typecheck + `pnpm ci:tenant-scope` → green. Commit.

### Task 8: Owner suspension notice — the 4th notice package

**Spec:** §2.10. **Files:** create `worker/jobs/autonomy-suspended-notice/{AutonomySuspendedNoticeWorker,context,dispatch,errors}.ts`, `src/lib/notifications/email/templates/autonomy-suspended-notice.ts` + tests; modify `src/lib/notifications/channels/types.ts`, `email-channel.ts`, `telegram-channel.ts`, `whatsapp-channel.ts`, `telegram-body.ts`/`whatsapp-body.ts` (per existing layout), `src/lib/notifications/delivery.ts`, `worker/queues.ts`, `worker/index.ts`.

- [ ] **Step 1:** Read `worker/jobs/pending-post-notice/*` end-to-end (the closest clone), `src/lib/notifications/delivery.ts:143-190` (claim + self-reap), `channels/types.ts:153`.
- [ ] **Step 2:** `claimAutonomySuspendedNoticeDelivery(sql, { entityId, channel, recipient })` — INSERT `ON CONFLICT (entity_id, channel, recipient) WHERE entity_id IS NOT NULL AND template = 'autonomy_suspended_notice' DO NOTHING RETURNING id` (byte-for-byte with 076), preceded by the 15-minute self-reap DELETE (pending-post idiom; `response_id` stays NULL).
- [ ] **Step 3:** Channel seam: `sendAutonomySuspendedNotice(params)` on `NotificationChannel` + 3 implementations; WhatsApp gated on `WHATSAPP_AUTONOMY_SUSPENDED_TEMPLATE_SID` (unset → skip, precedent); email template + telegram/whatsapp bodies with the spec §2.10 content (paused after safety review / account scope / drafts continue, owner approves manually / reason category / support + settings links). **No raw review/response text in any body.**
- [ ] **Step 4:** Worker package (guard-and-return): `extractOutboxHandle` → context load (account + enrollments + suspension audit context; fail/skip discriminated) → subscription guard via `getEligibleChannels` → dispatch loop (claim → send → finalize/release/fail) → `retryableFailed > 0` throws → all-skipped systemic warn (WS4 §6 signal) → complete outbox. **Deliberately NO feature-flag kill-switch** — safety notification; comment why (spec §2.10).
- [ ] **Step 5:** Register queue + `topicToQueue` + worker (injected-`sql`).
- [ ] **Step 6:** Tests (pending-post suites as template): claim dedup + self-reap; per-channel skip paths; retryable throw; no-flag-guard behavior; template bodies contain no response text; systemic-warn on all-skipped.
- [ ] **Step 7:** Run tests + lint/typecheck → green. Commit.

### Task 9: Admin alert worker

**Spec:** §2.11. **Files:** create `worker/jobs/AutonomyAdminAlertWorker.ts` + test; modify `worker/queues.ts`, `worker/index.ts`.

- [ ] **Step 1:** Read `worker/jobs/AdminExceptionWorker.ts` (shape + `sendInternalEmail` + unset-email posture).
- [ ] **Step 2:** `handleAutonomyAdminAlert(sql, job)`: self-contained payload render (account, trigger, evidence rates/verdict, suspension_event_id) → `sendInternalEmail({ to: ADMIN_NOTIFICATION_EMAIL, category: 'internal' })`; unset email → log error + complete (no retry); send failure → throw (retry). Then best-effort `Sentry.captureMessage('autonomy suspended', { level: 'warning', tags: { subsystem: 'autonomy_watchdog', trigger } })` in its own try/catch (log-and-swallow — never poison the success path). Complete outbox.
- [ ] **Step 3:** Register queue + worker. Tests: email-fail throws; Sentry-fail swallowed; unset-email completes; body carries evidence, not raw texts.
- [ ] **Step 4:** Run tests + lint/typecheck → green. Commit.

### Task 10: Admin unsuspend surface

**Spec:** §2.12. Invoke `repworth-brand-design` for the page. **Files:** create `src/app/api/admin/autonomy/suspensions/route.ts`, `src/app/api/admin/autonomy/unsuspend/route.ts`, `src/app/admin/autonomy/page.tsx`, route tests; modify `src/lib/auto-approval/suspension.ts` (list read fn), `scripts/ci/tenant-scope-allowlist.ts`.

- [ ] **Step 1:** Read `src/app/api/admin/flagged/route.ts` + its test (admin auth pattern), `src/app/admin/flagged/page.tsx`.
- [ ] **Step 2:** `listSuspendedPolicies(sql)` in suspension.ts: suspended rows (account + location scopes) joined to account name + current governor rates (`computeGovernorRates`) + recent flag verdicts (last 5 per account). Admin cross-account → allowlist `admin-after-require-role`, same commit.
- [ ] **Step 3:** GET route (requireRole admin → list → JSON) and POST unsuspend route (parse `{ accountId, note }` → `sql.begin(tx => unsuspendAccountAutonomy(tx, { accountId, actorUserId, note }))` → `{ unsuspended: false }` ⇒ 409; else `{ rearmed }` in the 200). Route handlers orchestrate only (invariant/route rules).
- [ ] **Step 4:** `page.tsx`: minimal table (account, reason, trigger, suspended-at, rates, evidence) + unsuspend button with note field + armed/manual outcome toast (flagged-queue clone, brand skill).
- [ ] **Step 5:** Route tests: non-admin 403; list shape; unsuspend 200 + audit written; 409 when not suspended; note required. Run + lint/typecheck → green. Commit.

### Task 11: Judge eval lane (llm-eval gate)

**Spec:** §2.9. **Files:** create `tests/llm-eval/judge-eval-set.jsonl`, `judge-types.ts`, `judge-load.ts`, `judge-scorer.ts`, `__tests__/judge-eval.test.ts`; modify `tests/llm-eval/run.ts` (+ `live-runner.ts` for `--live`).

- [ ] **Step 1:** Read `tests/llm-eval/{types,load,scorer,run}.ts` + README (harness conventions).
- [ ] **Step 2:** Fixtures (≥ 10 rows): clean positive (pass), compensation promise (flag), PII leak (flag), fabricated claim (flag), hostile tone (flag), mediocre-but-safe (`expect.forbidden: ['flag']`), adversarial near-misses. Each row: `{ id, category, description, input, postedReply, cannedOutput, expect: { verdict?, forbidden? } }` — `cannedOutput` is the golden model JSON for offline schema/mapping validation.
- [ ] **Step 3:** Offline scorer: loader validation + `JudgeOutputSchema.parse(cannedOutput)` + verdict mapping vs `expect`; wire into `run.ts` (offline always; judge `--live` runs `runLlmTask('judge')` per fixture and scores agreement — sanctioned unguarded eval caller, mark it per `run-task.ts` contract comment).
- [ ] **Step 4:** Keyless vitest smoke (`__tests__/judge-eval.test.ts`): loads set, offline scorer passes, duplicate-id rejection.
- [ ] **Step 5:** `pnpm eval:llm` (offline) → PASS including judge lane. Run + lint/typecheck → green. Commit. (All paths inside the `llm-eval` CI filter — verify no workflow edit needed.)

### Task 12: Flags, startup asserts, docs + contract sweep

**Spec:** §2.13, §3. **Files:** modify `worker/config/startup-assert.ts`, `.claude/reference/env-vars.md`, `docs/directory.md`.

- [ ] **Step 1:** Add `JUDGE_ENABLED`, `GOVERNOR_ENABLED` to `SERVER_ONLY_FEATURE_OPTIONAL_BOOLEAN_ENV`; extend its test.
- [ ] **Step 2:** `env-vars.md`: rows for both flags (server-only, default off, `readFlag`, no `NEXT_PUBLIC_*` companion, staging→prod rollout, the **JUDGE_ENABLED↔AUTO_APPROVAL_ENABLED coupling** — judge off ⇒ publisher downgrades every auto-post) + `WHATSAPP_AUTONOMY_SUSPENDED_TEMPLATE_SID` + `JUDGE_POLL_INTERVAL_MS`/`GOVERNOR_INTERVAL_MS`.
- [ ] **Step 3:** `docs/directory.md`: rows for every new module (pollers, schedulers, jobs, lib files, admin routes/page, eval lane) in their sections — integration review flags misses.
- [ ] **Step 4:** Lint/typecheck + all `ci:*` audits → green. Commit.

### Task 13: Full gates (branch-final)

- [ ] **Step 1:** `pnpm lint && pnpm typecheck`.
- [ ] **Step 2:** Sequential full suite (the acceptance bar — parallel flakes on shared-DB DDL):
  `TEST_DATABASE_POOL_URL=postgresql://test:test@localhost:5499/test_ws4 DATABASE_POOL_URL=postgresql://test:test@localhost:5499/test_ws4 pnpm vitest run --no-file-parallelism` → 0 failed.
- [ ] **Step 3:** Every audit: `pnpm ci:tenant-scope && pnpm ci:rls-audit && pnpm ci:analytics-events && pnpm ci:static-policy && pnpm ci:db-imports` (+ any other `ci:*` in package.json) → green.
- [ ] **Step 4:** `pnpm eval:llm` (offline) → PASS. `pnpm ci:fallow` (origin/main base; delete stale `coverage/coverage-final.json` first if present) → clean, extract rather than bust thresholds.
- [ ] **Step 5:** Fix anything red; commit fixes.

---

## Self-review (done at authoring)

- **Spec coverage:** §2.1→T3/T5; §2.2→T2; §2.3→T1; §2.4→T2; §2.5→T5 (anchor + source-shape test); §2.6→T4; §2.7→T7; §2.8→T6; §2.9→T11; §2.10→T8; §2.11→T9; §2.12→T10; §2.13→T12; §4 spread across per-task test steps + T13.
- **Type consistency:** `suspendAccountAutonomy`/`unsuspendAccountAutonomy` (T4) match callers in T5/T7/T10; `insertJudgeVerdict`/`listUnjudgedAutoPosts`/`findLatestRunIdForReview` (T3) match T5/T6; `judgeResponse` (T2) matches T5; `isJudgeHealthy` (T6) consumed only by the gate; trigger union consistent across T4/T7/T9.
- **Placeholder scan:** category enum for `JudgeOutputSchema.reasons` and exact notice copy are deliberately delegated to the executing task within stated constraints (bounded enum ≤ 8 categories mirroring the rubric; copy constraints in T8 Step 3) — not open-ended TBDs.
- **Ordering:** T1 (schema) → T2–T4 (leaf modules) → T5–T7 (workers/loops) → T8–T10 (notify/admin) → T11–T13 (eval/docs/gates). T5 depends on T2+T3+T4; T6 on T3; T7 on T4.
