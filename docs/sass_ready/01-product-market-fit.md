# Spec 01 — Product–Market Fit & Positioning

> **Goal:** Lock one sharp ICP, one JTBD, three defensible wedges, and a measurable activation event so every roadmap argument has a single tribunal.

---

## 1. Why this matters

RepWorth competes with Birdeye, Podium, NiceJob, and GoSite — all better funded. Without a focused ICP and a documented JTBD, every feature request bends the roadmap and dilutes the wedge. PMF is the moat that makes pricing, support, and retention work; without it, all later specs leak.

## 2. Current state (RepWorth)

_Verified 2026-05-23 against the live tree (migration head 042)._

- Public marketing exists but **no `docs/icp.md`** (confirmed absent).
- Pricing and onboarding emphasize the AI feature, not the JTBD. The JTBD string does not yet appear on the landing H1, pricing page, or onboarding success screen.
- ✅ **Worker-side analytics shipped** (PR #81, 2026-05-24). `posthog-node` is installed and `src/lib/analytics/posthog.ts` captures `activation_completed` on the publisher path (`worker/jobs/publisher/activation.ts`) — first posted response within 7 days of `accounts.created_at`, scoped by `account_id`. No-op without `POSTHOG_API_KEY`, flushed on worker shutdown. **Still missing:** `posthog-js` (client SDK), retention cohort dashboards, and the broader event taxonomy. See §2a.
- **No `/compare` page and no `/changelog`** (both confirmed absent under `src/app/`).
- Multi-location billing shipped (migration **034**; per-location overage via Stripe `quantity` in `worker/jobs/billing/UpdateStripeOverageWorker.ts`) — proves the multi-location wedge is real today.
- A prior PMF brainstorm exists at `docs/superpowers/specs/2026-05-19-pmf-positioning-design.md`. This spec is its operational successor — reconcile, don't duplicate.

## 2a. Resolved decision — analytics tooling (was: blocked tasks 4–5)

✅ **Decided (Step 0, 2026-05-23): PostHog Cloud.** Fastest path to event capture + cohorts with minimal infra; also bundles the feature-flag tool ([Spec 24](./24-devops-deployment.md)) so %-rollout comes free. The rejected alternative was a Postgres-native `analytics_events` table + Metabase (no new vendor, but you build cohort math yourself). Metabase-on-replica is still the **future** scale option once custom-SQL needs exceed PostHog — see [Spec 11 §Future](./11-data-analytics-bi.md).

Add `posthog-node` (server) + `posthog-js` (client); capture events on the **worker** publish path (not Vercel routes). The four §6 metrics below now read from PostHog. This unblocks `activation_completed` instrumentation (tasks 4–5) and the dependent specs (06, 07, 11, 14, 16, 26).

> ✅ **Shipped (Step 1, PR #81):** `posthog-node` + `src/lib/analytics/posthog.ts` + the `activation_completed` capture on the worker publish path (task 4). `posthog-js`, the retention dashboard (task 5), and the event taxonomy remain open.

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
3. Add comparison page `src/app/(public)/compare/page.tsx` (route-group convention, matching the existing `(public)/pricing`) with three-wedge table vs. Birdeye, Podium, NiceJob, GoSite. Cite approval audit + per-location pricing + brand voice as proof.
4. ✅ **Done (PR #81).** `activation_completed` is emitted from the worker publisher chokepoint (`worker/jobs/publisher/activation.ts`) on the first account-level posted response within 7 days of `accounts.created_at`, scoped by `account_id` (covers all four posted-transition paths). _Remaining:_ backfill of historical activations from existing `responses` / `accounts` rows (the live path only emits going forward).
5. Build a 4-metric retention dashboard (PostHog or Metabase): trial → paid %, monthly logo retention, 90-day logo retention, activation rate.
6. Public changelog at `src/app/(public)/changelog/page.tsx` (markdown-rendered from `docs/changelog/*.md`). Public "what's next" page with three buckets: shipping / exploring / considering (no dates).
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

> The "PostHog" sources above are confirmed by the §2a decision (PostHog Cloud).

## 7. Risks & mitigations

- **Risk:** ICP drift via opportunistic single-location deals. **Mitigation:** every deal logged with ICP-fit score 1–5; quarterly review on <3 churns.
- **Risk:** Activation event poorly correlated with retention. **Mitigation:** re-derive activation if lift < 2× after 50 activated accounts.
- **Risk:** Competitor responds by adding approval flow. **Mitigation:** double down on wedge #2 (multi-location-native pricing) — harder to copy without cannibalizing their enterprise revenue.

## 8. Dependencies & cross-links

- [Spec 06 — Onboarding & Activation](./06-onboarding-activation.md) (owns activation flow instrumentation)
- [Spec 11 — Data, Analytics & BI](./11-data-analytics-bi.md) (event taxonomy, cohort math)
- [Spec 14 — Customer Success & Retention](./14-customer-success-retention.md) (interview cadence)
- [Spec 16 — Marketing & Growth](./16-marketing-growth.md) (changelog, comparison page)
- Prior design: `docs/superpowers/specs/2026-05-19-pmf-positioning-design.md`

## 9. Implementation in the current repo

- **ICP doc:** `docs/icp.md`; reference it from the PR template (`.github/pull_request_template.md`).
- **JTBD string:** define once in a shared constant (e.g. `src/lib/brand/copy.ts`) and import into the landing (`src/app/page.tsx`), pricing (`src/app/(public)/pricing/PricingContent.tsx`), and onboarding success screen — the snapshot test then asserts one constant, not three hard-coded copies.
- **Compare page:** `src/app/(public)/compare/page.tsx` — static, no worker involvement.
- **Activation event:** capture belongs on the **worker** publish path (`worker/jobs/publisher/*`) where `published_at` is set — not in a Next.js route (Vercel = UI only). If Option B, write to `analytics_events` inside the existing publish transaction so it's outbox-safe.
- **Retention dashboard:** read-only; if Postgres-native, point Metabase at the pooled/replica URL.
- **Changelog:** `src/app/(public)/changelog/page.tsx` rendering `docs/changelog/*.md`.

---
_Verified 2026-05-23 against migration head 042. Confirmed absent: `docs/icp.md`, `/compare`, `/changelog`, any PostHog/analytics dependency. Activation query corrected to account-scope. Reconciled with `2026-05-19-pmf-positioning-design.md`._
