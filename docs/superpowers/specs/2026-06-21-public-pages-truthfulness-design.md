# Public Marketing Pages — Truthfulness Copy Correction

- **Date:** 2026-06-21
- **Status:** Approved (design) — pending implementation plan
- **Owner:** Norbert
- **Type:** Copy + display-data correction (no backend behavior changes)

## Problem

A claim-by-claim audit of the four public pages (`/`, `/features`,
`/how-it-works`, `/pricing`) against the actual system found **6 material
(false / self-contradicting)** claims and **~13 imprecise / overstated** ones.
The marketing copy promises behavior the code does not implement, and in one
case (pro-rated refunds) directly contradicts RepWorth's own legal terms.

Full evidence: `/tmp/verify-spec-findings-public-pages.md` (audit run
2026-06-21, branch `main` @ `186d8249`). Key code references inline below.

## Goal

Make every public page **true to the system as it exists today**, by correcting
copy and a few display-only data values. Add regression tests so the false
claims cannot silently return.

## Non-goals (explicitly out of scope — separate future projects)

- **14-day trial** — owner is implementing this separately; trial copy
  (`PricingContent.tsx` FAQ #1, the "14-day free trial · No credit card" badge,
  `AuthIslandClient.tsx` "Free for 14 days") is **left untouched**.
- Building any feature to match copy: quota/usage metering, Google-history voice
  import, deferred downgrades, pro-rated refunds, multi-channel notifications,
  weekly-brief topic+sentiment extraction.
- **Code follow-up (tracked, not done here):** the approval-link TTL (48h) vs.
  owner-nudge timing (3 days) ordering gap — the reminder currently fires after
  the link expires. Logged as a separate bug; this spec only makes copy honest.

## Locked decisions (from brainstorming)

1. **Copy-first** — correct copy to match today's system; no behavior changes.
2. **Drop volume entirely** — remove all per-tier review-count language;
   differentiate tiers on locations + included features (what the code gates on).
3. **Disclose opt-in auto mode** — describe owner approval as the default and
   transparently note the optional, off-by-default, safety-gated auto-approval.
4. **Available on Premium** — present multi-location & ranking as Premium
   capabilities (enabled during onboarding, consistent with their admin-gated
   reality); strip false universality ("out of the box", "over 90 days").

## Evidence anchors (why each change is required)

- Auto-post path exists: `worker/jobs/response-generation/persist.ts:136-169`
  (`approval_method='auto_policy'` → `enqueuePublishResponse`, no owner notify),
  gated by `AUTO_APPROVAL_ENABLED` (default false).
- No refund on cancel: `BillingScheduleWorker.ts:80` (`cancel_at_period_end`),
  `teardown-stripe.ts:90` (`prorate:false`); legal `src/lib/legal/content.ts:83-84`
  ("the unused portion … is not refunded" / "non-refundable").
- Voice learning: `src/lib/responses/voice-learning.ts` (`LIMIT 10`, max 5,
  owner-**edited** only, `MIN_EXAMPLES_FOR_ACTIVATION=5`; no Google import).
- Plan change immediate+prorated both ways: `src/lib/accounts/tier-change.ts:339-342`.
- No response quota: `src/lib/billing/quota.ts` (location-based only).
- Posting via provider: `worker/jobs/publisher/post-reply.ts:46`,
  `src/lib/zernio/client/transport.ts:64`.
- Nudge at 3 days: `worker/background/pollers/EngagementMonitorPoller.ts:23,55`.
- Approval link SHA-256 + 48h TTL: `src/lib/approval/create-link.ts:30,80`.
- Backfill premium-only: `worker/jobs/zernio/ZernioBackfillWorker.ts:190`.
- One mobile channel per account: DB constraint `one_mobile_per_scope`.
- Weekly brief contents: `worker/jobs/WeeklySummaryWorker.ts`,
  `WeeklySummaryScheduler.ts:47-50` (Mon ~8–9am UTC); no topic/sentiment scoring.
- Ranking flag-gated: `RANKING_TRACKING_ENABLED`; multi-location:
  `MULTI_LOCATION_ENABLED`.

## Changes by file

### `src/components/sections/how-it-works/HowItWorksContent.tsx`

