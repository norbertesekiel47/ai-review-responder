# Spec 26 — Financial Operations

> **Goal:** Track MRR / NRR / GRR / CAC / payback / gross margin monthly, ≥ 75% gross margin target, ProfitWell as the SaaS-metrics spine, cohort by acquisition channel, 18-month runway model in 3 scenarios.

---

## 1. Why this matters

Bootstrapped SaaS lives on cash. Without monthly financial discipline, the founder learns about churn three months after it happened. Gross margin below 75% means AI/hosting/Stripe is eating the business and you need to act early.

## 2. Current state (RepWorth)

- Stripe-first billing with hardened reconciliation contract.
- Multi-location billing shipped.
- No documented MRR / ARR / NRR dashboard.
- No documented gross-margin tracking (AI cost vs. revenue).
- No financial model.

## 3. Target state

### Core SaaS metrics (monthly)
**Bare minimum dashboard:**
| Metric | Definition | Source |
|---|---|---|
| MRR | Σ active subscription MRR | Stripe + recurring overage |
| ARR | MRR × 12 | Derived |
| New MRR | First-time customers this month | Stripe |
| Expansion MRR | Upgrades / location adds / overage growth | Stripe + DB |
| Churned MRR | Cancellations this month | Stripe |
| Contraction MRR | Downgrades / location removals | Stripe |
| **Net New MRR** | New + Expansion − Churn − Contraction | Derived |
| **NRR** | (MRR_prior_cohort + Expansion − Contraction − Churn) / MRR_prior_cohort | Cohort analysis |
| **GRR** | (MRR_prior_cohort − Contraction − Churn) / MRR_prior_cohort | Cohort analysis |
| CAC | Marketing + sales cost ÷ new customers | Spend trackers + Stripe |
| CAC payback | Months to recover CAC from gross margin | Derived |
| Gross margin | Revenue − COGS (hosting + AI + Stripe + email + SMS) | Stripe + cloud bills |

### Tooling
- **ProfitWell** (free, by Paddle) — MRR, churn, expansion automatically calculated from Stripe.
- **Stripe Sigma** — ad-hoc SQL queries against Stripe data.
- **Chargebee/Maxio** — only if you outgrow Stripe billing logic (unlikely for SMB).

### COGS detail
Track monthly in `docs/finance/cogs-YYYY-MM.md`:
- Supabase hosting + DB
- Railway worker hosting
- Vercel hosting
- Upstash Redis (cache + queue)
- OpenAI + Anthropic API
- Stripe fees (2.9% + $0.30 per transaction)
- Resend
- Twilio (SMS)
- Sentry, PostHog (if paid), Help Scout, Loops

### Gross margin target
- **≥ 75%.**
- **< 60% per-customer** → margin alert; intervene with prompt-shrink, rate-limit, or tier upsell ([Spec 22](./22-ai-llm-ops.md)).

### Cohort analysis
- Cohort by signup month + acquisition channel (organic, paid Google, paid Meta, referral, partner).
- Retention curves per cohort + per channel in **PostHog** or **ProfitWell**.
- Critical for double-down decisions on marketing spend.

### Revenue recognition
- **Recognize ratably over the subscription period**, not at invoice date.
- Stripe Revenue Recognition handles deferred revenue automatically (enable in Stripe dashboard).
- Otherwise: QuickBooks or your accountant.
- Annual plans: defer revenue across 12 months.

### Financial model (3 scenarios)
- **Conservative**: 5% monthly growth, 4% monthly churn, 60% gross margin.
- **Base**: 10% monthly growth, 2% monthly churn, 75% gross margin.
- **Ambitious**: 15% monthly growth, 1% monthly churn, 80% gross margin.
- Inputs: MRR growth rate, churn, gross margin, opex burn, runway months.
- Tool: **Causal**, **Finmark**, or a clean spreadsheet (`finance/model.xlsx`).
- **Bootstrapped target: profitability before $0 runway.**
- Update monthly.

### Burn multiple
- (Net Burn) / (Net New ARR).
- Target < 1 for healthy growth.
- Investor proxy if you ever raise.

### Bookkeeping
- **QuickBooks Online** or **Xero** for monthly close.
- Bank + Stripe sync.
- 1099 / W-2 / sales tax automated by accountant from book of record.

### Tax compliance
- **Sales tax**: Stripe Tax handles 50 US states + EU + UK + AU + CA ([Spec 05](./05-billing-subscription.md)).
- **Income tax**: accountant files annually.
- **Quarterly estimated tax** if revenue > threshold.

## 4. Implementation tasks

1. Subscribe ProfitWell. Connect to Stripe.
2. Subscribe Stripe Sigma (or use free 60-day trial if available).
3. Build monthly metrics dashboard in ProfitWell + Stripe Sigma. Bookmark.
4. Author `docs/finance/cogs-template.md` and start tracking monthly.
5. Compute gross margin monthly. Alert if < 70% (warning) or < 60% (action).
6. Build cohort analysis in PostHog or ProfitWell. Per-channel retention curves.
7. Enable Stripe Revenue Recognition (in Stripe dashboard, after lawyer reviews accounting impact).
8. Build 3-scenario financial model in Causal or spreadsheet. Update monthly.
9. Set up QuickBooks or Xero. Connect bank + Stripe. Monthly close cadence.
10. Hire fractional CFO / bookkeeper at $10–20k MRR.

## 5. Acceptance criteria

- [ ] ProfitWell dashboard live with MRR / NRR / GRR / churn auto-tracking.
- [ ] Monthly COGS recorded in `docs/finance/cogs-YYYY-MM.md` for 3 consecutive months.
- [ ] Gross margin computed monthly; ≥ 75% target met or remediation plan in place.
- [ ] Cohort analysis renders per-channel retention curves.
- [ ] 3-scenario financial model exists and is updated monthly.
- [ ] Stripe Revenue Recognition configured (if applicable).
- [ ] QuickBooks/Xero connected; first monthly close completed.

## 6. Metrics

| Metric | Target |
|---|---|
| Gross margin | ≥ 75% |
| NRR | ≥ 100% within 12 months |
| GRR | ≥ 85% |
| CAC payback | ≤ 4 months |
| Burn multiple (if raising) | < 1.0 |
| Runway (model base case) | ≥ 18 months at all times |
| Financial-model update cadence | Monthly |

## 7. Risks & mitigations

- **Risk:** Gross margin compressed by LLM cost on heavy customers. **Mitigation:** per-customer cost monitor ([Spec 22](./22-ai-llm-ops.md)); rate-limit or upsell.
- **Risk:** Stripe Revenue Recognition mis-configured creates deferred-revenue audit issue. **Mitigation:** accountant reviews setup; reconcile quarterly.
- **Risk:** Founder under-estimates burn. **Mitigation:** monthly model update + 3-scenario discipline.

## 8. Dependencies & cross-links

- [Spec 02 — Pricing](./02-pricing-packaging.md) (per-location ARPL, overage)
- [Spec 05 — Billing](./05-billing-subscription.md) (Stripe-first, reconciliation, Stripe Tax)
- [Spec 11 — Data, Analytics & BI](./11-data-analytics-bi.md) (cohort by channel)
- [Spec 14 — Customer Success](./14-customer-success-retention.md) (NRR drivers)
- [Spec 16 — Marketing & Growth](./16-marketing-growth.md) (CAC by channel)
- [Spec 22 — AI/LLM Operations](./22-ai-llm-ops.md) (cost per response → gross margin)
- Code anchors: Stripe-first contract per `worker/ingress/stripe.ts`, outbox pattern
