# Current Implementation Map

This file explains what is actually built in the repository today, how it maps to the implementation plan, and what is left to build.

Last updated: 2026-05-22 (WhatsApp owner self-service, `feat/whatsapp-go-live`)

## Quick summary — what shipped 2026-05-22 (WhatsApp owner self-service)

In simple words:

### What we changed

Business owners can now connect WhatsApp to RepWorth themselves, from the **Settings → Channels** page — the same way they already connect Telegram. Before this, only an admin could turn WhatsApp on for a business; the owner's page just showed a greyed-out "coming soon" box. The whole feature is still switched off in production (behind the `CHANNELS_WHATSAPP_ENABLED` flag) until the real WhatsApp number and message template are approved by Meta.

### Why we did it

The WhatsApp code was built months ago but parked, waiting for the WhatsApp Business Account to be approved. That approval came through, so we finished the last missing piece (the owner-facing "Connect" button) and wrote the step-by-step guide for actually turning it on.

### The new shape — what got added

- **`src/components/dashboard/OwnerWhatsAppWidget.tsx`** — the "Connect WhatsApp" box the owner sees. Shows a QR code / link to scan, then flips to "Connected" once they message the number. Copied from the Telegram widget.
- **`src/app/api/dashboard/channels/whatsapp/start|cancel|disable/`** — three small API endpoints behind that button (begin connecting, cancel a half-finished connect, disconnect). They only ever act on the logged-in owner's own location.
- **`src/lib/channels/whatsapp-enrollment.ts`** — got two new shared functions (`startWhatsAppEnrollment`, `disableWhatsAppEnrollment`) so the "begin" and "disconnect" database logic lives in one place instead of being copy-pasted into the routes. The older admin route was switched over to use them too.
- **`docs/runbooks/whatsapp-templates.md`** — the "how to actually launch it" checklist: which message template to submit to Meta, what to set in Vercel and Railway, and the 8 things to test before flipping the switch.
- **`docs/known-issues.md`** (new) — records a multi-location bug we found (see below).

### The new house rule

WhatsApp owner self-service is **single-location-only for now.** If an account has more than one location, the owner sees "coming soon" instead of the Connect button, and the connect endpoint refuses with a clear error. This is a deliberate guardrail around a pre-existing bug (the owner connect/disconnect logic looks up the row by location, but the page reads it by account, so on accounts with multiple owners they can disagree). The same bug quietly affects SMS and Telegram too — it's written up in `docs/known-issues.md` with a proper fix planned separately.

### What didn't change

Email, SMS, and Telegram all work exactly as before. The admin-side WhatsApp enrollment (on the business detail page) is unchanged except that it now calls the shared helper functions. Nothing about review ingestion, response generation, or posting changed. And because the flag is still off, customers see no difference until launch.

### Where to read more

- `docs/runbooks/whatsapp-templates.md` — the launch checklist + how to submit the Meta template.
- `docs/known-issues.md` + `docs/superpowers/specs/2026-05-22-owner-channel-account-scope-design.md` — the multi-location desync and its planned cross-channel fix.
- `docs/progresstracking.md` — the full sprint log for this work (PR #53).

---

## Quick summary — what shipped 2026-05-09 (Multi-location support)

In simple words:

### What we changed

We added the ability for one owner to manage **many Google Business Profile locations** under a single subscription. Before today, every owner row mapped 1:1 to a single business and a single Google location. Now the same owner can hold multiple locations under one billing umbrella, switch between them in the dashboard, get notifications routed by location, and bill cleanly via Stripe overage.

### Why we did it

The pricing page already advertised multi-location as a Premium feature, but the code didn't support it. Small chains (the Premium tier's stated audience) couldn't actually onboard without manually creating one full account per location. This branch closes that gap.

### The new shape — what got added, what got rearranged

```
src/
├── app/
│   ├── (authenticated)/
│   │   ├── dashboard/
│   │   │   └── add-location/                  ← NEW: 4-step wizard for adding a location
│   │   │       ├── page.tsx
│   │   │       ├── AddLocationWizard.tsx
│   │   │       └── __tests__/
│   │   └── settings/
│   │       ├── locations/                     ← NEW: list, archive, reactivate, promote-primary
│   │       ├── voice/                         ← NEW: per-location voice config tab
│   │       └── channels/                      ← NEW: per-location channel override tab
│   │
│   └── api/
│       ├── locations/                         ← NEW route group
│       │   ├── add/                           (owner: insert businesses + audit + outbox)
│       │   ├── archive/
│       │   ├── reactivate/
│       │   ├── promote-primary/
│       │   ├── display-label/
│       │   └── existing-place-ids/
│       ├── billing/                           ← NEW route group
│       │   ├── checkout/                      (server-built Stripe Checkout Session)
│       │   ├── portal/                        (POST → Stripe billing portal URL)
│       │   └── tier-change/                   (upgrade/downgrade)
│       ├── settings/
│       │   ├── voice/                         ← NEW
│       │   └── channels/override/             ← NEW
│       └── admin/
│           └── locations/csv-import/          ← NEW: bulk CSV upload
│
├── lib/
│   ├── accounts/                              ← NEW module
│   │   ├── tier-config.ts                     (basic / standard / premium / founders)
│   │   ├── quota.ts                           (assertCanAddLocation, computeOverageQuantity)
│   │   └── repo.ts                            (getAccountById, getAccountOwnerUserId)
│   ├── locations/                             ← NEW module
│   │   ├── add-location-tx.ts                 (atomic add — businesses + audit + outbox)
│   │   ├── archive-location-tx.ts             (atomic archive + reactivate)
│   │   ├── promote-primary-tx.ts              (atomic primary swap)
│   │   ├── repo.ts                            (getLocationById, getActiveLocationCount, …)
│   │   └── display-label.ts                   (getDisplayLabel helper)
│   ├── notifications/
│   │   └── resolve-channels.ts                ← NEW chokepoint: org-default vs per-location override resolver
│   │                                            with 5-min Redis cache + safeInvalidateChannelCache wrapper
│   ├── admin/
│   │   └── csv-import.ts                      ← NEW: parse, validate, processRow + aggregate enqueue helper
│   └── shared/
│       └── ids.ts                             ← UPDATED: branded AccountId + LocationId types
│
worker/
└── jobs/
    └── billing/                               ← NEW folder
        └── UpdateStripeOverageWorker.ts       (handles outbox topic 'update_stripe_overage_quantity'
                                                with Stripe idempotency keys)
```

The schema gained an `accounts` table (the new billing parent), an `account_audit_log` table, and `account_id` denormalization on six existing tables. The `businesses` table now means "a single Google Business Profile location" — the owner-facing concept of "the business" lives on `accounts`. We kept the `businesses` name because renaming 150+ files of `business_id` references would have cost weeks for no functional gain. CLAUDE.md now carries this naming honesty as an architecture invariant.

### How to find what you need

- **"How does an owner add a location?"** → `src/app/(authenticated)/dashboard/add-location/AddLocationWizard.tsx` calls `POST /api/locations/add` which calls `src/lib/locations/add-location-tx.ts` (atomic businesses INSERT + audit log + Stripe overage outbox + Zernio backfill outbox).
- **"How is the dashboard scoped to all-locations vs one location?"** → `src/app/api/dashboard/route.ts` reads `?scope=all` or `?scope=<locationId>`. Falls back to the user's primary location. The `rw_location_scope` cookie persists the choice across navigations.
- **"Where does Stripe overage billing happen?"** → `worker/jobs/billing/UpdateStripeOverageWorker.ts`. Reads outbox rows of topic `update_stripe_overage_quantity`, retrieves the subscription, and updates the overage subscription item with idempotency keys. Add / archive / reactivate / tier-change all enqueue the same topic.
- **"Where does notification routing decide which channel + handle?"** → `src/lib/notifications/resolve-channels.ts`. It groups `channel_enrollments` rows for the account, prefers per-location overrides, ignores archived/unverified/unsubscribed rows, and caches the result in Redis for 5 minutes. Every write path calls `safeInvalidateChannelCache(accountId, context)` — a wrapper that logs Redis failures instead of silently swallowing them.
- **"Where does the publisher refuse to post for archived locations?"** → `worker/jobs/publisher/ResponsePublisherWorker.ts:67-92`. The load query selects `b.archived_at` and short-circuits with `markOutboxCompleted` if the location was archived after the response was approved.
- **"What does the cancellation grace period read?"** → `accounts.cancelled_at + 30 days` (with `subscription_activated_at` legacy fallback). Set by the Stripe webhook on `customer.subscription.deleted`.
- **"Where do migrations 034–041 live?"** → `supabase/migrations/`. The runbook at `docs/runbooks/multi-location.md` lists the apply order and what each one does.

### The new house rule

`.claude/CLAUDE.md` now carries this invariant:

> **`businesses` row = location; `accounts` row = billing parent.** Since multi-location (migration 034), the `businesses` table holds one row per Google Business Profile location. Subscription / Stripe / quota state lives on `accounts`. Naming kept for blast-radius reasons; do not re-introduce subscription columns on `businesses`.

### What didn't change

The single-location experience. If an owner has exactly one location (basic tier or any tier with one location), the location switcher is hidden, the settings page keeps its old shape, and the dashboard renders without the per-location KPI strip. Multi-location is opt-in via the `MULTI_LOCATION_ENABLED` flag — when off, the new routes return 404 and the legacy paths run unchanged.

The approval flow, response generation, Zernio ingestion, and review dedup logic are all unchanged. Reviews and responses still scope by `business_id` (= location_id), and that's still the only correct way to scope per-location data. The new `account_id` column is for cross-location queries (aggregate dashboard, billing, audit) — never use it as a substitute when you actually want a specific location.

### What got better as a side effect

- Auth is now triple-gated for owner mutations: middleware role + account_id check, then in-route `requireRole('owner')`, then per-resource ownership lookup against the session's account. Closes IDOR risks that were possible in the original single-location code if URLs leaked.
- Channel cache invalidation now logs Redis hiccups via `safeInvalidateChannelCache` instead of `.catch(() => {})`. TCPA-relevant cache staleness is no longer silently masked.
- Migration 040+041 tightened RLS on `businesses` and `channel_enrollments` — owners can only directly UPDATE the safe columns (tone, products_services, etc.); subscription / Stripe / `is_primary` / `archived_at` columns require service-role + the dedicated transaction paths.
- Eight new lab notes captured in `.claude/skills/lab-notes.md` — including the "column-level REVOKE doesn't override a table-level GRANT" gotcha and the "FOR UPDATE outside `sql.begin()` is a no-op under PgBouncer" gotcha.

### Where to read more

- `docs/runbooks/multi-location.md` — full implementation runbook + 18 manual test cases + known non-blocking debt list.
- `docs/superpowers/specs/2026-05-06-multi-location-design.md` — the original design spec (gitignored, local-only).
- `docs/superpowers/specs/2026-05-07-multi-location-investigation.md` and `2026-05-07-multi-location-readiness.md` — the pre-implementation investigation and readiness checks (also gitignored).
- `docs/progresstracking.md` — full sprint log of what we built, the 13-issue security review, and the 5-issue post-launch fix-pass.

---

## Quick summary — what shipped 2026-05-05 (Worker index failure extraction, PR #18)

In simple words:

### What we changed

We took the long inline error-handling code out of `worker/index.ts` and moved it into its own files next to the workers it belongs to. The boot file now does just one thing: register workers and start the server. The actual logic for what happens when a job fails for the last time lives next door.

### Why we did it

Before: `worker/index.ts` was 607 lines and did three different things at once — set up Sentry, register all the BullMQ workers, AND own ~250 lines of database-writing failure logic inside two big inline `worker.on('failed', …)` callbacks. The failure logic had almost no test coverage because it was buried deep inside a boot file. Hard to read, hard to test, easy to break.

After: `worker/index.ts` is **296 lines** of pure registration. Each `worker.on('failed', …)` is a one-liner pointing at a named function. The failure logic now lives in tested modules right next to the workers that throw the errors.

### The new shape

```
worker/
├── index.ts                ← still the bootstrap, but now pure registration + lifecycle
├── sentry.ts               ← NEW: Sentry init + key-redaction scrubber
│
├── jobs/
│   ├── zernio/
│   │   ├── ZernioReviewIngestWorker.ts
│   │   └── ingest-failed-hook.ts        ← NEW: handleIngestFailed
│   │
│   └── publisher/
│       ├── ResponsePublisherWorker.ts
│       ├── publisher-error-handlers.ts
│       └── failed-hook.ts               ← NEW: handlePublisherFailed
```

### How to find what you need

- **"Where does Sentry get configured?"** → `worker/sentry.ts`
- **"What happens when a Zernio ingest job fails for the last time?"** → `worker/jobs/zernio/ingest-failed-hook.ts`
- **"What happens when a publish-to-Google job fails for the last time?"** → `worker/jobs/publisher/failed-hook.ts`
- **"Where do the BullMQ workers get registered?"** → still `worker/index.ts`. The `.on('failed', …)` callbacks are now one-liners that delegate to the modules above.

### The new house rule

`.claude/CLAUDE.md` now carries this invariant:

> **Entry points orchestrate; modules own failure behavior.** Route handlers, worker boot files, and ingress handlers may validate, orchestrate, and map errors, but must not own durable side effects inside long failure branches. Extract any error-handling branch over ~30 lines into a named module interface next to its caller, with focused tests for the branch.

This PR was the first application of that rule. PRs #2 and #3 (next on the runway) apply the same rule to two Next.js routes (`select-location/route.ts` and `callback/route.ts`).

### What didn't change

Behavior. Every Sentry tag, every error message, every database write, every outbox reason is byte-equal to what it was before. This was pure code-motion — no logic edits, no formatting drift. If a customer's review fails to ingest tomorrow, the same row gets written to `review_exceptions` with the same payload as it would have a week ago.

### What got better as a side effect

Two error branches that had **zero** direct test coverage on `main` are now tested:

