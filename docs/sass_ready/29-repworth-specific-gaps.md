# Spec 29 — RepWorth-Specific Gaps

> **Goal:** Close the seven highest-leverage RepWorth-specific gaps: approval audit content-snapshot, multi-location invoice monitoring, second review-source contingency, LLM cost gross-margin guard, past_due visible UX, support extension macro, CSV-import polish, and a public Trust Center.

---

## 1. Why this matters

Sections 1–28 cover generic SaaS readiness. This section is the **RepWorth-specific gap list** — the ones that, if ignored, would specifically bite RepWorth's business model (approval-first architecture, GBP-only ingestion, multi-location pricing, AI-driven generation).

## 2. Current state (RepWorth) — at a glance

_Verified 2026-05-23 against the live tree (migration head 042)._

| Gap | Status (verified) |
|---|---|
| 1. Approval audit content snapshot | `approval_audit_log` stores **action/event only** (no `response_text_at_approval`); the approved text lives separately on `responses.approved_text`. Gap = bind immutable text to the audit row. |
| 2. Multi-location invoice recon | `StripeLocationsReconcilePoller` detects **quantity** drift; **no upcoming-invoice comparator**, no `is_pilot` (could ride `accounts.flags`). |
| 3. Single Zernio dependency | `ReviewSource → NormalizedReview` interface **exists** (`src/lib/reviews/types.ts`) with a 2nd impl already (`serpapi-source.ts`, test/demo); Zernio is the **sole production** source. GBP-direct is greenfield. |
| 4. LLM cost per customer | `api_costs` captures **per-call** (business_id); **no `account_llm_cost` monthly rollup**. |
| 5. Past_due banner + countdown | `PastDueBanner` exists with a **hardcoded "7-day"** message; **no `past_due_at`**, no dynamic countdown. |
| 6. "Help me pay past_due" macro + grant-extension | Neither exists; no `docs/support/macros/`. |
| 7. CSV import template + validation | `csv-import.ts` (MAX_ROWS=**100**); `CsvImportReport` **already returns per-row failures**; **no public template, no client-side validation**. |
| 8. Public Trust Center | No `/trust`, no `/security`. |

## 3. Target state — seven discrete gaps

### Gap 1 — Approval audit captures *content* snapshot

**Why**: in a dispute ("you published a response I didn't approve"), the audit row must prove which exact text was approved.

**Target**:
- `approval_audit(account_id, response_id, approval_token_hash, user_id, ip, user_agent, request_id, response_text_at_approval, response_html_at_approval, created_at)` — immutable snapshot.
- Append-only.
- 13-month minimum retention.

