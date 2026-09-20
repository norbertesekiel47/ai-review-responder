# Current state — implementation inventory (updated 2026-09-11)

The filename is stable. The original 2026-08-26 inventory drew on design of
record §8 (2026-07-22), §9 (updated 2026-08-26), project instructions and dated
staging evidence under `docs/runbooks/evidence/`. Those historical checks are
not fresh verification of every row.

The 2026-09-07 refresh made targeted source checks at `4aa132b`: QR,
Refusal ledger/read surface, run-spine and solicitation lifecycle, reporting,
tier configuration, Judge gate and source/publisher seams. **Built** below
means implementation described by the linked code or original inventory;
rows marked **source checked Sep 7** identify this refresh's checks. This is
not a complete code audit. No application, browser, deployment, flag, Stripe
or database state was inspected; no current production-readiness claim follows.

**September 11 update:** added the approved operator direction as
unimplemented product hypotheses (§2 table below), and checked the LLM
contract and legacy admin route inventory at `0ad5c1bdc`. Other rows keep
their dated evidence. No deployed environment or customer result was checked.

## 1. One-paragraph summary

RepWorth has bounded event-driven workflows for review handling, owner
approval, automatic-policy handling, supervision and solicitation. The
original inventory records staging evidence for WS1–WS8 and solicitation
send-mode, including
`docs/runbooks/evidence/2026-08-24-solicitation-send-mode-staging-flip.md`.
QR and the Refusal ledger/read surface are now present in source. These are
useful foundations for reducing owner work; they do not by themselves prove
net time saved, a moat, current live availability or launch readiness.

## 2. Capability inventory

P1–P8 below are stable roadmap topic identifiers, not a fixed chronological
build sequence. Current selection/dependencies live in
`2026-08-26-forward-roadmap.md`.

### Operator direction: implementation is distinct from validation

| Capability/hypothesis | Implementation evidence | Verified live availability | Customer validation |
|---|---|---|---|
| Owner instruction → operating plan → ongoing conversational delegation | Specified, not built ([spec](2026-09-11-owner-operator.md)); `src/lib/llm/types.ts` is single-shot and excludes tool calls/multi-turn loops (source checked Sep 11). No operator implementation exists | Not established | Not established; the spec's owner pilot is the test |
| Confirmed operating memory | Brand fields and owner-edit voice examples are existing foundations; structured facts/rules and correction-to-later-task behavior remain future P4 scope when selected | New memory behavior not established | Requires fewer factual/repeated corrections on comparable tasks |
| Follow-through and outcomes for the selected job | Existing run/domain records support activity evidence; a complete recovery lifecycle and operator follow-up are future scope, not consequences of having a run spine | Proposed workflow not established | Requires correctly completed work, unresolved-case tracking and less intervention; no causal revenue inference |
| Complete operation in another market | Existing language/channel capabilities do not establish every country's workflow; use the verticals capability matrix | Must be verified per selected market and operation | Transferability unproven |

These states must be updated independently. Code presence does not prove
deployment, and a successful demonstration does not prove repeated paid use.

### 2.1 Review ingestion & sources

