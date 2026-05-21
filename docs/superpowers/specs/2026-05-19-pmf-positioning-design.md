# Spec 01 (Implementation) — Product–Market Fit & Positioning

> **Status:** Design approved 2026-05-19. Ready for implementation planning.
> **Derives from:** [`docs/sass_ready/01-product-market-fit.md`](../../sass_ready/01-product-market-fit.md) (high-level plan).
> **Migration claimed:** `043` (current head: `042_zernio_backfill_run_reasons.sql`).
> **Goal:** Make the PMF plan buildable. Lock one JTBD string by construction, measure activation authoritatively in Postgres, surface retention/ICP signal in an internal admin page, and ship the positioning surfaces (`/compare`, `/changelog`, ICP doc) without coupling to a not-yet-existent analytics platform.

---

## 0. Decisions baked in (from brainstorming)

| Decision | Choice | Why |
|---|---|---|
| Scope | Full — strategy + code, fully fleshed | One owner-driven epic; PMF threads through everything |
| Activation metric | Postgres-native, server-emitted from publisher worker | No analytics layer exists; `Vercel = UI only`; outbox invariant |
| Retention viz | SQL views + internal admin page | No new infra; heavyweight BI deferred to Spec 11 |
| Interview tracking | Lightweight Postgres table + admin form | No CRM exists; queryable beside retention; seam to Spec 14 |
| `/compare` claims | Cited + legal-review gate | Competitor claims are Spec 17 legal territory |
| Spec output | `docs/superpowers/specs/` | Original `01-*.md` stays as the plan |
| Admin placement | One `/admin/metrics` page, interviews as a tab | Fewer routes; metrics + interview signal read together |
| Markdown lib | `react-markdown` + `gray-matter` | Avoids `dangerouslySetInnerHTML`; standard front-matter parse |

---

## 1. Correction vs. the original plan

The plan's activation definition (`responses.published_at IS NOT NULL`) references a **column that does not exist**. The real publish signal in the schema is:

- `responses.status = 'posted'` (terminal state set by the publisher), and
- `responses.posted_at` (timestamp; indexed via `idx_responses_business_posted (business_id, posted_at)`).

The publisher path that sets this is `handlePublishResponse` in `worker/jobs/publisher/ResponsePublisherWorker.ts`. **All activation logic in this spec uses `status='posted'` + `posted_at`.** The original plan doc should be amended to match (tracked in §9).

---

## 2. Component A — Single-source JTBD string

**Problem it solves:** The acceptance criterion "JTBD appears identically on landing H1, pricing, onboarding success" is unenforceable if the string is hardcoded in three files. Make drift impossible.

**Build:**

- New `src/lib/brand/jtbd.ts`:
  ```ts
  export const JTBD = "Never miss a review. Never publish a bad response." as const;
  // Two-clause split for layouts that render each line separately:
  export const JTBD_PARTS = ["Never miss a review.", "Never publish a bad response."] as const;
  ```
- Consumers import the constant (no literal strings):
  - Landing H1 — `src/app/(public)/page.tsx`
  - Pricing value prop — `src/app/(public)/pricing/` (page or its hero component)
  - Onboarding success — `src/app/onboarding/payment-success/PaymentSuccessClient.tsx`

**Test (Vitest):** a single test imports `JTBD` and asserts each of the three surfaces renders it verbatim. Because all three import one constant, the test guards against a contributor hardcoding a variant string rather than re-checking three literals.

**Interface contract:** `jtbd.ts` is a leaf module — no imports, no side effects. Anyone can read it and know what it does.

---

## 3. Component B — Activation event (migration 043, worker emit)

**Definition:** `activation_completed` = an account's **first** approved-and-`posted` response where `posted_at - accounts.created_at <= INTERVAL '7 days'`.

### 3.1 Schema (migration 043)

