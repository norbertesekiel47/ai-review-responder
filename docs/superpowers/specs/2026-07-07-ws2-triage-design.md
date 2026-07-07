# WS2 — Triage: LLM severity classification on the negative lane — Design

**Status:** Accepted (brainstormed 2026-07-07 against the design of record; open decisions
from the WS1→WS2 handoff resolved below with evidence).
**Parent:** `docs/future-plans/2026-07-01-agentic-reputation-platform-design.md` (§2.2 Guardian,
§3.1 triage step, §5.2 fail-safe) and the Phase 1 decomposition table in
`docs/superpowers/plans/2026-07-01-agentic-platform-phase1-run-spine.md` (WS2 row).
**Depends on:** WS1 (shipped — run spine, migration 071). **Blocks:** WS3 (Guardian).

---

## 1. What WS2 ships

One cost-guarded LLM classification per **non-positive** review, run inside the existing
`ResponseGeneratorWorker` job before drafting, producing `{severity, issues,
suggested_action}`; persisted on the `reviews` row (migration 072); recorded as a
`triage` step (persona `guardian`) on the review's `review_handler` run; severity fed
into the reply prompt as tone guidance; and a triage-severity veto added to the
auto-approval gate. Behind a server-only kill switch `TRIAGE_ENABLED` (default off).

Explicitly **not** WS2: escalation notifications / resolution state (WS3), rating-band
policy redesign (WS4), timeline UI (WS5), triage evals in CI (WS7).

## 2. Resolved design decisions

### 2.1 Placement — in the response-generation job, before drafting

Triage runs in `handleResponseGeneration` between `loadGenerationContext` and
`generateDraft`. Rationale: the design doc wants "one shared LLM call early in the run"
whose severity can shape reply tone; the generation job is the first point where the
review + business context + subscription guard + cost plumbing already exist. No new
queue, no pipeline topology change, no new worker. (A dedicated triage worker was
rejected: it buys nothing at launch volume and adds an outbox hop + failure surface.)

The LLM call happens **outside** any DB transaction (never hold locks across remote
calls); persistence + spine step happen after it in one short tx.

### 2.2 Scope — non-positive lane only

LLM triage runs when `classifySentiment(starRating).label !== 'positive'` (≤3★ or
rating-less). The positive lane (4–5★) gets **no** LLM call, **no** triage columns,
**no** spine step — mirroring the "unchanged review does not touch the spine"
discipline. The WS2 decomposition row ("severity classification on the negative lane")
is authoritative over the design doc's looser "shared by both branches" phrasing;
deterministic sentiment already fully routes the positive lane. Rating-less/text-less
reviews still get the LLM call (prompt handles "(no text)") — one code path, no
deterministic side-branch to maintain.

### 2.3 Persistence — columns on `reviews` (migration 072), not the spine

The spine is attribution data, not pipeline state (design §3.2); WS3's escalation logic
must not read `agent_run_steps` to make decisions. Following the `sentiment_*`
precedent, migration 072 adds nullable columns to `reviews`:

| Column | Type / constraint |
|---|---|
| `triage_severity` | TEXT CHECK IN ('low','medium','high') |
| `triage_issues` | TEXT[] (values validated app-side against the taxonomy) |
| `triage_suggested_action` | TEXT CHECK IN ('respond','escalate','respond_and_escalate') |
| `triage_source` | TEXT — 'llm_triage_v1' \| 'fallback_high_v1' \| 'mock_v1' |
| `triage_model` | TEXT (pinned model id that produced it; NULL for fallback) |
| `triage_content_hash` | TEXT (the `review_content_hash` that was classified) |
| `triaged_at` | TIMESTAMPTZ |

A single-row CHECK ties them together: all-null or (`triage_severity` + `triage_source`
+ `triaged_at` non-null). No new table → no RLS/offboarding/tenant-table registration
changes (columns ride `reviews`' existing disposition). No new index (WS3 decides its
own query shape).

**Idempotency & invalidation:** skip re-triage when `triaged_at IS NOT NULL AND
triage_content_hash IS NOT DISTINCT FROM review_content_hash AND triage_source <>
'fallback_high_v1'` (fallback rows are re-attempted — see 2.6). A content-changed review
gets a new hash → next generation job re-triages. A BullMQ retry after triage committed
skips the second LLM spend (durable DB check; no Redis cache needed).

### 2.4 LLM task — first structured-output tenant of the seam

- `LLM_TASKS` gains `triage`: primary `gpt-4o-mini-2024-07-18`, fallback
  `claude-haiku-4-5-20251001` (same pins as the other tasks), `maxTokens: 200`,
  `temperature: 0`, and the first live `outputSchema` (zod).
