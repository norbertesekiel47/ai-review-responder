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

## Prioritization framework

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

If you have a quarter and want to maximize readiness:

| Quarter | Theme | Specs to ship |
|---|---|---|
| **Q1** | Foundation | 03, 05, 07, 09, 17, 29 (gaps 1, 2, 5) |
| **Q2** | Activation + Growth seeds | 06, 13, 14, 16 |
| **Q3** | Scale + API + Mobile | 12, 20, 21, 22 |
| **Q4** | Maturity + Polish | 08, 11, 18, 19, 23, 24, 25, 26, 27, 28 |

Specs 01 (PMF) and 02 (Pricing) thread continuously — review monthly, not "shipped once."

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
