# RepWorth SaaS-Readiness Specs

> Optimized, implementation-ready specs derived from `docs/saas_readiness_questions_for_repworth.md`. Each spec is a self-contained design document for closing a specific readiness gap, tied to RepWorth's code, migrations, and runbooks.

---

## Index

| # | Spec | Focus |
|---|---|---|
| 01 | [Product–Market Fit & Positioning](./01-product-market-fit.md) | ICP, JTBD, wedges, activation event |
| 02 | [Pricing & Packaging](./02-pricing-packaging.md) | Three tiers, per-location value metric, hybrid sub + overage |
| 03 | [Multi-tenancy & Data Isolation](./03-multitenancy-isolation.md) | Repository scoping, RLS, brutal cross-tenant test |
| 04 | [Auth, AuthZ & Identity](./04-auth-identity.md) | SSO + MFA + role model + audit log |
| 05 | [Billing & Subscription Lifecycle](./05-billing-subscription.md) | Stripe-first recon, dunning, past_due UX |
| 06 | [Onboarding & Activation](./06-onboarding-activation.md) | < 10-min TTFV, OAuth hardening, sample-data demo |
| 07 | [Observability, Logging & Monitoring](./07-observability.md) | Sentry SLO, structured logs, Bull Board, synthetic checks |
| 08 | [Reliability, SRE & Incident Response](./08-reliability-sre.md) | SLOs, status page, severity ladder, DR drills |
| 09 | [Security & Compliance](./09-security-compliance.md) | Pentest, secrets rotation, KMS, SOC 2 controls |
| 10 | [Trust & Safety](./10-trust-safety.md) | 3-layer moderation, prompt-injection defense, abuse path |
| 11 | [Data, Analytics & BI](./11-data-analytics-bi.md) | 5-KPI dashboard, event taxonomy, sentiment classifier |
| 12 | [Performance & Scalability](./12-performance-scalability.md) | Load tests, latency budgets, 500-location scenario |
| 13 | [Customer Support](./13-customer-support.md) | Help Scout + chat + KB + admin impersonation |
| 14 | [Customer Success & Retention](./14-customer-success-retention.md) | Health score, lifecycle email, QBR, Canny |
| 15 | [Sales & GTM Operations](./15-sales-gtm.md) | PLG + sales-assisted, demo env, deal desk |
| 16 | [Marketing & Growth](./16-marketing-growth.md) | Programmatic SEO, blog cadence, referral, attribution |
| 17 | [Legal & Compliance Docs](./17-legal-compliance-docs.md) | ToS/PP/AUP/DPA lawyered, AI disclosure, insurance |
| 18 | [Internationalization & Localization](./18-i18n-localization.md) | `next-intl`, multi-language AI generation, per-language eval |
| 19 | [Accessibility](./19-accessibility.md) | WCAG 2.1 AA, axe + Pa11y in CI, VPAT |
| 20 | [API, Integrations & Extensibility](./20-api-integrations.md) | REST + OpenAPI + Svix webhooks + Zapier |
| 21 | [Mobile](./21-mobile.md) | PWA + 2-tap approve + SMS/Telegram/WhatsApp |
| 22 | [AI/LLM Operations](./22-ai-llm-ops.md) | Pinned models, eval set, cost tracking, guardrails |
| 23 | [Testing & QA](./23-testing-qa.md) | Critical-path coverage, post-deploy smoke, visual regression, chaos |
| 24 | [DevOps & Deployment](./24-devops-deployment.md) | PR previews, feature flags, rollback playbook, secrets rotation |
| 25 | [Documentation](./25-documentation.md) | ADRs, Mintlify docs, CONTEXT.md, doc CI |
| 26 | [Financial Operations](./26-financial-operations.md) | MRR/NRR/GRR + ≥ 75% gross margin + 3-scenario runway model |
| 27 | [Team & Knowledge Management](./27-team-knowledge.md) | Hiring triggers, onboarding doc, bus-factor emergency access |
| 28 | [Customer Communications & Brand](./28-customer-comms-brand.md) | DKIM/SPF/DMARC, branded templates, breach notification |
| 29 | [RepWorth-Specific Gaps](./29-repworth-specific-gaps.md) | Approval audit snapshot, multi-location recon, Zernio fallback, Trust Center |

---

## How to use these specs

