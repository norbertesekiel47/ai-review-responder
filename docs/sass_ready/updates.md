# RepWorth SaaS-Readiness — Implementation Status (Updates)

> **Generated:** 2026-05-27 · **Migration head:** 052 (next: 053) · **Branch:** `main`
>
> This is a point-in-time audit of what has actually been built against the
> execution plan in [`README.md`](./README.md). It reports, per Step/Wave and
> per Spec (01–29): **what shipped**, **what was deferred and why**, **which
> migrations ran and why**, and **recommended next + future steps**.
>
> Source of truth: each spec's own `Current State` / `Acceptance Criteria`
> annotations, cross-checked against the migration files (043–052), the
> superpowers design/plan docs, and merged PRs (#57, #81, #85, #87, #93–#105).
> Percentages are rough completion estimates for orientation, not precise
> measures.

---

## TL;DR — Launch verdict

**Code for the launch slice is complete.** Step 0 (decisions), Step 1
(keystones + CI), and Step 2 Waves 1–3 are all shipped and merged to `main`.
**Waves 4 (Growth) and 5 (Scale/Maturity) are deliberately NOT built** — by the
plan's own risk framing they are post-launch.

What stands between RepWorth and launch is **not more code** — it's a set of
**external/vendor gates** (lawyer review, insurance, prod env vars, vendor
setup) and **one untested reliability assumption** (PITR restore). See
[§ What's left before launch](#whats-left-before-launch).

---

## Step 0 — Cross-cutting decisions ✅ RESOLVED (2026-05-23)

All six recurring `⚠️` decisions were brainstormed and stamped into the specs.
These are **decisions only** — the implementations landed in their respective
waves.

| Decision | Resolved choice | Landed in |
|---|---|---|
| Analytics tooling | **PostHog Cloud** | `posthog-node` (Step 1) + analytics queue (Wave 2, mig 046) |
| Feature-flag tool | **Hybrid: env-var kill-switches + PostHog flags** | Env flags live; PostHog %-rollout when needed |
| Lifecycle ESP | **Extend Resend + schedulers** | 4 schedulers already live |
| Legal routing | **Migrate all to `/legal/*`** (301/308 redirects) | Wave 1 (PR #85) |
| Audit/cost-metadata home | **Extend `api_costs`** (no separate `llm_calls`) | Wave 3 (mig 050) |
| CSV row cap | **Keep 100** (`MAX_ROWS = 100`) | Already shipped; reconciled in spec |

Also settled: live 4-tier pricing model (not Starter/Growth/Scale); no
repository layer (inline scoping + CI guard).

---

## Step 1 — Keystones ✅ COMPLETE (2026-05-24)

| Keystone | Status | Evidence |
|---|---|---|
| **Base CI gate + branch protection** | ✅ Shipped (PR #57) | `.github/workflows/ci.yml` runs `lint`/`typecheck`/`test`/`build` on every PR + `push:main`; RepWorth-org "main protection" ruleset blocks force-push/deletion; actions SHA-pinned; Dependabot configured |
| **`accounts.past_due_at` column** | ✅ Shipped (PR #81) | Migration **043** — set on `active→past_due`, cleared on recovery/cancellation |
| **Generalized audit helper + extended `account_audit_log`** | ✅ Shipped (PR #81) | Migration **043** (5 metadata cols) + `src/lib/audit/log.ts` (`writeAccountAuditLog`) |
| **Worker-side analytics capture** | ✅ Shipped (PR #81) | `activation_completed` captured on publisher path via `posthog-node` (no-op without key) |

**Deliberately deferred from Step 1:** `account_memberships` (role/membership
schema) — moved to a later Spec 04 auth-hardening slice. The keystone was the
audit foundation only.

**Still open from the CI keystone:** DB-backed integration + Playwright/e2e in
CI (need `TEST_DATABASE_POOL_URL` secret), then the specialized "fail-the-build"
gates (a11y, OpenAPI drift, LLM eval, container scan) required by ~8 specs.

---

## Step 2 — Waves 1–3 (all CODE-COMPLETE, merged to `main`)

### Wave 1 — Foundation / launch-risk ✅ SHIPPED (2026-05-25, PR #85)

Data isolation, billing recon, security baseline, legal docs, approval evidence.

| Spec | Shipped |
|---|---|
| **03** Multi-tenancy | RLS audit script + tenant-scope static audit in `lint` job; cross-tenant integration test (`src/__tests__/tenant-isolation.test.ts`, gated on `TEST_DATABASE_POOL_URL`); `onboarding_demos` under RLS (**mig 045**); `docs/security/{rls-inventory,tenant-isolation}.md` |
| **05** Billing | Subscription + multi-location reconciliation in `StripeLocationsReconcilePoller` (drift → Sentry, never auto-corrects); `past_due_at` (mig 043) |
| **09** Security | `security.txt` + `/security` page; vendor-risk/access registers; secrets-rotation runbooks; CSP report-only/nonce plan; PHI scanner (`src/lib/security/phi-scanner.ts`) on Zernio ingest; existing CSRF/headers/rate-limit confirmed |
| **17** Legal | Canonical `/legal/{terms,privacy,aup,dpa,cookies,sub-processors}` routes; 308 redirects from old paths; reconciled sub-processor list; versioned content; AI-disclosure copy |
| **29** Gap 1 | Approval-text snapshot `approval_audit_log.response_text_at_approval` (**mig 044**), immutable, written in-tx across all publish paths |
| **29** Gap 2 | Multi-location invoice reconciliation + `accounts.flags.is_pilot`; founder pilot-invoice review template |

### Wave 2 — Activation ✅ SHIPPED (2026-05-26, PR #87)

Don't lose a paying customer: onboarding measurement, past-due UX, MFA, support.

| Spec | Shipped |
|---|---|
| **06** Onboarding | First-party analytics queue (`analytics_events`, **mig 046**; RLS in **mig 049**); `AnalyticsDispatchPoller` → PostHog; activation funnel + taxonomy (`docs/analytics/events.md`); Zernio-connect polish (help link, redirect-timeout fallback); CSV template + client validation + partial-success UI; logged-out demo entry |
| **04** Auth | Supabase TOTP MFA enrollment (Settings → Security); MFA challenge route w/ rate limit; AAL2 gates on admin/owner surfaces; extended `account_audit_log` (mig 043) wired to `subscription_status_changed` |
| **05/29 Gap 5** Past-due UX | Day-aware `PastDueBanner` (dismiss → countdown → read-only); day-5 modal; day-8 read-only layer; shared `computePastDueRecoveryState` drives UI + worker guard; `past_due_at` backfill (**mig 047**) |
| **29 Gap 6** Support extension | `/api/admin/billing/grant-extension` (AAL2-gated, audited, writes `accounts.flags.past_due_extension` in one tx); macro + runbook |
| **13** Support | `/help/contact` + 5 help articles + 6 version-controlled macros; admin "view-as" impersonation (`impersonation_sessions`, **mig 048**, RLS, AAL2, signed httpOnly cookie, read-only shell, audit-logged) |
| **29 Gap 7** CSV polish | Template (`public/csv-templates/*`) + Zod validation + "X of Y imported" partial-success UI (per-row audit deferred) |

### Wave 3 — Visibility & AI safety 🟢 CODE-COMPLETE (2026-05-27, PRs #93–#105)

Observability spine, AI-safety audit, moderation, KPIs, finance signals.

| Spec | Shipped |
|---|---|
| **07** Observability | JSON structured worker logs + `AsyncLocalStorage` context (`src/lib/shared/{logger,log-context}.ts`); web + worker `/api/health`; admin queue-depth view; typed event taxonomy + CI drift audit (`scripts/ci/analytics-events-audit.ts`); on-call runbooks (`docs/runbooks/{observability,oncall-3am,alert-tuning}.md`) — **Bull Board deferred** |
| **22** AI ops | OpenAI model pinned `gpt-4o-mini-2024-07-18` (guarded by `model-pinning.test.ts`); versioned/hashed prompt base (`src/lib/responses/prompt-policy.ts`); per-call audit metadata on `api_costs` (**mig 050**); prompt-injection hardening; LLM eval harness (`tests/llm-eval/*`, keyless, `pnpm eval:llm`) |
| **10** Trust & Safety | Output moderation (`src/lib/moderation/*`, local regex + optional OpenAI Moderation, fail-open); high-confidence unsafe drafts held in `flagged_responses` (**mig 051**, admin-only deny-all RLS, owner-notification suppressed in-tx); `/admin/flagged` disposition queue; trust-safety enforcement docs (`docs/trust-safety/*`) |
| **11** Data/BI | Deterministic per-review sentiment (`reviews.sentiment_*`, **mig 052**, star-based classifier); 5 customer KPIs (`DashboardKpiSummary` — response rate, avg star, volume MoM, time-to-respond, 8-week sentiment trend); `GET /api/dashboard/kpis` (auth + IDOR + subscription read-entitlement + UUID-scope validation); per-location/per-account scope (`src/lib/kpi/*`) |
| **26** Finance | Admin-only API/LLM cost-margin signals computed aggregate-on-read from `api_costs` (`src/lib/admin/margin-service.ts`, `getMarginReport` — per-account cost/MRR risk at 25%/40%, platform margin at 70%/60%); surfaced in `/admin/costs`; finance docs (`docs/finance/{cogs-template,monthly-close,model}.md`) |

---

## Migrations added & run (043–052)

All additive/idempotent; owner runs them via the Supabase SQL editor. Migration
head is now **052**.

| # | File | Wave | Why it was added |
|---|---|---|---|
| **043** | `step_1_keystones` | Step 1 | Adds `accounts.past_due_at` (countdown source) + 5 generic `account_audit_log` metadata columns (`entity_type`, `entity_id`, `ip`, `user_agent`, `request_id`) for the typed audit helper |
| **044** | `approval_audit_snapshot` | Wave 1 | Immutable `approval_audit_log.response_text_at_approval` — proves exact owner-approved text even if `responses.approved_text` later changes |
| **045** | `onboarding_demos_rls` | Wave 1 | Brings tenant-scoped `onboarding_demos` (from mig 032) under RLS so authenticated reads are constrained to the owning account |
| **046** | `analytics_events` | Wave 2 | First-party analytics dispatch queue — browser/Next.js record facts here; workers ship to PostHog async (Vercel = UI only) |
| **047** | `backfill_past_due_at` | Wave 2 | Backfills `past_due_at` for accounts already `past_due` before mig 043 shipped (would otherwise be NULL → recovery helper misbehaves) |
| **048** | `impersonation_sessions` | Wave 2 | Admin impersonation session state — time-boxed, RLS-protected, AAL2-gated support "view-as" |
| **049** | `analytics_events_rls` | Wave 2 | Enables RLS on `analytics_events` — mig 046 was the only table-creating migration that skipped it (anon PostgREST exposure risk) |
| **050** | `api_costs_metadata` | Wave 3 | Per-call AI-safety/audit metadata on `api_costs`: `system_prompt_hash`, `prompt_version`, `latency_ms`, `moderation_score`, `moderation_categories`, `flagged`, `output_excerpt` |
| **051** | `flagged_responses` | Wave 3 | Holds high-confidence unsafe drafts out of the owner-notification path until admin disposition; preserves the no-auto-posting invariant; admin-only deny-all RLS |
| **052** | `reviews_sentiment` | Wave 3 | Nullable `reviews.sentiment_*` columns + label CHECK + one-time star-based deterministic backfill (LLM-ready via `sentiment_source`) |

**Deferred migrations (named in specs, not yet created):** `account_memberships`
(Spec 04 teams), `legal_acceptances` (Spec 17 re-accept flow), `brand_voices`
(Specs 18/22 per-language voice), `nps_responses` (Spec 14), `referrals`
(Spec 16), `api_tokens` (Spec 20), `account_llm_cost` rollup (Spec 29 Gap 4).

---

## Per-spec status (01–29)

Rough completion %, what's done, what's deferred + why. **Bold** = launch-slice
spec (Waves 1–3). Plain = Wave 4/5 (post-launch by design).

| # | Spec | % | Implemented | Deferred (and why) |
|---|---|--:|---|---|
| 01 | Product–Market Fit | ~30% | Worker analytics capture; multi-location proves wedge #2 | `docs/icp.md`, JTBD landing copy, `/compare`, `/changelog`, `posthog-js`, retention dashboards — Wave 4 growth work |
| 02 | Pricing & Packaging | ~60% | 4 tiers live (`tier-config.ts`); pricing page w/ annual toggle; per-location overage; 7-day grace | Usage meter; 80/100/120% soft-cap notifications; `auto_upgrade_opt_in`; proration FAQ; `docs/billing/*` — not yet built |
| **03** | **Multi-tenancy** | ~80% | RLS audit + scope guard in CI; cross-tenant test; mig 045; isolation docs | Hard-gate DB test in CI (needs `TEST_DATABASE_POOL_URL`); hourly synthetic probe; Sentry breach alert; cache-key decision |
| **04** | **Auth & Identity** | ~70% | TOTP MFA; AAL2 gates; admin impersonation; extended audit (mig 043) | Recovery codes; device/session mgmt; `account_memberships` + Team UI (later auth slice); audit export; mandatory-MFA policy |
| **05** | **Billing Lifecycle** | ~80% | Recon pollers; `past_due_at`; day-aware banner/modal/read-only; grant-extension | Branded dunning emails; cancellation survey; Stripe Tax; dunning/chargeback runbooks |
| **06** | **Onboarding & Activation** | ~85% | Analytics queue (mig 046/049); funnel + taxonomy; Zernio polish; CSV import; demo | TTFV dashboard (needs prod data); white-glove runbook; Growth-tier auto-prompt |
| **07** | **Observability** | ~70% | JSON logs + context; `/api/health`; admin queue view; taxonomy + CI audit; runbooks | **Bull Board**; centralized log drain; Sentry P0–P2 routing; synthetic checks; ops dashboard — external/vendor gates |
| 08 | Reliability & SRE | ~40% | Base CI + branch protection; runbook base; PITR enabled (**untested**); worker health check | Status page; SLO docs; severity ladder; postmortem template; **first PITR restore test**; weekly S3 backups; `/trust`; Next.js `/api/health` |
| **09** | **Security & Compliance** | ~55% | security.txt + `/security`; PHI scanner; CSRF/headers/rate-limit; registers; secrets-rotation runbooks; OAuth encrypted columns | Pentest ($50k MRR gate); ZAP/Trivy CI gates (need staging); SOC 2; remove CSP `'unsafe-inline'` (after soak); Dependabot/Snyk specialized gates |
| **10** | **Trust & Safety** | ~75% | Prompt-injection guard; output moderation; `flagged_responses` (mig 051); `/admin/flagged`; enforcement docs; eval harness | Signup abuse detection (CAPTCHA/disposable-email); customer abuse-report path + SLAs; appeal flow; transparency report; OpenAI Moderation in prod |
| **11** | **Data, Analytics & BI** | ~70% | Sentiment classifier (mig 052); 5 KPIs; `/api/dashboard/kpis`; taxonomy + CI audit | Visible KPI cards (UI, Wave 4+); CSV/PDF export; PostHog prod dashboards; per-location filter UI |
| 12 | Performance & Scalability | ~25% | DB tuning; React Query; partial pagination; base CI | Load tests (k6); 500-location seed; N+1 walkthrough; latency budgets; Lighthouse-CI; web-vitals; pool monitoring — Wave 5 |
| **13** | **Customer Support** | ~50% | `/help/contact`; 5 articles; 6 macros; admin impersonation (mig 048); support runbook | Help Scout inboxes; in-app chat (Plain/Crisp); Mintlify docs; auto-responder; SLA reporting; full 20 macros; export/delete-account UI |
| 14 | Customer Success & Retention | ~30% | 4 lifecycle schedulers; Resend lifecycle email; churn score; cancellation grace | Health-score table/scheduler; at-risk dashboard; NPS modal; CSAT; Canny; QBRs; win-back; 2 of 5 sequences — Wave 4 |
| 15 | Sales & GTM | ~25% | Lead intake (`owner_leads`, mig 033); onboarding demo; multi-location billing | CRM (HubSpot/Attio); Stripe→CRM sync; `demo.repworth.com`; Calendly; collateral; deal desk; lead scoring — Wave 4 |
| 16 | Marketing & Growth | ~15% | Lead intake; landing UI; Resend/schedulers | Programmatic SEO; blog; `/changelog`; referral program; UTM columns; Ads/Meta; PostHog conversion tracking; LP template — Wave 4 |
| **17** | **Legal & Compliance Docs** | ~60% | `/legal/*` routes + 308 redirects; sub-processor list; versioned content; AI-disclosure copy | **Lawyer review**; **insurance binding**; `legal_acceptances` table + re-accept; cookie-consent banner; AI-disclosure banner at approval UI — external gates |
| 18 | i18n & Localization | ~5% | `reviews.detected_language` column exists (written NULL); Stripe local-currency checkout | `next-intl`; string extraction; populate detected_language; `brand_voices`; 5-language eval sets — Wave 5 (English-only first 12mo) |
| 19 | Accessibility | ~10% | Base CI; design tokens | axe/Pa11y CI gates; Radix vs custom decision; aria-label coverage; baseline/cleanup; keyboard/SR testing; VPAT; skip-to-main — Wave 5 |
| 20 | API & Integrations | ~10% | Zod pervasive in routes; approval invariant safe (no auto-publish) | `/api/v1/*`; `api_tokens`; Svix outbound webhooks; OpenAPI gen; public rate limiting; Zapier (month 9) — Wave 4 |
| 21 | Mobile | ~40% | Responsive dashboard + `MobileTabBar`; SMS/Telegram/WhatsApp approval; SHA-256 tokens | PWA (manifest/SW); web-push; offline mode; swipe/sticky-approve; real SMB-owner SMS tests — Wave 5 |
| **22** | **AI/LLM Operations** | ~75% | Model pinning + guard; prompt policy/hash; eval harness; api_costs metadata (mig 050); moderation | Scheduled 50-row **live** eval; per-language brand-voice; `brand_voices` table; per-customer cost rollup + margin alert; admin cost dashboard |
| **23** | **Testing & QA** | ~50% | ~302 unit/integration + 13 e2e; base CI; `MOCK_EXTERNAL_APIS`; startup-assert | DB-integration gate; Playwright in PR gate; post-deploy smoke; visual regression; load tests; chaos drills; flakiness tracker |
| **24** | **DevOps & Deployment** | ~55% | Secret-free CI gate + branch protection (ruleset); env-var flags; Dependabot; `.env.example`; startup-assert | Railway PR envs; Vercel preview URLs in PR; `TEST_DATABASE_POOL_URL`; Playwright PR gate; rollback runbook; secrets-rotation runbooks; Slack `#deploys` |
| 25 | Documentation | ~20% | `docs/adr/0001`; base CI; strong runbooks; CLAUDE.md/currents/directory | 12 bootstrap ADRs (0002–0013); `CONTEXT.md`; Mintlify docs site; docs CI (lychee/cspell); `/changelog` — Wave 5 |
| **26** | **Financial Operations** | ~40% | Admin cost-margin signals (`margin-service.ts`); `/admin/costs`; finance docs; per-call `api_costs` | ProfitWell/Stripe Sigma; MRR/NRR/GRR dashboard; PostHog cohorts; QuickBooks/Xero close; materialized rollup — external gates |
| 27 | Team & Knowledge | ~0% | — (nothing built) | All docs absent: new-hire onboarding; 1Password emergency access; sealed envelope; access checklist; on-call; hiring/JD — Wave 5 |
| 28 | Customer Comms & Brand | ~30% | Resend client + 10 templates; lifecycle/transactional category tags + List-Unsubscribe; `email-deliverability.md` runbook | **DKIM/SPF/DMARC `p=reject` enforcement** (DNS/Resend — verify!); breach-notification runbook; maintenance-comms template; `docs/brand/voice.md`; changelog widget; separate sending domain |
| **29** | **RepWorth Gaps** | ~50% | Gap 1 (approval snapshot, mig 044); Gap 2 (invoice recon); Gap 5 (past-due UX, mig 047); Gap 6 (grant-extension); Gap 7 (CSV, partial) | Gap 3 (GBP-direct fallback source); Gap 4 (LLM cost rollup + margin guard); Gap 8 (`/legal/trust` Trust Center) — deferred |

---

## What's left before launch

The launch slice is code-complete. The remaining launch work is **non-code**.

### Hard launch blockers (do not launch without these)

1. **Lawyer review of legal docs** (Spec 17) — ToS/PP/AUP/DPA are live but
   unreviewed. `docs/legal/legal-review.md` is a placeholder.
2. **Insurance binding** ($1M E&O + Cyber) by first paid customer (Spec 17).
3. **Email auth: DKIM/SPF/DMARC** (Spec 28) — **verify this is enforced.** Your
   entire product hinges on approval emails landing in the inbox; if the Resend
   sending domain isn't authenticated, the core loop silently breaks. Likely
   already set via Resend domain verification — confirm `p=reject`.
4. **First PITR restore test** (Spec 08) — PITR is *enabled* but **never
   restored end-to-end**. This is the single most important untested assumption;
   a botched first restore during a real incident is catastrophic.

### Production env / vendor gates (needed for shipped features to actually work)

5. `POSTHOG_API_KEY` in prod — analytics queue + activation funnel are inert without it.
6. `IMPERSONATION_COOKIE_SECRET` (≥32 chars) — admin "view-as" support flow.
7. `OPENAI_MODERATION_ENABLED` + threshold tuning — second moderation layer (local regex always runs).
8. Help Scout inbox/workflow setup — support@/billing@/security@/report@.
9. Sub-processor list re-confirmation once PostHog is live in prod (compliance accuracy).

### Cheap, high-signal quick wins (hours, not days)

10. Write `CONTEXT.md` (Spec 25) and `docs/icp.md` (Spec 01).
11. `docs/runbooks/rollback.md` (Spec 24) — you should have this before any prod incident.

---

## Recommended next steps (now)

In priority order — these close the launch gate without new feature code:

1. **Run the first PITR restore drill** and document RTO (Spec 08). Highest risk-reduction per hour.
2. **Confirm DKIM/SPF/DMARC** on the Resend sending domain (Spec 28). 10 minutes; protects the core flow.
3. **Send legal docs to a lawyer; get an insurance quote** (Spec 17). Long lead time — start now, in parallel.
4. **Set the production env vars** (#5–7 above) and smoke-test the activation funnel + impersonation + moderation paths against prod config.
5. **Wire `TEST_DATABASE_POOL_URL` in CI** (Specs 03/23/24) — flips the cross-tenant isolation test and integration suite from self-skip to hard-gated. Unblocks the strongest correctness guarantee you have.
6. **Author the two cheap runbooks** — `rollback.md` and `secrets-rotation-*.md` (Spec 24).
7. **Set up Help Scout** + finish the macro catalog (Spec 13) before first paying customer.

## Future steps to plan (post-launch, do NOT block launch)

**First 90 days (close partial launch-slice gaps as data arrives):**
- TTFV dashboard once prod analytics flows (Spec 06); turn on OpenAI Moderation when volume justifies (Spec 10); schedule the weekly live LLM eval (Spec 22).
- Bull Board + centralized log drain + Sentry P0–P2 routing + synthetic checks (Spec 07) — convert observability from "logs exist" to "alerts fire."
- Branded dunning emails + cancellation survey (Spec 05); usage meter + soft-cap notifications (Spec 02).
- Specialized CI gates: ZAP/Trivy (Spec 09), a11y axe/Pa11y (Spec 19), OpenAPI drift (Spec 20), Playwright in PR gate (Spec 23).

**Wave 4 — Growth (when you want to scale acquisition/retention):**
- Spec 01 PMF instrumentation · Spec 16 SEO/referral/UTM · Spec 15 CRM + demo env · Spec 14 health score + lifecycle sequences + NPS · Spec 20 public API + Zapier · Spec 28 comms polish.

**Wave 5 — Scale & maturity (at 10× load or enterprise asks):**
- Spec 12 load/perf · Spec 08 DR drills + status page + SLOs · Spec 18 i18n · Spec 19 a11y/VPAT · Spec 21 PWA/mobile · Spec 23 testing depth (visual regression, chaos) · Spec 25 ADRs + Mintlify · Spec 27 team/hiring docs.

**Spec 29 leftover gaps to schedule:**
- Gap 3 (GBP-direct fallback ingestion source — de-risks Zernio single-vendor dependency; Wave 4/5).
- Gap 4 (per-customer LLM cost rollup + margin guard — pairs with Spec 22/26; once cost data accumulates).
- Gap 8 (`/legal/trust` Trust Center — wire after status page + postmortems + sub-processors exist).

---

## Notes on accuracy

- Statuses reflect spec annotations + merged PRs as of 2026-05-27. Percentages
  are orientation estimates, not measured coverage.
- "CODE-COMPLETE" ≠ "in production." Every Wave 1–3 spec carries external/vendor
  gates that are tracked above, not in the code.
- Update this file's per-spec rows when a spec's `Current State` changes
  materially (per the Maintenance section of `README.md`).