| Capability | Status | Pointer |
|---|---|---|
| Google review ingestion via Zernio webhooks (real-time) | ✅ Built | `worker/ingress/zernio/`, `.claude/reference/review-ingestion.md` |
| Consented historical review import (import offer, `import_decision`, derived expiry, four enqueue gates) | ✅ Built | spec `docs/superpowers/specs/2026-08-05-consented-review-import-design.md`, `src/lib/reviews/import-consent.ts` |
| CSV review ingest | ✅ Built | `worker/jobs/csv-ingest/` |
| `NormalizedReview` DTO contract (source-agnostic prompt builder) | ✅ Built (invariant #7) | `src/lib/` review source seam |
| Review sentiment (deterministic star-based `deterministic_star_v1`) | ✅ Built | `src/lib/reviews/sentiment.ts` |
| Direct Google Business Profile API access | Historical inventory records application filed 2026-07-01; current approval/access unknown. `google_review_name` storage keeps a future adapter path open | design §8.4, `src/lib/reviews/types.ts` |
| Non-Google platforms (Yelp, Facebook, Tripadvisor, Trustpilot) | ❌ No implementation established here; current identity/source/publisher still carry Google/Zernio assumptions. Each platform requires verified access and capability/policy work | roadmap P6, `src/lib/reviews/types.ts`, `src/lib/publishing/review-publisher.ts` |

### 2.2 Response generation & brand voice

| Capability | Status | Pointer |
|---|---|---|
| AI drafts for every review, brand-voice conditioned | ✅ Built | `src/lib/responses/generator.ts` |
| Brand parameters: `tone`, `products_services`, `staff_names`, `highlight_facts`, `avoid_facts`, `sample_responses` (denormalized on `businesses`) | ✅ Built (since migration 001) | `supabase/migrations/001_initial_schema.sql` |
| Voice learning from owner edits — activates after 5 posted+edited replies, few-shot corpus = most recent 5 of last 10 edited pairs | ✅ Built | `src/lib/responses/voice-learning.ts` |
| Edit-distance (Levenshtein) tracking per response (`original_draft_text`, `edited_text`, `edit_distance`) — longitudinal AI-quality signal | ✅ Built | `responses` table; readers in voice-learning + approval flow |
| Voice Report Card (owner-facing screen of learned register traits + activation meter) | ✅ Built (watch-mode probe) | design §9.2 |
| Prompt policy + version hash recorded on every `api_costs` row | ✅ Built | `src/lib/responses/prompt-policy.ts` |
| Review TL;DR / insight summaries | ✅ Built | `src/lib/responses/review-summary.ts` |
| Structured "Business Truth" layer (hours, refund/cancellation policy, compensation limits) + per-draft "why RepWorth wrote this" explanation | ❌ Not established by this inventory; minimum facts/policies must precede any recovery action depending on them | roadmap P4 |

### 2.3 Approval, autonomy & publishing

| Capability | Status | Pointer |
|---|---|---|
| Copilot approval loop (owner approves everything; approval links with SHA-256-hashed tokens, never raw) | ✅ Built (invariants #3, #5) | `approval_links`, `approval-security` skill |
| Autopilot auto-approval (`auto_policy`) behind gates: current-state, subscription, active-location/connection, review-hash, policy threshold, provider moderation, triage veto, trust dial, veto window, Autopilot tier | ✅ Built | invariant #3, WS4/WS8 |
| Trust dial: rating bands + daily caps (default 10, ceiling 50) | ✅ Built | WS4, migration 074 |
| Veto window (15/30-min enum, DB CHECK) | ✅ Built | WS4 |
| Moderation absolute veto — high-severity drafts held in `flagged_responses` (admin-only RLS), never notified, re-notify only via `/admin/flagged` | ✅ Built (invariant #4) | `approval-security` skill |
| Publishing seam (`ReviewPublisher`: resolveTarget/publishReply/deleteReply/findReply), Zernio as first adapter | ✅ Built | `src/lib/publishing/review-publisher.ts` |
| Edit-existing-replies | ✅ Built | publisher edit suite |
| Per-action autonomy levels (separate grants for positive replies / requests / recovery outreach) | ❌ Not built — trust dial is rating-band + cap only; `SOLICITATION_AUTO_APPROVAL_ENABLED` exists as a flag-level lane split | roadmap P5 |

### 2.4 Watchdogs & governance (the trust infrastructure)

| Capability | Status | Pointer |
|---|---|---|
| Judge — designed to review every auto-post after publication; Judge availability is a posting precondition (unavailable ⇒ publisher downgrades auto-policy rows to owner review). Availability is not a pre-publication verdict on each draft | ✅ Gate source checked Sep 7; live coverage unverified | `worker/jobs/publisher/judge-gate.ts`, WS6, design §8.2 |
| Governor — autonomous per-account autonomy suspension + owner/admin notification; admin `/admin/autonomy` (AAL2); repeat-offender path fixed #520 | ✅ Built | WS6 |
| Run spine — `agent_runs`/`agent_run_steps`/`agent_outcomes`, single writer, transaction-ordered, persona attribution, no raw text in detail columns | ✅ Source checked Sep 7: attribution/lifecycle records, not a generic execution engine; solicitation owns its batch lifecycle | `src/lib/agents/run-spine.ts`, `src/lib/solicitation/outreach.ts`, migration 071 |
| LLM safety eval as a CI release gate (`llm-eval`, path-filtered) | ✅ Built | WS7, `pnpm eval:llm` |
| Restraint policy — pure `evaluateAsk(candidate, context) → send \| withhold(reason, evidence)`, closed withhold-reason enum; the agent visibly refuses harmful asks | ✅ Built | design §9.2 |
| Account audit log (single-transaction writes via `writeAccountAuditLog`) | ✅ Built | `src/lib/audit/log.ts` |
| Refusal ledger + owner Restraint tab | ✅ Source checked Sep 7: seven-lane vocabulary, transactional writer and owner-safe reader/surface exist. Recording depends on runtime flags; historical coverage gaps are disclosed, not backfilled | `src/lib/refusals/{vocabulary,write,read}.ts`, `src/app/(authenticated)/dashboard/analytics/restraint/page.tsx`, `docs/context/refusal-ledger.md` |
| Judge auditing of withhold decisions; Governor per-gate suspension | ❌ Not built (sequenced in design §9.4) | roadmap P5 |

### 2.5 Guardian: triage & escalation

| Capability | Status | Pointer |
|---|---|---|
| Triage — negative lane only (≤3★/unrated), cost-bounded (~200 tokens, pinned `gpt-4o-mini`), `triage_*` columns on `reviews`, `TRIAGE_ENABLED` | ✅ Built | WS2 |
| Escalation — raise → notify → acknowledge/resolve, `review_escalations`, owner-unreachable escalation (migration 083) | ✅ Built | WS3 |
| Recovery cases (complaint classification → private outreach → resolution tracking → outcome) | ❌ Not built — escalation stops at acknowledge/resolve; no recovery object, no private-outreach workflow, no saved/lost outcome | roadmap P2; depends on required P4 facts/policies |

### 2.6 Insights & intelligence

| Capability | Status | Pointer |
|---|---|---|
| Insights persona — weekly digest (`WeeklySummaryWorker`) | ✅ Built | WS5 |
| Monthly impact email (`MonthlyImpactWorker`) | ✅ Worker registration source checked Sep 7; name does not establish measured financial impact | `worker/jobs/MonthlyImpactWorker.ts`, `worker/index.ts` |
| Competitor snapshots — normalized `competitor_snapshots` rows (full SerpAPI local pack, migrations 084/085), weekly digest gap line, owner-picked Named rival + deterministic Auto-default rival | ✅ Built (watch-mode probe) | design §9.2, `docs/context/competitor-delta.md` "Competitor Delta" |
| Ranking tracking (SerpAPI, active-subscription-only) | ✅ Built | invariant #11 |
| Dashboard KPI stack — per-location + per-account aggregate; Review-time anchor; response rate; timeSaved | ✅ Source checked Sep 7 for savings: handled replies × fixed **7-minute estimate**, also used in weekly email; does not deduct approvals, edits, CSV preparation or supervision | `src/lib/dashboard/constants.ts`, `src/lib/dashboard/reputation-summary.ts`, `src/lib/notifications/email/templates/weekly-value-report.ts`, ADR 0019 |
| Review-topic ontology (classify complaints/praise into per-vertical operational topics; operational trend lines) | ❌ Not built — sentiment is star-derived only; later work requires enough usable data | roadmap P3 |
| Reputation graph query layer (staff-level, service-level, complaint→churn questions) | ❌ Not built as queries — existing records are ingredients, not complete attribution or proof of incremental revenue | roadmap P7 |
| ROI / "RepWorth Impact" page with conservative attribution | ❌ Dedicated page not established here; existing report names and timeSaved estimates are not measured ROI. Use a manual evidence sheet before a new UI | roadmap P7 |

### 2.7 Solicitation (review requests)

| Capability | Status | Pointer |
|---|---|---|
| Watch-mode — real batches, per-candidate send/withhold decisions with reasons, sends nothing (`SOLICITATION_WATCH_ENABLED`) | ✅ Built 2026-07-26 | design §9.2 |
| Send-mode — consent ledger, suppression ledger, unsubscribe (both paths → global suppression), email adapter + deliverability, batch approval → sends, mid-flight halt, ramp caps | ✅ Original inventory records staging operation on 2026-08-26; current flags/delivery unverified | design §9.3, specs `2026-07-28-*`, ADRs 0014/0020/0021/0022 |
| Approval/halt lane — `approveBatch`/`haltBatch`/`adminHaltBatch`, ask exclusion/regeneration/withdrawal, halt latch | ✅ Built | spec 2026-07-28-send-mode-executor-approval |
| Candidate source: owner CSV upload with consent attestation (contacts/visits ledger, migrations 086/087) | ✅ Built | spec 2026-07-23-contacts-csv-contract |
| Review attribution — persistent `attributed_review_id`/`attributed_at` marker and `review_attributed` outcome | ✅ Built; original inventory records one staging match. A match is not proof of incremental bookings or revenue | `src/lib/solicitation/attribution.ts` |
| Event-triggered candidates from booking/CRM/FSM/POS systems | ❌ Not built — conditional on shared beta provider, demonstrated CSV burden, access, durable event identity and consent provenance | roadmap P1 |
| QR-code review requests | ✅ Source checked Sep 7: per-location printable/downloadable QR, public Google redirect, best-effort scan event; no customer identity or resulting-sale proof | `src/app/q/[businessId]/route.ts`, `src/app/(authenticated)/dashboard/requests/qr/page.tsx`, `docs/context/review-qr.md` |
| Voice-conditioned asks + memory-jog details; position read-model | ❌ Not built (sequenced §9.4) | later |
| Prod flip | Original inventory named bring-up/counsel gates; current completion and authorization were not checked | design §9.3; deployment/runbook evidence required |

### 2.8 Channels & notifications

| Capability | Status | Pointer |
|---|---|---|
| Email (Resend) — approvals, digests, solicitation sends | ✅ Built | `worker/ingress/resend/` |
| Telegram + WhatsApp owner channels (12 enrollment routes, shared runners, Channel-actor resolvers) | ✅ Built | spec 2026-08-15 portal-audit §4 |
| Auto-posted-reply FYI (`auto_post_notice`) + `/r/google/<id>` redirect | ✅ Built | `docs/runbooks/channels-rollout.md` |
| SMS | ⛔ Deliberately removed (2026-06-09 sms-removal design); TCPA work returns with a future SMS effort | `docs/superpowers/specs/2026-06-09-sms-removal-design.md` |
| Unsubscribe ingress — recipient-facing, rate-limiter-exempt by design | ✅ Built | `worker/ingress/unsubscribe.ts` |

### 2.9 Billing, tiers & lifecycle

| Capability | Status | Pointer |
|---|---|---|
| Copilot/Autopilot tiers; `tierGrantsAutopilot`; `AUTOPILOT_PURCHASABLE` composed purchase gate | ✅ Built | WS8 |
| **Source pricing:** Copilot $29 list / $19 founding; Autopilot $69 / $49 (monthly, per account, one included location); additional location $15/$20 | ✅ Source checked Sep 7; deployed Stripe and purchase availability unverified. Founding availability reads configured `FOUNDING_DEADLINE`, not this snapshot | `src/lib/accounts/tier-config.ts`, `src/lib/payments/founding-window.ts` |
| Grandfathered per-account price snapshot (`locations_included`, overage, `base_price_cents` stored on `accounts`) | ✅ Built (invariant #9a) | migration 054 |
| Card-up-front 30-day trial (`TRIAL_ENABLED`, `trialing` = full access except SerpAPI tracking) | ✅ Built | invariant #11, migration 069 |
| Stripe as source of truth; single status applier | ✅ Built | `worker/ingress/stripe/apply-subscription-state.ts` |
| Admin invite funnel (3-field form, Beta comp coupon, `checkout_attempt_*` snapshot, resend-invite) | ✅ Built | plan 2026-08-14 admin-invite-funnel |
| Self-serve signup (`SELF_SERVE_SIGNUP_ENABLED`) | ✅ Built | gotchas list |
| Owner offboarding (cancel_only / delete_data / purge) | ✅ Built | spec 2026-06-05 |
| Multi-location (lifecycle, per-location overage, account digests, channel overrides) | ✅ Built | spec 2026-06-09 multi-location-hardening |
| Outcome billing (per-outcome pricing semantics on `agent_outcomes`) | ❌ Deliberately not built (design Decision 2: instrumented, not billed); outcome positioning does not require contingent billing | design §8.5 |

### 2.10 Admin & operations

| Capability | Status | Pointer |
|---|---|---|
| Admin console — overview, At-risk data, Business-summary DTO, health badges | ⚠️ Partial — legacy business list/detail/new, Security and Runbook pages retired (source checked Sep 11) | `src/app/admin/overview/page.tsx`, `src/lib/admin/business-summary.ts`; API routes remain; business management moves to the separate Admin app (deployment not checked): [admin retirement notes](../currents.md) |
| Margin/finance signals (aggregate-on-read from `api_costs`) | ✅ Built | `src/lib/admin/margin-service.ts` |
| Flagged-response queue (`/admin/flagged`) | ✅ Built | invariant #4 |
| Autonomy admin (`/admin/autonomy`, AAL2) | ✅ Built | WS6 |
| Admin MFA (AAL2) enforcement (`ci:admin-aal2`) | ✅ Built | portal-audit spec |

### 2.11 Infrastructure & safety rails (summary)

Transactional outbox (invariant #2) · BullMQ on Railway Redis + Upstash cache ·
single-replica worker assumption · LLM task seam
(`runLlmTask`, pinned `gpt-4o-mini` primary / `claude-haiku-4-5` fallback,
per-provider circuit breaker) · two-phase cost guard (Redis reservation before
production LLM calls, with documented demo/eval exceptions) · DB admission chokepoint (#773) · worker crash-net with
transient-DB classification · health alerting (`HealthAlertPoller`, Sentry) ·
PostHog analytics with server-side dispatch · structured logging with
sanitizer · RLS + tenant-scope and CI audits · BotID/WAF edge
protection · eval-in-CI. The source concurrency guard is per process and needs
separate coordination/load evidence before widening the replica envelope
(`worker/config/startup-assert.ts`). Details: `.claude/CLAUDE.md`
and `docs/directory.md` (index) + `docs/directory/` pages.

## 3. Environment reality (do not oversell)

- Current production/staging topology, flags and working journeys were not
  queried. The original August 26 bring-up status cannot establish their state
  on September 7. Use `docs/runbooks/deployment-guide.md` and fresh evidence.
- **No standing migration 078 exception remains.** `.claude/CLAUDE.md` records
  production application at **2026-08-31T07:09Z** and an introspection-based
  lockstep check. This refresh performed no DB introspection; that dated result
  is not a new certification that every migration is still in sync.
- The canonical launch procedure retains ordered supervision/autonomy gates.
  A source flag default, past staging PASS or marketing commitment to flip a
  flag is not evidence that a specific deployment is currently enabled.
- Public availability claims require target/commit, actual flag state and
  completed browser/backend journey evidence. No tier is declared launchable
  solely from this inventory; see positioning §5 and the relevant runbook.

## 4. The gap list (what the forward roadmap exists to close)

Topic IDs remain stable; they are not a queue to execute in numeric order.
The [forward roadmap](2026-08-26-forward-roadmap.md) owns immediate
selection, provisional capacity limits and early cash gates. Select at most
one improvement from actual beta or paid-decision evidence; choosing no new
feature is valid. Funding and beta learning proceed in parallel.

1. **Event-triggered review requests** — no booking/CRM/FSM/POS connectors;
   CSV upload remains the candidate source. (P1)
2. **Reputation recovery workflows** — no recovery case object, no private
   outreach, no resolution/outcome tracking. Requires minimum P4 business
   facts/policies before any dependent outreach or promise. (P2)
3. **Review-topic ontology** — no operational topic classification or trend
   intelligence; sentiment is star-derived. Defer until usable data supports it. (P3)
4. **Business Truth + policy layer** — brand voice exists; structured business
   facts, response policies, compensation limits, and per-draft explanations do
   not. Build only the minimum needed by a selected workflow first. (P4)
5. Per-action autonomy levels. (P5)
6. Non-Google platforms + platform policy engine + direct GBP adapter. (P6)
7. Reputation-graph query layer + ROI/impact page, conditional on useful evidence. (P7)
8. Competitor-intelligence expansion, social-proof widgets, AI-search
   visibility, public API/MCP, agency/white-label. Public agent access still
   needs machine identity, scoped authorization and demand evidence. (P8 / later)

The owner-operator v1 is selected and specified in
[owner-operator/README.md](2026-09-11-owner-operator.md); it is not a
P8/API dependency. Rows above stay "not established" until the checkpoint
evidence lands.

Also open from the design of record (not roadmap-phase work): cadence jitter
(pre-scale item, §8.2), calibrated-confidence router,
cross-agent coordination keys, outcome billing (§8.5), Zernio pay-per-use
pricing-unit + written-echo follow-ups (§8.4 gate note).