| Current | Change to | Decision |
|---|---|---|
| Guarantee "Nothing posts without you … No auto-post, ever. No surprise posts." | "Nothing posts without your approval — by default" + one transparent line: optional auto-approval mode exists, off by default, posts only after safety checks. | #3 |
| FAQ "Can RepWorth post without asking me? No. Approval is a hard gate. Every reply requires your one-tap confirmation." | "By default, no — every reply waits for your one-tap approval. You can optionally turn on auto-approval (off by default, safety-gated)." | #3 |
| Step 2 sub: "We trained on your past 30 owner responses." | "RepWorth learns your voice from the replies you approve and edit — the more you use it, the more it sounds like you." | #1 (material #3) |
| Step 2 bullet "Trained on your existing owner responses" | "Learns from the replies you approve and edit" | #1 |
| FAQ "How does it learn my voice? … we import your last 30 owner responses from Google …" | Rewrite to the edit-based learning above; remove the Google-import + "30" + "updates within a day". | #1 |
| FAQ negative reviews: "… routed to you with a longer deadline." | Remove the longer-deadline clause; keep "never defensive/dismissive" (true via prompt safety + moderation). | #1 |
| Step 4 "post the reply back via the Google Business API" | "post the reply back to your Google listing" | #1 |
| HOOD node tech "Business API" | "Google" (drop direct-API naming) | #1 |
| HOOD node tech "Resend · HMAC" | "Resend · signed link" (token is SHA-256, not HMAC) | #1 |
| FAQ "… After 48 hours we send a gentle nudge." | "… the reply simply waits, and we'll send you a reminder." (drop the "48 hours" figure; keep Step 3 "expires in 48 hours" link TTL — that is accurate). | #1 |
| Step 1 bullet "Multi-location businesses handled out of the box" | "Multi-location supported (Premium)" | #4 |
| Step2 artifact cap "Draft generation · voice model v3" | "Draft generation · voice model" (drop version) | #1 |
| Step2 artifact chip "Matches you · 96%" | Remove the fake match-score chip (or relabel the row to a real attribute like "Length"). | #1 |

Keep accurate: Step 3 one-tap/no-login/48h link; webhook + ~5-min poll; dedup;
star/name/text capture; receipt in dashboard; "Google only + roadmap" FAQ.

### `src/app/(public)/pricing/PricingContent.tsx`

