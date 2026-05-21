# Onboarding Wizard Research — 2026-05-03

Multi-AI research synthesis on RepWorth's onboarding wizard: current-state map,
gap analysis, prioritized recommendations, and a concrete redesign proposal that
anticipates multi-location + multi-source without over-engineering MVP.

Two research rounds:
- **Round 1 (Discovery):** mapped the current journey, identified gaps, proposed
  the journey reshape and ReviewSource contract evolution.
- **Round 2 (Deep-Dive):** stress-tested Round 1 with concrete specs (demo
  mechanic, zero-downtime migration), validated against competitor signup
  walkthroughs (BirdEye / Podium / NiceJob / GatherUp), and corrected three
  load-bearing claims about multi-source API access in 2026.

---

# ROUND 1 — Discovery Synthesis

## 1. Executive Summary

The current onboarding takes payment **before** showing any product value, then
drops paid users on a dead dashboard with the critical Zernio connect step
hidden behind self-discovery. The wizard's most product-defining input
("Voice") is labeled optional and visually skippable, while Premium tier
markets a **multi-location feature that doesn't exist in the schema**
(credibility risk). The fix is structural, not cosmetic: reshape the journey
into *account-level setup → loop(connect-source → pick-location → confirm) →
dashboard with persistent checklist*, build that skeleton with N=1 today, and
multi-location + multi-source becomes a UX configuration change later instead
of a multi-week re-architecture.

## 2. Current-State Map (verified against the codebase)

```
/signup ─┬─ email/password ──► /signup/check-email ──► /signup/finish ┐
         └─ Google OAuth ─────────────────────────────► /signup/finish ┘
                                                             │
                                                             ▼
                                                    /onboarding/pay
                                            ($99 founding | $149 std | $199 premium*)
                                                             │
                                                             ▼
                                              Stripe Payment Link (external)
                                                             │
                                                             ▼
                                                /onboarding/payment-success
                                              (webhook → subscription_status='active')
                                                             │
                                                             ▼
                                                /onboarding/business  ◄── 3-step wizard
                                                  Step 1: StepLocation (autocomplete | URL paste)
                                                  Step 2: StepProfile (name*, category, website)
                                                  Step 3: StepVoice (skippable: tone, staff, facts, samples)
                                                             │
                                                             ▼
                                                       /dashboard  ◄── DEAD STATE
                                                     (no Zernio = no reviews)
                                                             │
                                            ┌────────────────┼─────────────────┐
                                            ▼                ▼                 ▼
                              /dashboard/connect    /settings/channels    (wait for webhooks)
                              (Zernio OAuth)        (only email auto)     (silent latency)
                                    │
                                    ▼
                              /dashboard/connect/select-location
                              (single GBP location pick)
```

**Key code-level facts:**

- `businesses` table conflates *account* and *location*: singular
  `google_place_id`, `place_id_verified`, `google_maps_url`, plus per-location
  voice fields.
- `users.business_id` is 1:1 — no multi-tenancy of locations.
- `ReviewSource` interface has `fetchReviews(placeId)` — single placeId input.
- `ReviewIdentity.provider` enum is `'serpapi_poll' | 'zernio'` —
  transport-leaky, hardcoded to Google sources.
- `BusinessOnboardingSchema` accepts only Google place ID/Maps URL.
- Premium tier copy claims "Multi-location" — **the schema cannot store a
  second location**.
- `createBusinessTx` self-serve path writes a placeholder `(pending setup)`
  row at signup; the wizard UPDATEs it. Paid-then-bounced users leave orphan
  placeholders.

## 3. Key Themes (research synthesis)

### Theme 1 — "Aha-then-paywall" wins for self-serve SMB

TTFV targets in 2025/2026 cluster at **<2 min first value, 5–15 min full
setup**. Paywall placement converts best **after** an aha moment unless
trial-fraud risk is high — which it isn't for RepWorth (real-name,
real-business buyers). RepWorth currently paywalls before *any* product
demonstration. [Inference] This is conversion debt.

### Theme 2 — Persistent dashboard checklist is the modal pattern

Linear, Stripe, Notion, Intercom converge: a thin first-session wizard that
gets users to one meaningful action, plus a docked "Setup checklist" on the
dashboard for everything else, pinned until 100% complete. RepWorth has no
checklist — users who skip Voice or never connect Zernio have nothing telling
them they're incomplete.

### Theme 3 — Account/Location/Asset is the industry data model

Toast (Restaurant Group → Restaurant), Square (Merchant → Location), Mindbody
(Site → Location), BirdEye/Podium (Account → Business Profile → Listing) all
separate *who pays* from *what is monitored*. Single-location SaaS that
"renames businesses to locations" later breaks mental models. The clean path:
keep `businesses` = account, add `locations` table, set `default_location_id`
for back-compat.

### Theme 4 — Voice/tone wants brand-default + per-location override

Multi-location chains want centralized brand consistency *and* local manager
personalization. The dominant pattern is sparse JSONB overrides cascading from
account-level defaults — like CSS or Kubernetes ConfigMaps. Storing voice only
at business or only at location forces duplication or destroys local color.

### Theme 5 — Read and write capabilities are asymmetric per source

Yelp explicitly forbids automated reply posting (TOS). TripAdvisor reply API
is partner-only (months of approval). Facebook reply needs Page Access Tokens
(originally claimed 60-day expiry — **see Round-2 correction C1 below**).
Google via Zernio is the *only* fully-writable broker today. The
architectural mistake is conflating ingestion and publishing into one
`ReviewSource` interface; the right shape is `ReviewIngestionAdapter` +
`ReplyPublishingAdapter` + a declarative `ReplyCapability` descriptor.

### Theme 6 — Source-agnostic identity needs a transport/provider split

RepWorth's `ReviewIdentity.provider = 'serpapi_poll' | 'zernio'` mixes *which
platform* with *how received*. Industry pattern: `provider` ∈ {google, yelp,
tripadvisor, trustpilot} and `ingestionTransport` ∈ {zernio_webhook,
serpapi_poll, yelp_fusion_poll, …} as separate fields.

## 4. Gap Analysis — Top 11 Friction Points