- `runLlmTask` replaces its fail-loud `structured output not yet implemented` guard with
  enforcement: when the task has an `outputSchema`, strip code fences, `JSON.parse`, and
  `schema.parse` the completion; a parse/validation failure counts as **that provider
  attempt failing** → fallback provider is tried; if all attempts fail validation the
  error is **terminal** (temperature-0 retries of the same provider won't converge;
  never wrapped as `TransientLLMError`). Validated value is returned on a new optional
  `LLMCallResult.structured` field; text stays raw. Transient/terminal classification
  for transport errors is unchanged.
- `model-pinning.test.ts` extends to the triage entry.

Output schema:

```ts
{
  severity: 'low' | 'medium' | 'high',
  issues: TriageIssue[] (0–3, from the fixed taxonomy),
  suggested_action: 'respond' | 'escalate' | 'respond_and_escalate',
}
```

Issue taxonomy (fixed enum — keeps `detail` JSONB and analytics free of raw text):
`service_quality`, `product_quality`, `wait_time`, `pricing`, `cleanliness`,
`staff_conduct`, `order_accuracy`, `communication`, `safety_or_health`,
`billing_or_refund`, `other`.

Prompt: system prompt defines the severity rubric (high = threats, legal/safety/health,
discrimination, viral-risk accusations; medium = concrete service failures, refund
demands; low = mild criticism) and the JSON contract, with the standard
treat-review-text-as-untrusted-data line; user prompt carries star rating + sanitized
review text truncated to 1,500 chars (or "(no text)").

### 2.5 Cost guard — same shape as `review-summary.ts`

`withCostGuard({ businessId, subscriptionTier, withConcurrency: false, onFinalizeError:
'log-and-return-value' })` wrapping the `runLlmTask('triage', …)` call; actual cost from
`calculateCostUsd`; `api_costs` audit row with `endpoint: 'review-triage'`,
`responseId: null` (best-effort, log-and-swallow, matching review-summary). The
pessimistic reserve precedes the call, so spend stays safe even when limiters are
bypassed. Pre-LLM Redis **transport** failures surface as `CostInfraUnavailableError`
(retryable); budget decisions stay terminal-shaped (see 2.6).

### 2.6 Failure semantics — everything fails toward "ask the owner"

| Failure at triage | Behavior |
|---|---|
| `TransientLLMError`, `CostInfraUnavailableError` | Rethrow → BullMQ retries the job (3× + backoff) + 1h outbox watchdog. No draft spend has happened yet; committed triage is skipped on retry via the hash check. |
| Budget decision (`CostLimitExceeded` / `GlobalCostLimitExceeded`) | Apply the **fallback classification** and continue — generation's own cost guard owns the terminal cost-cap behavior (alert + outbox failed). Triage never double-owns that decision. |
| Terminal LLM error / schema-invalid on both providers | Apply the fallback classification and continue. |

**Fallback classification** (design §5.2 "triage inconclusive → negative/hold lane"):
`severity='high'`, `issues=[]`, `suggested_action='escalate'`,
`triage_source='fallback_high_v1'`, `triage_model=NULL`. Persisted like a real result
(so WS3 escalates it), spine step status `'failed'` (consistent with
`moderation_checked`'s held-draft semantics). A fallback result is **not** cached
forever: fallback rows are re-attempted on the next generation job for that review
(skip-check requires `triage_source <> 'fallback_high_v1'`), bounded naturally by
generation job frequency.

`TRIAGE_ENABLED=false` (default): the whole phase is skipped — no LLM call, no columns
written, no step, no veto input. Flip on staging first.

### 2.7 Spine instrumentation — `triage` step, persona `guardian`

- `STEP_PERSONA` gains `triage: 'guardian'` (+ totality/attribution tests).
- Recorded in the **same tx** as the `reviews.triage_*` UPDATE, with the review row
  locked `FOR UPDATE` as the tx's **first statement** (binding lock-ordering rule from
  the run-spine header), then `findActiveReviewRun` → `recordStep`:
  `status: 'completed' | 'failed'(fallback)`, `detail: { severity, suggested_action,
  issues, source, model }` (enums/ids only), `latencyMs` measured around the LLM call.
- Legacy reviews with no running run: triage columns still persist; step is skipped
  (`findActiveReviewRun` returns null) — same posture as the WS1 checkpoints.
- No `agent_outcomes` row: triage is a step, not an owner-billable outcome; the
  escalation outcome (`review_escalated`) belongs to WS3.

### 2.8 Severity → reply tone

