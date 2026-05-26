# Spec 06 — Onboarding & Activation

> **Goal:** From signup → first AI-drafted response visible in **< 10 minutes**. Zernio-connect drop-off < 15%. Sample-data demo before commitment (already built — flag-gated). Bulk-CSV onboarding for regional managers. _(The 5-step checklist is dropped — see §2.)_

---

## 1. Why this matters

Activation is the single highest-correlation metric with 90-day retention (per [Spec 01](./01-product-market-fit.md)). Every minute over 10 from signup to first draft drops activation. OAuth drop-off is the biggest known leak; sample-data is the highest-leverage prospect tool RepWorth hasn't built.

## 2. Current state (RepWorth)

_Verified 2026-05-23 against the live tree (migration head 042); refreshed 2026-05-26 after Wave 2 Activation (migration head 048)._

- Self-serve signup live behind `SELF_SERVE_SIGNUP_ENABLED`.
- **Onboarding is more built than this spec credited.** Three flows exist: a flag-gated **pre-paywall demo** (`/onboarding/{start,demo,pay}`, behind `ONBOARDING_DEMO_ENABLED`, SerpAPI-backed, `onboarding_demos` table from migration 032); a live **3-step post-pay business wizard** (`/onboarding/business` → location → profile → voice, with `StepConnect`); and the **Zernio connect flow** (`/dashboard/connect`, a documented 6-state machine).
- **GBP connect is Zernio-mediated, not direct Google OAuth.** The "OAuth drop-off / pre-OAuth screen / bulk-OAuth one-consent" framing is wrong — consent + location-select happen in **Zernio's** flow (`/api/zernio/connect/start`, `/dashboard/connect/select-location`). The funnel step is `gbp_connected` via Zernio.
- ⚠️ **The dashboard checklist was deliberately removed** (2026-05-04, PR #2 follow-up): "the checklist's four items collapsed once the post-pay wizard learned to connect Zernio directly." Per decision, this spec **drops** the checklist + `account_onboarding_state`; the "invite a teammate" step is also impossible (single-owner model, teams deferred — [Spec 04](./04-auth-identity.md)).
- CSV import shipped (`src/lib/admin/csv-import.ts`): required cols `name`+`placeId`, **`MAX_ROWS = 100`** (not 500), 5 MB cap, aggregate audit via `account_audit_log`, partial-success report, client-side validation, and a public template at `/csv-templates/locations.csv`.
- ✅ **Wave 2 analytics queue shipped.** Migration **046** adds `analytics_events`; browser/Next code enqueues first-party facts through `/api/analytics/enqueue`; `AnalyticsDispatchPoller` dispatches from Railway to PostHog. No `posthog-js` browser SDK.
- Empty state already optimistic: dashboard shows "All caught up! 🎉 … We'll email when a new draft is ready" (`src/components/dashboard/ReviewsCard.tsx`) — not "No reviews yet".
- Docs: `docs/onboarding-wizard-research-2026-05-03.md` exists. The "pre-paywall demo design" is `docs/runbooks/onboarding-demo-launch-runbook.md` (the `2026-05-03-…journey-reorder-design.md` filename does **not** exist).

## 3. Target state

### Time-to-first-value (TTFV)
- **Goal: < 10 minutes** from email confirmation to first AI-drafted response visible.
- Event: `time_to_first_draft` recorded as `first_draft_at - email_verified_at`.
- TTFV > 30 min flagged for review; instrumented funnel between each step.

### Signup → activation funnel
```
signup_started
  → email_verified
    → gbp_pre_check (owner confirms they're verified manager)
      → gbp_connected (via Zernio)
        → first_review_ingested (Zernio or seed)
          → first_response_drafted
            → first_response_approved
              → first_response_published  ← activation_completed
```
Each step instrumented in PostHog with per-step drop-off dashboard.

### Zernio-connect hardening (not direct Google OAuth)
- Connect happens through **Zernio** (`/dashboard/connect` → `/api/zernio/connect/start` → Zernio consent → `/dashboard/connect/select-location`). The existing 6-state machine already handles pending/active/disconnected/finalizing.
- The pre-connect screen already confirms manager status; add a help link (screenshot guide) if drop-off warrants.
- Add a fallback for when the Zernio redirect window fails to open — show a manual retry link.
- Funnel target: **Zernio-connect** drop-off ≤ 15%.

### ~~Five-step in-app checklist~~ — dropped
Removed per decision. The dashboard checklist was deleted on 2026-05-04 (PR #2 follow-up) because the post-pay wizard now connects Zernio directly and the items collapsed. Do **not** re-introduce it — the wizard (`/onboarding/business`) is the activation path. ("Invite a teammate" is also moot under the single-owner model.)

### Sample-data demo (mostly built — flag-gated)
> Already implemented behind `ONBOARDING_DEMO_ENABLED`: `/onboarding/demo`, `onboarding_demos` table (migration 032), SerpAPI-backed with a curated fallback. Remaining work is the logged-out entry point + conversion event below.
- "Try with sample data" button on signup screen and from logged-out homepage.
- Loads pre-built demo business with 20 reviews across the 1–5 star spectrum.
- Demo mode session = read-only, 60-min expiry, no persistence.
- CTA: "Connect your own Google Business Profile" → starts real signup with email pre-filled.
- Conversion event: `sample_demo_to_signup`. Target lift ≥ 2× vs blank-state.

### White-glove onboarding
- Growth tier: 30-min onboarding call included. Calendly + Zoom. Internal checklist in `docs/runbooks/white-glove-onboarding.md`.
- Scale tier: dedicated CSM (founder until $50k MRR, then first hire).

### Multi-location bulk add
- CSV import path already exists; harden + polish.
- Publish CSV template at `/help/csv-template.csv` with field docs.
- Row-by-row validation (Zod) before upload; show errors inline.
- Cap CSV at 100 rows per import (✅ Step-0 decision: keep the shipped `MAX_ROWS = 100`; raise only on real customer demand).
- Bulk OAuth: one Google consent screen lists all locations from the manager's GBP account.
- Audit log every CSV import (already in place per recent fix).

### Empty state
Not "No reviews yet" — instead:
> **"You're ahead of the curve. Here's what to do while you wait for your next review:"**
> - [ ] Train brand voice with past responses
> - [ ] Invite teammates
> - [ ] Set notification preferences (email / SMS / Telegram)

## 4. Implementation tasks

1. ✅ **Wave 2 shipped:** instrument the signup → activation funnel through the first-party analytics queue (migration 046 + `/api/analytics/enqueue` + Railway `AnalyticsDispatchPoller`). Capture still follows the architecture invariant: PostHog dispatch happens from the worker, not the browser SDK.
2. Build the TTFV dashboard (median + p95 per cohort week) in PostHog once production data is flowing.
3. ✅ **Wave 2 shipped:** add a help link / screenshot guide on the existing `/dashboard/connect` pre-connect screen (Zernio flow). **No new `gbp-check` page** — the connect view already exists.
4. ✅ **Wave 2 shipped:** add a Zernio-redirect popup/timeout fallback with a manual retry link in `/dashboard/connect`.
5. ~~Build the 5-step checklist + `account_onboarding_state`~~ — **dropped** (checklist removed 2026-05-04; wizard replaced it).
6. ~~Build sample-data demo~~ — **already built** (`/onboarding/demo`, `onboarding_demos` table, behind `ONBOARDING_DEMO_ENABLED`). Remaining: a logged-out entry point + the `sample_demo_to_signup` conversion event; verify 60-min expiry semantics.
7. ✅ **Wave 2 shipped:** add CSV template `public/csv-templates/locations.csv` (cols `name`,`placeId` + optionals) + a column README. ✅ Step-0 decision: keep `MAX_ROWS = 100`; the template README states the 100-row limit.
8. ✅ **Wave 2 shipped:** add row-by-row error UI on CSV import (row #, reason) + "X of Y imported" partial-success summary.
9. Publish white-glove onboarding runbook + Calendly into the Growth-tier flow.
10. Empty state is already optimistic ("All caught up!"); optionally extend it with proactive actions (train voice / set notifications) — exclude "invite teammates" (single-owner).

## 5. Acceptance criteria

- [ ] Activation analytics events are enqueued and dispatched to PostHog; production TTFV median < 10 min. ✅ Code shipped; production dashboard/threshold validation pending.
- [ ] Zernio-connect drop-off measured weekly; target ≤ 15%. ✅ `gbp_connect_started` / `gbp_connect_failed` / `gbp_connected` instrumentation shipped; weekly reporting pending production dashboard.
- [ ] Sample-data demo reachable from a logged-out entry point; `sample_demo_to_signup` fires; 60-min expiry verified.
- [x] CSV template publicly downloadable; client-side validation rejects malformed files before upload; row cap reconciled at 100.
- [x] Empty-state retains the optimistic copy (any added actions exclude teammates).
- [ ] Growth-tier signups auto-prompt for onboarding call within 24h.

## 6. Metrics

| Metric | Target |
|---|---|
| TTFV (median, signup → first draft) | < 10 min |
| TTFV p95 | < 30 min |
| Zernio-connect drop-off | < 15% |
| Sample-demo → signup conversion | ≥ 2× blank state |
| 7-day activation rate (activation_completed) | ≥ 50% |
| Onboarding-call attendance (Growth tier) | ≥ 60% |

## 7. Risks & mitigations

- **Risk:** Sample-data demo confuses prospects who can't tell it from their real account. **Mitigation:** persistent "DEMO MODE" banner; demo accounts cannot send real responses.
- **Risk:** OAuth pre-check screen adds a step that drops users. **Mitigation:** A/B-test the pre-check; only deploy if drop-off-without-pre-check is higher.
- **Risk:** Checklist gamification feels condescending to power users. **Mitigation:** dismissable + auto-hides on all-complete.

## 8. Dependencies & cross-links

- [Spec 01 — PMF](./01-product-market-fit.md) (activation event definition)
- [Spec 11 — Data, Analytics & BI](./11-data-analytics-bi.md) (event taxonomy)
- [Spec 13 — Customer Support](./13-customer-support.md) (white-glove, help docs)
- [Spec 29 — RepWorth Gaps](./29-repworth-specific-gaps.md) (CSV import audit)
- Code anchors: `src/app/onboarding/{start,demo,business,pay}/*`, `src/app/(authenticated)/dashboard/connect/*`, `src/app/api/zernio/connect/*`, `src/lib/admin/csv-import.ts`, `onboarding_demos` (migration 032), `docs/runbooks/onboarding-demo-launch-runbook.md`

## 9. Implementation in the current repo

- **The activation path already exists** — pre-paywall demo + 3-step wizard + Zernio connect. Wave 2 added the first-party analytics queue/dispatcher and polish around CSV import + Zernio connect help/retry.
- **Funnel capture** uses `analytics_events` as the browser/Next-safe outbox and `AnalyticsDispatchPoller` on Railway for PostHog dispatch. The Zernio connect state machine emits start/failure/connect facts without installing a browser PostHog SDK.
- **CSV**: validation + aggregate audit + partial-success reporting exist in `src/lib/admin/csv-import.ts` and `src/app/admin/locations/csv-import/CsvImportClient.tsx`; public template files live under `public/csv-templates/`. The `MAX_ROWS` mismatch is resolved: keep 100.
- **Demo**: reuse `onboarding_demos` + the existing SerpAPI/curated pipeline; add a logged-out CTA and the conversion event.
- **No checklist / no `account_onboarding_state`** — both dropped.

---
_Verified 2026-05-23 against migration head 042; refreshed 2026-05-26 after Wave 2 Activation (migration head 048). Corrected the OAuth→Zernio mediation; dropped the deliberately-removed checklist + `account_onboarding_state`; marked demo as already-built; fixed CSV cap (100), empty-state copy, and a non-existent design-doc anchor._
