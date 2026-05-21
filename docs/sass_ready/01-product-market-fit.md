# Spec 01 — Product–Market Fit & Positioning

> **Goal:** Lock one sharp ICP, one JTBD, three defensible wedges, and a measurable activation event so every roadmap argument has a single tribunal.

---

## 1. Why this matters

RepWorth competes with Birdeye, Podium, NiceJob, and GoSite — all better funded. Without a focused ICP and a documented JTBD, every feature request bends the roadmap and dilutes the wedge. PMF is the moat that makes pricing, support, and retention work; without it, all later specs leak.

## 2. Current state (RepWorth)

- Public marketing exists (landing page redesigned 2026-04-18) but no `docs/icp.md`.
- Pricing pages and onboarding emphasize the AI feature, not the JTBD.
- No `activation_completed` event in analytics; no retention cohort split.
- Multi-location billing shipped (PR #28) — proves the multi-location wedge is real today.

## 3. Target state

**ICP (one, written, pinned):** Multi-location service SMBs, 2–25 locations, non-technical owner-operator or marketing manager. Verticals: dental groups, medspas, auto-service chains, salon groups, fitness studios. Decision-maker title: Owner / Director of Operations / Head of Marketing. Top pains: missed reviews, inconsistent voice across locations, fear of public mistakes.

**JTBD (one sentence, repeated verbatim across H1, pricing value prop, onboarding success screen):**
> "Never miss a review. Never publish a bad response."

**Three wedges (ranked, each on the comparison page with proof):**
1. **Approval-first architecture** — every response requires explicit owner sign-off; cryptographic audit trail. Competitors auto-post.
2. **Multi-location-native at SMB prices** — incumbents charge enterprise rates per location.
3. **Best-in-class brand voice tuning per location** — example-shot from owner's past replies.

**Activation event (instrumented, primary north-star input):**
> `activation_completed` = first approved + published response within 7 days of signup.

## 4. Implementation tasks

1. Create `docs/icp.md` with: verticals, employee count, location count, current tooling, decision-maker title, top 3 pains, top 3 cancellation reasons (start empty, fill from interviews). Pin it.
2. Update H1 on `src/app/page.tsx` (landing) + pricing value prop + onboarding success screen to use JTBD verbatim.
3. Add comparison page `src/app/compare/page.tsx` with three-wedge table vs. Birdeye, Podium, NiceJob, GoSite. Cite approval audit + per-location pricing + brand voice as proof.
4. Instrument `activation_completed` in PostHog. Emit when `responses.published_at IS NOT NULL` and `published_at - users.created_at <= INTERVAL '7 days'`. Backfill from existing data.
5. Build a 4-metric retention dashboard (PostHog or Metabase): trial → paid %, monthly logo retention, 90-day logo retention, activation rate.
6. Public changelog at `/changelog` (markdown-rendered from `docs/changelog/*.md`). Public "what's next" page with three buckets: shipping / exploring / considering (no dates).
7. Standing weekly customer interview cadence: target 5 conversations/week. Track answers in CRM custom field `top_cancellation_risk`.

## 5. Acceptance criteria

- [ ] `docs/icp.md` exists and is referenced in every roadmap proposal PR template.
- [ ] JTBD string appears identically on landing H1, pricing page, onboarding success — verified by snapshot test.
- [ ] PostHog event `activation_completed` firing in production with ≥ 95% accuracy (manual spot-check 20 accounts).
- [ ] Retention dashboard live and bookmarked; reviewed every Monday.
- [ ] Public `/changelog` deployed and linked from footer.
- [ ] Trial → paid ≥ 15%, 30-day retention ≥ 90% within 6 months of measurement start. If below, ICP and JTBD revisited.

## 6. Metrics

| Metric | Target | Source |
|---|---|---|
| Trial → paid | 15–25% | Stripe + PostHog |
| 30-day logo retention | ≥ 90% | PostHog cohorts |
| 90-day logo retention | ≥ 75% | PostHog cohorts |
| 12-month logo retention | ≥ 70% | Stripe MRR cohort |
| `activation_completed` rate (signups within 7 days) | ≥ 50% | PostHog |
| Customer interviews/week | ≥ 5 | CRM custom property |

## 7. Risks & mitigations

- **Risk:** ICP drift via opportunistic single-location deals. **Mitigation:** every deal logged with ICP-fit score 1–5; quarterly review on <3 churns.
- **Risk:** Activation event poorly correlated with retention. **Mitigation:** re-derive activation if lift < 2× after 50 activated accounts.
- **Risk:** Competitor responds by adding approval flow. **Mitigation:** double down on wedge #2 (multi-location-native pricing) — harder to copy without cannibalizing their enterprise revenue.

## 8. Dependencies & cross-links

- [Spec 06 — Onboarding & Activation](./06-onboarding-activation.md) (owns activation flow instrumentation)
- [Spec 11 — Data, Analytics & BI](./11-data-analytics-bi.md) (event taxonomy, cohort math)
- [Spec 14 — Customer Success & Retention](./14-customer-success-retention.md) (interview cadence)
- [Spec 16 — Marketing & Growth](./16-marketing-growth.md) (changelog, comparison page)