| # | Friction | Severity | UX principle violated |
|---|---|---|---|
| 1 | Dashboard delivers no value at handoff — Zernio unconnected, no reviews, no checklist | **Blocker** | No first-meaningful-experience |
| 2 | Payment precedes any product demonstration ($99–$199 paid blind) | **Blocker** | No progressive value reveal |
| 3 | Premium tier markets "multi-location" feature that doesn't exist in code | **Blocker** | Trust violation; refund/chargeback risk |
| 4 | "Voice" step is labeled optional — most product-defining input gets skipped | **Major** | Misaligned salience; form fatigue |
| 5 | No status feedback during async Maps-URL place_id validation | **Major** | Visibility of system status (Nielsen #1) |
| 6 | Google OAuth path still routes through `/signup/finish` — duplicate-feeling form | **Major** | Redundancy; broken OAuth expectation |
| 7 | Zernio connect post-dashboard, self-discovered | **Major** | Mystery-meat navigation |
| 8 | Webhook latency (hours-days) with no "what to expect" copy | **Major** | Visibility of system status |
| 9 | Channel preferences buried at `/settings/channels` — users don't know SMS/Telegram exist | **Minor** | Discoverability |
| 10 | Bounced post-payment users leave orphan placeholder businesses | **Minor (UX) / Major (data)** | No graceful recovery |
| 11 | No first-approval tutorial — first real review arrives cold | **Minor** | Onboarding-to-habit bridge missing |

## 5. Recommendations — P0 / P1 / P2

### 🔴 P0 — Blockers, ship before next paid signup

**P0-1. Reorder the journey: Connect Google before payment.**
New sequence: signup → **Zernio OAuth → location pick** → business confirm →
**demo response on a real past review** → paywall → voice tuning → dashboard.
The Zernio `listLocations` call already returns name + category + address — it
can replace `StepLocation` + `StepProfile` for OAuth users. Keep Place
Autocomplete as fallback for users who decline Google connect.

> **Round-2 amendment:** demo source is **SerpAPI**, not Zernio (see §R2-4.1).

**P0-2. Generate one demo response on a real review *before* the paywall.**
After connect+location pick, fetch one recent review and run it through your
response pipeline (one LLM call ≈ $0.0001). Show on `/onboarding/pay` above
the tier cards: *"Here's what we just wrote for [reviewer]. Pick a plan to
start posting these."* Single highest-leverage conversion mechanic.

**P0-3. Fix the Premium "multi-location" claim immediately.**
Either remove the bullet or rename the tier ("Priority + 50-review backfill").
One copy edit in `PlanPickerClient.tsx`. Shipping a paywall that promises a
feature your schema can't store is a credibility bomb.

**P0-4. Build a persistent Setup Checklist on `/dashboard`.**
Four items, each with state (done / pending / skipped):
- ☐ Connect Google Business
- ☐ Pick location
- ☐ Tune your voice
- ☐ Approve your first response

Pinned card with progress ring. Mirrors Stripe / Linear / Intercom pattern.
Single highest-leverage UI addition you can make.

### 🟡 P1 — Major friction, ship within 2 sprints

**P1-5. Reframe `StepVoice` as required-but-fast.**
Drop "Skip for now". Reduce to three required questions: brand-voice radio
(warm/professional/playful/concise), top 3 things to mention when praised
(chips), one thing to never say. Move staff names / products / sample
responses to a post-onboarding "Refine your voice" page accessible from the
checklist.

**P1-6. Add async-validation feedback on Maps URL paste.**
Inline state machine: spinner ("Looking up your business…") → confirmation
card (thumbnail + name + address + "Is this you?") OR fallback to
autocomplete. Disable Next while validation in flight.

**P1-7. Unify post-OAuth and post-OTP paths.**
Audit `/signup/finish`: skip it entirely for Google OAuth users (name +
email already provided), route them directly to the connect step.

**P1-8. Add "what to expect" copy after Zernio connect.**
*"We're now watching [Business Name]. New reviews appear here within minutes
of being posted. Historical reviews from the last 90 days arrive over the
next 1–24 hours."*

### 🟢 P2 — Polish, opportunistic

**P2-9.** Surface channel choice as a checklist item ("Where should we ping
you?") with email pre-checked and SMS/Telegram/WhatsApp as opt-ins.

**P2-10.** Seed one fake review + AI response in approval state on first
dashboard visit. User clicks Approve once, learns the loop in 30 seconds.

**P2-11.** Recover orphan businesses: resume wizard from last completed step
on re-entry; 7-day cleanup poller for paid-but-abandoned rows (mirror
existing `CleanupAbandonedSignupsPoller`).

## 6. Concrete Redesign — Future-Shape Journey

Multi-location + multi-source ready, N=1 today:

```
/signup ──► /signup/finish (skip if OAuth) ──► /onboarding/sources/connect
                                                         │
                                              ┌──────────┴──────────┐
                                              ▼                     ▼
                                    Google (Zernio OAuth)    "Paste Maps URL"
                                              │                     │
                                              └─────────┬───────────┘
                                                        ▼
                                          /onboarding/locations/select
                                                        ▼
                                          /onboarding/locations/confirm
                                          (name, category, website pre-filled)
                                                        ▼
                                          /onboarding/preview
                                          (REAL demo response — paywall trigger)
                                                        ▼
                                                /onboarding/pay
                                                        ▼
                                            Stripe Payment Link
                                                        ▼
                                          /onboarding/voice
                                          (account-level: 3 required Q's)
                                                        ▼
                                          /dashboard
                                          ┌──────────────────────────────┐
                                          │ Setup Checklist (3/4 done)   │
                                          │ ☑ Connect Google             │
                                          │ ☑ Pick location              │
                                          │ ☑ Tune voice                 │
                                          │ ☐ Approve first response →   │
                                          └──────────────────────────────┘
```

For multi-location later: `/onboarding/locations/add` becomes a re-entrant
flow accessible from the dashboard's "Add location" button (Premium tier).

---

# ROUND 2 — Deep-Dive Findings

The Round-1 report had three load-bearing claims that the deep-dives
**corrected**. Those are flagged first, then the new specifics layer on top.

## R2-1. Executive Summary

The original recommendation shape (move connect before pay → demo on real
review → paywall → voice → checklist) survives validation: it independently
matches the dominant Podium/NiceJob/GatherUp pattern, and the
demo-on-real-review is the **single differentiator no competitor offers**.
But the deep-dives changed three specifics:

1. The demo should run against **SerpAPI pre-Zernio**, not Zernio post-OAuth
   — Zernio finalize blows past TTFV.
2. The multi-location migration's "dual-write" Phase 2 is fragile — replace
   with **trigger-driven outbox propagation**.
3. The multi-source roadmap needs surgery — **Facebook reviews API is
   deprecated as of Graph v22**, Yelp Respond-to-Reviews is enterprise-only.
   Realistic source order: Google → Yelp(compose-and-copy) →
   Trustpilot(customer-gated) → TripAdvisor(deferred). Facebook removed.

Two new UX adjustments emerged from the competitor walkthrough: add **Google
Sign-In as primary auth** (NiceJob pattern), and consider moving **voice
tuning before the demo** so the demo shows tuned output.

## R2-2. Corrections to Round-1 Claims

| # | Round-1 said | Round-2 found | Impact |
|---|---|---|---|
| **C1** | Facebook reply needs Page Access Tokens (60-day expiry) | **Page tokens don't normally expire**; the 60-day window is User tokens. More importantly, **Graph API v22 deprecated `/{page-id}/ratings` and recommendation reads** entirely. Page rating webhooks no longer fire. | **Remove Facebook from multi-source roadmap.** Reframe FB story as "managed natively in Meta Business Suite, not RepWorth." |
| **C2** | Yelp Fusion has no reply endpoint; reply is owner-portal only | **Yelp Respond-to-Reviews API exists** but is gated to Insights Program partners (enterprise-tier mutual customers only); 20 replies/day/location cap; partner-employees explicitly disallowed from posting on behalf of customers. | Yelp story is **"compose-and-copy"** in-product — RepWorth drafts reply, owner pastes into Yelp. Document the policy reason. |
| **C3** | Phase 2 of multi-location migration: dual-write to `businesses` + `locations` | **Application dual-write is the failure mode**. Better: trigger on `businesses` UPDATE writes a `topic='location_sync'` row to `job_outbox`; worker propagates to `locations`. Single source of truth, atomic, retried, observable. | Aligns with existing transactional-outbox invariant. **Required correction** — original plan would silently desync. |

## R2-3. Key Themes (Round-2)

### R2-Theme 1 — The demo source is SerpAPI, not Zernio

Zernio finalize takes "seconds-to-minutes" (per spec §3.3.5), which blows
past the <2-minute TTFV target *and* hides the demo behind OAuth consent —
the highest-friction step in the funnel. SerpAPI lookup against the
`placeId` resolved by PlaceAutocomplete returns the most-recent review in
2–4s pre-OAuth, costs $0.005/lookup, and gives the demo "this is *your*
business's *real* review" without making OAuth the gating event.
Curated-by-category is the fallback when SerpAPI returns zero reviews (new
businesses).

### R2-Theme 2 — Cost is a non-issue; abuse model is the real constraint

Per-attempt cost: SerpAPI $0.005 + GPT-4o-mini ~$0.0001 = **$0.0051**. At
1000 signups/day, worst-case is **~$153/month**. The cost-guard ceiling
isn't a concern. The real constraint is bot abuse generating free demos —
solved by gating behind the existing email OTP (already mandatory for
self-serve) plus three hard caps:

- 1/user lifetime (DB unique on `onboarding_demos.user_id`)
- 3/IP/24h (Upstash sliding window)
- 5/email-domain/24h
- Global circuit breaker at 200/hour falling back to curated.

### R2-Theme 3 — Migration zero-downtime hinges on three Postgres techniques

The deep-dive identified three specific Postgres patterns that prevent the
multi-location migration from causing AccessExclusiveLock stalls or silent
desync:

- **Trigger-on-INSERT** in `businesses` to auto-create default location,
  eliminating the new-signups-during-backfill race.
- **`NOT VALID` CHECK → `VALIDATE CONSTRAINT` → `SET NOT NULL`** sequence
  for `reviews.location_id NOT NULL` — avoids AccessExclusiveLock, only
  takes ShareUpdateExclusive (concurrent writes proceed).
- **Versioned outbox payloads** (`_v: 1 | 2`) with normalize-on-read in
  workers, instead of "drain the queue before cutover."

### R2-Theme 4 — Proposal aligns with SMB self-serve pattern; one tunable

Across BirdEye / Podium / NiceJob / GatherUp / Reputation.com signup flows,
the dominant SMB pattern is: 14-day free trial (no CC) → email verify →
wizard with Google connect early and pre-paywall → flat-or-tiered pricing →
in-product checklist. RepWorth's proposed journey matches Podium / NiceJob /
GatherUp on every dimension. The competitor walkthrough flagged one tunable:
**voice tuning placed post-paywall means the demo response is generated with
default voice.** A 30-second voice-tuning slider before the demo would make
the demo show tuned output, materially lifting conversion. Worth A/B testing.

### R2-Theme 5 — Multi-source roadmap is far smaller than originally drawn

After verifying current API access in 2026:

- **Google** (Zernio) — solved. Strategic risk: file direct-GBP application
  now even though queue is months-long, for BATNA against Zernio price hike
  in 12–24 months.
- **Yelp** — ingest 3-excerpt sentiment via Fusion (free, instant);
  compose-and-copy reply UI; no automation possible at SMB tier.
- **Trustpilot** — customer-gated. Build adapter only when an inbound
  customer already has the Business Plan + API add-on. Zero R&D risk if
  scoped this way.
- **TripAdvisor** — vertical-gated (hospitality only); 5-review read ceiling
  makes ingest barely worth it; defer until ≥10 paying hospitality customers
  + someone owning partner intake.
- **Facebook** — **removed.** v22 deprecated reads and webhooks; Meta lags
  its own docs but the changelog is authoritative.

## R2-4. Concrete Specifications

### R2-4.1. Pre-paywall demo: full implementation plan

**Storage** — new migration **032**:

```sql
CREATE TABLE onboarding_demos (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  place_id text NOT NULL,
  source_review jsonb NOT NULL,           -- NormalizedReview shape
  source_origin text NOT NULL,            -- 'serpapi' | 'curated'
  generated_response text,
  status text NOT NULL DEFAULT 'pending', -- pending | ready | failed
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX idx_demos_cleanup ON onboarding_demos(created_at) WHERE status != 'ready';
```

**Flow:**

1. Wizard "Confirm business" → Next.js API `/api/onboarding/demo` →
   validates email confirmed + rate limits + writes `onboarding_demos` row
   (`status=pending`) + `job_outbox` entry **in one transaction** (outbox
   invariant).
2. OutboxPoller dispatches to `onboarding_demo_response` BullMQ queue on
   Railway (LLM invariant: workers, not Vercel).
3. Worker: SerpAPI
   `engine=google_maps_reviews&place_id=X&num=1&sort_by=newest` → normalize
   → ResponseGenerator in **demo mode** (skip subscription guard; explicit
   `pending_payment` carve-out matching existing admin-demo path).
4. Paywall page reads `onboarding_demos` server-side; client polls
   `/api/onboarding/demo/status` every 1.5s, max 30s. **Polling, not SSE** —
   Vercel serverless caps SSE at 60s, PgBouncer churn known issue, p95
   latency is 3–5s anyway.

**Failure handling:** LLM 429/timeout → retry once → fall through to curated
template (status still `ready`, owner never sees failure). Refresh
mid-generation: read current row, never re-trigger (`user_id UNIQUE` makes
re-enqueue 409).

**Security:** React text-node escaping (no `dangerouslySetInnerHTML`);
1500-char length cap on review text; rate-limit IPs hashed with server
secret before Redis storage (GDPR posture); `auth_id` from Supabase session,
never trust client `userId`.

**Conversion measurement:** `users.experiment_bucket` for sticky 50/50
split. Baseline 8% → MDE 5pp, α=0.05, power 0.80, two-sided → **n=610/arm,
~1,500 total**. ~50 days at 30/day, ~2 weeks at 100/day. Pre-register:
primary metric `paid` within 24h of signup.

**Ship behind flag** `ONBOARDING_DEMO_ENABLED`. Week 1 staff-only at 100%
treatment; Week 2 open A/B 50/50.

### R2-4.2. Multi-location migration — corrected plan

**Phase 1 — Migration 032 (DDL only, NO backfill in tx):**

```sql
CREATE TABLE locations (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name text NOT NULL,
  place_id text,
  formatted_address text,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX locations_business_id_default_idx
  ON locations (business_id) WHERE is_default = true;

CREATE TABLE location_review_sources (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  source_type text NOT NULL,          -- 'google' | 'yelp' | 'trustpilot' | 'tripadvisor'
  external_id text,
  metadata jsonb,
  connected_at timestamptz,
  UNIQUE (location_id, source_type)
);

ALTER TABLE businesses ADD COLUMN default_location_id uuid REFERENCES locations(id);

-- Trigger eliminates new-signup race during backfill
CREATE OR REPLACE FUNCTION ensure_default_location() RETURNS trigger AS $$
DECLARE new_loc_id uuid;
BEGIN
  INSERT INTO locations (business_id, name, place_id, formatted_address, is_default)
  VALUES (NEW.id, NEW.name, NEW.google_place_id, NEW.google_maps_url, true)
  RETURNING id INTO new_loc_id;
  INSERT INTO location_review_sources (location_id, source_type, external_id)
  VALUES (new_loc_id, 'google', NEW.google_place_id);
  UPDATE businesses SET default_location_id = new_loc_id WHERE id = NEW.id;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_business_default_location
  AFTER INSERT ON businesses FOR EACH ROW
  EXECUTE FUNCTION ensure_default_location();
```

**Backfill** (separate idempotent script, NOT in 032; chunks of 500,
`WHERE default_location_id IS NULL` guards re-run safety; trigger handles
new businesses created mid-backfill):

```sql
-- Run as a loop in worker code or a psql DO block. Chunk = 500 rows.
-- 500 rows × ~3ms/insert ≈ 1.5s; well under 8s PgBouncer timeout.
DO $$
DECLARE cursor_id uuid := '00000000-0000-0000-0000-000000000000';
DECLARE batch_count int;
BEGIN
  LOOP
    WITH batch AS (
      SELECT id, name, google_place_id, google_maps_url
      FROM businesses
      WHERE id > cursor_id AND default_location_id IS NULL
      ORDER BY id LIMIT 500
    ),
    new_locs AS (
      INSERT INTO locations (business_id, name, place_id, formatted_address, is_default)
      SELECT id, name, google_place_id, google_maps_url, true FROM batch
      ON CONFLICT DO NOTHING
      RETURNING id, business_id
    ),
    new_sources AS (
      INSERT INTO location_review_sources (location_id, source_type, external_id)
      SELECT nl.id, 'google', b.google_place_id
      FROM new_locs nl JOIN businesses b ON b.id = nl.business_id
      ON CONFLICT (location_id, source_type) DO NOTHING
      RETURNING 1
    )
    UPDATE businesses b SET default_location_id = nl.id
    FROM new_locs nl WHERE b.id = nl.business_id
    RETURNING b.id INTO cursor_id;
    GET DIAGNOSTICS batch_count = ROW_COUNT;
    EXIT WHEN batch_count = 0;
    PERFORM pg_sleep(0.05); -- breathe
  END LOOP;
END $$;
```

**Phase 2 — Code-only, trigger-driven outbox propagation (NOT dual-write):**

- Application writes only to `businesses`, unchanged.
- `AFTER UPDATE ON businesses` trigger inserts `job_outbox` row with
  `topic='location_sync'`.
- Worker normalizes and propagates to `locations`.
- `location_drift` view monitors mismatches; cutover gate = drift = 0
  sustained 48h + outbox depth = 0.

```sql
CREATE VIEW location_drift AS
SELECT b.id AS business_id, b.name AS biz_name, l.name AS loc_name,
       b.google_place_id AS biz_place, l.place_id AS loc_place
FROM businesses b
JOIN locations l ON l.id = b.default_location_id
WHERE b.name IS DISTINCT FROM l.name OR b.google_place_id IS DISTINCT FROM l.place_id;
```

**Phase 3 — Migration 033 + 034:** Add `reviews.location_id` nullable +
`CREATE INDEX CONCURRENTLY`; chunked backfill in 5000-row batches; then the
**`NOT VALID` CHECK → `VALIDATE` → `SET NOT NULL`** sequence (PG12+
piggybacks on the validated CHECK to skip the table scan):

```sql
-- Step 1 (fast, ShareUpdateExclusive — concurrent reads/writes proceed)
ALTER TABLE reviews ADD CONSTRAINT reviews_location_id_not_null
  CHECK (location_id IS NOT NULL) NOT VALID;

-- Step 2 (slow, but only ShareUpdateExclusive — no write blocking)
ALTER TABLE reviews VALIDATE CONSTRAINT reviews_location_id_not_null;

-- Step 3 (PG12+: SET NOT NULL piggybacks on the validated CHECK, no rescan)
ALTER TABLE reviews ALTER COLUMN location_id SET NOT NULL;
ALTER TABLE reviews DROP CONSTRAINT reviews_location_id_not_null;
```

Versioned outbox payloads (`_v: 1 | 2`) with normalize-on-read:

```typescript
type OutboxPayloadV1 = { review_id: string; business_id: string };
type OutboxPayloadV2 = { review_id: string; business_id: string; location_id: string };
type OutboxPayload = (OutboxPayloadV1 | OutboxPayloadV2) & { _v: 1 | 2 };

function normalize(p: OutboxPayload): OutboxPayloadV2 {
  if (p._v === 2) return p;
  return { ...p, location_id: resolveDefaultLocation(p.business_id), _v: 2 };
}
```

**Authorization belt-and-suspenders** during cutover: every location-scoped
query also asserts `l.business_id = $auth_business_id`. Drop in Phase 4.

```sql
SELECT r.* FROM reviews r
JOIN locations l ON l.id = r.location_id
WHERE r.location_id = $1 AND l.business_id = $2; -- $2 = auth context
```

**Phase 4 — Migration 035+:** Drop redundant columns from `businesses`
(`name`, `google_place_id`, `google_maps_url`); ship multi-location UI;
Stripe quantity-based subscription line item; activate `user_location_roles`
for chains.

**Rollback paths:**

- Phase 2 is code-only rollback (locations table sits unused, trigger keeps
  populating harmlessly).
- Phase 3 NOT NULL rollback is `ALTER TABLE reviews ALTER COLUMN location_id
  DROP NOT NULL` (fast, ShareUpdateExclusive).
- Phase 4 (drop redundant columns) is irreversible — gate on 30 days stable
  Phase 3.

**Phase-by-phase gantt:**

| Phase | Migration | Code | Prerequisites | Exit Criteria | Duration |
|---|---|---|---|---|---|
| 1 | 032: locations + trigger + DDL | none | Vitest green; staging soak 24h | Backfill complete; drift view = 0; new signups auto-create location for 48h | 3–5 days |
| 2 | none | Outbox `location_sync` reconciler; payload V2; shadow-reads | Phase 1 exit met | Outbox lag <30s p99; drift = 0 sustained 48h; canary business_id reads from locations cleanly 72h | 1–2 weeks |
| 3a | 033: `reviews.location_id` nullable + index CONCURRENTLY | Workers write `location_id` on new reviews | Phase 2 exit met | Column exists; new reviews have `location_id`; backfill complete | 2–3 days |
| 3b | 034: NOT VALID CHECK → VALIDATE → SET NOT NULL | Workers scope by `location_id`; auth uses `l.business_id = $auth` belt | Phase 3a backfill; zero NULL rows for 24h | NOT NULL active; no crash spike; outbox V1 drained | 3–5 days |
| 4 | 035+: drop `businesses.{name, google_place_id, google_maps_url}`; multi-location UI | Multi-location wizard, per-location response settings | Phase 3b stable 30d | Feature live; rollback window closed | 2+ weeks |

### R2-4.3. ReviewSource adapter shape (no breaking change to Zernio)

```typescript
interface ReviewIngestionAdapter {
  readonly provider: 'google' | 'yelp' | 'trustpilot' | 'tripadvisor';
  readonly mode: 'webhook' | 'poll';
  fetchReviews?(conn: SourceConnection, since?: Date): Promise<NormalizedReview[]>;
  parseWebhook?(headers: Headers, body: unknown): Promise<NormalizedReview[]>;
  verifyWebhookSignature?(headers: Headers, raw: string): boolean;
}

interface ReplyPublishingAdapter {
  readonly provider: ReviewProvider;
  readonly capability: ReplyCapability;
  publishReply?(conn: SourceConnection, identity: ReviewIdentity, reply: string): Promise<PublishResult>;
}

type ReplyCapability =
  | { kind: 'api'; supportsEdit: boolean; supportsDelete: boolean }       // Trustpilot, future direct-GBP
  | { kind: 'broker'; brokerName: string }                                  // Zernio (Google today)
  | { kind: 'manual'; instructionsUrl: string }                             // Yelp compose-and-copy
  | { kind: 'unsupported'; reason: string };                                // TripAdvisor

interface ReviewIdentity {
  provider: ReviewProvider;              // platform: google | yelp | trustpilot | tripadvisor
  ingestionTransport: IngestionTransport; // how received: zernio_webhook | serpapi_poll | yelp_fusion_poll | trustpilot_poll
  externalBusinessId: string;
  externalReviewId: string;
  contentHash: string;                   // dedup fallback
}
```

Zernio path becomes the reference implementation:
`(provider: 'google', ingestionTransport: 'zernio_webhook', publishing: { kind: 'broker', brokerName: 'zernio' })`.

## R2-5. Updated Recommendation Stack

### 🔴 P0 — Ship first (refined from Round 1)

- **P0-1.** Reorder journey: signup → connect → pick location → confirm →
  demo → paywall → voice → dashboard.
- **P0-2.** Demo response via **SerpAPI** (not Zernio) with curated fallback.
  Migration 032 + new BullMQ queue + `onboarding_demos` table. Gated behind
  email OTP. Polling not SSE. Behind `ONBOARDING_DEMO_ENABLED` flag, A/B
  tested.
- **P0-3.** Fix Premium "multi-location" copy in `PlanPickerClient.tsx`
  immediately.
- **P0-4.** Persistent setup checklist on `/dashboard`.

### 🟡 P1 — Adopt from competitors

- **P1-NEW-A.** **Google Sign-In as primary auth** (NiceJob pattern).
  Collapses signup + Google review-scope OAuth into one consent click.
  Reduces step count materially.
- **P1-NEW-B.** **Move voice tuning *before* the demo** — short-form
  (3 required questions: warm/professional/playful/concise,
  mention-when-praised, never-say). Demo then renders with tuned voice.
  A/B-able as a second-order experiment.
- **P1-NEW-C.** **Time-boxed framing** on the dashboard checklist (GatherUp
  pattern): "Up and running in 10 minutes." Visible finish line.
- **P1-NEW-D.** **Notification preferences as an inline checklist step**
  (no competitor does this well; RepWorth's approval-required architecture
  makes it load-bearing). "Where should we ping you for approvals?" — email
  pre-checked, SMS/Telegram opt-in.
- P1-5 through P1-8 from Round 1 retained: voice required-but-fast,
  async-validation feedback, unify post-OAuth path, "what to expect" copy.

### 🟢 P2 — Migration + multi-source order

- **P2-MIGRATION.** Multi-location migration phases 1–4 per §R2-4.2. Total
  elapsed: ~6–8 weeks. **Trigger-driven outbox propagation, not
  dual-write.**
- **P2-SOURCE-ORDER.** Yelp (compose-and-copy) → Trustpilot (customer-gated)
  → TripAdvisor (vertical-gated, deferred). **Remove Facebook.** File
  direct-GBP application now for BATNA against Zernio.
- **P2-COPY-FIX.** Update Premium tier copy to reflect honest multi-source
  promise once §R2-4.2 phase 4 ships.

## R2-6. Patterns to Adopt vs Reject (from competitor walkthrough)

### Adopt

1. **Google Sign-In as primary auth** (NiceJob).
2. **Time-boxed framing** ("up and running in 10 minutes" — GatherUp).
3. **Notification preferences inline in onboarding** — no competitor does
   this well; RepWorth's approval-required architecture makes it
   load-bearing.
4. **Email verification BEFORE wizard entry** (Podium) — cleaner abandonment
   metrics and cuts spam signups.

### Reject

1. **Mandatory sales/demo call** (BirdEye, Reputation.com) — kills SMB
   self-serve velocity.
2. **Per-location pricing gated behind a form** (BirdEye, GatherUp) —
   NiceJob's flat pricing is a documented competitive wedge.
3. **Goal-branching wizard** (Podium) — RepWorth has one job, linear flow
   wins.
4. **Paid onboarding fees** (BirdEye's $500–$15K) — incompatible with
   self-serve.
5. **Auto-triggering messages before owner has reviewed them** (NiceJob's
   documented failure) — already prevented by RepWorth's "no auto-posting"
   invariant.
6. **Open-ended week-by-week curriculum** (BirdEye) — owners want to be
   done, not enrolled in a course.

## R2-7. Multi-Source Access Reality Check (2026)

| Source | Read | Write | Approach |
|---|---|---|---|
| **Google** | GBP API gated; Zernio webhooks today | Zernio API today; direct PUT on `/reviews/{id}/reply` once GBP approval clears | **Solved.** File direct-GBP application now for BATNA. |
| **Yelp** | Fusion 3-excerpt ceiling (free) OR Insights Program (enterprise-only) | R2R API exists but enterprise-gated; partners disallowed from posting on customer behalf | **Compose-and-copy** in-product. Document policy reason. |
| **Trustpilot** | Public read + Business OAuth (paid plan + API add-on) | `POST /v1/private/reviews/{id}/reply` (paid plan + API add-on) | **Customer-gated.** Build adapter when inbound customer has API contract. |
| **TripAdvisor** | Content API, 5-review ceiling, partner-approved | No public reply endpoint | **Defer.** Vertical-gated (hospitality only); ≥10 paying customers + partner intake. |
| **Facebook** | **Deprecated v22** (`/{page-id}/ratings` returns error 12; webhooks stopped) | Never publicly available | **Removed from roadmap.** |

**Strategic note:** Zernio dependency is a 12–24mo risk. File direct-GBP
application now even though queue is months — gives BATNA when Zernio
renegotiates pricing. Keep the `wip/edit-existing-replies-zernio-v1` parked
tag exactly as the project notes already direct.

---

# Sources & Attribution

## Onboarding/UX research

- [Subscription Onboarding Patterns — DEV Community](https://dev.to/paywallpro/subscription-onboarding-15-patterns-you-must-know-4n4f)
- [SaaS Onboarding Best Practices 2025 — Flowjam](https://www.flowjam.com/blog/saas-onboarding-best-practices-2025-guide-checklist)
- [Aha Moment Guide — Userpilot](https://userpilot.com/blog/aha-moment/)
- [Intercom Checklists](https://www.intercom.com/blog/intercom-checklists-onboard-engage-customers/)
- [SaaS Implementation Best Practices 2026 — Guideflow](https://www.guideflow.com/blog/saas-implementation-best-practices)
- [Progressive Disclosure — Userpilot](https://userpilot.com/blog/progressive-disclosure-examples/)

## Architecture / data model

- Toast, Square, Mindbody developer docs — account/location separation
- BirdEye, Podium, Reputation.com — public pricing + partner SDK shapes
- [Google Zanzibar paper (2019)](https://research.google/pubs/zanzibar-googles-consistent-global-authorization-system/) and OpenFGA / Auth0 FGA — ReBAC / scoped RBAC
- Stripe subscriptions docs — quantity-based + metered billing

## API surface verification (2025/2026)

- [Google Business Profile API prerequisites](https://developers.google.com/my-business/content/prereqs) — quota gating, 60+ day prereq
- [Google Business Profile review data reference](https://developers.google.com/my-business/content/review-data) — review handling retained from v4 deprecation
- [Yelp Fusion FAQs — Insights & R2R partner gating](https://docs.developer.yelp.com/docs/faqs)
- [TripAdvisor Content API overview](https://tripadvisor-content-api.readme.io/reference/overview) — 5-review ceiling
- [Trustpilot Service Reviews API](https://developers.trustpilot.com/service-reviews-api/) — `POST /v1/private/reviews/{id}/reply`
- [Meta Graph API v22 changelog](https://developers.facebook.com/docs/graph-api/changelog/version22.0/) — ratings/recommendations deprecation
- [Yext: Facebook deprecating metrics, Oct 2025](https://yext.com/blog/2025/10/facebook-is-deprecating-metrics-what-to-know)

## Competitor signup flows

- [BirdEye onboarding](https://birdeye.com/blog/from-setup-to-success-birdeye-onboarding/), [BirdEye pricing analysis](https://wiserreview.com/blog/birdeye-pricing/)
- [Podium 14-day trial](https://www.podium.com/free-trial), [Podium G2 reviews](https://www.g2.com/products/podium/reviews)
- [NiceJob pricing + AI Replies](https://get.nicejob.com/product/ai-review-replies), [NiceJob G2 reviews](https://www.g2.com/products/nicejob/reviews)
- [GatherUp Quick-Start Guide](https://gatherup.com/quick-start-guide/)

## Codebase sources (verified during research)

- `src/app/onboarding/business/BusinessWizardClient.tsx`,
  `StepLocation.tsx`, `StepProfile.tsx`, `StepVoice.tsx`, `guard.ts`
- `src/app/api/onboarding/business/route.ts`
- `src/lib/onboarding/create-business.ts`
- `src/app/onboarding/pay/PlanPickerClient.tsx`
- `src/app/(public)/signup/SignupFormClient.tsx`
- `src/app/(authenticated)/dashboard/connect/page.tsx`
- `src/app/(authenticated)/settings/channels/page.tsx`
- `src/lib/reviews/types.ts`, `index.ts`

[Inference] tags applied to: payment-first defensibility heuristic;
SMB trial-fraud reasoning; transport/provider split for ReviewIdentity;
BATNA framing for Zernio renegotiation; voice-before-demo conversion lift
hypothesis; abuse-cap thresholds.

---

# Methodology

## Round 1 — Discovery providers

- `octo:personas:product-writer` — SaaS onboarding best-practice synthesis
- `octo:personas:database-architect` — multi-location schema patterns
- `octo:personas:backend-architect` — multi-source adapter patterns
- `octo:personas:ux-researcher` — RepWorth-specific friction inventory
  grounded in verified codebase state

## Round 2 — Deep-dive providers

- `octo:personas:ai-engineer` — pre-paywall demo mechanic (storage, queue,
  abuse model, A/B design)
- `octo:personas:database-architect` — zero-downtime migration phasing,
  specific Postgres SQL, rollback paths
- `octo:personas:strategy-analyst` — competitor signup walkthroughs;
  WebFetch-verified
- `octo:personas:research-synthesizer` — multi-source API access in 2026;
  WebFetch-verified against current docs

## Acknowledged gaps

- The `/signup/finish` form's exact field set was inferred but not directly
  read; recommendation P1-7 should be validated by reading
  `FinishSignupClient.tsx`.
- Existing observability/funnel analytics — no audit performed of what
  onboarding events are currently instrumented.
- No load test of the trigger overhead on `businesses` INSERT — the
  `AFTER INSERT` trigger doing 3 writes adds latency to signup; benchmark
  before Phase 1 ships.
- Migration agent assumed `is_default` column on `locations`;
  `default_location_id` on `businesses` is the alternative. Both work; pick
  one before writing 032.
- Conversion-lift estimate for "voice-before-demo" is unsourced
  [Inference] — would need empirical A/B data, not literature.
- ReviewTrackers and similar multi-source aggregators not deeply
  evaluated — only mentioned in passing.
- Stripe Payment Link plumbing — recommendation to gate paywall on demo
  viewing assumes the existing Payment Link flow can carry forward state;
  if not, this becomes a Stripe-side change.

## Cross-references

- Migration agent's trigger-on-INSERT correctly anticipated the demo
  agent's separate migration 032 (`onboarding_demos`). They don't conflict
  — both can ship in the same migration.
- Competitor walkthrough's voice-before-demo suggestion contradicts Round-1
  ordering. Both defensible — flagged as A/B-able.
- Multi-source agent's Facebook deprecation finding **invalidates** Round-1
  ReviewSource adapter shape that included Facebook as a planned provider.
  Updated §R2-4.3 accordingly.

---

# Project Decomposition & How to Spec Each

The research above bundles ~5 independent projects under one banner. Each
should get its own spec → plan → branch cycle rather than a single mega-spec.
This section turns the research into a sequenced, buildable plan with the
open questions that must be resolved *before* writing each spec.

## Order at a glance

| # | Project | Effort | Value at current scale | When |
|---|---|---|---|---|
| **A** | Premium tier copy fix | <1 day | Removes trust violation | **Ship today** |
| **B** | Journey reorder + pre-paywall demo + setup checklist | ~2 weeks | Core conversion play | Next sprint |
| **C** | Voice + onboarding polish (P1 set) | ~1 week | Iterate on B's data | After B has soaked 2 weeks |
| **D** | Multi-location migration (R2-4.2 phases 1–4) | 6–8 weeks | Zero current value | **Deferred** — first multi-loc customer |
| **E** | ReviewSource adapter split (R2-4.3) | Unbounded | Zero current value | **Deferred** — 2nd writeable source |

Two cross-cutting items independent of the projects above:

- **File direct-GBP API application now** (months-long queue). BATNA against
  Zernio price renegotiation. Side action, not a project.
- **Audit existing onboarding analytics** (R2 §Acknowledged gaps): unknown
  what funnel events are instrumented today. Prerequisite for measuring B.

---

## Project A — Premium "multi-location" copy fix

**Scope:** Remove or rename the "Multi-location" bullet on Premium tier in
`src/app/onboarding/pay/PlanPickerClient.tsx`.

**Why:** Schema cannot store a second location today; selling a feature that
doesn't exist is credibility / refund / chargeback risk.

**No spec needed.** Single-line PR. Decision to make:

1. Remove the bullet entirely, OR
2. Replace with an honest Premium differentiator already in code: priority
   approval queue, larger backfill window, etc.

Pick one and ship. Don't gate on D landing — that's months away.

---

## Project B — Pre-paywall demo + journey reorder + setup checklist

The core conversion play. Combines **P0-1, P0-2, P0-4** from the research.

### In scope

- Reorder journey: signup → connect/confirm location → **demo response** →
  paywall → voice → dashboard
- Migration 032: `onboarding_demos` table only (no `locations` table — that's
  Project D)
- SerpAPI-driven demo with curated fallback (per §R2-4.1)
- BullMQ queue `onboarding_demo_response` on Railway (worker invariant)
- `/api/onboarding/demo` writes `onboarding_demos` row + `job_outbox` entry
  in one Postgres tx (outbox invariant)
- Persistent setup checklist on `/dashboard` (4 items)
- Gated behind `ONBOARDING_DEMO_ENABLED` flag
- Demo uses the existing ResponseGenerator `pending_payment` carve-out

### Out of scope

- A/B testing infrastructure with statistical gates (volume too low; ship as
  winner-takes-all and observe directionally)
- Anything multi-location
- Any ReviewSource adapter refactor
- Yelp/Trustpilot/Facebook
- Google Sign-In as primary auth (handled in C as part of P1-7)

### Open questions to resolve in brainstorming BEFORE writing the spec

1. **Review-selection bias.** `sort_by=newest` may surface a 1-star at the
   worst possible moment (paywall). Candidate strategies:
   - Filter `rating >= 4` (cleanest, but new businesses with all 1-stars get
     curated fallback)
   - Most-recent positive within last 30d; curated fallback if none
   - Owner picks one of last 5 reviews to demo on (extra step, more honest)
   - Show whatever's newest (status quo of the research doc — risky)
2. **Polling vs server-side await.** With p95 3–5s, server-side render with
   6–8s budget + skeleton + one auto-refresh is simpler than 1.5s client
   polling. Try simpler first; fall back to polling only if tail latency
   exceeds 8s often enough to matter.
3. **Lifetime `UNIQUE` cap on `user_id`.** Pinches genuine retry (demo
   failed, support helped them, want fresh). Consider partial unique on
   `WHERE status='ready'` so a failed demo doesn't lock the user out, plus
   a 24h sliding window cap. Lock down before migration 032.
4. **Curated fallback content.** Per-category? LLM-generated once and
   reviewed? Hand-written? Storage location? Spec must lock this.
5. **Re-entry behavior.** User generates demo → bounces → returns 3 days
   later. Show stale `source_review`? Refetch? Hide?
6. **Abuse model primitives.** The 4-cap proposal (1/user, 3/IP/24h,
   5/email-domain/24h, 200/h global) is fine but each cap adds Redis state.
   Confirm Upstash sliding-window is right vs simpler DB counts.
7. **Cost-guard ceiling.** Wire SerpAPI + LLM cost into the existing
   cost-guard pattern (`.claude/skills/cost-guard.md`) with a hard daily
   ceiling. Don't rely on rate limits alone.

### Suggested build order

1. Migration 032: `onboarding_demos` table (DDL only)
2. Demo worker: `onboarding_demo_response` BullMQ queue + worker handler
3. ResponseGenerator demo-mode carve-out (extend the existing
   `pending_payment` allow-path)
4. `/api/onboarding/demo` route — outbox + demo row in one tx
5. Paywall page server-side reads demo, skeleton + auto-refresh fallback
6. Setup checklist on `/dashboard` (parallelizable from step 4)
7. Journey reorder: route changes + redirects from old paths
8. `ONBOARDING_DEMO_ENABLED=true` for staff; soak ≥48h; flip globally

### Risks

- **SerpAPI cost spike** if abuse caps fail open → cost-guard daily $ ceiling.
- **Demo on 1-star** converts worse than no demo → resolve open question 1.
- **Checklist as permanent decoration** if Zernio webhooks lag → "we're
  watching, no reviews yet" intermediate completion state.
- **Stripe Payment Link state hand-off** (R2 acknowledged gap): if the
  paywall now needs to carry demo state forward into Stripe, may require
  Stripe-side change. Validate on day 1 of the spec.

### Spec target

`docs/superpowers/specs/2026-05-XX-pre-paywall-demo-and-journey-reorder.md`

---

## Project C — Voice + onboarding polish

Ships after B has been live ~2 weeks and there's directional conversion data.

### In scope

- **P1-5:** Reframe `StepVoice` as required-but-fast — 3 questions only
  (tone radio, mention-when-praised chips, never-say). Move staff names /
  products / sample responses to a post-onboarding "Refine your voice" page.
- **P1-NEW-B:** Move voice tuning *before* the demo, so the demo renders
  with tuned output. (Ship as leading hypothesis — too low volume for a
  rigorous A/B.)
- **P1-6:** Async-validation feedback on Maps URL paste (spinner → confirm
  card → fallback to autocomplete; disable Next during validation).
- **P1-7:** Skip `/signup/finish` for Google OAuth users (validate
  `FinishSignupClient.tsx` field set first per R2 acknowledged gap).
- **P1-8:** "What to expect" copy after Zernio connect.
- **P1-NEW-D:** Notification preferences as an inline checklist step
  (email pre-checked; SMS/Telegram opt-in).
- **P1-NEW-C:** Time-boxed framing on the dashboard checklist
  ("Up and running in ~10 min").

### Out of scope

- Multi-location anything
- New auth providers
- New review sources

### Open questions

- Where does the "Refine your voice" page live? `/settings/voice`? Inline on
  dashboard? Spec must pick.
- Does voice-before-demo lift conversion at current scale? Can't A/B-power —
  ship as the leading hypothesis, observe directionally.

### Spec target

`docs/superpowers/specs/2026-XX-XX-onboarding-polish.md`

---

## Project D — Multi-location migration (DEFERRED)

**Recommendation: do not start until at least one paying-or-ready-to-pay
prospect is actively asking for multi-location support.**

Reasoning: The R2-4.2 phased plan is technically sound. The problem is
sequencing — burning 6–8 weeks on infrastructure for zero current revenue
when the same time spent on B + C measurably moves conversion. The only
near-term urgency for this work is Premium tier copy, which Project A
removes in <1 day.

### When to revisit

- First inbound prospect with ≥2 locations who is otherwise ready to pay, OR
- Paying customer count >100 (optionality has organizational value), OR
- Specific compliance/regulatory forcing function

### What to keep on hand for that future moment

- §R2-4.2 phased plan in this doc is the spec scaffold
- Re-validate at that future moment, especially:
  - Trigger overhead on `businesses` INSERT (R2 acknowledged gap — untested)
  - Backfill batch size (500 may be wrong by then)
  - Outbox versioning (`_v: 1 | 2`) is over-engineered for one in-flight
    migration; the simpler "pause enqueue → drain → cutover → resume" path
    was rejected without justification — challenge that before adopting

### What NOT to do

Do not pre-emptively ship migration 032 with `locations`. The version of 032
in §R2-4.1 (`onboarding_demos`) ships with Project B. The version in §R2-4.2
(`locations`) ships with this project, whenever that is. The research doc's
"they don't conflict, ship in same migration" cross-reference is wrong —
locations DDL must be its own migration so D can be deferred independently.

---

## Project E — ReviewSource adapter refactor (DEFERRED)

**Recommendation: do not refactor until the second writeable source is
actually being implemented.**

Reasoning: Google via Zernio is 100% of writeable traffic today. Yelp is
compose-and-copy (no automation). Trustpilot is customer-gated (build when
the contract arrives). TripAdvisor is deferred. Refactoring an interface for
one current implementation is over-engineering — any abstraction designed
without a second concrete implementation in hand will be wrong on the second
implementation.

### When to revisit

- Trustpilot customer arrives with API contract → spec the adapter split
  *as part of* shipping their adapter
- Direct GBP approval clears → spec the adapter split *as part of*
  migrating off Zernio

### What to keep on hand

- §R2-4.3 interface sketch as a starting point — but re-derive from the
  second concrete implementation, not from theoretical multi-source
  projection
- C1 / C2 / C3 corrections (Facebook deprecated, Yelp enterprise-gated,
  trigger-driven outbox not dual-write) are durable and should still apply
  whenever the work resumes

---

## What this decomposition explicitly rejects

- **One mega-spec covering A through E** — too large for a single
  brainstorm or implementation plan; scope creep guaranteed.
- **A/B testing the demo with formal α/power gates** — n=1500 sample at
  ~30 signups/day is 50+ days per experiment. Ship leading hypothesis,
  observe directionally, iterate.
- **Multi-location migration before a multi-location customer exists** —
  YAGNI, with 6–8 weeks of opportunity cost vs B + C.
- **ReviewSource adapter polymorphism for theoretical sources** — refactor
  on the second concrete implementation, not before.
- **Adding Facebook to any roadmap surface** — Graph v22 deprecated reads.
  Reframe as "managed in Meta Business Suite, not RepWorth."
