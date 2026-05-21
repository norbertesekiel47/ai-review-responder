# Spec 15 — Sales & Go-to-Market Operations

> **Goal:** PLG primary, sales-assisted for multi-location, founder-led demos until volume forces hiring. CRM = HubSpot Starter or Attio. Demo environment that resets nightly. Sales collateral that doesn't suck.

---

## 1. Why this matters

The GTM motion must match ACV. RepWorth's ICP is multi-location SMBs at $89–$149/location/month — that's $300–$3000/mo per customer, sitting in the sales-assisted zone. Pure self-serve loses revenue on enterprise; pure sales-led burns founder hours on $49 deals.

## 2. Current state (RepWorth)

- Marketing site + signup live.
- Multi-location billing shipped.
- No CRM visible.
- No demo environment.
- No partner / agency program.
- Owner lead intake exists (`docs/plans/2026-05-06-owner-lead-intake-design.md`).

## 3. Target state

### Motion segmentation (by ACV)
| ACV (monthly) | Motion | Funnel |
|---|---|---|
| < $100 (1 location, Starter) | Pure PLG | self-serve trial → paid |
| $100–$500 (Growth, 2–10 locations) | Sales-assisted | demo + onboarding call optional |
| $500–$2000 (Scale, 10–25 locations) | Sales-led | demo + custom call + onboarding + CSM |
| $2000+ (enterprise, 25+ locations) | Custom deal | deal desk, custom contract |

### CRM
- **HubSpot Starter ($20/mo)** for first 100 customers — best free CRM + email tracking + lifecycle stages.
- Alternative: **Attio** if you prefer modern UX (also $0–29/mo to start).
- Stripe → HubSpot sync via Zapier or native integration:
  - Lifecycle stage: `lead` → `trial` → `paid` → `churned`.
  - Properties synced: MRR, plan, locations, last_login, churn_date.

### Lead scoring (rules-based; defer until > 100 leads/mo)
- Locations > 5 → SQL
- Time on `/pricing` > 60s → MQL
- Trial active + activation_completed → SQL
- Trial active + no activation by day 7 → MQL with intervention

Until then: every demo request hand-qualified; every trial monitored manually.

### Demo environment
- **`demo.repworth.com`** with nightly reset Cron (Railway scheduler).
- Pre-seeded: 3 example businesses (Acme Dental, Sparkle Salon, FitWell Studio), 50 reviews across the 1–5 star spectrum, sample responses.
- Tag every demo session with prospect email (HubSpot property + UTM).
- "Book a demo" CTA on pricing page → Calendly → automated demo-link email with seeded prospect's name pre-filled.

### Sales collateral
| Asset | Format | Update cadence |
|---|---|---|
| One-pager | PDF, 1 page | Quarterly |
| Demo deck | Slides, 10 max | Quarterly |
| ROI calculator | Google Sheet (later: in-product widget) | Per pricing change |
| Case studies | 3 minimum (anonymous early), each a 1-page PDF | New every quarter |
| Comparison vs. Birdeye / Podium / NiceJob / GoSite | Web page + PDF | Per pricing change |

Stored in Notion or a `sales-enablement/` folder in repo + linked from `docs/sales/`.

### Partner / agency program
- **Not until 10 inbound partner asks.** Then:
  - 20% recurring commission for first 12 months.
  - Partner portal with reporting (Rewardful or PartnerStack).
  - Co-branded landing pages.
  - White-label option at Scale tier ($X premium).
- Likely fastest growth lever once PMF is proven — agencies serve dozens of SMBs.

### Sales-process basics (founder-led)
- Demo prep: read CRM record before the call, identify ICP fit.
- Demo agenda: pain probe (5 min) → 3-step product walk (15 min) → pricing + objection handle (5 min) → next steps (5 min).
- Follow-up: thank-you within 24h, recap email, two-touch nurture cadence.
- Loss tracking: every lost deal logged with reason — feeds product roadmap.

### Deal desk
- For any custom pricing / annual prepay / contract redlines → `docs/sales/deal-desk.md` runbook.
- Founder-approved until $50k MRR.

## 4. Implementation tasks

1. Subscribe HubSpot Starter or Attio. Configure pipeline stages + properties.
2. Wire Stripe → HubSpot via Zapier; sync lifecycle stage + MRR + plan.
3. Build `demo.repworth.com` with nightly reset:
   - New subdomain in Vercel.
   - Seeded fixture in `scripts/seed/demo-environment.ts`.
   - Cron in Railway scheduler resets at 03:00 UTC.
4. Build "Book a demo" Calendly integration. Capture UTM + email.
5. Author one-pager, demo deck, ROI calc, first 3 case studies (anonymous).
6. Build comparison page (`src/app/compare/page.tsx`) — overlaps with [Spec 01](./01-product-market-fit.md) wedge framing.
7. Write `docs/sales/deal-desk.md` for first 5 enterprise deals.
8. Wire owner-lead intake design (already designed) into HubSpot pipeline.
9. Set lifecycle-stage automation: trial-day-3 / trial-day-12 / day-1-paid triggers founder nudge in HubSpot.

## 5. Acceptance criteria

- [ ] HubSpot or Attio live with pipeline + Stripe sync.
- [ ] `demo.repworth.com` resets nightly; pre-seeded data renders.
- [ ] Calendly demo flow active; first 5 demos completed with CRM records.
- [ ] One-pager, deck, ROI calc, 3 case studies, comparison page all published.
- [ ] Deal desk runbook tested on 1 enterprise prospect.
- [ ] Loss tracking field populated for last 10 lost deals.

## 6. Metrics

| Metric | Target |
|---|---|
| Demo → trial conversion | ≥ 50% |
| Trial → paid (sales-assisted) | ≥ 30% (vs. 15–25% PLG) |
| Loss reason logged | 100% |
| Founder time on demos / week | Capped (cap forces hiring decision) |
| Case study velocity | 1 new per quarter |

## 7. Risks & mitigations

- **Risk:** Founder demo overload caps growth. **Mitigation:** monitor weekly demo count; first SDR/AE hire trigger when > 10 demos/week sustained.
- **Risk:** Demo environment data leaks between prospects. **Mitigation:** nightly reset + session-scoped prospect data only in CRM.
- **Risk:** Partner program built too early. **Mitigation:** firm "10 inbound asks" gate before building.

## 8. Dependencies & cross-links

- [Spec 01 — PMF](./01-product-market-fit.md) (comparison page)
- [Spec 02 — Pricing & Packaging](./02-pricing-packaging.md) (Contact Sales path)
- [Spec 06 — Onboarding](./06-onboarding-activation.md) (demo environment)
- [Spec 14 — Customer Success](./14-customer-success-retention.md) (QBRs)
- [Spec 16 — Marketing & Growth](./16-marketing-growth.md) (paid acquisition, attribution)
- Code anchors: `docs/plans/2026-05-06-owner-lead-intake-design.md`