```sql
CREATE TABLE account_activations (
  account_id          UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  business_id         UUID NOT NULL REFERENCES businesses(id),
  response_id         UUID NOT NULL REFERENCES responses(id),
  activated_at        TIMESTAMPTZ NOT NULL,           -- = responses.posted_at
  days_to_activation  NUMERIC(5,2) NOT NULL,          -- posted_at - accounts.created_at, in days
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- One row per account, written once. `account_id` PK makes idempotency a constraint, not app logic.
- Narrow, PMF-specific table — **not** a general event bus (that's Spec 11's taxonomy). Documented seam in §8.

### 3.2 Emit path (publisher worker, same transaction)

Inside the transaction in `handlePublishResponse` where the response is marked `posted` (`UPDATE responses SET status='posted', posted_at=NOW() …`), add — **in the same Postgres transaction**, honoring the transactional-outbox invariant (state change + follow-up work in one tx; never write Postgres then separately enqueue):

```sql
INSERT INTO account_activations (account_id, business_id, response_id, activated_at, days_to_activation)
SELECT a.id, $businessId, $responseId, $postedAt,
       EXTRACT(EPOCH FROM ($postedAt - a.created_at)) / 86400.0
FROM accounts a
JOIN businesses b ON b.account_id = a.id
WHERE b.id = $businessId
  AND $postedAt - a.created_at <= INTERVAL '7 days'
ON CONFLICT (account_id) DO NOTHING;
```

- Fires only inside the success branch where status actually transitions to `posted` (re-publish / no-op paths must not emit).
- `ON CONFLICT DO NOTHING` + the 7-day guard means: only the first qualifying response activates; later ones and out-of-window ones are silently skipped.
- **Signup anchor** = `accounts.created_at` (billing parent), per the multi-location invariant (`accounts` = billing parent, `businesses` = location). The exact column is verified against the live schema during implementation; if account creation timestamp lives elsewhere, the spec's intent (account birth, not location birth) governs.

**Code placement (entry-point invariant):** the emit is a small status-guarded INSERT alongside the existing posted-UPDATE, so it stays in the publisher worker. If wiring it cleanly requires more than ~30 lines of branching, extract an `emitActivation(tx, …)` helper module next to `ResponsePublisherWorker.ts` with its own focused tests.

### 3.3 Backfill (migration 043)

Backfill `account_activations` from existing data so historical accounts aren't undercounted:

```sql
INSERT INTO account_activations (account_id, business_id, response_id, activated_at, days_to_activation)
SELECT DISTINCT ON (a.id)
       a.id, r.business_id, r.id, r.posted_at,
       EXTRACT(EPOCH FROM (r.posted_at - a.created_at)) / 86400.0
FROM responses r
JOIN businesses b ON b.id = r.business_id
JOIN accounts a   ON a.id = b.account_id
WHERE r.status = 'posted'
  AND r.posted_at IS NOT NULL
  AND r.posted_at - a.created_at <= INTERVAL '7 days'
