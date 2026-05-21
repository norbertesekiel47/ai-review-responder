# Spec 06 — Onboarding & Activation

> **Goal:** From signup → first AI-drafted response visible in **< 10 minutes**. OAuth drop-off < 15%. Sample-data demo before commitment. Five-step in-app checklist. Bulk-CSV onboarding for regional managers.

---

## 1. Why this matters

Activation is the single highest-correlation metric with 90-day retention (per [Spec 01](./01-product-market-fit.md)). Every minute over 10 from signup to first draft drops activation. OAuth drop-off is the biggest known leak; sample-data is the highest-leverage prospect tool RepWorth hasn't built.

## 2. Current state (RepWorth)

- Self-serve signup live behind `SELF_SERVE_SIGNUP_ENABLED`.
- Onboarding wizard research done (`docs/onboarding-wizard-research-2026-05-03.md`).
- Pre-paywall demo journey reorder design exists (`docs/plans/2026-05-03-pre-paywall-demo-and-journey-reorder-design.md`).
- CSV import shipped; hardened error handling + audit logging.
- Multi-location design (PR #28) supports bulk-add via CSV.
- No `time_to_first_draft` event instrumented. No sample-data demo button. No OAuth funnel analytics published.

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
      → gbp_connected (OAuth)
        → first_review_ingested (Zernio or seed)
          → first_response_drafted
            → first_response_approved
              → first_response_published  ← activation_completed
```
Each step instrumented in PostHog with per-step drop-off dashboard.

### OAuth flow hardening
- Pre-OAuth screen: "Are you the verified manager of your Google Business Profile?" with help link (screenshot guide).
- Browser-extension/popup-blocker fallback: if window.opener is null after 5s, show "Couldn't open Google. Click here to retry in a new tab" with a manual link.
- Funnel target: OAuth drop-off ≤ 15%.

### Five-step in-app checklist
Hand-rolled component (`src/components/onboarding/Checklist.tsx`). Sticky in dashboard sidebar until all done. Items:
1. Connect Google Business Profile.
2. Set brand voice (paste 3 past responses).
3. Review first AI draft.
4. Approve first response.
5. Invite a teammate.

Don't use Appcues. The checklist is part of the product.

### Sample-data demo
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
- Cap CSV at 500 rows per import.
- Bulk OAuth: one Google consent screen lists all locations from the manager's GBP account.
- Audit log every CSV import (already in place per recent fix).

### Empty state
Not "No reviews yet" — instead:
> **"You're ahead of the curve. Here's what to do while you wait for your next review:"**
> - [ ] Train brand voice with past responses
> - [ ] Invite teammates
> - [ ] Set notification preferences (email / SMS / Telegram)

## 4. Implementation tasks

1. Instrument PostHog events listed in §3 funnel. Source of truth `docs/analytics/events.md` (see [Spec 11](./11-data-analytics-bi.md)).
2. Build TTFV dashboard in PostHog with median + p95 per cohort week.
3. Build pre-OAuth confirmation screen (`src/app/onboarding/gbp-check/page.tsx`) with help link.
4. Add OAuth popup fallback: detect blocker, render manual link.
5. Build `<OnboardingChecklist />` component with the five steps. Persist completion state in `account_onboarding_state(account_id, step_key, completed_at)`.
6. Build sample-data demo: route `src/app/demo/page.tsx`, in-memory or scoped-account-with-`demo=true` flag. 60-min session.
7. Add CSV template `public/csv-templates/locations.csv` with example rows + a `README.md` describing each column.
8. Add row-by-row error UI on CSV import page (show row #, column, reason). Partial-success cases (some rows imported, some failed) need a clear "X of Y imported" toast linking to a detail page.
9. Publish white-glove onboarding runbook + Calendly integration into Growth-tier signup flow.
10. Replace empty-state copy on dashboard home with the three-action layout.

## 5. Acceptance criteria

- [ ] `time_to_first_draft` event firing in PostHog; median < 10 min in production.
- [ ] OAuth drop-off measured weekly; target ≤ 15%.
- [ ] Sample-data demo accessible without login; 60-min expiry tested.
- [ ] Five-step checklist visible after first login; persists across sessions.
- [ ] CSV template publicly downloadable; client-side validation rejects malformed files before upload.
- [ ] Empty-state shows three actions instead of "No reviews yet".
- [ ] Growth-tier signups auto-prompt for onboarding call within 24h.

## 6. Metrics

| Metric | Target |
|---|---|
| TTFV (median, signup → first draft) | < 10 min |
| TTFV p95 | < 30 min |
| OAuth drop-off | < 15% |
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
- Code anchors: `src/app/api/onboarding/*`, `src/app/api/locations/*`, `docs/plans/2026-05-03-pre-paywall-demo-and-journey-reorder-design.md`
