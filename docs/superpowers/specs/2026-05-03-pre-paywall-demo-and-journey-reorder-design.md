# Project B — Pre-paywall demo + journey reorder + setup checklist

**Status:** Design v2 — incorporates code-review tier 1/2/3 corrections (2026-05-03)
**Date:** 2026-05-03
**Branch (target):** Two PRs — see §10.0
**Scope reference:** `docs/onboarding-wizard-research-2026-05-03.md` §Project B (lines 870-950)
**Migration:** 032 (`onboarding_demos` table)
**Feature flag:** `ONBOARDING_DEMO_ENABLED` (default `false`)

---

## 1. Goal

Insert a SerpAPI-driven demo response between signup and the paywall so prospective owners see what RepWorth would do *for their own business* before committing payment. Re-order the wizard so location capture happens pre-pay, profile + voice happen post-pay, and the dashboard surfaces a persistent setup checklist that drives time-to-first-value.

This is the core conversion play. Combines research items P0-1, P0-2, P0-4. Ships as winner-takes-all (no formal A/B — volume too low).

---

## 2. Non-goals (deliberately out of scope)

- Multi-location anything (Project D, deferred)
- ReviewSource adapter refactor (Project E, deferred)
- Yelp / Trustpilot / Facebook / TripAdvisor sources
- Google Sign-In as primary auth (Project C, P1-7)
- Voice-tuning UI changes (Project C, P1-5)
- Async-validation feedback on Maps URL paste (Project C, P1-6)
- Statistical A/B testing infrastructure
- Stripe Payment Link state hand-off changes — verified unnecessary, see §3.11

---

## 3. Architectural decisions

### 3.1 Hybrid journey split

**Decision:** Pre-pay endpoint captures location only (no profile, no voice). Existing wizard (`/onboarding/business`) becomes profile + voice post-pay, starting at "Step 1 of 2" (profile) of a 2-step flow.

**Why:** The existing `/api/onboarding/business` route hard-rejects anything that isn't `subscription_status='active'` (`business/route.ts:115-120`). The hybrid split avoids touching that gate.

**New routing topology:**

```
/signup → /signup/finish → /onboarding/start (NEW: location only)
   → /onboarding/demo (NEW: demo + paywall composed)
   → Stripe checkout (unchanged)
   → /onboarding/payment-success (unchanged)
   → /onboarding/business (EXISTING, schema relaxed via §5.4: now starts at Step 1-of-2 — profile)
   → Step 2-of-2 (voice)
   → /dashboard (with persistent checklist §3.10)
```

### 3.2 Data model: separate table, lifecycle helper with documented schema divergence

**Decision:** New `onboarding_demos` table (migration 032). New BullMQ queue `onboarding_demo_response`. Lifecycle code extracted to `src/lib/demos/lifecycle.ts` and shared with the existing `DemoGenerationWorker` (sales prospect demos against `prospect_demos`).

**Schema divergence — explicit handling:**
`prospect_demos` (per `001_initial_schema.sql:352-377`) has `review_source TEXT NOT NULL DEFAULT 'serpapi'` and lacks the new `source` discriminator. The shared helper handles this via an **optional** `source` parameter on `completeDemo()`. When called for `prospect_demos` the parameter is omitted and the column is untouched (existing default behavior). When called for `onboarding_demos`, the parameter is required and the column is written. Documented in `lifecycle.ts` JSDoc.

The other lifecycle columns (`generation_status`, `started_at`, `completed_at`, `generation_error`, `reviews_snapshot`, `generated_responses`) are identical in shape and the helper writes them uniformly.

**Two-PR rollout (see §10.0):** the lifecycle extraction lands as PR #1 (pure refactor, green tests on existing prospect demo path); the onboarding_demos additions land as PR #2.

### 3.3 Review selection: positive-with-moderate-tail (revised from Tier-3 review)

**Decision:** Filter SerpAPI results to `rating ≥ 3`. Build a 3-review portfolio with this preference order:

1. ≥1 5-star with body length > 50 chars (substance signal)
2. 4-star reviews (recent first)
3. 1 representative 3-star review at the end if available (the "can it handle my Karen problem" answer)

If after filtering there are zero `rating ≥ 4` reviews, the demo falls through to curated fallback. Strict 1-2-star signups don't get a real demo — the fallback bears the burden honestly.

**Telemetry requirement for Phase 1:** emit `fallback_rate_by_category` to Sentry/admin dashboard. If any category exceeds 5% in Phase 1 soak, that category is removed from demo eligibility before Phase 4 global flip.

**Why revised:** original "≥4 only" sidesteps the actual paywall question ("can this thing handle a 3-star?"). Including one moderate review with a thoughtful AI response is more informative than three cherry-picked 5-stars. Cap at one 3-star to avoid loss-aversion overshoot.

### 3.4 Polling: server-side render with widened poll window

**Decision:** Page is server-rendered from `onboarding_demos` row. `<DemoLoader>` client component polls `/api/onboarding/demo/status` every 2s up to **15 attempts** (30s ceiling), then surfaces a "still working — refresh in a minute" CTA.

**On `completed` transition** (or `failed`/`archived`), `<DemoLoader>` calls `router.refresh()` to re-trigger the SSR read of the full row payload. Without this the user stares at a skeleton until manual reload — explicitly a Tier-1 fix.

**Visibility-driven reset:** when the tab regains focus (`document.visibilityState === 'visible'`), the poll counter resets to 0. Bookmark-and-return scenarios get fresh poll budget without forcing a manual refresh.

**Why widened from 10s to 30s:** SerpAPI p95 (3-5s) + LLM (1-3s) + Railway worker cold start (2-5s) + outbox poller delay (up to 10s) = realistic median 8-15s, p95 closer to 25s. 5×2s = 10s burned the budget on cold-start alone.

### 3.5 Per-user uniqueness: partial unique on `completed`, race-aware completion

**Decision:**

