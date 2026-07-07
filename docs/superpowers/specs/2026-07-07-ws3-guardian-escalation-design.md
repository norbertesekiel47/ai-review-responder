# WS3 — Guardian escalation: raise, notify, track resolution — Design

**Status:** Accepted (brainstormed 2026-07-07 against the design of record; open decisions
from the WS2→WS3 handoff resolved below with evidence; four product calls confirmed by
Norbert in the brainstorm — see §2 markers).
**Parent:** `docs/future-plans/2026-07-01-agentic-reputation-platform-design.md` (§2.2
Guardian, §3.1 one-run-per-review, §5.2 fail-safe) and the Phase 1 decomposition table in
`docs/superpowers/plans/2026-07-01-agentic-platform-phase1-run-spine.md` (WS3 row).
**Depends on:** WS2 (shipped — triage columns, migration 072). **Feeds:** WS5 (timeline /
exception-queue UI reads `review_escalations` and the guardian steps).

---

## 1. What WS3 ships

When a triaged review's `triage_suggested_action` is `escalate` or
`respond_and_escalate`, Guardian raises an escalation: one `review_escalations` row
(migration 073, state machine `escalated → acknowledged → resolved`) + a
`review_escalated` outcome + an `escalation_notice` outbox enqueue, all atomically inside
the existing `persistTriage` transaction. A new `EscalationNoticeWorker` delivers the
notice over the existing owner channels (email/Telegram/WhatsApp). The owner sees a
severity/status badge with **Acknowledge** and **Resolve** actions on the existing
dashboard review cards; resolve records `escalation_resolved`. Everything is behind a
new server-only flag `ESCALATION_ENABLED` (default off; inert without `TRIAGE_ENABLED`
upstream since nothing writes `escalate` actions without triage).

**No LLM calls anywhere in WS3** — escalation content comes from persisted triage facts
(no cost-guard registry changes, no new `runLlmTask` callers).

Explicitly **not** WS3: autonomous recovery actions (v2 Complaint-Recovery), rating-band
policy (WS4), the full exception-queue/timeline UI (WS5), escalation auto-retract,
tokenized acknowledge links, Telegram inline ack buttons.

## 2. Resolved design decisions

### 2.1 Trigger — `suggested_action`, source-agnostic; fallback escalates immediately

Escalate when `triage_suggested_action IN ('escalate', 'respond_and_escalate')`
(taxonomy owner: `src/lib/reviews/triage-schema.ts`). Severity is not consulted for the
trigger — WS2's rubric and fallback already encode "high ⇒ escalate" in the action.

**Fallback rows (`triage_source='fallback_high_v1'`) escalate immediately** (user
decision 2026-07-07), not after a re-attempt cycle: re-attempts only happen on the *next*
generation job for that review, which may never come — waiting has unbounded latency on
exactly the reviews Guardian exists for. Design §5.2's "everything fails toward ask the
owner" wins. Two mitigations for the cost-cap burst case (an account at its cap produces
fallback-high rows for every negative review until budget resets):

- **One-open-escalation-per-review dedup** (§2.3) caps the burst at one notice per review.
- **Distinct copy for fallback-sourced escalations** (user decision): the notice says the
  review could not be assessed automatically and asks the owner to take a look, instead
  of claiming an assessed severity.

Mock rows (`mock_v1`) never trigger: mock triage always emits `suggested_action:
'respond'` (WS2 §2.10). No special-case guard needed; the trigger predicate is the guard.

**No auto-retract in v1:** a fallback row later re-attempted and downgraded to `respond`
leaves its already-open escalation for the owner to acknowledge/resolve. The owner was
told "please take a look" — retracting that silently is worse than a benign extra card.

### 2.2 Firing point — inside `persistTriage`, atomic with the triage write

The raise happens in `persistTriage` (`src/lib/reviews/triage.ts`), which already takes
the review row `FOR UPDATE` as the transaction's **first statement** (binding
lock-ordering rule), UPDATEs `reviews.triage_*`, and records the guardian `triage` step.
After the triage UPDATE, still under the same lock and tx:

1. INSERT the `review_escalations` row with `ON CONFLICT ... DO NOTHING` against the
   one-open-per-review partial unique index (predicate must match the index
   **byte-for-byte** — documented Postgres gotcha).
