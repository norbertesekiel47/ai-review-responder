# WS5 — Persona surfaces — Design

**Status:** Accepted (brainstorm session 2026-07-12, Norbert + Claude).
**Parents:** design of record
[2026-07-01-agentic-reputation-platform-design.md](../../future-plans/2026-07-01-agentic-reputation-platform-design.md)
(§3.1 personas at the presentation layer, §2.2 Insights = repackaged weekly-report machinery)
and the Phase 1 decomposition row in
[2026-07-01-agentic-platform-phase1-run-spine.md](../plans/2026-07-01-agentic-platform-phase1-run-spine.md)
(*"WS5 — Persona surfaces: run-timeline page, dashboard 'agent team' reframe, Insights
persona labeling on the weekly report. Depends on WS1. Ships: the product story owners see."*).
WS4 spec §6 amendments and CLAUDE.md invariants win over anything here on conflict.
**Kickoff handoff:** `/tmp/repworth-handoff-2026-07-13-ws5-persona-surfaces.md` (ground
rules restated in §7 below).

---

## 1. What WS5 ships

1. **Run-timeline page** — deep-linkable `/dashboard/reviews/[reviewId]/timeline`,
   the first owner-facing read path over the deny-all-RLS spine tables.
2. **Terminal-failure run checkpoints** — `completeRun('failed')` at the terminal
   draft-failure and publisher-exhaustion seams (closes the WS1 follow-up).
3. **Agent-team dashboard reframe** — persona badges on existing feed cards + an
   "agent team" summary strip. No new IA (design doc: three visible agents at ~80%
   existing code).
4. **Insights instrumentation** — the spine's second tenant: `weekly_insights` runs +
   the never-emitted `digest_sent` outcome, recorded by the weekly report worker;
   weekly email relabeled as the Insights persona.
5. **Escalation surfaces owed since WS3** — aggregate-feed escalation badges + a
   "Needs attention" discharge list for open escalations whose reviews left the
   pending feed.
6. **Scheduled-posts visibility** — a "Scheduled" chip in the feed during the veto
   window (WS4 named WS5 the natural home).
7. **Migration 075** — one index supporting the timeline's completed-run lookup.

**Resolved scope decisions (2026-07-12, user-confirmed):** per-review timeline *page*
(not drawer, not account activity feed); honest render + failure checkpoints (no
abandonment sweep); badges + strip (no dedicated team page); scheduled chip IN.

**Out of scope:** abandonment sweep for vetoed-never-reapproved runs (they render as
"waiting on you", which is truthful); dedicated `/dashboard/team` page; account-wide
activity feed; any new LLM call (nothing in WS5 rides the cost guard); new analytics
events; conversational surfaces; feature flags (all WS5 surfaces are read-honest at any
flag state — spine rows exist in prod since WS1; prod simply has no auto-post or
escalation rows yet, and every surface degrades to its empty state).

---

## 2. Run-timeline page + read path

### 2.1 Route + auth

`GET /api/dashboard/reviews/[reviewId]/timeline`. Auth mirrors the canonical
dashboard-review shape (`src/lib/approval/http-routes.ts:141` —
`requireDashboardReviewOwner`): owner role + `accountId`, then a tenant-scoped
pre-read `reviews r JOIN businesses b ON … WHERE r.id = … AND b.account_id = … AND
b.archived_at IS NULL` as a **flat top-level statement** (the tenant-scope auditor
cannot see predicates inside subqueries). 404 on scope miss, per the
`runDashboardReviewAction` precedent. Read-only — no `withSameOrigin` needed, no
subscription-writability gate (read surfaces stay visible to `past_due`/grace states,
same posture as `GET /api/dashboard`).

### 2.2 Read module

New **`src/lib/agents/read.ts`** — the spine's read module. `run-spine.ts` remains
the only *writer* (its header contract). All functions take `sql: Sql` as an explicit
parameter (invariant #15); the route is the composition root. Functions:

- `getReviewTimeline(sql, {accountId, reviewId})` — runs for the review
  (`kind='review_handler' AND subject_type='review' AND subject_id=<reviewId>`,
  `ORDER BY started_at DESC`, served by the 075 index), each run's steps
  (`ORDER BY step_index`, served by `agent_run_steps_index_uniq`) and outcomes
  (served by the `agent_outcomes_once_per_run_kind` partial index — its
  `agent_run_id IS NOT NULL` predicate is satisfied by the equality lookup).
  Bounded: runs capped (LIMIT 20, newest first) — a review cannot accumulate
  unbounded runs in practice, the cap is a production.md guard.
- `getAgentTeamSummary(sql, scope, window)` — §4.2.

### 2.3 Response contract

```
{
  review:      { id, rating, reviewerName, submittedAt, status },
  response:    { id, status, approvalMethod, autoPostScheduledAt, postedAt,
                 responseText, version } | null,
  escalation:  { id, status, severity, suggestedAction, createdAt,
                 acknowledgedAt, resolvedAt } | null,
  runs: [{
    id, status, startedAt, endedAt, error,
    displayState: 'in_progress' | 'waiting_on_owner' | 'stalled'
                | 'completed' | 'failed',
    steps:    [{ stepIndex, stepKey, attributedAgent, status, detail,
                 latencyMs, createdAt }],
    outcomes: [{ outcomeKind, attributedAgent, occurredAt }]
  }]
}
```

- Human context (response text/status, escalation state, review content) is joined
  from the **owning tables** in this route; step `detail` is ids/enums only and the
  UI renders it as structured facts, never prose (WS1 contract).
- Personas render from the stored `attributed_agent` on steps/outcomes — **never
  re-derived** (agenda item 7). `STEP_PERSONA` is extended only by new step kinds.
- Escalation *history* renders from `review_escalations` + `escalation_raised` steps,
  not from outcomes — per-(run, kind) outcome dedup means a resolved-then-re-raised
  escalation has no second `review_escalated` outcome row.
- `autoPostScheduledAt` is read live from `responses` at request time — it is
  current-truth (the WS4 late-notice gate can push it); never cached or derived.
- Legacy review with zero runs → `runs: []`; the page renders an honest empty state
  ("this review predates the agent timeline"), not a fabricated one.

### 2.4 `displayState` derivation (server-side, single owner)

Derived in `read.ts` (one owner; the UI renders it, tests pin it):

| Condition (evaluated in order) | displayState |
|---|---|
| `status='completed'` | `completed` |
| `status='failed'` | `failed` |
| `status='running'` AND latest response status ∈ {`pending_approval`, `awaiting_owner_connect`} (covers veto/downgrade, which returns the response to owner review) | `waiting_on_owner` |
| `status='running'` AND `started_at` older than **48h** | `stalled` (badge + age) |
| `status='running'` otherwise | `in_progress` |

A scheduled auto-post (approved + `auto_policy` + future `auto_post_scheduled_at`)
is `in_progress` — the system, not the owner, holds the next move.

### 2.5 Page + UI

`src/app/(authenticated)/dashboard/reviews/[reviewId]/timeline/page.tsx` +
components under `src/components/dashboard/timeline/`. Entered from a feed-card
link (§4.1). Renders: review header, vertical step timeline grouped by run
(persona icon + label per step from `attributed_agent`), outcome chips, the
displayState badge, and — when an open escalation exists — **Acknowledge/Resolve
actions** wired to the existing `POST /api/dashboard/escalations/[id]/{acknowledge,resolve}`
routes (§5.2). `repworth-brand-design` skill is mandatory for all of it.

---

## 3. Terminal-failure checkpoints

Two new `completeRun('failed')` writers, each **in the same transaction as the state
change that marks the terminal failure** (outbox discipline, never best-effort):

1. **Terminal draft failure** — where the response-generation lane records its
   terminal `{kind:'failed'}` state for a review (non-retryable classification —
   budget-exceeded decisions, `guardrail_failed`, moderation-terminal, etc.). The
   executor locates the exact seam in `worker/jobs/response-generation/` (the
   generate-draft terminal branch and/or its persistence of the failed state); the
   contract is: wherever the review's handling reaches a no-further-retry state with
   no posted reply, the active run completes `failed` with a structured `error`.
2. **Publisher exhaustion** — `worker/jobs/publisher/failed-hook.ts` (BullMQ
   `'failed'` exhaustion): the run for the review completes `failed` in the same tx
   as the hook's terminal state write.

Rules for both (lock-order law, tripwire-enforced):

- **Reviews lock FIRST** — before any statement taking an implicit FK lock
  (`recordOutcome`/`completeRun` INSERT/UPDATE paths take `FOR KEY SHARE` on
  `agent_runs`). Use `anchorReviewLockOrder` (`src/lib/approval/outcomes.ts:39`)
  or an explicit `FROM reviews … FOR UPDATE` as the tx's first statement.
- Both call sites are added to `CALLER_ALLOWLIST` in
  `src/lib/approval/__tests__/outcome-anchor-pairing.test.ts` — extend the
  tripwire, never fight it.
- `completeRun` is already idempotent (`running`→terminal only, replay-safe) —
  BullMQ retries and watchdog re-dispatches stay safe.
- Retryable/transient failures never complete the run — only the terminal
  classification does. If no active run exists (legacy review), the checkpoint is a
  no-op, not an error.

The WS1 "terminal-failure completion" follow-up closes here. The abandonment sweep
stays explicitly unshipped (§1 out-of-scope).

---

## 4. Agent-team dashboard reframe

### 4.1 Persona badges + scheduled chip on feed cards

`ReviewFeedCard` (`src/components/dashboard/reviews/ReviewFeedCard.tsx`) gains
persona attribution derived **from data already in the feed item** — no per-review
spine query, no N+1:

- **Reply badge** — a response exists on the item; the auto variant when the
  existing auto-approved signal shows (the `AutoApprovedBadge` data).
- **Guardian badge** — `escalation != null` (already on the per-location feed item,
  `src/lib/dashboard/types.ts:105`).
- **Insights** never badges feed cards.
- **Scheduled chip** — "Scheduled — posts at HH:MM" when
  `status='approved' AND approval_method='auto_policy' AND auto_post_scheduled_at`
  is in the future, linking to the approve page (which already renders the veto /
  Cancel-auto-post surface, `src/app/api/approve/[token]/route.ts:68-115`). If the
  feed projection (`src/lib/dashboard/service.ts:140-189`) lacks `approval_method` /
  `auto_post_scheduled_at`, extend the projection + `DashboardDataActive` types —
  values read live per request, never cached (deadline pushes).
- **Timeline link** — each feed card links to `/dashboard/reviews/[reviewId]/timeline`.

These signals are presentation-layer derivations of persona semantics consistent
with `STEP_PERSONA`; the timeline page is where stored attribution is authoritative.

### 4.2 "Your agent team" summary strip

New `GET /api/dashboard/agent-team?window=…` route (keeps the main dashboard payload
untouched; second react-query in `DashboardContent`). Auth `requireOwnerWithAccount`
+ `resolveDashboardRequest` (same scope policy as `/api/dashboard/kpis`, including
the location IDOR check). Windows reuse `DASHBOARD_WINDOWS` from `src/lib/kpi/types.ts`.

`getAgentTeamSummary(sql, scope, window)` in `read.ts` aggregates `agent_outcomes`:

| Persona | Counted outcome kinds |
|---|---|
| Reply | `reply_posted` + `reply_auto_posted` |
| Guardian | `review_escalated` |
| Insights | `digest_sent` |

Scope follows the dashboard scope policy (account-wide in aggregate view; filtered
by `business_id` in per-location view — matches KPI behavior). Account-scoped reads
ride `idx_agent_outcomes_account_occurred (account_id, occurred_at DESC)`; the
per-location filter applies on top (acceptable selectivity at current volume — no
new index). Tenant predicates written **inline in the top-level statement** (KPI
service precedent, `src/lib/kpi/service.ts` header).

UI: a strip of three persona cards (Reply / Guardian / Insights — icon, name,
one-line role, windowed count) rendered in `DashboardContent` near the KPI band;
empty counts render as the agent "standing by", not hidden. The existing
`IntelligenceBriefCard` gains an Insights persona attribution label (copy-only).
`repworth-brand-design` mandatory.

---

## 5. Insights instrumentation + escalation surfaces

### 5.1 `weekly_insights` runs + `digest_sent` (the spine's second tenant)

Today: `worker/jobs/WeeklySummaryWorker.ts` sends per-business digests
(scheduler enqueues one outbox row per business) with **zero spine writes**;
`digest_sent` exists in `AGENT_OUTCOME_KINDS` and the 071/074 CHECKs but has no
emitter; `startOrGetActiveRun` already types `{kind:'weekly_insights',
subjectType:'account_week'}`.

**Shape: one short-lived run per digest send.** In ONE transaction wrapped around
the existing crash-safe `sent_at` flip (WeeklySummaryWorker ~L238-242, which
deliberately precedes the Resend call — the spine writes adopt the same posture:
they record "digest send committed", exactly as `sent_at` does):

1. `startOrGetActiveRun(tx, { kind:'weekly_insights', subjectType:'account_week',
   subjectId: `${accountId}_${weekStartDate}`, accountId, businessId,
   correlationId })`
2. `recordStep(tx, …)` with **new step key `digest_sent`** → persona `insights`
   (extends `STEP_PERSONA` — the map's first `insights` entry — plus totality
   tests); `detail` ids/enums only (e.g. `{ week_start_date, business_id }`).
3. `recordOutcome(tx, …)` `outcome_kind='digest_sent'`, `attributed_agent='insights'`.
4. `completeRun(tx, runId, 'completed')`.

Multi-location accounts produce N completed runs per account-week (one per
business digest) sharing the `subject_id` — legal (the
`agent_runs_one_active_per_subject` partial unique blocks only *concurrent
running* runs) and each an honest record; `business_id` on the run says which
digest. Outcome dedup is per-run, so each send gets its outcome row and the team
strip counts N digests.

**Tripwire carve-out (documented, not fought):** this is a new
`recordOutcome`/`completeRun` call site with **no review subject** — the
`account_week` lane touches no `reviews` rows, so it cannot join a lock cycle with
the review-anchored lanes; the reviews-first law's domain is transactions that
touch review-lane rows. Extend
`outcome-anchor-pairing.test.ts` with an explicitly-commented non-review-subject
allowlist (e.g. `NON_REVIEW_SUBJECT_CALLERS`) for this caller, keeping the
reviews-lock pairing mandatory for everything else. The weekly tx must **never**
grow a `reviews` or `businesses` lock later without re-entering the ordering law.

**Idempotency:** the worker's existing claim + `ON CONFLICT (business_id,
week_start_date)` upsert already dedups sends; the spine writes ride inside the
same guarded flip, so a re-run cannot double-record (`sent_at` already set → flip
skipped → no spine writes).

**Persona labeling (copy-only):** the weekly email template
(`src/lib/notifications/email/templates/weekly-value-report.ts`) + subject line
(worker ~L250) are relabeled as the Insights agent's report ("Your Insights agent's
weekly report" shape — final copy at execution under `repworth-brand-design`).
No template SID / channel work — email only.

### 5.2 Escalation badges + exception-queue discharge (WS3-owed)

1. **Aggregate-feed badges:** the aggregate dashboard feed gains the same
   open-escalation LATERAL join the per-location feed has
   (`src/lib/dashboard/service.ts:172-185` — `e.status <> 'resolved'`, matching the
   `review_escalations_one_open_per_review` partial-index predicate
   **byte-for-byte**) and the same `escalation` field + badge rendering
   (`active-mappers.ts:43-49` precedent) in the aggregate components.
2. **"Needs attention" discharge list:** new `GET /api/dashboard/escalations`
   (account-scoped, `requireOwnerWithAccount`): open escalations
   (`status <> 'resolved'`) joined to review + business name, ordered
   `escalated` before `acknowledged`, then severity high→low, then oldest first;
   **bounded** (LIMIT 20 + total count). Served by
   `idx_review_escalations_account_status (account_id, status)`. Rendered as a
   compact dashboard list (only when non-empty) — each row links to the review's
   timeline page, where Acknowledge/Resolve actions live (existing transition
   routes, `withSameOrigin`, 409 already-resolved mapping — `src/lib/escalations/
   http-routes.ts`). This makes escalations on posted/left-the-feed reviews
   dischargeable — the exception queue closes.

---

## 6. Migration 075, performance, testing

### 6.1 Migration 075 (read `.claude/reference/migrations-log.md` first; head 074)

One index — the timeline's completed-run lookup has no support today (071's
`agent_runs_one_active_per_subject` is partial on `status='running'`; the other 071
indexes lead on `business_id`/`account_id`):

```sql
CREATE INDEX idx_agent_runs_subject
  ON agent_runs (subject_type, subject_id, started_at DESC);
```

No other new indexes: team strip → `idx_agent_outcomes_account_occurred`; steps →
`agent_run_steps_index_uniq`; outcomes-by-run → the partial unique; needs-attention →
`idx_review_escalations_account_status` (all verified against 071/073). Apply to
**staging first, then prod** in lockstep, per deployment-guide. The migration is
index-only ⇒ no two-directional apply-window hazard; code-before-075 merely means a
slow (seq-scan) timeline read, never a wrong one.

### 6.2 Testing strategy

- **Unit (mocked `sql`,** `worker/__tests__/helpers/mock-sql.ts`**)**: `read.ts`
  query shapes + displayState derivation table (§2.4 pinned case-by-case); route
  handlers (auth, 404-on-scope-miss, bounded outputs); feed-card badge/chip
  derivation; weekly worker spine-write wiring (skip-when-already-sent).
- **Live-DB (`describeWithDb`,** local container per ground rules**)**: timeline
  read over a seeded run (runs+steps+outcomes round-trip, ordering, legacy-empty
  case); `weekly_insights` tx (run+step+outcome+complete committed atomically with
  the `sent_at` flip; re-run no-ops); terminal-failure checkpoints (run flips to
  `failed`; idempotent replay); team-strip aggregation.
- **Tripwires extended:** `outcome-anchor-pairing.test.ts` (new callers +
  non-review-subject carve-out); `STEP_PERSONA` totality tests in
  `src/lib/agents/__tests__/` for the `digest_sent` key.
- **Audits, same commit as the change:** `scripts/ci/tenant-scope-allowlist.ts`
  (exact SQL snippets for the new reads), `ci:db-imports` (new routes are
  composition roots; `read.ts` takes `sql` param), rls-inventory untouched (no new
  tables), `docs/directory.md` rows for `read.ts`, timeline page/components, new
  routes. `-- topic-audit-ignore` only where the audit demands.
- **Gates:** `pnpm lint`, `pnpm typecheck`, sequential full suite
  (`pnpm vitest run --no-file-parallelism` with local-container
  `TEST_DATABASE_POOL_URL` + `DATABASE_POOL_URL` exported), every `ci:*` audit,
  `pnpm eval:llm` (offline).

---

## 7. Binding ground rules (from the WS5 handoff — restated, they apply verbatim)

- `ci:db-imports` STRICT (invariant #15); `tx.json()` for JSONB in domain modules.
- **Lock-order law:** reviews → businesses → responses/child rows → agent_runs;
  "first" = before ANY implicit-FK-lock statement; tripwire-enforced.
- Outbox pattern for state change + follow-up; BullMQ job IDs use `_`.
- ON CONFLICT byte-for-byte with partial-index predicates.
- Outcome writes are durable facts → in-tx; best-effort only for observability.
- fallow CI gate: prefer extraction over threshold-busting complexity; regenerate
  stale local coverage before trusting a red.
- Brittle allowlists land in the SAME commit as the change they cover.
- `TEST_DATABASE_POOL_URL` = local container only
  (`postgresql://test:test@localhost:5499/test_ws4`) — never any Supabase URL.
- Never log raw review/response text, tokens, secrets (returning them via authed
  API responses to their owner is the dashboard's job and is fine).
- `react-doctor` CI check is known-broken repo-wide — not a required check, don't
  chase it as a code failure.
