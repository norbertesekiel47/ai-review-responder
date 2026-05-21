# Spec 29 — RepWorth-Specific Gaps

> **Goal:** Close the seven highest-leverage RepWorth-specific gaps: approval audit content-snapshot, multi-location invoice monitoring, second review-source contingency, LLM cost gross-margin guard, past_due visible UX, support extension macro, CSV-import polish, and a public Trust Center.

---

## 1. Why this matters

Sections 1–28 cover generic SaaS readiness. This section is the **RepWorth-specific gap list** — the ones that, if ignored, would specifically bite RepWorth's business model (approval-first architecture, GBP-only ingestion, multi-location pricing, AI-driven generation).

## 2. Current state (RepWorth) — at a glance

| Gap | Status |
|---|---|
| Approval audit captures content snapshot | Partially — audit captures event, content snapshot to verify |
| Multi-location invoice reconciliation | Multi-location billing shipped; per-account hourly recon not yet (see [Spec 05](./05-billing-subscription.md)) |
| Single Zernio dependency | Single point of failure for ingestion |
| LLM cost monitoring per-customer | No per-account rollup |
| Past_due banner + countdown | Backend ready; UX missing |
| "Help me pay past_due" support macro | Not yet authored |
| CSV import template + validation | Implemented; template & client-side validation gap |
| Public Trust Center | Doesn't exist |

## 3. Target state — seven discrete gaps

### Gap 1 — Approval audit captures *content* snapshot

**Why**: in a dispute ("you published a response I didn't approve"), the audit row must prove which exact text was approved.

**Target**:
- `approval_audit(account_id, response_id, approval_token_hash, user_id, ip, user_agent, request_id, response_text_at_approval, response_html_at_approval, created_at)` — immutable snapshot.
- Append-only.
- 13-month minimum retention.

**Tasks**:
- Migration **057**: extend `approval_links` or add `approval_audit` table.
- Capture `response_text` from the response row at approval time, write to audit.
- Verify in `tests/integration/approval-audit.spec.ts` that audit row matches text shown to owner.

---

### Gap 2 — Multi-location invoice correctness monitoring

**Why**: per-location billing + overage = the highest-leverage place a billing bug shows up. First 10 multi-location customers are the highest-stake.

**Target**:
- `BillingReconciliationPoller` (see [Spec 05](./05-billing-subscription.md)) runs hourly on multi-location accounts.
- Compares DB-expected invoice line items vs. Stripe **upcoming invoice**.
- Alerts on any drift > **$0.01**.
- Tag the first 10 multi-location accounts with `pilot=true` flag.
- Manually inspect their first 3 invoices end-to-end before automating away.

**Tasks**:
- Migration **058**: `accounts.is_pilot boolean DEFAULT false`. Tag first 10 multi-location accounts.
- Build the Stripe upcoming-invoice comparator in the reconciliation worker.
- Founder reviews pilot invoices monthly; documented in `docs/finance/pilot-invoice-review-YYYY-MM.md`.

---

### Gap 3 — Second review-ingestion source contingency

**Why**: Zernio is a single dependency. If they raise prices, change terms, or go down, every customer's ingestion breaks. This is the **#1 concentration risk**.

**Target**:
- Preserve `ReviewSource → NormalizedReview` DTO contract (architecture invariant — already in place).
- **Spike a direct Google Business Profile API integration** as a 30-day fallback POC.
- **Negotiate Zernio contract with 30-day price-change notice.**
- Treat single-source-dependency commercially as existential — track quarterly in `docs/business/concentration-risk-YYYY-Q.md`.

**Tasks**:
- Build `worker/jobs/ingestion-sources/google-business-profile-direct.ts` — read-only POC.
- Conform to existing `ReviewSource` interface.
- Feature flag: `ingestion.source = 'zernio' | 'gbp-direct'`. Per-account override possible.
- Document fallback runbook `docs/runbooks/zernio-outage-fallback.md`: switch flag → backfill missed window → resume normal.

---

### Gap 4 — LLM cost gross-margin guard per customer

**Why**: heavy-usage customers can silently destroy unit economics. Margin death is invisible without per-customer cost rollup.

**Target** (overlaps with [Spec 22](./22-ai-llm-ops.md) but RepWorth-specific guardrails):
- Track LLM cost per response weekly. Alert on **> 20% drift** in median cost.
- Target $0.02–0.05 per response on GPT-4o-mini.
- Compute per-customer **monthly LLM cost ÷ MRR contribution** ratio.
- Any customer where ratio > **25%** → margin alert. Action: rate-limit, upsell, or improve prompt.
- If account gross margin drops below **60%** → raise prices on next renewal or shrink prompt.

**Tasks**:
- Build `account_llm_cost(account_id, month, cost_usd_calculated, response_count, avg_cost_per_response)` rollup. Migration **059**.
- Nightly worker writes rollups.
- Admin dashboard panel: "Top 10 customers by LLM-cost ratio". Alert on > 25%.
- Author founder runbook: "Heavy-usage customer triage".

---

### Gap 5 — Past_due visible UX

**Why**: silent past_due → cancellation by surprise → chargebacks + customer-trust damage. The backend is right; the UX is the missing layer.

**Target** (overlaps with [Spec 05](./05-billing-subscription.md) — RepWorth-specific):
- **Day 1**: dismissable banner ("Payment failed — update card") linked to Stripe Customer Portal.
- **Day 3**: persistent banner with countdown.
- **Day 5**: full-screen modal on login (dismissable once / day).
- **Day 7**: read-only mode at midnight UTC.
- Verify the banner UI exists and shows the countdown.

