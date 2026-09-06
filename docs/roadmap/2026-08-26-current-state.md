# Current state — what RepWorth has actually built (2026-08-26)

Verified against: design of record §8 (as-built, 2026-07-22) and §9
(solicitation, updated 2026-08-26), `.claude/CLAUDE.md`, staging evidence files
under `docs/runbooks/evidence/`, and targeted code reads. Every claim below has
a code or doc pointer so a future session can re-verify instead of trusting
this snapshot.

## 1. One-paragraph summary

The agentic platform Phase 1 (WS1–WS8) is **fully built and staging-proven**:
run spine, triage, Guardian escalation, trust dial + veto window, persona
surfaces, Judge + Governor, eval-in-CI, and Copilot/Autopilot tier wiring.
Solicitation shipped in two waves — watch-mode (2026-07-26) and **send-mode,
live on staging as of 2026-08-26** (map #617 closed, evidence
`docs/runbooks/evidence/2026-08-24-solicitation-send-mode-staging-flip.md`).
The production stack is deliberately **not stood up yet** — the strategy is one
production bring-up at launch; all autonomy flags are OFF in prod. Copilot is
launchable now with zero autonomy flags.

## 2. Capability inventory

### 2.1 Review ingestion & sources

| Capability | Status | Pointer |
|---|---|---|
| Google review ingestion via Zernio webhooks (real-time) | ✅ Built | `worker/ingress/zernio/`, `.claude/reference/review-ingestion.md` |
| Consented historical review import (import offer, `import_decision`, derived expiry, four enqueue gates) | ✅ Built | spec `docs/superpowers/specs/2026-08-05-consented-review-import-design.md`, `src/lib/reviews/import-consent.ts` |
| CSV review ingest | ✅ Built | `worker/jobs/csv-ingest/` |
| `NormalizedReview` DTO contract (source-agnostic prompt builder) | ✅ Built (invariant #7) | `src/lib/` review source seam |
| Review sentiment (deterministic star-based `deterministic_star_v1`) | ✅ Built | `src/lib/reviews/sentiment.ts` |
| Direct Google Business Profile API access | ⏳ Application filed 2026-07-01, pending; `google_review_name` capture ships since migration 070 to keep the adapter path open | design §8.4 |
| Non-Google platforms (Yelp, Facebook, Tripadvisor, Trustpilot) | ❌ Not built | roadmap Phase 6 |

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
| Structured "Business Truth" layer (hours, refund/cancellation policy, compensation limits) + per-draft "why RepWorth wrote this" explanation | ❌ Not built | roadmap Phase 4 |

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
| Per-action autonomy levels (separate grants for positive replies / requests / recovery outreach) | ❌ Not built — trust dial is rating-band + cap only; `SOLICITATION_AUTO_APPROVAL_ENABLED` exists as a flag-level lane split | roadmap Phase 5 |

### 2.4 Watchdogs & governance (the trust infrastructure)

| Capability | Status | Pointer |
|---|---|---|
| Judge — LLM review of **100%** of auto-posts (`JudgeSweepPoller`, `judge_verdicts`); judge availability is a **posting precondition** (unavailable ⇒ publisher downgrades auto_policy rows to owner review) | ✅ Built, stronger than designed | WS6, design §8.2 |
| Governor — autonomous per-account autonomy suspension + owner/admin notification; admin `/admin/autonomy` (AAL2); repeat-offender path fixed #520 | ✅ Built | WS6 |
| Run spine — `agent_runs`/`agent_run_steps`/`agent_outcomes`, single writer, transaction-ordered, persona attribution, no raw text in detail columns | ✅ Built | `src/lib/agents/run-spine.ts`, migration 071 |
| LLM safety eval as a CI release gate (`llm-eval`, path-filtered) | ✅ Built | WS7, `pnpm eval:llm` |
| Restraint policy — pure `evaluateAsk(candidate, context) → send \| withhold(reason, evidence)`, closed withhold-reason enum; the agent visibly refuses harmful asks | ✅ Built | design §9.2 |
| Account audit log (single-transaction writes via `writeAccountAuditLog`) | ✅ Built | `src/lib/audit/log.ts` |
| Judge auditing of withhold decisions; Governor per-gate suspension | ❌ Not built (sequenced in design §9.4) | roadmap Phase 5 |

### 2.5 Guardian: triage & escalation

| Capability | Status | Pointer |
|---|---|---|
| Triage — negative lane only (≤3★/unrated), cost-bounded (~200 tokens, pinned `gpt-4o-mini`), `triage_*` columns on `reviews`, `TRIAGE_ENABLED` | ✅ Built | WS2 |
| Escalation — raise → notify → acknowledge/resolve, `review_escalations`, owner-unreachable escalation (migration 083) | ✅ Built | WS3 |
| Recovery cases (complaint classification → private outreach → resolution tracking → outcome) | ❌ Not built — escalation stops at acknowledge/resolve; no recovery object, no private-outreach workflow, no saved/lost outcome | roadmap Phase 2 |

### 2.6 Insights & intelligence

| Capability | Status | Pointer |
|---|---|---|
| Insights persona — weekly digest (`WeeklySummaryWorker`) | ✅ Built | WS5 |
| Competitor snapshots — normalized `competitor_snapshots` rows (full SerpAPI local pack, migrations 084/085), weekly digest gap line, owner-picked Named rival + deterministic Auto-default rival | ✅ Built (watch-mode probe) | design §9.2, `docs/context/competitor-delta.md` "Competitor Delta" |
| Ranking tracking (SerpAPI, active-subscription-only) | ✅ Built | invariant #11 |
| Dashboard KPI stack — per-location + per-account aggregate; Review-time anchor for reputation metrics; response rate; timeSaved | ✅ Built | `src/lib/dashboard/`, `src/lib/kpi/fragments.ts`, ADR 0019 |
| Review-topic ontology (classify complaints/praise into per-vertical operational topics; trend lines like "arrival-time sentiment fell 3 months straight") | ❌ Not built — sentiment is star-derived only | roadmap Phase 3 |
| Reputation graph query layer (staff-level, service-level, complaint→churn questions) | ❌ Not built as queries — the underlying spine/attribution data accumulates already | roadmap Phase 7 |
| ROI / "RepWorth Impact" page with conservative attribution | ❌ Not built (timeSaved + response metrics exist as ingredients) | roadmap Phase 7 |

### 2.7 Solicitation (review requests)

| Capability | Status | Pointer |
|---|---|---|
| Watch-mode — real batches, per-candidate send/withhold decisions with reasons, sends nothing (`SOLICITATION_WATCH_ENABLED`) | ✅ Built 2026-07-26 | design §9.2 |
| Send-mode — consent ledger, suppression ledger, unsubscribe (both paths → global suppression), email adapter + deliverability, batch approval → real sends, mid-flight halt, ramp caps | ✅ Built, **live on staging 2026-08-26** (`SOLICITATION_SEND_ENABLED` + `SOLICITATION_AUTO_APPROVAL_ENABLED`) | design §9.3, specs `2026-07-28-*`, ADRs 0014/0020/0021/0022 |
| Approval/halt lane — `approveBatch`/`haltBatch`/`adminHaltBatch`, ask exclusion/regeneration/withdrawal, halt latch | ✅ Built | spec 2026-07-28-send-mode-executor-approval |
| Candidate source: owner CSV upload with consent attestation (contacts/visits ledger, migrations 086/087) | ✅ Built | spec 2026-07-23-contacts-csv-contract |
| Review attribution — permanent `attributed_review_id`/`attributed_at` marker on outreach, idempotent, `review_attributed` outcome; one clean match proven on staging | ✅ Built | `src/lib/solicitation/attribution.ts` |
| Event-triggered candidates from booking/CRM/FSM/POS systems (replace CSV as primary source) | ❌ Not built — named in design §9.4 as the successor | roadmap **Phase 1** |
| QR-code review requests | ❌ Not built — **pulled forward to the pre-launch track** (owner decision 2026-08-26) | forward-roadmap Phase 0 |
| Voice-conditioned asks + memory-jog details; position read-model | ❌ Not built (sequenced §9.4) | later |
| Prod flip | Blocked on production bring-up + counsel sign-off on the #620 Part II brief | design §9.3 |

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
| **Live pricing:** Copilot $29 list / $19 founding; Autopilot $69 / $49 (monthly, **per account**); location overage $10/$20; founding deadline 2027-01-01 | ✅ Set | design §8.2 |
| Grandfathered per-account price snapshot (`locations_included`, overage, `base_price_cents` stored on `accounts`) | ✅ Built (invariant #9a) | migration 054 |
| Card-up-front 30-day trial (`TRIAL_ENABLED`, `trialing` = full access except SerpAPI tracking) | ✅ Built | invariant #11, migration 069 |
| Stripe as source of truth; single status applier | ✅ Built | `worker/ingress/stripe/apply-subscription-state.ts` |
| Admin invite funnel (3-field form, Beta comp coupon, `checkout_attempt_*` snapshot, resend-invite) | ✅ Built | plan 2026-08-14 admin-invite-funnel |
| Self-serve signup (`SELF_SERVE_SIGNUP_ENABLED`) | ✅ Built | gotchas list |
| Owner offboarding (cancel_only / delete_data / purge) | ✅ Built | spec 2026-06-05 |
| Multi-location (lifecycle, per-location overage, account digests, channel overrides) | ✅ Built | spec 2026-06-09 multi-location-hardening |
| Outcome billing (per-outcome pricing semantics on `agent_outcomes`) | ❌ Deliberately not built (design Decision 2: instrumented, not billed) | design §8.5 |

### 2.10 Admin & operations

| Capability | Status | Pointer |
|---|---|---|
| Admin console — overview, businesses, At-risk list, Business-summary DTO, health badges | ✅ Built | spec 2026-08-15 §5, `src/lib/admin/business-summary.ts` |
| Margin/finance signals (aggregate-on-read from `api_costs`) | ✅ Built | `src/lib/admin/margin-service.ts` |
| Flagged-response queue (`/admin/flagged`) | ✅ Built | invariant #4 |
| Autonomy admin (`/admin/autonomy`, AAL2) | ✅ Built | WS6 |
| Admin MFA (AAL2) enforcement (`ci:admin-aal2`) | ✅ Built | portal-audit spec |

### 2.11 Infrastructure & safety rails (summary)

Transactional outbox (invariant #2) · BullMQ on Railway Redis + Upstash cache ·
single-replica worker (detected, not enforced) · LLM task seam
(`runLlmTask`, pinned `gpt-4o-mini` primary / `claude-haiku-4-5` fallback,
per-provider circuit breaker) · two-phase cost guard (Redis reservation before
every LLM call) · DB admission chokepoint (#773) · worker crash-net with
transient-DB classification · health alerting (`HealthAlertPoller`, Sentry) ·
PostHog analytics with server-side dispatch · structured logging with
sanitizer · RLS + tenant-scope + ~15 CI audit scripts · BotID/WAF edge
protection · eval-in-CI. Details: `.claude/CLAUDE.md` and `docs/directory.md` (index) + `docs/directory/` pages.

## 3. Environment reality (do not oversell)

- **Production stack is not stood up** — deliberate (design §8.4): one
  production bring-up at launch (prod Railway worker + Redis + env matrix +
  webhook endpoints + Vercel prod env + smoke). Prod Supabase migrations stay
  in lockstep meanwhile (078 is the single sanctioned gap; see CLAUDE.md).
- **All autonomy flags OFF in prod.** Ordered flip: `TRIAGE` → `ESCALATION` →
  `JUDGE`+`GOVERNOR` → `AUTO_APPROVAL` → `AUTOPILOT_PURCHASABLE`.
- **Staging is the only place the full pipeline runs**, and everything through
  solicitation send-mode has PASS evidence there.
- Marketing consequence: public copy must not claim live autonomy until the
  prod flips happen — see the positioning doc §5.

## 4. The gap list (what the forward roadmap exists to close)

In the locked build order, then the rest:

1. **Event-triggered review requests** — no booking/CRM/FSM/POS connectors;
   CSV upload is the only candidate source. (Phase 1)
2. **Reputation recovery workflows** — no recovery case object, no private
   outreach, no resolution/outcome tracking. (Phase 2)
3. **Review-topic ontology** — no operational topic classification or trend
   intelligence; sentiment is star-derived. (Phase 3)
4. **Business Truth + policy layer** — brand voice exists; structured business
   facts, response policies, compensation limits, and per-draft explanations do
   not. (Phase 4)
5. Per-action autonomy levels. (Phase 5)
6. Non-Google platforms + platform policy engine + direct GBP adapter. (Phase 6)
7. Reputation-graph query layer + ROI/impact page. (Phase 7)
8. Competitor-intelligence expansion, social-proof widgets, AI-search
   visibility, public API/MCP, agency/white-label. (Phase 8 / later)

Also open from the design of record (not roadmap-phase work): cadence jitter
(pre-scale item, §8.2), calibrated-confidence router, conversational surface,
cross-agent coordination keys, outcome billing (§8.5), Zernio pay-per-use
pricing-unit + written-echo follow-ups (§8.4 gate note).