`buildProductionPrompt` accepts optional triage context; for `medium`/`high` it appends
dynamic guidance (lead with empathy, no defensiveness, acknowledge the specific issue
categories, invite offline resolution; for `high` additionally: short, no excuses, no
disputing facts). This is the **dynamic** prompt layer — `SYSTEM_PROMPT_BASE` and
`PROMPT_VERSION` are untouched. Plumbing: worker passes the triage result through
`generateDraft` → `generateResponse` opts → prompt builder. `pnpm eval:llm` runs as a
local gate before merge (WS7 later automates this). Mock generator ignores severity.

### 2.9 Auto-approval veto — real safety, not dead code

`AutoApprovalThreshold` legally goes down to **1**, so a ≤3★ review can auto-post today
if an owner configures it — design §3.3's "negative-review autonomy is never granted at
launch" is not currently enforced. WS2 adds the minimal triage input to the existing
gate (invariant #3's gate list, extended not rewritten):

- `loadAutoApprovalRuntimeState` also reads `triage_severity`/`triage_source` (same
  locked re-read it already does for the content hash).
- `evaluateAutoApprovalCandidate` blocks with reason `triage_high_severity` when
  severity is `'high'`, and `triage_fallback` when `triage_source` is the fallback.

Residual (documented, deliberate): a `low`/`medium` ≤3★ review with an owner-set
threshold ≤3 can still auto-post when `AUTO_APPROVAL_ENABLED=true` — full rating-band
enforcement is WS4's trust-dial scope. The flag is off in prod today, so exposure is
zero until WS4 lands anyway.

### 2.10 Mock mode

`isMockMode()` → deterministic mock triage (1–2★ → `medium`, else `low`; `issues:
['other']` when text exists; `suggested_action: 'respond'`; `triage_source: 'mock_v1'`),
no provider call — keeps `MOCK_EXTERNAL_APIS=true` dev loops and tests keyless.

## 3. Components & file map

| Unit | Responsibility |
|---|---|
| `supabase/migrations/072_review_triage.sql` (create) | 2.3 columns + CHECKs |
| `src/lib/reviews/triage.ts` (create) | Domain module: taxonomy + zod schema, prompt builder, `classifyReviewTriage(sql, …)` (mock/cost-guard/LLM/fallback), `persistTriage(tx, …)` (lock → UPDATE → spine step). Takes `sql`/`tx` params (invariant #15). |
| `src/lib/llm/run-task.ts`, `tasks.ts` (modify) | Structured-output enforcement; `triage` registry entry |
| `src/lib/agents/run-spine.ts` (modify) | `STEP_PERSONA.triage = 'guardian'` |
| `worker/jobs/response-generation/triage.ts` (create) | Worker phase: flag + eligibility + idempotency check, orchestrates classify→persist, failure mapping per 2.6 |
| `worker/jobs/ResponseGeneratorWorker.ts` (modify) | Call the triage phase; thread result to `generateDraft` |
| `generate-draft.ts`, `src/lib/responses/generator.ts`, `prompt-builder.ts` (modify) | Optional triage context → tone guidance |
| `worker/jobs/response-generation/auto-approval.ts` (modify) | Runtime-state read + veto (2.9) |
| Tests | Colocated per repo pattern (mocked-`sql` via `createMockSql` harness; `describeWithDb` integration where warranted); extend `model-pinning.test.ts`, run-spine persona tests, persist/auto-approval tests |
| Docs | `migrations-log.md` (072, head bump), `env-vars.md` (`TRIAGE_ENABLED`) |

## 4. Testing strategy

- **Unit (TDD per task):** schema validation + fence-stripping edge cases in the seam;
  eligibility/idempotency/fallback matrix in the worker phase; lock-ordering (first
  statement is the review `FOR UPDATE`) in `persistTriage`; veto reasons in
  `evaluateAutoApprovalCandidate`; persona-map totality.
- **Failure propagation:** transient rethrow vs fallback-and-continue vs
  budget-decision passthrough, mirroring WS1's checkpoint failure tests.
- **Integration (`describeWithDb`):** triage persist + step append against real
  Postgres, re-triage on content-hash change, fallback re-attempt.
- **Gates:** `pnpm lint && pnpm typecheck && pnpm test` + all `ci:*` audits +
  `pnpm eval:llm` (offline) before PR.

## 5. Rollout

Migration 072 staging-first, both Supabase projects in lockstep. `TRIAGE_ENABLED=true`
on staging worker → observe a few negative-lane runs (`agent_run_steps.step_key='triage'`,
`reviews.triage_*`, `api_costs.endpoint='review-triage'`) → enable in prod. Kill switch
is the same flag.
