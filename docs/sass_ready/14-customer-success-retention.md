# Spec 14 — Customer Success & Retention

> **Goal:** Composite health score, quarterly NPS + per-interaction CSAT, five lifecycle email sequences, QBRs for top accounts, Canny for voice-of-customer, save-rate ≥ 20% on cancellation.

---

## 1. Why this matters

Acquiring is expensive; retaining compounds. SMB SaaS lives or dies on monthly logo retention and expansion within multi-location accounts. The wedge ("never miss a review") only delivers value if the customer keeps logging in.

## 2. Current state (RepWorth)

- Owner dashboard redesigned (PR #27) — engagement surface.
- No documented health-score logic.
- No NPS / CSAT cadence.
- No lifecycle email sequences (only transactional via Resend).
- Cancellation flow not yet built (see [Spec 05](./05-billing-subscription.md)).

## 3. Target state

### Health score (composite, 0–100)
Inputs (weighted):
| Input | Weight | Source |
|---|---|---|
| Logins in last 14 days | 25% | PostHog session events |
| Responses approved in last 30 days | 25% | `responses.approved_at` |
| Review volume trend (rolling 4-week vs. prior 4-week) | 15% | `reviews.created_at` |
| NPS most-recent | 15% | Survey table |
| Support ticket sentiment (last 30 days) | 10% | Help Scout tag + sentiment |
| Tenure (older = lower decay penalty) | 10% | `accounts.created_at` |

Score < 40 = at-risk → flagged for intervention (founder ping, save call offer).
Score 40–70 = neutral → keep nurturing.
Score > 70 = champion → ask for referral, case study, expansion.

Implementation: nightly worker `worker/background/schedulers/health-score-scheduler.ts` writes to `account_health(account_id, score, computed_at, components JSONB)`.

### NPS / CSAT
- **NPS quarterly** via in-product modal (Delighted if budget allows; otherwise hand-rolled).
- Target: ≥ 40 for SMB SaaS.
- Follow up on **every detractor personally** for the first 12 months.
- **CSAT** after every support interaction (Help Scout built-in survey).
- Target ≥ 90%.

### Lifecycle email sequences
Implement in **Loops** or **Customer.io** (separate from Resend transactional).

| Sequence | Trigger | Cadence |
|---|---|---|
| Welcome | signup_started | 5 emails over 14 days |
| Activated | activation_completed | 3 emails over 30 days (product depth) |
| At-risk | health_score < 40 for 14 consecutive days | 3 emails over 14 days |
| Win-back | subscription_canceled | 30-day, 60-day, 90-day touches |
| Milestone | response count = 100, 500, 1000; tenure = 6mo, 1yr, 2yr | One-off celebrations |

Each sequence has its own copy doc in `docs/lifecycle/sequences/*.md`. Open/click/reply rates tracked in Loops + back into PostHog via webhook.

### Quarterly Business Reviews (QBRs)
- For accounts > $500/mo MRR.
- Format: 30-min Zoom + slide deck with 4 sections:
  1. Value delivered: responses published, time saved, $ value (using $X/hour assumption × hours saved).
  2. Health: review volume trend, response rate trend.
  3. Roadmap preview (what's shipping, what's exploring).
  4. Listening: any blockers, expansion signals.
- Notes captured in `crm/accounts/<account-id>/qbr-YYYY-Qx.md` (or Notion).
- Founder-led until first CSM hire.

### Voice-of-customer
- **Canny.io** for public feature requests + roadmap voting.
- Linked from in-app "Suggest a feature" button.
- Roadmap = Canny votes + interview themes + strategic bets (weighted, owner judges).
- Close-the-loop publicly on ship: "This was suggested by @customer in March — here it is."

### Cancellation save flow
- See [Spec 05](./05-billing-subscription.md). Target save-rate ≥ 20%.
- Save prompts: pause 60 days / downgrade tier / talk to founder.
- Required exit survey: reason, what-would-have-changed-mind, NPS at cancel, can-we-contact-in-6-months.

### Win-back program
- 30-day post-churn: "We made these changes since you left" (changelog).
- 60-day: founder personal email asking for feedback.
- 90-day: 30% off 3 months offer (Promotion Code).
- Track win-back rate.

## 4. Implementation tasks

1. Migration **049**: `account_health(account_id, score INT, components JSONB, computed_at)`. Indexed on `score`.
2. Build `HealthScoreScheduler` in `worker/background/schedulers/`. Runs nightly at 03:00 UTC. Computes per-account.
3. Build Settings → Admin → Health dashboard (founder-only) listing at-risk accounts sorted by score ascending.
4. Subscribe Loops or Customer.io. Wire 5 lifecycle sequences. Author copy.
5. Build NPS modal: triggers quarterly per user, dismissable, response stored in `nps_responses` table. Migration **050**.
6. Wire Help Scout CSAT survey.
7. Subscribe Canny. Embed widget at `src/app/dashboard/feedback/page.tsx`.
8. Build QBR template + scheduling Calendly workflow for > $500 MRR accounts.
9. Author `docs/lifecycle/sequences/*.md` for each sequence.
10. Author `docs/cs/qbr-template.md`.

## 5. Acceptance criteria

- [ ] Health-score worker running nightly; founder dashboard surfaces at-risk accounts.
- [ ] All 5 lifecycle sequences active; first cohort of customers in welcome sequence.
- [ ] NPS modal firing quarterly; first cohort surveyed; detractor follow-up logged.
- [ ] Canny widget live; first 10 feature requests captured.
- [ ] One QBR completed with a > $500/mo account.
- [ ] Cancellation save-rate measurable; target ≥ 20% within 6 months.

## 6. Metrics

| Metric | Target |
|---|---|
| NPS | ≥ 40 |
| CSAT | ≥ 90% |
| Logo retention 30-day | ≥ 90% |
| NRR (net revenue retention) | ≥ 100% within 12 months |
| GRR (gross revenue retention) | ≥ 85% |
| Detractor follow-up rate | 100% (first 12 months) |
| Cancellation save rate | ≥ 20% |
| Win-back rate at 30/60/90 days | Track; tune offers |

## 7. Risks & mitigations

- **Risk:** Health-score components miscalibrated. **Mitigation:** quarterly review of score-to-churn correlation; re-weight inputs.
- **Risk:** Lifecycle emails feel automated and cold. **Mitigation:** founder voice + 1:1 detractor follow-up; sequences kept short.
- **Risk:** Canny becomes a noisy feature-request graveyard. **Mitigation:** monthly triage + ship-and-close-loop cadence.

## 8. Dependencies & cross-links

- [Spec 01 — PMF](./01-product-market-fit.md) (interview cadence)
- [Spec 05 — Billing](./05-billing-subscription.md) (cancellation save flow)
- [Spec 11 — Data, Analytics & BI](./11-data-analytics-bi.md) (event taxonomy, NPS tracking)
- [Spec 13 — Customer Support](./13-customer-support.md) (CSAT, ticket sentiment)
- [Spec 16 — Marketing & Growth](./16-marketing-growth.md) (referral program from champions)
- Code anchors: PR #27 dashboard redesign; `worker/background/schedulers/`
