# WS5 — Persona Surfaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the owner-facing persona surfaces — run-timeline page, agent-team dashboard reframe, Insights instrumentation + labeling, escalation discharge, scheduled-post visibility — per the accepted spec.

**Spec (authoritative):** `docs/superpowers/specs/2026-07-12-ws5-persona-surfaces-design.md`. On any conflict, the spec wins; on conflict with CLAUDE.md invariants or WS4 spec §6 amendments, those win over both.

**Architecture:** First owner read path over the deny-all-RLS spine tables via a new read module (`src/lib/agents/read.ts`, `sql` as param) + thin composition-root routes; two new `completeRun('failed')` writers under the lock-order law; the weekly worker becomes the spine's second tenant (per-send `weekly_insights` runs); all UI is a reframe of existing dashboard surfaces under `repworth-brand-design`.

**Tech stack:** Next.js 16 routes + React dashboard components, Postgres.js (`sql`/`tx` param convention), Vitest (mocked-`sql` via `worker/__tests__/helpers/mock-sql.ts`; live-DB via `describeWithDb` against the LOCAL container `postgresql://test:test@localhost:5499/test_ws4`), migration 075.

**Branch:** work happens on `feat/ws5-persona-surfaces` (spec + this plan are its first commits). Never push to `main`.

**Every task, non-negotiable:**
- Read the spec section named in the task BEFORE coding.
- Brittle allowlists (`tenant-scope-allowlist.ts`, static-policy, tripwire caller lists, CLAUDE.md JSONB-guard allowlist) land in the SAME commit as the change that needs them.
- `pnpm lint && pnpm typecheck` green before every commit; task-scoped tests green before commit.
- UI tasks: invoke the `repworth-brand-design` skill first. DB-read tasks: `supabase-postgres-best-practices`.

---

## File structure (locked)

| File | Responsibility |
|---|---|
| `supabase/migrations/075_agent_runs_subject_index.sql` (create) | Timeline completed-run lookup index |
| `src/lib/agents/read.ts` (create) | ALL spine reads: `getReviewTimeline`, `getAgentTeamSummary`, `deriveRunDisplayState`. `run-spine.ts` stays the only writer |
| `src/lib/agents/__tests__/read.test.ts` + `read.integration.test.ts` (create) | Unit (mocked sql) + live-DB coverage |
| `src/app/api/dashboard/reviews/[reviewId]/timeline/route.ts` (create) | Composition root: auth → `getReviewTimeline` → JSON |
| `src/app/api/dashboard/agent-team/route.ts` (create) | Composition root: auth + scope policy → `getAgentTeamSummary` |
| `src/app/api/dashboard/escalations/route.ts` (create) | Composition root: needs-attention list (module fn in `src/lib/escalations/list.ts`, create) |
| `worker/jobs/ResponseGeneratorWorker.ts` / `worker/jobs/response-generation/*` (modify) | Terminal draft failure → `completeRun('failed')` |
| `worker/jobs/publisher/failed-hook.ts` (modify) | Non-recoverable exhaustion branches → `completeRun('failed')` |
| `worker/jobs/WeeklySummaryWorker.ts` (modify) | `weekly_insights` run + `digest_sent` step/outcome in the `sent_at` tx |
| `src/lib/agents/run-spine.ts` (modify) | `STEP_PERSONA` += `digest_sent: 'insights'` |
| `src/lib/notifications/email/templates/weekly-value-report.ts` (modify) | Insights persona copy |
| `src/lib/dashboard/service.ts`, `types.ts`, `active-mappers.ts`, aggregate equivalents (modify) | Feed projection additions (scheduled fields; aggregate escalation join) |
| `src/app/(authenticated)/dashboard/reviews/[reviewId]/timeline/page.tsx` + `src/components/dashboard/timeline/*` (create) | Timeline page UI |
| `src/components/dashboard/reviews/ReviewFeedCard.tsx` (modify) | Persona badges, scheduled chip, timeline link |
| `src/components/dashboard/AgentTeamStrip.tsx` (create) + `DashboardContent.tsx` (modify) | Team strip + needs-attention list mounting |
| `src/lib/approval/__tests__/outcome-anchor-pairing.test.ts` (modify) | New callers + non-review-subject carve-out |
| `.claude/reference/migrations-log.md`, `.claude/CLAUDE.md` (JSONB allowlist), `docs/directory.md`, `scripts/ci/tenant-scope-allowlist.ts` (modify) | Contracts kept current |