ORDER BY a.id, r.posted_at ASC          -- earliest qualifying post wins
ON CONFLICT (account_id) DO NOTHING;
```

### 3.4 Tests (Vitest, integration with seeded DB)

- In-window first post → row inserted with correct `days_to_activation`.
- Out-of-window (>7 days) post → **no** row.
- Second qualifying post on an already-activated account → no duplicate (idempotent).
- Re-run / re-publish of the same response → no duplicate.
- Backfill query produces exactly the earliest qualifying post per account.

---

## 4. Component C — Retention metrics views (migration 043) + admin page

### 4.1 Postgres views (043)

Plain views first (admin traffic is tiny). Promote individual views to `MATERIALIZED` + a refresh in `worker/background/schedulers/` only if a view is measured slow.

| View | Definition (intent) |
|---|---|
| `v_trial_to_paid` | Of accounts created in a cohort month, the % that reached a paid `subscription_status` on `accounts`. |
| `v_logo_retention` | Cohort by `accounts.created_at` month; % still on a non-cancelled `subscription_status` at 30 / 90 / 365 days. |
| `v_activation_rate` | Of accounts with `created_at` ≥ 7 days ago, the % with a row in `account_activations`. |
| `v_interview_volume` | Interviews per ISO week from `customer_interviews` (see §5). |

Subscription / Stripe state is read from `accounts` (never re-introduced on `businesses`, per the multi-location invariant).

### 4.2 Admin page

- New route `src/app/admin/metrics/` modeled on the existing `src/app/admin/costs/` page (same admin shell: `src/app/admin/layout.tsx`, `providers.tsx`).
- Reads the four views. Two tabs: **Retention** (the 4 KPI views) and **Interviews** (see §5.2).
- Read-only display; no business logic in the route. Server Component fetches via the transactional `postgres` client; admin auth scope already enforced by the admin layout.
- Heavyweight BI (charts, drilldowns, cross-filtering) is explicitly **Spec 11**, not here.

### 4.3 Tests

View-correctness tests against seeded fixtures: known cohort → expected trial→paid %, retention %, activation %.

---

## 5. Component D — Interview / ICP-fit tracking (migration 043)

### 5.1 Schema (043)

```sql
CREATE TABLE customer_interviews (
  id                    UUID PRIMARY KEY,                       -- UUIDv7 (time-ordered, per DB convention)
  account_id            UUID REFERENCES accounts(id) ON DELETE SET NULL,  -- nullable: prospects too
  interviewer           TEXT NOT NULL,
  interviewed_at        TIMESTAMPTZ NOT NULL,
  top_cancellation_risk TEXT,                                   -- replaces the plan's CRM custom field
  icp_fit_score         SMALLINT CHECK (icp_fit_score BETWEEN 1 AND 5),
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_customer_interviews_interviewed_at ON customer_interviews (interviewed_at);
```

The plan's "every deal logged with ICP-fit score 1–5" guardrail maps directly onto `icp_fit_score`; the quarterly `<3` churn review is a runbook note (§7).

### 5.2 Admin entry form

- Lives in the **Interviews tab** of `src/app/admin/metrics/`.
- Simple insert form (interviewer, date, account lookup optional, risk text, 1–5 score, notes) → writes via a server action / admin API route using the transactional client.
- Lists recent interviews + the `v_interview_volume` weekly count against the ≥5/week target.

### 5.3 Seam to Spec 14

01 owns **storage + capture** only. The cadence program, lifecycle automation, and health-score integration are **Spec 14**. Documented in §8 and inline in the migration comment.

---

## 6. Component E — `/compare`, `/changelog`, `/whats-next`, ICP doc

### 6.1 `/compare` (cited claims, legal gate)

- `src/app/(public)/compare/page.tsx` — three-wedge table vs. Birdeye / Podium / NiceJob / GoSite. Wedges: (1) approval-first + audit trail, (2) multi-location-native at SMB pricing, (3) per-location brand-voice tuning.
- Competitor claims live in typed data, **not** inline JSX:
  ```ts
  // src/lib/compare/competitors.ts
  export type CompetitorClaim = { claim: string; source: string; sourceDate: string };
  ```
  Every negative/comparative statement about a named competitor must be a `CompetitorClaim` with a dated source. Uncited claims cannot render (enforced by the type + a lint/test that rejects empty `source`).
- Layout follows the `repworth-brand-design` skill (island layout, color tokens, animation conventions).
- **Acceptance gate:** a checklist item requiring legal sign-off before the page goes live (cross-link Spec 17).

### 6.2 `/changelog` + `/whats-next`

- Add deps: `react-markdown`, `gray-matter`.
- `src/app/(public)/changelog/page.tsx` — Server Component reads `docs/changelog/*.md` (fs at request/build), sorts by front-matter date, renders with `react-markdown` (no raw HTML injection).
- "What's next" — three buckets **shipping / exploring / considering**, **no dates**. Sourced from a single structured `docs/changelog/roadmap.md` (front-matter bucket lists). Either its own `/whats-next` route or a section on `/changelog`; default to a section on `/changelog` to avoid a near-empty route.
- Linked from the public footer.

### 6.3 `docs/icp.md`

- Author with the plan's skeleton: verticals (dental groups, medspas, auto-service chains, salon groups, fitness studios), employee/location count band (2–25 locations), current tooling, decision-maker titles, top 3 pains, top 3 cancellation reasons (start empty, filled from interviews).
- Pinned and referenced from the PR template (`.github/pull_request_template.md`) so every roadmap proposal is judged against it.

---

## 7. Non-engineering deliverables (process / docs)

- `docs/icp.md` (§6.3) — pinned, in PR template.
- Quarterly ICP-drift review runbook note: deals with `icp_fit_score < 3` are reviewed quarterly; opportunistic single-location deals logged with a fit score.
- Activation-validity check: re-derive the activation definition if lift over non-activated cohorts is `< 2×` after 50 activated accounts (the `v_activation_rate` view + retention views make this measurable).

---

## 8. Cross-spec seams (respected, not duplicated)

| Spec | Owns | This spec's boundary |
|---|---|---|
| 11 — Data/Analytics/BI | General event taxonomy, cohort math, heavyweight BI | 01 builds only `account_activations` + 4 PMF views; no general event bus |
| 14 — Customer Success | Interview cadence program, health score | 01 builds only `customer_interviews` storage + admin capture |
| 17 — Legal | ToS/PP/competitor-claim review | 01 gates `/compare` behind legal sign-off |
| 06 — Onboarding | Activation *flow* (TTFV, demo) | 01 owns activation *measurement* only |
| 16 — Marketing | SEO, broader changelog/comparison strategy | 01 ships the page mechanics; messaging strategy is 16 |

---

## 9. Acceptance criteria (merge-gate)

- [ ] `src/lib/brand/jtbd.ts` exists; landing H1, pricing value prop, onboarding success all import it; snapshot test green.
- [ ] Migration 043 applied: `account_activations`, `customer_interviews`, four `v_*` views created; backfill run.
- [ ] Activation INSERT wired into the publisher `posted` transaction; unit + integration tests cover in-window / out-of-window / idempotent / backfill cases.
- [ ] `/admin/metrics` live with Retention + Interviews tabs, reading the views; interview entry form writes rows.
- [ ] `/compare` live, all competitor claims carry dated sources, **legal sign-off recorded** in the PR.
- [ ] `/changelog` (with What's-next buckets) deployed and linked from footer; renders `docs/changelog/*.md`.
- [ ] `docs/icp.md` exists, pinned, referenced from `.github/pull_request_template.md`.
- [ ] Original `docs/sass_ready/01-product-market-fit.md` amended: `published_at` → `status='posted'`/`posted_at`, PostHog references reconciled to Postgres-native.
- [ ] Targets (review, not block at merge): trial→paid 15–25%, 30-day logo retention ≥ 90%, activation rate ≥ 50% — tracked on `/admin/metrics`.

---

## 10. Migration 043 summary

One migration, additive only (no destructive changes to existing tables):

1. `CREATE TABLE account_activations` (§3.1)
2. `CREATE TABLE customer_interviews` + index (§5.1)
3. `CREATE VIEW v_trial_to_paid`, `v_logo_retention`, `v_activation_rate`, `v_interview_volume` (§4.1)
4. Backfill INSERT into `account_activations` (§3.3)

Follows DB conventions: UUIDv7 PKs, `ON CONFLICT` predicates matching any partial-index predicate byte-for-byte, JSONB via the `jsonb()` helper if any column needs it (none currently).

---

## 11. Dependencies & cross-links

- Plan: [`docs/sass_ready/01-product-market-fit.md`](../../sass_ready/01-product-market-fit.md)
- [Spec 06 — Onboarding & Activation](../../sass_ready/06-onboarding-activation.md)
- [Spec 11 — Data, Analytics & BI](../../sass_ready/11-data-analytics-bi.md)
- [Spec 14 — Customer Success & Retention](../../sass_ready/14-customer-success-retention.md)
- [Spec 16 — Marketing & Growth](../../sass_ready/16-marketing-growth.md)
- [Spec 17 — Legal & Compliance Docs](../../sass_ready/17-legal-compliance-docs.md)
- Code anchors: `worker/jobs/publisher/ResponsePublisherWorker.ts`, `src/app/admin/costs/`, `src/app/(public)/page.tsx`, `src/app/(public)/pricing/`, `src/app/onboarding/payment-success/PaymentSuccessClient.tsx`, `supabase/migrations/`.
