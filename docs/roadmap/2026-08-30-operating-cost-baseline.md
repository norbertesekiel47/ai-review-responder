# Operating cost baseline (2026-08-30)

Every external service RepWorth pays for, what it costs, and what that implies
for break-even. Costs were priced by the owner on 2026-08-30 and seeded into
the expense tracker the same day.

**This document is a snapshot for decision-making. The tracker is the live
register.** When the two disagree, the tracker wins — update this file from it,
not the other way round.

- **Live register:** <https://repworth-expense-tracker.vercel.app/>
- **Tracker repo:** `norbertesekiel47/repworth-expense-tracker`
- **Seed source of truth:** `scripts/seed-data.mjs` in that repo (PR #1)
- **Vendor bill template:** `docs/finance/cogs-template.md`
- **Margin assumptions:** `docs/finance/model.md`
- **Service → env-var map:** `docs/eservices-variables.md`

---

## 1. Headline

| Measure | Amount |
|---|---|
| Total monthly equivalent | **$729.17** |
| True fixed floor (zero customers) | **$399.17** |
| Usage-dependent | **$330.00** |
| Of which is an operator-set **cap**, not a bill | **$220.00** |
| Current-month recorded spend (August 2026) | $830.00 |

The $830 figure is higher than $729.17 because two annual charges (Zoho $60,
GoDaddy $50) were seeded with a 2026-08-30 purchase date and land wholly in
August. Correcting those dates from the invoices drops August to about $720.

**$729.17 is a ceiling, not a bill.** $220 of it — OpenAI at $100 and Upstash
at $120 — are spend limits the owner set, not invoices received. Replace both
with actuals once real bills land.

---

## 2. Full service inventory

32 services. Amounts are monthly equivalents; annual charges are divided by 12.

**Confidence** — `actual` = known invoice or plan price; `estimate` = upper
bound of a band the owner gave; `cap` = an operator-set spend ceiling.

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
| ChatGPT / Codex | $20.00 | subscription | actual | Plus. Powers the `codex-rescue` agent. |
| 21st.dev | $20.00 | subscription | estimate | UI component MCP. |
| Infisical | $0.00 | — | actual | Free tier. Secrets, set up in WS8 preflight. |
| Firecrawl | $0.00 | — | actual | Lapsed or free. Research output in `.firecrawl/`. |

### Marketing & media (6350) — $35.00

| Service | Monthly | Model | Confidence | Note |
|---|---|---|---|---|
| Runway | $35.00 | subscription | actual | Pro. Adopted 2026-08-30 to replace Higgsfield. |
| Higgsfield | $0.00 | — | cancelled | Superseded by Runway. Archive once the last invoice clears. |

### Payments (6300) and Legal (6400) — $0.00

| Service | Monthly | Model | Confidence | Note |
|---|---|---|---|---|
| Stripe | $0.00 | usage | actual | Percentage of processed revenue. Costs nothing until revenue starts. |

---

## 3. Rollups

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

### Fixed floor vs usage-dependent

| | Monthly | Contents |
|---|---|---|
| Fixed platform | $124.17 | Vercel, Railway, Supabase, Resend, Sentry, Zoho, GoDaddy, GitHub |
| Fixed overhead | $275.00 | Claude Code, ChatGPT, 21st.dev, Runway |
| **True floor** | **$399.17** | Paid whether or not anyone signs up |
| Usage-dependent | $330.00 | OpenAI, Upstash, Zernio, Maps, Anthropic, PostHog |
| **Ceiling total** | **$729.17** | |

**Two observations that matter.**

1. **Developer tooling is 69% of the fixed floor.** $275 of $399.17 is Claude
   Code, ChatGPT, 21st.dev and Runway. The entire production platform —
   hosting, database, worker, email, error tracking — costs $124.17. That
   ratio is normal for a pre-revenue solo founder and it is the largest lever
   the owner controls. It is **not** COGS and never enters gross margin.
2. **Only ~$190/month scales with customers** — Zernio, the two LLMs, and
   Maps. Marginal cost per location is cents, not dollars: a draft on
   `gpt-4o-mini` costs a fraction of a cent, and Zernio is the only material
   per-review unit cost. **The constraint is the fixed floor, not COGS.**

---

## 4. Break-even

Customers needed to cover the **$399.17 fixed floor**, ignoring the small
marginal COGS per location. Prices are per account with one location included
(`TIER_CONFIG`, `src/lib/accounts/tier-config.ts`).

| Tier and price | Status | Customers to break even |
|---|---|---|
| Copilot $19 | founding, shipped | **22** |
| Copilot $29 | list, shipped | **14** |
| Autopilot $49 | founding, shipped | **9** |
| Autopilot $69 | list, shipped | **6** |

Against the **platform floor only** ($124.17, excluding developer tooling),
Copilot at $29 list breaks even at **5 customers**.

---

## 5. Competitive price context

From the owner's own research, `.firecrawl/reviewflowz-comparison.md`
(retrieved 2026-08). Per location per month:

| Competitor | Price |
|---|---|
| Podium | ~$450 |
| Birdeye | $299–349 |
| Reputation.com | $299+ |
| Reviewflowz | $80 (1 profile), $120 (3), $350 (10) |
| RightResponse.AI | $8 headline, **~$70 real** at 150 reviews/month (credit-based) |
| Grade.us "Grow" | $59 |

RepWorth ships at **Copilot $29 list / $19 founding**, **Autopilot $69 list /
$49 founding**. The cheapest credible competitor is roughly twice the Copilot
list price; Birdeye is about twelve times it.

RightResponse.AI is the cautionary case: an $8 headline that reaches ~$70
through opaque credits. The adopted pricing thesis (hybrid base + usage,
outcome credits only once attribution is defensible) explicitly rejects that
opacity.

---

## 6. Outstanding corrections

Fix these in the tracker, then update this file.

1. **Zoho and GoDaddy purchase dates.** Both annual, both seeded with
   2026-08-30, which puts $110 of annual charges into August. Correct from the
   invoices. Forecast burn is unaffected.
2. **GoDaddy amount.** Seeded at $50/year as the upper bound of a band.
   Correct from the renewal invoice.
3. **18 missing receipts.** Every seeded row lacks a receipt URL and invoice
   number, so Accounting flags all 18. Expected, not a fault.
4. **Replace the two caps with actuals.** OpenAI ($100) and Upstash ($120) are
   ceilings. Once real invoices land, the $729.17 ceiling should fall
   materially.
5. **Sentry** was purchased on 2026-08-30 and is recorded at $26 on that
   assumption. Confirm against the first invoice.

---

## 7. Known documentation gaps (still open)

Found during the 2026-08-30 service audit, not yet fixed:

1. **`docs/legal/sub-processors.md` does not list PostHog.** It is read by
   production code and named in the launch checklist. This is a compliance
   gap, not a documentation gap.
2. **`docs/eservices-variables.md` §1 says Upstash runs the BullMQ queue.**
   It runs the cache. Railway Redis runs the queue — `CLAUDE.md` and
   `REDIS_QUEUE_URL` are correct; that table row is stale.
3. **`docs/finance/cogs-template.md` has no row for Zernio, Stripe, or Google
   Maps.** Zernio is a core variable cost, so its absence understates COGS.
   The template also predates the 11-category scheme the tracker now uses.

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

## 9. How to refresh this document

1. Open the tracker and read Dashboard → forecast burn, plus Budgets.
2. Export CSV from Accounting for the per-row detail.
3. Update §2, §3 and §4 here. Note the date in the title.
4. If a service is added or dropped, update `scripts/seed-data.mjs` in the
   tracker repo **and** `docs/eservices-variables.md` §1 in this repo, so the
   service map and the cost register do not drift.
