# WS6 — Judge + governor (the autonomy watchdog) — Design

**Date:** 2026-07-13 · **Parents:** design doc §5.1 items 2–3
(`docs/future-plans/2026-07-01-agentic-reputation-platform-design.md`) · **WS row:**
`docs/superpowers/plans/2026-07-01-agentic-platform-phase1-run-spine.md` (WS6) ·
**Depends:** WS1 (run spine, shipped) + WS4 (trust dial + suspension seam, shipped).
**Handoff of record:** `/tmp/repworth-handoff-2026-07-13-ws6-judge-governor.md`.

WS4 §6 amendments (`docs/superpowers/specs/2026-07-07-ws4-trust-dial-veto-window-design.md`)
own suspension semantics and win on conflict. WS5 §8 amendments
(`docs/superpowers/specs/2026-07-12-ws5-persona-surfaces-design.md`) own outcome-counting
semantics (`reply_posted` is the unit; `reply_auto_posted` is the qualifier).

## 1. What WS6 ships

The autonomy watchdog — the last launch-blocking guardrail before the Autopilot prod
flip (go-live gate = WS4 ✅ + WS7 ✅ + **WS6** + Zernio limits in writing):

1. **Online judge:** every auto-posted reply is independently reviewed by an
   LLM-as-judge within minutes of posting — 100% sampling at launch (design doc: a
   dial turned *down* with volume, never up). Post-hoc and advisory; **never in the
   posting latency path.** A `flag` verdict suspends the account's autonomy
   immediately.
2. **Verdict storage:** new `judge_verdicts` table (migration **076**), deny-all RLS,
   one verdict per response.
3. **Autonomy health governor:** per-account rolling edit-rate / veto-rate /
   judge-signal-rate over the outcome stream + verdicts; crossing a **frozen
   threshold** suspends autonomy — never silently (owner notice + admin alert +
   audit, atomically).
4. **The WS4 suspension seam gets its writer:** `suspended_at`/`suspended_reason` on
   the account-default `auto_approval_policies` row; the inert `policy_suspended`
   evaluator gate goes live the moment the first writer fires.
5. **Owner suspension notice** (4th notice package) + **admin alert** (internal email
   + Sentry).
6. **Admin-only unsuspend flow** respecting WS4 §6's
   clear-degrades-to-threshold-NULL shape.
7. **Judge-down failure semantics:** judge disabled or unhealthy → the publisher
   downgrades auto-policy posts to owner review. Auto-posting pauses; Copilot is
   untouched. Everything fails toward "ask the owner."