---

### Task 1: Migration 075 — subject lookup index

**Files:** Create `supabase/migrations/075_agent_runs_subject_index.sql`; modify `.claude/reference/migrations-log.md`.

- [ ] **Step 1:** Read `.claude/reference/migrations-log.md` (mandatory before any migration; confirm head=074, next=075) and `supabase/migrations/071_agent_run_spine.sql` (existing indexes).
- [ ] **Step 2:** Write the migration:

```sql
-- 075_agent_runs_subject_index.sql
-- WS5: the run-timeline page looks up ALL runs (any status) for a subject.
-- 071's agent_runs_one_active_per_subject is partial (status='running');
-- the other 071 indexes lead on business_id/account_id. This covers the
-- completed-run lookup: WHERE subject_type=? AND subject_id=? ORDER BY started_at DESC.
CREATE INDEX idx_agent_runs_subject
  ON agent_runs (subject_type, subject_id, started_at DESC);
```

- [ ] **Step 3:** Apply to the LOCAL test container (`psql postgresql://test:test@localhost:5499/test_ws4 -f supabase/migrations/075_agent_runs_subject_index.sql`) so live-DB tests in later tasks see it. NEVER apply to any Supabase project — that is the user's promotion-time step.
- [ ] **Step 4:** Update `migrations-log.md`: 075 entry, head→075, next→076.
- [ ] **Step 5:** Commit: `feat(ws5): migration 075 — agent_runs subject lookup index`.

---

### Task 2: Spine read module — `src/lib/agents/read.ts`

**Spec:** §2.2–§2.4. **Files:** Create `src/lib/agents/read.ts`, `src/lib/agents/__tests__/read.test.ts`, `src/lib/agents/__tests__/read.integration.test.ts`; modify `scripts/ci/tenant-scope-allowlist.ts`, `.claude/CLAUDE.md` (JSONB string-guard allowlist).

- [ ] **Step 1:** Read `src/lib/agents/run-spine.ts` (types to reuse: `AgentPersona`, `AgentOutcomeKind`), `src/lib/kpi/service.ts` header + one query (inline tenant-predicate convention), `src/lib/shared/response-status.ts`, and an existing `describeWithDb` test for harness shape.
- [ ] **Step 2:** Write failing unit tests for `deriveRunDisplayState` — pure function, full table from spec §2.4:

```ts
// read.test.ts (shape; one case per row + boundary)
expect(deriveRunDisplayState({ status: 'completed', startedAt }, null, now)).toBe('completed');
expect(deriveRunDisplayState({ status: 'failed', startedAt }, null, now)).toBe('failed');
expect(deriveRunDisplayState({ status: 'running', startedAt: fresh }, { status: 'pending_approval' }, now)).toBe('waiting_on_owner');
expect(deriveRunDisplayState({ status: 'running', startedAt: fresh }, { status: 'awaiting_owner_connect' }, now)).toBe('waiting_on_owner');
// waiting_on_owner WINS over stalled even when old:
expect(deriveRunDisplayState({ status: 'running', startedAt: threeWeeksAgo }, { status: 'pending_approval' }, now)).toBe('waiting_on_owner');
expect(deriveRunDisplayState({ status: 'running', startedAt: threeWeeksAgo }, { status: 'posted' }, now)).toBe('stalled');
expect(deriveRunDisplayState({ status: 'running', startedAt: fresh }, null, now)).toBe('in_progress');
// scheduled auto-post is in_progress (spec §2.4):
expect(deriveRunDisplayState({ status: 'running', startedAt: fresh }, { status: 'approved', approvalMethod: 'auto_policy', autoPostScheduledAt: future }, now)).toBe('in_progress');
```

- [ ] **Step 3:** Run: `pnpm vitest run src/lib/agents/__tests__/read.test.ts` — expect FAIL (module missing).
- [ ] **Step 4:** Implement the module. Key signatures (implementation fills in per spec §2.2–§2.3):