**Tasks**:
- Build `<PastDueBanner />` component with day-aware variants ([Spec 05](./05-billing-subscription.md), already detailed there).
- Verify in production with a controlled past_due test account at days 1, 3, 5, 7.

---

### Gap 6 — Support macro for "I'm past_due and can't pay"

**Why**: real customer scenario: card cancelled, owner can't pay during 7-day grace, needs an extension. Currently no documented path.

**Target macro**:
> "Sorry to hear about the card issue. Update your payment method here: [Stripe Customer Portal link]. Once updated, your account auto-recovers and we'll retry the failed payment within 24 hours. **If you need a 7-day extension while you wait for a new card, reply YES and I'll grant it.**"

**Tasks**:
- Author the macro in Help Scout + mirror in `docs/support/macros/past-due-extension.md`.
- Build admin "Grant extension" action: founder UI to add N days of grace to a past_due account. Audit-logged.
- Document in `docs/runbooks/support-extension.md` — when to grant, how to revoke if abused.

---

### Gap 7 — CSV import template + client validation + partial-success UX

**Why**: CSV import already exists + hardened, but missing: a public template, client-side validation, and clear partial-success UX.

**Target**:
- **Template at `/help/csv-template.csv`** with example rows.
- **Client-side validation** (Zod) before upload — show errors inline.
- **Server returns row-by-row error list** with line numbers.
- **Partial-success cases** (some rows imported, some failed) surface clearly — "X of Y imported" toast + detail page link.
- **Audit log persists** even when downstream billing fails (already implemented per recent fix — confirm).

**Tasks**:
- Publish CSV template + README at `public/csv-templates/locations.csv` and `public/csv-templates/README.md`.
- Implement client-side Zod validation in CSV upload form.
- Add partial-success detail page `src/app/onboarding/csv-import/[importId]/page.tsx` listing each row's outcome.
- Update import audit-log to include per-row outcome.

---

### Gap 8 — Public Trust Center

**Why**: required for any prospect doing vendor security review. Build it **before the first one asks**. Same effort as a one-pager, signals 10x more maturity.

**Target**:
- Page at `/trust` (and `/security` cross-link).
- Sections:
  - **Security**: SOC 2 status (in progress / certified), pentest cadence, vulnerability disclosure policy, security.txt link, contact (`security@`).
  - **Compliance**: GDPR / CCPA / LGPD links to self-serve flows, DPA download, sub-processor list.
  - **Reliability**: uptime SLO, status page link, incident history (last 12 months).
  - **Data**: encryption at rest / in transit, retention policy, data residency (note: US-only currently).
  - **Privacy**: privacy policy link, AI usage disclosure.

**Tasks**:
- Build `src/app/trust/page.tsx`. Static-rendered. Linked from footer.
- Pull live data where possible: status from BetterStack, incidents from `docs/postmortems/`, sub-processors from `docs/Legal/sub-processors.md`.
- Author static copy where needed.
- Link from `/login`, `/signup`, pricing page footer, dashboard footer.

---

## 4. Acceptance criteria (consolidated)

- [ ] Approval audit captures `response_text_at_approval` per response.
- [ ] Multi-location invoice reconciliation alerts on > $0.01 drift; first 10 multi-location accounts tagged `pilot=true`.
- [ ] GBP-direct ingestion POC exists; fallback runbook documented.
- [ ] Per-customer LLM cost rollup running; admin dashboard surfaces > 25% ratio accounts.
- [ ] Past_due banner + countdown + read-only mode functional end-to-end.
- [ ] "Grant extension" admin action exists, audit-logged.
- [ ] CSV template public; client-side validation; partial-success UI; per-row audit.
- [ ] `/trust` Trust Center page live and linked from footer.

## 5. Metrics

| Metric | Target |
|---|---|
| Approval-dispute defensibility | 100% (every published response has snapshot) |
| Multi-location invoice drift | $0 |
| Zernio fallback POC | Spike completed within 60 days |
| LLM cost / MRR ratio (any customer) | < 25% |
| Past_due → recovered (by day 7) | ≥ 60% |
| CSV import error rate | < 5% rows failed |
| Trust Center vendor-review pass rate | ≥ 90% (when first requested) |

## 6. Risks & mitigations

- **Risk:** GBP-direct POC reveals API limitations Zernio abstracted. **Mitigation:** it's a POC — find out now, not in an outage.
- **Risk:** Trust Center copy stale (claim SOC 2 in-progress when paused). **Mitigation:** quarterly review; founder owns.
- **Risk:** Pilot-tagged accounts notice the manual scrutiny. **Mitigation:** invisible to customer; just an internal flag.

## 7. Dependencies & cross-links

- [Spec 03 — Multi-tenancy](./03-multitenancy-isolation.md) (approval audit retention)
- [Spec 05 — Billing](./05-billing-subscription.md) (past_due UX, reconciliation)
- [Spec 09 — Security & Compliance](./09-security-compliance.md) (Trust Center)
- [Spec 11 — Data, Analytics & BI](./11-data-analytics-bi.md) (LLM cost dashboard)
- [Spec 13 — Customer Support](./13-customer-support.md) (extension macro)
- [Spec 22 — AI/LLM Operations](./22-ai-llm-ops.md) (per-customer cost rollup)
- Architecture invariants: approval flow (no auto-post, hashed tokens), `ReviewSource` contract, subscription guard
- Code anchors: `worker/ingress/zernio/*`, `worker/jobs/publisher/*`, `src/app/api/billing/*`, `worker/background/pollers/`