- The "bare ZernioTransientError reached failed-hook" defensive branch (a code-bug indicator that should never fire — but if it does, we now know it'll log + Sentry-capture correctly).
- The "last-resort handler-crash" branch (the safety net for when even our `markOutboxFailed` call throws).

### Where to read more

- `docs/superpowers/specs/2026-05-05-entry-point-modularization-design.md` — the full Group A spec covering all three PRs (local-only, not in git).
- `docs/superpowers/plans/2026-05-05-pr1-worker-index-failure-extraction.md` — the implementation plan that drove this PR (also local-only).
- `docs/progresstracking.md` — full commit-by-commit log of the 13 commits behind PR #18.

---

## Quick summary — what shipped 2026-05-05 (Worker folder reorganization)

In simple words:

### What we changed

We rearranged the files inside the `worker/` folder. Nothing the app *does* changed — same workers, same handlers, same behavior. The change is purely about where files live so the codebase stays easy to navigate as we add more workers and background loops.

### Why we did it

Before: `worker/jobs/` had 28 files mixing three different things — actual job processors, pollers that watch the database, and schedulers that run on a clock. `worker/ingress/` had 17 files where webhook entry points sat next to provider-specific helper modules. Tests were spread across three different `__tests__/` folders that didn't match each other. Hard to scan, hard to know where a new file belongs.

After: each folder has one clear job. Tests live next to the source they test, the way the rest of the codebase already does it.

### The new shape

```
worker/
├── env.ts            ← loads .env.local first
├── index.ts          ← the bootstrap (Sentry, Fastify, BullMQ workers, lifecycle)
├── queues.ts         ← all 16 BullMQ queue definitions in one place
│
├── config/           ← boot-time env-var assertions
│
├── ingress/          ← webhook handlers (Stripe, Resend, etc.)
│   ├── twilio/       ← SMS + WhatsApp inbound + their helpers
│   ├── telegram/     ← Telegram bot webhooks + helpers
│   └── zernio/       ← Zernio review webhook + signature verify
│
├── jobs/             ← BullMQ job processors (one per `new Worker(...)`)
│   ├── notification/ ← NotificationWorker + its 5 helper modules
│   ├── publisher/    ← ResponsePublisher + error handlers
│   └── zernio/       ← Zernio backfill + ingest workers + shared helpers
│
└── background/       ← long-running loops that aren't BullMQ jobs
    ├── pollers/      ← watch the database for state changes (OutboxPoller, etc.)
    └── schedulers/   ← run on a clock (WeeklySummaryScheduler, etc.)
```

### How to find what you need

- **"Where does Stripe webhook code live?"** → `worker/ingress/stripe.ts`
- **"Where does the WhatsApp signature get verified?"** → `worker/ingress/twilio/twilio-verify.ts`
- **"Where does the email-bounce notification get sent?"** → `worker/jobs/notification/NotificationWorker.ts`
- **"What handles posting a reply to Google?"** → `worker/jobs/publisher/ResponsePublisherWorker.ts`
- **"What drains pending outbox rows into BullMQ?"** → `worker/background/pollers/OutboxPoller.ts`
- **"What enqueues the weekly summary email?"** → `worker/background/schedulers/WeeklySummaryScheduler.ts`
- **"Where do all the workers get registered?"** → still `worker/index.ts` — that file is the canonical "what runs" map.

### Two rules we kept

1. **No barrel/index files inside `worker/`.** Every poller, scheduler, and worker is imported by name in `worker/index.ts`. That file is the runtime registry — you can read it top-to-bottom and see exactly what's running.
2. **Tests live next to the code they test.** Just like everywhere else in `src/`. So `worker/jobs/zernio/__tests__/ZernioBackfillWorker.test.ts` sits right next to `worker/jobs/zernio/ZernioBackfillWorker.ts`.

### What didn't move

Class names didn't change. `OutboxPoller` is still `OutboxPoller`. `NotificationWorker` is still `NotificationWorker`. So any documentation or skill file that talked about those by name is still correct — only the file paths changed.

### Where to read more

- `docs/directory.md` — the full file-by-file reference, with one row per file describing what it does.
- `docs/superpowers/specs/2026-05-04-worker-folder-reorg-design.md` and `docs/superpowers/specs/2026-05-05-worker-background-split-design.md` — the planning documents (local-only, not in git).

---

## Quick summary — what shipped 2026-05-04 (Pre-paywall demo + journey reorder)

In simple words:

### The problem we solved

People who signed up for RepWorth used to go straight from "give us your business location" to "give us your credit card." They had to *imagine* what AI replies for their reviews would look like, then trust us with money. A lot of them dropped off at the paywall. We had no proof-of-value moment.

### What we shipped (behind a flag)

A new screen between signup and the paywall that **shows the owner what RepWorth would actually write for their real Google reviews — for free, before they pay.**

The new flow:

1. **Sign up** → confirm email.
2. **`/onboarding/start`** — type business name + pick from Google Maps autocomplete (or paste a Google Maps URL).
3. **`/onboarding/demo`** — within ~10 seconds the page shows 3 of their actual recent reviews with AI-generated responses underneath each one. Big "Choose a plan →" button.
4. **`/onboarding/pay`** — Stripe checkout (unchanged).
5. **`/onboarding/business`** — same form as before but only **Profile** and **Voice** steps now (Location was captured back at step 2). Header reads: *"You're in. Two quick questions to make responses sound like you, then we go live."*
6. **`/dashboard`** — now has a **setup checklist** card at the top showing four boxes (Connect Zernio, Approve your first response, Tune your voice, Set notifications). Each shows ✓ when done.

### What if our demo can't be generated?

Corner cases the user might hit, and what they see:

- **Their business has very few or low-rated Google reviews** → we show three pre-written sample reviews + sample responses with a small note: *"Sample reviews shown — connect your account after signup to see your real ones."* Demo still completes; paywall still shows.
- **Our daily $10 budget for free demos is used up** → we still let them onto `/onboarding/demo` but show the paywall directly: *"Your live demo is on the way after signup — for now, you can still subscribe."* No infinite redirect loop.
- **Demo generation flat-out fails (e.g., SerpAPI down)** → we show a "Try again" button AND the paywall right below. Payment is never blocked on a demo issue.
- **They paid mid-flight** (between clicking Generate and the worker picking up the job) → we mark the demo `failed` (not empty `completed`, which would lock them into never being able to regenerate) and they go on to the paywall path.

### Why it's flag-gated

`ONBOARDING_DEMO_ENABLED=false` keeps the legacy 3-step Location/Profile/Voice wizard exactly as it is today. Flip the flag on, and the new flow appears. We can deploy code without changing user-visible behavior, then turn it on for staff first, then everyone.

### What changed in the codebase

**New UI files:**
- `src/app/onboarding/start/page.tsx` + `StartLocationClient.tsx` — the new "find your business" screen.
- `src/app/onboarding/demo/page.tsx` + `PaywallWithDemoClient.tsx` — the demo + paywall screen.
- `src/app/(authenticated)/dashboard/SetupChecklist.tsx` + `SetupChecklistClient.tsx` — the dashboard checklist.

**New backend files:**
- `src/app/api/onboarding/start/route.ts` — receives the location capture, creates the demo job in one transaction.
- `src/app/api/onboarding/demo/status/route.ts` — the page polls this every 2 seconds while the demo is generating.
- `src/app/api/onboarding/demo/regenerate/route.ts` — fires when the user clicks "Regenerate demo".
- `src/lib/costs/onboarding-demo-cost-guard.ts` — keeps the global $10/day demo spend ceiling. Reserves 20¢ before each demo, reconciles to actual cost (~3¢) after.
- `src/lib/demos/fallback-content.ts` + `__fixtures__/fallback-source-reviews.ts` — the canned reviews + replies we show when SerpAPI returns nothing useful.
- `worker/jobs/OnboardingDemoWorker.ts` — the worker that fetches reviews, generates responses, and writes the demo row.

**Modified files:**
- `src/app/api/onboarding/business/route.ts` — when the flag is on, uses a different schema (rejects location fields) and only writes profile/voice. When the flag is off, exactly the same as before.
- `src/app/onboarding/business/BusinessWizardClient.tsx` + `ProgressDots.tsx` + `guard.ts` + `page.tsx` — the wizard now adapts to 2-step or 3-step based on the flag.
- `src/lib/shared/schemas.ts` — added `OnboardingStartSchema` (tighter business-name regex because the value flows into the LLM prompt) and `BusinessOnboardingPostPaySchema` (rejects `googlePlaceId`/`googleMapsUrl` via `z.never()`).
- `src/lib/shared/queue-names.ts` + `worker/queues.ts` + `worker/index.ts` — registered the new `onboarding_demo_response` queue + worker.
- `src/lib/demos/lifecycle.ts` — `completeDemo` now handles two demos completing for the same user at once (catches Postgres 23505, archives the loser, closes its outbox).
- `worker/jobs/CleanupAbandonedSignupsPoller.ts` — explicitly deletes onboarding_demos rows when cleaning up abandoned signups, plus a top-of-loop pass that drops completed demos older than 30 days.

**New database migration: 032**
- `supabase/migrations/032_onboarding_demos.sql` — new `onboarding_demos` table (sister to the existing `prospect_demos`), with a partial unique index that enforces "one completed demo per user", and a partial cleanup index for the 30-day deletion pass.
- **Important:** the user runs migrations themselves. The file is committed but the SQL has NOT been applied yet.

**New env vars:**
- `ONBOARDING_DEMO_ENABLED` (default off) — master switch.
- `ONBOARDING_DEMO_DAILY_CENTS` (default 1000 = $10/day) — global cost ceiling.
- `ONBOARDING_DEMO_STAFF_EMAILS_CSV` — Phase 3 staff allowlist (not yet wired into the route).

**Test runbook:** `docs/runbooks/pr-2-pre-paywall-demo-test.md` — step-by-step for verifying the implementation locally.

### What's still left for later (Phase 2+)

- **Per-category curated fixtures** — today we have one "general business" fallback for everyone. A script will eventually generate restaurant-specific, salon-specific, etc. versions.
- **`api_costs` ledger entries** — today demo spend lives only in Redis. The admin cost dashboard won't see this lane until we add a `cost_lane` column to the `api_costs` table.
- **Auto-regenerate on stale revisit** — if the user bookmarks `/onboarding/demo` and comes back the next day, today they see a "Last updated 1 day ago" footnote and have to click the Regenerate button. Phase 2 may auto-trigger regeneration on the SSR page.
- **Phase 3 staff-allowlist gating** — the env var exists but the route doesn't yet check it. Wire that up before flipping the flag globally.

---

## What changed before that — 2026-05-02 (Past Replies, view-only)

In simple words:

### The problem we solved

When an owner connects Zernio for the first time, we used to silently throw away every Google review they had already personally replied to before signing up for RepWorth. They lost the entire history. Tanicia Resort lost 8 reviews that way. The owner had no record of past engagement, our voice-learning hook had no bootstrap data, and there was no place in our dashboard to even see those replies.

### What we shipped

A new **read-only "Past Replies" tab** in the owner dashboard. Every existing Google reply is now ingested into our database as a `posted` response and shown in a paginated list (50 per page), grouped into two sections:
- **"From your active period"** — reviews that came in AFTER the owner started paying.
- **"From before you joined"** — reviews from BEFORE the owner started paying. Non-premium owners see a small upsell banner ("Premium customers will be able to edit replies to historical reviews using their current brand voice once direct Google integration ships").

Each card shows the customer's review on the left, the reply that's live on Google on the right, and a small label that says either **"Imported from Google · 2024-08-14"** (the owner posted it directly on Google) or **"Posted via RepWorth · 2024-08-14"** (we posted it for them).

**No edit button. No regenerate button. No drawer.** The full edit feature is parked (see below).

### Why it's read-only — the split decision

The original branch `feat/edit-existing-replies` had the full feature: 31 commits, 6 review rounds, ~3,500 LOC, an EditReplyDrawer with 9 states, 7 API routes, a publisher DELETE+POST locked-tx state machine with orphan-marker recovery, and recovery routes (Retry/Restore-original).

Why we didn't ship that whole thing:

1. **Zernio's API requires DELETE-then-POST to edit a reply.** Direct GBP (Google Business Profile) API uses single-PUT replacement. About 25% of the parked code (the DELETE+POST recovery state machine, the orphan-marker convention, the recovery routes) becomes unnecessary the moment GBP arrives. Building Zernio-shaped recovery for production support of a feature that will be deleted is engineering debt.

2. **GBP is at least 6-18 months away** (we haven't even applied yet). During that window the original Tanicia pain keeps recurring. We needed the visibility win NOW.

3. **The visibility slice is 30% of the code, 5% of the operational complexity, and addresses the original user pain.** The other 70% (edit + recovery) is the optional feature on top.

4. **The branch was stabilizing but not stable.** Six review rounds kept finding successively smaller variants of the same hidden-draft bug class in the regenerate flow. Each round was real engineering hours, and post-launch ops would inherit that complexity.

So we **split**: ship the visibility slice (this branch) now; park the edit machinery on tag `wip/edit-existing-replies-zernio-v1` for either GBP-time reuse OR resurrection if GBP timeline blows up beyond 12 months.

### Two flags

`EDIT_EXISTING_REPLIES_ENABLED` (the original single flag) was renamed and split into TWO independent flags so the operator controls write rollout separately from UI rollout:

- **`EXTERNAL_REPLY_IMPORT_ENABLED`** — gates the WRITES path. When on, `reconcileExternallyAnsweredReview` ingests previously-silent external replies as `posted` responses. When off, today's silent-no-op behavior preserved.
- **`PAST_REPLIES_VIEW_ENABLED`** — gates the UI. When on, the page renders + the OwnerNav link appears. When off, the page returns 404 + nav link is hidden.

Why two flags? Imported `posted` rows count toward the dashboard's "total responded" metric. Turning ingestion on changes customer-visible numbers. The split lets the operator turn ingestion on first, soak silently while watching the metric shift in product analytics, then turn the UI on once they're comfortable.

### Where everything lives on `feat/past-replies-view`

- **Migration:** `supabase/migrations/031_edit_existing_replies.sql` — adds `reviews.external_reply_ingested_at`, `zernio_backfill_runs.external_reply_ingested_count`, partial unique index `responses_one_posted_per_review`, secondary index `idx_reviews_business_review_date`. **Apply non-transactionally; pre-flight check is required (see runbook §10).**
- **Worker (extended, not new files):** `worker/jobs/zernio-ingest-shared.ts` — `reconcileExternallyAnsweredReview` gets two new flag-gated branches (`insertImportedReview` + `insertImportedResponse` + `bumpExternalReplyIngestedCount`).
- **Zernio client safety fixes:** `src/lib/zernio/client.ts` normalizes `reviewReply` to null at the API chokepoint + `summarizeShape` helper for redacting raw JSON in unrecognized-shape logs. `worker/jobs/publisher-error-handlers.ts` exports `redactSensitiveError` which now wraps persisted error bodies in `handlePublisherPermanentErrorTerminal`.
- **Dashboard page:** `src/app/(authenticated)/dashboard/past-replies/page.tsx` (server component, paginated, gap/historical bucketing).
- **Components:** `src/components/dashboard/PastReplyCard.tsx` (read-only card) + `src/components/dashboard/HistoricalUpgradeBanner.tsx` (soft upsell).
- **Nav link:** `src/components/OwnerNav.tsx` accepts `pastRepliesEnabled` prop; `src/app/(authenticated)/layout.tsx` passes `process.env.PAST_REPLIES_VIEW_ENABLED === 'true'`.
- **Backfill script:** `scripts/zernio-backfill-external-replies.ts` — one-off CLI for retroactive ingestion. Requires `EXTERNAL_REPLY_IMPORT_ENABLED=true` to run.
- **Runbook:** `docs/runbooks/zernio-launch-runbook.md` §10 — Phase A → B1 → B2 rollout playbook.

### What's pending before customers see this

1. **Apply migration 031** in production Supabase. Pre-flight check first (run the SQL in the migration file's comments — confirm zero duplicate `posted` rows). Apply non-transactionally (uncheck the single-tx box in Supabase SQL editor).
2. **Phase A:** ship code with both flags off, soak ≥ 1 week.
3. **Phase B1:** turn on `EXTERNAL_REPLY_IMPORT_ENABLED` in prod env. Silent ingestion starts. Watch the dashboard "total responded" count in product analytics.
4. **Phase B2:** turn on `PAST_REPLIES_VIEW_ENABLED` in prod env. Owners see the new tab.
5. **Pilot one customer end-to-end** before wider rollout.
6. **File the GBP API application** if not already.

### What's deferred

- The full edit / regenerate / publish / retry / restore-original feature — parked on tag `wip/edit-existing-replies-zernio-v1`. Revive only when GBP arrives (rebuild against single-PUT) OR GBP timeline blows up beyond 12 months (resurrect the parked branch with another review pass on the residual hidden-draft variants).
- Integration tests + E2E tests (deferred from the parked branch — need `TEST_DATABASE_POOL_URL` + Playwright harness).

### Directory changes (for future reference)

**New files on this branch:**
- `supabase/migrations/031_edit_existing_replies.sql`
- `src/app/(authenticated)/dashboard/past-replies/page.tsx`
- `src/components/dashboard/PastReplyCard.tsx`
- `src/components/dashboard/HistoricalUpgradeBanner.tsx`
- `scripts/zernio-backfill-external-replies.ts`

**Modified files on this branch:**
- `worker/jobs/zernio-ingest-shared.ts` (extended with import branches)
- `worker/jobs/ZernioBackfillWorker.ts` (loose-equality `reviewReply` guards)
- `worker/jobs/ZernioReviewIngestWorker.ts` (loose-equality `reviewReply` guards)
- `worker/__tests__/zernio-ingest-shared.test.ts` (7 new test cases)
- `worker/jobs/publisher-error-handlers.ts` (export `redactSensitiveError` + use it in handlePublisherPermanentErrorTerminal)
- `src/lib/zernio/client.ts` (`listReviews` reviewReply normalization + `summarizeShape` helper + 3 redacted log sites)
- `src/app/(authenticated)/layout.tsx` (passes `pastRepliesEnabled` prop)
- `src/components/OwnerNav.tsx` (renders Past Replies link conditionally)
- `docs/runbooks/zernio-launch-runbook.md` (§10 rewrite for dual-flag rollout)

**Files that are NOT on this branch (parked on tag `wip/edit-existing-replies-zernio-v1`):**
- `src/app/api/dashboard/past-replies/draft/route.ts`
- `src/app/api/dashboard/past-replies/draft/[responseId]/route.ts`
- `src/app/api/dashboard/past-replies/draft-status/route.ts`
- `src/app/api/dashboard/past-replies/publish/route.ts`
- `src/app/api/dashboard/past-replies/[responseId]/retry/route.ts`
- `src/app/api/dashboard/past-replies/[responseId]/restore-original/route.ts`
- `src/components/dashboard/EditReplyDrawer.tsx`
- `src/lib/responses/edit-existing.ts` (assertCanEditReply + validateOptimisticConcurrency)
- `worker/jobs/publisher-on-failed.ts` (orphan-marker conversion)
- The `runEditPublisherIfApplicable` branch in `worker/jobs/ResponsePublisherWorker.ts`
- The `verify409InTx` helper in `worker/jobs/publisher-error-handlers.ts`
- The stale-marking branch in `src/lib/reviews/process-review.ts`
- The `deleteReply` method + `ZernioReplyAlreadyDeletedError` in `src/lib/zernio/client.ts`/`errors.ts`

For details: see `docs/progresstracking.md` "feat/past-replies-view" section, `docs/runbooks/zernio-launch-runbook.md` §10.

---

## What We Built So Far

### Sprint 1: Scaffolding + Demo Engine (Prompts 1-6)

We set up the entire project foundation and built the prospect demo generator — the #1 sales weapon.

**What it does:** A sales partner pastes a Google Maps URL into the admin page, and within 60 seconds gets a shareable demo page showing that business's real reviews with AI-generated responses.

**What we built:**

- Next.js 14 app with TypeScript strict mode, Tailwind, App Router
- Full database schema (15 tables in Supabase) covering the entire long-term architecture
- Railway worker process with Fastify HTTP server + BullMQ job queue + OutboxPoller
- SerpAPI integration for fetching Google Maps reviews
- AI response generator with OpenAI (primary) + Anthropic (fallback)
- Cost tracking system with Redis-based budget guards
- Demo generation pipeline: admin UI → outbox → worker → SerpAPI → AI → viewer page
- Mock mode for local development without API keys

### Sprint 2: Production Pipeline (Prompts 7-13)

We built the complete automated review response workflow — the core product loop.

**What it does:** When a business signs up, the system automatically polls their Google reviews every 60 minutes, generates AI response drafts, emails the owner for approval, and queues approved responses for manual posting by the sales partner.

**What we built:**

- 7 shared utilities (subscription guard, outbox helpers, sanitizer, rate limiter, mock mode, worker types, voice learning)
- OutboxPoller watchdog recovery for crashed workers
- ReconciliationPoller — schedules review syncs every 60 minutes for active businesses
- ReviewSyncWorker — fetches reviews via SerpAPI, deduplicates, detects edits, triggers response generation
- ResponseGeneratorWorker — calls AI with cost guards, avoid-facts checking, voice learning
- NotificationWorker — generates approval tokens (SHA-256 hashed), sends approval emails via Resend
- Approval system — 5 API routes, device-bound cookies, CSRF protection, server+client approval page
- ResponsePublisherWorker — sets responses to awaiting_manual_post, emails admin with paste instructions
- AdminExceptionWorker — alerts admin when a reviewer edits their review after we already posted
- Resend webhook handler — tracks email delivery status
- Admin business detail page with copy-to-clipboard and mark-as-posted buttons

### Sprint 3: Admin Dashboard + Payments + Security (Prompts 14a-16)

We built the full admin interface, payment integration, and security hardening — everything needed for the sales partner to onboard and manage clients independently.

**What it does:** The sales partner logs in with Supabase Auth, onboards a business through a form, sends the owner a Stripe Payment Link, and monitors everything from admin dashboard pages. Stripe webhooks automatically activate the subscription when payment completes. Security headers and Sentry error tracking protect everything.

**What we built:**

**Authentication (Prompt 14a):**

- Supabase Auth with `@supabase/ssr` — cookie-based sessions, email/password login
- Middleware rewrote: session refresh + role-based route protection (admin/sales_partner for admin pages, owner for dashboard)
- `requireRole()` defense-in-depth on every admin API route
- Old API key auth completely removed
- RLS policy: users can only read their own row
- Auth callback route for email confirmations

**Admin Dashboard Pages (Prompt 14b):**

- Overview page — system health cards (pending outbox, failed jobs, today's cost, notification failures) + business table sorted by urgency, 30-second auto-refresh
- Costs page — breakdown by provider, business, day. Daily limit progress bar. 7d/30d/90d date filter. Businesses exceeding 80% of limit highlighted red.
- Notifications page — delivery log with business/channel/status filters, pagination
- Jobs page — outbox summary cards + BullMQ queue depth per queue. Gracefully shows "unavailable" if Redis is down. Failed jobs table with pagination.

**Business Onboarding + Management (Prompt 14c):**

- Onboarding form (`/admin/businesses/new`) — react-hook-form + Zod, 14 fields across 4 sections (business info, owner info, voice context, subscription tier). Creates business + owner user + initial sync outbox entry in one atomic transaction.
- Business list (`/admin/businesses`) — table with pagination, "Add Business" button, clickable rows
- Upgraded business detail page — inline-editable profile section (PATCH API), review list with color-coded response status badges (new=gray, pending_approval=yellow, approved=blue, awaiting_manual_post=orange, posted=green, failed=red), existing manual-post section preserved

**Stripe Payments (Prompt 15):**

- Stripe webhook handler on Railway (`/ingress/stripe`) — signature verification, dedup via inbound_events
- 5 event types: checkout.session.completed (pending_payment → active), invoice.payment_failed (→ past_due), invoice.paid (grace recovery → active), customer.subscription.deleted (→ cancelled), customer.subscription.updated (tier change)
- Payment Link URL returned from onboarding API with `client_reference_id` + `prefilled_email`
- Onboarding form copies Payment Link to clipboard after business creation
- Lazy Stripe singleton — worker doesn't crash if Stripe keys aren't set

**Security Hardening (Prompt 16):**

- Sentry error tracking — client/server/edge configs for Next.js + worker init. Sensitive data scrubbed (keys, secrets, tokens, passwords stripped from error payloads).
- Security headers on all Vercel responses: HSTS (2-year), CSP (production only), X-Frame-Options DENY, X-Content-Type-Options nosniff
- Security headers on all Railway responses: HSTS + nosniff via Fastify onSend hook
- Shared Zod schemas for business validation (replaces inline schemas in onboarding + PATCH)
- Demo generation rate limits: 50/day global + 5/min per IP

### Sprint 4: Production Hardening (Prompts 17-18)

We built the safety nets that let the system run 10 businesses without anyone touching it — automatic recovery when emails don't deliver, weekly owner summaries, database cleanup, and tests that verify the security mechanisms actually work.

**What it does:** If an approval email gets lost or bounces, the system detects it within 2 hours and re-sends automatically (alerting the admin if all attempts fail). Every Monday morning, business owners get a summary email with their week's review stats and any negative reviews needing attention. Old completed jobs and expired data are cleaned up automatically so database tables don't grow forever. Security tests verify that the cost guards, token hashing, input sanitization, and subscription checks all work correctly.

**What we built:**

**Notification Failover (Prompt 17):**

- NotificationFailoverPoller — runs every 2 hours, finds approval emails that were sent but never confirmed delivered after 4 hours, and re-queues them with a fresh approval token
- Detects two failure modes: "stale" (email sent, never delivered) and "all-failed" (every delivery attempt bounced or was marked as spam)
- Sends an admin alert email when all delivery attempts for a response have failed, with 24-hour dedup so the admin doesn't get spammed
- NotificationWorker upgraded with "failover-awareness" — normal retries check `sent_at` (was the email sent?), but failover re-sends check `delivered_at` (was it actually delivered?) so it can re-send when an email was sent but lost in transit

**Weekly Summaries (Prompt 17):**

- WeeklySummaryScheduler — runs every hour, checks if it's Monday 8-9 AM UTC, and queues summary emails for all active businesses
- WeeklySummaryWorker — queries the week's stats (total reviews, total responded, response rate %, notable negative reviews), builds a responsive HTML email, and sends it to the business owner
- Idempotent: uses `ON CONFLICT` + `WHERE sent_at IS NULL` so replayed jobs never send duplicate emails
- Summary covers the previous week (Monday to Sunday), not the current week

**Database Cleanup (Prompt 17):**

- ArchivalPoller — runs every 24 hours, deletes old data in batches of 5,000 to avoid long-running locks:
  - Completed outbox entries older than 7 days
  - Processed webhook events older than 30 days
  - Expired prospect demos older than 30 days past expiry

**Security Tests (Prompt 18):**

- 10 Vitest security property tests verifying existing security mechanisms work correctly:
  - `sanitizeText()` strips control characters from prompt-injection text without crashing or stripping semantic content
  - `escapeHtml()` escapes `<script>` tags and quote-based attribute injection
  - `checkRegenBudget()` rejects the 4th regeneration attempt per review per day and rolls back the Redis counter
  - `lockValidLink()` queries with SHA-256 hash of the raw token (verified by capturing the hash via mock)
  - Webhook replay dedup logic correctly identifies already-processed events
  - `ExpiredTokenError` and `DeviceConflictError` are proper Error subclasses
  - Subscription guard denies cancelled/pending_payment for notification and publisher workers

**E2E Approval Tests (Prompt 18):**

- 5 Playwright E2E test scenarios for the full approval flow (require `TEST_DATABASE_POOL_URL`):
  - Approve: navigate → click Approve → verify response status becomes 'approved' in DB
  - Edit: navigate → click Edit → modify text → Save & Approve → verify edited_text and edit_distance in DB
  - Expired: navigate to expired link → see "expired" error message
  - Regenerate: navigate → click Regenerate → verify old response 'superseded' + new generate_response outbox entry
  - Consumed: navigate to already-used link → see "already been approved" message
- Seed helper (`e2e/seed.ts`) with safety guards: fails fast without `TEST_DATABASE_POOL_URL`, creates unique data per test with cleanup in `finally` blocks
- Tests skip gracefully when no test DB is configured

**Infrastructure Fixes:**

- Redis cache client now fails fast when Redis is unreachable (3-second connect timeout, 1 retry max, offline queue disabled) — prevents API routes from hanging indefinitely when local Redis isn't running
- Two bugs fixed in Prompt 17 code: notification failover now processes all-failed BEFORE stale (so admin alerts actually fire), and weekly summary upsert correctly detects already-sent summaries

### Sprint 5A: Retention Stack (Prompts 19a, 19c, 19d, 19f)

We built everything needed to prove ROI to business owners and detect churn risk before customers leave — upgraded emails, an owner dashboard, automated engagement alerts, and a churn scoring system.

**What it does:** Business owners now receive rich "Weekly Value Report" emails with an AI Intelligence Brief summarizing customer themes, plus monthly impact emails showing cumulative value. They can log into a dashboard to see review velocity charts, response rate lift, and ranking trends. Meanwhile, the system watches for disengaged owners (not approving reviews) and automatically nudges them, escalating to the sales partner if they go silent for too long. The admin overview shows a Health column ranking every business by churn risk.

**Weekly Value Report + Monthly Impact Email (Prompt 19a):**

- Upgraded the basic weekly summary email into a "Weekly Value Report" with 7 sections: AI Intelligence Brief (3-5 sentence LLM summary of the week's reviews), Value Delivered header ("handled 7 reviews, saving you 49 minutes"), Response Rate Lift (current vs baseline), Review Velocity (this week vs 4-week average), conditional Google Maps Ranking, Notable Reviews, and a Dashboard link (only shown when owner has a login)
- New monthly impact email — sent on the 1st of each month with monthly intelligence brief, cumulative stats, best review of the month (with the approved response), and ranking change since joining
- AI Intelligence Brief uses a dedicated `generateReviewSummary()` helper with OpenAI→Anthropic fallback, cost reservation lifecycle, and mock mode support. Caps at 30 reviews, truncates text to prevent budget overruns. Reuses existing summary on retry (no duplicate LLM calls).
- Crash-safe email delivery: `claimed_at` column prevents duplicate sends between concurrent workers, `sent_at` set just before Resend call. If the send fails, both are cleared so retries can reclaim the report.
- MonthlyImpactScheduler polls hourly, fires on the 1st of the month 9-10 AM UTC
- `recordNotificationDelivery()` extended to support business-level notifications (responseId now optional)

**Read-Only Owner Dashboard (Prompt 19c):**

- `GET /api/dashboard` — single API endpoint returning all dashboard data in one payload, scoped by the authenticated owner's `business_id`. Defense-in-depth: `requireRole('owner')` + `businessId` null check. All responses use `NO_STORE_HEADERS`.
- Dashboard page with 5 sections: Value Summary Banner (blue gradient, reviews handled + time saved + response rate with baseline comparison), Review Velocity bar chart (recharts, last 8 weeks with zero-week fill), conditional Google Maps Ranking line chart (Y-axis inverted, one line per keyword, limited to 12 months), Recent Reviews list (last 10 with color-coded status badges, expandable approved response text, "check your email" for pending), Latest Intelligence Brief (most recent by `sent_at`, monthly preferred over weekly)
- OwnerNav component with business name + sign-out button (error handling on sign-out failure)
- Authenticated layout shell reads Supabase session, queries business name, renders OwnerNav
- Middleware protects `/api/dashboard` for owner role with no-store headers on 401/403

**Engagement Detection & Re-engagement (Prompt 19d):**

- EngagementMonitorPoller — runs daily, computes engagement metrics for ALL active businesses in one grouped CTE query (not N+1). 5 metrics: approval rate (30-day rolling), days since last approval, pending count, oldest pending age, notified response count.
- 4 engagement rules with cooldown dedup: owner_nudge (3+ days inactive, 3-day cooldown), partner_engagement_alert (7+ days, 7-day cooldown), partner_escalation_alert (14+ days, 14-day cooldown), partner_low_engagement (approval rate below 50% with 3+ notifications, 7-day cooldown)
- Atomic dedup: `INSERT ... WHERE NOT EXISTS` checks both cooldown deliveries and in-flight outbox entries. Backed by a partial unique index (migration 011) that catches concurrent races via 23505.
- EngagementAlertWorker routes by `alert_type`: owner_nudge creates fresh approval links for each pending review (via extracted `createApprovalLink()`) and sends a customer-facing nudge email; partner alerts send internal emails to the admin with business metrics and owner contact info
- `createApprovalLink()` extracted from NotificationWorker into `src/lib/approval/create-link.ts` for reuse. Supports `revokeMode: 'orphaned_only'` (normal notifications) and `revokeMode: 'always'` (nudge emails that replace stale links).
- 4 email templates: owner nudge (customer-facing, lists pending reviews with approval buttons), partner engagement alert (plain), partner escalation alert (red accent, "at risk"), partner low-engagement (amber accent, neutral wording — trend direction deferred to Sprint 5B)
- Owner nudge idempotency: checks for existing delivery within 1 day before creating links

**Churn Risk Score (Prompt 19f):**

- Pure function `computeChurnRiskScore()` — no DB calls, no side effects. Takes pre-queried metrics, returns a 0-100 score with level and signal breakdown.
- 5 weighted signals: Approval rate 30% (0-1 fraction with defensive auto-correction for 0-100), Days since approval 25%, Satisfaction pulse 20% (null until Sprint 5B), Response time trend 15%, Account age 10%
- Levels: 0-30 = healthy (green), 31-60 = watch (amber), 61-100 = at_risk (red)
- Weights and thresholds exported as constants for easy tuning
- Admin Overview enhanced: grouped metrics CTE query computes churn data for all businesses in one round trip. Sorted by risk score descending server-side before paginating. Health column with colored HealthBadge.
- Business Detail enhanced: risk badge next to business name + Engagement section with 5-signal breakdown showing name, value, color-coded contribution bar, and numeric contribution
- Response time trend derived from current-week vs previous-4-week average approval latency (>1.5x = slower, pending+stale = stopped)

---

## Every File In The Project

### Root Config Files

| File                      | What it does                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| `package.json`            | Dependencies and scripts: `pnpm dev`, `pnpm worker`, `pnpm test`, `pnpm build`                 |
| `tsconfig.json`           | TypeScript strict mode, path aliases (`@/` → `./src/`)                                         |
| `next.config.mjs`         | Next.js 14 config, wrapped with Sentry, security headers (HSTS, CSP, X-Frame-Options, nosniff) |
| `sentry.client.config.ts` | Sentry browser-side init with sensitive data scrubbing                                         |
| `sentry.server.config.ts` | Sentry server-side init with sensitive data scrubbing                                          |
| `sentry.edge.config.ts`   | Sentry Edge Runtime init (for middleware)                                                      |
| `tailwind.config.ts`      | Tailwind CSS setup                                                                             |
| `postcss.config.mjs`      | PostCSS + Tailwind + Autoprefixer                                                              |
| `vitest.config.ts`        | Test runner config: includes `src/**/__tests__/**` and `worker/**/__tests__/**`                |
| `playwright.config.ts`    | E2E test config (tests scaffolded, not yet implemented)                                        |
| `.env.example`            | Template for all environment variables with documentation                                      |
| `.env.local`              | Actual secrets (never committed to git)                                                        |

### Database (`supabase/migrations/`)

| File                                          | What it does                                                                                                                                                                                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `001_initial_schema.sql`                      | Creates all 15 tables: businesses, reviews, responses, approval_links, users, job_outbox, inbound_events, notification_deliveries, prospect_demos, api_costs, review_exceptions, weekly_summaries, ranking_snapshots, google_connections, approval_audit_log |
| `002_prompt2_fixes.sql`                       | Fixes audit log schema, adds missing indexes                                                                                                                                                                                                                 |
| `003_fix_audit_log_rls.sql`                   | Restores row-level security on audit log                                                                                                                                                                                                                     |
| `004_sync_reviews_dedup_constraint.sql`       | Prevents duplicate sync_reviews outbox entries per business                                                                                                                                                                                                  |
| `005_nullable_review_exception_review_id.sql` | Allows NULL review_id for identity collision exceptions + dedup index                                                                                                                                                                                        |
| `006_users_rls_policy.sql`                    | Enables RLS on users table + self-select policy for authenticated users                                                                                                                                                                                      |
| `007_place_id_verification.sql`               | Place ID verification flag + PlaceIdValidationWorker outbox topic                                                                                                                                                                                            |
| `008_retention_core.sql`                      | Creates `monthly_impact_emails` table + notification delivery index for cooldown checks                                                                                                                                                                      |
| `009_report_claim_columns.sql`                | Adds `claimed_at` to `weekly_summaries` + `monthly_impact_emails` for atomic send claims                                                                                                                                                                     |
| `010_dashboard_indexes.sql`                   | Composite index `(business_id, detected_at DESC)` on reviews for dashboard queries                                                                                                                                                                           |
| `011_engagement_alert_dedup.sql`              | Partial unique index on `job_outbox` for in-flight engagement alerts (prevents concurrent duplicates)                                                                                                                                                        |
| `012_outbox_status_doc.sql`                   | Documents `dispatching` status in outbox lifecycle comment                                                                                                                                                                                                   |
| `013_churn_query_indexes.sql`                 | Response indexes for churn metrics: `(business_id, status, created_at)` + `(business_id, approved_at DESC)`                                                                                                                                                  |

### Worker Process (`worker/`)

Runs on Railway. Handles all background jobs — review syncing, AI generation, email sending, posting.

| File                                 | What it does                                                                                                                                                                                                                                                                     | Status  |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `index.ts`                           | Starts Fastify server + 11 BullMQ workers + OutboxPoller + ReconciliationPoller + NotificationFailoverPoller + WeeklySummaryScheduler + ArchivalPoller + MonthlyImpactScheduler + EngagementMonitorPoller. Handles graceful shutdown.                                            | Working |
| `env.ts`                             | Loads `.env.local` for the worker process (Next.js does this automatically, worker doesn't)                                                                                                                                                                                      | Working |
| `queues.ts`                          | Defines 11 BullMQ queues with retry config (3 attempts, exponential backoff at 5s). Handles Redis connection for local, Railway, and Upstash.                                                                                                                                    | Working |
| `jobs/OutboxPoller.ts`               | Runs every 10 seconds. Two-phase dispatch: claims rows as 'dispatching' with `dispatched_at = NOW()`, then adds to BullMQ. Watchdog recovers 'dispatched' entries stuck >1 hour and stale 'dispatching' entries >2 minutes. Uses FOR UPDATE SKIP LOCKED.                         | Working |
| `jobs/ReconciliationPoller.ts`       | Runs every 60 minutes. Finds active businesses due for a review sync and creates outbox entries. Skips in mock mode. Has atomic dedup guard backed by a DB unique index.                                                                                                         | Working |
| `jobs/ReviewSyncWorker.ts`           | Fetches reviews from SerpAPI (or mock), compares against DB using content hashes, inserts new reviews, detects edits, triggers response generation. Each review processed in its own transaction.                                                                                | Working |
| `jobs/ResponseGeneratorWorker.ts`    | Calls AI to generate a response draft. Handles cost reservation, concurrency limits, regen budget, avoid-facts checking with one retry, voice learning. Persists response + notification outbox in one transaction.                                                              | Working |
| `jobs/NotificationWorker.ts`         | Calls shared `createApprovalLink()` for token generation + hash storage, sends approval email via Resend, records delivery. Handles orphaned link recovery on retry. Failover-aware: normal retries check sent_at, failover re-sends check delivered_at.                         | Working |
| `jobs/DemoGenerationWorker.ts`       | Generates prospect demos: fetches reviews + AI responses, saves snapshot to DB. Has stale-running recovery.                                                                                                                                                                      | Working |
| `jobs/ResponsePublisherWorker.ts`    | Sets response to "awaiting_manual_post" and emails the admin/sales partner with the approved text + Google Maps link for manual copy-paste posting.                                                                                                                              | Working |
| `jobs/AdminExceptionWorker.ts`       | Emails admin when a reviewer edits their review after a response was already posted.                                                                                                                                                                                             | Working |
| `jobs/WeeklySummaryWorker.ts`        | Upgraded to Weekly Value Report: AI Intelligence Brief (via `generateReviewSummary`), value-delivered header, response rate lift, review velocity, conditional ranking, dashboard link. claimed_at/sent_at crash-safe pattern. Clears both on send failure for retry recovery.   | Working |
| `jobs/WeeklySummaryScheduler.ts`     | Runs every hour. On Monday 8-9 AM UTC, creates weekly_summary outbox entries for all active/past_due businesses. Dedup guard prevents duplicate entries.                                                                                                                         | Working |
| `jobs/NotificationFailoverPoller.ts` | Runs every 2 hours. Finds approval emails that were sent but never delivered after 4 hours and re-queues them. Alerts admin when all attempts fail. 24h admin alert dedup.                                                                                                       | Working |
| `jobs/MonthlyImpactWorker.ts`        | Processes `send_monthly_impact` outbox entries. Upserts `monthly_impact_emails` row (idempotent), queries month stats + best review, generates AI intelligence brief (reuses on retry), builds email, sends via Resend. claimed_at/sent_at crash-safe pattern.                   | Working |
| `jobs/MonthlyImpactScheduler.ts`     | Runs every hour. On 1st of month 9-10 AM UTC, queues monthly impact emails for all active businesses. Dedup guard checks both table and in-flight outbox.                                                                                                                        | Working |
| `jobs/EngagementMonitorPoller.ts`    | Runs every 24 hours. Single grouped CTE query computes engagement metrics across all active businesses. Applies 4 rules (owner_nudge, partner_engagement, partner_escalation, partner_low_engagement) with cooldown dedup. Atomic INSERT with NOT EXISTS + partial unique index. | Working |
| `jobs/EngagementAlertWorker.ts`      | Routes by alert_type: owner_nudge creates fresh approval links per pending review and sends customer-facing nudge email; partner alerts send internal emails to admin. Idempotency check on owner nudge (skips if recent delivery exists).                                       | Working |
| `jobs/PlaceIdValidationWorker.ts`    | Validates Google Place IDs via SerpAPI search + haversine matching.                                                                                                                                                                                                              | Working |
| `jobs/ArchivalPoller.ts`             | Runs every 24 hours. Deletes completed outbox entries >7 days, processed events >30 days, expired demos >30 days. Batched at 5000 per cycle.                                                                                                                                     | Working |
| `ingress/resend.ts`                  | Handles Resend delivery webhooks (delivered/bounced/complained). Verifies svix signatures, deduplicates via inbound_events.                                                                                                                                                      | Working |
| `ingress/stripe.ts`                  | Handles Stripe webhooks (checkout completed, payment failed, paid, subscription deleted/updated). Verifies signatures, deduplicates via inbound_events, updates business subscription status.                                                                                    | Working |

### Worker Tests (`worker/__tests__/`)

| File                                 | Tests                                                                                                                                                                                  |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ReconciliationPoller.test.ts`       | Interval parsing, mock mode skip, lifecycle                                                                                                                                            |
| `ReviewSyncWorker.test.ts`           | Business not found, cancelled sub, null place_id, SerpAPI errors, new review, unchanged review, content changed + pending, content changed + posted, collision insert, collision dedup |
| `ResponseGeneratorWorker.test.ts`    | Success, cancelled sub, cost limit, mock mode, avoid-facts retry with skipCache + cache overwrite                                                                                      |
| `NotificationWorker.test.ts`         | Success, pending_payment skip, idempotent skip, orphaned link revocation, email failure, failover skip on delivered, failover re-send on undelivered, failover subscription guard      |
| `ResponsePublisherWorker.test.ts`    | Success, cancelled sub, already posted, email failure, retry with awaiting_manual_post                                                                                                 |
| `AdminExceptionWorker.test.ts`       | Success, already resolved, email failure                                                                                                                                               |
| `NotificationFailoverPoller.test.ts` | Stale failover queueing, all-failed admin alert, 24h alert dedup, lifecycle                                                                                                            |
| `WeeklySummaryWorker.test.ts`        | Full value report: LLM summary call, template switch, delivery recording, summary_text reuse, no-reviews skip, ranking data, dashboard URL, baseline rate, email failure recovery      |
| `MonthlyImpactWorker.test.ts`        | Full monthly flow: stats query, best review, LLM brief, idempotent upsert, already-sent skip, ranking, dashboard, baseline, email failure recovery                                     |
| `EngagementMonitorPoller.test.ts`    | All 4 engagement rules, cooldown suppression, multi-alert per business, null activityAge, insufficient sample size                                                                     |
| `EngagementAlertWorker.test.ts`      | Owner nudge with approval links, partner alerts (engagement/escalation/low-engagement), subscription guard, missing config, idempotency, email failure                                 |

### Next.js Pages (`src/app/`)

| File                                            | What it does                                                                                                                                      | Status                  |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `layout.tsx`                                    | Root HTML shell                                                                                                                                   | Working                 |
| `(public)/page.tsx`                             | Landing page                                                                                                                                      | Placeholder             |
| `(public)/demo/[slug]/page.tsx`                 | Public demo viewer — shows reviews + AI responses for prospects                                                                                   | Working                 |
| `(public)/approve/[token]/page.tsx`             | Approval page server shell — validates token, renders business name, loads client component                                                       | Working                 |
| `(public)/approve/[token]/approval-client.tsx`  | Approval page client component — fetches review+response, shows approve/edit/regenerate buttons                                                   | Working                 |
| `(authenticated)/layout.tsx`                    | Authenticated layout shell — reads Supabase session, renders OwnerNav with business name                                                          | Working                 |
| `(authenticated)/dashboard/page.tsx`            | Owner dashboard — value summary banner, review velocity chart, ranking chart, recent reviews, intelligence brief                                  | Working                 |
| `(authenticated)/settings/page.tsx`             | Business owner settings                                                                                                                           | Placeholder — Sprint 5B |
| `admin/demos/page.tsx`                          | Admin page for generating prospect demos                                                                                                          | Working                 |
| `admin/businesses/new/page.tsx`                 | Business onboarding form — react-hook-form + Zod, 14 fields, creates business + owner + sync outbox in one transaction                            | Working                 |
| `admin/businesses/[id]/page.tsx`                | Business detail — editable profile, review list with status badges, churn risk badge + Engagement breakdown section, awaiting manual post section | Working                 |
| `admin/businesses/[id]/manual-post-section.tsx` | Copy-to-clipboard + mark-as-posted buttons                                                                                                        | Working                 |
| `admin/businesses/page.tsx`                     | Business list with pagination, "Add Business" button, clickable rows                                                                              | Working                 |
| `admin/overview/page.tsx`                       | Admin CRM — system health cards + business table with Health column (churn risk badges), sorted by risk score descending, 30s auto-refresh        | Working                 |
| `admin/costs/page.tsx`                          | Cost monitoring — provider/business/day breakdown, daily limit progress bar, date filter                                                          | Working                 |
| `admin/jobs/page.tsx`                           | Queue health — outbox summary, BullMQ queue depth, failed jobs list                                                                               | Working                 |
| `admin/notifications/page.tsx`                  | Notification delivery log — filters by business/channel/status, pagination                                                                        | Working                 |
| `admin/login/page.tsx`                          | Admin login — Supabase Auth email/password                                                                                                        | Working                 |
| `admin/layout.tsx`                              | Admin layout wrapper                                                                                                                              | Working                 |
| `admin/providers.tsx`                           | React Query provider for admin pages                                                                                                              | Working                 |

### API Routes (`src/app/api/`)

| File                                         | What it does                                                                                                                                                                 | Status  |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `admin/demos/generate/route.ts`              | POST: queues demo generation via outbox. Rate limited: 50/day global + 5/min per IP.                                                                                         | Working |
| `admin/demos/route.ts`                       | GET: lists all demos                                                                                                                                                         | Working |
| `admin/businesses/route.ts`                  | GET: business list with pagination. POST: onboard new business (creates business + owner + sync outbox in one transaction, returns Payment Link URL).                        | Working |
| `admin/businesses/[id]/route.ts`             | GET: business detail + reviews + responses + churn risk score. PATCH: update business settings (Zod validated).                                                              | Working |
| `dashboard/route.ts`                         | GET: owner dashboard data (8 parallel queries scoped by owner's business_id — value summary, velocity, ranking, recent reviews, briefs). All responses use NO_STORE_HEADERS. | Working |
| `admin/businesses/[id]/mark-posted/route.ts` | POST: marks response as posted (awaiting_manual_post → posted)                                                                                                               | Working |
| `admin/overview/route.ts`                    | GET: system health metrics + business list with churn risk scores (grouped CTE metrics query, server-side risk sort, paginated)                                              | Working |
| `admin/costs/route.ts`                       | GET: cost breakdown by provider, business, day. Accepts ?days= filter.                                                                                                       | Working |
| `admin/notifications/route.ts`               | GET: notification delivery log with filters + pagination                                                                                                                     | Working |
| `admin/jobs/route.ts`                        | GET: outbox counts + BullMQ queue health + failed jobs list                                                                                                                  | Working |
| `auth/callback/route.ts`                     | GET: Supabase auth code exchange for email confirmations                                                                                                                     | Working |
| `approve/[token]/route.ts`                   | GET: validates approval token, returns review+response data, sets cookies                                                                                                    | Working |
| `approve/[token]/session/route.ts`           | POST: binds device cookie to approval link                                                                                                                                   | Working |
| `approve/[token]/approve/route.ts`           | POST: approves response, queues publishing                                                                                                                                   | Working |
| `approve/[token]/edit/route.ts`              | POST: approves with edits, computes Levenshtein distance                                                                                                                     | Working |
| `approve/[token]/regenerate/route.ts`        | POST: supersedes response, queues new generation                                                                                                                             | Working |

### Shared Business Logic (`src/lib/`)

#### `src/lib/reviews/` — Review fetching and normalization

| File                   | What it does                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `types.ts`             | Core types: NormalizedReview, ReviewSource interface, MonitorResult, identity types        |
| `serpapi-source.ts`    | Demo-mode fetcher: calls SerpAPI, normalizes to NormalizedReview                           |
| `serpapi-monitor.ts`   | Production-mode fetcher: same SerpAPI call but adds identity hashing + collision detection |
| `serpapi-normalize.ts` | Shared normalization logic used by both source and monitor                                 |
| `detect-language.ts`   | Language detection using franc-min (ISO 639-3 → 639-1 mapping)                             |
| `url-parser.ts`        | Extracts Google Place ID from various Maps URL formats                                     |
| `mock-source.ts`       | 8 canned reviews in 4 languages for mock mode                                              |
| `mock-monitor.ts`      | Mock version of SerpApiMonitor with identity enrichment                                    |
| `index.ts`             | Barrel exports                                                                             |

#### `src/lib/responses/` — AI response generation

| File                | What it does                                                                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`          | BusinessContext, VoiceExample, GenerationOptions, GenerationResult                                                                                                                                      |
| `prompt-builder.ts` | Builds system+user prompts for demo mode (infers tone) and production mode (uses business config)                                                                                                       |
| `generator.ts`      | Dual-mode generator: demo (no cost guard) and production (full cost lifecycle). OpenAI primary, Anthropic fallback. Supports skipCache for avoid-facts retry.                                           |
| `mock-generator.ts` | Template-based mock responses in 4 languages for mock mode                                                                                                                                              |
| `review-summary.ts` | LLM-powered multi-review intelligence brief generator. OpenAI→Anthropic fallback, cost reservation lifecycle, caps at 30 reviews, mock mode support. Used by WeeklySummaryWorker + MonthlyImpactWorker. |
| `voice-learning.ts` | Fetches owner-edited responses as few-shot voice examples (activates after 5 edits)                                                                                                                     |
| `index.ts`          | Barrel exports                                                                                                                                                                                          |

#### `src/lib/costs/` — Cost safety

| File         | What it does                                                                                                                                              |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tracker.ts` | Redis-based cost reservation (pessimistic 15 cents), concurrency limiter (max 3/business), regen budget (max 3/day), idempotent cache. Tier-aware limits. |
| `audit.ts`   | Postgres audit trail: recordApiCost(), linkApiCostToResponse(), calculateCostUsd() with model pricing                                                     |
| `index.ts`   | Barrel exports                                                                                                                                            |

#### `src/lib/approval/` — Approval flow

| File             | What it does                                                                                                                                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `service.ts`     | Core logic: lockValidLink (FOR UPDATE), establishSession, approve, edit (Levenshtein), regenerate. All methods receive a transaction client. Checks response is still pending before consuming link.              |
| `create-link.ts` | Shared approval link creation: generates randomUUID token, stores SHA-256 hash, supports `revokeMode: 'orphaned_only'` (normal) or `'always'` (nudge emails). Used by NotificationWorker + EngagementAlertWorker. |
| `cookies.ts`     | HMAC-signed device cookie + CSRF double-submit pattern. Constant-time comparisons.                                                                                                                                |
| `errors.ts`      | Typed errors: InvalidToken, Expired, Revoked, Consumed, DeviceConflict, ResponseNotPending                                                                                                                        |
| `http-errors.ts` | Shared error-to-HTTP-response mapper used by all 4 POST approval routes                                                                                                                                           |
| `index.ts`       | Barrel exports                                                                                                                                                                                                    |

#### `src/lib/notifications/` — Email sending

| File          | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `email.ts`    | sendApprovalEmail + sendInternalEmail + 8 template builders: buildManualPostEmailHtml, buildWeeklyValueReportHtml (AI brief, value stats, velocity, ranking, dashboard link), buildMonthlyImpactEmailHtml (monthly brief, best review, ranking), buildOwnerNudgeEmailHtml (pending reviews with approval buttons), buildPartnerEngagementAlertHtml, buildPartnerEscalationAlertHtml (red accent), buildPartnerLowEngagementAlertHtml (amber accent). All with HTML escaping + mock mode. |
| `delivery.ts` | Shared recordNotificationDelivery() — inserts into notification_deliveries. responseId is optional (supports business-level notifications like weekly/monthly reports).                                                                                                                                                                                                                                                                                                                  |
| `index.ts`    | Barrel exports                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

#### `src/lib/demos/` — Demo generation

| File           | What it does                                                                           |
| -------------- | -------------------------------------------------------------------------------------- |
| `generator.ts` | Fetches reviews + generates AI responses in parallel. Pure computation — no DB writes. |
| `types.ts`     | DemoJobPayload, DemoGeneratorInput/Result, DemoMetadata, DemoListItem                  |
| `index.ts`     | Barrel exports                                                                         |

#### `src/lib/shared/` — Shared utilities

| File                    | What it does                                                                                                                                                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subscription-guard.ts` | Checks if a worker should process work for a business. 4 statuses × 4 worker types.                                                                                                                                                                                                   |
| `outbox.ts`             | markOutboxCompleted() and markOutboxFailed() — used by every worker                                                                                                                                                                                                                   |
| `sanitize.ts`           | Strips control characters, null bytes, collapses whitespace                                                                                                                                                                                                                           |
| `rate-limit.ts`         | Atomic Lua script rate limiter on Redis. Gracefully skips when Redis unavailable.                                                                                                                                                                                                     |
| `mock-mode.ts`          | isMockMode() + getReviewMonitor() factory                                                                                                                                                                                                                                             |
| `churn-score.ts`        | Pure function `computeChurnRiskScore()` — 5 weighted signals (approval rate 30%, days since approval 25%, satisfaction pulse 20%, response time trend 15%, account age 10%). Returns score 0-100, level (healthy/watch/at_risk), and signal breakdown. Exported constants for tuning. |
| `worker-types.ts`       | Job payload interfaces: SyncReviews, GenerateResponse, SendNotification (with failover), PublishResponse, NotifyAdminException, WeeklySummary, SendMonthlyImpact, ValidatePlaceId, EngagementAlert (with alert_type + metrics)                                                        |
| `constants.ts`          | ResponseStatus, SubscriptionStatus, ExceptionType enums, NO_STORE_HEADERS, buildGoogleMapsUrl()                                                                                                                                                                                       |
| `schemas.ts`            | Shared Zod schemas for business validation: OnboardBusinessSchema, UpdateBusinessSchema, field sub-schemas                                                                                                                                                                            |
| `html.ts`               | Shared escapeHtml() used by email templates and workers                                                                                                                                                                                                                               |
| `index.ts`              | Barrel exports                                                                                                                                                                                                                                                                        |

#### `src/lib/db/` — Database clients + auth

| File                 | What it does                                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `server.ts`          | Postgres.js client (for transactions) + Supabase service-role client. 30s statement timeout.                                           |
| `browser.ts`         | Supabase browser client using `@supabase/ssr` createBrowserClient (auth-aware, manages cookies)                                        |
| `auth.ts`            | Server-side auth helpers: getCurrentUser (reads session from cookies, looks up users table), requireAuth, requireRole, AuthError class |
| `supabase-server.ts` | Cookie-aware Supabase client for Server Components and Route Handlers (anon key, RLS-aware)                                            |
| `redis-cache.ts`     | Redis cache client singleton (getCacheRedis) — used by rate limiter, cost tracker. Fails fast with 3s timeout when Redis unreachable.  |
| `client.ts`          | Deprecated — import from server.ts or browser.ts directly                                                                              |

#### `src/lib/reviews/` additions

| File                | What it does                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `process-review.ts` | Review ingestion state machine: dedup, content-hash comparison, branching (new/unchanged/edited). Extracted from ReviewSyncWorker for reuse by future GBP API Pub/Sub handler. |

#### Other

| File                                   | What it does                                                                                                                                                                                                          |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/publishing/index.ts`          | Placeholder — future GBP API posting                                                                                                                                                                                  |
| `src/types/index.ts`                   | Shared TypeScript interfaces placeholder                                                                                                                                                                              |
| `src/components/OwnerNav.tsx`          | Owner dashboard navigation — business name + sign-out button with error handling                                                                                                                                      |
| `src/components/DashboardContent.tsx`  | Owner dashboard client component — value summary banner, velocity BarChart, ranking LineChart (recharts), recent reviews with status badges + expandable responses, intelligence brief                                |
| `src/components/AdminNav.tsx`          | Admin navigation bar with responsive mobile menu                                                                                                                                                                      |
| `src/components/PlaceAutocomplete.tsx` | Google Maps Place Autocomplete input for business onboarding                                                                                                                                                          |
| `src/middleware.ts`                    | Supabase Auth session refresh + role-based route protection. Admin/sales*partner for /admin/*, owner for /dashboard/\_ and /api/dashboard (with no-store headers). Uses HTTP-based Supabase client (Edge-compatible). |

### Tests (`src/lib/*/__tests__/`)

| File                                                         | What it tests                                                                                                                                                                                                          |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reviews/__tests__/serpapi-source.test.ts`                   | Normalization, content hashing, language detection, URL parsing, SerpAPI adapter                                                                                                                                       |
| `responses/__tests__/prompt-builder.test.ts`                 | Category→tone inference, word limits, language, voice examples                                                                                                                                                         |
| `responses/__tests__/generator.test.ts`                      | OpenAI/Anthropic fallback, demo/production modes, cost lifecycle                                                                                                                                                       |
| `costs/__tests__/tracker.test.ts`                            | Cost calculation, reservation, concurrency, regen budget                                                                                                                                                               |
| `shared/__tests__/subscription-guard.test.ts`                | All statuses × worker types, grace period                                                                                                                                                                              |
| `shared/__tests__/sanitize.test.ts`                          | Control chars, null bytes, whitespace                                                                                                                                                                                  |
| `shared/__tests__/rate-limit.test.ts`                        | Allow, deny, exact limit                                                                                                                                                                                               |
| `approval/__tests__/service.test.ts`                         | lockValidLink variants, session binding, approve, edit, regenerate                                                                                                                                                     |
| `approval/__tests__/cookies.test.ts`                         | Device cookie HMAC, CSRF validation                                                                                                                                                                                    |
| `shared/__tests__/security.test.ts`                          | Prompt injection sanitization, XSS escaping, regen budget cost amplification, SHA-256 token hash verification via lockValidLink mock, webhook replay dedup logic, error type checks, subscription bypass (3 scenarios) |
| `shared/__tests__/churn-score.test.ts`                       | 39 tests: each signal independently, perfect engagement, fully disengaged, new account, boundary values (30/31/60/61), combined scoring, insufficient data, Sprint 5B null satisfaction                                |
| `responses/__tests__/review-summary.test.ts`                 | LLM summary, empty reviews, truncation, mock mode, fallback, both-fail, cost audit failure, cost reservation/finalization                                                                                              |
| `notifications/__tests__/email-templates.test.ts`            | Weekly value report (11 tests: brief, time saved, baseline, velocity, ranking, dashboard, escaping) + monthly impact (7 tests)                                                                                         |
| `notifications/__tests__/engagement-email-templates.test.ts` | Owner nudge (8 tests) + partner engagement (6 tests) + partner escalation (5 tests) + partner low-engagement (5 tests). HTML escaping on all.                                                                          |
| `api/dashboard/__tests__/route.test.ts`                      | 9 tests: auth errors, missing business, full data, null ranking/brief, zero velocity, weekly-over-monthly brief preference, pending reviews                                                                            |

### E2E Tests (`e2e/`)

| File               | Status                                                                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `seed.ts`          | Test data seed/cleanup helper. Creates unique business + review + response + approval_link per test. Safety: fails fast without `TEST_DATABASE_POOL_URL`. Cleanup in FK-safe order.                           | Working                                   |
| `approval.spec.ts` | 5 Playwright E2E scenarios: approve, edit (with Levenshtein), expired, regenerate (superseded + outbox), consumed. Per-test isolation with cleanup in `finally`. Skips gracefully when no test DB configured. | Working (requires TEST_DATABASE_POOL_URL) |

---

## Current Live Workflow

This is the complete working flow as of today:

```
1. ReconciliationPoller (every 60 min)
   → Finds active businesses due for sync
   → Inserts sync_reviews outbox entry (atomic dedup)

2. OutboxPoller (every 10 sec)
   → Reads pending outbox entries
   → Dispatches to BullMQ queues
   → Watchdog recovers entries stuck >1 hour

3. ReviewSyncWorker
   → Fetches reviews from SerpAPI (or mock)
   → Deduplicates by identity hash
   → Detects edits via content hash
   → New review → inserts generate_response outbox entry
   → Edited review + pending → fails old response, regenerates
   → Edited review + posted → creates admin exception

4. ResponseGeneratorWorker
   → Checks idempotent cache (skip if already generated)
   → Reserves cost budget (Redis atomic INCRBY)
   → Calls OpenAI gpt-4o-mini (falls back to Anthropic claude-haiku-4-5)
   → Checks avoid-facts, retries once with skipCache if violated
   → Persists response + send_notification outbox in one transaction

5. NotificationWorker
   → Generates raw approval token (randomUUID)
   → Stores only SHA-256 hash in approval_links
   → Sends approval email via Resend (or mock)
   → Records delivery in notification_deliveries

6. Owner clicks approval link in email
   → GET /approve/{token} → validates, shows review + draft response
   → POST /approve/{token}/session → binds device cookie
   → POST /approve/{token}/approve → consumes link, inserts publish_response outbox
   (or /edit with Levenshtein distance, or /regenerate → supersedes + new generation)

7. ResponsePublisherWorker
   → Sets response to awaiting_manual_post
   → Emails admin with approved text + Google Maps link
   → Records delivery for idempotent retry

8. Sales partner manually posts on Google Maps
   → Opens /admin/businesses/{id}
   → Copies approved text
   → Pastes on Google Maps
   → Clicks "Mark as Posted" → response status = posted
```

**Also working:**

- Demo generation (separate flow for sales prospects via /admin/demos)
- Business onboarding (form → Payment Link → Stripe checkout → webhook → active subscription → ReconciliationPoller picks up)
- Admin dashboard (overview with Health column, costs, notifications, jobs — all with real data)
- Owner dashboard (value summary, velocity chart, ranking chart, recent reviews, intelligence brief)
- Sentry error tracking on both Vercel and Railway
- Security headers on all responses
- NotificationFailoverPoller (every 2h) — re-sends approval emails that were never delivered, alerts admin on permanent failures
- WeeklySummaryScheduler (Monday 8-9 AM UTC) → WeeklySummaryWorker → sends Weekly Value Report with AI Intelligence Brief
- MonthlyImpactScheduler (1st of month 9-10 AM UTC) → MonthlyImpactWorker → sends Monthly Impact Report
- EngagementMonitorPoller (every 24h) → EngagementAlertWorker → owner nudges with fresh approval links + partner escalation alerts
- ArchivalPoller (every 24h) — cleans up old completed outbox entries, processed events, and expired demos
- Churn risk scoring on admin overview + business detail pages
- RankingTrackingScheduler (biweekly, feature-flagged) → RankingTrackingWorker → SerpAPI ranking search + upsert (strict fail-closed budget)
- OnboardingDripScheduler (hourly) → OnboardingDripWorker → day 1/7/30 onboarding emails with claim-before-send idempotency
- Owner settings page with notification opt-out (weekly/monthly toggle)
- Dashboard approval actions (approve/edit/regenerate via session auth, separate from token-based routes)
- Satisfaction pulse in weekly email (HMAC-signed links → scanner-safe GET confirmation → POST upsert + partner alert for "Not great")
- Admin keyword management + manual ranking entry on business detail page

---

## Sprint 5B Workflows

These are the new workflows added in Sprint 5B. Each one runs independently alongside the core review pipeline above.

### Automated Ranking Tracking

```
1. RankingTrackingScheduler (hourly, fires biweekly on even-week Sunday 22 UTC)
   → Checks RANKING_TRACKING_ENABLED === 'true' (skips silently if not)
   → Checks mock mode (skips if true)
   → Checks current time is Sunday, hour 22, ISO week number is even
   → Single query: finds active businesses with verified place ID +
     tracked keywords + location data (coords or search location)
   → Inserts track_ranking outbox entries with run_date for dedup
   → ON CONFLICT DO NOTHING (partial unique index prevents duplicates)

2. OutboxPoller dispatches to BullMQ

3. RankingTrackingWorker
   → Loads business, checks subscription_status === 'active' (strict — no past_due grace)
   → Re-checks google_place_id is still set
   → Parses tracked_keywords (JSONB guard + filters empty strings)
   → Limits to 1 keyword per business (Sprint 5B initial rollout)
   → Per-keyword: checks monthly SerpAPI budget via checkRateLimit({ strict: true })
     (fails closed when Redis unavailable — no ranking without budget enforcement)
   → In mock mode: generates random rank 1-10
   → In real mode: calls SerpAPI engine=google_maps with ll= (coords) or location= (text)
   → Finds business by matching place_id in local_results
   → Uses SerpAPI position field when available, falls back to index + 1
   → Upserts into ranking_snapshots ON CONFLICT (business_id, keyword, snapshot_date)
   → Marks outbox completed
```

### Owner Settings

```
1. Owner navigates to /settings (requires owner auth)

2. Page fetches GET /api/dashboard (includes settings data)
   → Shows read-only fields: name, category, Google Place ID
   → Shows editable fields: tone, products/services, avoid facts, sample responses
   → Shows notification preferences: channel (email/sms/both), phone, weekly/monthly toggles

3. Owner makes changes, clicks "Save Changes"
   → PUT /api/settings (Zod validated, owner-scoped by session — never accepts business_id in body)
   → Only sends changed fields (diff against initial values)
   → SMS channel requires phone number (checks stored phone for partial updates)
   → Success: green banner, auto-dismiss after 3 seconds

4. Opt-out takes effect:
   → WeeklySummaryScheduler skips businesses where weekly_summary_enabled = FALSE
   → MonthlyImpactScheduler skips businesses where monthly_impact_enabled = FALSE
```

### Dashboard Approval Actions

```
1. Owner navigates to /dashboard

2. Pending reviews show Approve / Edit / Regenerate buttons
   (only when review.responseStatus === 'pending_approval' AND responseText exists)

3. Owner clicks Approve:
   → POST /api/dashboard/reviews/{reviewId}/approve
   → requireRole('owner') + query scoped by business_id (prevents IDOR)
   → sql.begin: approveBySession() → lockPendingResponse + revokeOpenLinksForResponse
     + UPDATE status='approved' + INSERT publish_response outbox
   → approval_audit_log: auth_method='owner_session', actor_user_id, token_hash=NULL
   → ResponsePublisherWorker picks up (same manual-post flow as email-based approval)

4. Owner clicks Edit:
   → Textarea appears pre-filled with draft text
   → Owner modifies, clicks "Save & Approve"
   → POST /api/dashboard/reviews/{reviewId}/edit with { editedText }
   → Same flow as approve but computes Levenshtein distance, sets status='edited'

5. Owner clicks Regenerate:
   → POST /api/dashboard/reviews/{reviewId}/regenerate
   → Old response set to 'superseded', new generate_response outbox entry created
   → Owner sees "New draft requested — check your email"

Note: The existing email-based token approval flow is completely unchanged.
Dashboard actions are a parallel entry point using session auth, converging
on the same core response mutation logic.
```

### Onboarding Drip Emails

```
1. Business subscribes via Stripe
   → checkout.session.completed webhook fires
   → Sets subscription_activated_at = COALESCE(subscription_activated_at, NOW())
     (COALESCE preserves the anchor if re-activating from past_due)

2. OnboardingDripScheduler (hourly)
   → Single CROSS JOIN query: finds all (business, drip_type) pairs where:
     - subscription_status = 'active'
     - subscription_activated_at <= NOW() - interval (1/7/30 days)
     - No sent drip_log entry (sent_at IS NOT NULL)
     - No in-flight outbox entry
   → Inserts onboarding_drip outbox entries ON CONFLICT DO NOTHING

3. OutboxPoller dispatches to BullMQ

4. OnboardingDripWorker
   → Loads business, checks subscription_status === 'active'
   → Validates subscription_activated_at is not null (day 7/30)
   → Claims drip_log entry BEFORE any side effects:
     INSERT ... ON CONFLICT DO NOTHING RETURNING id
     If row exists: atomic UPDATE takeover if same outbox_id OR claim > 15 min stale
     If sent_at IS NOT NULL: skip (already sent)
   → Checks owner has auth (for dashboard URL)
   → Branches by drip_type:

   Day 1 (Welcome):
     → Sends welcome email: how it works, 30-second approval, weekly report mention
     → Conditional dashboard link (only if owner has auth mapping)

   Day 7 (First Week Recap):
     → Queries first-week stats bounded to [activatedAt, activatedAt + 7 days):
       reviews handled, time saved, response rate, highlight review, has edits
     → If pending reviews exist: creates fresh approval links via createApprovalLink()
       (throws if NEXT_PUBLIC_APP_URL missing — strict, matches owner-nudge behavior)
     → If zero reviews: "No reviews came in — we're watching"

   Day 30 (First Month Impact):
     → Queries first-month stats bounded to [activatedAt, activatedAt + 30 days)
     → Response rate before → now (from ROI baseline)
     → Ranking change if ranking_snapshots data exists
     → Sales partner sign-off (business-scoped via onboarded_by with role check)

   → Sends email via Resend (or mock)
   → Updates onboarding_drip_log.sent_at = NOW()
   → Records notification delivery
   → Marks outbox completed
```

### Satisfaction Pulse

```
1. WeeklySummaryWorker sends Weekly Value Report email
   → If CSRF_SECRET is configured:
     Builds 3 HMAC-signed feedback URLs (great / ok / not_great)
     HMAC input: business_id + rating + week_start_date
     Adds satisfaction pulse section at bottom of email:
     [Great]  [OK]  [Not great]

2. Owner clicks one of the three buttons
   → Opens GET /api/feedback?business_id=X&rating=Y&week=YYYY-MM-DD&sig=HMAC
   → Route validates: HMAC signature, UUID format, calendar date
   → Renders lightweight HTML confirmation page (NOT a Next.js page)
   → Shows rating label + "Submit Feedback" button
   → For "Not great": shows optional comment textarea
   → NEVER writes to database (email scanners prefetch GET URLs)

3. Owner clicks "Submit Feedback"
   → POST /api/feedback (HTML form submission, not JSON)
   → Re-validates HMAC from hidden form fields
   → Single sql.begin() transaction:
     a. Upsert satisfaction_responses ON CONFLICT (business_id, week_start_date)
        DO UPDATE SET rating, comment
     b. If rating = 'not_great':
        SELECT dedup check (existing alert for same business + week?)
        INSERT engagement_alert outbox ON CONFLICT DO NOTHING
        (ON CONFLICT prevents broad index from aborting the transaction)
   → Redirects 303 to /feedback/thanks

4. If "Not great" alert was queued:
   → OutboxPoller dispatches to BullMQ
   → EngagementAlertWorker.handleSatisfactionAlert()
     → Validates JSONB payload at runtime (rating, date, comment types)
     → Re-reads satisfaction_responses from DB (skips if owner changed to ok/great)
     → Checks week-scoped idempotency (template='partner_satisfaction_alert:YYYY-MM-DD')
     → Sends partner alert email with rating + comment + owner contact
     → Records delivery
```

---

## Page Workflow — What Links Where

This documents every page-to-page navigation path in the application,
verified against the source as of 2026-04-18.

### From the Landing Page — Full Traversal Map

The landing page `/` is the single entry point for both admins (via
`/admin/login`) and prospects. Below is the complete tree of what's
reachable from there, annotated with auth requirements and redirects.

```
/ (landing page, public)
│
├─[click "Admin Login" / "Get Started" / "Admin"]→ /admin/login
│
└─[click "See How It Works"]→ #how-it-works anchor (same page)


/admin/login (public, shared login for ALL roles — not admin-only despite the URL)
│
├─[sign-in succeeds, role = 'admin' or 'sales_partner']→
│      → honors ?from= if it's under /admin/*
│      → else → /admin/overview
│
├─[sign-in succeeds, role = 'owner']→
│      → honors ?from= if it's under /dashboard/* or /settings/*
│      → else → /dashboard
│
└─[sign-in succeeds, role unknown / missing]→ /admin/overview
       (middleware will bounce if role doesn't fit)


───── Admin branch (role = admin | sales_partner) ────────────────────

/admin/overview (the admin CRM home)
│ Landed here after admin sign-in. Shows system health cards + business
│ table sorted by churn risk. Has top AdminNav bar present on every
│ /admin/* page (except /admin/login and /admin/payment-success).
│
├─[AdminNav links]→ /admin/overview, /admin/businesses, /admin/demos,
│                   /admin/costs, /admin/notifications, /admin/jobs,
│                   /admin/runbook
├─[business table row click]→ /admin/businesses/[id]
├─[health "Demos" / "Manage" shortcut]→ /admin/demos / /admin/businesses
└─["Add Business" button]→ /admin/businesses/new


/admin/businesses (business list — paginated)
├─[AdminNav]→ same 7 admin links as above
├─[table row click]→ /admin/businesses/[id]
└─["Add Business" button]→ /admin/businesses/new


/admin/businesses/new (onboarding form)
│ react-hook-form + Zod. Creates business + owner user + initial
│ sync outbox in one atomic transaction. Returns Stripe Payment Link.
│
├─[form submit, paymentUrl returned]→ window.location = paymentUrl
│                                    (external — leaves the app to
│                                     Stripe Checkout)
├─[form submit, no paymentUrl]→ /admin/businesses/[id] (new detail page)
└─[AdminNav]→ same 7 admin links


/admin/businesses/[id] (business detail + review CRM)
│ Editable profile, review list with status badges, churn risk badge,
│ engagement breakdown, tracked keywords, ranking, manual-post section.
│
├─[inline profile editor save]→ PATCH /api/admin/businesses/[id]
│                               (no navigation — updates in place)
├─["Back to overview" link in header]→ /admin/overview
├─[Google Maps link]→ external maps.google.com
├─[Clear bounce flag button]→ PATCH {ownerEmailBounced:false}
│                            (no navigation)
├─[Manual Post Section "Copy to Clipboard"]→ clipboard only
├─[Manual Post Section "Mark as Posted"]→ POST .../mark-posted
│                                        (no navigation)
├─[Keywords PUT]→ PUT .../keywords (no navigation)
├─[Ranking manual entry]→ POST .../ranking (no navigation)
└─[AdminNav]→ same 7 admin links


/admin/demos (prospect demo generator)
├─["Generate Demo" button]→ POST /api/admin/demos/generate → polls
│                          /api/admin/demos for completion (no navigation)
├─[Demo list "Copy Link"]→ clipboard: /demo/<slug> URL
├─[Demo list slug link]→ /demo/[slug] (new tab)
└─[AdminNav]→ same 7 admin links


/admin/costs (cost monitoring — standalone dashboard)
├─[Day range selector]→ re-query via /api/admin/costs (no navigation)
└─[AdminNav]→ same 7 admin links


/admin/notifications (delivery log — standalone dashboard)
├─[Filter controls + pagination]→ re-query (no navigation)
└─[AdminNav]→ same 7 admin links


/admin/jobs (queue health — standalone dashboard)
├─[Shows 5 counters: Pending / Dispatching / Dispatched / Failed / Completed Today]
├─[Failed jobs pagination]→ re-query (no navigation)
└─[AdminNav]→ same 7 admin links


/admin/runbook (static quick-reference page)
├─[5-scenario "Customer says X" table — read only, no actions]
├─[Footer refs]→ docs/operational-runbook.md, docs/smoke-test-checklist.md,
│                docs/email-deliverability.md
│                (clickable anchors when NEXT_PUBLIC_DOCS_BASE_URL is set,
│                else rendered as <code> filenames)
└─[AdminNav]→ same 7 admin links


/admin/payment-success (post-Stripe-checkout landing)
│ Stripe redirects back here after the customer pays. Polls the
│ payment-success API by session_id to find the activated business.
│
├─[business found]→ router.push(/admin/businesses/[id])
├─["Go to business"/"Continue" buttons]→ /admin/businesses/[id]
└─["Go to overview"]→ /admin/overview
    (no AdminNav on this page — it's a transient landing)


───── Owner branch (role = owner) ────────────────────────────────────

/dashboard (owner home)
│ Landed here after owner sign-in. Has top OwnerNav bar present on
│ /dashboard and /settings.
│
├─[OwnerNav "Dashboard"]→ /dashboard
├─[OwnerNav "Settings"]→ /settings
├─[OwnerNav "Sign out"]→ router.push('/admin/login')
│                       (shared login page; on re-sign-in, role-aware
│                        redirect sends them back to /dashboard)
├─[Recent Reviews: Approve / Edit / Regenerate buttons on pending rows]→
│      POST /api/dashboard/reviews/[reviewId]/{approve,edit,regenerate}
│      (no navigation — content updates in place)
└─[No direct link to any public pages]


/settings (owner settings — profile + notification prefs)
├─[OwnerNav]→ same 3 items (/dashboard, /settings, Sign out)
├─["Save Changes"]→ PUT /api/settings (no navigation, shows toast)
└─[No links to other pages]


───── Email-triggered entry points (public URLs owners land on) ──────

Every approval email contains a token-authenticated URL that owners
click WITHOUT logging in. These are all public routes protected by
the HMAC/token in the URL itself.

/approve/[token] (approval page)
│ Owner lands here from an approval email. No auth UI — device cookie
│ + CSRF handle trust. Page is standalone (no nav bar).
│
├─["Approve" button]→ POST /api/approve/[token]/approve → success state
├─["Edit" button]→ textarea appears → "Save & Approve" →
│                  POST /api/approve/[token]/edit → success state
├─["Regenerate" button]→ POST /api/approve/[token]/regenerate → success state
├─[expired link]→ static "this link has expired" message
└─[already-consumed]→ static "already been approved" message


/demo/[slug] (prospect demo viewer)
│ Sales partner shares this URL with prospects. Renders their reviews
│ with AI-generated responses.
│
└─[CTA at bottom]→ mailto: link (NEXT_PUBLIC_CONTACT_EMAIL)


/api/feedback?business_id=X&rating=Y&week=...&sig=HMAC
│ Satisfaction pulse URLs in weekly value report emails. Validates
│ HMAC, renders a confirmation page. NOT a Next.js page — served
│ directly by the API route as HTML.
│
└─["Submit Feedback" button]→ POST /api/feedback → 303 redirect to
                              /feedback/thanks


/feedback/thanks (static thank-you page after satisfaction submission)
└─[No outbound links]
```

### Email → App Entry Points

These are the URLs embedded in customer-facing emails. All of them
land on the routes described above but originate from a worker's
email send, so they don't appear in any page-level navigation graph.

| Email                                                             | Button / link                               | Destination                                                    |
| ----------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------- |
| Approval request (transactional)                                  | "Review & Approve"                          | `/approve/[token]`                                             |
| Manual-post alert (internal to admin)                             | _(read-only instructions)_                  | _(admin opens Google Maps manually)_                           |
| Weekly Value Report (marketing)                                   | "See your full dashboard"                   | `/dashboard` (conditional on owner having auth)                |
| Weekly Value Report (marketing)                                   | Great / OK / Not great buttons              | `GET /api/feedback?...&sig=HMAC` → submit → `/feedback/thanks` |
| Monthly Impact Report (marketing)                                 | Dashboard link                              | `/dashboard`                                                   |
| Owner nudge (marketing)                                           | "Review & Approve" (one per pending review) | `/approve/[token]` (fresh link)                                |
| Onboarding drip day 1 (marketing)                                 | Dashboard link                              | `/dashboard` (conditional)                                     |
| Onboarding drip day 7 (marketing)                                 | Approval link per pending review            | `/approve/[token]`                                             |
| Onboarding drip day 30 (marketing)                                | _(read-only milestone)_                     | _(no link)_                                                    |
| Partner engagement / escalation / low-engagement alert (internal) | _(read-only)_                               | _(admin reads alert)_                                          |
| Partner satisfaction alert (internal)                             | _(read-only)_                               | _(admin reads alert)_                                          |
| Admin exception alert (internal)                                  | _(read-only)_                               | _(admin reads alert)_                                          |
| Notification failover re-send (transactional)                     | "Review & Approve"                          | `/approve/[token]` (replacement link)                          |

### Middleware Redirect Behavior

`src/middleware.ts` guards every page and API route. The behavior
matters for knowing where unauthenticated requests end up:

| Route pattern                               | Unauthenticated / wrong role     | Authenticated with correct role                             |
| ------------------------------------------- | -------------------------------- | ----------------------------------------------------------- |
| `/admin/login`                              | allowed                          | allowed (but the page itself sends you elsewhere on submit) |
| `/admin/*` (any other)                      | 302 → `/admin/login?from=<path>` | allowed                                                     |
| `/api/admin/*`                              | 401                              | allowed                                                     |
| `/dashboard/*`, `/settings/*`               | 302 → `/admin/login?from=<path>` | allowed                                                     |
| `/api/dashboard/*`, `/api/settings/*`       | 401 / 403                        | allowed                                                     |
| `/approve/*`, `/demo/*`, `/feedback/*`, `/` | always allowed (public)          | —                                                           |
| `/api/approve/*`, `/api/feedback`           | always allowed (token/HMAC auth) | —                                                           |

The login page (`/admin/login`) and the auth callback (`/api/auth/callback`)
are role-aware: after a successful sign-in they look up the user's role
and route to `/dashboard` for owner or `/admin/overview` for
admin/sales_partner. A requested `?from=` is honored only if the path
matches the user's role scope — otherwise the role default wins. This
prevents the post-sign-in redirect loop an owner would otherwise hit
when `?from` pointed into `/admin/*`.

### Known Navigation Observations (not bugs)

- **`/admin/login` is the shared login page for all roles.** The URL
  is misleading but changing it would break existing bookmarks and email
  templates. The page title is "RepWorth Admin" but actually accepts any
  role. The post-sign-in redirect is role-aware.
- **OwnerNav "Sign out" routes to `/admin/login`.** This is intentional
  (single login page for the whole app). After signing back in, the
  role-aware redirect sends owners to `/dashboard`.
- **No "back to landing" link anywhere inside the app.** Admins and
  owners are expected to stay inside their respective branches.
- **`/admin/runbook` references `docs/*.md` by filename.** These are
  clickable anchors only if `NEXT_PUBLIC_DOCS_BASE_URL` is set to the
  GitHub blob URL or similar. Otherwise they render as `<code>` text
  for oncall engineers with a local clone.
- **`/admin/payment-success` is transient.** It has no AdminNav (Stripe
  redirects here before the full admin shell is in play). It polls the
  payment-success API then redirects to the business detail page.

### Sprint 5B: Retention Expansion (Prompts 19b, 19c-5B, 19d-5B, 19e, 19g)

We built the remaining retention features — automated ranking tracking, owner settings with notification opt-out, dashboard approval actions, onboarding drip emails, and satisfaction pulse feedback.

**What it does:** Google Maps ranking is tracked automatically every two weeks via SerpAPI (feature-flagged, budget-capped). Business owners can now edit their profile and toggle weekly/monthly email preferences from a settings page. They can also approve, edit, or regenerate review responses directly from the dashboard (without needing the email link). New customers receive onboarding emails at day 1, 7, and 30 after subscribing. The weekly value report email now includes a satisfaction pulse — three buttons (Great / OK / Not great) that let the owner rate their experience without logging in. A "Not great" response triggers an alert to the sales partner.

**Automated Ranking Tracking (Prompt 19b):**

- RankingTrackingScheduler — runs hourly, fires biweekly on even-week Sundays at 22:00 UTC. Feature-flagged via `RANKING_TRACKING_ENABLED` env var (disabled by default). Queries eligible businesses (active, verified place ID, has coordinates or search location, non-empty tracked keywords).
- RankingTrackingWorker — calls SerpAPI `engine=google_maps` with the business's tracked keyword, finds the business by matching `place_id` in the results, and upserts the rank into `ranking_snapshots`. Uses SerpAPI's `position` field when available, falls back to array index. Strict active-only subscription check (no past_due grace for paid API calls).
- Monthly SerpAPI budget enforced via `checkRateLimit({ strict: true })` — fails closed when Redis is unavailable (unlike user-facing rate limits which fail open). Budget check is per-keyword, inside the loop — safe when keyword limit is raised.
- Admin business detail page has two new sections: Tracked Keywords (editable pill list, max 5, add/remove) and Ranking (recent snapshots table + manual entry form with keyword/rank/date).
- PUT `/api/admin/businesses/:id/keywords` — Zod validated, `.trim().min(1)` rejects whitespace-only
- POST `/api/admin/businesses/:id/ranking` — manual rank upsert with calendar date validation + FK→404

**Owner Settings + Dashboard Approval Actions (Prompt 19c-5B):**

- Owner settings page at `/settings` — two sections: Business Profile (read-only name/category/placeId, editable tone/products/avoid-facts/sample-responses) and Notification Preferences (email/sms/both channel toggle, phone number, weekly summary on/off, monthly impact on/off). Single "Save Changes" button sends only changed fields.
- PUT `/api/settings` — Zod validated, owner-scoped via `user.businessId` (never from request body). SMS channel requires phone number (checks stored phone from DB for partial updates).
- WeeklySummaryScheduler and MonthlyImpactScheduler respect `weekly_summary_enabled` / `monthly_impact_enabled` columns — businesses that opt out are skipped.
- ApprovalService refactored: new `approveBySession()`, `editBySession()`, `regenerateBySession()` methods share the same core mutation helpers as token-based methods but write `auth_method='owner_session'` + `actor_user_id` to audit log. Token-based routes untouched.
- Three new dashboard API routes: POST `/api/dashboard/reviews/[reviewId]/approve|edit|regenerate` — `requireRole('owner')`, business ownership check (query scoped by `business_id` to prevent IDOR), 409 for non-pending responses.
- Session-based actions revoke all open approval links for the response via `revokeOpenLinksForResponse()`.
- DashboardContent upgraded with Approve/Edit/Regenerate buttons on pending reviews (guard on `responseStatus === 'pending_approval'`, not `displayStatus` fallback).
- OwnerNav updated with Settings link.

**Partner Satisfaction Alert (Prompt 19d-5B):**

- `partner_satisfaction_alert` added to `EngagementAlertType` union
- `EngagementAlertPayload.satisfaction` optional field carries rating/comment/week_start_date
- `EngagementAlertPayload.metrics` made optional (satisfaction alerts don't need engagement metrics)
- `handleSatisfactionAlert()` in EngagementAlertWorker — validates JSONB payload at runtime (rating enum, date format, comment type), re-reads `satisfaction_responses` before sending (skips if owner changed rating from not_great), week-scoped idempotency via `template='partner_satisfaction_alert:YYYY-MM-DD'`, crash-safe outbox-completed-before-send
- `buildPartnerSatisfactionAlertHtml()` — red accent for not_great, amber for ok, shows comment + owner contact

**Onboarding Drip Emails (Prompt 19e):**

- Stripe webhook handler sets `subscription_activated_at = COALESCE(subscription_activated_at, NOW())` when activating — preserves anchor on re-activation from past_due.
- OnboardingDripScheduler — hourly poller, single CROSS JOIN query finds all (business, drip_type) pairs that are due. Index-friendly predicate (`activated_at <= NOW() - interval`). Only suppresses drips where `sent_at IS NOT NULL` (allows stale claim recovery).
- OnboardingDripWorker — three-way claim system: INSERT new claim → own-outbox retry → stale takeover (>15 min). Prevents concurrent duplicate sends via `claimed_by_outbox_id` column. Claims BEFORE any side effects (approval link creation).
  - Day 1: Welcome email — how it works (3-step list), 30-second approval, weekly report mention, conditional dashboard link
  - Day 7: First-week recap — reviews handled + time saved + response rate (all window-bounded to activation + 7 days), highlight review+response pair, edit acknowledgment, pending reviews with fresh approval links via `createApprovalLink()`. Throws when `NEXT_PUBLIC_APP_URL` missing and pending reviews exist.
  - Day 30: Monthly impact — total reviews, response rate before → now, time saved, ranking change if data exists. Business-scoped sales partner lookup (via `onboarded_by` with role check).
- `sent_at` set only after `sendInternalEmail()` succeeds. Delivery recorded before outbox completion.

**Satisfaction Pulse (Prompt 19g):**

- Weekly Value Report email now includes a satisfaction pulse section at the bottom: three HMAC-signed buttons (Great / OK / Not great). Links use `CSRF_SECRET` for signing. Only rendered when `CSRF_SECRET` is configured.
- HMAC helper (`src/lib/shared/feedback-hmac.ts`) — `signFeedback()`, `verifyFeedback()` (hex pattern validation + `Buffer.from(sig, 'hex')` + `timingSafeEqual`), `buildFeedbackUrl()`.
- GET `/api/feedback` — validates HMAC + UUID format + calendar date, renders lightweight HTML confirmation page with hidden signed fields. Shows optional comment textarea for not_great. **Never writes to DB** (email scanners prefetch GET URLs).
- POST `/api/feedback` — re-validates HMAC, single `sql.begin()` transaction: upserts `satisfaction_responses` on `(business_id, week_start_date)` + conditionally inserts `engagement_alert` outbox entry for not_great. Uses SELECT dedup + `INSERT ON CONFLICT DO NOTHING` to avoid aborting the transaction from the broad engagement-alert index. Redirects 303 to `/feedback/thanks`.
- Migration 016 replaces the broad `idx_jo_engagement_alert_inflight` index (which blocked different-week satisfaction alerts) with two indexes: one excluding `partner_satisfaction_alert`, one week-scoped for satisfaction alerts specifically.
- Static `/feedback/thanks` page.

**New database objects (3 migrations):**

- Migration 014: `onboarding_drip_log` table, `satisfaction_responses` table, 8 new columns on `businesses` (subscription_activated_at, tracked_keywords, google_place_address/lat/lng, ranking_search_location, weekly_summary_enabled, monthly_impact_enabled), `approval_audit_log` alterations (nullable token_hash, actor_user_id, auth_method), ranking dedup indexes, JSONB array CHECK constraint
- Migration 015: `onboarding_drip_log` claim/sent state separation (nullable sent_at, claimed_at, claimed_by_outbox_id), outbox dedup index for onboarding_drip, scheduler performance index
- Migration 016: Week-scoped satisfaction alert index (replaces broad engagement alert dedup)

---

## Every File In The Project

_(Additions and changes from Sprint 5B are marked with 🆕 for new files and 📝 for modified files)_

### Database (`supabase/migrations/`) — Sprint 5B additions

| File                                  | What it does                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------ |
| 🆕 `014_retention_expansion.sql`      | 2 new tables, 8 business columns, audit log alterations, ranking indexes, JSONB constraint |
| 🆕 `015_drip_log_claim_state.sql`     | Drip log claim/sent separation, outbox dedup index, scheduler performance index            |
| 🆕 `016_satisfaction_alert_index.sql` | Week-scoped satisfaction alert index, fixes broad engagement dedup                         |

### Worker Process (`worker/`) — Sprint 5B additions

| File                                  | What it does                                                                                                  | Status  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------- |
| 🆕 `jobs/RankingTrackingScheduler.ts` | Biweekly poller (even-week Sunday 22 UTC). Feature-flagged. Single query with dedup.                          | Working |
| 🆕 `jobs/RankingTrackingWorker.ts`    | SerpAPI google_maps search, place_id matching, ranking_snapshots upsert. Strict fail-closed budget.           | Working |
| 🆕 `jobs/OnboardingDripScheduler.ts`  | Hourly poller. Single CROSS JOIN query finds due drips. Only suppresses sent drips.                           | Working |
| 🆕 `jobs/OnboardingDripWorker.ts`     | Three-way claim (INSERT/retry/stale takeover). Day 1 welcome, day 7 recap with approval links, day 30 impact. | Working |
| 📝 `jobs/EngagementAlertWorker.ts`    | Added `handleSatisfactionAlert()` — validates JSONB, re-reads DB before sending, week-scoped idempotency      | Working |
| 📝 `jobs/EngagementMonitorPoller.ts`  | COOLDOWNS changed to Partial (satisfaction alerts excluded — dedup is in the worker)                          | Working |
| 📝 `jobs/WeeklySummaryWorker.ts`      | Passes HMAC-signed feedback URLs to the weekly email template                                                 | Working |
| 📝 `jobs/WeeklySummaryScheduler.ts`   | Respects `weekly_summary_enabled` opt-out flag                                                                | Working |
| 📝 `jobs/MonthlyImpactScheduler.ts`   | Respects `monthly_impact_enabled` opt-out flag                                                                | Working |
| 📝 `ingress/stripe.ts`                | Sets `subscription_activated_at = COALESCE(subscription_activated_at, NOW())` on activation                   | Working |
| 📝 `index.ts`                         | Registers 4 new workers/schedulers (ranking + drip) with start/stop lifecycle                                 | Working |
| 📝 `queues.ts`                        | Added `TRACK_RANKING` and `ONBOARDING_DRIP` queues                                                            | Working |

### Worker Tests — Sprint 5B additions

| File                                            | Tests                                                                                                                                                                                         |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🆕 `__tests__/RankingTrackingScheduler.test.ts` | Feature flag, mock mode, time gates, eligible business query, dedup, ISO week, lifecycle (19 tests)                                                                                           |
| 🆕 `__tests__/RankingTrackingWorker.test.ts`    | Subscription guard, empty keywords, JSONB guard, budget cap, Redis unavailable, coords vs location, SerpAPI position, NULL rank, mock mode, keyword limit, SerpAPI error (16 tests)           |
| 🆕 `__tests__/OnboardingDripScheduler.test.ts`  | Mock mode, day offsets, drip_log/outbox dedup, multi-drip queuing, lifecycle (12 tests)                                                                                                       |
| 🆕 `__tests__/OnboardingDripWorker.test.ts`     | Day 1/7/30 emails, auth check, approval links, zero reviews, ranking, claim idempotency, stale takeover, subscription guard (12 tests)                                                        |
| 📝 `__tests__/EngagementAlertWorker.test.ts`    | Added satisfaction alert tests: send with rating+comment, no comment, missing data, invalid rating/date, idempotency skip, rating changed skip, admin email missing (added 9 tests, total 23) |

### Next.js Pages — Sprint 5B additions

| File                                   | What it does                                                                        | Status  |
| -------------------------------------- | ----------------------------------------------------------------------------------- | ------- |
| 📝 `(authenticated)/settings/page.tsx` | Owner settings page — profile editing + notification preferences + opt-out toggles  | Working |
| 🆕 `(public)/feedback/thanks/page.tsx` | Static thank-you page after satisfaction pulse submission                           | Working |
| 📝 `admin/businesses/[id]/page.tsx`    | Added TrackedKeywordsSection (editable pills) + ManualRankingSection (table + form) | Working |

### API Routes — Sprint 5B additions

| File                                                  | What it does                                                                                      | Status  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------- |
| 🆕 `admin/businesses/[id]/keywords/route.ts`          | PUT: update tracked keywords (max 5, Zod validated)                                               | Working |
| 🆕 `admin/businesses/[id]/ranking/route.ts`           | POST: manual rank entry with date validation + FK→404                                             | Working |
| 🆕 `dashboard/reviews/[reviewId]/approve/route.ts`    | POST: session-auth approve (owner scoped)                                                         | Working |
| 🆕 `dashboard/reviews/[reviewId]/edit/route.ts`       | POST: session-auth edit with Zod validation                                                       | Working |
| 🆕 `dashboard/reviews/[reviewId]/regenerate/route.ts` | POST: session-auth regenerate                                                                     | Working |
| 🆕 `settings/route.ts`                                | PUT: owner settings update with SMS phone validation                                              | Working |
| 🆕 `feedback/route.ts`                                | GET: HMAC-validated confirmation page (no DB write). POST: upsert satisfaction_responses + outbox | Working |
| 📝 `admin/businesses/[id]/route.ts`                   | Returns trackedKeywords + rankingSnapshots + location data in GET                                 | Working |
| 📝 `dashboard/route.ts`                               | Returns settings data (tone, prefs, opt-out flags) in GET                                         | Working |

### API Route Tests — Sprint 5B additions

| File                                                        | Tests                                                                                                      |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 🆕 `admin/businesses/[id]/keywords/__tests__/route.test.ts` | Non-array, >5, valid, empty, 404, whitespace (6 tests)                                                     |
| 🆕 `admin/businesses/[id]/ranking/__tests__/route.test.ts`  | Missing keyword, rank 0, valid, default date, null rank, invalid date, whitespace (7 tests)                |
| 🆕 `dashboard/reviews/__tests__/actions.test.ts`            | All 3 routes: auth, 404, business scoping, validation, 409 not pending (17 tests)                          |
| 🆕 `settings/__tests__/route.test.ts`                       | No business, empty body, tone, prefs, toggles, invalid enum, body injection (11 tests)                     |
| 🆕 `feedback/__tests__/route.test.ts`                       | GET valid/invalid/missing, POST upsert/not_great outbox/great no outbox, redirect, comment trim (17 tests) |

### Shared Business Logic — Sprint 5B additions

| File                                 | What it does                                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| 🆕 `src/lib/shared/feedback-hmac.ts` | HMAC sign/verify for satisfaction pulse links (SHA-256, CSRF_SECRET, hex validation, constant-time compare)        |
| 📝 `src/lib/shared/rate-limit.ts`    | Added `{ strict: true }` option — throws on Redis errors instead of failing open                                   |
| 📝 `src/lib/shared/worker-types.ts`  | Added TrackRankingPayload, OnboardingDripPayload, EngagementAlertPayload.satisfaction field, metrics made optional |
| 📝 `src/lib/approval/service.ts`     | Added approveBySession/editBySession/regenerateBySession + SessionAuditContext + revokeOpenLinksForResponse        |
| 📝 `src/lib/notifications/email.ts`  | Added 6 templates: 3 onboarding drip + satisfaction pulse section in weekly report + partner satisfaction alert    |

### Shared Tests — Sprint 5B additions

| File                                                | Tests                                                                                                           |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 🆕 `src/lib/shared/__tests__/feedback-hmac.test.ts` | Consistent signing, verify valid/tampered/wrong-length, buildFeedbackUrl (8 tests)                              |
| 📝 `src/lib/shared/__tests__/rate-limit.test.ts`    | Added strict mode tests: Redis fail throws, REDIS_CACHE_URL missing throws, default mode still allows (4 tests) |

### Components — Sprint 5B changes

| File                                     | What changed                                                                           |
| ---------------------------------------- | -------------------------------------------------------------------------------------- |
| 📝 `src/components/DashboardContent.tsx` | Added ReviewActions component with Approve/Edit/Regenerate buttons for pending reviews |
| 📝 `src/components/OwnerNav.tsx`         | Added Settings link                                                                    |

### Other — Sprint 5B changes

| File                   | What changed                                                              |
| ---------------------- | ------------------------------------------------------------------------- |
| 📝 `src/middleware.ts` | Added `/api/settings` to owner route protection                           |
| 📝 `.env.example`      | Added `RANKING_TRACKING_ENABLED=false` and `RANKING_TRACKING_INTERVAL_MS` |

---

### Sprint 6: Scale + Operational Polish (Prompts 20a-20e)

We built the infrastructure and polish needed to operate the system at 10-20 paying customers without ops firefights — end-to-end request tracing, automatic archival of old cost data, auto-fill on the onboarding form, hard bounce detection for email compliance, and a full launch-readiness runbook.

**What it does:** Every review now carries an ID that threads through the entire pipeline, so oncall can trace a single review from sync → generate → notify → publish with one SQL query. Cost records older than 90 days are automatically rolled up into daily aggregates and the detail rows deleted, so `api_costs` stops growing unbounded. When a sales partner onboards a business, SerpAPI pre-fills the category, phone, and website — the admin just picks a place and most of the form is already filled. If an email hard-bounces, the system detects it from the Resend webhook, flags the business so it stops getting emails, and alerts the admin. There is now a written runbook explaining what to do when things break and a smoke-test checklist to validate the whole pipeline before the first real customer.

**Correlation IDs + Structured Logging (Prompt 20a):**

- New `createWorkerLogger()` helper wraps every worker's logs with a consistent prefix and an optional correlation ID tag. One ID follows a single review's whole chain: `sync_reviews → generate_response → send_notification → publish_response`.
- `BasePayload` interface added to all 12 outbox payload types with a `correlation_id?: string` field. IDs generated at every entry point: 7 pollers/schedulers (using `uuidv7()`), 3 admin API routes, and at every outbox INSERT inside the workers.
- `recoverCorrelationId()` helper in `src/lib/approval/correlation.ts` looks up the upstream `generate_response` payload by `review_id` when the approval flow crosses the token/session boundary, so approve/edit/regenerate actions stay on the original ID instead of generating a new one.
- 12 workers replaced `console.log` with `createWorkerLogger`. All PII (emails, names) scrubbed from correlation-tagged logs — only business_id / response_id appears.
- Migration 018 adds `idx_jo_correlation_id` (expression index on `payload->>'correlation_id'`) + rebuilds `idx_jo_sync_reviews_inflight` to include the `'dispatching'` status + adds `idx_jo_generate_response_by_review` for the canonical correlation-recovery lookup.
- Single trace SQL: `SELECT id, topic, status, attempts FROM job_outbox WHERE payload->>'correlation_id' = '<id>' ORDER BY created_at`.

**Archival Expansion + Cost Rollups (Prompt 20b):**

- New `api_costs_daily_rollups` table aggregates `api_costs` rows older than 90 days into one row per `(business_id, provider, rollup_date)`. Uses Postgres 15's `UNIQUE NULLS NOT DISTINCT` so platform-level costs (business_id=NULL, like SerpAPI prefill) aggregate correctly too.
- ArchivalPoller extended: new `api_costs` branch uses a DELETE-first CTE pattern (`FOR UPDATE SKIP LOCKED` → `DELETE ... RETURNING` → aggregate from RETURNING → upsert with additive `ON CONFLICT DO UPDATE`). This is atomic — no matter how many archival cycles overlap, each row is counted exactly once.
- `notification_deliveries` older than 90 days are straight-deleted (no rollup — the operational dedup windows are much shorter).
- Admin `/admin/costs` page now supports date ranges up to 365 days. The API merges detail rows (<90 days) with rollup rows (>=90 days) via a server-side UNION CTE — detail takes precedence on any same-date collision. `todayTotalUsd` stays detail-only.
- Schema also adds `businesses.website` (used by Prompt 20c) and `businesses.owner_email_bounced` (used by Prompt 20d).
- Fixes during review round: `days=0` clamping bug, negative `limit` handling, NUMERIC(14,6) widening for cost, BIGINT for tokens, server-side pagination via UNION CTE.

**Onboarding Automation + SerpAPI Pre-fill (Prompt 20c):**

- New `src/lib/reviews/serpapi-prefill.ts` module: takes a Google Place ID, calls SerpAPI `engine=google_maps`, returns a normalized `BusinessPrefill` object `{ category, phone, website, hours, fullAddress }`. Never throws — returns all-nulls on any failure.
- 7-day Redis cache by place_id. Cost tracked in `api_costs` with `business_id=NULL` (platform-level) on every outbound SerpAPI call including timeouts/errors (so admin dashboards don't underreport quota burn).
- 2-second `Promise.race` timeout so a stalled SerpAPI doesn't hang the onboarding UI.
- New admin-only route `/api/admin/businesses/prefill` with a 10/min per-user strict rate limit (returns 503 when Redis unavailable — prevents uncapped SerpAPI spend).
- Onboarding form at `/admin/businesses/new` auto-triggers prefill after PlaceAutocomplete selection. Uses `getFieldState(name).isDirty` at response-apply time (not captured at render time) so a user editing mid-flight never gets their edits overwritten. Clear button resets prefilled fields so the next selection starts fresh.
- Website field added to the form, onboarding INSERT, `FIELD_TO_COLUMN` PATCH mapping, business detail display + edit form.
- New `websiteUrlSchema` in `src/lib/shared/schemas.ts` — only accepts `http://` or `https://`, rejects `javascript:`/`data:`/`mailto:` etc. Defense-in-depth `safeHttpUrl()` at render time.
- During this prompt's development we also extended `normalizeResponse` to read `type`/`types`/`category`/`categories` variants for category (SerpAPI returns different field names for chains vs individual places) and to handle both object and array shapes for hours.

**Email Deliverability + Hard Bounce Handling (Prompt 20d):**

- New `EmailCategory` type: `'transactional' | 'marketing' | 'internal'`. Each send path tags its category explicitly.
- Marketing emails (weekly/monthly/drip/nudge) get RFC-8058-compliant `List-Unsubscribe` headers — required by Gmail and Yahoo's Feb-2024 bulk-sender rules. If `LIST_UNSUBSCRIBE_URL` is set, emits both the HTTPS form and the `List-Unsubscribe-Post: One-Click` header. Otherwise falls back to mailto-only (still valid). URL validation rejects unsafe schemes.
- Resend webhook (`worker/ingress/resend.ts`) upgraded: classifies bounce types defensively (reads `data.bounce.type`, `data.reason`, `data.status` — whichever SerpAPI sends), normalizes into `bounced:hard:<raw>` or `bounced:soft:<raw>`. Only flags `businesses.owner_email_bounced=TRUE` when the bounced template is owner-directed (approval*request / weekly_value_report / monthly_impact / owner_nudge / onboarding_drip*_). Admin-directed template bounces (admin*manual_post, partner*_ alerts) log-and-skip. `UPDATE ... IS DISTINCT FROM TRUE RETURNING id` transition guard means the admin alert fires only on the flag's FALSE→TRUE flip — no duplicates from replayed webhooks.
- Skip-if-bounced guards in 5 owner-directed workers: NotificationWorker, WeeklySummaryWorker, MonthlyImpactWorker, OnboardingDripWorker, EngagementAlertWorker.handleOwnerNudge. EngagementMonitorPoller excludes bounced businesses from `owner_nudge` at query time. Partner/admin alerts still send to the admin regardless of the owner's bounce state.
- Admin `/admin/overview` gets a new Email Health card: 24h delivery rate (%, green/red), 7d bounces / hard bounces / complaints. Red state when delivery rate drops below 95% (with ≥5 sends) OR any complaint/hard bounce in the last 7 days.
- Business detail page shows a red "Owner email is bouncing" banner with a "Clear bounce flag" button when `owner_email_bounced=true`. Banner explains exactly which emails are being skipped.
- Owner email is now editable via the admin profile editor (added to `UpdateBusinessSchema` + `FIELD_TO_COLUMN` + the Edit form). Banner points admins to the editor.
- Migration 019 adds partial indexes on `notification_deliveries(external_message_id)`, `(sent_at)`, `(failed_at, failure_reason)` — all scoped to `WHERE ... IS NOT NULL` so they stay small.
- New `docs/email-deliverability.md` — full runbook covering SPF/DKIM/DMARC DNS setup, warmup schedule (2-3 customers/week first month), monitoring, troubleshooting table, hard-bounce flow, env vars, List-Unsubscribe compliance rationale.

**Launch Readiness Documentation (Prompt 20e):**

- New `docs/operational-runbook.md` — 5 sections: "Customer says X" troubleshooting (5 scenarios), daily 2-minute health check, debugging SQL queries (correlation-id trace + 6 others), incident response (7 scenarios with Auto vs Manual columns), weekly maintenance tasks.
- New `docs/smoke-test-checklist.md` — manual pre-launch E2E test across 3 real businesses (happy path, edit + concurrent onboarding, regenerate + correlation trace). Includes throughput sanity check and mobile approval performance check.
- New admin page at `/admin/runbook` — static client component, renders 5 "Customer says X" scenarios as a quick-reference table. Links to the full markdown files by filename (clickable if `NEXT_PUBLIC_DOCS_BASE_URL` env is set).
- AdminNav gains a "Runbook" link.
- Fixes from review: correlation-trace SQL corrected for actual `aggregate_id` semantics (sync_reviews uses business_id, generate_response uses review_id, send_notification/publish_response use response_id), smoke checklist cost assertions rewritten to match what the app actually records, place-id recovery procedure documented with real SQL, D2 Redis guidance corrected to reflect `reserveCost` throwing on Redis failure.

**Cross-cutting fixes (post-Sprint-6 cleanup):**

- **JSONB double-encoding fix (migration 020).** Root cause: `${JSON.stringify(payload)}::jsonb` in Postgres.js v3 double-encodes — when a string is bound to a jsonb position, Postgres.js wraps it in additional JSON quotes, producing a JSONB scalar string instead of a JSONB object. Result: `payload->>'correlation_id'` returned NULL on every row, runbook C1 trace was broken, correlation index was useless, 20% storage bloat. Fix: new `jsonb()` helper in `src/lib/db/server.ts` wraps `sql.json(value)` with a type cast — at runtime Postgres.js sends the object as a Parameter with OID 3802, serialized exactly once. All 34 call sites across 19 files swept. Migration 020 normalizes existing scalar-string rows across 8 JSONB columns.
- **Redis cache client first-request race fix.** `enableOfflineQueue: false` was too aggressive — the FIRST prefill request after dev-server boot would error with "Stream isn't writeable" before ioredis finished the TCP handshake. Flipped to the default `true`. Fail-fast on a truly-dead Redis is still guaranteed by `connectTimeout: 3s` + `retryStrategy` returning null after 2 retries.
- **Queue-name registry extracted.** Moved `QUEUE_NAMES` to `src/lib/shared/queue-names.ts` (pure constants, no BullMQ imports). Both `worker/queues.ts` and the admin `/api/admin/jobs` route now import from the same source of truth — the list can't drift again.
- **NotificationFailoverPoller correlation preservation.** Failover jobs used to generate a fresh uuidv7(), breaking the traceability chain. New `recoverFailoverCorrelationId()` helper looks up the prior `send_notification` row first, falls back to the upstream `generate_response` row, only uses a fresh ID as a last resort.
- **SerpAPI prefill cost on timeout.** Cost is now recorded even on timeout/error (endpoint tagged `:failed`). Without this, admin cost dashboards underreported quota burn exactly when something was going wrong. Cache write is skipped on failure so the next selection retries.
- **Admin cost boundary-day bug.** Rollup query used strict `<` against `CURRENT_DATE - 90 days`, silently losing the morning portion of the archived boundary day. Fixed to `<=` across 4 query locations. Regression test asserts the boundary operator.
- **List-Unsubscribe-Post compliance.** The Post header was emitted without an HTTPS URL, which per RFC 8058 is non-functional (and misleading to Gmail/Outlook). Now conditional on `LIST_UNSUBSCRIBE_URL` being set.

**New database objects (4 migrations):**

- Migration 017 (`sprint6_scale.sql`): `api_costs_daily_rollups` table with `UNIQUE NULLS NOT DISTINCT` + 3 indexes, `businesses.website`, `businesses.owner_email_bounced`, `idx_nd_created_at`
- Migration 018 (`correlation_and_dispatching_indexes.sql`): correlation expression index, sync_reviews in-flight index rebuilt to include `'dispatching'`, generate_response lookup index for correlation recovery
- Migration 019 (`notification_delivery_bounce_indexes.sql`): partial indexes on external_message_id / sent_at / (failed_at, failure_reason)
- Migration 020 (`normalize_jsonb_scalar_strings.sql`): one-time data repair — converts JSONB scalar strings back to proper objects across 8 columns (`UPDATE ... SET col = (col#>>'{}')::jsonb WHERE jsonb_typeof(col) = 'string'`)

---

## Sprint 6 Workflows

### End-to-End Correlation Trace

```
1. Entry point generates correlation_id
   → ReconciliationPoller inserts sync_reviews with correlation_id = uuidv7()
   → Or: approval API route generates correlation_id and passes it forward

2. ReviewSyncWorker reads payload.correlation_id
   → Propagates it into every generate_response outbox entry it creates
   → Same ID appears in the worker's structured logs (createWorkerLogger)

3. ResponseGeneratorWorker
   → Reads correlation_id from job payload
   → Passes it into the send_notification outbox entry

4. NotificationWorker / ResponsePublisherWorker
   → Same propagation pattern: read from payload, write to next outbox

5. Approval flow crosses a boundary
   → recoverCorrelationId(tx, { reviewId, responseId }) looks up the upstream
     generate_response payload and reuses its correlation_id
   → publish_response outbox entry carries the ORIGINAL chain ID, not a fresh one

6. Oncall trace query
   → SELECT * FROM job_outbox WHERE payload->>'correlation_id' = '<id>'
     ORDER BY created_at
   → Uses idx_jo_correlation_id (expression index, fast)
   → Returns every hop of the review chain in chronological order
```

### Archival + Cost Rollup

```
1. ArchivalPoller fires every 24 hours

2. For each of 5 targets (outbox, inbound_events, prospect_demos,
   api_costs, notification_deliveries):

   a. outbox: DELETE completed entries >7 days old (batch 5000)
   b. inbound_events: DELETE processed events >30 days (batch 5000)
   c. prospect_demos: DELETE expired >30 days past expiry (batch 5000)

   d. api_costs (NEW): atomic claim-and-aggregate CTE
      → candidates CTE: SELECT id FROM api_costs
        WHERE created_at < NOW() - INTERVAL '90 days'
        ORDER BY created_at, id LIMIT 5000
        FOR UPDATE SKIP LOCKED
      → deleted CTE: DELETE FROM api_costs WHERE id IN (candidates)
        RETURNING business_id, provider, created_at::date, cost_usd, tokens
      → aggregated CTE: SUM by (business_id, provider, cost_date)
      → INSERT INTO api_costs_daily_rollups
        ON CONFLICT ON CONSTRAINT uniq_cost_rollups_business_provider_date
        DO UPDATE SET total_cost_usd = existing + EXCLUDED (additive)

   e. notification_deliveries (NEW): DELETE >90 days old (batch 5000)

3. Logs per-target counts with saturation warning at 80% of batch size

4. Admin /admin/costs query logic:
   → If days <= 90: detail-only UNION CTE (single query)
   → If days > 90: detail + rollup UNION CTE
     - Detail rows authoritative on same-date collision
     - byBusiness pagination is server-side (SQL UNION + GROUP BY + LIMIT)
     - byDay is additive merge (rollup morning + detail afternoon)
```

### SerpAPI Prefill on Onboarding

```
1. Admin navigates to /admin/businesses/new

2. Admin selects a place in the PlaceAutocomplete widget
   → onPlaceSelect fires with { placeId, formattedAddress, lat, lng }
   → triggerPrefill(placeId) called async

3. triggerPrefill:
   → AbortController cancels any previous in-flight request
   → latestPlaceIdRef = placeId (guard against stale responses)
   → GET /api/admin/businesses/prefill?place_id=...

4. /api/admin/businesses/prefill route:
   → requireRole('admin', 'sales_partner')
   → checkRateLimit('prefill:minute:<userId>', 10, 60, { strict: true })
     → Returns 503 if Redis unavailable (no uncapped spend)
   → Calls fetchBusinessDetails(placeId)

5. fetchBusinessDetails:
   → Mock mode: return canned data
   → Cache read: 7-day TTL by place_id → return cached if hit
   → SerpAPI key guard: return empty if missing
   → Promise.race: getJson(engine=google_maps) vs 2s timeout
   → Record cost (always, even on failure) with endpoint = google_maps_prefill
     or google_maps_prefill:failed
   → Cache write (only on success)
   → Return { category, phone, website, hours, fullAddress } or all-nulls

6. Client response-apply:
   → Check latestPlaceIdRef === placeId (discard stale)
   → For each fillable field: check getFieldState(name).isDirty LIVE (not
     captured) — only fill if empty AND untouched by user
   → setValue('category', prefill.category, { shouldDirty: false })

7. Clear button:
   → cancelPrefill() aborts in-flight, clears latestPlaceIdRef
   → Resets googlePlaceId + googlePlaceAddress + prefilled fields via
     resetField() (also clears dirty state for next selection)
```

### Hard Bounce Handling

```
1. Resend sends an email. Some time later the recipient's MTA rejects it.

2. Resend POSTs to /ingress/resend on the Railway worker
   → Svix signature verification, stale-timestamp check, dedup via inbound_events
   → Body includes type='email.bounced' and a bounce classification

3. Worker extracts bounce type defensively
   → Tries data.bounce.type, data.reason, data.status (first one wins)
   → Normalizes via classifyBounce() into:
     - bounced:hard:<raw>  (matches 'permanent', 'hard', 'hardbounce', 'hard_bounce',
                             'permanent_failure', or anything containing 'permanent')
     - bounced:soft:<raw>  (everything else — including the 'unknown' fallback)

4. Worker looks up the delivery row by external_message_id
   → Gets business_id AND template

5. Worker UPDATEs notification_deliveries.failure_reason = normalized reason

6. If isHard AND template is owner-directed (approval_request,
   weekly_value_report, monthly_impact, owner_nudge, onboarding_drip_*):
   → UPDATE businesses SET owner_email_bounced = TRUE
     WHERE id = business_id AND owner_email_bounced IS DISTINCT FROM TRUE
     RETURNING id
   → If the transition fired (row returned): send admin alert via sendInternalEmail
   → Otherwise (already flagged): silent — no duplicate admin spam

7. Next owner-directed worker run for that business:
   → NotificationWorker / WeeklySummaryWorker / MonthlyImpactWorker /
     OnboardingDripWorker / EngagementAlertWorker.handleOwnerNudge all
     SELECT owner_email_bounced and skip-if-bounced
   → EngagementMonitorPoller also excludes bounced businesses from owner_nudge
   → Admin + partner alerts continue — they're not sent to the owner

8. Admin sees the red "Clear bounce flag" banner on /admin/businesses/<id>
   → Verifies the email address, updates it via the Business Profile editor if wrong
   → Clicks "Clear bounce flag" → PATCH { ownerEmailBounced: false }
   → Owner-directed emails resume on the next worker cycle
```

### /admin/runbook — Quick Reference

```
1. Admin has a customer-facing issue.

2. Opens /admin/runbook (5-scenario table rendered from static data).

3. Finds the matching "Customer says X" row:
   - A1: I never got the approval email
   - A2: The response doesn't sound like me
   - A3: I approved it but it's not posted on Google
   - A4: I'm getting too many emails
   - A5: My reviews aren't being picked up

4. Reads the "First check" and "Fix" columns for immediate action.

5. If more detail needed, clicks the `docs/operational-runbook.md` reference
   → Full runbook covers daily health check, debugging SQL (correlation
     trace, stuck outbox, business activity, reset stuck entry, today's cost,
     bounced businesses, manual-post backlog), incident response (worker
     crash, Redis down, Supabase down, SerpAPI quota, LLM down, cost breaker,
     Resend degraded), and weekly maintenance tasks.
```

---

## Every File In The Project

_(Additions and changes from Sprint 6 are marked with 🆕 for new files and 📝 for modified files)_

### Database (`supabase/migrations/`) — Sprint 6 additions

| File                                              | What it does                                                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 🆕 `017_sprint6_scale.sql`                        | `api_costs_daily_rollups` table, `businesses.website`, `businesses.owner_email_bounced`, `idx_nd_created_at` |
| 🆕 `018_correlation_and_dispatching_indexes.sql`  | Correlation expression index, sync_reviews in-flight index rebuilt, generate_response lookup index           |
| 🆕 `019_notification_delivery_bounce_indexes.sql` | Partial indexes on external_message_id / sent_at / (failed_at, failure_reason)                               |
| 🆕 `020_normalize_jsonb_scalar_strings.sql`       | One-time data repair — converts JSONB scalar strings back to objects across 8 columns                        |

### Worker Process (`worker/`) — Sprint 6 changes

| File                                    | What changed                                                                                                                                                                                  | Status  |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 📝 All 12 workers                       | Replaced `console.log` with `createWorkerLogger`. PII scrubbed from correlation-tagged logs. Read `correlation_id` from payload and propagate it to downstream outbox entries.                | Working |
| 📝 `jobs/ArchivalPoller.ts`             | Added api_costs DELETE-first CTE (FOR UPDATE SKIP LOCKED → aggregate from RETURNING → additive upsert). Added notification_deliveries >90d delete. 5-target logging with saturation warnings. | Working |
| 📝 `jobs/NotificationFailoverPoller.ts` | Added `recoverFailoverCorrelationId()` — preserves upstream correlation_id from prior send_notification or generate_response. Falls back to uuidv7 only as last resort.                       | Working |
| 📝 `ingress/resend.ts`                  | Defensive bounce-type extraction + normalized `classifyBounce()`. Template-gated owner flag (only flags for owner-directed templates). Transition guard prevents duplicate admin alerts.      | Working |

### Worker Tests — Sprint 6 additions

| File                                              | Tests                                                                                                                                                                                                          |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🆕 `__tests__/correlation-chain.test.ts`          | Proves correlation_id flows through sync_reviews → generate_response → send_notification chain                                                                                                                 |
| 🆕 `__tests__/webhook-dedup.test.ts`              | Resend webhook dedup via external_event_key                                                                                                                                                                    |
| 🆕 `__tests__/resend-webhook-bounce.test.ts`      | 8 tests: hard bounce flags + alerts, soft bounces don't, template-gated (admin_manual_post + partner_engagement_alert don't flag), onboarding_drip_day_7 DOES flag, transition guard prevents duplicate alerts |
| 🆕 `__tests__/bounced-skip.test.ts`               | 4 owner-directed workers skip-if-bounced                                                                                                                                                                       |
| 📝 `__tests__/NotificationFailoverPoller.test.ts` | Added 2 regression tests: correlation recovery from existing send_notification + fallback to generate_response                                                                                                 |
| 📝 `__tests__/ArchivalPoller.test.ts`             | Added api_costs rollup path tests + concurrent-archival race safety                                                                                                                                            |

### Next.js Pages — Sprint 6 additions

| File                                | What it does                                                                                                                      | Status  |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 🆕 `admin/runbook/page.tsx`         | Static quick-reference page — 5-scenario "Customer says X" table, links to markdown runbook                                       | Working |
| 📝 `admin/businesses/[id]/page.tsx` | Red "Owner email bouncing" banner + "Clear bounce flag" button + editable ownerEmail field in profile editor                      | Working |
| 📝 `admin/businesses/new/page.tsx`  | SerpAPI prefill on place selection with AbortController + live `getFieldState` dirty check. Clear button resets prefilled fields. | Working |
| 📝 `admin/overview/page.tsx`        | Email Health card (24h delivery rate + 7d bounces/hard-bounces/complaints, red state when <95% or any 7d complaint/hard)          | Working |
| 📝 `admin/costs/page.tsx`           | Added 180 and 365 day range options (exercises the rollup-backed path)                                                            | Working |

### API Routes — Sprint 6 additions

| File                                    | What it does                                                                                                                                                      | Status  |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 🆕 `admin/businesses/prefill/route.ts`  | GET: admin-only SerpAPI prefill by place_id. 10/min strict rate limit.                                                                                            | Working |
| 📝 `api/admin/costs/route.ts`           | Days cap raised to 365. Server-side UNION CTE merges detail + rollup. byDay additive merge. Boundary filter uses `<=` (not `<`) against `CURRENT_DATE - 90 days`. | Working |
| 📝 `api/admin/overview/route.ts`        | Email Health query (24h delivery + 7d bounces). Grouped CTE includes email health fields.                                                                         | Working |
| 📝 `api/admin/jobs/route.ts`            | Imports `ALL_QUEUE_NAMES` from the shared registry so the list can't drift behind worker/queues.ts                                                                | Working |
| 📝 `api/admin/businesses/[id]/route.ts` | Added `ownerEmail` + `ownerEmailBounced` to GET and PATCH allowlist                                                                                               | Working |

### Shared Business Logic — Sprint 6 additions

| File                                    | What it does                                                                                                                                                                                        |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🆕 `src/lib/shared/logger.ts`           | `createWorkerLogger(prefix, correlationId?)` — structured logs with optional correlation tag                                                                                                        |
| 🆕 `src/lib/shared/queue-names.ts`      | `QUEUE_NAMES` + `ALL_QUEUE_NAMES` constants. Pure — no BullMQ imports. Shared by worker/queues.ts AND /api/admin/jobs.                                                                              |
| 🆕 `src/lib/approval/correlation.ts`    | `recoverCorrelationId(tx, { reviewId, responseId })` — looks up upstream generate_response for approval-flow boundary                                                                               |
| 🆕 `src/lib/reviews/serpapi-prefill.ts` | `fetchBusinessDetails(placeId)` — 7-day Redis cache, cost tracking (even on failure), 2s timeout, never throws                                                                                      |
| 📝 `src/lib/db/server.ts`               | Added `jsonb<T>(value)` helper — wraps `sql.json(value)` so typed payloads satisfy Postgres.js's strict JSONValue. Used everywhere instead of `${JSON.stringify(x)}::jsonb` (which double-encodes). |
| 📝 `src/lib/db/redis-cache.ts`          | Removed `enableOfflineQueue: false` (fixes first-request race on dev boot)                                                                                                                          |
| 📝 `src/lib/notifications/email.ts`     | Added `EmailCategory` type, `getEmailHeaders()` (RFC 8058 compliant), `getEmailTags()`, 5 new templates for bounce banner + onboarding drip + satisfaction alert                                    |
| 📝 `src/lib/shared/worker-types.ts`     | `BasePayload` with `correlation_id?` — all 12 payload types extend it                                                                                                                               |
| 📝 `src/lib/shared/schemas.ts`          | `websiteUrlSchema` (http/https only). `ownerEmail` + `website` added to `UpdateBusinessSchema`.                                                                                                     |

### Shared Tests — Sprint 6 additions

| File                                                    | Tests                                                                                                                                           |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 🆕 `src/lib/shared/__tests__/email-headers.test.ts`     | 8 tests: marketing vs transactional/internal, LIST_UNSUBSCRIBE_URL precedence, mailto fallback, unsafe scheme rejection                         |
| 🆕 `src/lib/notifications/__tests__/email-send.test.ts` | 4 tests: transactional tags, internal default, marketing with HTTPS URL, marketing mailto-only (no Post header)                                 |
| 🆕 `src/lib/reviews/__tests__/serpapi-prefill.test.ts`  | 33 tests: normalization variants (type/types/category/categories), hours shapes (array/object/nested), timeout cost recording, cache validation |

### Components — Sprint 6 changes

| File                                      | What changed                                        |
| ----------------------------------------- | --------------------------------------------------- |
| 📝 `src/components/AdminNav.tsx`          | Added "Runbook" link                                |
| 📝 `src/components/PlaceAutocomplete.tsx` | onClear callback now also cancels in-flight prefill |

### Documentation — Sprint 6 additions

| File                              | What it does                                                                                                                        |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 🆕 `docs/operational-runbook.md`  | Authoritative ops reference — 5 sections: Customer-says-X, daily health check, debugging SQL, incident response, weekly maintenance |
| 🆕 `docs/smoke-test-checklist.md` | Pre-launch manual E2E checklist — 3 businesses, throughput sanity, mobile approval perf                                             |
| 🆕 `docs/email-deliverability.md` | SPF/DKIM/DMARC setup, warmup schedule, monitoring, troubleshooting table, hard bounce flow, List-Unsubscribe compliance             |

### Test Infrastructure — Sprint 6 additions

| File                  | What changed                                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 🆕 `vitest.setup.ts`  | Sets dummy SUPABASE_URL / SUPABASE_SERVICE_KEY / DATABASE_POOL_URL so unit tests that transitively import db/server can load |
| 📝 `vitest.config.ts` | Added `setupFiles: ['./vitest.setup.ts']`                                                                                    |
| 📝 ~30 test files     | Added `jsonb: (v: unknown) => v` pass-through to all db/server `vi.mock` calls                                               |

### Other — Sprint 6 changes

| File              | What changed                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 📝 `.env.example` | Added `LIST_UNSUBSCRIBE_URL` (optional) and `NEXT_PUBLIC_DOCS_BASE_URL` (optional — makes runbook filenames clickable anchors) |

---

## Communication Channels (Phases 0–3)

Design spec: `docs/adding-communication-channels.md`. This is the multi-channel approval-notification rollout that lets owners receive and action review approvals from **email + SMS + Telegram + WhatsApp** instead of email only. Every channel sits behind a shared `NotificationChannel` interface; the dispatcher in `NotificationWorker` fans out to whichever channels a business has verified.

Phases 0–3 are all **code-complete** and live in `main` (except Phase 3 which is on branch `feat/channels-whatsapp-phase-3` with its PR open). SMS, Telegram, and WhatsApp all ship flag-gated **off** at merge and flip on per-channel once their external prerequisite (10DLC registration / bot registration / Meta Business verification) is done.

### Phase 0: Refactor + infra (merged to main 2026-04-21)

**What it does:** Rewires the single-channel email notification path into a channel-agnostic dispatcher, so each new channel is a drop-in rather than a rewrite. Existing email customers see identical behavior.

**What we built:**

- Migration 021 (`channel_enrollments`) — one row per (business, channel). Tracks `status` (`pending_verification | verified | disabled | unsubscribed`), `handle` (email / phone / chat_id), optional `verification_token_hash` for enrollment flows. Every existing business gets an auto-verified email row via a one-off backfill.
- `NotificationChannel` interface + `SendApprovalParams` type — pluggable transport contract. First-class peer with the existing `ReviewSource` pattern.
- `EmailChannel` — wraps the existing `sendApprovalEmail` from `src/lib/notifications/email.ts`. Zero behavior change to email customers.
- `getChannel(id)` factory + `getVerifiedEnrollments(businessId)` query helper.
- `createApprovalLink` became channel-scoped — accepts a `channel` param, advisory-locked, revokes only same-channel siblings.
- `NotificationWorker` rewritten as a **dispatcher**: loops over verified enrollments, sends per channel, continues on single-channel failures instead of failing the whole job.
- `NotificationFailoverPoller` stale branch now emails admin rather than re-dispatching (the old "re-send on primary" path was tied to single-channel thinking).
- Admin UI gained a "Channels" section on `/admin/businesses/[id]` listing enrollments with masked handles and status badges.
- Legacy `businesses.notification_preference` column dropped in migration 022.

### Phase 1: SMS (merged to main 2026-04-22, flag-gated off pending 10DLC)

**What it does:** Owners who opted into SMS during onboarding get a short text per review: "New ⭐3 review from Jane. Draft ready: [link]". They tap through, approve on the web (no inline buttons on SMS — carriers strip them). Replying `STOP` unsubscribes per US TCPA. Re-enrollment requires a fresh verification.

**What we built:**

- Migration 022 — adds soft-delete (`archived_at`) + partial unique index to `channel_enrollments`, plus `sms_sender_opt_outs` / `sms_sender_opt_out_events` tables for sender-wide opt-out fan-out (Twilio error 21610).
- `SmsChannel` + Twilio Programmable SMS via Messaging Service SID.
- `sms-body.ts` — GSM-7 single-segment formatter with two-tier length fallback (drops the review snippet first, then the reviewer name).
- `sms-tracker.ts` — per-business + global daily cents ceiling in Redis (`SMS_DAILY_LIMIT_CENTS_PER_BUSINESS` / `_GLOBAL`).
- `worker/ingress/twilio.ts` — Twilio signature verify, delivery status callback (terminal-precedence + race-safe retry), inbound STOP/START with EN+ES keyword set, TCPA opt-out audit log.
- 6 admin API routes under `src/app/api/admin/channels/sms/` (`verify`/`confirm`/`cancel`/`disable`/`delete`/`status`) — advisory-lock-serialized, Twilio-first ordering, env-readiness 503.
- `SmsEnrollmentWidget` — 7-state client UI, server-authoritative flag, green check on verify.
- Worker startup assertion `assertChannelsSmsEnv` — fail-fast if flag on but envs missing.
- **Ship gate pending:** 10DLC brand/campaign registration (external paperwork). Real-phone manual walkthrough not yet run. Flag stays off in prod.

### Phase 2: Telegram (PR to main opened 2026-04-23, ship gate PASSED in local dev against `@RepWorthBot`)

**What it does:** Owners enrolled via Telegram get a rich-formatted message per review with **inline Approve / Regenerate buttons** and a URL "Edit" button. One tap approves — no web round-trip. Faster than any other channel for mobile-first owners. Scope narrowed to **admin-onboarding only** (owner dashboard is Phase 4).

**What we built:**

- Zero migrations — migration 021 already accommodates `channel='telegram'`.
- `TelegramChannel` + `TelegramClient` — native `fetch` wrapper (no SDK), 10s AbortController timeout, 4 typed error classes (`Blocked`/`ChatNotFound`/`RateLimit`/`Api`).
- `formatApprovalTelegram` — pure HTML-escaped body + 2-row inline keyboard (Approve / Regenerate as `callback_data`, Edit as URL button).
- `worker/ingress/telegram.ts` — `/start <token>` enrollment flow (SHA-256 hash lookup, atomic enrollment tx, rejects group/channel chats) + `callback_query` handler with **Model A ack ordering** (ack after cheap validation but before approval tx — keeps inside Telegram's 15s budget while keeping the approval atomic).
- Permanent link-state errors (`ConsumedLinkError`/`RevokedLinkError`/`ExpiredLinkError`/`ChannelMismatchError`/`ResponseNotPendingError`) route to `editMessageText` in place — replaces the stale draft and drops the buttons so repeated taps can't re-fire. Unexpected errors get a text-only fallback with no raw token embed.
- `worker/ingress/telegram-verify.ts` — constant-time compare against `TELEGRAM_WEBHOOK_SECRET`.
- `worker/ingress/shared.ts` — extracted `claimInboundEvent(source, dedupKey, eventType, payload)` (originated in Twilio, now shared across Twilio/Telegram/WhatsApp).
- `approveViaCallback` / `regenerateViaCallback` on `ApprovalService` — bypass device-cookie binding because authorization is provider-signature + sender-handle-bound in ingress. Audit row stores SHA-256 `chat_handle_hash` + `update_id` in the `metadata` JSONB (no schema change).
- 3 admin API routes under `src/app/api/admin/channels/telegram/` (`start`/`cancel`/`disable`), server-rendered QR data URL via the `qrcode` dep so the raw one-time token never leaves the server except to the admin browser that initiated the flow.
- `TelegramEnrollmentWidget` — 8-state client UI, 3s polling during `awaiting_scan`, 1h TTL countdown, distinguishes 401/403 from 5xx.
- `NotificationWorker` flag-skip + typed-error branches: `TelegramRecipientBlocked` → `unsubscribed`/`telegram_blocked`, `TelegramChatNotFound` → `disabled`. Both handle-scoped so stale send errors can't stomp a re-enrolled handle.
- PII-stripped payload redaction before `inbound_events.payload` persist (strips `from.first_name`/`last_name`/`username`, replaces `callback_query.data` with `[redacted]`).
- **Ship gate passed** against a real `@RepWorthBot` on the Hey Tea test business via ngrok: enrollment, approve round-trip (button → "✅ approved" edit → response flipped), regenerate round-trip (button → "🔄 Regenerating…" edit → new draft arrives), blocked-bot handling, re-enroll after unblock, cross-channel race vs email. Flag stays off in prod pending prod bot registration + prod `setWebhook` + one-business pilot walkthrough.

### Phase 3: WhatsApp (code-complete 2026-04-23 on `feat/channels-whatsapp-phase-3`; flag-gated off pending Meta verification + WABA + template approval)

**What it does:** Owners enrolled via WhatsApp get a Twilio-rendered Content template with the same **Approve / Regenerate / Edit** buttons as Telegram. Enrollment uses a `wa.me` click-to-chat deep link — owner taps, WhatsApp opens with `start-<token>` pre-filled, they send it. Faster than SMS and more familiar internationally than Telegram. Same admin-onboarding scope as Phase 2; owner dashboard deferred to Phase 4.

**What we built:**

- Zero migrations — migration 021 + 022 already accommodate `channel='whatsapp'`.
- **Preparatory refactor** — widened `CallbackAuditContext` from Telegram-shaped `{updateId}` to a provider-agnostic discriminated union that enforces "never both" at compile time. Telegram audit rows keep writing `metadata.update_id` (historical query compatibility), WhatsApp rows write `metadata.message_sid`; both get cross-channel `metadata.provider_event_id`.
- **Second refactor** — extracted `classifyIntent` + `STOP_KEYWORDS` / `START_KEYWORDS` from `worker/ingress/twilio.ts` to shared `worker/ingress/twilio-intent.ts` so SMS and WA ingress both use it.
- `WhatsAppChannel` + `WhatsAppClient` — Twilio SDK wrapper with explicit `{timeout: 10_000, autoRetry: false}`, 7 typed error classes split by cause (owner-intent vs config-error vs transient). `classifyError` dispatches by Twilio error code set membership.
- `whatsapp-body.ts` — produces 9 Content variables for the Meta-approved `repworth_approval_request_v1` template. `extractTokenFromApprovalUrl` enforces strict `/approve/<token>` shape (rejects query strings, fragments, trailing slashes).
- `worker/ingress/twilio-whatsapp.ts` (sibling to `twilio.ts`, zero touch to SMS logic):
  - Status callback mirrors SMS pattern with `channel='whatsapp'` discriminator.
  - Inbound handler dispatches on payload shape: **ButtonPayload** → approve/regenerate via `approveViaCallback` + `twilioMessageSid` audit; **STOP** → single-statement UPDATE (handle-scoped + `archived_at IS NULL`); **`start-<token>`** → sha256 hash lookup + enrollment tx; else → log + markProcessed.
  - **UUID regex** on `ButtonPayload` BEFORE the DB SELECT — prevents Postgres "invalid input syntax for type uuid" from escaping.
  - **Post-claim try/catch safety net** — any DB throw between `claimInboundEvent` and markProcessed/markFailed lands in `markFailed('post_claim_unexpected:...')` instead of leaving a stuck `received` row that future Twilio retries would silent-200.
  - Payload redaction strips `Body`, `ButtonPayload`, `ProfileName`, `WaId` before `inbound_events` persist.
- 3 admin API routes under `src/app/api/admin/channels/whatsapp/` (`start`/`cancel`/`disable`), same flag → env → auth gate as Telegram. `/start` builds a digit-only `wa.me` deep link (`TWILIO_WHATSAPP_NUMBER.replace(/^whatsapp:\+?/, '')`).
- `WhatsAppEnrollmentWidget` — 8-state client UI with masked phone display (first-3 + `•`-padded middle + last-4), 3s polling, 1h TTL countdown, onCancel force-resets locally so the QR vanishes immediately.
- **`NotificationWorker` dispatcher split — CRITICAL:**
  - Owner-intent errors (`RecipientBlocked`/`InvalidRecipient`) flip enrollment to `unsubscribed`/`disabled` with handle-scoped + `archived_at IS NULL` guard.
  - **Config-error errors (`TemplateConfigError`, `SessionWindowError`) leave enrollment `verified` UNCHANGED** — a paused/broken template is a RepWorth ops failure, not owner intent. Flipping to unsubscribed would falsely suppress future notifications + mislead the admin widget. An explicit integration test asserts zero `channel_enrollments` UPDATE calls on `WhatsAppTemplateConfigError` — the single most important regression guard in Phase 3.
  - Transient errors (`RateLimit`/`Timeout`) record a `failed_delivery` row and let BullMQ queue-level backoff retry.
- Startup assertion `assertChannelsWhatsAppEnv` is **self-contained** — verifies 7 env vars + `TWILIO_WHATSAPP_NUMBER` format + `WHATSAPP_APPROVAL_URL_BASE === NEXT_PUBLIC_APP_URL + '/approve/'` equality check (prevents staging/local URLs shipping into a Meta-approved template).
- **Raw-token locality invariant maintained** — raw approval token exists only in `contentVariables['9']` for the URL button (same semantic boundary as email), never in `ButtonPayload`, never in `inbound_events.payload`, never in logs. Anti-regression test asserts no console.log/error/warn call arg contains the raw-token fixture across every error path.
- Template contract documented in `docs/whatsapp-templates.md`: `twilio/card` Content type, 9 body variables, 2 quick-reply buttons + 1 URL button, UTILITY category.
- **Ship gate** (8-item, not yet run): webhook registration, click-to-chat enrollment, approve round-trip, regenerate round-trip, blocked-recipient handling, re-enrollment after unblock, cross-channel race vs email, STOP inside session. Flag stays off until all 8 pass.
- **External prerequisites (nothing started at merge):** Meta Business verification (2–4 week external clock), WABA creation, Twilio WA sender provisioning, `repworth_approval_request_v1` Content template submission + Meta approval, populate 4 env vars in Railway + Vercel.

---

## Every File In The Project — Channels additions

All Channels work sits under dedicated folders so it doesn't leak into Sprint 1–6 code paths. The top-level shape of the new areas:

```
src/
├── app/api/admin/channels/        # NEW — admin enrollment routes, one subfolder per channel
│   ├── sms/        (6 routes + _shared + __tests__)
│   ├── telegram/   (3 routes + _shared + __tests__)
│   └── whatsapp/   (3 routes + _shared + __tests__)
├── components/admin/              # NEW folder
│   ├── ChannelsSection.tsx
│   ├── SmsEnrollmentWidget.tsx
│   ├── TelegramEnrollmentWidget.tsx
│   └── WhatsAppEnrollmentWidget.tsx
└── lib/notifications/channels/    # NEW — the pluggable-transport layer
    ├── types.ts                   # NotificationChannel interface + ChannelId type
    ├── index.ts                   # getChannel factory
    ├── email-channel.ts
    ├── sms-channel.ts
    ├── telegram-channel.ts
    ├── telegram-client.ts
    ├── telegram-body.ts
    ├── whatsapp-channel.ts
    ├── whatsapp-client.ts
    ├── whatsapp-body.ts
    └── __tests__/  (9 test files)

worker/ingress/                    # Existing folder, several files added
├── shared.ts                      # NEW — claimInboundEvent extracted from twilio.ts
├── telegram.ts                    # NEW
├── telegram-verify.ts             # NEW — X-Telegram-Bot-Api-Secret-Token compare
├── twilio.ts                      # Phase 1 additions — status callback + STOP/START
├── twilio-intent.ts               # NEW — extracted STOP/START keyword classifier
├── twilio-verify.ts               # NEW
├── twilio-whatsapp.ts             # NEW — sibling to twilio.ts for WA payloads
└── __tests__/  (7 test files for this domain)

supabase/migrations/
├── 021_channel_enrollments.sql    # Phase 0
└── 022_sms_channel_infra.sql      # Phase 1
                                   # (Phases 2 + 3 ship zero migrations)
```

### Database migrations — Channels

| File                                   | What it does                                                                                                                                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 🆕 `021_channel_enrollments.sql`       | New `channel_enrollments` table + 2 indexes. Backfills every existing business with a verified email row. Deprecates `businesses.notification_preference`.                                             |
| 🆕 `022_sms_channel_infra.sql`         | Drops `businesses.notification_preference`. Adds `channel_enrollments.archived_at` soft-delete + partial unique index on `(business_id, channel) WHERE archived_at IS NULL`. New `sms_sender_opt_outs` + `sms_sender_opt_out_events` tables with RLS + CHECK constraints. Handle lookup index. |

### Worker ingress — Channels additions

| File                            | What it does                                                                                                                                                                             | Status  |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 🆕 `worker/ingress/shared.ts`           | `claimInboundEvent(source, dedupKey, eventType, payload)` — atomic dedup + reclaim of failed/stale rows. Shared by Twilio (SMS + WA) and Telegram.                                       | Working |
| 🆕 `worker/ingress/twilio.ts`           | Twilio signature verify, status callback (SMS delivery), inbound STOP/START (EN+ES), sender-wide opt-out fan-out via `sms_sender_opt_outs`. Phase 1.                                     | Working |
| 🆕 `worker/ingress/twilio-intent.ts`    | Pure keyword classifier — `classifyIntent` + `STOP_KEYWORDS` / `START_KEYWORDS`. Extracted so SMS + WA share it.                                                                         | Working |
| 🆕 `worker/ingress/twilio-verify.ts`    | Twilio X-Twilio-Signature HMAC verify. Shared by SMS + WA.                                                                                                                               | Working |
| 🆕 `worker/ingress/twilio-whatsapp.ts`  | WA status callback + inbound dispatcher (ButtonPayload / STOP / `start-<token>` / else). UUID regex on button payloads, post-claim try/catch safety net, payload redaction.              | Working |
| 🆕 `worker/ingress/telegram.ts`         | `/start <token>` enrollment + `callback_query` handler with Model A ack ordering. Typed link-state errors edit the message in place; unexpected errors get text-only fallback.           | Working |
| 🆕 `worker/ingress/telegram-verify.ts`  | Constant-time compare of `X-Telegram-Bot-Api-Secret-Token` against `TELEGRAM_WEBHOOK_SECRET`.                                                                                            | Working |

### Notification channels layer — `src/lib/notifications/channels/`

| File                    | What it does                                                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 🆕 `types.ts`           | `NotificationChannel` interface, `SendApprovalParams`, `ChannelId` union. The contract every channel implements.                                                                     |
| 🆕 `index.ts`           | `getChannel(id)` factory — returns the right implementation and throws a typed error if the channel's feature flag is off.                                                           |
| 🆕 `email-channel.ts`   | Wraps existing `sendApprovalEmail`. Zero behavior change for existing customers.                                                                                                     |
| 🆕 `sms-channel.ts`     | Twilio Programmable SMS send via Messaging Service SID. Uses `sms-body` formatter + `sms-tracker` cost guard.                                                                        |
| 🆕 `telegram-channel.ts`| `sendApprovalRequest` → `TelegramClient.sendMessage` with inline keyboard. Maps provider errors to typed `TelegramRecipientBlockedError` / `TelegramChatNotFoundError` / etc.         |
| 🆕 `telegram-client.ts` | Raw Bot API wrapper — native `fetch`, 10s AbortController timeout, 4 typed error classes.                                                                                            |
| 🆕 `telegram-body.ts`   | `formatApprovalTelegram` — pure HTML-escape + 2-row inline keyboard builder. No side effects.                                                                                        |
| 🆕 `whatsapp-channel.ts`| `sendApprovalRequest` → `WhatsAppClient.sendTemplate` with 9 content variables + dispatcher-visible typed errors.                                                                    |
| 🆕 `whatsapp-client.ts` | Twilio SDK wrapper with explicit `{timeout, autoRetry: false}`, 7 typed error classes, `classifyError` dispatch by Twilio error code set membership.                                 |
| 🆕 `whatsapp-body.ts`   | `formatApprovalWhatsApp` produces the 9 Content variables. `extractTokenFromApprovalUrl` enforces strict `/approve/<token>` shape.                                                   |

### SMS-specific support files

| File                                    | What it does                                                                                                                       |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 🆕 `src/lib/notifications/sms-body.ts`  | GSM-7 single-segment formatter, two-tier length fallback (drops snippet first, then reviewer name), `SmsBodyTooLongError`.         |
| 🆕 `src/lib/costs/sms-tracker.ts`       | Per-business + global daily cents ceiling in Redis (`SMS_DAILY_LIMIT_CENTS_PER_BUSINESS` / `_GLOBAL`). INCR + try/finally refund.  |

### Admin API routes — `src/app/api/admin/channels/`

| Route                                              | What it does                                                                                                                                             |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🆕 `sms/verify/route.ts`                           | POST: start Twilio Verify flow for a given business + phone. Inserts `pending_verification` row.                                                         |
| 🆕 `sms/confirm/route.ts`                          | POST: accept 6-digit code, validates via Twilio, flips to `verified`.                                                                                    |
| 🆕 `sms/cancel/route.ts`                           | POST: cancel an in-flight verification (before confirm).                                                                                                 |
| 🆕 `sms/disable/route.ts`                          | POST: flip an enrollment to `disabled`.                                                                                                                  |
| 🆕 `sms/delete/route.ts`                           | POST: soft-delete (`archived_at=NOW()`) so the business can re-enroll with a different number.                                                           |
| 🆕 `sms/status/route.ts`                           | GET: current enrollment status for admin widget polling.                                                                                                 |
| 🆕 `telegram/start/route.ts`                       | POST: generate a fresh 1h-TTL verification token, return the raw token once (for QR + deep link), persist only the SHA-256 hash.                         |
| 🆕 `telegram/cancel/route.ts`                      | POST: cancel a `pending_verification` row before the owner taps the deep link.                                                                           |
| 🆕 `telegram/disable/route.ts`                     | POST: flip a verified Telegram enrollment to `disabled`.                                                                                                 |
| 🆕 `whatsapp/start/route.ts`                       | POST: same pattern as Telegram `start` — generates token, returns `wa.me` click-to-chat deep link + QR data URL.                                         |
| 🆕 `whatsapp/cancel/route.ts`                      | POST: cancel an in-flight WhatsApp enrollment.                                                                                                           |
| 🆕 `whatsapp/disable/route.ts`                     | POST: flip a verified WhatsApp enrollment to `disabled`.                                                                                                 |

Each channel folder also contains:
- `_shared.ts` — common auth/flag/env guards + advisory-lock helpers.
- `__tests__/` — route-level integration tests.

### Components — Channels additions

| File                                                | What it does                                                                                                                                             |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🆕 `src/components/admin/ChannelsSection.tsx`       | Server component rendered on `/admin/businesses/[id]`. Lists every enrollment (masked handle + status badge) + mounts the per-channel enrollment widget. |
| 🆕 `src/components/admin/SmsEnrollmentWidget.tsx`   | 7-state client UI: idle → entering_phone → awaiting_code → verified / failure / disabled / unsubscribed.                                                  |
| 🆕 `src/components/admin/TelegramEnrollmentWidget.tsx` | 8-state client UI with 3s polling during `awaiting_scan`, 1h TTL countdown, QR + deep link display.                                                    |
| 🆕 `src/components/admin/WhatsAppEnrollmentWidget.tsx` | 8-state client UI mirroring Telegram, with masked-phone display and Cancel that locally resets before refresh.                                         |

### Approval service — Channels additions

| File                              | What changed                                                                                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 📝 `src/lib/approval/service.ts`  | New `approveViaCallback` / `regenerateViaCallback` — bypass the device-cookie requirement because authorization is provider-signature + sender-handle-bound in ingress. Typed link-state errors (`ConsumedLinkError`, `RevokedLinkError`, `ExpiredLinkError`, `ChannelMismatchError`). Audit row writes `via_channel`, SHA-256 `chat_handle_hash`, and provider event id to `metadata` JSONB (no schema change). |
| 📝 `src/lib/approval/create-link.ts` | Channel-scoped revoke — only revokes siblings in the same channel, not across channels.                                                                                                    |

### Feature flags + new env vars

Every channel is **off by default**. Each flag is server-authoritative — the admin page reads it through the business detail API, never from a `NEXT_PUBLIC_*` companion.

| Env var                             | Purpose                                                                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `CHANNELS_SMS_ENABLED`              | Gates factory, dispatcher, admin routes, widget. Default `false`.                                                           |
| `CHANNELS_TELEGRAM_ENABLED`         | Same, for Telegram. Default `false`.                                                                                        |
| `CHANNELS_WHATSAPP_ENABLED`         | Same, for WhatsApp. Default `false`.                                                                                        |
| `WORKER_PUBLIC_URL`                 | Required when SMS on. Used as Twilio statusCallback base + signature-verified path.                                         |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_MESSAGING_SERVICE_SID` / `TWILIO_VERIFY_SERVICE_SID` | Required when SMS on. Asserted at worker startup. |
| `SMS_DAILY_LIMIT_CENTS_PER_BUSINESS` (default 10) / `SMS_DAILY_LIMIT_CENTS_GLOBAL` (default 500) | SMS cost guard ceilings.                                      |
| `TELEGRAM_BOT_TOKEN`                | BotFather token for `@RepWorthBot`. Required when Telegram on.                                                              |
| `TELEGRAM_WEBHOOK_SECRET`           | 32+ byte shared secret — must match value passed to Telegram `setWebhook`. Ingress rejects 401 on mismatch.                 |
| `TELEGRAM_BOT_USERNAME`             | Optional — default `RepWorthBot`. Controls deep-link rendering.                                                             |
| `TWILIO_WHATSAPP_NUMBER`            | WA sender. Format: `whatsapp:+<digits>`. Required when WA on.                                                               |
| `WHATSAPP_APPROVAL_TEMPLATE_SID`    | Twilio Content SID for `repworth_approval_request_v1`. Required when WA on.                                                 |
| `WHATSAPP_APPROVAL_URL_BASE`        | Must equal `NEXT_PUBLIC_APP_URL + '/approve/'` — boot assertion enforces.                                                   |

---

## Owner Self-Serve Signup (2026-04-25, branch `feat/owner-self-serve-signup`)

**What it does:** Owners can now sign up, pay, and onboard themselves without an admin doing it manually. Before this branch, every signup needed an admin to type the customer's details into `/admin/businesses/new`. Now owners click "Sign Up" on the landing page and walk themselves through the whole flow.

**The flow in plain English:**

1. Owner clicks **Sign Up** on the landing page → `/signup` page asks for name + email + password (or "Continue with Google")
2. They submit → we create a Supabase Auth user + a placeholder business row + email them a 6-digit code
3. They land on `/signup/check-email` → type the 6-digit code → email is verified
4. We send them to `/onboarding/pay` → 2-card plan picker (Founding $99 / Standard $149)
5. They click a plan → we save the choice + redirect to Stripe's hosted checkout
6. They pay on Stripe → Stripe sends them back to `/onboarding/payment-success`
7. That page polls until our webhook flips the subscription to `active` (usually 2–5 seconds)
8. We push them into `/onboarding/business` → 3-step wizard (Location with Google Place autocomplete → Profile prefilled from SerpAPI review patterns → Voice tone, all skippable)
9. They submit the wizard → we enqueue the initial review sync → land them on `/dashboard`

**Google sign-in alternative:** Step 1 they click "Continue with Google" instead. Google handles auth + email confirmation, we ask for name + phone on `/signup/finish`, then everything from step 4 onwards is identical.

**Safety net for abandoned signups:** If someone signs up but never pays, a worker job called `CleanupAbandonedSignupsPoller` deletes their auth user + DB rows after 7 days. So "tire-kickers" don't pile up forever.

### Files added/changed

```
src/
├── app/
│   ├── (public)/
│   │   ├── signup/
│   │   │   ├── page.tsx                  ← /signup landing page (NEW)
│   │   │   ├── SignupFormClient.tsx      ← name+email+password form (NEW)
│   │   │   ├── check-email/
│   │   │   │   ├── page.tsx              ← OTP entry page (NEW)
│   │   │   │   └── CheckEmailClient.tsx  ← 6-digit code input + resend link (NEW)
│   │   │   └── finish/
│   │   │       ├── page.tsx              ← Google-signup name+phone (NEW)
│   │   │       └── FinishSignupClient.tsx (NEW)
│   │   ├── login/page.tsx                ← /login owner login (NEW)
│   │   ├── forgot-password/page.tsx      ← /forgot-password owner (NEW)
│   │   └── reset-password/page.tsx       ← /reset-password owner (NEW)
│   ├── admin/
│   │   ├── login/page.tsx                ← /admin/login (NEW — never flag-gated)
│   │   ├── forgot-password/page.tsx      ← /admin/forgot-password (NEW)
│   │   └── reset-password/page.tsx       ← /admin/reset-password (NEW)
│   ├── onboarding/
│   │   ├── pay/
│   │   │   ├── page.tsx                  ← plan picker page (NEW)
│   │   │   └── PlanPickerClient.tsx      ← 2-card plan picker UI (NEW)
│   │   ├── payment-success/
│   │   │   ├── page.tsx                  ← polls for active subscription (NEW)
│   │   │   └── PaymentSuccessClient.tsx  (NEW)
│   │   └── business/
│   │       ├── page.tsx                  ← 3-step wizard host (NEW)
│   │       ├── BusinessWizardClient.tsx  ← orchestrator (NEW)
│   │       ├── ProgressDots.tsx          ← step indicator (NEW)
│   │       ├── StepLocation.tsx          ← Step 1: PlaceAutocomplete (NEW)
│   │       ├── StepProfile.tsx           ← Step 2: prefilled profile (NEW)
│   │       ├── StepVoice.tsx             ← Step 3: tone + samples, skippable (NEW)
│   │       └── guard.ts                  ← pure resolveWizardDestination() (NEW, B13)
│   ├── api/
│   │   ├── auth/
│   │   │   ├── signup/route.ts           ← POST /api/auth/signup (NEW)
│   │   │   ├── finish-signup/route.ts    ← POST /api/auth/finish-signup (NEW)
│   │   │   ├── signup-status/route.ts    ← GET /api/auth/signup-status (NEW)
│   │   │   ├── verify-otp/route.ts       ← POST /api/auth/verify-otp (NEW)
│   │   │   ├── resend-confirmation/route.ts (NEW)
│   │   │   ├── forgot-password/route.ts  (NEW)
│   │   │   ├── reset-password/route.ts   (NEW)
│   │   │   └── callback/route.ts         ← extended w/ token_hash + flow= (MOD)
│   │   └── onboarding/
│   │       ├── business/route.ts         ← POST /api/onboarding/business (NEW)
│   │       └── select-plan/route.ts      ← POST /api/onboarding/select-plan (NEW, B8)
│   └── (authenticated)/dashboard/page.tsx ← pending-payment banner (MOD)
├── components/
│   └── auth/
│       ├── LoginFormClient.tsx           ← shared owner+admin login form (NEW)
│       ├── ForgotPasswordFormClient.tsx  (NEW)
│       └── ResetPasswordFormClient.tsx   (NEW)
├── lib/
│   ├── shared/
│   │   ├── auth-flow.ts                  ← AuthFlow type + loginUrlForFlow (NEW)
│   │   ├── csrf.ts                       ← assertSameOrigin (NEW)
│   │   ├── request-ip.ts                 ← getIpKey helper (NEW)
│   │   ├── auth-responses.ts             ← shared accountExistsResponse() (NEW)
│   │   └── schemas.ts                    ← +SignupSchema +FinishSignupSchema +VerifyEmailOtpSchema +SelectPlanSchema +ResendConfirmationSchema +ResetPasswordSchema +ForgotPasswordSchema (MOD)
│   ├── payments/payment-link.ts          ← buildPaymentLinkUrl (NEW)
│   └── onboarding/create-business.ts     ← extracted createBusinessTx admin/self_serve modes (NEW)
└── middleware.ts                         ← +/onboarding gating, +flow-aware redirects (MOD)

worker/
├── jobs/
│   └── CleanupAbandonedSignupsPoller.ts  ← 24h sweep of abandoned signups (NEW)
├── ingress/
│   ├── stripe.ts                         ← simplified to status-flip only (MOD)
│   └── __tests__/stripe.test.ts          ← noise-event no-op assertions (NEW, B12)
├── startup-assert.ts                     ← assertSelfServeSignupEnv (MOD)
└── index.ts                              ← register CleanupAbandonedSignupsPoller (MOD)

supabase/migrations/
└── 025_signup_schema.sql                 ← partial indexes + email lowercase backfill + onboarded_by backfill (NEW)

scripts/
└── clear-signup-rate-limits.ts           ← dev helper to flush Redis rate-limit keys (NEW, B9)

docs/
├── signup-test-runbook.md                ← 12 scenarios A–L (NEW)
└── progresstracking.md                   ← detailed implementation log (MOD)
```

### Bugs we hit + fixed (the interesting ones)

- **B5/B6 — Email confirmation links go to homepage instead of our callback.** Server-side `supabase.auth.signUp()` defaults to implicit flow (no PKCE — there's no browser to stash a code_verifier), so the email link arrives with `#access_token=...` instead of `?code=...`. Fix: switched to typed 6-digit OTP entry instead of clickable links — sidesteps both this AND email-scanner-prefetch (Outlook Safe Links / Gmail link checker eats single-use confirmation links before the human clicks).

- **B9 — "Account already exists" appearing for a brand-new email.** Supabase's built-in SMTP has a **2-emails-per-hour-per-address** cap. When you trip it, signUp() returns a 429 error which we were misclassifying as "account exists". Fix: route disambiguates the rate-limit error code and returns a clear "wait a few minutes" message. **Real fix is custom SMTP via Resend** (Supabase Dashboard → Authentication → SMTP Settings → host `smtp.resend.com:465`, username `resend`, password = `RESEND_API_KEY`). Once Custom SMTP is on, Supabase's built-in cap is bypassed.

- **B10 — Google signups got NO approval emails for any of their reviews.** The first Google-signed-up business had 8 reviews ingested + 8 responses generated, but `NotificationWorker` found 0 verified channels and silently dropped every dispatch. Cause: I'd moved the `channel_enrollments` INSERT from `createBusinessTx` into `/api/auth/verify-otp` (correct for OTP flow) but forgot Google users skip OTP — they go through `/api/auth/finish-signup` which had no equivalent INSERT. Fix: added the same INSERT to finish-signup. Backfilled the affected business + re-enqueued the 8 missed approval emails.

- **B11 — Admin-onboarded owners couldn't log in.** `createBusinessTx` admin mode wrote `users.auth_id=NULL` and didn't create a Supabase Auth user. Owner couldn't log in, couldn't reset password (Supabase silently no-ops on missing auth.users row), couldn't even sign up (our pre-check returns 409 on email collision). Fix: admin route now calls `supabaseServer.auth.admin.inviteUserByEmail()` after createBusinessTx, patches the resulting auth_id onto the users row. Owner gets an invite email → clicks → sets a password → logs in.

### Required Supabase config before flag flip in prod

1. **Enable custom SMTP** in Supabase Auth settings (host `smtp.resend.com`, port `465`, user `resend`, password `RESEND_API_KEY`). This is the bypass for the 2/hour limit.
2. **Update 3 email templates:**
   - **Confirm signup**: body uses `{{ .Token }}` (the 6-digit code), NOT `{{ .ConfirmationURL }}`
   - **Reset password**: link uses `{{ .SiteURL }}/api/auth/callback?token_hash={{ .TokenHash }}&amp;type=recovery&amp;flow=owner&amp;next=/reset-password` with `&amp;` escapes (unescaped `&` silently breaks the `<a href>` parser in some clients)
   - **Invite user**: same shape as Reset password but `type=invite`
3. **Run migration 025** in Supabase SQL editor (preconditions check email collisions + admin presence — fails fast if either is wrong).
4. **Env vars** in Vercel + Railway: `SELF_SERVE_SIGNUP_ENABLED=true`, `STRIPE_PAYMENT_LINK_FOUNDING`, `STRIPE_PAYMENT_LINK_STANDARD`, `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`.
5. **Stripe Payment Links** point success_url at `https://yourdomain.com/onboarding/payment-success?session_id={CHECKOUT_SESSION_ID}` and cancel_url at `https://yourdomain.com/onboarding/pay?cancelled=1`.
6. **Run all 12 runbook scenarios** (A–L in `docs/signup-test-runbook.md`) on staging.
7. Flip `SELF_SERVE_SIGNUP_ENABLED=true`, redeploy. Landing nav's Login + Sign Up links appear automatically.

Until those are done, every new route returns 404 and the landing nav doesn't show them.

---

## Self-Serve Signup Hardening (2026-04-26, B15–B20 — same `feat/owner-self-serve-signup` branch)

After the initial branch was code-complete, **5 rounds of external code review** found 21 issues. All fixed. Test count went from 1405 → 1433 (28 new tests + assertion strengthening on existing ones).

The headline issue was a **"could-have-deleted-a-paid-customer" bug** in the cleanup poller — a race window where Stripe activated a customer between the poller's candidate-select and the actual delete. We now re-validate every condition inside the transaction under FOR UPDATE so an in-flight Stripe webhook commits before we proceed. This was the most consequential fix; the other 20 are correctness + UX polish layered on top.

**What changed in plain English:**

1. **Cleanup poller is now race-safe.** Re-checks subscription status, stripe_customer_id, onboarded_by, role, auth_id, AND age inside the transaction with row-level locks. If any predicate has changed since the candidate was selected (e.g., they paid mid-cycle), we skip with a `skipped_state_changed` log instead of deleting.

2. **Plan-picker race fixed.** Took the activation lock BEFORE reading subscription status (instead of after), so a Stripe webhook racing the user clicking "Founding $99" can't result in the route handing out a payment URL for an already-active business.

3. **Server-side `signUp()` no longer creates ghost users.** Supabase returns a fake user object with empty `identities[]` for already-registered emails (anti-enumeration). We now detect this and return `account_exists` instead of writing a `users.auth_id` pointing at no real Supabase identity.

4. **Admin-onboarding route is now atomic.** APP_URL is validated BEFORE any DB writes; the `auth_id` link UPDATE uses `RETURNING id` and hard-fails (not soft-warns) if 0 rows match; rollback wraps job_outbox + users + businesses deletes in a single tx with FK-aware ordering. The previous soft-success path silently shipped admin-created businesses with broken auth.

5. **Auth-callback signOut now actually clears cookies.** The two `account_incomplete` branches were calling `signOut()` but the redirect they returned didn't copy the cleared cookies — browser kept the bad session and middleware-redirect-looped. Both branches now copy `response.cookies.getAll()` onto the redirect (matches the success path).

6. **Google Maps URL validation matches the worker's actual contract.** Before: any non-empty string passed; we'd write `google_maps_url` and the wizard guard treats the business as onboarded → owner sat on /dashboard with no Place ID because the worker silently failed validation. Now: schema validates host shape (Google Maps domains only) AND calls `parseGoogleMapsUrl()` to confirm the URL yields either a valid Place ID OR (businessName + coordinates) — the exact input contract the PlaceIdValidationWorker requires.

7. **New durable-retry poller for email channel enrollments.** `EmailChannelReconcilePoller` runs every 10 minutes, finds active-subscription owner businesses with no `channel_enrollments` email row at all (including archived ones — won't recreate intentionally-archived rows), and inserts the missing row idempotently. Catches the rare verify-otp / finish-signup INSERT failures that the inline try/catch swallows.

8. **Pay page redirect matches the documented flow.** Active+not-onboarded owners now go to `/onboarding/business` (the wizard) instead of `/dashboard` — same as `PaymentSuccessClient` already does.

9. **`/api/onboarding/*` enforces owner role at SQL.** Middleware doesn't gate `/api/*` routes — was relying on auth_id → business_id alone. An admin/sales_partner with a misconfigured users.business_id could submit owner-only endpoints. SQL filters now have `AND u.role = 'owner'`.

10. **Schema XOR alignment.** Both onboarding schemas (admin + owner) now require exactly one of `googlePlaceId` or `googleMapsUrl`, not both — was diverging silently downstream.

11. **Cleanup poller binds candidate auth_id to the row's auth_id.** A stale candidate whose users.auth_id had been re-linked to a NEW Supabase identity could let `deleteUser(<old auth_id>)` destroy the wrong identity. Now requires equality + DELETE WHERE predicate also pins it.

12. **OTP UI copy says "8-digit code"** (Supabase production is configured for 8, not 6). Inline comment in CheckEmailClient documents the source of truth.

13. **Rate-limit error responses now have human-readable `message` fields.** Was leaking machine codes (`rate_limited`, `rate_limit_unavailable`) directly into the form's error display. Server provides messages, client also has a fallback `KNOWN_MESSAGES` map for defense-in-depth.

14. **Middleware sends admins on `/onboarding/*` to `/admin/overview` instead of `/login`.** Was forcing them to re-authenticate when they were already correctly logged in.

### Files added/changed in B15–B20

```
NEW:
  worker/jobs/EmailChannelReconcilePoller.ts                   ← durable retry for missing email enrollments
  worker/jobs/__tests__/EmailChannelReconcilePoller.test.ts    ← 6 tests

MODIFIED:
  worker/jobs/CleanupAbandonedSignupsPoller.ts                  ← TOCTOU + identity-binding fixes
  worker/jobs/__tests__/CleanupAbandonedSignupsPoller.test.ts   ← 4 new TOCTOU regression tests
  worker/index.ts                                                ← register/stop EmailChannelReconcilePoller

  src/app/api/onboarding/select-plan/route.ts                   ← lock-then-read race fix
  src/app/api/onboarding/business/route.ts                      ← AND u.role = 'owner' filter
  src/app/api/auth/signup/route.ts                              ← obfuscated-user detect + message field
  src/app/api/auth/callback/route.ts                            ← signOut cookie copy
  src/app/api/admin/businesses/route.ts                         ← APP_URL pre-check + RETURNING id + rollback

  src/app/(public)/signup/SignupFormClient.tsx                  ← KNOWN_MESSAGES fallback map
  src/app/(public)/signup/check-email/CheckEmailClient.tsx      ← 8-digit copy
  src/app/onboarding/pay/page.tsx                               ← active+not-onboarded → /onboarding/business

  src/lib/shared/schemas.ts                                      ← googleMapsUrlSchema + isPlaceId alignment + admin XOR
  src/middleware.ts                                              ← admin role → /admin/overview not /login

  src/lib/shared/__tests__/signup-schemas.test.ts               ← 11 new schema tests (URL + XOR)
  src/app/api/onboarding/__tests__/select-plan.test.ts          ← race_lost test + role-filter pin
  src/app/api/onboarding/__tests__/business.test.ts             ← role-filter pin + URL fixture update
  src/app/api/auth/__tests__/signup.test.ts                     ← message-shape regression assertions
  src/app/api/admin/businesses/__tests__/route.test.ts          ← link-failure rollback tests + mock refactor
  src/lib/onboarding/__tests__/create-business.test.ts          ← mock fixes for new SQL shapes
```

### New env vars

| Var | Purpose |
|---|---|
| `EMAIL_CHANNEL_RECONCILE_INTERVAL_MS` | Optional, default 10min. How often the reconcile poller scans for active businesses missing an email enrollment. |
| `EMAIL_CHANNEL_RECONCILE_BATCH_SIZE` | Optional, default 100. Max INSERTs per scan. |
| `EMAIL_CHANNEL_RECONCILE_DISABLED=true` | Skip the poller entirely. Mock mode auto-skips too. |

### What stayed the same

- The 12 runbook scenarios (A–M in `docs/signup-test-runbook.md`) all still pass.
- All production prerequisites still apply (custom SMTP via Resend, 3 email templates, migration 025, Stripe Payment Links, env vars).
- `SELF_SERVE_SIGNUP_ENABLED=false` in prod until the prereqs are done + the 12 scenarios pass on staging.

---

## Zernio GBP Auto-Posting Integration (2026-04-28, branch `feat/zernio-integration`)

### What this is in plain words

Up until now, every time the AI drafted a reply to a Google review and the owner approved it, a sales partner had to manually copy that reply and paste it into the Google Business Profile dashboard. That works for a handful of customers but doesn't scale, and it slows down replies. We applied for direct Google Business Profile API access months ago and are still waiting.

Zernio is a third party that already has GBP API access. They expose a friendly HTTP API: log in once, pick your Google location, and from then on you can list reviews and post replies through their server.

This integration wires Zernio in as the auto-posting backend. The owner clicks "Connect Google Business" once on their dashboard, picks the right business location, and from that moment on every approved reply gets posted automatically. If the connection breaks (owner revokes access on Google's side, or Zernio reports the account disconnected via webhook), the system gracefully parks pending replies, emails the owner with a "Reconnect" CTA, and resumes once they're connected again. No replies are lost.

Everything is gated behind a `ZERNIO_PUBLISHING_ENABLED` flag that defaults OFF. Merging the PR ships dormant code; flipping the flag goes live.

### Connect flow in plain words

1. Owner sees a blue banner on their dashboard: "Connect Google Business to start auto-posting your approved responses."
2. Owner clicks **Connect** → browser POSTs to `/api/zernio/connect/start` → Zernio returns an OAuth URL → browser redirects there.
3. Owner authorises with Google through Zernio's OAuth provider → Zernio redirects browser back to `/api/zernio/connect/callback?state=...&connect_token=...`.
4. The callback validates the state, asks Zernio for the list of Google locations the owner manages, sets a signed session cookie, and redirects to `/dashboard/connect/select-location`.
5. Owner picks the right location and submits → POSTs to `/api/zernio/connect/select-location` → server takes a finalize lock, calls Zernio's `selectLocation`, and atomically writes a `zernio_connections` row + a `drain_pending_owner_connect` outbox entry in one Postgres transaction.
6. Drain worker picks up the outbox entry and re-enqueues any responses that were parked in `awaiting_owner_connect` while the connection was down.

If anything goes ambiguously wrong at step 5 (timeout / 5xx / network blip mid-call), the system writes a `zernio_finalize_incidents` row and shows the owner a yellow "manual review" banner — admin reconciles via the runbook. This is the worst case and is rare; it exists because we never want to silently create a duplicate connection.

### Publishing in plain words

When `ResponsePublisherWorker` picks up an approved response:

- **Active Zernio connection?** Look up the matching Zernio review id (cached in Redis), call `postReply`, mark the response `posted`. Done in seconds, no human in the loop.
- **No active connection?** Mark the response `awaiting_owner_connect` and queue an email to the owner: "Your reply for [business] is ready to publish — reconnect Google Business to send it."
- **Auth error during post?** Connection got revoked between when we checked and when we tried — disconnect the row, mark the response `awaiting_owner_connect`, queue the reconnect email AND the connection-lost email.
- **Transient error during post?** Re-throw so BullMQ retries. If retries exhaust, the `publisherWorker.on('failed')` handler runs the same graceful degradation path.
- **Reply already exists at Zernio?** Treat as idempotent success — someone (us or another path) already posted. Mark the response `posted`.
- **Review not found at Zernio?** Permanent failure. Mark the response `failed` and create a `review_exceptions` row for admin to investigate.

### Files added / changed

#### New top-level documentation

- `docs/zernio-launch-runbook.md` — operational runbook with the `finalize_unknown` reconciliation procedure (Branch A sub-cases A-1/A-2/A-3 + Branch B + rollback paths). Oncall reference.
- `docs/zernio-testing-and-shipping.md` — local QA + production shipping playbook. 6 test scenarios with exact curl/SQL/redis commands. Pre-flight checklist for prod rollout.
- `docs/zernio-test-report-2026-04-28.md` — actual test pass report from 2026-04-28. All 6 scenarios PASS.

#### Database migration

- `supabase/migrations/026_zernio_publishing.sql` — widens `responses.status` VARCHAR → TEXT, recreates `responses_one_non_terminal_per_review` partial unique index to include `awaiting_owner_connect`, creates `zernio_connections` + `zernio_finalize_incidents` tables (RLS enabled, partial unique indexes), creates 2 dedup partial unique indexes on `notification_deliveries` for the new owner emails, pre-cleanup UPDATE on `job_outbox` to collapse duplicate in-flight `publish_response` rows, then `idx_jo_publish_response_inflight` partial unique index.

#### Zernio HTTP client and types — new directory `src/lib/zernio/`

- `src/lib/zernio/types.ts` — `EndpointKind` union, `ZernioConnectionStatus`, `ZernioConnectionRow`, `ZernioReview`, `ZernioLocationOption`, `ConnectPendingMarker`, `ConnectStateBlob`, `ConnectLocationsBlob`.
- `src/lib/zernio/errors.ts` — 7 typed error classes: `ZernioAuthError`, `ZernioValidationError`, `ZernioTransientError`, `ZernioPermanentError`, `ZernioReviewNotFoundError`, `ZernioReplyAlreadyExistsError`, `ZernioRouteError`.
- `src/lib/zernio/client.ts` — `request()` primitive with AbortController timeouts and Zernio-error preservation, 9 per-endpoint methods (`createProfile`, `startConnect`, `listLocations`, `selectLocation`, `listReviews`, `listAllReviews`, `postReply`, `deleteAccount`, `deleteProfile`), `classifyAndParse` with endpoint-aware error mapping including a strict allowlist for 409 publish_reply codes, mock-mode bypass.
- `src/lib/zernio/connect-state.ts` — 6 shared Lua scripts (`luaTokenCAS`, `luaCASToFinalizing`, `luaCASRevertToOauth`, `luaCASToFinalizeUnknown`, `luaDeletePendingByFlowIdAnyStatus`, `luaCASCancel`) + key helpers (`pendingKey`, `stateKey`, `locationsKey`, `lockKey`, `finalizeLockKey`) + id generators.
- `src/lib/zernio/connect-session-cookie.ts` — HMAC-signed `zernio_connect_session` cookie helpers (set / read / clear). Mirrors the approval-cookie pattern.
- `src/lib/zernio/__tests__/{errors,client}.test.ts` — 28 unit tests covering the error classes + classification table.

#### Publishing — new file in `src/lib/publishing/`

- `src/lib/publishing/zernio-publisher.ts` — `lookupZernioReviewId` (Redis-cached, 4-page paginated, displayName + rating + comment + ±24h match) + `applyTransientExhaustionFallback` (transactional disconnect + revert response + double notify-outbox INSERT).
- `src/lib/publishing/__tests__/zernio-publisher.test.ts` — 4 tests (cache hit, missing internal review, happy-path 4-field match + cache write, no-candidate-match).

#### Email templates — new files in `src/lib/notifications/email/templates/`

- `owner-reconnect-required.ts` — per-response email when the owner approved a reply but the connection isn't active.
- `owner-connection-lost.ts` — per-business-per-day email when the connection drops via webhook or auth-error-on-post.

#### Status grouping — new shared module

- `src/lib/shared/response-status.ts` — central source of truth for response status groupings (`HANDLED_STATUSES`, `APPROVED_OR_LATER_STATUSES`, `NON_TERMINAL_STATUSES`, `TERMINAL_STATUSES`, `AWAITING_PUBLISH_STATUSES`, `RECENT_REVIEW_DISPLAY_STATUSES`, type `ResponseStatus`). 7 unit tests guard the partition.
- 8 production callsites updated to import these constants instead of inline `IN ('approved', 'edited', 'awaiting_manual_post', ...)` lists, ensuring `awaiting_owner_connect` is counted everywhere `awaiting_manual_post` is.

#### UI — components and pages

- `src/components/dashboard/ConnectGoogleBanner.tsx` — 4 banner states: blue "Connect" (none), blue "Connecting…" + view-progress link (in-flight pending), orange "Reconnect" + queued-count headline (disconnected), yellow "manual review" (finalize_unknown).
- `src/app/(authenticated)/dashboard/connect/page.tsx` — state-aware connect page (Connect / Connecting / Finalizing / Reconnect / Manual-review).
- `src/app/(authenticated)/dashboard/connect/select-location/page.tsx` — server component that reads cookie + Redis SSR.
- `src/app/(authenticated)/dashboard/connect/select-location/LocationPicker.tsx` — client form for location selection with friendly error messages.

#### API routes — new directory `src/app/api/zernio/`

- `src/app/api/zernio/connect/start/route.ts` — POST. Two-layer concurrency defense, DB idempotency check, `zernio_finalize_incidents` block, placeholder marker, full Zernio start work, Step F failure cleanup.
- `src/app/api/zernio/connect/callback/route.ts` — GET. Atomic GETDEL state claim, double pending re-verify, signed cookie set, OAuth-denial cleanup.
- `src/app/api/zernio/connect/select-location/route.ts` — POST. Largest single route. Finalize lock, finalizing CAS, Zernio call with outcome-known/unknown branching, DB transaction, post-accountId recovery.
- `src/app/api/zernio/connect/cancel/route.ts` — POST. flowId-bound CAS-cancel with finalize-state refusal.
- `src/app/api/zernio/disconnect/route.ts` — POST. Owner + admin (sales_partner explicitly excluded), `manual_owner` / `manual_admin` reason.

#### Worker — new files in `worker/`

- `worker/jobs/OwnerEmailWorker.ts` — handles both `reconnect_required` and `connection_lost` discriminated kinds with claim-before-send dedup. The `connection_lost` `ON CONFLICT` clause uses `((created_at AT TIME ZONE 'UTC')::date)` to match migration 026's index expression.
- `worker/jobs/DrainOwnerConnectWorker.ts` — single CTE that re-enqueues stuck `publish_response` rows for a business with NOT EXISTS guard + ON CONFLICT DO NOTHING.
- `worker/ingress/zernio.ts` — Fastify webhook handler. Flag-gate, HMAC verify, `inbound_events` dedup, switch on event type. `account.disconnected` → `WITH disconnected AS ... INSERT FROM disconnected` multi-row pattern that flips connections + queues notify-owner-connection-lost outbox rows.
- `worker/ingress/zernio-verify.ts` — HMAC-SHA256 verifier with HEX_64 regex check + length-safe `timingSafeEqual` (8 unit tests).

#### Worker — modified files

- `worker/jobs/ResponsePublisherWorker.ts` — Steps 4-8 replaced with the Zernio branch. 7 distinct error sub-cases each with the correct status transition and idempotency guard.
- `worker/index.ts` — registered `OwnerEmailWorker` + `DrainOwnerConnectWorker`, attached `publisherWorker.on('failed')` graceful-degradation handler, registered `/ingress/zernio` Fastify route with `rawBody: true`, called `assertZernioPublishingEnv()` at boot.
- `worker/queues.ts` — registered `drainOwnerConnect` + `sendOwnerEmail` queue instances; added 3 `topicToQueue` entries (`drain_pending_owner_connect`, `notify_owner_reconnect`, `notify_owner_connection_lost`).
- `worker/startup-assert.ts` — gated 4 new env vars behind `ZERNIO_PUBLISHING_ENABLED` (with mock-mode bypass).
- `worker/ingress/resend.ts` — added `owner_reconnect_required` + `owner_connection_lost` to `OWNER_DIRECTED_TEMPLATES` for hard-bounce handling.

#### Admin UI — modified

- `src/app/admin/businesses/[id]/components/ZernioConnectionPanel.tsx` (new) — current state, timestamps, disconnect_reason, last_error preview, queued response count, unresolved finalize incidents, Manually Disconnect button.
- `src/app/admin/businesses/[id]/page.tsx` — wires in the panel.
- `src/lib/admin/business-detail-{types,service}.ts` — 3 new SQL queries inside the existing Promise.all + types.
- `src/app/admin/overview/page.tsx` + `src/app/api/admin/overview/route.ts` — added "Reconnect" column showing count of `awaiting_owner_connect` responses per business (color-coded: 0 → `—`, 1-2 amber, 3+ red).

#### Dashboard data — modified

- `src/lib/dashboard/types.ts` — added `zernioConnection.pendingFlow?` field with `status` + `started_at`.
- `src/lib/dashboard/service.ts` — added 3 SQL queries (zernio_connections, awaiting_owner_connect responses count, unresolved incidents) + Redis read for `connect_pending` marker. Status precedence rule: incident → pending finalize_unknown → active DB → pending (in-flight) → DB pending/disconnected → none. `pendingFlow` only surfaced when relevant.
- `src/components/DashboardContent.tsx` — wires `<ConnectGoogleBanner zernio={data.zernioConnection} />` near the top of the active-data view.

#### Helper scripts — new

- `scripts/redis.ts` + `pnpm redis` shortcut — tiny Redis CLI helper that reuses the project's `REDIS_CACHE_URL` connection. Commands: `get`, `keys`, `scan`, `del`, `ttl`, `set`, `info`, `zernio` (dump all connect-flow keys), `flush-zernio` (delete a business's Zernio Redis state, asks for confirmation). Avoids the need to install redis-cli on Windows / WSL / Upstash-with-TLS setups.
- `scripts/zernio-fire-webhook.sh` — signed-webhook helper that builds the right nested-`account.id` payload per spec §5.4, supports `account.disconnected`, `webhook.test`, `review.new`, `review.updated`, custom event types.

### Bugs we hit + fixed (the interesting ones)

**The `(created_at::date)` immutability trap.** Migration 026 originally tried to use `(created_at::date)` in a partial unique index. Postgres rejected it at apply time with `ERROR 42P17: functions in index expression must be marked IMMUTABLE` because `timestamptz::date` is `STABLE` (depends on session timezone). Fix: wrap with `AT TIME ZONE 'UTC'` first — `((created_at AT TIME ZONE 'UTC')::date)` is `IMMUTABLE`. The `OwnerEmailWorker` `ON CONFLICT` clause must use the byte-identical expression. Lab note added.

**409 publish_reply too permissive.** Original implementation marked any 409 from publish_reply as "reply already exists" → response posted. If Zernio uses 409 for a different conflict (rate limit, lock contention), we'd record a phantom post. Fix: gate on `body.code` matching a strict allowlist (`reply_already_exists`); unknown 409 codes now retry transient instead.

**Non-`select_location` 4xx fallthrough → infinite retries.** Only 400 was classified permanent; 422/410/etc. fell through to the transient classifier and retried until BullMQ exhaustion, eventually triggering connection-loss fallback for what should have been a permanent error. Fix: catch-all 4xx → ZernioPermanentError, exempting 408/429.

**finalize_unknown overwrite via stale-age fallthrough.** `/start` originally treated any pending marker >15min old as stale and recreated. If a `zernio_finalize_incidents` insert had failed but the Redis CAS to `finalize_unknown` succeeded, after 15min the marker would be overwritten and the incident lost. Fix: hard refusal on `finalize_unknown` markers regardless of age — admin reconciliation required.

**Pending state invisible on dashboard.** Connect flow stores in-flight state in Redis only; schema can't insert a pending row (NOT NULL on account/location). Original dashboard `zernioConnection.status` came from DB only, so in-flight flows showed as `none` and the user got no cancel CTA. Fix: read `connect_pending` Redis key in dashboard service; surface as `pendingFlow` field; banner has a new blue "Connecting…" branch.

**Stale pending hides active connection.** select-location's best-effort Redis cleanup after the DB tx could fail transiently. The dashboard precedence at the time gave any pending marker priority over `active` DB status, so a 15min "stuck connecting" UX could appear even after the real connection succeeded. Fix: precedence reorder — `active` DB beats non-finalize_unknown pending markers; `pendingFlow` is undefined when status resolves to `active`.

**`awaiting_owner_connect` missing from status groups.** Multiple metric/display callsites had ad-hoc `IN ('approved', 'edited', 'awaiting_manual_post', 'posted')` lists that excluded the new state, undercounting dashboard response rate, admin overview metrics, weekly summaries, engagement detection, and onboarding milestones. Fix: centralized `src/lib/shared/response-status.ts` with named groups; updated 8 callsites.

**process-review.ts review-edit exception.** When a SerpAPI review's content changes for an `awaiting_owner_connect` response, the original code threw away the owner's approval and regenerated. Fix: extended the exception branch to include `awaiting_owner_connect`.

**OAuth-denial leaked profile + blocked owner.** When the user denied OAuth on Google's side, callback returned the friendly redirect immediately without cleanup — Redis pending marker stayed for 15min TTL, Zernio profile orphaned. Fix: best-effort cleanup (atomic GETDEL state, flowId-bound delete pending, `deleteProfile`) before redirecting.

**Webhook test helper payload shape (caught during 2026-04-28 manual QA).** The inline test script in the testing guide built a flat `accountId` field, but the handler reads nested `body.account.id` per spec §5.4. Handler returned 200 received:true but silently skipped processing — false-positive in CI/manual testing. Fix: promoted the inline script to versioned `scripts/zernio-fire-webhook.sh` with proper nested payload + multi-event support.

### New env vars

- `ZERNIO_PUBLISHING_ENABLED` — gates everything. Default off. Server-authoritative.
- `ZERNIO_API_KEY` — required when flag on (mock mode bypasses). Worker startup assertion enforces.
- `ZERNIO_WEBHOOK_SECRET` — required when flag on. HMAC shared secret used by `worker/ingress/zernio-verify.ts`. Must match the value configured in the Zernio dashboard exactly.
- `ZERNIO_PROFILE_ID_PREFIX` — optional, default `'repworth-prod-'`. Prefixed onto Zernio profile names so prod / staging / local don't collide on the same Zernio workspace.
- `ZERNIO_API_BASE` — optional, default `'https://zernio.com/api'`. Override for sandbox.

### Required before prod flag flip

- Zernio account: subscribe to **Accelerate plan + Inbox add-on** (required for `gmb-reviews` API access)
- Zernio dashboard: generate API key + webhook secret; configure webhook URL pointing at `${WORKER_PUBLIC_URL}/ingress/zernio`; subscribe events `account.disconnected` + `webhook.test` (optionally `account.connected`, `review.new`, `review.updated`); fire the test webhook → expect 200 in Railway logs
- Apply migration 026 in prod Supabase (one brief ACCESS EXCLUSIVE moment on `responses` — run during low traffic)
- Set `ZERNIO_API_KEY` + `ZERNIO_WEBHOOK_SECRET` + `WORKER_PUBLIC_URL` + `NEXT_PUBLIC_APP_URL` in both Railway (worker) and Vercel (Next.js)
- Deploy with flag OFF first; verify routes return 503 and worker boots cleanly with the env vars present
- Flip `ZERNIO_PUBLISHING_ENABLED=true` on Railway and Vercel; verify routes flip from 503 to 401 (alive but require session)
- Onboard one cooperative customer per `docs/zernio-launch-runbook.md` Phase 1; monitor for 1-2 weeks (Sentry triage, admin overview Reconnect column, Zernio billing reconciliation)

### What's deferred (Phase 1+ follow-ups)

- **Review-id lookup persistence.** Current `lookupZernioReviewId` scans 4 pages × 50 reviews per attempt and field-matches on displayName + rating + comment + ±24h timestamp. For large accounts or normalized text differences this can falsely mark publishable responses as mismatches. The right fix is to persist Zernio's review id at SerpAPI ingestion time (or after Phase 3, replace SerpAPI ingestion with Zernio webhooks entirely). Tracked as a Phase 1 follow-up.
- **`NEXT_PUBLIC_ZERNIO_PUBLISHING_ENABLED`** companion flag for hiding the dashboard "Connect" CTA before launch. Currently the banner shows for `zernioConnection.status === 'none'` regardless of the worker flag — owners with the migration applied but the flag off will see a CTA that 503s. If you want to hide the CTA until launch, that's a small follow-up commit.
- **Phase 3** — promote `review.new`/`review.updated` webhook counters (currently just incrementing a Redis counter for visibility) to real ingestion events; swap SerpAPI polling for Zernio webhooks for connected businesses. Cost savings: ~70% of current polling spend disappears as customers connect.

### Tests

- Unit tests added: 36 (8 webhook verify, 25 client classification, 4 publisher, 7 status-group, 4 dashboard precedence, plus the bonus latent-bug regressions)
- Total branch tests: **1544/1544 pass** (full project suite)
- E2E scaffold at `e2e/zernio-connect.spec.ts` (skips gracefully without `TEST_DATABASE_POOL_URL`; fixme block locks in the happy-path intent for when the auth harness is wired)

### Local QA pass on 2026-04-28

All 6 scenarios from `docs/zernio-testing-and-shipping.md` Part 1 manually exercised against the worktree. Full report in `docs/zernio-test-report-2026-04-28.md`. **All PASS.**

| Scenario | Tests | Status |
|---|---|---|
| A — Happy-path connect | start → callback → select-location → success | ✅ |
| B — Cancel mid-flow | cancel returns `{cancelled:true,reason:flow_cancelled}`; clean state | ✅ |
| C — Disconnect | DB flips to `disconnected` with `manual_owner`; orange banner | ✅ |
| D — Publishing pipeline | Mock returns 0 reviews → review-not-found path; failed status + review_exception | ✅ |
| E — Webhook ingress | account.disconnected flips connection + queues notify; bad sig 401; dedup works | ✅ |
| F — finalize_unknown | Forced via mock patch; incident row + yellow banner; Sentry alert | ✅ |

---

## Channels Phase 4 — Owner Channel Dashboard (2026-04-28, branch `feat/phase-4-owner-channels`, PR #10)

### What this is in plain words

Up until now, if an owner wanted to receive review-approval notifications via Telegram instead of (or in addition to) email, the sales partner had to flip Telegram on for that business from the admin CRM. Same for SMS and WhatsApp once those channels graduate. That doesn't scale — every owner who wants Telegram has to email support to be enrolled. Phase 4 fixes that for Telegram by giving the owner a self-serve page at `/settings/channels` where they can connect Telegram themselves. SMS and WhatsApp are shown but greyed out as "Coming soon" because those channels are still waiting on Twilio 10DLC and Meta business verification respectively.

### How an owner uses it

1. Owner logs into the dashboard and clicks **Settings** in the nav, then the **Notification channels** tab.
2. The page shows four rows:
   - **Email** (always-on, with their email address as the handle and an "Always on" pill).
   - **Telegram** with a Connect button (if the flag is on and the bot env is configured).
   - **SMS** as a Coming Soon row with no button — explains "Available once 10DLC verification clears."
   - **WhatsApp** as a Coming Soon row — "Available once Meta business verification clears."
3. Owner clicks **Connect** on the Telegram row.
4. The page generates a QR code + a `https://t.me/RepWorthBot?start=<token>` deep link, valid for 1 hour. A countdown timer ticks down.
5. Owner scans the QR with their phone (or clicks the link if they're on mobile), opens the chat with `@RepWorthBot`, and taps **Start**.
6. Telegram sends a webhook to the worker. The worker hashes the token, looks up the matching `pending_verification` row, flips it to `verified`, and stores the chat ID as the handle.
7. The page (which has been polling every 3 seconds) sees the row flip to `verified` and immediately updates: ✓ Connected · ••• 1234 (last 4 digits of the chat ID) with a Disconnect button.
8. From now on, every approval-request email also arrives as a Telegram message with Approve / Regenerate / Edit buttons.

### What changed under the hood

- **Pure state machine extracted.** The previous admin Telegram widget had ~150 lines of inline `useState`/`useEffect` for the QR-scan flow. We extracted that into a pure `enrollmentReducer` (`(state, action) => state`, no I/O, no `Date.now()`) with 8 states and 8 action types. 27 unit tests pin every transition in the table including the subtle "no-op" ones — e.g. when the page polls during `awaiting_scan` and gets back a `pending_verification` row, the reducer must NOT touch the cached `expiresAt` because the row's expiry could be a stale read.
- **React glue moved into a hook.** `useEnrollment` wires the reducer to fetch, polling, AbortController cleanup, and the 1 s TTL countdown. Both the admin Telegram widget AND the new owner widget consume it. The admin WhatsApp widget was also refactored to use the same hook (229 → 68 lines, a 70 % reduction). Visual layout unchanged on the admin side.
- **Shared transaction helpers.** `startTelegramEnrollment(tx, businessId, tokenHash, expiresAt)` extracts the SELECT + INSERT/UPDATE that admin and owner routes both need. Caller owns the advisory lock and QR generation; helper owns the state machine and the 23505 → typed-error mapping. Plus matching `cancelTelegramEnrollment` / `disableTelegramEnrollment` helpers.
- **Owner-scoped routes** under `/api/dashboard/channels/*` (4 new routes). Every POST is wrapped with `withSameOrigin()` for CSRF protection. `businessId` always comes from the session via `requireRole(req, 'owner')`, never from the request body — the browser cannot ask the server to act on someone else's business.
- **Migration 027 — partial unique index.** A new database-level constraint enforces "at most one pending or verified mobile channel per business" across SMS / Telegram / WhatsApp. Defense-in-depth: even if the UI gates this client-side, a buggy client or future API path can't enroll two mobile channels for the same business. The predicate intentionally excludes disabled / unsubscribed / archived rows so an owner's enrollment history is preserved across switches.

### The hardening pass — 4 review rounds with Codex

The first implementation pass shipped, but Codex (a separate AI reviewer) found 9 distinct issues across 3 review rounds. All were fixed before merge.

**Round 1 — 6 fixes:**

1. **Critical — cancel left rows occupying migration 027's slot.** When an owner cancelled a Telegram QR scan, we cleared the token but left the row in `pending_verification`. Migration 027 treats those rows as "occupying the one mobile channel slot per business" — so once SMS or WhatsApp ships, an owner who cancelled Telegram would hit a 409 with no UI explanation when trying to enroll a different mobile channel. Fix: cancel now flips status to `disabled`. The `disabled → pending` reconnect branch in the start helper handles re-enrollment cleanly.
2. **Medium — SMS verify burned a Twilio SMS before checking for cross-channel conflict.** The 23505 catch correctly returned 409, but Twilio had already been called and we'd already paid for an SMS. Fix: pre-check inside the SMS lock for any other pending/verified mobile channel before calling Twilio.
3. **Medium — Owner Telegram widget ignored the server-loaded enrollment row.** A verified owner saw the Connect button for ~200–500 ms before the hook's first fetch resolved; clicking during that window produced a misleading 409. Fix: derive an `initialSnapshot` from the verified row server-side and hand it to `useEnrollment` (which then skips the first fetch).
4. **Medium — `cancel()` hid server failures.** The hook's cancel action always dispatched success regardless of HTTP status. A 401 / 500 / network failure would make the UI show idle while the server still had a pending row. Fix: only dispatch `CANCEL_SUCCEEDED` on a 2xx response; surface non-OK and network failures through the same error UI as connect failures.
5. **Medium — E2E specs are mostly `test.fixme`.** Acceptable as a tracked gap — the executable regression layer is the unit-tested reducer / helpers / detector, plus integration-style helper tests with mocked `tx`. Fix: documented the coverage path with a comment block at the top of each spec file so future contributors know where to look.
6. **Low — error copy hardcoded "Telegram".** The reducer's 404 handler said "Telegram is currently unavailable." after the WhatsApp widget refactor, which now uses the same reducer. And 409 conflated `already_verified` with `multiple_mobile_channels`. Fix: channel-neutral 404 copy, plus a 409 disambiguation that reads the response's `error` field.

**Round 2 — 2 fixes:**

7. **Medium — per-channel locks didn't serialize cross-channel.** Each channel held its own advisory lock (`sms_enroll:`, `telegram_enroll:`, `whatsapp_enroll:`), so a concurrent SMS verify + Telegram start could race past the SMS pre-check. Migration 027 still saved correctness, but the SMS bill was already incurred. Fix: unify all 4 mobile-enrollment paths under `mobile_enroll:${businessId}`.
8. **Medium — cancel routes did no advisory locking.** A concurrent start could observe the pending row, fall through to its UPDATE branch (no status WHERE guard), and overwrite cancel's `disabled` transition back to `pending_verification`. Plus my Round 1 fix had accidentally dropped the `archived_at IS NULL` filter from the cancel WHERE clause. Fix: cancel routes now wrap their UPDATE in `sql.begin` and take the same `mobile_enroll` lock as start; `archived_at IS NULL` filter restored.

**Round 3 — 1 fix:**

9. **Medium — start vs webhook race.** The mobile_enroll advisory lock serialized start-vs-start and start-vs-cancel, but webhook ingress doesn't take that lock. Without `SELECT FOR UPDATE`, start could SELECT a pending row, get preempted by an inbound webhook that flips the row to `verified`, then UPDATE by id back to pending — losing the verification. Fix: `SELECT FOR UPDATE` in `startTelegramEnrollment`, the WhatsApp admin start route, and the WhatsApp inbound verifier. Postgres row-locks now serialize start with inbound across separate transactions. (Telegram inbound already had `FOR UPDATE`, so it was untouched.)

**Round 4 — zero findings.** Branch is genuinely clean.

### What's deliberately NOT in this phase

- **No SMS or WhatsApp owner-side enrollment.** Both render as Coming Soon rows. SMS waits on Twilio 10DLC verification (the brand-and-campaign registration that lets us send to consumer mobile numbers in the US). WhatsApp waits on Meta business verification (a 2–4 week clock that requires a verified Meta business account + a WhatsApp Business API number).
- **No multi-channel "and" support.** Per spec § 3, an owner picks ONE extra channel beyond email. Migration 027 enforces this at the DB level. If we ever want "Email + Telegram + SMS at the same time," we'd need a new phase that drops the partial unique index and updates the dispatcher to fan-out.
- **No automated component-level tests for `useEnrollment`.** Vitest is configured for node-only (no jsdom) so the hook's React-specific behavior (polling cancellation on unmount, AbortController cleanup) is covered by Playwright's `test.fixme` block and the existing reducer unit tests. Real Playwright execution is deferred until the Supabase admin `generateLink` magic-link harness lands.

### Test plan

| Scenario | What it covers | Status |
|---|---|---|
| Reducer state machine | 27 unit tests, every transition + identity-equality no-ops | ✅ |
| Helper transactions (mocked tx) | 13 helper tests incl. cancel-then-start round-trip | ✅ |
| 23505 classifier | 11 detector unit tests | ✅ |
| Type-check | `pnpm tsc --noEmit` | ✅ clean |
| Lint | `pnpm lint` | ✅ clean |
| Full vitest suite | 1604 / 1604 passing | ✅ |
| Authenticated UI E2E | Playwright `test.fixme` pending auth harness | ⏸ deferred |
| Unauthenticated redirect E2E | `/settings/channels` → `/admin/login` | ✅ runs in CI |
| Manual smoke test on staging | Per `docs/runbooks/phase-4-owner-channels-manual-test.md` | ⏳ before flag flip |

### How to roll out

1. **Migration 027** is already applied to prod Supabase (2026-04-28).
2. **Merge PR #10** to main.
3. **Walk through `docs/runbooks/phase-4-owner-channels-manual-test.md`** on staging (or a local dev environment with `CHANNELS_TELEGRAM_ENABLED=true` and a real `@RepWorthBot` token).
4. **Flip `CHANNELS_TELEGRAM_ENABLED=true` in prod** once the smoke test passes.
5. **Onboard 1–2 pilot owners** through the new flow, monitor the helper unit tests + Sentry for any unexpected 23505 surfaces.
6. After 1–2 weeks of clean operation, the flag stays on.

---

## Zernio Webhook Ingestion — Replaces SerpAPI Polling (2026-04-30, branch `feat/zernio-ingestion-replace-serpapi`)

### What this is in plain words

Until now, every connected business was polled by SerpAPI every 60 minutes to check for new Google reviews. That cost ~$0.05 per sync × 24 syncs/day × however many businesses we onboarded — and most of those polls returned nothing new. It also meant up to a 60-minute delay between a customer posting a review and us drafting an AI response.

Zernio's webhooks already fire `review.new` and `review.updated` within seconds of a Google review appearing. The Phase 1 publishing rollout (the previous Zernio integration) wired up the webhook receiver but left the events as a no-op counter, just incrementing a Redis number for visibility. This sprint promotes those webhooks into the actual ingestion path.

The result: when a customer posts a review on Google, Zernio fires the webhook to our worker → we look up which RepWorth business owns that location → we fetch the full review payload from Zernio → we run our existing pipeline (dedup, AI draft, owner email). Total latency: a few seconds instead of up to an hour. Cost: zero polling spend on customers who use Zernio. The SerpAPI polling code is GONE for production ingestion (the SerpAPI source is preserved for the prospect demo engine, which still scrapes any Google Maps URL the sales partner pastes).

The same `ZERNIO_PUBLISHING_ENABLED` flag from Phase 1 controls everything — there's no new flag. Flipping it on activates publishing AND ingestion together.

We also took the opportunity to ship two things that were waiting on this work: (1) the Premium subscription tier is now wired end-to-end (it had cost-limit constants and type-union slots, but the plan picker, payment-link, and Stripe webhook didn't know about it), and (2) the `awaiting_manual_post` response status is fully decommissioned (it's been dormant since Phase 1 publishing landed; migration 029 bulk-fails any orphan rows and rebuilds the non-terminal-uniqueness index without it).

### How webhook ingestion works in plain words

1. A customer posts a review on Google.
2. Zernio's backend detects it (probably via Google's own Pub/Sub or polling on their end — that's their problem) and fires a webhook to `${WORKER_PUBLIC_URL}/ingress/zernio` with HMAC signature.
3. `worker/ingress/zernio.ts` verifies the signature, deduplicates against the `inbound_events` table, and parses the payload through `parseZernioReviewWebhook` (extracts the bare review id from either `review.id` or the resource-name path, validates agreement when both are present, deliberately does NOT cross-check the top-level `account.id` against the `accounts/{...}` segment in `review.name` — those are different ID spaces).
4. The handler runs a single `INSERT … SELECT … FROM zernio_connections … ON CONFLICT DO NOTHING` that emits one `ingest_zernio_review` outbox row per active connection at the firing Zernio account. When the parsed payload includes a location segment, the WHERE narrows to that exact location so sibling-location businesses at the same account don't all receive every webhook. The ON CONFLICT clause uses migration 030's partial unique index to dedup against in-flight rows when Zernio retries a webhook delivery mid-processing.
5. `OutboxPoller` picks up the row and dispatches it to `ZernioReviewIngestWorker`.
6. The worker checks subscription status, verifies the connection is still active (pinned by account+location), and walks up to 4 pages of `listReviews` (configurable via `ZERNIO_INGEST_MAX_PAGES`) scoped to the connection's location. It locates the review by `r.id === zernio_review_id`. If not found:
   - Walked the entire feed (no `nextPageToken` at last page) → durable `ZernioIngestReviewNotFoundError` → after BullMQ retries exhaust, opens a `review_exceptions` row with type `zernio_review_not_found`.
   - Hit cap with `nextPageToken` still set → indeterminate `ZernioIngestPaginationCapExhaustedError` → opens a distinct `zernio_pagination_cap_exhausted` exception type so ops can decide whether to bump the cap.
7. If the review is found AND `reviewReply !== null` (Zernio is reporting that the customer already received a reply via Google), the worker runs `reconcileExternallyAnsweredReview` — matches local rows by both exact zernio identity AND legacy `serpapi_poll` field-match, supersedes any active draft whose canonicalized `approved_text` does NOT match the external reply's text. (Replies that DO match are protected — that's our reply being reflected back.)
8. Otherwise, the worker builds a `MonitoredReview` with location-scoped resource names (`zernio://{accountId}/locations/{locationId}/reviews/{reviewId}`) and runs `processReview` — which handles dedup via `ON CONFLICT (provider, provider_review_name) DO NOTHING`, race-loss recovery, content-change detection, and the existing approval-pipeline state machine.
9. From there, the existing `ResponseGeneratorWorker` → `NotificationWorker` → owner approves → `ResponsePublisherWorker` chain runs unchanged.

### How the first-connect backfill works in plain words

When an owner connects Zernio for the first time on `/dashboard/connect`, we want to ingest some of their existing reviews so the dashboard isn't empty. But pulling 10 years of review history is expensive and clutters the approval inbox. The backfill is bucketed:

- **Gap reviews** = reviews created on or after `subscription_activated_at` (when they started paying). All tiers get up to 25.
- **Historical reviews** = reviews created before `subscription_activated_at`. Premium tier only — up to 50.

Everything else gets skipped, with the count + the `oldest_skipped_create_time` recorded in `zernio_backfill_runs` so the dashboard can render "X older reviews skipped" copy without runtime Zernio API calls.

All processed responses ride `suppress_notification=true` through the generate-response chain, so the first-connect backfill doesn't blast 75 approval emails the moment the owner connects. The reviews show up in the dashboard ready for batch approval; no email avalanche.

If billing was lapsed (`past_due`) when the worker tried to backfill, we record nothing and leave the row retryable. When billing recovers (`invoice.paid` webhook), the Stripe handler auto-enqueues a fresh backfill outbox row to resume. This also covers the rare case of an admin-onboarded business that connects Zernio before completing checkout.

### How the publisher 409 verify-first flow works in plain words

When the owner approves a response, the publisher tries to post to Zernio. If Zernio responds with `409 reply_already_exists`, we used to treat that as idempotent success and mark the response posted. But that's only correct if WE were the one who posted — if the customer manually replied via Google's UI in the meantime, our draft is now stale and shouldn't be marked posted (the customer's reply will be visible publicly, not ours).

The new verify-first flow:

1. On 409, walk listReviews up to 4 pages (or fewer if `getCachedZernioReviewPage` has a hit from the prior `lookupZernioReviewId` field-match — that cache pinpoints which page the review was on last time we saw it).
2. Find the target review and check `reviewReply.comment`.
3. Canonicalize both texts (CRLF→LF, NFC normalize, BOM/zero-width strip, trim) and compare.
4. If match → it's our reply, mark posted. If mismatch → external reply, supersede our draft with `posting_error='already_replied_external'`.
5. If review not found OR `reviewReply` is null (Zernio lag) → throw `ZernioReplyVerificationIndeterminateError`. After BullMQ retries exhaust, open a `zernio_reply_verification_indeterminate` exception with the reason + metadata (pages_walked, reviews_seen, underlying_error) so ops can manually reconcile.

Auth errors during the verifier walk route through the same shared `handlePublisherAuthErrorTerminal` helper as auth errors during the main post — pinned disconnect by account+location, parked response, reconnect notify. Permanent errors route through `handlePublisherPermanentErrorTerminal`. Transient errors are wrapped in `PublisherTransientWithContext` so the failed-hook can pin the disconnect when retries exhaust.

The text-mismatch supersede path logs `len=` and 12-char SHA-256 fingerprints of both reply texts — never plaintext, since reviewer text is PII. Auth error bodies are run through `redactSensitiveError` (strips `Bearer …`, `Basic …`, `token=…`, `api_key=…` patterns) before persisting in `zernio_connections.last_error` or `responses.posting_error` so we never leak credentials in the audit trail even if Zernio echoes a token in a 401 body.

### Files added / changed

#### New top-level documentation

- `docs/zernio-ingestion-test-runbook.md` — pre-merge QA + staging end-to-end smoke (10 scenarios) + production rollout sequence + common failure modes table + rollback procedures + test artifact template. Self-contained: an oncall engineer with no prior context can validate the implementation end-to-end.

#### Database migrations

- `supabase/migrations/028_zernio_backfill_runs.sql` — new `zernio_backfill_runs` table tracking per-business gap/historical processed + skipped counts. `subscription_tier` and `subscription_activated_at` snapshotted at backfill time so the row is self-contained. Partial unique index `zernio_backfill_runs_one_per_business` is defense-in-depth on top of the connect-callback's `needs_backfill` predicate.
- `supabase/migrations/029_drop_awaiting_manual_post.sql` — bulk-fails any orphan `awaiting_manual_post` response rows, rebuilds `responses_one_non_terminal_per_review` partial unique index without the dead status, drops the migration-024 `notification_deliveries_response_template_uniq` index whose predicate is no longer satisfiable. Apply order: 028 BEFORE 029.
- `supabase/migrations/030_ingest_zernio_review_outbox_dedup.sql` — partial unique index `job_outbox_ingest_zernio_review_inflight` on `(aggregate_id, (payload->>'zernio_review_id'))` for non-terminal `topic='ingest_zernio_review'` rows. Webhook fan-out's `INSERT … ON CONFLICT DO NOTHING` uses this to dedup against in-flight rows when Zernio retries a webhook delivery mid-processing.

#### New worker files in `worker/jobs/`

- `worker/jobs/ZernioReviewIngestWorker.ts` — handles the `ingest_zernio_review` outbox topic. Subscription guard → connection-active verify → mock-mode short-circuit → 4-page locationId-scoped `listReviews` walk → distinguish durable not-found from cap-exhausted → fail-closed on unparseable `review.name` → no-op on location mismatch → `reconcileExternallyAnsweredReview` if external reply, otherwise `processReview`. Three typed errors: `ZernioIngestReviewNotFoundError`, `ZernioIngestPaginationCapExhaustedError`, `ZernioIngestUnparseableLocationError`.
- `worker/jobs/ZernioBackfillWorker.ts` — handles the `zernio_initial_backfill` outbox topic. Idempotent claim via `INSERT … ON CONFLICT (business_id) DO NOTHING` + `completed_at IS NOT NULL` sentinel. Tier-aware buckets (gap cap=25 all tiers, historical cap=50 premium-only). All processed responses ride `suppress_notification=true`. Reconcile failures collected per-review; throw at end before setting `completed_at` so BullMQ retries the whole backfill on partial failure.
- `worker/jobs/zernio-ingest-shared.ts` — `handleZernioIngestError` dispatcher (auth → ingestion-fallback + markFailed; permanent/validation → markFailed; transient → rethrow; unknown → rethrow). `reconcileExternallyAnsweredReview` matches local rows by EITHER exact zernio identity OR legacy `serpapi_poll` field-match; per-response protect-set distinguishes "our reply" from "external reply" so mixed legacy/Zernio scenarios resolve correctly.
- `worker/jobs/publisher-error-handlers.ts` — extracted shared terminal-sequence helpers (`handlePublisherAuthErrorTerminal`, `handlePublisherPermanentErrorTerminal`) + new error classes (`PublisherTransientWithContext`, `ZernioReplyVerificationIndeterminateError`) + the `verify409AndDispose` discriminated-union dispatcher + `redactSensitiveError` for credential redaction in persisted error bodies.
- `worker/__tests__/{ZernioReviewIngestWorker,ZernioBackfillWorker,zernio-ingest-shared,publisher-error-handlers}.test.ts` — 4 new test files.
- `worker/__tests__/zernio-end-to-end.integration.test.ts` — exercises the worker chain with mocked sql + zernioClient; covers happy path with location-scoped MonitoredReview identity, multi-location fan-out separation, subscription cancelled, connection disconnected mid-flight, correlation_id propagation, externally-answered review reconcile branch.

#### New shared library files

- `src/lib/zernio/canonicalize-reply.ts` — `canonicalizeReplyText(text): string` — CRLF→LF, NFC normalize, BOM + zero-width strip (U+FEFF + U+200B–U+200D), trim. Used by both the publisher 409 verifier (text-match) and the ingest reconcile helper (protect-set comparison).
- `src/lib/zernio/parse-review-webhook.ts` — `parseZernioReviewWebhook(body)` + `ZernioReviewWebhookParseError`. Accepts both bare `review.id` and resource-name forms in either `review.id` or `review.name`, agreement-checks when both are present, extracts the bare review id and the location segment when available, deliberately does NOT cross-check top-level `account.id` against the resource-path segment (different ID spaces).
- `src/lib/zernio/auth-error-fallback.ts` — `applyIngestionAuthErrorFallback(businessId, accountId, locationId, reason)`. Connection-side cleanup for ZernioAuthError on the ingestion path (no response_id to park, so the publisher's `applyTransientExhaustionFallback` isn't a drop-in). Disconnects only the matching active connection (pinned), redacts credentials in the persisted reason, enqueues `notify_owner_connection_lost`. Idempotent.
- `src/lib/reviews/zernio-normalize.ts` — `zernioReviewToNormalized(z)`, `buildZernioMonitoredReview(z, accountId, locationId)`, `extractLocationFromReviewName(name)`, `ZernioReviewNormalizationError`. Per-review validation throws so workers can isolate one bad review without aborting a batch.
- `src/lib/reviews/zernio-field-match.ts` — canonical predicate for "this Zernio review matches this local serpapi_poll review". Exports `MATCH_WINDOW_MS = 86_400_000`, `fromZernioReview(z)`, `matchesLocalRow(target, localRow)`. Both the SQL fragment in `zernio-ingest-shared.ts` and the JS predicate in `zernio-publisher.ts` use this — single source of truth.
- `src/lib/{zernio,reviews}/__tests__/...` — 5 new test files covering all the above.

#### Modified files (~30)

**Worker entry + queues:**
- `worker/index.ts` — registers `ingestZernioReviewWorker` (default concurrency) + `zernioBackfillWorker` (concurrency 1, serial); `ingestZernioReviewWorker.on('failed')` escalates typed errors to distinct `review_exceptions` types after retry exhaustion (no admin notify for `zernio_review_not_found` and `zernio_pagination_cap_exhausted` — high-volume risk; admin notify only for `zernio_unparseable_review_name` — signals API contract change). Sentry warning for `zernio_pagination_cap_exhausted` so trends are observable. `publisherWorker.on('failed')` adds dedicated branch for `ZernioReplyVerificationIndeterminateError` BEFORE the transient branch (PublisherTransientWithContext extends ZernioTransientError so order matters), unwraps `attemptContext` to call `applyTransientExhaustionFallback` with pinned account+location, surfaces bare `ZernioTransientError` (now a code bug) loudly via Sentry. Workers map keyed by queue name (`workersByQueue`) replaces flat 15-entry array.
- `worker/queues.ts` — drops `sync_reviews` queue, adds `ingest_zernio_review` + `zernio_initial_backfill` queues.
- `worker/startup-assert.ts` — `assertSelfServeSignupEnv` now requires `STRIPE_PAYMENT_LINK_PREMIUM`.

**Worker ingress:**
- `worker/ingress/zernio.ts` — `case 'review.new': case 'review.updated':` replaces the old counter with `parseZernioReviewWebhook` + `INSERT … SELECT … FROM zernio_connections … ON CONFLICT (aggregate_id, (payload->>'zernio_review_id')) DO NOTHING`. Location-narrowed when payload carries it; account-wide fallback otherwise. Tolerates `sha256=` prefix in `x-zernio-signature` header.
- `worker/ingress/stripe.ts` — `processCheckoutSessionCompleted` and `processInvoicePaid` now call `maybeEnqueueBackfillResume` (only on real activation transition, `updated.count > 0`). Predicate is "no completed run exists" so it covers both the no-row case (admin connected Zernio pre-checkout) and the incomplete-row case (billing recovery). In-flight outbox dedup via `INSERT … SELECT WHERE NOT EXISTS`.

**Worker jobs:**
- `worker/jobs/ResponsePublisherWorker.ts` — 409 catch block reduced from 150 lines to a 25-line switch dispatch over `verify409AndDispose`'s discriminated union. Lookup-time `ZernioTransientError` now wraps in `PublisherTransientWithContext`. Drops `'awaiting_manual_post'` from publishable-state gate.
- `worker/jobs/ResponseGeneratorWorker.ts` — `persistResponseAndNotify` honors `suppress_notification=true` from the payload (skips `send_notification` outbox enqueue + `notification_deliveries` write).
- `worker/jobs/AdminExceptionWorker.ts` — `renderExceptionBody` switches on `exception.type` with 5 typed cases (review_edited_after_post, zernio_review_not_found, zernio_permanent_4xx, zernio_reply_verification_indeterminate, zernio_unparseable_review_name) + a generic fallback. SELECT now includes `re.review_id` so the reviewer block gates on row presence.
- `worker/jobs/PlaceIdValidationWorker.ts` — drops `enqueueSyncReviews` helper. Worker still resolves URL → placeId + marks `place_id_verified=true`; just doesn't fan out.

**Shared library:**
- `src/lib/publishing/zernio-publisher.ts` — `lookupZernioReviewId` requires `locationId` (4th param); cache key is `zernio_review_map:{accountId}:{locationId}:{businessId}:{ourReviewId}`. Page-by-page walk caches `(zernioReviewId → page#)` under `zernio_review_page:{accountId}:{locationId}:{zernioReviewId}` for the 409 verifier. Exports `getCachedZernioReviewPage`. Early-return for `provider='zernio'` rows requires exact `provider_location_name` match. `applyTransientExhaustionFallback` REQUIRES `account_id + location_id` (un-pinned legacy fallback DELETED — would have silently disconnected every active connection at a multi-connection business). Uses `fromZernioReview` + `matchesLocalRow` for legacy field-match.
- `src/lib/zernio/{client,types}.ts` — `listReviews` + `listAllReviews` widened to require `locationId`.
- `src/lib/reviews/process-review.ts` — `INSERT INTO reviews … ON CONFLICT (provider, provider_review_name) DO NOTHING`. Race-loss path re-reads FOR UPDATE and falls through to `processExistingReview`. `suppressNotification` flag propagates into all 4 `generate_response` outbox enqueues. No-active-response branch uses `MAX(version)+1` instead of `version: 1`. `awaiting_owner_connect` parked response now superseded with `posting_error='review_content_changed_during_park'` when content changes (closes a race where `DrainOwnerConnectWorker` could re-publish a stale draft after reconnect).
- `src/lib/reviews/{types,index}.ts` — `ReviewIdentity.provider` widened to `'serpapi_poll' | 'zernio'`; `identityStrategy` adds `'zernio_id'`. Drops SerpAPI monitor barrel re-exports.
- `src/lib/shared/{queue-names,worker-types,mock-mode,index,response-status,constants}.ts` — drop `sync_reviews` queue + `SyncReviewsPayload` + `getReviewMonitor` + `'awaiting_manual_post'` constants. Add `IngestZernioReviewPayload` + `ZernioInitialBackfillPayload` payload types. Add `suppress_notification?: boolean` to `GenerateResponsePayload`.
- `src/lib/shared/schemas.ts` — `SelectPlanSchema.tier` enum widened to include `'premium'`.
- `src/lib/payments/payment-link.ts` — TIER_ENV widened to include `STRIPE_PAYMENT_LINK_PREMIUM`.

**Frontend (App Router):**
- `src/app/onboarding/pay/PlanPickerClient.tsx` — adds Premium plan card; grid widened to `md:grid-cols-3`.
- `src/app/api/zernio/connect/select-location/route.ts` — emits `zernio_initial_backfill` outbox row in same tx as activation when `needs_backfill` predicate fires.
- `src/app/api/onboarding/business/route.ts` + `src/lib/onboarding/create-business.ts` — drop `sync_reviews` enqueues.
- `src/app/admin/businesses/[id]/{page,components/ReviewsList,components/ZernioConnectionPanel}.tsx` + `src/app/admin/runbook/page.tsx` — manual-post UI/copy cleanup; runbook A5 entry rewritten for Zernio language.
- `src/components/dashboard/{ConnectGoogleBanner,ReviewsList}.tsx` — two-clause v17 reconnect banner copy; drop `awaiting_manual_post` color class.
- `src/lib/notifications/email/templates/owner-reconnect-required.ts` — two-clause v17 wording in the email body.
- `.claude/CLAUDE.md` — updated tech stack pointer (Zernio webhooks for production ingestion; SerpAPI for demo + prefill + URL→placeId fallback only), added migrations 028+029+030, updated response status enum, added 4 lab notes.
- `.env.example` — adds `STRIPE_PAYMENT_LINK_PREMIUM` + `STRIPE_PRICE_PREMIUM`.
- `.gitignore` — whitelists `docs/zernio-ingestion-test-runbook.md`.

#### Files deleted (10)

- `worker/jobs/ReviewSyncWorker.ts` + `worker/__tests__/ReviewSyncWorker.test.ts` (SerpAPI consumer)
- `worker/jobs/ReconciliationPoller.ts` + `worker/__tests__/ReconciliationPoller.test.ts` (SerpAPI scheduling)
- `src/lib/reviews/serpapi-monitor.ts` + `src/lib/reviews/mock-monitor.ts` (SerpAPI dedup engine — `SerpApiSource` itself is preserved for the demo engine)
- `src/app/admin/businesses/[id]/manual-post-section.tsx` + `src/app/admin/businesses/[id]/components/ManualPostFlow.tsx` (manual-post admin UI)
- `src/app/api/admin/businesses/[id]/mark-posted/route.ts` (manual-post API)
- `src/lib/notifications/email/templates/manual-post.ts` (manual-post email template + tests if present)

### Three new env vars

- `STRIPE_PAYMENT_LINK_PREMIUM` — required when `SELF_SERVE_SIGNUP_ENABLED=true` (worker startup assertion).
- `STRIPE_PRICE_PREMIUM` — required so the Stripe webhook maps the premium price → `subscription_tier='premium'`.
- `ZERNIO_INGEST_MAX_PAGES` — optional, default `4` (200 reviews). Caps `ZernioReviewIngestWorker.listReviews` walk.

### What's next (operational, not code)

1. Apply migrations 028 → 029 → 030 in prod Supabase (in that order; 028 must come before 029).
2. Set `STRIPE_PAYMENT_LINK_PREMIUM` + `STRIPE_PRICE_PREMIUM` in prod env (Vercel + Railway).
3. Confirm Zernio webhook URL in dashboard still points at `${WORKER_PUBLIC_URL}/ingress/zernio` (no URL change — same endpoint now also handles `review.new`/`review.updated`).
4. Run §5 staging end-to-end smoke per `docs/zernio-ingestion-test-runbook.md` (10 scenarios incl. non-premium + premium first-connect backfill, steady-state ingestion, approval → publish → 409 verify-first, auth path with redaction check, multi-location fan-out, pagination cap exhaustion, indeterminate verifier path, past_due → active billing recovery, manual-post decommission verification).
5. Flip `ZERNIO_PUBLISHING_ENABLED=true` in prod (single flag controls publishing AND ingestion — no new flag).
6. Pilot one customer end-to-end.
7. 24h watchlist: zero `unwrapped_transient` errors in publisher, `zernio_pagination_cap_exhausted` warning rate under threshold, `review_exceptions type LIKE 'zernio_%'` count near zero, no `dispatched`-stuck rows in `ingest_zernio_review` / `zernio_initial_backfill`.
8. After successful pilot + 24h soak, the `~70% of polling spend disappears` benefit lands automatically as active customers stop hitting SerpAPI for review polling. Only the demo engine consumes SerpAPI now.

## What's Left To Build

### Sprint 3: COMPLETE ✓

### Sprint 4: COMPLETE ✓

### Sprint 5A: COMPLETE ✓

### Sprint 5B: COMPLETE ✓

### Sprint 6: COMPLETE ✓

### Channels Phase 0 (multi-channel refactor): COMPLETE ✓

### Channels Phase 1 (SMS): CODE COMPLETE ✓ — flag-off in prod pending 10DLC brand/campaign registration + real-phone pilot walkthrough

### Channels Phase 2 (Telegram): CODE COMPLETE ✓ — ship gate passed in local dev; flag-off in prod pending prod bot registration + prod `setWebhook` + one-business pilot walkthrough

### Channels Phase 3 (WhatsApp): CODE COMPLETE ✓ — flag-off in prod pending Meta Business verification (2–4 week external clock) + WABA + Twilio WA sender + `repworth_approval_request_v1` template approval + 8-item ship gate on pilot

### Owner Self-Serve Signup: CODE COMPLETE ✓ — flag-off in prod pending custom SMTP via Resend + 3 email templates updated + migration 025 run + 12 runbook scenarios pass on staging

### Zernio GBP Auto-Posting Integration: CODE COMPLETE ✓ — flag-off in prod pending Zernio Accelerate + Inbox subscription + 4 prod env vars + migration 026 run + webhook URL configured in Zernio dashboard + 6-scenario local QA already passing on 2026-04-28 (`docs/zernio-test-report-2026-04-28.md`); on `feat/zernio-integration` (49 commits, 1544/1544 tests pass)

### Channels Phase 4 (owner self-service dashboard): NOT STARTED — `/dashboard/settings/channels` page. Reuses the admin onboarding verification widgets. Can slot as early as Phase 1.5 if customer demand shows up.

### Zernio Phase 3 (Zernio review webhooks → ingestion): CODE COMPLETE ✓ — flag-off in prod pending migrations 028+029+030 applied + `STRIPE_PAYMENT_LINK_PREMIUM` + `STRIPE_PRICE_PREMIUM` env vars set + 10-scenario staging smoke passes per `docs/zernio-ingestion-test-runbook.md`. Same `ZERNIO_PUBLISHING_ENABLED` flag (no new flag). On `feat/zernio-ingestion-replace-serpapi` (40 commits, 1707/1707 vitest tests pass, `tsc --noEmit` clean, 4 review rounds — Codex pass-1 + 3 self-review rounds — all addressed). SerpAPI ingestion code is GONE; `SerpApiSource` preserved for the demo engine.

Everything through Sprint 6 + Channels Phases 0–4 + Self-Serve Signup + Zernio Phase 0 (publishing) + Zernio Phase 3 (ingestion) is built and working. Open branches: `feat/owner-self-serve-signup` (Self-Serve), `feat/channels-whatsapp-phase-3` (WhatsApp), `feat/zernio-ingestion-replace-serpapi` (this sprint). Channels Phase 4 (owner channel dashboard) merged via PR #10.

### Still deferred (not yet needed):

- PostHog analytics (zero paying customers = zero analytics value)
- Load testing with k6/Artillery (10 businesses × 10 reviews/month doesn't warrant it yet)
- DB-backed integration tests (requires dedicated test database in CI)
- Voice learning activation (code is in place; activates naturally once ≥5 edited+posted responses exist per business)

### Known residual risks (shipped as-is)

Two real-but-narrow issues from the post-Sprint-6 review that were accepted rather than fixed. Full detail in `.claude/CLAUDE.md` under "Known residual risks":

- **Approval email crash-after-send race** — duplicate emails possible in a millisecond race between Resend-ack and DB-write. Partially covered by `NotificationFailoverPoller`.
- **`past_due` grace period based on mutable `updated_at`** — unrelated admin edits can reset the 7-day grace window. Low exploit risk. Planned for the next billing-focused sprint as a dedicated `subscription_status_changed_at` column.

### GBP API Integration (When Google Approves)

- OAuth flow for business onboarding
- Google Pub/Sub for real-time review notifications
- Automated response posting via GBP API (replaces manual copy-paste)
- Adaptive polling intervals
- Migrate existing customers from SerpAPI to GBP API

### GBP API Integration (When Google Approves)

- OAuth flow for business onboarding
- Google Pub/Sub for real-time review notifications
- Automated response posting via GBP API (replaces manual copy-paste)
- Adaptive polling intervals
- Migrate existing customers from SerpAPI to GBP API

### Upstash Redis VS Railway Redis (Take in consideration while deploying)

Railway lets you spin up a Redis instance as a Railway service inside the same project as your worker. When two Railway services talk to each other within the same project, the traffic stays on Railway's internal network — $0 egress.

Right now your setup look like:  
 Railway (worker) ──TLS over internet──▶ Upstash Redis (external) ↑ every byte = $0.05/GB egress With Railway's Redis addon: Railway (worker) ──internal network──▶ Railway Redis (same project) ↑ $0 egress

How to set it up

1. In your Railway project dashboard, click "+ New" → "Database" → "Redis"
2. Railway provisions a Redis instance and exposes connection variables (REDIS_URL, REDIS_PRIVATE_URL, etc.) automatically
3. Use REDIS_PRIVATE_URL (internal networking) as your REDIS_QUEUE_URL — this routes through Railway's private network, not the public internet
4. Remove (or keep as fallback) the Upstash queue Redis credentials

Cost comparison

┌───────────────────┬─────────────────────────────┬─────────────────────────────────────────┐
│ │ Upstash (current) │ Railway Redis │
├───────────────────┼─────────────────────────────┼─────────────────────────────────────────┤
│ Egress │ $0.05/GB (was $16/day) │ $0 (internal) │
├───────────────────┼─────────────────────────────┼─────────────────────────────────────────┤
│ Compute │ Free tier / pay-per-command │ ~$5-10/mo for a small instance │
├───────────────────┼─────────────────────────────┼─────────────────────────────────────────┤
│ Blocking commands │ Unreliable (serverless) │ Native Redis, BRPOPLPUSH works properly │
└───────────────────┴─────────────────────────────┴─────────────────────────────────────────┘

The blocking commands point matters a lot. Upstash is serverless Redis — it doesn't truly support BRPOPLPUSH blocking, which is likely why BullMQ was spin-polling so aggressively. A real Redis instance blocks properly, so even without  
 the drainDelay fix, it would idle quietly.

Tradeoff

Railway Redis costs a flat ~$5-10/mo for a small instance regardless of usage, vs Upstash which is pay-per-command (cheap when idle). But you already proved that "cheap when idle" doesn't apply when BullMQ is polling 35 times/sec. The  
 flat cost is far more predictable.

You'd still keep your Upstash cache Redis separate (the one used by redis-cache.ts for rate limiting/cost guards) — that one gets hit infrequently and is fine as external. It's only the BullMQ queue Redis that's chatty.

## Light/Dark mode future consideration -

Your system is in dark mode (prefers-color-scheme: dark) and the gmp-place-autocomplete element has color-scheme: light dark — so it picks dark. The rest of your app ignores system dark mode but Google's component doesn't. (Current Implementation) The fix is simple: force color-scheme: light only on the element. Let me rewrite using the new PlaceAutocompleteElement class properly with this fix

docs/operational-runbook.md is local-only now. The /admin/runbook page references these filenames as clickable links when NEXT_PUBLIC_DOCS_BASE_URL is set (pointing to GitHub blob URLs). Those links will 404 on GitHub since the files aren't there anymore. Either leave NEXT_PUBLIC_DOCS_BASE_URL unset (files render as plain <code> text — engineers read them from local clones), OR point the env var at a private wiki / Notion / Confluence where the runbook lives instead.

## Language Guardrail -

Keep sensitive words as preventive measures.

"Trusted by local businesses across the US" to "Trusted by local businesses globally"

REFUND HOSTINGER INQUIRY

## What shipped 2026-05-22 (Billing tiers + Locations UX) — `feat/billing-locations-ux`

In simple words:

### What we changed

Two things. First, the **pay/onboarding page** now shows all four real plans — Founding Member, Basic, Standard, Premium — and the prices come straight from one config file instead of being typed in by hand (so they can't drift from what Stripe actually charges). Second, the **Locations settings page** now shows up as soon as the multi-location feature flag is on, even if you only have one location — so a freshly-paid Standard/Premium owner can immediately see how to add a second location. Basic owners see that same page but with a friendly "upgrade to add locations" message instead of an Add button.

### Why it was confusing before

The old code used one yes/no check — "do you already have more than one location?" — to decide everything: whether to show the Locations tab, whether to switch the dashboard into multi-location mode, and whether you could add a location. So a brand-new multi-location customer with exactly one location got locked out of the very feature they paid for.

### The new shape — what got added, what changed

```
src/
├── app/
│   └── onboarding/pay/
│       └── plan-options.ts                 ← NEW: the single source for plan names + prices
│                                              (price read from TIER_CONFIG, not hardcoded)
│       └── PlanPickerClient.tsx            ← now renders all 4 tiers (was 3)
│
├── lib/
│   └── locations/
│       └── multi-location-mode.ts          ← now has THREE helpers instead of one:
│            • shouldUseMultiLocationSettings → "are you in multi-location MODE?" (count > 1)
│            • shouldShowLocationsSettings    → "should the Locations TAB show?" (flag only)
│            • canAddLocationForAccount       → "are you ALLOWED to add one?" (flag + active + tier)
│   └── accounts/
│       └── quota.ts                         ← billing math now reads STORED quota
│                                              (locations_included + locations_overage_price_cents)
│                                              from the account, not the live tier config
│
└── app/(authenticated)/settings/
    ├── locations/page.tsx                   ← shows on the flag alone; computes the
    │                                           Basic "locked" vs eligible "Add Location" state
    └── (page/voice/channels)                ← pass the new "locations visible" flag through;
                                                single-location Voice now links to /settings#brand-voice
```

### One thing to remember

Money math (how many locations are included, and the per-extra overage price) is read from **stored columns on the account**, frozen at the time you signed up — not from the live price table. The one exception is the **base monthly price**, which still comes from the live table because there's no stored column for it yet. That matters most for Founding Members ("rate locked for life") — see the TODO in `quota.ts` and the runbook's Known Issues.

