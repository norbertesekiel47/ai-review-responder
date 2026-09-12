# Operating cost baseline — August 30 snapshot

**Interpretation refreshed 2026-09-07; vendor amounts remain the owner's
2026-08-30 snapshot.** The owner priced this service inventory and reported
seeding it into the expense tracker that day. No September invoices, bank
balances or tracker records were inspected for this refresh.

**September 11 strategy annotation:** vendor amounts and their verification
dates are unchanged. For a selected operator experiment, the
[CFO delivery-cost task](2026-09-08-founder-90-day-plan/cfo/README.md#cfo-08--measure-full-delivery-cost-and-test-the-subscription-economics)
owns the current model for planning/context calls, failed attempts, founder
rescue and cost per correctly completed delegated job. Record it in the
canonical CFO register, with setup/ongoing work and cash/imputed labor
separated. This historical snapshot is not a second live pilot-cost ledger.

This is a service-budget snapshot, not complete company burn, cash on hand or
a runway calculation. The tracker is the intended live register; reconcile
it with invoices and payment evidence before updating actual amounts here.

- **Live register:** [Expense tracker](https://repworth-expense-tracker.vercel.app/)
- **Tracker repo:** `norbertesekiel47/repworth-expense-tracker`
- **Seed source of truth:** `scripts/seed-data.mjs` in that repo (PR #1)
- **Vendor bill template:** `docs/finance/cogs-template.md`
- **Margin assumptions:** `docs/finance/model.md`
- **Service → env-var map:** `docs/eservices-variables.md`

---

## 1. What the snapshot shows

| Measure | Amount |
|---|---|
| Mixed monthly equivalent: plans, estimates and caps | **$729.17** |
| Subscription/annual-service allowance, including estimates | **$399.17** |
| Usage-dependent allowance | **$330.00** |
| Of which is an operator-set **cap**, not a bill | **$220.00** |
| August seeded spend reported on August 30; not invoice-verified here | $830.00 |

The original record attributed the $830 figure to two annual charges (Zoho
$60, GoDaddy $50) seeded with an August 30 purchase date. Their actual payment
dates and any tracker correction remain unverified. Do not substitute a
recalculated monthly equivalent for cash paid in August.

**$729.17 is neither a bill nor a global spending ceiling.** $220 of it —
OpenAI at $100 and Upstash at $120 — represents owner-reported limits, not
invoices. Their current enforcement was not checked. Other usage, overages,
missing expenses and timing can change cash needs. Actual cash, required
funding amount and cash-needed date are still unknown.

---

## 2. Full service inventory

32 services in the August 30 inventory. Amounts are monthly equivalents;
annual charges are divided by 12. Every plan, deployment state and operational
note in this section is historical unless separately verified below.

**Original confidence labels retained:** `actual` = owner-reported invoice or
plan price, not proof of payment reviewed here; `estimate` = owner-supplied
allowance; `cap` = reported operator limit, not a measured bill or proof of a
hard provider cutoff.

### AI (6220) — $120.00

| Service | Monthly | Model | Confidence | Note |
|---|---|---|---|---|
| OpenAI | $100.00 | usage | **cap** | Primary LLM (`gpt-4o-mini`) + Moderation API. Beta production cap. |
| Anthropic | $20.00 | usage | estimate | Fallback LLM (`claude-haiku-4-5`). Rising spend here means OpenAI is failing over. |

### Infrastructure (6200) — $160.00

| Service | Monthly | Model | Confidence | Note |
|---|---|---|---|---|
| Upstash Redis | $120.00 | usage | **cap** | Cache only. $100 prod + $20 staging caps. Not the queue. |
| Vercel | $20.00 | subscription | actual | Pro, 1 seat. UI only. |
| Railway | $20.00 | subscription | actual | Pro. Worker host. |
| Railway Redis | $0.00 | — | actual | BullMQ queue. Inside the Railway plan credit. |

### Reviews & data (6280) — $70.00

| Service | Monthly | Model | Confidence | Note |
|---|---|---|---|---|
| Zernio | $50.00 | usage | estimate | Review ingest + reply posting. **Core COGS — scales with customers.** |
| Google Maps Platform | $20.00 | usage | estimate | PlaceAutocomplete at onboarding. Essentials tier only. |
| SerpAPI | $0.00 | — | actual | Free tier. Ranking tracking + prefill. |
| Google Sheets API | $0.00 | — | actual | Free quota. Owner-lead mirror. |

### Observability (6240) — $46.00

| Service | Monthly | Model | Confidence | Note |
|---|---|---|---|---|
| Sentry | $26.00 | subscription | actual | Team. Purchased 2026-08-30. `SENTRY_DSN` gates worker boot. |
| PostHog | $20.00 | usage | estimate | **Not yet live** — `POSTHOG_API_KEY` unset in prod. |
| Discord | $0.00 | — | actual | Sentry alert sink, decided 2026-08-30. |

### Data & storage (6230) — $25.00

| Service | Monthly | Model | Confidence | Note |
|---|---|---|---|---|
| Supabase | $25.00 | subscription | actual | One Pro project (prod). Staging on free. |
| Neon | $0.00 | — | actual | Free tier. Hosts the expense tracker, not the product. |

### Messaging (6210) — $20.00

| Service | Monthly | Model | Confidence | Note |
|---|---|---|---|---|
| Resend | $20.00 | subscription | actual | Pro. **One bill covers both** `RESEND_API_KEY` and `SOLICITATION_RESEND_API_KEY`. |
| Twilio | $0.00 | — | actual | WhatsApp parked. No number provisioned, so no rental. |
| Telegram | $0.00 | — | actual | Bot API is free. |
| Help Scout | $0.00 | — | not bought | Launch-checklist blocker. Planned: support@, billing@, security@, report@. |

### Email & domain (6270) — $9.17

| Service | Monthly | Annual | Confidence | Note |
|---|---|---|---|---|
| Zoho Mail | $5.00 | $60.00 | actual | 5 mailboxes. Apex + `feedback.` subdomain. |
| GoDaddy | $4.17 | $50.00 | estimate | Registrar for `repworth.net`. DNS delegated to Cloudflare. |
| Cloudflare | $0.00 | — | actual | DNS. Proxy must stay **off** for mail and sending records. |

### CI & build (6260) — $4.00

| Service | Monthly | Model | Confidence | Note |
|---|---|---|---|---|
| GitHub | $4.00 | subscription | actual | Team, 1 seat. Actions minutes for the light CI jobs. |
| Blacksmith | $0.00 | — | actual | Free tier. Heavy lint/test/build/e2e runners. |

### Developer tools (6250) — $240.00

| Service | Monthly | Model | Confidence | Note |
|---|---|---|---|---|
| Claude Code | $200.00 | subscription | actual | Max 20x. **Largest single line in the register.** Separate from `ANTHROPIC_API_KEY`. |
| ChatGPT / Codex | $20.00 | subscription | actual | August 30 record: Plus, associated with the then-used `codex-rescue` agent. Current plan not rechecked. |
| 21st.dev | $20.00 | subscription | estimate | UI component MCP. |
| Infisical | $0.00 | — | actual | Free tier. Secrets, set up in WS8 preflight. |
| Firecrawl | $0.00 | — | actual | Lapsed or free. Research output in `.firecrawl/`. |

### Marketing & media (6350) — $35.00

| Service | Monthly | Model | Confidence | Note |
|---|---|---|---|---|
| Runway | $35.00 | subscription | actual | Pro. Adopted 2026-08-30 to replace Higgsfield. |
| Higgsfield | $0.00 | — | cancelled | Superseded by Runway. Archive once the last invoice clears. |

### Payments (6300) and Legal (6400) — $0.00 recorded allowance

| Service | Monthly | Model | Confidence | Note |
|---|---|---|---|---|
| Stripe | $0.00 | usage | actual | August allowance with no processing volume. Add applicable transaction, refund/dispute and other charges from actual activity. |

No legal-cost amount was recorded; zero in this inventory does not mean legal
review is free or that the company has no legal obligations.

---

## 3. Historical budget rollups

### By category

| Category | Code | Monthly | Share |
|---|---|---|---|
| Developer tools | 6250 | $240.00 | 32.9% |
| Infrastructure | 6200 | $160.00 | 21.9% |
| AI | 6220 | $120.00 | 16.5% |
| Reviews & data | 6280 | $70.00 | 9.6% |
| Observability | 6240 | $46.00 | 6.3% |
| Marketing & media | 6350 | $35.00 | 4.8% |
| Data & storage | 6230 | $25.00 | 3.4% |
| Messaging | 6210 | $20.00 | 2.7% |
| Email & domain | 6270 | $9.17 | 1.3% |
| CI & build | 6260 | $4.00 | 0.5% |
| Payments, Legal | 6300, 6400 | $0.00 | 0% |
| **Total** | | **$729.17** | |

### Running the product vs overhead

| Group | Monthly | Share |
|---|---|---|
| Running the product | $441.00 | 60% |
| Operational overhead | $288.17 | 40% |

"Running the product" = infrastructure, AI, reviews/data, observability,
data/storage, messaging, payments. "Overhead" = developer tools, marketing
media, domain, mail, CI.

### Subscription/annual allowances vs usage-dependent allowances

| | Monthly | Contents |
|---|---|---|
| Platform service allowance | $124.17 | Vercel, Railway, Supabase, Resend, Sentry, Zoho, GoDaddy, GitHub |
| Tooling/media allowance | $275.00 | Claude Code, ChatGPT, 21st.dev, Runway |
| **Subscription/annual allowance** | **$399.17** | Includes GoDaddy and 21st.dev estimates; not full company cash needs |
| Usage-dependent | $330.00 | OpenAI, Upstash, Zernio, Maps, Anthropic, PostHog |
| **Mixed budget total** | **$729.17** | No global ceiling implied |

**What can and cannot be inferred.**

1. Tooling/media account for $275 of the $399.17 allowance, about 69%.
   Reviewing those costs is useful, but a cut can also reduce delivery
   capacity. The founder approves changes; no cancellation is authorized here.
2. Per-location cost is unknown. LLM inference alone excludes ingestion,
   posting, messaging, retries, hosting, support and founder delivery time.
   Measure activity and reconcile vendor bills before claiming unit margin.
3. Monthly equivalents conceal payment dates. Annual renewals, legal fees,
   founder support, taxes and other obligations must enter the dated cash
   forecast. Do not use this snapshot alone to infer affordable operation.

---

## 4. Pricing inputs and cash coverage

The current [tier configuration](../../src/lib/accounts/tier-config.ts), read
September 7, contains these monthly base amounts with one location included.
These are source values, not a check of active Stripe prices, sales availability
or existing-account billing snapshots. No billing change is made here.

| Tier | List / founding monthly base | Additional location monthly |
|---|---|---|
| Copilot | $29 / $19 | $15 |
| Autopilot | $69 / $49 | $20 |

The earlier “six Autopilot customers break even” calculation only divided
selected service allowances by gross subscription revenue. It was not business
break-even and is withdrawn. Unknown contribution margin prevents a defensible
customer-count break-even estimate.

For planning, net customer contribution = revenue collected − refunds/taxes
owed − payment and delivery costs attributable to that work. Track support
and labor separately, then include their cash obligations once in the company
forecast. Fixed obligations divided by a positive, evidenced average
contribution can inform an operating break-even estimate; tier mix and
collection timing still matter.

The CFO must reconcile opening unrestricted cash, dated receipts, all
outflows, founder support and a chosen reserve. Compare current commitments,
approved lower outflows and conditional financing/paid-pilot cases. Forecast
balance by date = opening cash + cumulative receipts − cumulative outflows.
Uncertain funding stays outside the survival case. The operative decision date
is the earlier company/founder support deadline minus an explicitly chosen
lead-time buffer. Neither its date nor amount can be calculated from this
inventory. Generic growth/churn assumptions in [model.md](../finance/model.md)
are not actual receipts or evidence that continuation is affordable.

---

## 5. Competitive prices: first-party check on September 7

These advertised prices replace the older comparison-blog estimates. Plans
differ in scope, usage, locations, billing period and service obligations;
they are not equivalent bundles or evidence that RepWorth is the cheapest.

| Competitor | What the current public page establishes |
|---|---|
| [TrueReview](https://www.truereview.co/pricing) | Monthly billing: Starter $49, Small Business $99, Premium $299. Annual commitments show lower monthly equivalents. Check included locations/requests before comparing. |
| [NiceJob](https://get.nicejob.com/pricing) | Reviews $75/month and Pro $125/month, USD. The page also carries other website/bundle offers; do not blend their scope or prices. |
| [Birdeye](https://birdeye.com/pricing/) | Pricing form based on business and location information; no numeric package quote verified. |
| [Podium](https://www.podium.com/getpricing) | Custom quote by business/industry; no numeric package quote verified. |

RepWorth's pricing decision should use owner value, willingness to pay and
cost to serve alongside these alternatives. Keep the two supervision choices
and transparent included usage. Outcome fees remain optional hypotheses in
the [investor overlay](2026-08-29-investor-theses-overlay.md), not an adopted
metering commitment. Exact future prices remain open; honor beta and existing
customer agreements.

---

## 6. August tracker reconciliation items — current status unknown

These items were recorded on August 30. The tracker has not been rechecked;
do not label them still open or mark them resolved without evidence.

1. **Zoho and GoDaddy purchase dates.** Both annual, both seeded with
   2026-08-30, which puts $110 of annual charges into August. Correct from the
   invoices. Monthly amortization and actual cash dates serve different purposes.
2. **GoDaddy amount.** Seeded at $50/year as the upper bound of a band.
   Correct from the renewal invoice.
3. **18 missing receipts were reported.** Reconcile actual receipt URLs and
   invoice numbers; the historical count is not today's verified count.
4. **Replace the two caps with actuals.** OpenAI ($100) and Upstash ($120) are
   reported limits. Actual usage could differ; do not predict the total bill
   or assume the mixed budget is an enforceable ceiling.
5. **Sentry** was purchased on 2026-08-30 and is recorded at $26 on that
   assumption. Confirm against the first invoice.

---

## 7. Documentation checks repeated on September 7

The files below were read in this refresh. They are outside this document's
edit scope; a document finding is not proof of current production state.

1. [Sub-processors](../legal/sub-processors.md) still omits PostHog. The
   [launch checklist](../launch-checklist.md) calls for reconfirmation when
   PostHog is live. Production enablement was not checked, so no legal
   compliance conclusion follows from the omission alone. Counsel review of
   the broader package remains recorded as pending.
2. [Service map](../eservices-variables.md) §1 still attributes cache and
   BullMQ to Upstash, while its Redis section correctly separates Upstash
   cache from Railway queue. The sub-processor table also says Upstash
   handles queues; that description needs reconciliation with the architecture.
3. [COGS template](../finance/cogs-template.md) still lacks Zernio, Stripe and
   Google Maps rows. Reconcile these actual costs before using its totals;
   the snapshot's category map alone does not make the template complete.

---

## 8. Category scheme

The tracker's accounting categories, extending the original 62xx technology
block. Use these codes in `cogs-template.md` and any bookkeeping export.

| Category | Code |
|---|---|
| Infrastructure | 6200 |
| Messaging | 6210 |
| AI | 6220 |
| Data & storage | 6230 |
| Observability | 6240 |
| Developer tools | 6250 |
| CI & build | 6260 |
| Email & domain | 6270 |
| Reviews & data | 6280 |
| Payments | 6300 |
| Marketing & media | 6350 |
| Legal | 6400 |

---

## 9. How to refresh amounts and make cash decisions

1. Read the tracker and obtain owner-approved invoice/payment evidence. Keep
   raw financial records private; record sanitized amounts, dates and sources.
2. Reconcile service usage, caps, receipts and credits; distinguish annual
   amortization from each actual payment date. Add missing company obligations.
3. Update this snapshot with a new verification date and explain changed
   assumptions. Do not overwrite historical estimates as though they were bills.
4. Prepare current, lean and conditional-cash cases; rank real funding paths
   by evidenced clearing dates. Signed pilots and term sheets are not cash.
5. CFO presents cash decisions in week 1 and at day 7/day 14, or sooner
   if required. Ask before spending, contacting anyone, changing services or
   seeking revised terms. Approved changes to the tracker/service map are
   separate actions; no such changes occurred in this refresh.