**Tasks**:
- Migration (next free number; head 042 — coordinate): extend `approval_audit_log` with `response_text_at_approval` (the approved text already exists on `responses.approved_text` — snapshot it onto the immutable audit row at approval time so the proof isn't separable from the event).
- Capture `response_text` from the response row at approval time, write to the audit row.
- Verify in `src/__tests__/approval-audit.test.ts` (Vitest collocated convention) that the audit row matches text shown to the owner.

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
- Pilot flag: prefer a key in the existing `accounts.flags` JSONB (e.g. `flags.is_pilot`) over a new column — no migration needed. Tag the first 10 multi-location accounts.
- Build the Stripe upcoming-invoice comparator and add it to the existing `StripeLocationsReconcilePoller` (which today only checks overage **quantity**, not the full upcoming invoice).
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
- ✅ The `ReviewSource` interface already exists (`src/lib/reviews/types.ts`) and already has a second impl (`serpapi-source.ts`, used for the onboarding demo) — the abstraction is proven, not theoretical.
- Build a `GoogleBusinessProfileDirectSource` implementing `ReviewSource` (alongside the existing sources in `src/lib/reviews/`) — read-only POC. Note: `google_connections` already has encrypted token columns ([Spec 09](./09-security-compliance.md)) for the direct-GBP path.
- Feature flag (env-var pattern, per [Spec 24](./24-devops-deployment.md)): `INGESTION_SOURCE = 'zernio' | 'gbp-direct'`. Per-account override possible.
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
- Build `account_llm_cost(account_id, month, cost_usd_calculated, response_count, avg_cost_per_response)` rollup (next free migration number; head 042 — coordinate). ✅ Source is the existing **`api_costs`** (per-call); this is an aggregation, not new instrumentation. Note `api_costs` is keyed by `business_id` — roll up to `account_id` via the businesses→accounts join.
- Nightly worker writes rollups (mirror the existing scheduler pattern).
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
- ✅ `PastDueBanner` already exists (`SubscriptionStatusBanner.tsx`) with a hardcoded "7-day" message — **enhance it to day-aware variants**, don't create it.
- **Prerequisite: add `accounts.past_due_at`** ([Spec 05](./05-billing-subscription.md) owns this) — there's no countdown data source today (`subscription_status='past_due'` only).
- Verify in production with a controlled past_due test account at days 1, 3, 5, 7.

---

### Gap 6 — Support macro for "I'm past_due and can't pay"

**Why**: real customer scenario: card cancelled, owner can't pay during 7-day grace, needs an extension. Currently no documented path.

**Target macro**:
> "Sorry to hear about the card issue. Update your payment method here: [Stripe Customer Portal link]. Once updated, your account auto-recovers and we'll retry the failed payment within 24 hours. **If you need a 7-day extension while you wait for a new card, reply YES and I'll grant it.**"

**Tasks**:
- Author the macro in Help Scout + mirror in `docs/support/macros/past-due-extension.md` (`docs/support/macros/` is greenfield).
- Build admin "Grant extension" action (net-new — no such action exists): founder UI to add N days of grace to a past_due account. Audit-logged via the existing `account_audit_log`. Same action referenced in [Spec 05](./05-billing-subscription.md) task 10 — build once. Depends on `past_due_at` (Gap 5).
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
- Add a partial-success detail view listing each row's outcome. ✅ `CsvImportReport` (in `src/lib/admin/csv-import.ts`) **already returns per-row failures** — the gap is surfacing it in the UI, not computing it. (CSV import is admin-side: route `/api/admin/locations/csv-import`.)
- ✅ Row cap decided (Step 0): keep `MAX_ROWS = 100` (no code change); the template README states the 100-row limit.
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
- Build the Trust Center at `/legal/trust` (per the Step-0 `/legal/*` routing decision, [Spec 17](./17-legal-compliance-docs.md) §3 — keep `/trust` as a 301 redirect for memorability). Static-rendered. Linked from footer.
- ⚠️ Several data sources don't exist yet — start with static copy and wire live data as it lands: status (BetterStack — [Spec 08](./08-reliability-sre.md)), incidents (`docs/postmortems/` — not yet created), sub-processors (`docs/legal/sub-processors.md` — not yet created, [Spec 17](./17-legal-compliance-docs.md)).
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
- Code anchors: `approval_audit_log` + `responses.approved_text`, `src/lib/reviews/types.ts` (`ReviewSource`) + `serpapi-source.ts`, `api_costs` + `src/lib/costs/audit.ts`, `SubscriptionStatusBanner.tsx`, `src/lib/admin/csv-import.ts` (`CsvImportReport`), `worker/background/pollers/StripeLocationsReconcilePoller.ts`

## 8. Implementation in the current repo

- **Most gaps build on something that already exists**, which is the headline of this whole spec set: approved text on `responses.approved_text` (Gap 1), the proven `ReviewSource` abstraction + a 2nd impl (Gap 3), per-call `api_costs` (Gap 4), the `PastDueBanner` + `StripeLocationsReconcilePoller` (Gaps 2/5), and per-row `CsvImportReport` failures (Gap 7). Net-new from zero: the Trust Center (Gap 8), the grant-extension admin action + macro (Gap 6).
- **Cross-spec keystones**: `past_due_at` (Gaps 5/6 ← [Spec 05](./05-billing-subscription.md)); `account_llm_cost` rollup (Gap 4 ↔ [Spec 22](./22-ai-llm-ops.md)) sources the extended `api_costs` (Step-0 audit-home decision); analytics tool is **PostHog** (admin cost dashboards ← [Spec 01 §2a](./01-product-market-fit.md), Step-0 decision); flag pattern stays env-var kill-switches + PostHog flags for %-rollout ([Spec 24](./24-devops-deployment.md), Step-0 decision).
- **Migration numbering**: the original 057/058/059 are dropped in favor of "next free number, coordinate" (head 042); Gap 2's pilot flag can avoid a migration entirely via `accounts.flags`.

---
_Verified 2026-05-23 against migration head 042. Each gap's status corrected to the live tree: approval text lives on `responses.approved_text` (not the audit row); `ReviewSource` + a 2nd impl already exist; `api_costs` is the per-call source for the missing rollup; `PastDueBanner`/reconcile-poller/`CsvImportReport` partially exist. Migration numbers de-hardcoded; test/route paths aligned to real conventions._