```ts
import type { Sql } from 'postgres';
import type { AgentPersona, AgentOutcomeKind } from './run-spine';

export type RunDisplayState = 'in_progress' | 'waiting_on_owner' | 'stalled' | 'completed' | 'failed';
export const STALLED_RUNNING_THRESHOLD_MS = 48 * 60 * 60 * 1000;

export function deriveRunDisplayState(
  run: { status: 'running' | 'completed' | 'failed'; startedAt: Date | string },
  latestResponse: { status: string; approvalMethod?: string | null; autoPostScheduledAt?: Date | string | null } | null,
  now: Date,
): RunDisplayState { /* spec §2.4 table, in order */ }

export async function getReviewTimeline(
  sql: Sql,
  params: { accountId: string; reviewId: string },
): Promise<ReviewTimeline | null>;   // null = not found / out of scope → route 404s

export async function getAgentTeamSummary(
  sql: Sql,
  scope: { kind: 'account'; accountId: string } | { kind: 'location'; accountId: string; businessId: string },
  window: DashboardWindow,
): Promise<{ reply: number; guardian: number; insights: number }>;
```

Query rules (all FLAT top-level statements — the tenant-scope auditor cannot see subquery predicates):
  - Scope pre-read: `SELECT … FROM reviews r JOIN businesses b ON b.id = r.business_id WHERE r.id = ${reviewId} AND b.account_id = ${accountId} AND b.archived_at IS NULL` (verify actual review column names against the schema before writing the projection).
  - Latest displayable response: follow the dashboard feed's LATERAL/precedent (`src/lib/dashboard/service.ts:140-189`), statuses per `RECENT_REVIEW_DISPLAY_STATUSES`, plus `approval_method`, `auto_post_scheduled_at`, `posted_at`, `response_text`, `version`. Read `auto_post_scheduled_at` live — never cache/derive (WS4 §6 deadline pushes).
  - Open-or-any escalation for the review (timeline shows history; the open-escalation partial-predicate `status <> 'resolved'` byte-for-byte where used).
  - Runs: `SELECT … FROM agent_runs WHERE account_id = ${accountId} AND kind = 'review_handler' AND subject_type = 'review' AND subject_id = ${reviewId} ORDER BY started_at DESC LIMIT 20` (075 index; LIMIT is the production.md bound).
  - Steps: `WHERE agent_run_id = ANY(${runIds}) ORDER BY agent_run_id, step_index` — bounded by the run LIMIT.
  - Outcomes: `WHERE agent_run_id = ANY(${runIds})`.
  - **JSONB string-guard (mandatory):** `agent_run_steps.detail` and `agent_runs.error` come back as strings under PgBouncer — `typeof x === 'string' ? JSON.parse(x) : x`, narrowed at the call site. Add BOTH sites to the CLAUDE.md gotcha allowlist ("Postgres.js + PgBouncer returns JSONB as strings") in this commit.
  - Team summary: `SELECT attributed_agent, outcome_kind, COUNT(*)::int AS n FROM agent_outcomes WHERE account_id = ${accountId} AND occurred_at >= ${windowStart} [AND business_id = ${businessId}] GROUP BY 1, 2` → map: reply = `reply_posted`+`reply_auto_posted`; guardian = `review_escalated`; insights = `digest_sent` (spec §4.2 table).
  - Personas/attribution come from stored columns only — never re-derived (spec §2.3).
- [ ] **Step 5:** Unit tests green: `pnpm vitest run src/lib/agents/__tests__/read.test.ts`.
- [ ] **Step 6:** Write `read.integration.test.ts` (`describeWithDb`): seed account/business/review + a run with 3 steps + 2 outcomes via `run-spine.ts` writers inside a tx; assert round-trip ordering (`started_at DESC`, `step_index ASC`), JSONB detail narrowing, legacy review → `runs: []` and non-null review, out-of-scope account → `null`, team-summary counts incl. business filter.
- [ ] **Step 7:** Run it with the local container env; green.
- [ ] **Step 8:** Add the new SQL snippets to `scripts/ci/tenant-scope-allowlist.ts` ONLY if `pnpm ci:tenant-scope` demands (inline predicates should mostly satisfy it); run `pnpm ci:tenant-scope && pnpm ci:db-imports`.
- [ ] **Step 9:** Commit: `feat(ws5): spine read module — timeline + team summary reads`.

---

### Task 3: Timeline API route