Not in WS6 v1: timeline/UI rendering of verdicts (read shape kept compatible —
`judge_verdicts.response_id` joins WS5's timeline response), owner self-serve
unsuspend, confidence routing, sampling dial below 100%, the notice-package triplet
extraction (see §2.10), the dashboard-native cancel-auto-post follow-up.

## 2. Resolved design decisions

### 2.1 Judge pipeline shape — sweep poller enqueues; BullMQ worker judges

Two pieces, split so LLM work rides the existing retry machinery:

- **`JudgeSweepPoller`** (`worker/background/pollers/JudgeSweepPoller.ts`,
  Postgres-state-driven → pollers/, per the trigger-based split). Built on
  `createGuardedPoll`. Each cycle (default `JUDGE_POLL_INTERVAL_MS = 60_000`,
  per-cycle timeout 30s, batch `LIMIT` 50): scan for posted auto-policy responses
  lacking a verdict and enqueue one `judge_verdict` outbox row per response
  (WeeklySummaryScheduler precedent — scan + `INSERT INTO job_outbox` with dedup).
  Scan predicate:
  - `responses.status = 'posted' AND approval_method = 'auto_policy'`
  - `posted_at >= NOW() - INTERVAL '24 hours'` (lookback constant
    `JUDGE_LOOKBACK_HOURS = 24` — bounds the scan and defines the judged population;
    pre-WS6 history is deliberately not judged)
  - anti-join: `NOT EXISTS (SELECT 1 FROM judge_verdicts jv WHERE jv.response_id = r.id)`
  - outbox dedup: `NOT EXISTS` an in-flight `judge_verdict` outbox row for the
    response, backed by the 076 partial unique index (byte-for-byte with the enqueue
    helper's `ON CONFLICT`)
  - subscription eligibility at scan time: join `businesses`→`accounts` and require
    `subscriptionGrantsFullAccess`-equivalent statuses (SQL-side list derived from
    the canonical TS constant). Cancelled/pending-payment accounts are not judged.
  Served by the new partial index `idx_responses_auto_policy_posted` (§2.3).
- **`JudgeWorker`** (`worker/jobs/judge/JudgeWorker.ts`, queue/topic
  `QUEUE_NAMES.JUDGE_VERDICT = 'judge_verdict'`): loads the response + review
  context, re-checks eligibility (worker-level subscription guard, invariant #11 —
  ineligible → complete outbox, no verdict; the row simply ages out of the
  lookback), runs the guarded judge LLM call (§2.4), and persists the verdict —
  plus, on `flag`, the suspension flow (§2.6) — in ONE transaction.

Why not enqueue from `mark-posted.ts` in-tx? The design of record says "async
poller" and the sweep shape is self-healing: it catches enqueue gaps, missed jobs,
and (with the anti-join) is trivially idempotent. The posting path stays completely
untouched — the strongest possible form of "never in the posting latency path."

**Terminal exhaustion writes an `error` verdict.** A colocated `'failed'` hook
(`worker/jobs/judge/failed-hook.ts`, publisher failed-hook precedent) writes a
`judge_verdicts` row with `verdict = 'error'` when BullMQ retries exhaust
(idempotent via the `UNIQUE (response_id)` `ON CONFLICT DO NOTHING`). This stops the
sweep from re-picking the row forever AND feeds the error-density judge-health
signal (§2.8). Budget-exceeded cost decisions (terminal, per the cost-guard skill)
land here too; transient LLM/Redis-transport failures retry (3× + backoff) before
the hook fires.

**Judge re-spend on tx failure — accepted.** If the LLM call succeeds but the
verdict tx fails, the BullMQ retry re-runs the LLM (no idempotent cache for judge
calls — generation's cache is generation-only). A judge call costs a fraction of a
cent at ~300 output tokens; the rare double-spend is accepted rather than building
a second cache lane.

### 2.2 Verdict enum + judged snapshot

`verdict IN ('pass', 'warn', 'flag', 'error')`:

- `pass` — the posted reply is fine.
- `warn` — imperfect but not suspension-worthy on its own; feeds the governor's
  judge-signal-rate (§2.7). No immediate action.
- `flag` — suspension-worthy (unsafe, off-brand-hostile, hallucinated facts,
  policy-violating). Triggers immediate account suspension (§2.6).
- `error` — the judge could not score (terminal LLM failure / budget-exceeded).
  Excluded from rate denominators; counted by the health signal.

The judge scores the response text as posted at judge time. No judged-text snapshot
is stored in v1 (accepted: `approval_audit_log.response_text_at_approval` already
preserves the approved text for disputes; edit-after-post is a tracked admin
exception). `rationale` (bounded ≤ 500 chars at the app layer) and `reasons`
(JSONB array of category enums) are stored for the admin surface — acceptable in a
deny-all-RLS, server-only table (flagged_responses precedent).

### 2.3 Migration 076 (read `.claude/reference/migrations-log.md` first; head 075)

One migration, re-runnable (074 conventions: `IF NOT EXISTS` / `DROP ... IF EXISTS`
before ADD, transactional, no `CONCURRENTLY` — zero-row predicates on a brand-new
topic/table, pre-launch table sizes), double-apply verified, shape suite mirroring
`migration-074-*.integration.test.ts`:

1. **`judge_verdicts`** — app-generated UUIDv7 PKs, spine posture:
   - `id UUID PRIMARY KEY`
   - `account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE`
   - `business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE`
   - `review_id UUID NOT NULL REFERENCES reviews(id) ON DELETE CASCADE`
   - `response_id UUID NOT NULL REFERENCES responses(id) ON DELETE CASCADE`
   - `agent_run_id UUID NULL REFERENCES agent_runs(id) ON DELETE SET NULL`
     (spine precedent — orphan tolerance; resolved via the review-subject lookup,
     latest run, at write time; NULL if none)
   - `verdict TEXT NOT NULL CHECK (verdict IN ('pass','warn','flag','error'))`
   - `reasons JSONB NULL` (category enums only), `rationale TEXT NULL`
   - `model TEXT NOT NULL`, `prompt_version TEXT NOT NULL`
   - `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
   - `UNIQUE (response_id)` (one verdict per response; also serves the anti-join)
   - `idx_judge_verdicts_account_created (account_id, created_at DESC)` — governor
     rate scans (mirrors `idx_agent_outcomes_account_occurred`)
   - `idx_judge_verdicts_created (created_at DESC)` — global health-window queries
   - **Deny-all RLS** (enable RLS, zero policies — 071/049 posture) + revoke writes
     from `authenticated`.
2. **`idx_responses_auto_policy_posted`** on `responses (posted_at DESC) WHERE
   status = 'posted' AND approval_method = 'auto_policy'` — sweep scan + staleness
   health query (no existing index covers `approval_method`).
3. **`idx_jo_judge_verdict_inflight`** on `job_outbox (topic, aggregate_id) WHERE
   topic = 'judge_verdict' AND status IN ('pending','dispatching','dispatched')` —
   byte-for-byte with `enqueueJudgeVerdict`'s `ON CONFLICT` (074 precedent).
4. **`notification_deliveries.entity_id UUID NULL`** — generic dedup key for
   non-response-anchored notices. Claim index
   `notification_deliveries_autonomy_suspended_claim` on
   `(entity_id, channel, recipient) WHERE entity_id IS NOT NULL AND
   template = 'autonomy_suspended_notice'` — byte-for-byte with
   `claimAutonomySuspendedNoticeDelivery`. (`response_id` stays NULL for this
   template; the entity is the suspension event, §2.6.)
5. **`idx_jo_autonomy_suspended_notice_inflight`** and
   **`idx_jo_autonomy_admin_alert_inflight`** — same partial-unique in-flight shape
   for the two new notice topics (aggregate = suspension event id).

Apply window: 076 is purely additive (new table, new indexes, one nullable column).
Code-before-076 is safe while `JUDGE_ENABLED`/`GOVERNOR_ENABLED` are off (no reads
of the new objects); 076-before-code is always safe. Staging runs flags on → apply
076 to staging before deploying, staging first then prod, lockstep.

### 2.4 Judge LLM call — task seam + cost guard + prompt policy

- **Task seam:** register `judge` in `LLM_TASKS` (`src/lib/llm/tasks.ts`) — the
  union member already exists, deliberately unregistered until now. Descriptor:
  primary `{ openai, OPENAI_MODEL }`, fallback `{ anthropic, ANTHROPIC_MODEL }`
  (both pinned constants, already priced in `MODEL_PRICING`), `maxTokens: 300`,
  `temperature: 0`, `outputSchema: JudgeOutputSchema` (zod — triage precedent):
  `{ verdict: 'pass'|'warn'|'flag', reasons: string[] (bounded enum), rationale: string }`.
  `LLMStructuredOutputError` stays terminal (fallback provider is the retry).
  **`model-pinning.test.ts` gains a judge block** (the test enumerates each
  registered task explicitly).
- **Prompt policy:** `src/lib/responses/judge-policy.ts` — `JUDGE_PROMPT_VERSION`
  + versioned system prompt + memoized `judgeSystemPromptHash()`
  (generation's `prompt-policy.ts` precedent — the judge is safety-critical, so it
  records `system_prompt_hash` + `prompt_version` on `api_costs`, and
  `prompt_version` + `model` on the verdict row). The prompt receives review
  context (rating, review text) + the posted reply and asks for a strict-JSON
  verdict against the safety rubric (no promises/compensation, no PII, no
  hallucinated facts, no hostility, brand-safe tone).
- **Domain module:** `src/lib/responses/judge.ts` — `judgeResponse(sql, input)`
  builds the prompt, wraps `runLlmTask('judge', prompt)` in
  `withCostGuard({ businessId, subscriptionTier, withConcurrency: false,
  onFinalizeError: 'log-and-return-value' })` (review-summary/triage precedent),
  computes `calculateCostUsd` → `Math.ceil(usd * 100)` cents, best-effort
  `recordApiCost` with `endpoint: 'response-judge'`, `accountId`,
  `systemPromptHash`, `promptVersion`, `latencyMs`. Placing judge modules under
  `src/lib/responses/` keeps them **inside the existing `llm-eval` CI path filter**
  (`src/lib/{moderation,responses,llm}/**`) — no workflow edit.
- **Failure classification (cost-guard skill, binding):** pre-LLM Redis transport
  errors surface as `CostInfraUnavailableError` → the worker re-throws →
  BullMQ retry. Budget-exceeded (`CostLimitExceeded`/`GlobalCostLimitExceeded`)
  stays terminal → failed-hook `error` verdict. Never reclassify a budget decision
  as infra. Judge spend shares the per-business daily budget with generation —
  accepted at launch volume (pennies; the pessimistic 15¢ reserve is transient).
- **Offline eval fixtures (§2.9)** cover the judge prompt under the `llm-eval` gate.

### 2.5 Verdict write transaction — reviews-first

The `judge_verdicts` INSERT takes implicit FK `FOR KEY SHARE` locks on `responses`,
`reviews`, `agent_runs`, `businesses`, `accounts` — review-lane locks, so the
**lock-order law applies** even though no spine writer is called (the law counts
implicit-FK-lock statements; the tripwire regex only watches spine-writer names and
won't fire here). The JudgeWorker tx therefore:

1. `anchorReviewLockOrder(tx, responseId, businessId)` as its FIRST statement
   (`src/lib/approval/outcomes.ts` anchor).
2. Re-validates current state under the lock (response still
   `posted`/`auto_policy`; anchor returns NULL → complete outbox, no verdict).
3. INSERT the verdict `ON CONFLICT (response_id) DO NOTHING` (a concurrent verdict
   → complete outbox, done).
4. On `flag`: the suspension flow (§2.6) inside the SAME tx.
5. Complete the outbox row.

A source-shape test pins anchor-before-INSERT ordering in the judge writer (mirrors
the tripwire idiom; the file does not join `CALLER_ALLOWLIST` because it calls no
spine writer — if a later change adds a spine call, the tripwire catches it).

No spine writes: no new run kind, no new step keys, no `STEP_PERSONA` change, no
outcome kinds. The judge lane is verdict-rows-only in v1 (agenda item 8 resolved:
runs are completed at post time; a `judge_review` run kind bought nothing but
migration + totality surface).

### 2.6 Suspension writer — single owner, atomic, idempotent

**`src/lib/auto-approval/suspension.ts`** is the ONLY writer of
`suspended_at`/`suspended_reason` (settings.ts treats them as governor-owned and
never touches them — verified). Signature shape:

```ts
suspendAccountAutonomy(tx, {
  accountId, trigger: 'judge_flag' | 'governor_edit_rate' | 'governor_veto_rate'
    | 'governor_judge_signal_rate',
  suspensionEventId,           // app-generated UUIDv7, the dedup anchor
  evidence,                    // verdict id | rate snapshot {rate, numer, denom, windowDays}
}): Promise<{ newlySuspended: boolean }>
```

In one tx (the caller's):

1. **Upsert the ACCOUNT-DEFAULT row** (WS4 §6 scoping — account-wide stop):
   `INSERT ... (account_id, location_id NULL, persona 'reply', action_class
   'posting', auto_approve_min_star NULL, suspended_at NOW(), suspended_reason $)`
   `ON CONFLICT (account_id, persona, action_class) WHERE location_id IS NULL
   DO UPDATE SET suspended_at = NOW(), suspended_reason = EXCLUDED.suspended_reason,
   updated_at = NOW() WHERE auto_approval_policies.suspended_at IS NULL` —
   byte-for-byte with `auto_approval_policies_one_account_default`. The INSERT arm
   covers override-only accounts (a threshold-NULL suspended account-default row is
   a legitimate WS4 §6 shape); the `WHERE suspended_at IS NULL` guard makes
   re-suspension a no-op — **zero rows updated ⇒ `newlySuspended: false` ⇒ no
   audit spam, no duplicate notices**.
2. `suspended_reason` = short owner-appropriate string keyed by trigger (constants
   in suspension.ts; surfaced verbatim in the WS4 settings suspended banner).
3. **`writeAccountAuditLog`** (same tx, CLAUDE.md law): `event_type:
   'autonomy_suspended'`, `entity_type: 'auto_approval_policy'`, payload
   `{ trigger, suspension_event_id, evidence }` (WS4's
   `auto_approval_policy_changed` precedent — account_audit_log, NOT
   approval_audit_log, which stays response-scoped).
4. **Enqueue owner notice + admin alert** (outbox, same tx; only when
   `newlySuspended`): topics `autonomy_suspended_notice` + `autonomy_admin_alert`,
   aggregate = `suspensionEventId`, via new `job-outbox-helpers.ts` enqueue helpers
   with byte-for-byte in-flight `ON CONFLICT` guards.

The moment `suspended_at` lands, WS4's inert machinery does the rest: the
`policy_suspended` evaluator gate blocks new grants account-wide, GET readiness
surfaces it, settings shows the read-only banner, expansion is blocked, and clears
degrade to threshold-NULL instead of DELETE.

**Callers:** JudgeWorker (on `flag`, inside its reviews-anchored verdict tx —
verdict + suspension + audit + notices are one atomic unit) and the governor
(§2.7, its own tx — policies/audit/outbox only, NO review-lane locks; cycle-free
vs the global order, justified in a comment).

### 2.7 Governor — scheduler, frozen constants, minimum-sample floors

**`worker/background/schedulers/AutonomyGovernorScheduler.ts`** (time-cadence
trigger → schedulers/; `createGuardedPoll`; default
`GOVERNOR_INTERVAL_MS = 900_000` — 15 min; per-cycle timeout 60s).

Each cycle, one bounded scan: accounts that (a) have at least one
`auto_approval_policies` row with `auto_approve_min_star IS NOT NULL` (autonomy
armed somewhere), and (b) are not already suspended on the account-default row.
For each candidate account, compute over the rolling window:

| Rate | Numerator | Denominator (floor) |
|---|---|---|
| `edit_rate` | `reply_edited_by_owner` | `reply_edited_by_owner + reply_approved_no_edit` (≥ 5) |
| `veto_rate` | `reply_vetoed_by_owner` | `reply_vetoed_by_owner + reply_auto_posted` (≥ 5) |
| `judge_signal_rate` | `flag + warn` verdicts | `pass + warn + flag` verdicts (≥ 5) |

Sources: `agent_outcomes` (per-(run,kind)-deduped; `reply_auto_posted` is the
auto-posted unit count per WS5 §8 — it co-occurs with `reply_posted`, so counting
it alone counts auto-posted runs exactly once) and `judge_verdicts` (`error`
excluded from both sides). Served by `idx_agent_outcomes_account_occurred` and
`idx_judge_verdicts_account_created`.

**Frozen constants** (in `src/lib/auto-approval/governor.ts`, constants not
config — flagged for user review at spec sign-off, then frozen):

- `GOVERNOR_WINDOW_DAYS = 7` (rolling)
- `GOVERNOR_MIN_SAMPLE = 5` (per-rate denominator floor — a 1-of-1 edit is not a
  100% edit rate)
- `GOVERNOR_EDIT_RATE_THRESHOLD = 0.5`
- `GOVERNOR_VETO_RATE_THRESHOLD = 0.3`
- `GOVERNOR_JUDGE_SIGNAL_RATE_THRESHOLD = 0.4`

Crossing any threshold (with its floor met) → `suspendAccountAutonomy` in a
per-account tx with the rate snapshot as evidence. Idempotent by construction: the
scan excludes already-suspended accounts AND the writer's `WHERE suspended_at IS
NULL` guard makes a race a no-op.

**Unsuspend-aware window:** the window start is
`GREATEST(NOW() - 7 days, last autonomy_unsuspended event)` — read from
`account_audit_log` (latest `event_type = 'autonomy_unsuspended'` per candidate,
served by `idx_account_audit_event`). Without this, an admin unsuspend is
instantly re-suspended by the same stale window and the notice spams.

Judge `flag` verdicts suspend immediately via §2.6 — the governor's
judge-signal-rate exists to catch *accumulating mediocrity* (`warn` density) that
never individually flags.

### 2.8 Judge-down failure semantics — publisher gate, fail toward the owner

Design risk table: "judge down → auto-posting pauses, Copilot flow unaffected."
Mechanism: a **pre-post gate in the publisher's auto-policy path**
(`worker/jobs/publisher/judge-gate.ts`, veto-window-gate precedent — runs BEFORE
any external call, alongside the WS4 kill-switch and notice-delivery gates):

1. **`JUDGE_ENABLED` off ⇒ downgrade.** Autonomy without its watchdog is not
   allowed: with the judge flag off, every due auto-policy post downgrades to owner
   review via the generalized WS4 downgrade helper (new audit action
   `AUDIT_ACTION_AUTO_POLICY_REVOKED_JUDGE_UNAVAILABLE =
   'auto_policy_revoked_judge_unavailable'` in `src/lib/approval/audit.ts`,
   `posting_error` marker + `downgrade_reason: 'judge_disabled'`). Flipping
   `AUTO_APPROVAL_ENABLED` on therefore REQUIRES `JUDGE_ENABLED` on — documented in
   `env-vars.md`; this IS the go-live coupling the design intends.
2. **`isJudgeHealthy(sql)`** (in `src/lib/responses/judge-health.ts`, frozen
   constants) — two signals, one bounded query each:
   - *Staleness:* no unjudged posted auto-policy response older than
     `JUDGE_STALENESS_LIMIT_MINUTES = 60` within the 24h lookback (served by
     `idx_responses_auto_policy_posted` + the verdict anti-join), **applying the
     same subscription-eligibility filter as the sweep scan** — a cancelled
     account's never-judged reply must not read as judge downtime. Error verdicts
     count as judged here (a single poison response must not wedge the fleet)…
   - *Error density:* …which is why systemic failure is caught separately: in the
     last 60 minutes, `error` verdicts ≥ 3 AND error share ≥ 50% ⇒ unhealthy
     (`idx_judge_verdicts_created`).
   Unhealthy ⇒ downgrade with `downgrade_reason: 'judge_unhealthy'`.
3. A gate **query failure** re-throws (transient → BullMQ retry) — an outage is
   detected by the health data, not by the health check erroring; a DB blip must
   not downgrade a valid post.

Copilot is structurally unaffected: the gate lives only in the auto-policy publish
branch. Owner-approved posts never consult it.

### 2.9 Offline eval fixtures — judge prompt under the `llm-eval` gate

`tests/llm-eval/` gains a judge lane mirroring the existing harness structure
(types/load/scorer/run):

- **`judge-eval-set.jsonl`** — fixture rows: `{ id, category, description, input
  (review rating/text + business ctx), postedReply, expect: { verdict, forbidden?:
  verdict[] } }` covering: clean positive reply (pass), compensation promise
  (flag), PII leak (flag), hallucinated claim (flag), hostile/defensive tone
  (flag), mediocre-but-safe (warn/pass tolerance — `expect.forbidden: ['flag']`),
  plus adversarial near-misses.
- **Offline/keyless mode** (the CI-gating part): validates fixture shape via the
  loader, and runs `JudgeOutputSchema` parsing + verdict mapping against canned
  model outputs (golden JSON snippets per fixture) — proving the schema/prompt
  contract without keys. A keyless vitest smoke suite in
  `tests/llm-eval/__tests__/` rides the standard `test` job.
- **`--live` mode** extension: runs the real `judge` task per fixture and scores
  verdict agreement (fails on any `expect.verdict` mismatch or `forbidden` hit).

All new files sit inside the `llm-eval` job's existing path filter
(`tests/llm-eval/`, `src/lib/responses/`, `src/lib/llm/`) — no workflow change.

### 2.10 Owner suspension notice — the 4th notice package (extraction deferred)

`worker/jobs/autonomy-suspended-notice/` clones the triplet shape
(`Worker.ts` + `context.ts` + `dispatch.ts` + `errors.ts`), topic
`AUTONOMY_SUSPENDED_NOTICE = 'autonomy_suspended_notice'`, payload
`{ account_id, suspension_event_id, trigger, correlation_id? }`. Notice content:
auto-posting is paused after a safety review, scope (whole account), what still
works (drafts continue; owner approves manually), reason category, support
contact, settings link. **No raw review/response text in any channel body.**

- Subscription guard via `getEligibleChannels` (invariant #11). **No feature-flag
  kill-switch guard** — a suspension notice is a safety notification and must
  deliver even mid-flag-flip (deliberate divergence from escalation/pending-post,
  documented in the worker).
- Claim/dedup: `claimAutonomySuspendedNoticeDelivery` keyed on
  `(entity_id = suspension_event_id, channel, recipient)` with the 15-minute
  self-reap (pending-post precedent — closes follow-up #3b for this template).
- Channels: `sendAutonomySuspendedNotice` added to `NotificationChannel` + 3
  implementations + email template
  (`src/lib/notifications/email/templates/autonomy-suspended-notice.ts`) +
  telegram/whatsapp bodies; WhatsApp requires
  `WHATSAPP_AUTONOMY_SUSPENDED_TEMPLATE_SID` (unset → skip, precedent).
- `retryableFailed > 0` ⇒ throw (BullMQ retry); the all-skipped systemic-failure
  warn signal (WS4 §6) is replicated.

**Triplet-extraction trigger acknowledged and deferred:** this is the 4th
topic-clone, which the WS5 handoff named as the extraction trigger. Deliberately
NOT done in WS6 — refactoring the veto-window-critical notice packages in the same
PR that adds the autonomy watchdog couples two risk surfaces. The extraction is a
dedicated follow-up with the 4 packages as its test bed.

### 2.11 Admin alert — dedicated topic, email + Sentry

`worker/jobs/AutonomyAdminAlertWorker.ts` (single-file, AdminExceptionWorker
precedent), topic `AUTONOMY_ADMIN_ALERT = 'autonomy_admin_alert'`, self-contained
payload `{ account_id, suspension_event_id, trigger, evidence }` (no
review_exceptions row — the governor path has no review anchor; the durable record
is the `account_audit_log` row):

- Primary: `sendInternalEmail` to `ADMIN_NOTIFICATION_EMAIL` (unset → log error +
  complete, AdminExceptionWorker posture). Send failure ⇒ throw (retry).
- Best-effort (log-and-swallow, never poisons the success path):
  `Sentry.captureMessage('autonomy suspended', { level: 'warning', tags:
  { subsystem: 'autonomy_watchdog', trigger } })` — the non-email paging route
  (HealthAlertPoller rationale: admin email shares Resend with the product).

### 2.12 Unsuspend — admin-only at launch

The suspension exists because the system detected a safety problem; owner
self-serve re-arm would defeat the watchdog while trust is thinnest. Owner
recovery = contact support (the notice says so).

- **`GET /api/admin/autonomy/suspensions`** — suspended policy rows (account +
  location scopes) with current governor rates + recent flag verdicts (evidence
  for the unsuspend decision). Admin-authed (`requireRole` admin, flagged-route
  precedent); cross-account reads allowlisted `admin-after-require-role`.
- **`POST /api/admin/autonomy/unsuspend`** — `{ accountId, note }`. One tx:
  `UPDATE auto_approval_policies SET suspended_at = NULL, suspended_reason = NULL,
  updated_at = NOW() WHERE account_id = $ AND location_id IS NULL AND persona =
  'reply' AND action_class = 'posting' AND suspended_at IS NOT NULL` +
  `writeAccountAuditLog` (`event_type: 'autonomy_unsuspended'`, actor admin user,
  payload `{ note, previous_reason }`). 0 rows ⇒ 409 (not suspended). Response
  reports whether the scope returns ARMED (threshold present) or stays MANUAL
  (threshold NULL — the WS4 §6 degraded shape survives; unsuspend never re-arms a
  threshold the owner cleared; the owner re-enables via settings, now unblocked).
  Route handlers orchestrate only — the module is
  `src/lib/auto-approval/suspension.ts` (`unsuspendAccountAutonomy`).
- **`src/app/admin/autonomy/page.tsx`** — minimal list + unsuspend button
  (flagged-queue clone; `repworth-brand-design` applies). No owner-facing UI
  beyond WS4's existing suspended banner.
- No owner notice on unsuspend in v1 (settings banner clears; accepted).
- No governor-rates-recovered precondition — the admin sees the rates in the GET
  and decides; the unsuspend-aware governor window (§2.7) prevents instant
  re-suspension from stale data.

### 2.13 Flags & rollout

- **`JUDGE_ENABLED`** (server-only, default off): gates JudgeSweepPoller +
  JudgeWorker processing (kill-switch first in the handler, escalation precedent)
  + is consulted by the publisher judge gate (§2.8 — off ⇒ downgrade).
- **`GOVERNOR_ENABLED`** (server-only, default off): gates
  AutonomyGovernorScheduler.
- Accessors per convention (`readFlag`; `judgeEnabled()` in
  `src/lib/responses/judge-flags.ts`, `governorEnabled()` in
  `src/lib/auto-approval/flags.ts`); both added to
  `SERVER_ONLY_FEATURE_OPTIONAL_BOOLEAN_ENV` in `worker/config/startup-assert.ts`;
  `.claude/reference/env-vars.md` rows (defaults, no `NEXT_PUBLIC_*` companions,
  the JUDGE↔AUTO_APPROVAL coupling, `WHATSAPP_AUTONOMY_SUSPENDED_TEMPLATE_SID`).
- Rollout: land PR → apply 076 (staging → prod, lockstep) → staging flips
  `JUDGE_ENABLED=true` + `GOVERNOR_ENABLED=true` (staging already runs
  `AUTO_APPROVAL_ENABLED=true`) → staging smoke (auto-post → verdict within
  minutes → forced-flag suspension drill → admin unsuspend). Prod: both flags stay
  OFF until the Autopilot go-live flip (order per handoff: `TRIAGE_ENABLED` →
  `ESCALATION_ENABLED` → WS6 flags with `AUTO_APPROVAL_ENABLED`).

## 3. Components & file map

| Piece | Path |
|---|---|
| Migration 076 | `supabase/migrations/076_judge_verdicts_governor.sql` (+ migrations-log entry) |
| Judge task registration | `src/lib/llm/tasks.ts` (+ `model-pinning.test.ts` judge block) |
| Judge prompt policy | `src/lib/responses/judge-policy.ts` |
| Judge domain call | `src/lib/responses/judge.ts` |
| Judge health | `src/lib/responses/judge-health.ts` |
| Judge flags | `src/lib/responses/judge-flags.ts` |
| Verdict store (insert/anti-join reads, sql-param) | `src/lib/responses/judge-store.ts` |
| Sweep poller | `worker/background/pollers/JudgeSweepPoller.ts` |
| Judge worker + failed hook | `worker/jobs/judge/{JudgeWorker,failed-hook}.ts` |
| Publisher judge gate | `worker/jobs/publisher/judge-gate.ts` |
| Suspension writer + unsuspend | `src/lib/auto-approval/suspension.ts` |
| Governor rates + constants | `src/lib/auto-approval/governor.ts` |
| Governor scheduler | `worker/background/schedulers/AutonomyGovernorScheduler.ts` |
| Owner notice package | `worker/jobs/autonomy-suspended-notice/*` |
| Admin alert worker | `worker/jobs/AutonomyAdminAlertWorker.ts` |
| Notice channel seam | `src/lib/notifications/channels/*` (+ email template + bodies) |
| Claim helper | `src/lib/notifications/delivery.ts` |
| Enqueue helpers | `src/lib/shared/job-outbox-helpers.ts` |
| Topics/queues | `src/lib/shared/queue-names.ts`, `worker/queues.ts`, `worker/index.ts` |
| Payload types | `src/lib/shared/worker-types.ts` |
| Audit action | `src/lib/approval/audit.ts` (new revoked-judge-unavailable action) |
| Admin API + page | `src/app/api/admin/autonomy/*`, `src/app/admin/autonomy/page.tsx` |
| Eval lane | `tests/llm-eval/judge-*` + smoke tests |
| Doc rows | `docs/directory.md`, `.claude/reference/env-vars.md`, `.claude/reference/migrations-log.md` |

New queue registrations: `judge_verdict`, `autonomy_suspended_notice`,
`autonomy_admin_alert` (queue-names → queues map → topicToQueue → worker/index.ts,
injected-`sql` style). All three new topics ride `defaultJobOptions` (3 attempts,
exponential + jitter).

## 4. Testing strategy

- **Unit (mock-sql):** sweep scan predicate + enqueue dedup; governor rate math
  (floors, window boundaries, unsuspend-aware window start, error-verdict
  exclusion, threshold edges); suspension upsert idempotence (`newlySuspended`
  false on re-suspend; INSERT arm for override-only accounts); judge prompt build
  + `JudgeOutputSchema` parse/reject; judge-health signals (stale, error-density,
  healthy, poison-single-error); publisher gate branches (flag off / unhealthy /
  healthy / query-error rethrow); notice worker guard-and-return branches; admin
  alert worker (email fail ⇒ throw; Sentry swallow); admin route auth + 409.
- **Integration (`describeWithDb`, local container only — apply 076 there):**
  verdict `ON CONFLICT` dedup; suspension → WS4 settings interplay (suspend →
  owner clear degrades to threshold-NULL → unsuspend → scope stays manual;
  suspend on override-only account creates the account-default row); evaluator
  `policy_suspended` fires after the writer (end of WS4's inert era); governor
  end-to-end against seeded outcomes/verdicts; migration 076 double-apply shape
  suite.
- **Source-shape tests:** anchor-before-INSERT in the judge writer; byte-for-byte
  `ON CONFLICT`↔partial-index pairs (074 precedent tests).
- **Gate tests:** `model-pinning.test.ts` judge block; eval smoke (keyless);
  tenant-scope allowlist entries (sweep scan, governor scan, health queries →
  `background-global-scan`; admin routes → `admin-after-require-role`) **with the
  baseline bump in the same commit** (371 → new count); `ci:db-imports` clean
  (poller/scheduler/workers registered in `worker/index.ts`; every
  `src/lib/**` module takes `sql`/`tx` params); `ci:static-policy` (no
  `NEXT_PUBLIC_*` companions).

## 5. Accepted risks & deliberate omissions

- Judge re-spend on rare post-LLM tx failure (no judge idempotent cache) — cost
  bounded at fractions of a cent.
- No judged-text snapshot on the verdict row (approval audit log covers disputes).
- Judge spend shares the per-business daily generation budget.
- Historical auto-posts older than the 24h lookback at deploy are never judged.
- A skipped (ineligible-subscription) response may be judged later if the account
  recovers inside the lookback — harmless.
- Notice-package triplet extraction deferred (4th clone ships; §2.10).
- No timeline/owner UI for verdicts; no owner notice on unsuspend.
- Governor `business_id`-level rates (per-location) deferred — account-level only,
  matching the account-default suspension scope.

## 6. Implementation amendments

(Per-task review acceptances land here during execution; on conflict they win
over the body, WS4/WS5 convention.)

- **§2.3 RI-support indexes (Task 1 review):** migration 076 additionally creates
  `idx_judge_verdicts_business (business_id)`,
  `idx_judge_verdicts_review (review_id)`, and partial
  `idx_judge_verdicts_agent_run (agent_run_id) WHERE agent_run_id IS NOT NULL`.
  PostgreSQL does not automatically index child FK columns; these prevent
  `businesses`/`reviews` CASCADE and `agent_runs` SET NULL actions from scanning
  `judge_verdicts`. `account_id` is already covered by
  `idx_judge_verdicts_account_created`, and the response UNIQUE covers
  `response_id`.
- **§2.1/§2.4 canonical judge topic routing (Task 3 review):** Task 3 pulls the
  shared `judge_verdict` queue-name constant and its inert BullMQ queue plus
  `topicToQueue` registration forward from Tasks 4/5. The verdict sweep's
  required in-flight outbox anti-join must use the canonical topic rather than
  duplicate a raw string, and `ALL_QUEUE_NAMES` requires every canonical topic
  to be routable. No producer, handler, poller, or `worker/index.ts` processing
  registration is pulled forward; runtime production and consumption remain
  Task 5 scope.
- **§2.10/§2.11 suspension topic routing (Task 4):** Task 4 pulls the inert
  BullMQ queues and `topicToQueue` mappings for `autonomy_suspended_notice` and
  `autonomy_admin_alert` forward from Tasks 8/9. Adding their canonical names
  to `ALL_QUEUE_NAMES` requires complete routing immediately. No handler or
  `worker/index.ts` registration is pulled forward; runtime consumption remains
  Tasks 8/9 scope.
- **§2.12 prior-reason capture (Task 4):** `unsuspendAccountAutonomy` snapshots
  the guarded account-default row in a `FOR UPDATE` CTE, clears it with
  `UPDATE ... FROM target`, and returns the target's prior reason and threshold.
  PostgreSQL's plain `UPDATE ... RETURNING suspended_reason` observes the
  post-update NULL, which cannot populate the required audit
  `previous_reason`; the single-statement CTE preserves the specified atomic
  guarded update and its zero-row semantics.
- **§2.3/§2.5 verdict-ID correlation (Task 5):** `insertJudgeVerdict` accepts an
  optional caller-generated UUIDv7 while retaining its `{ inserted }` return
  contract and its internal UUIDv7 default. `JudgeWorker` supplies the ID so the
  exact successfully inserted verdict can be embedded as
  `evidence.verdict_id` in the same transaction's `judge_flag` suspension;
  otherwise the store's boolean-only conflict contract gives the caller no
  reliable ID to correlate without an extra read.
- **§2.4/§2.5/§2.8 subscription eligibility (Task 6 review):** CLAUDE invariant
  #11 overrides the body text that limits Judge processing and health to
  `active`/`trialing`. The sweep and health scans use one shared SQL predicate
  matching publisher eligibility: `active`, `trialing`, and `past_due` during
  the unexpired seven-day grace (or a valid unexpired admin extension). The
  JudgeWorker revalidates the same rule through canonical
  `checkSubscription(..., workerType: 'publisher')`. Missing/expired grace,
  `cancelled`, and `pending_payment` remain ineligible. This keeps the watchdog
  population coherent with responses the publisher is still permitted to post.
  Extension timestamps use one exact server-generated format in TypeScript and
  SQL: the UTC-millisecond string emitted by `Date.toISOString()`
  (`YYYY-MM-DDTHH:mm:ss.SSSZ`). Offsets, other fractional widths, impossible
  calendar/time values, date-only and PostgreSQL-only values fail closed. The
  PostgreSQL-15-compatible SQL predicate uses a fixed-width regex, nested lazy
  `CASE` branches, and exception-free Gregorian leap/month arithmetic before a
  fixed-width UTC string comparison; it performs no timestamp cast. Thus one
  malformed account cannot abort a fleet sweep or health scan.
- **§2.7 bounded fairness and stale-candidate revalidation (Task 7 adversarial
  review):** the governor carries the last evaluated `account_id` across cycles
  and circularly orders the next bounded page after that key, wrapping to the
  start. This prevents a fixed `LIMIT 50` from permanently starving later
  healthy accounts. Every canonical suspend, unsuspend, and governor
  revalidation first locks the guaranteed `accounts` row; governor then locks
  the current policy rows in stable ID order and revalidates that autonomy
  remains armed, no suspended account-default exists, and no
  `autonomy_unsuspended` audit is newer than the scan's observed window. This
  account serialization closes the override-only missing-default gap: an admin
  unsuspend cannot commit between governor revalidation and suspension, so
  equal audit timestamps cannot create a post-revalidation race. A stale
  disarm or pre-lock admin-unsuspend snapshot emits no suspension audit or
  outbox work. Judge acquires the account lock only after its required
  review/business/child locks; governor/admin acquire no review-lane locks, so
  no reverse lock edge is introduced.