1. **Pick a spec** matching the area you want to harden.
2. **Read the "Current state" section** — references existing code, migrations, runbooks. Don't re-do what's already done.
3. **Use "Implementation tasks"** as a checklist. Each task is bounded and actionable.
4. **Acceptance criteria** are merge-gate level: when checked, the spec is shipped.
5. **Metrics & alerts** plug into [Spec 07 — Observability](./07-observability.md).
6. **Cross-links** at the bottom point to upstream/downstream specs and code anchors.

Each spec is independent enough to be implemented as a single planning epic but cross-references its dependencies so you don't ship a half-thing.

---

## Execution strategy (do **not** run these 1 → 29)

> Added 2026-05-23 after the full verification pass (all specs checked against the live tree, head 042). Spec numbers are an **index, not an execution order.** Three facts make sequencing matter:
> 1. **Keystones unblock clusters** — the first secret-free base CI gate (Spec 24) is in place; adding specialized gates still unblocks ~8 specs.
> 2. **Cross-cutting decisions sit upstream** of whole groups — resolve once, not per-spec.
> 3. **~40% is already partly built** — much "implementation" is verify-and-polish, not greenfield.

### The different ways to run them

| Model | What it is | Best when | Main cost |
|---|---|---|---|
| Sequential (1→29) | Top-to-bottom by number | Never — index order ≠ dependency order | Rework; rebuilds already-shipped work |
| Risk-tiered | Launch → activation → growth → scale blockers (§ below) | You want a pure priority lens | Doesn't encode dependencies |
| Dependency waves | Decisions → keystones → dependents | You want zero rework | Slower to first visible win |
| Parallel tracks | Independent clusters run concurrently | You have ≥ 2 builders | Needs capacity + coordination |
| **★ Risk-ordered critical path** | Waves, ordered by launch-risk *within* dependency constraints, one spec at a time | **Solo founder optimizing for low launch risk (RepWorth today)** | — |

**Recommended for RepWorth now: the Risk-ordered critical path below.** (Parallel tracks become the right model once you make your first hire — see [Spec 27](./27-team-knowledge.md).)

### Step 0 — Resolve the cross-cutting decisions first ✅ RESOLVED 2026-05-23

These `⚠️` choices recur across many specs; deciding them once prevents building the same thing twice. **All six are now resolved** (brainstormed 2026-05-23) and stamped into the affected specs as `✅ Decided (Step 0)`:

| Decision | ✅ Resolved choice | Rationale | Blocks (now unblocked) |
|---|---|---|---|
| Analytics tooling ([Spec 01](./01-product-market-fit.md) §2a) | **PostHog Cloud** | Fastest event capture + cohorts, minimal infra; bundles the feature-flag tool. Rejected Postgres+Metabase (build cohort math yourself); Metabase stays as the later scale option. | 01, 06, 07, 11, 14, 16, 26 |
| Feature-flag tool ([Spec 24](./24-devops-deployment.md)) | **Hybrid: env-var kill-switches + PostHog flags** | Keep working boolean kill-switches; use PostHog flags (free from the analytics choice) for %-rollout/A-B. GrowthBook rejected — no second vendor. | 22, 24, any gradual rollout |
| Lifecycle ESP ([Spec 14](./14-customer-success-retention.md)/16/28) | **Extend Resend + schedulers** | 4 schedulers already live; new sequences ride that infra. Loops/Customer.io rejected — net-new vendor + parallel infra for no current gain. | 14, 16, 28 |
| Legal routing ([Spec 17](./17-legal-compliance-docs.md)) | **Migrate all to `/legal/*`** (301-redirect old paths) | Only 2 pages exist today — cheapest to canonicalize now before publishing AUP/DPA/cookies/sub-processors. | 17, 19 (VPAT), 29 (Trust Center) |
| Audit/cost-metadata home ([Spec 10](./10-trust-safety.md)/22) | **Extend `api_costs`** | Add `system_prompt_hash`/`latency_ms`/`moderation_score` columns. A separate `llm_calls` would double-record cost data. | 10, 22, 26, 29 Gap 4 |
| CSV row cap ([Spec 06](./06-onboarding-activation.md)/29) | **Keep 100** | Tested + shipped (`MAX_ROWS = 100`). Spec text reconciled to 100. Raise only on real customer demand. | 06, 29 Gap 7 |

_Also settled earlier this pass: live 4-tier model (not Starter/Growth/Scale); no repository layer (inline scoping + CI guard)._

> **Next:** Step 0 is decisions only — the actual PostHog install, `api_costs` migration, `/legal/*` move, etc. land in their respective specs/waves. Proceed through the remaining **Step 1 keystones** now that the CI keystone's first secret-free slice has shipped.

### Step 1 — Lay the keystones (each unblocks a cluster)