- **Drop volume (#2):**
  - Remove the hl feature lines: Basic "Best for up to ~50 review responses/month";
    Standard "Best for up to ~300 …"; Premium "High-volume or fair-use unlimited …".
    Replace each tier's lead hl-feature with a locations/feature-based value line.
  - Remove `MATRIX` row "Best-fit monthly review volume".
  - Re-write tier `tag` lines if they imply volume (keep audience framing:
    solo / growing / multi-location).
- **Kill metering FAQs:** remove `FAQ_ITEMS` "What counts as a 'review response'?"
  and "What happens if I go over my monthly limit?".
- **Refund (material #2):** FAQ "Is there a contract?" → "No. Monthly is
  month-to-month; annual is paid upfront for the year. Cancel anytime — access
  continues through the end of the paid period and we don't charge again. Annual
  plans aren't refunded for unused time." (matches `legal/content.ts`).
- **Plan-change timing (material #5):** FAQ "Can I change plans later?" →
  "Yes — upgrade, downgrade, or cancel anytime from settings. Plan changes apply
  immediately and are prorated."
- **Approval FAQ:** "Do I have to approve every reply?" → "By default, yes — you
  approve every reply. You can optionally enable auto-approval (off by default,
  safety-gated)." (#3)
- **Matrix ground-truth pass:**
  - Backfill row `[false,false,true,true]` → `[false,false,false,true]` (premium-only).
  - Remove the "Multiple approval notification channels" row (system caps every
    account at email + one mobile channel). Standardize channel wording to
    "Email + one mobile channel (SMS / Telegram / WhatsApp)" in tier features.
  - **Verify every remaining matrix cell** against actual `tier-config.ts` +
    feature-flag enforcement; fix any cell that claims gating the code doesn't do.
- **Annual "Save 20%":** set display annual prices to true ≥20% off — Basic
  `24 → 23`, Standard `64 → 63` (Founders 15, Premium 159 already ≥20%). These
  annual values are page-only (no Stripe/`tier-config` backing), safe to edit.
  Keeps the card foot "20% off $X/mo" literally accurate.
- **Founders "3-year price lock":** → "Locked-in founder pricing — your rate
  never goes up" (grandfather is indefinite, not 3-year). Update both the tier
  feature line and the matrix "Price lock" cell label.
- **Untouched:** trial FAQ #1, "14-day free trial" badge, monthly prices, USD note,
  Coming-soon CTAs, Founders → /book-a-demo.

### `src/components/sections/features/FeaturesContent.tsx`

| Current | Change to |
|---|---|
| Feat 03 copy "Nothing is ever posted without your explicit go-ahead." | "By default, nothing posts without your go-ahead." |
| Feat 05 bullet "Top mentions, scored by sentiment" | Remove (no topic/sentiment scoring in the email). |
| Feat 05 bullet "Week-over-week review volume & stars" | "Week-over-week review volume" (stars WoW not computed). |
| Feat 06 copy "Where you sit in local search over 90 days." | "Where you sit in local search." |
| Feat 03 step "Webhook from Google · detected in < 60 seconds" | "New review detected via webhook" |

Keep: hero metrics (already labeled "Illustrative targets, not live performance
data"); Feat 04 "learns edit by edit" + illustrative 8-week chart; competitor
"Coming soon · in private testing"; language chips; AI before/after.

### Landing — `Hero.tsx`, `Features.tsx`, `TimelineSection.tsx`

- **Hero.tsx:** float-stat "Response rate 96%" — add an illustrative qualifier
  consistent with the Features page (e.g., a small "example" caption already
  present near the demo; ensure the 96% is not read as live data). Standardize
  the latency line "Draft ready in 8 seconds" → "Draft ready in seconds".
- **Features.tsx (landing):** eyebrow "Save 15 hours every week" / Hero lead
  "save about fifteen hours a week" → frame as typical/illustrative
  ("save hours every week" or "~15 hours" with illustrative framing). The
  TickerBar already carries the "illustration, not live account data" label.
- **TimelineSection.tsx:** the 8-min / 19-hr / 143× comparison is conceptual;
  ensure it reads as illustration (add/confirm framing), no hard claim changes.
- **How-it-works hero meta cluster** (30 sec / 96% / 15 hrs, in
  `HowItWorksContent.tsx`): add the same illustrative framing.

> Latency phrase standardized to **"in seconds"** everywhere (no measured target
> exists; only a 30s LLM timeout). Weekly-brief "top mentions" is **dropped**,
> not deferred.

## Testing

**Update existing assertions that break:**
- `src/app/(public)/pricing/__tests__/PricingContent.test.tsx`
  - line 38 `'Best for up to ~50 review responses/month'` — remove/replace.
  - line 41 `'High-volume or fair-use unlimited review responses'` — remove/replace.
  - Re-verify line 28 `'Billed annually ($1908/yr) - 20% off $199/mo'` (Premium
    unchanged → still valid); add an analogous assertion for a corrected tier
    (e.g. Standard `$756/yr`).
- `HowItWorksContent.test.tsx`, `FeaturesContent.test.tsx`,
  `LandingContent.test.tsx` — adjust any assertion referencing changed copy
  (none of the captured assertions currently reference the changed strings, but
  re-run to confirm).

**New truthfulness regression tests** (one per page, server-render `.not.toContain`):
- pricing: `'refund the unused months'`, `'~50 review responses'`,
  `'~300'`, `"What counts as a"`, `'Multiple approval notification channels'`,
  `'3-year price lock'`.
- how-it-works: `'No auto-post, ever'`, `'hard gate'`, `'past 30 owner responses'`,
  `'Google Business API'`, `'voice model v3'`.
- features: `'Top mentions, scored by sentiment'`, `'over 90 days'`,
  `'Webhook from Google'`.
- landing/hero: `'Draft ready in 8 seconds'`.

## Validation

- `pnpm lint && pnpm typecheck && pnpm test` green.
- No DB/flag/analytics changes → tenant-scope / rls / analytics / static-policy
  audits not required (run static-policy anyway since UI files change).
- Manual: render all four pages; spot-check each corrected claim and the matrix.

## Risks

- **Matrix ground-truth pass** is the one place that needs care: confirm actual
  per-tier enforcement before re-asserting any cell, or the matrix swaps one set
  of false claims for another. Treat unverified cells as "verify, then state".
- Tier value-props lean harder on locations/features once volume is gone —
  acceptable; Basic vs Standard now differ on digests/analytics/channel/support.