2. If (and only if) the row was inserted: `recordOutcome('review_escalated')` (when an
   active run exists), `recordStep('escalation_raised')`, and
   `enqueueEscalationNotice(tx, …)` — state change + follow-up work in ONE tx
   (invariant #2, outbox pattern).

Why here and not in `persistResponseAndNotify` (the draft-persist tx): escalation must
not depend on drafting success. A high-severity review escalates even if the draft LLM
call later fails terminally or moderation holds the draft — Guardian's promise is
independent of Reply's. `respond_and_escalate` therefore produces TWO notifications
(escalation notice at triage time; the normal approval request after the draft persists)
— deliberate, they serve different purposes, and the approval path is untouched.

Idempotency chain: a BullMQ retry after triage committed skips re-triage via WS2's hash
check → no re-raise. A re-triage that *does* run (content change, fallback re-attempt)
re-evaluates the trigger; the partial unique index absorbs the duplicate while an
escalation is open, and legitimately allows a NEW escalation if the previous one was
resolved and the review changed. The known concurrent-generation duplicate-triage race
(WS2 follow-up #3) is absorbed by the same index.

### 2.3 Persistence — `review_escalations` (migration 073)

New table (UUIDv7 time-ordered PK per convention; read
`.claude/reference/migrations-log.md` before writing — **next is 073**):

| Column | Type / constraint |
|---|---|
| `id` | UUID PK (UUIDv7 convention) |
| `account_id` | UUID NOT NULL FK → accounts |
| `business_id` | UUID NOT NULL FK → businesses |
| `review_id` | UUID NOT NULL FK → reviews |
| `agent_run_id` | UUID NULL FK → agent_runs **ON DELETE SET NULL** |
| `status` | TEXT NOT NULL DEFAULT 'escalated' CHECK IN ('escalated','acknowledged','resolved') |
| `triage_severity` | TEXT NOT NULL CHECK IN ('low','medium','high') — snapshot at raise |
| `triage_source` | TEXT NOT NULL — snapshot at raise |
| `triage_suggested_action` | TEXT NOT NULL CHECK IN ('escalate','respond_and_escalate') — snapshot |
| `triage_issues` | TEXT[] — snapshot (app-validated taxonomy) |
| `escalated_at` | TIMESTAMPTZ NOT NULL DEFAULT now() |
| `acknowledged_at` | TIMESTAMPTZ NULL |
| `resolved_at` | TIMESTAMPTZ NULL |
| `created_at` / `updated_at` | TIMESTAMPTZ NOT NULL DEFAULT now() |

The triage snapshot columns exist because `reviews.triage_*` is rewritable (re-triage on
content change / fallback re-attempt); the escalation records **what Guardian acted on**.

Constraints and indexes:

- **State-timestamp consistency CHECK**: `acknowledged` ⇒ `acknowledged_at` non-null;
  `resolved` ⇒ `resolved_at` non-null (direct `escalated → resolved` stamps BOTH
  timestamps — resolve implies acknowledge). Re-runnable (`DROP CONSTRAINT IF EXISTS`
  before ADD, 069/072 precedent).
- **One open escalation per review**: `CREATE UNIQUE INDEX … ON review_escalations
  (review_id) WHERE status <> 'resolved'`. The raise INSERT's `ON CONFLICT` clause must
  match this predicate byte-for-byte.
- **Delivery-claim index**: the migration-067 `auto_post_notice` claim index keys on
  `(response_id, channel, recipient)`, but an escalation is not a response — migration
  073 therefore also adds a nullable `notification_deliveries.escalation_id` (FK →
  review_escalations) and a partial unique index on `(escalation_id, channel, recipient)
  WHERE template = 'escalation_notice'`, claimed with a byte-for-byte-matching
  `ON CONFLICT`.
- A plain index on `(account_id, status)` for the dashboard read path (open escalations
  per account) — WS3 defines its own query shape, as the 072 log entry deferred.

**RLS: deny-all** (analytics_events / agent_outcomes posture); all reads/writes go
through server routes and workers, scoping app-enforced by `account_id` (invariant #8).

**New account-FK table ⇒ full WS1 checklist in the same PR:**
`scripts/ci/tenant-tables.ts` (+ table entry), `scripts/ci/tenant-scope-allowlist.ts`
(one entry per non-owner-scoped SQL touchpoint, `ALLOWLIST_BASELINE` bumped by the exact
count), `docs/security/rls-inventory.md` (deny-all row), offboarding disposition in
`src/lib/account-offboarding/table-disposition.ts` (`hard_delete` /
`direct_account_id` / `must_be_absent`) + the purge query module + verification
(`pnpm test` goes red if missed), `.claude/reference/migrations-log.md` (073 entry +
head bump + table-summary row).

State machine is **forward-only**: `escalated → acknowledged → resolved` and
`escalated → resolved`. No un-acknowledge, no re-open in v1.

### 2.4 Notification delivery — `escalation_notice` topic, clone of `auto_post_notice`

Each notification topic in this codebase is its own queue + worker + outbox topic +
enqueue helper + purpose-built channel method (`worker/jobs/notification/` is hardwired
to approval requests — do NOT extend it). The `auto-post-notice` package is the
precedent; touchpoints:

- `src/lib/shared/queue-names.ts` — `ESCALATION_NOTICE: 'escalation_notice'`.
- `worker/queues.ts` — queue instance + `topicToQueue` entry.
- `worker/index.ts` — worker registration + `workersByQueue` entry.
- `src/lib/shared/worker-types.ts` — `EscalationNoticePayload { escalation_id,
  business_id }` (snake_case; **ids only**, never review text).
- `src/lib/shared/job-outbox-helpers.ts` — `enqueueEscalationNotice(tx, …)` mirroring
  `enqueueAutoPostNotice` (`aggregate_type: 'review'`, deterministic key, `_` separators,
  `-- topic-audit-ignore` comment where required).
- New package `worker/jobs/escalation-notice/` (worker, context loader, dispatch,
  errors) cloned from `worker/jobs/auto-post-notice/`. Reuses `getEligibleChannels`
  (`worker/jobs/notification/eligibility.ts`) — subscription guard (invariant #11,
  `subscriptionGrantsFullAccess`) and account-scoped org-default enrollment lookup
  (`account_id` + `channel` + `location_id IS NULL`) come for free.
- `src/lib/notifications/channels/types.ts` — third purpose-built method
  `sendEscalationNotice(params)` on the `NotificationChannel` interface (ADR 0003: no
  generic `sendText`), implemented in all three channels: `email-channel.ts` (new
  template in `src/lib/notifications/email.ts`), `telegram-channel.ts`,
  `whatsapp-channel.ts`.
- **WhatsApp**: escalation notices are business-initiated → outside any 24h session
  window → must use an approved template (`docs/runbooks/whatsapp-templates.md` owns
  content + submission procedure; rollout note in §5).
- `src/lib/notifications/delivery.ts` — `claimEscalationNoticeDelivery` +
  `releaseDeliveryClaim`, backed by the §2.3 claim index (claim-before-send idempotency).
- `worker/ingress/resend.ts` — add `'escalation_notice'` to `OWNER_DIRECTED_TEMPLATES`
  (hard bounces flag `owner_email_bounced`).

**Kill switch honored at send time too:** if `ESCALATION_ENABLED` is off when the job
runs, the worker completes WITHOUT sending (publisher-downgrade precedent). The
escalation row stays `escalated` and visible in the dashboard — the flag stops outbound
noise, not the record.

Per-channel failure semantics follow `auto-post-notice`'s exactly (a failed channel does
not poison the others; transient errors → BullMQ 3× + backoff + 1h outbox watchdog;
claim prevents double-send on retry).

### 2.5 Notice content — private-channel context, ids-only everywhere else

The message goes to the owner's private enrolled channel, so review context in the
MESSAGE body is fine (approval-link precedent): business/location name, star rating,
reviewer display name, review text truncated (same truncation discipline as the approval
request template), assessed severity + humanized issue categories, a recommended-action
line, and a dashboard deep-link to the review. **Fallback-sourced escalations get
distinct copy**: "we couldn't assess this review automatically — please take a look"
(no fabricated severity claim; severity shown as needs-review).

Everything that is NOT the message stays ids/enums only: outbox payloads, BullMQ job
data, `agent_run_steps.detail`, structured logs (`createWorkerLogger`), Sentry. No raw
review text, ever (logging rules).

### 2.6 Spine instrumentation — two guardian steps, two outcomes

- `STEP_PERSONA` gains `escalation_raised: 'guardian'` and `escalation_sent: 'guardian'`
  (+ totality/attribution tests). `agent_run_steps.step_key` has no DB CHECK — no
  migration needed.
- **`escalation_raised`**: recorded in the raise tx (§2.2), `detail: { severity,
  suggested_action, source, escalation_id }` (enums/ids only), only when
  `findActiveReviewRun` finds a running run (legacy posture: no run → skip step, columns
  still written).
- **`escalation_sent`**: recorded by `EscalationNoticeWorker` after dispatch, in a tx
  that takes the review row `FOR UPDATE` first (lock-ordering rule), `detail: { channels,
  escalation_id }`; skipped when no running run.
- **`review_escalated` outcome**: in the raise tx via `recordOutcome` (`attributedAgent:
  'guardian'`) when a run exists. Already in migration 071's CHECK and
  `AGENT_OUTCOME_KINDS` — no migration. Per-(run, kind) dedup means a second escalation
  on the same run (resolved, then re-raised after content change) records no second
  outcome — accepted, documented.
- **`escalation_resolved` outcome**: recorded in the resolve route's tx using the
  escalation row's **stored `agent_run_id`** — this is the run-spine interplay answer:
  the outcome insert does not require the run to be running, so resolution days after
  `completeRun` still attributes correctly. `agent_run_id IS NULL` (legacy review or run
  deleted) → skip the outcome, resolve the row anyway.

### 2.7 Routes & UI — authenticated dashboard actions; two explicit steps

**Two explicit owner actions** (user decision): Acknowledge = "I've seen it", Resolve =
"handled". **Dashboard deep-link only** in the notification (user decision) — no
tokenized ack links, no Telegram inline buttons in v1 (future work; would then invoke
the `approval-security` skill).

- `POST /api/dashboard/escalations/[escalationId]/acknowledge` and `…/resolve` — clones
  of the `runDashboardReviewAction` pattern
  (`src/lib/approval/http-routes.ts`): `withSameOrigin`, `force-dynamic`,
  `requireRole(request, 'owner')`, escalation row scoped by `owner.accountId`, writable-
  subscription assertion, `sql.begin` with the **review row locked FOR UPDATE first**,
  then the escalation row — one global lock order shared with `persistTriage`, so routes
  and generation jobs can never deadlock. Transition semantics: repeating the SAME
  action is an idempotent no-op success (double-click safe under the row lock);
  backward/invalid transitions (ack on resolved, resolve on nothing) → 409. Route
  handlers parse → one module call → return; the transition logic lives in a domain
  module (`src/lib/escalations/…`, taking `sql`/`tx` per invariant #15).
- **Read path**: escalation fields join into the existing dashboard reviews read (server
  component / existing endpoint) — no new GET route. Plan decides the exact join site.
- **UI** (user decision: badge + actions, no dedicated tab): flag-gated
  (server-authoritative, invariant #13 — page passes `escalationsEnabled` like
  `historyEnabled`), a severity/status badge on `ReviewFeedCard` and
  Acknowledge/Resolve actions in `ReviewActions`, styled per the `repworth-brand-design`
  skill. The full exception-queue view is WS5.

### 2.8 Failure semantics — everything fails toward "ask the owner", nothing double-sends

| Failure | Behavior |
|---|---|
| Raise-path failure (INSERT/outcome/step/enqueue) | Same tx as triage persist → whole tx rolls back including triage columns → BullMQ retries the generation job → re-triage → re-raise. All-or-nothing; no half-raised state. |
| Notice worker transient failure | BullMQ 3× + backoff + 1h outbox watchdog re-dispatch. Delivery claim prevents double-send. |
| One channel fails | Other channels unaffected (auto-post-notice semantics); failures logged + Sentry, never swallowed silently. |
| `ESCALATION_ENABLED` off | Raise phase skipped entirely (no rows). In-flight notice jobs complete without sending; existing rows stay visible. |
| Owner has no enrolled channels | Escalation row + outcome still recorded; notice job completes with zero deliveries (logged). The dashboard badge is the fallback surface. |
| Route failures | Standard route error mapping; transitions are idempotent-safe under the row lock (double-click on Acknowledge → second request sees `acknowledged` → no-op success; backward transitions → 409, per §2.7). |

### 2.9 Flag & dependency

`ESCALATION_ENABLED` (server-only, default off, worker + Next.js server both read it;
documented in `.claude/reference/env-vars.md` with the operational coupling: without
`TRIAGE_ENABLED` nothing ever fires because no `escalate` actions are written). Kill
switch semantics per §2.4. No `NEXT_PUBLIC_*` companion (invariant #13, CI-enforced).

## 3. Components & file map

| Unit | Responsibility |
|---|---|
| `supabase/migrations/073_review_escalations.sql` (create) | §2.3 table + CHECKs + partial unique indexes |
| `src/lib/escalations/raise.ts` (create) | Domain module: trigger predicate + `raiseEscalation(tx, …)` (INSERT ON CONFLICT → outcome → step → enqueue); takes `tx` (invariant #15) |
| `src/lib/escalations/transitions.ts` (create) | `acknowledgeEscalation(sql, …)` / `resolveEscalation(sql, …)` incl. lock order, scoping, `escalation_resolved` outcome |
| `src/lib/reviews/triage.ts` (modify) | `persistTriage` calls `raiseEscalation` after the triage UPDATE, flag-gated |
| `src/lib/agents/run-spine.ts` (modify) | `STEP_PERSONA` + `escalation_raised` / `escalation_sent` |
| `src/lib/shared/{queue-names,worker-types,job-outbox-helpers}.ts` (modify) | Queue name, payload type, `enqueueEscalationNotice` |
| `worker/{queues,index}.ts` (modify) | Queue + worker registration |
| `worker/jobs/escalation-notice/` (create) | Notice worker package (context, dispatch, errors) — auto-post-notice clone |
| `src/lib/notifications/channels/*` + `email.ts` (modify) | `sendEscalationNotice` on the interface + 3 channel implementations + email template |
| `src/lib/notifications/delivery.ts` (modify) | Escalation-notice delivery claim |
| `worker/ingress/resend.ts` (modify) | `OWNER_DIRECTED_TEMPLATES` + `escalation_notice` |
| `src/app/api/dashboard/escalations/[escalationId]/{acknowledge,resolve}/route.ts` (create) | Composition roots: parse → module call → return |
| Dashboard reviews read path + `ReviewFeedCard` / `ReviewActions` (modify) | Escalation join + badge + actions, flag-gated |
| Tenant/security registries (modify) | `tenant-tables.ts`, tenant-scope allowlist + baseline, `rls-inventory.md`, `table-disposition.ts` + purge queries |
| Docs (modify) | `migrations-log.md` (073), `env-vars.md` (`ESCALATION_ENABLED`), `docs/directory.md` (new modules/worker), `whatsapp-templates.md` (template content) |

## 4. Testing strategy

- **Unit (TDD per task):** trigger matrix (action × source × mock × flag); raise
  idempotency (ON CONFLICT path, resolved-then-re-raise); state-machine transitions incl.
  invalid ones and direct-resolve timestamp stamping; route auth/scoping/subscription
  guard; notice worker claim/flag-off/zero-channels/per-channel failure; persona-map
  totality; outcome dedup + null-run skip. Mocked-`sql` via `createMockSql`
  (vi.hoisted recipe).
- **Integration (`describeWithDb`):** migration 073 shape; raise inside a real
  `persistTriage` tx (lock order observed); concurrent double-raise absorbed by the
  index; ack → resolve against real Postgres incl. `escalation_resolved` on a
  **completed** run.
- **Gates:** `pnpm lint && pnpm typecheck && pnpm test`, every `ci:*` audit (tenant-scope
  + rls-audit mandatory for this one), `pnpm eval:llm` offline (no prompt changes —
  regression guard only).

## 5. Rollout

1. Migration 073 **staging first**, then production, both Supabase projects in lockstep.
2. WhatsApp `escalation_notice` template submitted for approval per
   `docs/runbooks/whatsapp-templates.md` (email + Telegram are not gated on it; WhatsApp
   channel simply has no approved template until then and its send fails
   closed-and-logged per channel-failure semantics).
3. `ESCALATION_ENABLED=true` on the **staging** worker (`TRIAGE_ENABLED` already on).
   Observe one fresh negative ingest end-to-end: `review_escalations` row,
   `agent_run_steps` (`escalation_raised`, `escalation_sent`), `agent_outcomes`
   (`review_escalated`), notice delivery on an enrolled channel, dashboard badge,
   acknowledge → resolve → `escalation_resolved`.
4. Prod: flag on after staging observation. Kill switch is the same flag.

## 6. Implementation amendments (2026-07-07, review-driven)

Where per-task reviews tightened the spec during implementation. The original
sections above are unchanged; on any conflict, these amendments win.

- **§2.5:** `suggestedAction` is dropped from the channel-seam params
  (`SendEscalationNoticeParams`) — no channel renders it, and drafts are
  generated on BOTH escalating actions (`escalate` and
  `respond_and_escalate`), so the notice copy holds without it.
- **§2.5:** severity and issue labels are single-owner in
  `src/lib/reviews/triage-schema.ts` (`TRIAGE_SEVERITY_LABELS` /
  `TRIAGE_ISSUE_LABELS` — exhaustive over the taxonomy, so a new issue value
  forces a label). Review-text truncation uses each surface's established
  helper (email `templates/shared.ts` `truncate`, channel body helpers) — no
  bespoke slicing.
- **§2.6:** the `escalation_sent` step is recorded BEST-EFFORT after delivery
  (log-and-swallow with a distinct `step-record-failed` error signal) — a
  step-tx failure no longer fails the job, because the notices are already
  delivered and a retry would dedup on the claims (sent=0) without ever
  recovering the step. `notification_deliveries` is the authoritative
  per-channel delivery record; the step is observability.
- **§2.7:** escalation actions (Acknowledge/Resolve) render for ANY open
  escalation on the review card, regardless of draft state — moderation-HELD
  drafts (response text withheld via the flagged-response NOT EXISTS) are
  exactly the high-severity lane and must stay actionable
  (`EscalationActions`, decoupled from the draft-gated `ReviewActions`).
  **Residual (accepted boundary):** reviews whose reply was posted leave the
  pending feed entirely, so an escalation on them is dischargeable only via
  WS5's exception queue. Notification copy is unchanged.
- **§2.7:** dispatch warn-lines redact in-hand review text from provider
  error messages (`'[review_text]'` placeholder). Unredacted failure reasons
  persist only in `notification_deliveries.failure_reason` (DB, not logs).
- **§2.3:** migration 073 gained two RI-support indexes beyond the spec's
  list — `idx_nd_escalation` (notification_deliveries → escalation FK path)
  and `idx_review_escalations_agent_run` (agent_runs FK path).
- **§2.7:** no `escalationsEnabled` UI flag threading shipped — the review
  card renders escalation actions data-driven off the payload's escalation
  field, resolving §2.7's flag-gating language toward §2.4's kill-switch
  semantics: flipping `ESCALATION_ENABLED` off stops new raises and notices
  while already-raised escalations stay visible and actionable.
- **§2.4:** escalation-notice outbox rows use `aggregate_type='escalation'`
  + `aggregate_id=escalation_id`, not `aggregate_type='review'` as §2.4's
  auto-post-notice mirroring line implied.
- **§2.6:** the `escalation_sent` step detail is
  `{escalation_id, sent, skipped, terminal_failed}` per-attempt counts, not
  `{channels, escalation_id}`; the `notification_deliveries` rows are the
  authoritative per-channel delivery record.
- **§2.4:** email-channel enrollments are skipped pre-claim when
  `businesses.owner_email_bounced` is set (counted as skipped, ids-only log
  line) — same rule as the approval dispatcher; a known-bounced owner never
  gets a per-raise email.
- **§2.7:** the acknowledge/resolve routes run the writable-subscription
  check before (not inside) the transition transaction — an accepted TOCTOU
  window, matching the dashboard-action precedent.