**Spec:** §2.1, §2.3. **Files:** Create `src/app/api/dashboard/reviews/[reviewId]/timeline/route.ts` + a colocated route test (follow the pattern of existing dashboard route tests, e.g. the kpis route's).

- [ ] **Step 1:** Read `src/app/api/dashboard/reviews/[reviewId]/approve/route.ts` (param shape) and `src/lib/approval/http-routes.ts:141-159` (`requireDashboardReviewOwner`).
- [ ] **Step 2:** Failing tests: 401 unauthenticated; 403 no account; 404 out-of-scope review (wrong account) and unknown id; 200 happy path returns the spec §2.3 contract (review/response/escalation/runs with displayState); read-only — no CSRF/same-origin wrapper, no writable-subscription gate.
- [ ] **Step 3:** Implement: parse `reviewId` (UUID-validate), `requireDashboardReviewOwner`, call `getReviewTimeline(sql, …)`, 404 on null, JSON 200. Route = parse → one module call → return (repworth.md). Route file is a composition root (`ci:db-imports`).
- [ ] **Step 4:** Tests green; `pnpm ci:db-imports && pnpm ci:tenant-scope` green.
- [ ] **Step 5:** Commit: `feat(ws5): GET /api/dashboard/reviews/[reviewId]/timeline`.

---

### Task 4: Terminal-failure checkpoints

**Spec:** §3 (read it whole — the branch discipline matters). **Files:** Modify `worker/jobs/ResponseGeneratorWorker.ts` (and/or `worker/jobs/response-generation/persist.ts` — wherever the `{kind:'failed'}` terminal state is durably recorded), `worker/jobs/publisher/failed-hook.ts`, `src/lib/approval/__tests__/outcome-anchor-pairing.test.ts`; tests colocated with each worker file.

- [ ] **Step 1:** Read `worker/jobs/ResponseGeneratorWorker.ts:85-100` (`draft.kind === 'failed'` consumption), `worker/jobs/publisher/failed-hook.ts` (ALL branches), `src/lib/agents/run-spine.ts` (`findActiveReviewRun`, `completeRun`), `src/lib/approval/outcomes.ts:39` (`anchorReviewLockOrder`), and the tripwire test.
- [ ] **Step 2:** Failing tests, generation side: terminal `{kind:'failed'}` → the review's active run is completed `failed` with structured `error` `{ reason }`, **reviews lock taken first in the same tx** as the terminal write; transient errors do NOT complete the run; no active run (legacy) → no-op, job still succeeds.
- [ ] **Step 3:** Implement generation checkpoint. If the terminal branch has no tx today, create one: `sql.begin(tx => anchorReviewLockOrder(tx, reviewId) → findActiveReviewRun → completeRun(tx, runId, 'failed', { reason })` alongside whatever terminal state it records. `completeRun` is idempotent (`running`→terminal) so BullMQ replays are safe.
- [ ] **Step 4:** Failing tests, publisher side — **per-branch discipline (binding):** complete the run `failed` ONLY in branches that leave the response with no automatic retry AND no flow that resumes it (the generic close-outbox exhaustion branch; the orphan-conversion-to-`failed`-row branch). Do NOT complete in the transient fallback that parks at `awaiting_owner_connect` (owner reconnect resumes the flow — run stays `running`, renders `waiting_on_owner`). Write one test per branch.
- [ ] **Step 5:** Implement, same lock rules. Add both new caller files to `CALLER_ALLOWLIST` in the tripwire test (same commit); run the tripwire.
- [ ] **Step 6:** Live-DB test (`describeWithDb`): seed run → exercise checkpoint → run `failed` with `ended_at`; replay → still exactly one terminal flip.
- [ ] **Step 7:** All task tests + tripwire green. Commit: `feat(ws5): terminal-failure run checkpoints (generation + publisher exhaustion)`.

---

### Task 5: Insights instrumentation — the spine's second tenant

**Spec:** §5.1. **Files:** Modify `src/lib/agents/run-spine.ts` (STEP_PERSONA), `worker/jobs/WeeklySummaryWorker.ts`, `src/lib/notifications/email/templates/weekly-value-report.ts`, `src/lib/approval/__tests__/outcome-anchor-pairing.test.ts`; tests in `src/lib/agents/__tests__/` + the worker's test file.

- [ ] **Step 1:** Read `worker/jobs/WeeklySummaryWorker.ts` fully (claim at ~L166-180, `sent_at` flip at ~L237-242), `src/lib/agents/__tests__/run-spine.test.ts` (STEP_PERSONA totality pattern), the tripwire test.
- [ ] **Step 2:** Extend the map — failing totality test first, then:

```ts
// run-spine.ts STEP_PERSONA — first insights entry
digest_sent: 'insights',
```

- [ ] **Step 3:** Failing worker tests: on a send whose `sent_at` flip actually happens, ONE tx contains — `UPDATE weekly_summaries … SET sent_at … WHERE sent_at IS NULL RETURNING` (adapt the existing statement into the tx) → `startOrGetActiveRun(tx, { kind: 'weekly_insights', subjectType: 'account_week', subjectId: \`${accountId}_${weekStartDate}\`, accountId, businessId, correlationId })` → `recordStep(tx, …, stepKey: 'digest_sent', detail: { week_start_date, business_id })` → `recordOutcome(tx, …, outcomeKind: 'digest_sent', attributedAgent: 'insights')` → `completeRun(tx, runId, 'completed')`. When `sent_at` was already set (idempotent re-run): NO spine writes. The tx precedes the Resend call — same crash-safe posture as `sent_at` itself.
- [ ] **Step 4:** Implement. The weekly tx must touch NO `reviews`/`businesses` locks (spec §5.1 tripwire carve-out rationale). Multi-location: N short-lived completed runs per account-week is correct behavior (partial unique blocks only concurrent `running`).
- [ ] **Step 5:** Tripwire: add the worker to a new, explicitly-commented `NON_REVIEW_SUBJECT_CALLERS` set — membership still required in the caller allowlist, reviews-lock pairing exempted ONLY for this set; comment states the domain rule (account_week lane touches no review-lane rows). Extend — don't weaken — the check for everyone else.
- [ ] **Step 6:** Live-DB test: two sends same account+week (two businesses) → two completed runs sharing `subject_id`, two `digest_sent` outcomes; re-run of a sent week → no new rows.
- [ ] **Step 7:** Relabel the email as the Insights persona — subject line (worker ~L250) + template header (`weekly-value-report.ts` ~L55): "Your Insights agent's weekly report" shape; final copy under `repworth-brand-design`. Keep `{{…}}`-free plain template params as today; update template snapshot/unit tests.
- [ ] **Step 8:** All green (incl. `pnpm eval:llm` untouched-path sanity — no LLM change expected). Commit: `feat(ws5): weekly_insights runs + digest_sent emission + Insights email labeling`.

---

### Task 6: Agent-team + escalations routes

**Spec:** §4.2, §5.2(2). **Files:** Create `src/app/api/dashboard/agent-team/route.ts`, `src/app/api/dashboard/escalations/route.ts`, `src/lib/escalations/list.ts` (+ tests for each).

- [ ] **Step 1:** Read `src/app/api/dashboard/kpis/route.ts` end-to-end (auth, `resolveDashboardRequest`, location IDOR check, subscription read-gate posture) and `src/lib/escalations/{types,http-routes}.ts`.
- [ ] **Step 2:** Failing tests, agent-team: 401/403; window param validated against `DASHBOARD_WINDOWS` (default `30d`); aggregate scope → account-wide counts; location scope → business-filtered + IDOR 404 on foreign location; response `{ window, reply, guardian, insights }`.
- [ ] **Step 3:** Implement: auth → scope policy → `getAgentTeamSummary` → JSON. Route = composition root.
- [ ] **Step 4:** Failing tests, escalations list: 401/403; returns open escalations (`status <> 'resolved'`) for the account, ordered `escalated` first, then severity `high→medium→low`, then oldest `created_at` first; LIMIT 20 + `totalOpen` count; items carry `{ id, status, severity, suggestedAction, createdAt, reviewId, businessName, reviewRating }`.
- [ ] **Step 5:** Implement `listOpenEscalations(sql, { accountId })` in `src/lib/escalations/list.ts` — flat statements, join `reviews` + `businesses` inline-scoped, served by `idx_review_escalations_account_status`; route calls it. Severity ordering via explicit `CASE` (no enum-collation surprises).
- [ ] **Step 6:** `pnpm ci:tenant-scope && pnpm ci:db-imports && pnpm ci:rls-audit` green (allowlist entries same commit if demanded). Commit: `feat(ws5): agent-team summary + open-escalations routes`.

---

### Task 7: Feed data extensions (scheduled fields + aggregate escalation join)

**Spec:** §4.1, §5.2(1). **Files:** Modify `src/lib/dashboard/service.ts`, `src/lib/dashboard/types.ts`, `src/lib/dashboard/active-mappers.ts`, and the aggregate feed's query+mapper+types (locate via `AggregateReviewsCard`/`AggregateDashboardContent` data path); matching test files.

- [ ] **Step 1:** Read `src/lib/dashboard/service.ts:140-189` (feed query + existing escalation LATERAL), `types.ts:95-116`, `active-mappers.ts:30-51`; find the aggregate feed query.
- [ ] **Step 2:** Failing tests: per-location feed items expose `approvalMethod` + `autoPostScheduledAt` on the latest-response projection (add to the LATERAL only if not already projected — verify first; `AutoApprovedBadge` implies `approval_method` may exist); aggregate feed items now carry the same optional `escalation` field populated under the same `e.status <> 'resolved'` predicate (**byte-for-byte** with `review_escalations_one_open_per_review`).
- [ ] **Step 3:** Implement query + type + mapper changes in both feeds. `autoPostScheduledAt` is passed through raw (current-truth; consumers compare against now at render).
- [ ] **Step 4:** Tests + `pnpm ci:tenant-scope` green. Commit: `feat(ws5): feed projections — scheduled-post fields + aggregate escalation badges data`.

---

### Task 8: Timeline page UI

**Spec:** §2.5 (+ §2.3 rendering rules, §2.4 badge states). **Files:** Create `src/app/(authenticated)/dashboard/reviews/[reviewId]/timeline/page.tsx`, `src/components/dashboard/timeline/{TimelineContent,RunTimeline,TimelineStepRow,RunStateBadge,TimelineEscalationActions}.tsx` (split as sensible — these five responsibilities, fewer files OK if each stays focused); component tests in `src/components/dashboard/timeline/__tests__/`.

- [ ] **Step 1:** Invoke `repworth-brand-design`. Read `src/app/(authenticated)/dashboard/page.tsx` + `DashboardContent.tsx` (page shell/react-query conventions) and `ReviewFeedCard.tsx` (card idiom).
- [ ] **Step 2:** Build the page: fetch `GET /api/dashboard/reviews/[reviewId]/timeline`; render review header → per-run vertical step timeline (persona icon/label from stored `attributedAgent`; step `detail` as structured facts, never prose), outcome chips, `RunStateBadge` (displayState + age for `stalled`), and the honest empty state for `runs: []` ("this review predates the agent timeline" shape).
- [ ] **Step 3:** `TimelineEscalationActions`: when an unresolved escalation exists, Acknowledge/Resolve buttons POSTing to the existing `/api/dashboard/escalations/[id]/{acknowledge,resolve}` routes; handle the 409 already-resolved answer by refetching. Component tests: states render per fixture (all five displayStates, empty state, escalation actions fire fetch).
- [ ] **Step 4:** `pnpm lint && pnpm typecheck` + component tests green. Commit: `feat(ws5): run-timeline page`.

---

### Task 9: Feed card badges + scheduled chip + timeline link

**Spec:** §4.1. **Files:** Modify `src/components/dashboard/reviews/ReviewFeedCard.tsx` (+ its test file; follow `AutoApprovedBadge.tsx` idiom — small colocated badge components are fine).

- [ ] **Step 1:** Invoke `repworth-brand-design`. Read `ReviewFeedCard.tsx` + `AutoApprovedBadge.tsx`.
- [ ] **Step 2:** Failing component tests: Reply badge when a response exists (auto variant under the existing auto-approved signal); Guardian badge when `escalation != null`; scheduled chip "Scheduled — posts at HH:MM" when `status==='approved' && approvalMethod==='auto_policy' && autoPostScheduledAt` parses to a future instant, linking to the approve page surface exactly as the notice email does (reuse whatever link the card/approve flow already has to the response's approve URL — if the card has none, link the chip to the timeline page and let ITS scheduled state deep-link; do not mint a new token path); timeline link on every card → `/dashboard/reviews/[reviewId]/timeline`; no badge → no ghost elements.
- [ ] **Step 3:** Implement; derivation stays presentation-only (no spine fetch, no N+1 — spec §4.1).
- [ ] **Step 4:** Green. Commit: `feat(ws5): persona badges + scheduled chip + timeline links on feed cards`.

**Note:** approval-link tokens are hashed-at-rest and single-purpose (invariant #5) — the dashboard NEVER regenerates or displays raw approval tokens. If no existing owner-facing link to the approve page exists from the dashboard, the chip links to the timeline page (which shows the scheduled state); the veto surface remains the notice email. Flag the chosen shape in the task report.

---

### Task 10: Agent-team strip + needs-attention list + Insights label

**Spec:** §4.2, §5.2(2) UI half. **Files:** Create `src/components/dashboard/AgentTeamStrip.tsx`, `src/components/dashboard/NeedsAttentionList.tsx` (+ tests); modify `src/components/dashboard/DashboardContent.tsx`, `src/components/dashboard/kpi/IntelligenceBriefCard.tsx`.

- [ ] **Step 1:** Invoke `repworth-brand-design`. Read `DashboardContent.tsx` (mount points, react-query usage), `PendingApprovalsStrip.tsx` (strip idiom).
- [ ] **Step 2:** `AgentTeamStrip`: three persona cards (Reply/Guardian/Insights — icon, name, one-line role, windowed count from `GET /api/dashboard/agent-team`); zero-count renders "standing by", never hidden. Mount near the KPI band; follows current dashboard scope (aggregate vs location) like the KPI queries do.
- [ ] **Step 3:** `NeedsAttentionList`: fetch `GET /api/dashboard/escalations`; render ONLY when non-empty; rows → severity chip + review/business context + link to the timeline page. Mount in `DashboardContent` above the reviews feed.
- [ ] **Step 4:** `IntelligenceBriefCard`: add the Insights persona attribution label (copy-only change).
- [ ] **Step 5:** Component tests (fixtures for: counts, standing-by, empty needs-attention hidden, rows link correctly). Green. Commit: `feat(ws5): agent-team strip, needs-attention list, Insights labeling`.

---

### Task 11: Docs + contract sweep

**Files:** Modify `docs/directory.md`, verify `.claude/reference/migrations-log.md` (075 done in Task 1), `.claude/CLAUDE.md` JSONB allowlist (done in Task 2 — verify), spec/plan cross-refs.

- [ ] **Step 1:** `docs/directory.md` rows: `src/lib/agents/read.ts`, `src/lib/escalations/list.ts`, the three new routes, timeline page + `src/components/dashboard/timeline/`, `AgentTeamStrip`/`NeedsAttentionList`.
- [ ] **Step 2:** Grep for dangling refs / stale ticks introduced by this branch (repworth.md rule). Fix in place.
- [ ] **Step 3:** Commit: `docs(ws5): directory + reference updates`.

---

### Task 12: Full gates (branch-final)

- [ ] **Step 1:** `pnpm lint` — green.
- [ ] **Step 2:** `pnpm typecheck` — green.
- [ ] **Step 3:** Sequential full suite with the LOCAL container env exported:

```bash
export TEST_DATABASE_POOL_URL='postgresql://test:test@localhost:5499/test_ws4'
export DATABASE_POOL_URL="$TEST_DATABASE_POOL_URL"
pnpm vitest run --no-file-parallelism
```

Expected: all pass. This sequential run is the acceptance bar — parallel runs flake on shared-DB DDL contention and do not count.
- [ ] **Step 4:** Every `ci:*` audit from package.json (`ci:tenant-scope`, `ci:rls-audit`, `ci:analytics-events`, `ci:static-policy`, `ci:db-imports`, `ci:fallow` (origin/main base; delete stale local `coverage/coverage-final.json` before trusting a red), plus any others listed) — all green.
- [ ] **Step 5:** `pnpm eval:llm` (offline) — green.
- [ ] **Step 6:** Commit anything the gates required, `git push -u origin feat/ws5-persona-surfaces`. **NO PR** — that is reserved.

---

## Self-review (done at authoring)

- **Spec coverage:** §2.1–2.5 → Tasks 2, 3, 8; §3 → Task 4; §4.1 → Tasks 7, 9; §4.2 → Tasks 2, 6, 10; §5.1 → Task 5; §5.2 → Tasks 6, 7, 8, 10; §6.1 → Task 1; §6.2 → distributed + Task 12. No gaps found.
- **Type consistency:** `deriveRunDisplayState` / `getReviewTimeline` / `getAgentTeamSummary` / `RunDisplayState` used identically across Tasks 2, 3, 6, 8; persona count keys `{reply, guardian, insights}` consistent in Tasks 2, 6, 10.
- **Known judgment points left to the executor + reviews (deliberate):** exact generation-terminal tx seam (Task 4 Step 3), whether feed already projects `approval_method` (Task 7 Step 2), scheduled-chip link target (Task 9 note). Each is bounded by an explicit contract above.