| Keystone | Spec | Unblocks |
|---|---|---|
| **Extend GitHub Actions CI beyond the shipped secret-free base gate** | [24](./24-devops-deployment.md) (task 0 follow-ups) | every specialized "fail-the-build" gate: 07, 08, 09, 12, 19, 22, 23, 25 |
| `accounts.past_due_at` column | [05](./05-billing-subscription.md) | countdown UX (05, 29 Gap 5), grant-extension (29 Gap 6) |
| Analytics event capture on the worker publish path (PostHog — Step-0 decision) | [01 §2a](./01-product-market-fit.md) | 01, 06, 11, 14, 16, 26 |
| Generalized audit helper + extended `account_audit_log` | [04](./04-auth-identity.md) | impersonation audit (13), approval snapshot (29 Gap 1) |

**CI first slice is shipped** — the secret-free base gate now runs `lint`, `typecheck`, `test`, and `build`. Next, add DB-backed integration, Playwright/e2e, branch protection, and the specialized gates required by ~8 specs.

### Step 2 — Risk-ordered waves (solo, one spec at a time)

Within each wave, clear the **verify-and-polish** specs before the greenfield ones to bank quick wins.

- **Wave 1 — Foundation / launch-risk** (data, billing, legal, trust): `03` tenant-isolation test + scope-audit · `05` billing recon + `past_due_at` · `09` security (security.txt, CSP nonces, secrets rotation, PHI scanner) · `17` legal (lawyered docs + sub-processor reconcile) · `29` Gap 1 (approval snapshot) + Gap 2 (invoice recon).
- **Wave 2 — Activation** (don't lose a paying customer): `06` onboarding measurement + CSV polish · `05`/`29` Gap 5 past_due UX + Gap 6 grant-extension · `04` MFA + audit · `13` support (KB + impersonation).
- **Wave 3 — Visibility & AI safety**: `07` observability (JSON logs, Next.js `/api/health`, Bull Board) · `22` AI ops (**pin the OpenAI model — 1 line**, eval set, moderation) + `10` trust/safety · `11` KPIs + sentiment · `26` finance rollup.
- **Wave 4 — Growth**: `01` PMF instrumentation · `16` marketing (SEO, referral, UTM) · `15` sales (CRM, demo) · `14` CS (health score, lifecycle) · `20` API · `28` comms polish.
- **Wave 5 — Scale & maturity**: `12` perf/load · `08` reliability/DR drill · `18` i18n · `19` a11y · `21` mobile/PWA · `23` testing depth · `25` docs (ADRs, CONTEXT.md) · `27` team.

### Quick wins — do today (cheap, high signal)

- **Pin the OpenAI model** ([Spec 22](./22-ai-llm-ops.md)) — the unversioned `gpt-4o-mini` is a silent-regression risk; ~1 line.
- Write `docs/icp.md` ([01](./01-product-market-fit.md)) and `CONTEXT.md` ([25](./25-documentation.md)) — hours, not days.
- **Reconcile the sub-processor list** ([17](./17-legal-compliance-docs.md)) — it currently overstates reality (lists not-yet-live vendors + a wrong Zernio token claim); that's a live compliance-accuracy risk.
- ~~Resolve the Step-0 decisions.~~ ✅ Done 2026-05-23 (see Step 0 above).

### Verify, don't rebuild (already partly shipped — confirm before writing code)

Annual UI + per-location overage ([02](./02-pricing-packaging.md)) · webhook idempotency, reconcile pollers, `PastDueBanner` ([05](./05-billing-subscription.md)) · both KPI dashboards ([11](./11-data-analytics-bi.md)) · lifecycle schedulers ([14](./14-customer-success-retention.md)) · `ReviewSource` + a 2nd impl ([29](./29-repworth-specific-gaps.md) Gap 3) · `api_costs` ([26](./26-financial-operations.md)) · Zod in routes ([20](./20-api-integrations.md)) · `reviews.detected_language` ([18](./18-i18n-localization.md)) · `docs/adr/` + ADR 0001 ([25](./25-documentation.md)).

---

## Prioritization framework

> This is the **risk lens** that orders the waves in the Execution strategy above — read it as "which tier a spec belongs to," then run it via the Risk-ordered critical path.

Sequence work by the **smallest blocker that blocks the most growth**:

### 1. Launch-blockers (anything risking data loss, billing errors, or legal exposure in the next 30 days)

- [Spec 03 — Multi-tenancy](./03-multitenancy-isolation.md): tenant-isolation integration test.
- [Spec 05 — Billing](./05-billing-subscription.md): hourly reconciliation worker.
- [Spec 09 — Security](./09-security-compliance.md): lawyered ToS/PP/AUP/DPA.
- [Spec 17 — Legal](./17-legal-compliance-docs.md): sub-processor page + DPA.
- [Spec 29 — Gaps](./29-repworth-specific-gaps.md): approval audit content snapshot.

### 2. Activation-blockers (anything that costs a paying customer in the next 90 days)

- [Spec 06 — Onboarding](./06-onboarding-activation.md): < 10-min TTFV, sample-data demo.
- [Spec 13 — Support](./13-customer-support.md): in-app chat + KB.
- [Spec 29 — Gaps](./29-repworth-specific-gaps.md): past_due banner + countdown.

### 3. Growth-blockers (anything that caps growth in the next 12 months)

- [Spec 16 — Marketing](./16-marketing-growth.md): SEO programmatic pages, referral program.
- [Spec 20 — API](./20-api-integrations.md): Zapier app, REST API.
- [Spec 15 — Sales](./15-sales-gtm.md): demo environment.

### 4. Scale-blockers (anything that breaks at 10× current load)

- [Spec 03 — Multi-tenancy](./03-multitenancy-isolation.md): RLS audit gate in CI.
- [Spec 12 — Performance](./12-performance-scalability.md): load test + 500-location scenario.
- [Spec 22 — AI/LLM](./22-ai-llm-ops.md): eval set in CI.
- [Spec 29 — Gaps](./29-repworth-specific-gaps.md): second review-ingestion source.

### 5. Maturity (everything else)

- [Spec 09 — Security](./09-security-compliance.md): SOC 2.
- [Spec 21 — Mobile](./21-mobile.md): native iOS/Android.
- [Spec 08 — Reliability](./08-reliability-sre.md): multi-region.
- [Spec 15 — Sales](./15-sales-gtm.md): partner / agency program.

---

## The "good readiness review" hot-loop

> Alternate **calendar view** for a solo founder pacing over a year. The Step-2 waves above are the canonical order; this table groups those same waves into quarters (Step-0 decisions + the CI keystone land first, in Q1). Where the two views differ, **the waves win** — this is a pacing aid, not a second plan.

If you have a quarter and want to maximize readiness:

| Quarter | Theme | Specs to ship (≈ waves) |
|---|---|---|
| **Q1** | Keystones + Foundation | **Step 1**: CI (`24` task 0) · `04` audit helper · `05` `past_due_at` · `01` analytics capture — then **Wave 1**: `03`, `09`, `17`, `29` (gaps 1, 2) |
| **Q2** | Activation (Wave 2) | `06`, `13`, `04` MFA, `05`/`29` gaps 5–6 |
| **Q3** | Visibility & AI safety + Growth seeds (Waves 3 + early 4) | `07`, `22`, `10`, `11`, `26` · then `16` |
| **Q4** | Growth + Scale & maturity (Waves 4 + 5) | `15`, `14`, `20`, `28` · `12`, `08`, `18`, `19`, `21`, `23`, `25`, `27` |

Specs 01 (PMF) and 02 (Pricing) thread continuously — review monthly, not "shipped once." Spec 24 beyond task-0 CI (rollback playbook, secrets rotation) trails through the year as ops matures.

---

## Conventions used across specs

- **Spec structure**: Why → Current State → Target State → Implementation Tasks → Acceptance Criteria → Metrics → Risks → Dependencies.
- **Migration numbering**: Each spec proposing schema work claims a number; current head is **042**, next is **043**. Reserve numbers in spec body. If two specs land in parallel, the second one renumbers — coordinate via the PR description.
- **Code anchors**: Every spec links to relevant files (`worker/`, `src/`, `supabase/migrations/`, `docs/runbooks/`) so an implementer doesn't start from a blank page.
- **Cross-links**: Specs reference each other by relative path. Search any spec for `[Spec NN]` to find related work.

---

## Maintenance

- Update a spec's **Current State** when its referenced code changes materially.
- Mark **Acceptance Criteria** done in the spec PR that closes them.
- When a new readiness gap appears, decide: extend an existing spec or create a new one numbered 30+.
- Annual review: founder reads every spec and updates as needed.

---

## Source

These specs synthesize and operationalize the answers in [`../saas_readiness_questions_for_repworth.md`](../saas_readiness_questions_for_repworth.md) — the prescriptive "best answer" doc that motivated this folder. The question doc is the **why**; this folder is the **how**.