- `CREATE UNIQUE INDEX onboarding_demos_one_completed_per_user ON onboarding_demos (user_id) WHERE generation_status = 'completed'`
- Redis sliding window `onboarding-demo:user:<userId>` — 3 attempts per 24h
- New terminal status `archived` — both for support-driven resets AND for the race-loser case below

**Race semantics — explicit:** the partial unique only fires at the `UPDATE → completed` step, not at INSERT. Two concurrent regenerates can both reach the worker before either completes. The first wins; the second's `completeDemo()` will throw Postgres `23505 unique_violation`.

`lifecycle.ts:completeDemo()` catches `23505` on the partial unique and:

1. Re-reads the demo row.
2. If a different demo row for the same `user_id` is already `completed` → marks the loser's row as `archived` (race outcome, not a generation failure) and completes the outbox cleanly.
3. If no `completed` row exists (impossible-but-defensive) → re-throws as a real failure for BullMQ retry.

This keeps the partial unique as the source-of-truth invariant while making completion idempotent across concurrent workers.

### 3.6 Re-entry: stale render with manual regenerate (v1) — auto-regen deferred to Phase 2

**Decision (revised after PR #2 plan review, 2026-05-03):** On `/onboarding/demo` page load:

- If latest `completed` demo's `completed_at < NOW() - 24h` → render the stale demo with a small "Last updated N days ago" footnote (not a banner — informational only). The manual `<RegenerateButton />` remains as the user-driven path for refresh.
- If `completed_at < 24h ago` → render the stale demo unchanged.
- Manual `<RegenerateButton />` consumes the 3/24h `onboarding-demo:user:<userId>` budget per §3.7.

**Auto-regen on revisit (Phase 2 follow-up):** the original spec called for SSR-side archive+insert+outbox tx when `isStale && budget-available`, with stale-render fallback on `CostCeilingExceeded`. Deferred from v1 because:

1. The manual button already covers bookmark-revisit at the cost of one click — not a hard UX failure.
2. The SSR-tx path adds ~80ms TTFB on every revisit and a non-trivial concurrency-safety surface (refresh-during-tx racing a second regen, error-recovery if the tx commits but the page render fails, etc.).
3. Phase 1 telemetry should validate whether revisit conversion drag is a real problem before paying that complexity. If `time_to_pay_after_revisit` regresses materially vs first-visit, implement in Phase 2.

**Implementation marker:** `src/app/onboarding/demo/page.tsx` carries a `// SCOPE: auto-regen ... deferred to Phase 2` comment at the `isStale` branch (see PR #2 Task 12) so the future implementer finds the exact insertion point.

**Cleanup poller cascade — explicit fix (Tier-1):** `CleanupAbandonedSignupsPoller.ts:155-167` currently treats demo refs as "invariant violation" and SKIPS deletion. The existing check protects `prospect_demos` (sales-tool data that must NOT be deleted with the user). For `onboarding_demos` the desired behavior is the opposite — those rows MUST be deleted with the user.

Implementation:

1. Modify the existing `has_demos` check to query **only** `prospect_demos`. Rename the variable to `has_prospect_demos` for clarity.
2. Inside the same tx, BEFORE the `users` row delete, add: `DELETE FROM onboarding_demos WHERE user_id = ${candidate.user_id}::uuid` (explicit cleanup, not just FK CASCADE).
3. FK `ON DELETE CASCADE` on `onboarding_demos.user_id` stays as defense-in-depth but is no longer the load-bearing path.

**PII retention (Tier-2):** add a separate cleanup pass in the poller for completed onboarding demos older than 30 days, regardless of business state — prevents indefinite SerpAPI author/text retention. Implemented as a second SELECT pass at the top of the poller's tick.

### 3.7 Abuse model: three rate-limit lanes + tightened input sanitization

**Rate-limit lanes (unchanged from v1):**

- `onboarding-demo:user:<userId>` — 3/24h
- `onboarding-demo:ip:<ipKey>` — 5/24h
- `onboarding-demo:global` — 200/h

**Tightened input schema (Tier-1):** `OnboardingStartSchema.businessName` is `z.string().min(1).max(80).regex(/^[^\n\r<>{}]+$/)`. Reasoning: the value flows into the LLM prompt and the curated demo display; demo output is one tweet away from public. Doesn't reuse the existing `businessNameSchema` because that one is permissive enough to cover legitimate post-pay edits where prompt-injection isn't load-bearing.

Email-domain cap deliberately dropped (false-positive rate on shared domains > prevented abuse).

All checks in API route layer before outbox INSERT. Redis-down fails closed (503 — see §3.8 boundary).

### 3.8 Cost guard: parallel `withOnboardingDemoCostGuard` helper, net-new threshold-crossing alerts

**Decision (revised from Tier-1 review):** Build a parallel helper, NOT an extension to existing `withCostGuard`. Existing `withCostGuard` (`cost-guard.ts:30-45`) hardwires `(businessId, subscriptionTier)` and throws TypeError without both. Pre-pay users have neither (they have `subscription_status='pending_payment'`, not a tier). Forking the Lua to add a lane parameter would mean every existing caller needs to be re-tested.

**Concrete deliverable:**

- New file `src/lib/costs/onboarding-demo-cost-guard.ts` exporting `withOnboardingDemoCostGuard(opts: { ipKey: string }, fn): Promise<T>`.
- New Redis key `cost:onboarding-demo:{date}` — pessimistic reserve 20¢ per demo (covers SerpAPI ~$0.01 + 3 LLM responses ~$0.015 + headroom).
- Reservation/release pattern mirrors `withCostGuard`: try-finally with explicit DECRBY on failure, finalize on success.
- No per-business sub-key; the demo lane is global because pre-pay users aren't tier-bucketed.
- Reconcile actuals to `api_costs` table with `cost_lane='onboarding_demo'` (existing `cost_lane` column accepts free-form discriminators — verified).
- Hard ceiling via `ONBOARDING_DEMO_DAILY_CENTS` env (default `1000` = $10/day). Override via Redis key `cost:onboarding-demo:override:cents`.

**Threshold-crossing alerts (also net-new):** new function `checkCostThreshold(lane: string, date: string, thresholds: number[]): Promise<{ crossed: number[] }>`. Single Lua script that does INCRBY then evaluates whether the previous-vs-current value crosses any threshold percentage of the ceiling. Returns the list of newly-crossed thresholds for this call. Worker logs to Sentry with severity per threshold (50% info, 90% warn, 100% error + admin email). **Spec owns this as net-new code — no existing pattern to inherit.**

### 3.9 Curated fallback: per-category, LLM-generated-once, frozen

(Unchanged from v1.) Per-category fallback in `src/lib/demos/fallback-content.ts`. One-shot script `scripts/generate-fallback-demos.ts` runs `generateDemo()` against a hand-written fixture in `src/lib/demos/__fixtures__/fallback-source-reviews.ts`. ~10-12 categories (restaurant, salon, dentist, gym, auto-repair, real-estate, contractor, retail, professional-services, healthcare-other, beauty-other, general-business). Output committed as TypeScript constant. `getFallbackDemo(category: string | null)` does case-insensitive prefix-match; unknown → `general-business`.

**Tier-3 disclosure constraint:** the "Sample reviews shown — connect after signup" disclosure lands at the worst paywall moment. Phase 1 telemetry from §3.3 governs this — if `fallback_rate_by_category > 5%` for any tier, that category is excluded from demo at Phase 4 (we'd rather show no demo than tank a category's conversion).

### 3.10 Setup checklist: 4 items, single CTE, dropped time-boxed framing

**Items (unchanged):**

1. **Connect Zernio** — completion = active row in `zernio_connections`. Sub-text "watching, no reviews yet" when connected AND no reviews ingested in 24h.
2. **Approve your first response** — completion = `responses.exists(business_id, status IN ('approved', 'posted'))`.
3. **Tune your voice** — completion = any of: `businesses.tone != 'professional and friendly'`, `products_services` non-empty, `array_length(staff_names) > 0`, `array_length(highlight_facts) > 0`, `array_length(avoid_facts) > 0`, `array_length(sample_responses) > 0`.
4. **Set notification preferences** — completion = `channel_enrollments.exists(business_id, channel != 'email' AND status = 'verified')`.

**Single CTE (Tier-2 fix):** all four computed in one query:

```sql
WITH checklist AS (
  SELECT
    EXISTS (SELECT 1 FROM zernio_connections WHERE business_id = $1 AND status = 'active') AS zernio_connected,
    EXISTS (SELECT 1 FROM responses WHERE business_id = $1 AND status IN ('approved','posted')) AS first_approval_done,
    (SELECT
       COALESCE(tone <> 'professional and friendly', false)
       OR COALESCE(products_services <> '', false)
       OR COALESCE(array_length(staff_names, 1) > 0, false)
       OR COALESCE(array_length(highlight_facts, 1) > 0, false)
       OR COALESCE(array_length(avoid_facts, 1) > 0, false)
       OR COALESCE(array_length(sample_responses, 1) > 0, false)
     FROM businesses WHERE id = $1) AS voice_tuned,
    EXISTS (SELECT 1 FROM channel_enrollments WHERE business_id = $1 AND channel <> 'email' AND status = 'verified') AS notification_prefs_set,
    (NOT EXISTS (SELECT 1 FROM reviews WHERE business_id = $1 AND created_at > NOW() - INTERVAL '24 hours')) AS no_recent_reviews
)
SELECT * FROM checklist;
```

One round-trip total. `zernio_watching_no_reviews = zernio_connected AND no_recent_reviews`.

**Render rule (revised — dropped time-box framing per Tier-3):**

- Header copy: "Get fully set up" (no time number — "10 minutes" was aspirational and the funnel may take longer for some users).
- localStorage `repworth.checklist.dismissedAt` carries the dismiss state.
- Card visible iff `!allComplete OR (allComplete AND !dismissed)`.

### 3.11 Stripe Payment Link state hand-off — verified, not deferred

**Status:** Verified upfront (Tier-1 promotion from old §12).

`buildPaymentLinkUrl()` (`src/lib/payments/payment-link.ts:48-50`) appends only `client_reference_id=businessId` and `prefilled_email`. The Stripe checkout session uses `client_reference_id` to identify the business on `checkout.session.completed`. Demo state lookup post-pay happens server-side at `/onboarding/demo` and `/onboarding/business` via `auth_id → users.id → onboarding_demos.user_id`. No demo identifier needs to round-trip through Stripe's URL or session metadata.

**Conclusion:** today's flow already preserves demo state across Stripe with zero changes to Stripe-side configuration. No new Stripe metadata, no new `client_reference_id` shape, no Stripe webhook changes. This is **asserted**, not "to validate on day 1."

---

## 4. Data model — migration 032

```sql
CREATE TABLE onboarding_demos (
  id                   UUID PRIMARY KEY,                 -- UUIDv7
  user_id              UUID NOT NULL
                         REFERENCES users(id) ON DELETE CASCADE,
  business_id          UUID NOT NULL
                         REFERENCES businesses(id) ON DELETE CASCADE,

  business_name        TEXT NOT NULL,
  category             TEXT,
  google_place_id      TEXT,
  google_maps_url      TEXT,

  generation_status    TEXT NOT NULL,
  started_at           TIMESTAMPTZ,
  completed_at         TIMESTAMPTZ,
  generation_error     TEXT,

  reviews_snapshot     JSONB,           -- shape: RawReview[] (rating, text, author_name, review_date, review_id?)
  generated_responses  JSONB,           -- shape: { reviewId: string, response: string }[] keyed positionally
  source               TEXT,            -- 'serpapi' | 'curated_fallback'; NULL until worker completes

  correlation_id       UUID NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                                        -- No trigger: every write MUST `SET updated_at = NOW()` explicitly

  CONSTRAINT onboarding_demos_status_check
    CHECK (generation_status IN ('queued','running','completed','failed','archived')),
  CONSTRAINT onboarding_demos_source_when_completed
    CHECK (generation_status <> 'completed' OR source IS NOT NULL)
);

-- Q3.5 invariant: at most one completed demo per user, ever.
-- Race-loser handling in lifecycle.ts:completeDemo (catch 23505).
CREATE UNIQUE INDEX onboarding_demos_one_completed_per_user
  ON onboarding_demos (user_id)
  WHERE generation_status = 'completed';

-- Hot path: "show me this user's latest demo" on /onboarding/demo
CREATE INDEX onboarding_demos_user_lookup
  ON onboarding_demos (user_id, created_at DESC);

-- Cleanup poller / cascade traversal
CREATE INDEX onboarding_demos_business_lookup
  ON onboarding_demos (business_id);

-- Tier-2 fix: matches prospect_demos pattern for admin observability of in-flight demos.
CREATE INDEX onboarding_demos_generation_inflight
  ON onboarding_demos (generation_status)
  WHERE generation_status IN ('queued', 'running');
```

**Apply mode:** transactional. Norbert runs in Supabase SQL editor (per project convention).

**Out of migration:** no new `responses.status` value, no `cost_lane` column change, no outbox topic enum change.

---

## 5. API surface

### 5.1 NEW: `POST /api/onboarding/start`

Replaces wizard Step 1 entry. Captures location + business name + place-prefill payload from client. Queues demo generation.

- **Auth:** Cookie-bound Supabase session, `users.role='owner'` filter at SQL boundary.
- **CSRF:** `assertSameOrigin`.
- **Subscription gate:** `pending_payment` only.
- **Schema (`OnboardingStartSchema` in `lib/shared/schemas.ts`):**
  ```ts
  {
    inputMode: 'autocomplete' | 'url',
    googlePlaceId?: string,
    googlePlaceAddress?: string,
    googleMapsUrl?: string,
    businessName: string,                        // tightened: .min(1).max(80).regex(/^[^\n\r<>{}]+$/)
    prefilledCategory?: string | null,           // from /api/signup/place-prefill (autocomplete branch)
    prefilledWebsite?: string | null             // ditto
  }
  ```
  XOR refine: exactly one of `googlePlaceId` (autocomplete) or `googleMapsUrl` (URL) must be present. `prefilledCategory` and `prefilledWebsite` only valid in autocomplete branch (refine rejects them otherwise).

- **Rate-limit:** 10/auth-id/hour strict.

- **Reservation + tx envelope (Tier-1 fix):** the cost-guard reservation lives OUTSIDE the Postgres tx but INSIDE a try/catch that compensates on tx failure:

  ```ts
  await checkDemoRateLimits(userId, ipKey);  // throws → 429
  const cleanupReservation = await reserveOnboardingDemoBudget();  // throws → 503; returns release fn
  try {
    await sql.begin(async (tx) => {
      // ...steps 1-6 below...
    });
  } catch (err) {
    await cleanupReservation.release();  // ALWAYS release on tx failure
    throw err;
  }
  // Success: reservation will be reconciled by the worker on completion.
  ```

- **Single tx (steps 1-6):**
  1. Advisory lock `<bizId>:activation`
  2. `SELECT ... FOR UPDATE` business row
  3. Idempotency guard: if `place_id_verified=true` OR `google_maps_url IS NOT NULL` → silent no-op (return existing demo redirect)
  4. `UPDATE businesses` with `name`, `google_place_id`, `place_id_verified`, `google_maps_url`, AND `category`, `website` (the latter two from `prefilledCategory`/`prefilledWebsite`, NULL if URL branch)
  5. URL branch only: INSERT `validate_place_id` outbox (existing topic, existing worker)
  6. INSERT `onboarding_demos` row (`generation_status='queued'`) + INSERT `job_outbox` row (`topic='onboarding_demo_response'`)

- **Response:**
  - `200 { redirectTo: '/onboarding/demo', demoQueued: true }` on success
  - `200 { redirectTo: '/onboarding/demo', demoQueued: false, reason: 'cost_ceiling' | 'rate_limit' }` if demo blocked but business onboarded — **business row is still committed; user proceeds to paywall without demo**
  - `409 { error: 'subscription_inactive' | 'already_started' }`
  - `429 { error: 'rate_limited' }` for the 10/hour outer limit only
  - `503 { error: 'rate_limit_unavailable' | 'redis_unavailable' }` strictly for transport failures (Tier-2 fix — cost-ceiling no longer 503s)

### 5.2 NEW: `GET /api/onboarding/demo/status`

Read-only status poll for `<DemoLoader>`.

- **Auth:** Cookie-bound; ownership scoped (`auth_id → users.id → onboarding_demos.user_id`).
- **Rate-limit:** 60/auth-id/minute soft (raised from 30 because Tier-2 widened the poll cap).
- **Response:**
  ```ts
  {
    status: 'queued' | 'running' | 'completed' | 'failed' | 'archived',
    completedAt?: string,
    source?: 'serpapi' | 'curated_fallback'
  }
  ```
  Status-only; full payload comes from SSR refresh after the page calls `router.refresh()`.

- **404** if no demo row OR row belongs to another user (no enumeration distinction).

### 5.3 NEW: `POST /api/onboarding/demo/regenerate`

- Same auth/CSRF/sub-gate posture as `/start`.
- Same reservation + tx envelope pattern as §5.1.
- Inside tx: archive the existing `completed` row, INSERT new `queued` row + outbox row.
- Consumes the same `onboarding-demo:user:<userId>` 3/24h budget.

### 5.4 MODIFIED: `POST /api/onboarding/business` — bifurcated schema

(Tier-2 fix.) The existing `BusinessOnboardingSchema` enforces XOR on `googlePlaceId`/`googleMapsUrl`. Post-pay we read those from the existing business row, so the schema must change.

**Concrete deliverable:** new `BusinessOnboardingPostPaySchema` in `lib/shared/schemas.ts`. Schema:

- `businessName` optional (defaults to existing row value)
- `googlePlaceId`/`googlePlaceAddress`/`googleMapsUrl` **forbidden** (zod refine rejects with `unexpected_field`)
- `tone`, `productsServices`, `staffNames`, `highlightFacts`, `avoidFacts`, `sampleResponses`, `category`, `website` — same as today

Route picks schema based on flag: `ONBOARDING_DEMO_ENABLED=true` → `BusinessOnboardingPostPaySchema`; else legacy `BusinessOnboardingSchema`. Both ship together.

New route guard: if business row has `place_id_verified=false AND google_maps_url IS NULL`, return `409 { error: 'onboarding_not_started', redirectTo: '/onboarding/start' }`.

### 5.5 MODIFIED: `GET /onboarding/business` (page)

Server-side: if no `google_place_id` AND no `google_maps_url` on business row, redirect to `/onboarding/start`. Wizard UI shifts from Step 1-2-3 to Step 1-of-2 (Profile) + Step 2-of-2 (Voice). `BusinessWizardClient` payload drops `googlePlaceId`/`googlePlaceAddress`/`googleMapsUrl`/`businessName`.

**Step 2 prefill source (Tier-2 fix):** `category` and `website` are written to the business row at `/start` time (§5.1 step 4) using values the client gathered from `/api/signup/place-prefill` before submitting `/start`. The post-pay wizard reads them as initial form values from server-side props — no re-fetch needed, no orphan empty fields.

### 5.6 Unchanged

`/api/onboarding/select-plan`, `/onboarding/payment-success`, all Zernio / publishing / approval routes.

---

## 6. Worker contract

### 6.1 NEW: `src/lib/demos/lifecycle.ts`

Pure functions, table-parameterized. The optional `source` parameter handles schema divergence:

```ts
type DemoTable = 'prospect_demos' | 'onboarding_demos';

export async function claimDemo(
  table: DemoTable,
  demoId: string,
  logger: WorkerLogger,
): Promise<'claimed' | 'already_terminal' | 'not_found' | 'reset_to_queued'>;

export async function completeDemo(
  table: DemoTable,
  demoId: string,
  outboxId: string,
  outboxAttempt: number,
  result: {
    reviews: RawReview[];
    responses: GeneratedResponse[];
    source?: 'serpapi' | 'curated_fallback';   // optional — omitted for prospect_demos
  },
): Promise<void>;
//
// Race semantics: catches Postgres 23505 unique_violation on the partial
// unique (only fires for onboarding_demos). On 23505:
//  - If a different completed row exists for same user_id → mark this row
//    `archived`, complete outbox cleanly. Race outcome, not a failure.
//  - Else → re-throw for BullMQ retry (defensive; should be unreachable).

export async function failDemo(
  table: DemoTable,
  demoId: string,
  outboxId: string,
  outboxAttempt: number,
  error: Error,
): Promise<void>;
```

Stale-running recovery (5min threshold), CAS transition, transactional outbox completion — centralized.

### 6.2 NEW: `worker/jobs/OnboardingDemoWorker.ts`

Handler for BullMQ topic `onboarding_demo_response`:

1. **Mock leak guard (Tier-2):** `if (process.env.MOCK_EXTERNAL_APIS === 'true' && process.env.NODE_ENV === 'production') throw new Error('MOCK_EXTERNAL_APIS must not be true in production')`. Fail-fast at the worker level.
2. `claimDemo('onboarding_demos', demoId)` (queued → running, race-safe).
3. Resolve Place ID if URL branch (reuse `resolvePlaceId`).
4. SerpAPI fetch via `fetchSerpApiReviews(placeId)`.
5. `selectQualifyingReviews(reviews, { rule: 'positive-with-moderate-tail' })` — 5-star-with-substance preferred, then 4-star recent, then 1 representative 3-star at the end (§3.3).
6. **SerpAPI-vs-fallback branch** — eligibility for the SerpAPI path requires **≥1 review with rating ≥ 4** in the selection output. Any other case (only 3-star reviews, only 1-2 star reviews, or SerpAPI terminal failure) falls through to `getFallbackDemo(category)`. The 3-star "moderate tail" only ships *alongside* a 4-or-5-star anchor; a pure 3-star demo is never shown.
   - SerpAPI path → `generateResponsesForReviews(reviews, business)` → `source='serpapi'`
   - Fallback path → `getFallbackDemo(category)` → `source='curated_fallback'`
7. `completeDemo('onboarding_demos', demoId, outboxId, attempt, { reviews, responses, source })`.
8. Cost-guard reconcile actuals via `withOnboardingDemoCostGuard` finalize path (§3.8); records to `api_costs` with `cost_lane='onboarding_demo'`.
9. Threshold check: `checkCostThreshold('onboarding-demo', date, [50, 90, 100])`. Newly-crossed thresholds → Sentry + admin email per §3.8.
10. On any uncaught failure: `failDemo(...)` + cost-guard release.

**Subscription guard (inverted):** skip if `subscription_status != 'pending_payment'`. Onboarding demos for active customers are nonsensical.

### 6.3 `generateDemo()` decomposition

Split into three single-purpose functions (Tier-1-adjacent — supports the pure-refactor PR):

- `fetchSerpApiReviews(placeId): Promise<RawReview[]>`
- `selectQualifyingReviews(reviews, opts): RawReview[]` — pure. Rules: `'newest'` (existing prospect path) and `'positive-with-moderate-tail'` (new).
- `generateResponsesForReviews(reviews, business): Promise<{ reviews, responses }>`

Existing `DemoGenerationWorker` becomes the composition `fetch → select(newest) → generate`. New worker uses `fetch → select(positive-with-moderate-tail) → generate` OR fallback.

### 6.4 Worker registration

New entry in worker bootstrap. `OutboxPoller` is topic-agnostic — no poller changes.

---

## 7. Frontend components

### 7.1 NEW: `src/app/onboarding/start/page.tsx` + `StartLocationClient.tsx`

Reuses the autocomplete + URL-toggle UI from existing `StepLocation.tsx`. Critical: client gathers `prefilledCategory` / `prefilledWebsite` from `/api/signup/place-prefill` BEFORE submitting `/start` (mirrors today's StepLocation behavior; the prefill fetch already exists). Submit payload includes prefill in the autocomplete branch.

Server page guards: email confirmed, `subscription_status='pending_payment'`, redirects active → `/onboarding/business`, past_due/cancelled → `/dashboard`. Flag-off → `notFound()`.

### 7.2 NEW: `src/app/onboarding/demo/page.tsx` + `PaywallWithDemoClient.tsx`

Server reads latest `onboarding_demos` row. Render branches:

- **null** → redirect to `/onboarding/start`
- **`completed`** + `completed_at < 24h ago` → `<DemoResultDisplay />` + `<PlanPicker />`
- **`completed`** + `completed_at > 24h ago` (v1) → render stale + footnote "Last updated N days ago"; user can click `<RegenerateButton />` to refresh manually (consumes 3/24h budget). Auto-regen deferred per §3.6.
- **`completed`** + `completed_at > 24h ago` (Phase 2 if shipped) → SSR awaits archive+insert+outbox tx with budget check; on `CostCeilingExceeded` falls through to the v1 stale-with-footnote render
- **`queued` | `running`** → `<DemoSkeleton />` + `<DemoLoader demoId>` (polls every 2s, max 15, calls `router.refresh()` on transition)
- **`failed`** → `<DemoFailedNotice />` + `<RegenerateButton />` + `<PlanPicker />` (paywall remains usable)
- **`archived`** → "no demo yet" state (regenerate UX)

`<DemoLoader>` adds visibility-driven reset: `document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') resetCounter(); })`.

`<DemoResultDisplay>` renders identical shape for `serpapi` and `curated_fallback` sources. Disclosure banner only when `source='curated_fallback'`: "Sample reviews shown — connect your account after signup to see your real ones."

**Post-pay landing copy (Tier-3, §20):** the `<PaymentSuccessClient />` redirects to `/onboarding/business` which now renders a one-line lead-in above the wizard:

> "You're in. Two quick questions to make responses sound like you, then we go live."

(Owns the post-pay continuity that today's payment-success page leaves implicit.)

### 7.3 NEW: `src/app/dashboard/SetupChecklist.tsx`

Server component reading the single CTE from §3.10. Header copy: **"Get fully set up"** (no time number). Sub-state `zernio_watching_no_reviews` renders inline sub-text on the Connect Zernio item.

`localStorage` dismiss flag (`repworth.checklist.dismissedAt`). Render iff `!allComplete OR (allComplete AND !dismissed)`.

### 7.4 MODIFIED: `BusinessWizardClient.tsx`

Drop Step 1. Steps become Step 1-of-2 (Profile) + Step 2-of-2 (Voice). `ProgressDots` 3 → 2 dots. Profile step receives `category` and `website` as initial values from server-side props (read from the business row, which was populated by `/start`).

### 7.5 Unchanged

`PaymentSuccessClient.tsx` already pushes to `/onboarding/business`.

---

## 8. Error handling matrix (revised)

| Failure | Detection | UX | Cost | HTTP |
|---|---|---|---|---|
| SerpAPI 5xx after retries | Worker → `getFallbackDemo()` | Demo renders, `source='curated_fallback'` | Reconciled (LLM only) | n/a |
| Zero qualifying reviews | `selectQualifyingReviews` → `[]` | Curated fallback | Reconciled | n/a |
| Place ID resolution fails | `resolvePlaceId` throws | `failDemo`, page renders `<DemoFailedNotice>`, paywall usable | Released | n/a |
| LLM both providers fail | Existing fallback chain throws | Same as above | Released | n/a |
| Worker crashes mid-generation | Stale-running recovery (5min) | Next poll resets queued, retries | Reservation persists; second attempt reconciles | n/a |
| Concurrent regenerate race wins+loses | `completeDemo` catches 23505 | Loser's row → `archived`; winner shows | Both reservations reconciled | n/a |
| Cost ceiling tripped at `/start` | `withOnboardingDemoCostGuard` throws `CostCeilingExceeded` | Page proceeds to paywall WITHOUT demo + explainer copy | None | **200** `demoQueued:false reason:'cost_ceiling'` |
| Per-user rate limit (3/24h) tripped | `checkDemoRateLimits` returns `{user: blocked}` | Same as above | None | **200** `demoQueued:false reason:'rate_limit'` |
| Outer 10/h rate limit tripped | Existing strict rate-limit | Page can't proceed | None | **429** |
| Redis transport failure | strict mode | Same as 429 (transport-level) | None | **503** |
| User bounces, business cleanup-poller deleted | `/start` redirects to `/signup` | Re-signup | N/A | n/a |
| User returns 8h later, demo `completed` | Stale render unchanged | Per §3.6 | None | n/a |
| User returns 36h later (v1) | Stale + "Last updated N days ago" footnote; manual `<RegenerateButton />` available | Per §3.6 | None until user clicks regen | n/a |
| User clicks `<RegenerateButton />` | Archive+insert tx via `/api/onboarding/demo/regenerate` | New reservation; consumes 3/24h budget | None on success | n/a |
| User returns 36h later (Phase 2 if shipped) | Auto-regen + skeleton if budget; stale + footnote if exhausted | Per §3.6 Phase 2 | New reservation if budget | n/a |
| Two tabs hit `/start` | Advisory lock + idempotency guard | Second silent no-op | One reservation | n/a |
| `MOCK_EXTERNAL_APIS=true` in dev | Worker uses mocks | Demo against mock data | Bypasses cost-guard | n/a |
| `MOCK_EXTERNAL_APIS=true` in production | Worker startup assertion throws (§6.2 step 1) | Worker fails fast | n/a | n/a |
| Concurrent /start tab race | Idempotency guard (place_id_verified or google_maps_url already set) | Silent no-op | One reservation | 200 |

**Defense in depth at `/start`** (in execution order): flag → CSRF → auth → owner-only → sub gate → schema (with regex sanitization) → outer per-auth rate limit → demo-specific rate limits → cost-guard reservation (in try/catch envelope) → DB tx with advisory lock + idempotency guard.

**Sentry:** all `failDemo` paths log with `demo_id`, `correlation_id`, `cost_lane='onboarding_demo'`. `checkCostThreshold` crossings emit at 50% (info), 90% (warn), 100% (error + admin email).

---

## 9. Testing strategy

### 9.1 Unit

- `lib/demos/lifecycle.ts` — claim/complete/fail with race + stale-recovery scenarios + 23505 race-loser path (Tier-1 #4 specific test)
- `lib/demos/select-qualifying.ts` — `'newest'` rule (pre-existing) + `'positive-with-moderate-tail'` rule (new); covers 5-star-with-substance preference, 1-3 star tail behavior, fallback-when-no-positive
- `lib/demos/fallback-content.ts` — `getFallbackDemo` for known + unknown categories; shape validation across all fixtures
- `lib/shared/schemas.ts → OnboardingStartSchema` — XOR refine, businessName regex sanitization (newlines, angle brackets, length cap)
- `lib/costs/onboarding-demo-cost-guard.ts` — reserve/release/finalize, threshold-crossing detection (50/90/100%), parallel-call atomicity

### 9.2 Integration (against `TEST_DATABASE_POOL_URL`)

Skip gracefully without env var.

- `/api/onboarding/start` — happy / replay / wrong status / URL branch / outer rate-limit (429) / cost-ceiling (200 with `demoQueued:false`) / Redis transport failure (503) / cost-reservation-cleanup-on-tx-failure (Tier-1 #3 specific)
- `/api/onboarding/business` — flag-off regression: with `ONBOARDING_DEMO_ENABLED=false`, route uses legacy `BusinessOnboardingSchema` and accepts `googlePlaceId`/`googleMapsUrl`/`businessName` (forbidden under PostPay schema). Confirms the §5.4 bifurcation doesn't break the existing flow during gradual rollout.
- `/api/onboarding/demo/status` — each lifecycle status; cross-user 404
- `/api/onboarding/demo/regenerate` — archive + insert in single tx; partial unique never fires; shared rate window
- `OnboardingDemoWorker` — happy SerpAPI / 0-qualifying fallback / SerpAPI 5xx fallback / Place ID URL branch / crash idempotency / 23505 race-loser path / MOCK leak guard fires in `NODE_ENV=production`
- `CleanupAbandonedSignupsPoller` cascade — explicit `DELETE FROM onboarding_demos`, `prospect_demos` skip preserved (Tier-1 #8); 30-day stale-completed cleanup pass

### 9.3 E2E (Playwright)

Skips without `TEST_DATABASE_POOL_URL`.

- End-to-end: signup → start → demo → plan → Stripe (mocked) → wizard Step 1-of-2 (Profile) → Step 2-of-2 (Voice) → dashboard with checklist
- Demo with MOCK mode returns mock review/response set
- Refresh while queued → skeleton; after worker tick → completed via `router.refresh()` (Tier-1 #6)
- Regenerate button: archives old, new demo renders
- Stale revisit (>24h): stale demo with "Last updated N days ago" footnote + manual regenerate button visible
- Setup checklist appears, single CTE roundtrip verified, dismiss state persists
- (Phase 2, deferred): auto-regen on revisit > 24h replaces stale; budget-exhausted variant falls through to footnote

### 9.4 Manual smoke (pre-rollout)

`docs/runbooks/onboarding-demo-launch-runbook.md`:

1. Real-API demo on staging — confirm SerpAPI cost ledger
2. Force SerpAPI failure → curated fallback + Sentry event
3. Burn 3/24h budget → 4th attempt blocked (200 with `demoQueued:false`)
4. Cost ceiling at $1 in staging → confirm threshold-crossing alerts at 50%, 90%, 100%
5. Cleanup poller dry-run on 7-day-old `pending_payment` user with completed demo → confirm cascade + 30-day stale pass

---

## 10. Rollout plan

### 10.0 Two-PR split (Tier-1 fix)

The lifecycle extraction must NOT ship in the same PR as the new feature.

**PR #1 — Pure refactor on `feat/lifecycle-extraction`:**
- Extract `lib/demos/lifecycle.ts` from `worker/jobs/DemoGenerationWorker.ts`
- Refactor `DemoGenerationWorker` to call helpers
- Decompose `generateDemo()` into `fetchSerpApiReviews` + `selectQualifyingReviews` + `generateResponsesForReviews`
- All existing prospect-demo tests stay green (the refactor's only test)
- Zero behavior change to admin/sales prospect demo flow
- Reviewable in isolation; merges first

**PR #2 — Onboarding demo flow on `feat/pre-paywall-demo`:**
- Migration 032
- New endpoints (`/start`, `/demo/status`, `/demo/regenerate`)
- Modified endpoints (`/business` schema bifurcation)
- New worker, new cost-guard helper, new pages, new components
- Cleanup poller modifications
- All flag-gated; ships behind `ONBOARDING_DEMO_ENABLED=false`

This split is mandatory per code review — conflating the refactor with a 2,000-line feature PR fails review on principle. PR #1 must merge before PR #2 opens against `main`.

### 10.1 Flag-off behavior (post-PR-#2-merge, pre-flip)

Entire feature invisible. Existing signup flow runs unchanged.

### 10.2 Phases

**Phase 1 — staging soak:**
- Migration 032 applied to staging
- Curated fallback content generated, committed
- `ONBOARDING_DEMO_ENABLED=true` on staging
- `ONBOARDING_DEMO_DAILY_CENTS=100` ($1/day, deliberately tight)
- 5-10 internal signups across categories (autocomplete + URL)
- Verify: real SerpAPI, cost ledger, threshold-crossing alerts at 50/90/100%, fallback fires, regenerate works, cleanup cascade, dashboard checklist
- **Phase 1 gate metric:** `fallback_rate_by_category < 5%` (Tier-3) — any category exceeding gets removed from demo eligibility before Phase 4
- 48h soak minimum

**Phase 2 — prod deploy, flag off:**
- PR #2 merged to `main`, deployed
- Migration 032 applied to production
- Flag stays `false` — production unchanged
- Verify migration is harmless on prod data
- **Legacy onboarded users sanity check:** users who completed the legacy 3-step wizard before this rollout already have `category` and `website` populated on their `businesses` row (same columns the legacy `StepLocation` prefill writes today). When the flag flips, those users would only re-enter the wizard for support-driven re-onboarding — at which point the new 2-step Profile/Voice wizard reads `category`/`website` from server-side props as initial values, same as fresh onboards. **Verify by impersonating a pre-flag-flip account in staging and confirming Step 1-of-2 prefills correctly.** Edge case is non-load-bearing — included for due diligence.

**Phase 3 — prod internal-only:**
- `ONBOARDING_DEMO_ENABLED=true`
- Staff allowlist via `ONBOARDING_DEMO_STAFF_EMAILS_CSV` env var, checked in `/onboarding/start`
- Production cost ceiling: `1000` ($10/day per §3.8)
- Norbert + staff sign up fresh, document rough edges
- 48h soak, daily cost ledger review, threshold alerts confirmed

**Phase 4 — global flip:**
- Drop staff allowlist gate
- `ONBOARDING_DEMO_ENABLED=true` global
- Excluded categories from Phase 1 gate metric stay excluded — they get the curated fallback unconditionally OR skip the demo if fallback rate was excessive
- Cost ceiling stays $10/day; weekly review
- Monitor 7 days: conversion, demo completion, fallback rate, cost burn, Sentry rate

### 10.3 Rollback

- **Soft:** flip flag to `false`. New visitors see today's flow. In-flight rows cleaned up by poller. Zero data loss.
- **Hard:** `DROP TABLE onboarding_demos CASCADE`. Cleanup-poller pre-delete tolerates absence (`IF EXISTS` defensive).

---

## 11. Documentation deliverables

- Migration 032 entry in `.claude/skills/migrations.md`
- New skill file `.claude/skills/onboarding-demo-cost-guard.md` documenting the parallel helper + threshold-crossing pattern
- New env vars in `.claude/skills/feature-flags.md`: `ONBOARDING_DEMO_ENABLED`, `ONBOARDING_DEMO_DAILY_CENTS`, `ONBOARDING_DEMO_STAFF_EMAILS_CSV` (Phase 4 removable)
- Runbook: `docs/runbooks/onboarding-demo-launch-runbook.md`
- ADR: `docs/adr/00X-onboarding-demo-and-journey-reorder.md` capturing four big architectural decisions (hybrid split, separate table, parallel cost-guard, fallback strategy + Phase 1 gate metric)

---

## 12. Open items deferred to implementation

- Exact `<RegenerateButton />` confirm-dialog wording
- ADR number assignment (depends on existing ADR sequence at implementation time — `docs/adr/` does not yet exist)
- Specific category list refinement based on actual customer mix (~10-12 is the target; final list authored when fixture is written)

(Removed: Stripe hand-off — verified in §3.11. Removed: visibility-driven reset — now in §3.4. Removed: 503 vs 200 — resolved in §8.)

---

## 13. Risks & mitigations (revised)

| Risk | Mitigation |
|---|---|
| SerpAPI cost spike if abuse caps fail open | `withOnboardingDemoCostGuard` $10/day ceiling + threshold alerts at 50/90/100% |
| Demo on stale review converts worse than no demo | Curated fallback always available; rating ≥ 3 with structured tier-break in §3.3 |
| Checklist as permanent decoration if Zernio webhooks lag | "Watching, no reviews yet" sub-text after 24h; checklist completion gates on connection only |
| Two demo flows (prospect vs onboarding) drift over time | Shared `lifecycle.ts` with documented schema divergence (§3.2); both tested against same lifecycle suite |
| Migration 032 cascade missing future code paths | Two-layer: explicit `DELETE FROM onboarding_demos` in cleanup poller + FK `ON DELETE CASCADE` safety net |
| Concurrent regenerate triggers UNIQUE violation | `completeDemo` catches 23505 and archives the loser (§3.5); race-loser test required |
| Concurrent regen wastes loser's LLM + SerpAPI cost | Bounded by 3/24h per-user cap (§3.7); race-loser cost burn is acceptable cost-of-doing-business and reconciles to `api_costs` like any successful demo. Worst case at the user cap: 3× full demo cost = ~75¢ |
| Curated fallback rate too high in a category | Phase 1 gate metric removes category before Phase 4 (§3.9, §10.2) |
| `MOCK_EXTERNAL_APIS=true` slips into production | Worker startup assertion fails fast (§6.2 step 1) |

---

## 14. Definition of done

- PR #1 (lifecycle extraction) merged with green tests, zero behavior change to prospect demo flow
- PR #2 (onboarding feature) merged behind flag off
- Migration 032 applied to staging and production
- All tests green (unit + integration + E2E)
- Curated fallback content committed
- Phase 1 gate metric satisfied (`fallback_rate_by_category < 5%` per category, OR exclusion list locked)
- Phase 4 reached (global flag flip)
- 7-day post-flip soak with no Sentry P1/P2 issues attributable to demo path
- Runbook + ADR + skill updates merged
- Conversion-rate baseline captured for comparison after 14 more days

---

## 15. Spec strengths to preserve through implementation

(From code review — these are the structurally-correct decisions that should not be re-litigated when scope pressure hits.)

- Hybrid pre-pay/post-pay split avoids touching the hard `subscription_status='active'` gate at `business/route.ts:115-120`.
- Advisory-lock `<bizId>:activation` reuse correctly serializes against Stripe webhooks + cleanup poller (`select-plan/route.ts:167-206`, `CleanupAbandonedSignupsPoller.ts:99-100`).
- Migration 032 number verified correct (head is 031).
- `archived` terminal status + partial-unique-on-completed self-heals the lifetime-UNIQUE trap.
- Demo responses isolated in `onboarding_demos.generated_responses` JSONB — the no-auto-posting invariant is structurally preserved (no FK to `responses`, no path through publisher worker).
- Three-lane rate-limiting + Redis-fails-closed + cost-guard ceiling = appropriately paranoid defense-in-depth.
- `source` discriminator + CHECK constraint prevents the "completed but unsourced" bug class entirely.
