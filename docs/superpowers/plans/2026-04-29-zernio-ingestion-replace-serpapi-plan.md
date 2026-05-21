# Zernio Review Ingestion — Replace SerpAPI Polling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace SerpAPI polling with Zernio webhook-driven review ingestion (with first-connect tier-aware backfill, fan-out across same-account-multi-location connections, hardened publisher 409 verification, and decommissioning of the manual-post fallback).

**Architecture:** Webhooks fire `review.new` / `review.updated` → existing `worker/ingress/zernio.ts` fans out one `ingest_zernio_review` outbox row per active connection at the same Zernio account → new `ZernioReviewIngestWorker` fetches the review via `zernioClient.listReviews({ locationId })`, filters by location, reconciles externally-answered reviews, and runs `processReview`. On first Zernio connect, a `ZernioBackfillWorker` does a one-shot tier-aware backfill (gap reviews ≤25 all tiers, historical ≤50 premium only) with `suppress_notification=true`. SerpAPI ingestion is deleted. Manual-post fallback is decommissioned (migration 029). Premium tier is wired end-to-end.

**Tech Stack:** Next.js 14 App Router, TypeScript strict, Postgres.js (`sql.begin`), BullMQ 5, Zernio HTTP client, Vitest, Playwright, pnpm. Spec at `docs/superpowers/specs/2026-04-29-zernio-ingestion-replace-serpapi-design.md`.

---

## Conventions used in this plan

- **Imports:** all paths use the `@/` alias (`tsconfig.json` maps `@/*` → `src/*`; `worker/` imports `@/lib/*` per CLAUDE.md tsconfig setup).
- **Test command:** `pnpm test -- <pattern>` runs Vitest filtered by file/test name.
- **Type-check:** `pnpm tsc --noEmit` (strict mode is on).
- **Lint:** `pnpm lint`.
- **E2E:** `pnpm test:e2e` (skips gracefully without `TEST_DATABASE_POOL_URL`).
- **Migrations:** the user runs SQL migrations manually in the Supabase SQL editor (per `feedback_supabase_migrations.md`). Tasks emit the exact SQL; do NOT call `mcp__supabase__apply_migration` without explicit user instruction.
- **Apply order for migrations:** 028 BEFORE 029 (per spec §12 rollout step 1). 029's index rebuild references the migration-026 `responses_one_non_terminal_per_review` index and assumes the backfill table from 028 already exists.
- **Commit format:** Conventional Commits (`feat:`, `refactor:`, `test:`, `chore:`, `fix:`). Co-author tag required: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- **Mock mode:** `MOCK_EXTERNAL_APIS=true` short-circuits Zernio HTTP. Tasks rely on this for local-dev smoke checks.
- **Flag posture:** all changes ship behind the existing `ZERNIO_PUBLISHING_ENABLED=false` (no new flag introduced). Final cutover in Task 30 flips the flag in prod.

---

## File map

| Path | Purpose | Status |
| --- | --- | --- |
| `supabase/migrations/028_zernio_backfill_runs.sql` | One-shot per-business backfill summary table | NEW |
| `supabase/migrations/029_drop_awaiting_manual_post.sql` | Bulk-fail orphan rows + rebuild non-terminal uniqueness index w/o dead status + drop migration-024 stale dedup index | NEW |
| `src/lib/zernio/canonicalize-reply.ts` | Shared CRLF/Unicode/trim normalizer for reply-text comparison | NEW |
| `src/lib/zernio/__tests__/canonicalize-reply.test.ts` | Unit tests | NEW |
| `src/lib/zernio/parse-review-webhook.ts` | Documented `parseZernioReviewWebhook` + `ZernioReviewWebhookParseError` | NEW |
| `src/lib/zernio/__tests__/parse-review-webhook.test.ts` | Webhook payload parser tests | NEW |
| `src/lib/zernio/auth-error-fallback.ts` | `applyIngestionAuthErrorFallback` (no response_id required) | NEW |
| `src/lib/zernio/__tests__/auth-error-fallback.test.ts` | Helper tests | NEW |
| `src/lib/zernio/client.ts` | Add `locationId` param to `listReviews` / `listAllReviews` | MODIFIED |
| `src/lib/reviews/zernio-normalize.ts` | Identity construction, content-hash, location-segment extractor, `ZernioReviewNormalizationError` | NEW |
| `src/lib/reviews/__tests__/zernio-normalize.test.ts` | Normalizer tests | NEW |
| `src/lib/reviews/process-review.ts` | ON CONFLICT DO NOTHING + race-loss re-read; propagate `suppressNotification` flag | MODIFIED |
| `src/lib/reviews/types.ts` | Widen `ReviewIdentity.provider` to `'serpapi_poll' \| 'zernio'`; add `'zernio_id'` strategy | MODIFIED |
| `src/lib/reviews/index.ts` | Drop SerpAPI monitor exports; add Zernio normalizer exports | MODIFIED |
| `src/lib/shared/queue-names.ts` | Drop `'sync_reviews'`; add `'ingest_zernio_review'`, `'zernio_initial_backfill'` | MODIFIED |
| `src/lib/shared/worker-types.ts` | Add `IngestZernioReviewPayload`, `ZernioInitialBackfillPayload`; add `suppress_notification?: boolean` to `GenerateResponsePayload` | MODIFIED |
| `src/lib/shared/mock-mode.ts` | Drop `getReviewMonitor()` | MODIFIED |
| `src/lib/shared/constants.ts` | Drop `AWAITING_MANUAL_POST` | MODIFIED |
| `src/lib/shared/response-status.ts` | Drop `'awaiting_manual_post'` from helper sets/unions | MODIFIED |
| `src/lib/shared/__tests__/response-status.test.ts` | Drop manual-post assertions | MODIFIED |
| `src/lib/publishing/zernio-publisher.ts` | `lookupZernioReviewId` takes `locationId`; exact `provider_location_name` match for early-return; `applyTransientExhaustionFallback` widened to optional pinned account/location; field-match path passes `locationId` | MODIFIED |
| `worker/queues.ts` | Drop `sync_reviews` queue; add `ingest_zernio_review`, `zernio_initial_backfill` | MODIFIED |
| `worker/index.ts` | Unregister SerpAPI; register ingest + backfill workers; ingest onFailed hook; publisher onFailed hook updated for indeterminate + transient unwrap | MODIFIED |
| `worker/ingress/zernio.ts` | Replace counter with fan-out outbox enqueue using `parseZernioReviewWebhook` | MODIFIED |
| `worker/jobs/ZernioReviewIngestWorker.ts` | New worker; typed errors `ZernioIngestReviewNotFoundError`, `ZernioIngestUnparseableLocationError` | NEW |
| `worker/__tests__/ZernioReviewIngestWorker.test.ts` | Tests | NEW |
| `worker/jobs/ZernioBackfillWorker.ts` | New backfill worker; idempotent via `zernio_backfill_runs.completed_at IS NOT NULL` sentinel | NEW |
| `worker/__tests__/ZernioBackfillWorker.test.ts` | Tests | NEW |
| `worker/jobs/zernio-ingest-shared.ts` | `handleZernioIngestError` dispatcher + `reconcileExternallyAnsweredReview` helper | NEW |
| `worker/__tests__/zernio-ingest-shared.test.ts` | Dispatcher + reconcile tests (incl. mixed legacy/Zernio scenario) | NEW |
| `worker/jobs/publisher-error-handlers.ts` | `handlePublisherAuthErrorTerminal`, `handlePublisherPermanentErrorTerminal`, `PublisherTransientWithContext`, `ZernioReplyVerificationIndeterminateError` | NEW |
| `worker/__tests__/publisher-error-handlers.test.ts` | Helper unit tests + regressions | NEW |
| `worker/jobs/ResponseGeneratorWorker.ts` | Skip `send_notification` outbox enqueue when `suppress_notification=true` | MODIFIED |
| `worker/jobs/ResponsePublisherWorker.ts` | Replace 409 mark-posted with verify-first flow; refactor auth/permanent paths to shared helpers; wrap transient throws in `PublisherTransientWithContext` | MODIFIED |
| `worker/jobs/AdminExceptionWorker.ts` | `renderExceptionBody` switch; SELECT adds `re.review_id`; reviewer block gates on `review_id` not `reviewer_name` | MODIFIED |
| `worker/__tests__/AdminExceptionWorker.test.ts` | Per-type rendering tests + anonymous-reviewer regression | MODIFIED |
| `worker/jobs/PlaceIdValidationWorker.ts` | Drop `enqueueSyncReviews` helper + call site | MODIFIED |
| `worker/__tests__/PlaceIdValidationWorker.test.ts` | Update to assert NO sync_reviews enqueue | MODIFIED |
| `worker/jobs/ReviewSyncWorker.ts` | Delete | DELETED |
| `worker/__tests__/ReviewSyncWorker.test.ts` | Delete | DELETED |
| `worker/jobs/ReconciliationPoller.ts` | Delete | DELETED |
| `src/lib/reviews/serpapi-monitor.ts` | Delete | DELETED |
| `src/lib/reviews/mock-monitor.ts` | Delete | DELETED |
| `src/lib/reviews/__tests__/serpapi-monitor.test.ts` | Delete (if present) | DELETED |
| `worker/__tests__/correlation-chain.test.ts` | Rewrite part A to test `ingest_zernio_review → generate_response` | MODIFIED |
| `src/app/api/onboarding/business/route.ts` | Remove `topic='sync_reviews'` enqueue | MODIFIED |
| `src/lib/onboarding/create-business.ts` | Remove `placeIdVerified` branch's sync_reviews enqueue | MODIFIED |
| `src/app/api/zernio/connect/select-location/route.ts` | Same-tx enqueue `zernio_initial_backfill` on first activation (per `needs_backfill` predicate) | MODIFIED |
| `src/lib/shared/schemas.ts` | `SelectPlanSchema` accepts `'premium'` | MODIFIED |
| `src/app/onboarding/pay/PlanPickerClient.tsx` | Add Premium plan card; widen `Plan.tier` | MODIFIED |
| `src/lib/payments/payment-link.ts` | Add `premium: 'STRIPE_PAYMENT_LINK_PREMIUM'` | MODIFIED |
| `worker/ingress/stripe.ts` | Add `STRIPE_PRICE_PREMIUM` mapping in `priceToTier` | MODIFIED |
| `worker/startup-assert.ts` | `assertSelfServeSignupEnv` requires `STRIPE_PAYMENT_LINK_PREMIUM` | MODIFIED |
| `src/app/api/onboarding/__tests__/select-plan.test.ts` | Flip "rejects premium" test | MODIFIED |
| `.env.example` | Add `STRIPE_PAYMENT_LINK_PREMIUM` + `STRIPE_PRICE_PREMIUM` | MODIFIED |
| `src/app/admin/businesses/[id]/manual-post-section.tsx` | Delete | DELETED |
| `src/app/admin/businesses/[id]/components/ManualPostFlow.tsx` | Delete | DELETED |
| `src/app/api/admin/businesses/[id]/mark-posted/route.ts` | Delete | DELETED |
| `src/lib/notifications/email/templates/manual-post.ts` | Delete | DELETED |
| `src/lib/notifications/email/templates/__tests__/manual-post.test.ts` | Delete (if present) | DELETED |
| `src/app/admin/businesses/[id]/page.tsx` | Drop `awaitingPost` filter + `<ManualPostFlow />` render | MODIFIED |
| `src/components/dashboard/ReviewsList.tsx` | Drop `awaiting_manual_post` color class | MODIFIED |
| `src/app/admin/businesses/[id]/components/ReviewsList.tsx` | Drop `awaiting_manual_post` color class | MODIFIED |
| `src/app/admin/businesses/[id]/components/ZernioConnectionPanel.tsx` | Update copy + drop `awaiting_manual_post` references | MODIFIED |
| `src/app/admin/runbook/page.tsx` | Replace "Manual posting is normal for MVP" copy | MODIFIED |
| `src/lib/notifications/email.ts` | Drop manual-post barrel re-export | MODIFIED |
| `src/lib/notifications/email/headers.ts` | Comment cleanup | MODIFIED |
| `src/lib/notifications/email/templates/internal.ts` | Comment cleanup | MODIFIED |
| `src/lib/notifications/email/templates/shared.ts` | Comment cleanup | MODIFIED |
| `src/lib/notifications/delivery.ts` | Comment cleanup | MODIFIED |
| `src/lib/notifications/__tests__/delivery.test.ts` | Replace `'admin_manual_post'` fixture with `'admin_exception'` | MODIFIED |
| `worker/ingress/resend.ts` | Comment cleanup | MODIFIED |
| `worker/__tests__/resend-webhook-bounce.test.ts` | Drop dead test case at lines 192-197 | MODIFIED |
| `src/lib/notifications/email/templates/reconnect.ts` (or current location) | Two-clause v17 wording | MODIFIED |
| `.claude/CLAUDE.md` | Update tech stack, status enum, lab notes, migrations 028+029, rollout actions | MODIFIED |

---

## Task 0: Pre-flight audit

**Goal:** Confirm the codebase is on a clean baseline before this large multi-phase change starts.

- [ ] **Step 0.1: Confirm clean working tree on a fresh feature branch**

Run:

```bash
git status
git branch --show-current
```

Expected: working tree clean (or only the deletions of `docs/zernio-launch-runbook.md` / `docs/zernio-testing-and-shipping.md` already noted in `gitStatus`); branch is a new feature branch (NOT `main`). If on `main`, create one:

```bash
git checkout -b feat/zernio-ingestion-replace-serpapi
```

- [ ] **Step 0.2: Verify `ZERNIO_PUBLISHING_ENABLED` is OFF in prod env**

Confirm with the user that `ZERNIO_PUBLISHING_ENABLED=false` (or unset) in the prod Railway / Vercel environment. The full plan ships behind this existing flag; the Task 30 cutover flips it after migrations + manual smoke pass.

- [ ] **Step 0.3: Snapshot `pnpm test` baseline**

Run:

```bash
pnpm test
```

Expected: PASS (record the test count for later comparison). If pre-existing failures exist, document them so they can be distinguished from regressions introduced by this plan.

- [ ] **Step 0.4: Confirm migration head is 027**

Run:

```bash
ls supabase/migrations | sort | tail -5
```

Expected: highest-numbered migration is `027_*.sql`. This plan adds 028 and 029.

---

## Task 1: Migration 028 — `zernio_backfill_runs`

**Files:**
- Create: `supabase/migrations/028_zernio_backfill_runs.sql`

- [ ] **Step 1.1: Write migration SQL**

Create `supabase/migrations/028_zernio_backfill_runs.sql`:

```sql
-- supabase/migrations/028_zernio_backfill_runs.sql
--
-- Persists per-business summary of the one-shot Zernio first-connect backfill
-- so the dashboard can render reliable "X older reviews skipped" messaging
-- without dashboard-time Zernio API calls. Replaces the unreliable
-- "compare response count vs total Zernio reviews" approach.
--
-- See docs/superpowers/specs/2026-04-29-zernio-ingestion-replace-serpapi-design.md §5.

CREATE TABLE IF NOT EXISTS zernio_backfill_runs (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id              UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  zernio_account_id        TEXT NOT NULL,
  zernio_location_id       TEXT NOT NULL,
  subscription_tier        TEXT NOT NULL,                   -- snapshot at backfill time
  subscription_activated_at TIMESTAMPTZ NOT NULL,            -- snapshot at backfill time

  -- Bucket counts (what we processed)
  gap_processed_count       INTEGER NOT NULL DEFAULT 0,
  historical_processed_count INTEGER NOT NULL DEFAULT 0,

  -- Cap-skip counts (what we did NOT process due to tier/cap limits)
  gap_skipped_count         INTEGER NOT NULL DEFAULT 0,    -- gap reviews beyond cap=25
  historical_skipped_count  INTEGER NOT NULL DEFAULT 0,    -- premium-only; non-premium = total historical
  oldest_skipped_create_time TIMESTAMPTZ,                  -- for "older than [date]" copy

  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One backfill run per business (the predicate guard in the connect callback
-- ensures it fires only on first activation; this index is defense-in-depth).
CREATE UNIQUE INDEX IF NOT EXISTS zernio_backfill_runs_one_per_business
  ON zernio_backfill_runs (business_id);

ALTER TABLE zernio_backfill_runs ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE zernio_backfill_runs IS
  'Per-business summary of Zernio first-connect backfill. Dashboard reads '
  'skipped counts to render "X older reviews skipped" messaging. Tier and '
  'subscription_activated_at are snapshotted to make the row self-contained.';
```

- [ ] **Step 1.2: Tell the user to run the migration**

Output to the user:

> "Migration 028 SQL ready at `supabase/migrations/028_zernio_backfill_runs.sql`. Please run it in the Supabase SQL editor (dev), then confirm here so I can proceed. Verify with `\d+ zernio_backfill_runs` that the partial unique index `zernio_backfill_runs_one_per_business` is present."

Do NOT call `mcp__supabase__apply_migration`.

- [ ] **Step 1.3: Wait for user confirmation, then commit**

```bash
git add supabase/migrations/028_zernio_backfill_runs.sql
git commit -m "$(cat <<'EOF'
feat(zernio): migration 028 — zernio_backfill_runs table

Per-business summary of the one-shot first-connect backfill (gap/historical
processed + skipped counts, oldest-skipped createTime). Dashboard reads
this to render "X older reviews skipped" copy without runtime Zernio API
calls. Tier + subscription_activated_at are snapshotted so the row is
self-contained. Unique-per-business partial index is defense-in-depth.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Outbox payload types + queue names

**Files:**
- Modify: `src/lib/shared/worker-types.ts`
- Modify: `src/lib/shared/queue-names.ts`
- Modify: `worker/queues.ts`

- [ ] **Step 2.1: Add new payload types**

In `src/lib/shared/worker-types.ts`, add these exports (preserve existing exports verbatim):

```ts
// Added by Zernio ingestion plan (spec §6.13).
//
// IngestZernioReviewPayload — emitted by the Zernio webhook handler (one row
// per active connection at the firing account). Fanned out across same-account
// multi-location connections; the worker filters by location after fetching
// the review.
export interface IngestZernioReviewPayload {
  outbox_id?: string;          // populated by OutboxPoller dispatcher
  attempt?: number;            // populated by OutboxPoller dispatcher
  business_id: string;
  zernio_account_id: string;
  zernio_location_id: string;
  zernio_review_id: string;    // BARE id (not resource path); matches ZernioReview.id
  correlation_id?: string;
}

// ZernioInitialBackfillPayload — emitted by the connect-callback when the
// `needs_backfill` predicate is satisfied. One-shot per business.
export interface ZernioInitialBackfillPayload {
  outbox_id?: string;
  attempt?: number;
  business_id: string;
  zernio_account_id: string;
  zernio_location_id: string;
  subscription_tier: string;            // 'founding' | 'standard' | 'premium' (string for forward-compat)
  subscription_activated_at: string;    // ISO timestamp from businesses.subscription_activated_at
  correlation_id?: string;
}
```

ALSO update the existing `GenerateResponsePayload` interface — add the optional `suppress_notification` field:

```ts
export interface GenerateResponsePayload {
  outbox_id?: string;
  attempt?: number;
  review_id: string;
  business_id: string;
  version: number;
  correlation_id?: string;
  // Added by Zernio ingestion plan (spec §4.6, §6.6, §6.7).
  // When true, the ResponseGeneratorWorker skips the send_notification
  // outbox enqueue. Used by ZernioBackfillWorker so the first-connect
  // backfill of up to 75 reviews does NOT blast 75 approval emails.
  suppress_notification?: boolean;
}
```

- [ ] **Step 2.2: Update queue-names**

In `src/lib/shared/queue-names.ts`:
- Remove the `'sync_reviews'` queue name constant + any associated typing.
- Add `'ingest_zernio_review'` and `'zernio_initial_backfill'`.

```ts
// Outbox topics + BullMQ queue names. Kept as a single source of truth so
// the OutboxPoller dispatcher and worker registrations cannot drift.
export const QUEUE_NAMES = {
  GENERATE_RESPONSE: 'generate_response',
  SEND_NOTIFICATION: 'send_notification',
  PUBLISH_RESPONSE: 'publish_response',
  VALIDATE_PLACE_ID: 'validate_place_id',
  DEMO_GENERATION: 'demo_generation',
  WEEKLY_SUMMARY: 'weekly_summary',
  MONTHLY_IMPACT: 'monthly_impact',
  ENGAGEMENT_ALERT: 'engagement_alert',
  ONBOARDING_DRIP: 'onboarding_drip',
  RANKING_TRACKING: 'ranking_tracking',
  NOTIFY_OWNER_RECONNECT: 'notify_owner_reconnect',
  NOTIFY_OWNER_CONNECTION_LOST: 'notify_owner_connection_lost',
  DRAIN_OWNER_CONNECT: 'drain_owner_connect',
  NOTIFY_ADMIN_REVIEW_EXCEPTION: 'notify_admin_review_exception',
  // Added by Zernio ingestion plan.
  INGEST_ZERNIO_REVIEW: 'ingest_zernio_review',
  ZERNIO_INITIAL_BACKFILL: 'zernio_initial_backfill',
} as const;

export type QueueName = typeof QUEUE_NAMES[keyof typeof QUEUE_NAMES];
```

If the existing file has a different shape (e.g. flat exported strings), preserve that shape — just delete the `SYNC_REVIEWS` line and add the two new ones.

- [ ] **Step 2.3: Update worker queue definitions**

In `worker/queues.ts`:
- Remove the `syncReviewsQueue` (or whatever it's currently named) export and its BullMQ Queue construction.
- Add two new queues:

```ts
import { Queue } from 'bullmq';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import { redisConnection } from './redis';

// ... existing queues retained ...

export const ingestZernioReviewQueue = new Queue(
  QUEUE_NAMES.INGEST_ZERNIO_REVIEW,
  { connection: redisConnection },
);

export const zernioInitialBackfillQueue = new Queue(
  QUEUE_NAMES.ZERNIO_INITIAL_BACKFILL,
  { connection: redisConnection },
);
```

- [ ] **Step 2.4: Type-check**

Run: `pnpm tsc --noEmit`

Expected: PASS for these three files (some downstream files referencing `sync_reviews` will fail; those are fixed in later tasks — that's acceptable for now as long as ONLY the SerpAPI-specific consumers fail).

If unrelated TypeScript errors appear, fix them before proceeding.

- [ ] **Step 2.5: Commit**

```bash
git add src/lib/shared/worker-types.ts src/lib/shared/queue-names.ts worker/queues.ts
git commit -m "$(cat <<'EOF'
feat(zernio): outbox payload types + queue names for ingest + backfill

Adds IngestZernioReviewPayload and ZernioInitialBackfillPayload. Adds
suppress_notification?: boolean to GenerateResponsePayload (used by
backfill to avoid a 75-email blast on first connect). Drops the
sync_reviews queue/topic and registers ingest_zernio_review +
zernio_initial_backfill queues.

Downstream sync_reviews consumers (ReviewSyncWorker, ReconciliationPoller)
are deleted in a later commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Widen `ReviewIdentity` for Zernio provider

**Files:**
- Modify: `src/lib/reviews/types.ts`

- [ ] **Step 3.1: Widen `ReviewIdentity`**

Locate the `ReviewIdentity` interface in `src/lib/reviews/types.ts`. Update:
- `provider`: from `'serpapi_poll'` to `'serpapi_poll' | 'zernio'`.
- `identityStrategy`: add `'zernio_id'` to the union.

Keep all existing fields verbatim. Example shape after edit:

```ts
export interface ReviewIdentity {
  provider: 'serpapi_poll' | 'zernio';
  providerReviewId: string;
  providerReviewName: string;
  providerLocationName: string;
  identityStrategy: 'serpapi_hash' | 'serpapi_id' | 'zernio_id';
  // ... any existing fields preserved verbatim
}
```

If the existing union for `identityStrategy` differs, simply add `'zernio_id'` to it.

- [ ] **Step 3.2: Type-check**

Run: `pnpm tsc --noEmit`

Expected: PASS or unchanged failure set from Task 2 (no NEW errors introduced).

- [ ] **Step 3.3: Commit**

```bash
git add src/lib/reviews/types.ts
git commit -m "$(cat <<'EOF'
feat(reviews): widen ReviewIdentity to include 'zernio' provider

Adds 'zernio' to ReviewIdentity.provider and 'zernio_id' to
identityStrategy. process-review.ts unique constraint on
(provider, provider_review_name) handles dedup; Zernio review.id is
canonical and stable across reviewer edits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `canonicalizeReplyText` shared helper

**Files:**
- Create: `src/lib/zernio/canonicalize-reply.ts`
- Create: `src/lib/zernio/__tests__/canonicalize-reply.test.ts`

- [ ] **Step 4.1: Write failing tests**

Create `src/lib/zernio/__tests__/canonicalize-reply.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { canonicalizeReplyText } from '../canonicalize-reply';

describe('canonicalizeReplyText', () => {
  it('returns identical text unchanged', () => {
    expect(canonicalizeReplyText('hello')).toBe('hello');
  });

  it('normalizes CRLF → LF', () => {
    expect(canonicalizeReplyText('hello\r\nworld')).toBe('hello\nworld');
  });

  it('normalizes lone CR → LF', () => {
    expect(canonicalizeReplyText('hello\rworld')).toBe('hello\nworld');
  });

  it('normalizes Unicode NFC (decomposed → precomposed)', () => {
    // 'café' with combining acute (NFD) vs precomposed é (NFC).
    const decomposed = 'café';
    const precomposed = 'café';
    expect(canonicalizeReplyText(decomposed)).toBe(canonicalizeReplyText(precomposed));
  });

  it('trims outer whitespace', () => {
    expect(canonicalizeReplyText('  hello  ')).toBe('hello');
  });

  it('preserves internal whitespace (different meaning)', () => {
    expect(canonicalizeReplyText('a  b')).not.toBe(canonicalizeReplyText('a b'));
  });

  it('returns "" for null', () => {
    expect(canonicalizeReplyText(null)).toBe('');
  });

  it('returns "" for undefined', () => {
    expect(canonicalizeReplyText(undefined)).toBe('');
  });
});
```

- [ ] **Step 4.2: Run test to verify it fails**

Run: `pnpm test -- src/lib/zernio/__tests__/canonicalize-reply.test.ts`

Expected: FAIL with "Cannot find module '../canonicalize-reply'".

- [ ] **Step 4.3: Write the implementation**

Create `src/lib/zernio/canonicalize-reply.ts`:

```ts
// src/lib/zernio/canonicalize-reply.ts
//
// Used by BOTH the publisher 409 verifier (spec §6.10b) AND the ingest
// reconcile helper (spec §6.3b) to compare reply text robustly. A round-trip
// through Zernio + Google can introduce CRLF↔LF and Unicode NFC↔NFD differences
// that .trim() alone misses, causing false text-mismatch supersessions.
//
// Conservative normalization only:
//   - trim outer whitespace
//   - collapse \r\n and lone \r → \n
//   - Unicode-normalize to NFC
// Does NOT collapse internal whitespace (would change meaning).

export function canonicalizeReplyText(text: string | null | undefined): string {
  if (text == null) return '';
  return text
    .replace(/\r\n?/g, '\n')   // CRLF / CR → LF
    .normalize('NFC')           // canonical-composition Unicode normalization
    .trim();
}
```

- [ ] **Step 4.4: Run test to verify it passes**

Run: `pnpm test -- src/lib/zernio/__tests__/canonicalize-reply.test.ts`

Expected: all 8 tests PASS.

- [ ] **Step 4.5: Type-check + lint**

Run: `pnpm tsc --noEmit && pnpm lint`

Expected: both PASS for these files.

- [ ] **Step 4.6: Commit**

```bash
git add src/lib/zernio/canonicalize-reply.ts src/lib/zernio/__tests__/canonicalize-reply.test.ts
git commit -m "$(cat <<'EOF'
feat(zernio): canonicalizeReplyText shared helper

CRLF→LF + Unicode NFC + outer-trim normalization for reply-text
comparison. Used by the publisher 409 verifier (§6.10b) and the
ingest reconcile helper (§6.3b). Internal whitespace preserved
deliberately (changing it would alter meaning).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `parseZernioReviewWebhook` documented parser

**Files:**
- Create: `src/lib/zernio/parse-review-webhook.ts`
- Create: `src/lib/zernio/__tests__/parse-review-webhook.test.ts`

- [ ] **Step 5.1: Write the failing tests**

Create `src/lib/zernio/__tests__/parse-review-webhook.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  parseZernioReviewWebhook,
  ZernioReviewWebhookParseError,
} from '../parse-review-webhook';

const buildBody = (overrides: Record<string, unknown> = {}) => ({
  event: 'review.new',
  id: 'evt_abc',
  account: { id: 'zernio-acct-A' },
  review: { id: 'AbFv0LXyz123' },
  ...overrides,
});

describe('parseZernioReviewWebhook', () => {
  it('extracts nested account.id', () => {
    const r = parseZernioReviewWebhook(buildBody());
    expect(r.accountId).toBe('zernio-acct-A');
  });

  it('extracts bare review.id', () => {
    const r = parseZernioReviewWebhook(buildBody());
    expect(r.reviewId).toBe('AbFv0LXyz123');
    expect(r.locationIdFromPayload).toBeNull();
    expect(r.fullReviewName).toBeNull();
  });

  it('extracts bare review id from resource-name review.id', () => {
    const r = parseZernioReviewWebhook(buildBody({
      review: { id: 'accounts/108472/locations/9876/reviews/AbFv0LXyz123' },
    }));
    expect(r.reviewId).toBe('AbFv0LXyz123');
    expect(r.locationIdFromPayload).toBe('9876');
    expect(r.fullReviewName).toBe('accounts/108472/locations/9876/reviews/AbFv0LXyz123');
  });

  it('extracts bare review id from resource-name review.name when review.id absent', () => {
    const r = parseZernioReviewWebhook(buildBody({
      review: { name: 'accounts/108472/locations/9876/reviews/AbFv0LXyz123' },
    }));
    expect(r.reviewId).toBe('AbFv0LXyz123');
    expect(r.locationIdFromPayload).toBe('9876');
  });

  it('accepts agreement between review.id and review.name', () => {
    const r = parseZernioReviewWebhook(buildBody({
      review: {
        id: 'AbFv0LXyz123',
        name: 'accounts/108472/locations/9876/reviews/AbFv0LXyz123',
      },
    }));
    expect(r.reviewId).toBe('AbFv0LXyz123');
    expect(r.locationIdFromPayload).toBe('9876');
  });

  it('throws on disagreement between review.id and review.name bare ids', () => {
    expect(() => parseZernioReviewWebhook(buildBody({
      review: {
        id: 'AbFv0LXyz123',
        name: 'accounts/108472/locations/9876/reviews/Different',
      },
    }))).toThrow(ZernioReviewWebhookParseError);
  });

  it('throws on disagreement between location segments', () => {
    expect(() => parseZernioReviewWebhook(buildBody({
      review: {
        id: 'accounts/X/locations/A/reviews/AbFv0LXyz123',
        name: 'accounts/X/locations/B/reviews/AbFv0LXyz123',
      },
    }))).toThrow(ZernioReviewWebhookParseError);
  });

  it('throws when account is missing', () => {
    expect(() => parseZernioReviewWebhook({ review: { id: 'r' } }))
      .toThrow(ZernioReviewWebhookParseError);
  });

  it('throws when account.id is empty string', () => {
    expect(() => parseZernioReviewWebhook({ account: { id: '' }, review: { id: 'r' } }))
      .toThrow(ZernioReviewWebhookParseError);
  });

  it('throws when review is missing', () => {
    expect(() => parseZernioReviewWebhook({ account: { id: 'A' } }))
      .toThrow(ZernioReviewWebhookParseError);
  });

  it('throws when slash-containing review.id has malformed shape', () => {
    expect(() => parseZernioReviewWebhook(buildBody({
      review: { id: 'foo/bar/baz' },
    }))).toThrow(ZernioReviewWebhookParseError);
  });

  it('does NOT cross-check top-level account.id against accounts/{...} resource-path segment (different ID spaces)', () => {
    // Round-4 regression: top-level account.id='zernio-acct-A' is Zernio's
    // account ID. The accounts/{...} segment in review.name is Google's
    // account ID — different ID space. Parser must NOT reject on mismatch.
    const r = parseZernioReviewWebhook(buildBody({
      account: { id: 'zernio-acct-A' },
      review: { name: 'accounts/google-acct-B/locations/9876/reviews/AbFv0LXyz123' },
    }));
    expect(r.accountId).toBe('zernio-acct-A');
    expect(r.reviewId).toBe('AbFv0LXyz123');
    expect(r.locationIdFromPayload).toBe('9876');
  });

  it('throws on null/undefined body', () => {
    expect(() => parseZernioReviewWebhook(null)).toThrow(ZernioReviewWebhookParseError);
    expect(() => parseZernioReviewWebhook(undefined)).toThrow(ZernioReviewWebhookParseError);
  });
});
```

- [ ] **Step 5.2: Run test to verify it fails**

Run: `pnpm test -- src/lib/zernio/__tests__/parse-review-webhook.test.ts`

Expected: FAIL with "Cannot find module '../parse-review-webhook'".

- [ ] **Step 5.3: Write the implementation**

Create `src/lib/zernio/parse-review-webhook.ts`. Use the implementation from spec §6.6b verbatim. Reproduced for the engineer:

```ts
// src/lib/zernio/parse-review-webhook.ts
//
// Zernio review webhook payload shape (per Zernio docs as of 2026-04-29 — verify
// against current Zernio webhook spec during implementation):
//
//   {
//     event: 'review.new' | 'review.updated',
//     id: string,                              // event id (also in x-zernio-event-id)
//     account: { id: string },                 // Zernio account id (NOT Google's)
//     review: {
//       id: string,                            // Zernio review id (canonical)
//       name?: string,                         // 'accounts/{a}/locations/{l}/reviews/{r}'
//     },
//   }

export interface ParsedReviewWebhook {
  /** Top-level Zernio account.id from the webhook envelope. Used for the
   *  zernio_connections lookup and Zernio API calls. NOTE: this is distinct
   *  from the {accountResource} segment in any review resource-name path —
   *  the resource path segment is Google's account ID, a different ID space.
   *  Do NOT cross-check the two. */
  accountId: string;
  /** BARE review id (last path segment, never a slash-separated resource form).
   *  Compared directly to ZernioReview.id from listReviews. */
  reviewId: string;
  /** Location id extracted from a review resource-name path, if present.
   *  Optional — the ingest worker doesn't depend on this for routing
   *  (it fans out per active connection and filters by listReviews output),
   *  but logging it aids debugging multi-location fan-out. */
  locationIdFromPayload: string | null;
  /** Full resource-name form when supplied, retained for logging only. */
  fullReviewName: string | null;
}

export class ZernioReviewWebhookParseError extends Error {
  constructor(reason: string, readonly raw: unknown) {
    super(`[parse-review-webhook] ${reason}`);
    this.name = 'ZernioReviewWebhookParseError';
  }
}

// Resource-name shape per Google Business Profile API convention:
//   accounts/{accountResource}/locations/{locationResource}/reviews/{reviewResource}
// CRITICAL: the {accountResource} segment in this path is the Google Business
// account identifier — it is NOT the same ID space as the top-level Zernio
// `account.id` in the webhook envelope. Do NOT cross-check them.
const REVIEW_NAME_RE = /^accounts\/([^/]+)\/locations\/([^/]+)\/reviews\/([^/]+)$/;

function extractBareReviewId(value: string): { bareReviewId: string; locationFromPath: string | null } {
  const trimmed = value.trim();
  if (!trimmed) return { bareReviewId: '', locationFromPath: null };

  if (trimmed.includes('/')) {
    const m = trimmed.match(REVIEW_NAME_RE);
    if (m) {
      const [, , locationSegment, reviewSegment] = m;
      return { bareReviewId: reviewSegment, locationFromPath: locationSegment };
    }
    return { bareReviewId: '', locationFromPath: null };
  }

  return { bareReviewId: trimmed, locationFromPath: null };
}

export function parseZernioReviewWebhook(body: unknown): ParsedReviewWebhook {
  if (!body || typeof body !== 'object') {
    throw new ZernioReviewWebhookParseError('body is not an object', body);
  }
  const b = body as Record<string, unknown>;

  const account = b.account;
  if (!account || typeof account !== 'object') {
    throw new ZernioReviewWebhookParseError('missing account object', body);
  }
  const accountId = (account as Record<string, unknown>).id;
  if (typeof accountId !== 'string' || accountId.trim().length === 0) {
    throw new ZernioReviewWebhookParseError('account.id missing or empty', body);
  }

  const review = b.review;
  if (!review || typeof review !== 'object') {
    throw new ZernioReviewWebhookParseError('missing review object', body);
  }
  const r = review as Record<string, unknown>;

  let bareReviewId: string | null = null;
  let locationIdFromPayload: string | null = null;
  let fullReviewName: string | null = null;

  if (typeof r.id === 'string' && r.id.trim().length > 0) {
    const ext = extractBareReviewId(r.id);
    if (ext.bareReviewId) bareReviewId = ext.bareReviewId;
    if (ext.locationFromPath) locationIdFromPayload = ext.locationFromPath;
    if (r.id.includes('/')) fullReviewName = r.id.trim();
  }

  if (typeof r.name === 'string' && r.name.trim().length > 0) {
    const ext = extractBareReviewId(r.name);
    if (ext.bareReviewId) {
      if (bareReviewId && bareReviewId !== ext.bareReviewId) {
        throw new ZernioReviewWebhookParseError(
          `review.id and review.name yield different bare ids: ${bareReviewId} vs ${ext.bareReviewId}`, body,
        );
      }
      bareReviewId = ext.bareReviewId;
    }
    if (ext.locationFromPath) {
      if (locationIdFromPayload && locationIdFromPayload !== ext.locationFromPath) {
        throw new ZernioReviewWebhookParseError(
          `review.id and review.name yield different location segments: ${locationIdFromPayload} vs ${ext.locationFromPath}`, body,
        );
      }
      locationIdFromPayload = ext.locationFromPath;
    }
    fullReviewName = r.name.trim();
  }

  if (!bareReviewId) {
    throw new ZernioReviewWebhookParseError('could not extract bare review id from review.id or review.name', body);
  }

  return { accountId: accountId.trim(), reviewId: bareReviewId, locationIdFromPayload, fullReviewName };
}
```

- [ ] **Step 5.4: Run test to verify it passes**

Run: `pnpm test -- src/lib/zernio/__tests__/parse-review-webhook.test.ts`

Expected: all 13 tests PASS.

- [ ] **Step 5.5: Type-check + lint**

Run: `pnpm tsc --noEmit && pnpm lint`

Expected: PASS for these files.

- [ ] **Step 5.6: Commit**

```bash
git add src/lib/zernio/parse-review-webhook.ts src/lib/zernio/__tests__/parse-review-webhook.test.ts
git commit -m "$(cat <<'EOF'
feat(zernio): documented parseZernioReviewWebhook + tests

Replaces inline (body as ...) type-casting in worker/ingress/zernio.ts
with explicit parser + ZernioReviewWebhookParseError. Accepts both bare
review.id and resource-name forms (in either review.id or review.name);
extracts the bare id; verifies agreement when both present. Does NOT
cross-check top-level account.id against the accounts/{...} resource-path
segment (different ID spaces — Zernio acct vs Google Business acct).

Round-4 regression test pinned in to lock in the no-cross-check behavior.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `zernioClient.listReviews` / `listAllReviews` accept `locationId`

**Files:**
- Modify: `src/lib/zernio/client.ts`

- [ ] **Step 6.1: Update `listReviews` + `listAllReviews` signatures**

Locate the two methods around `src/lib/zernio/client.ts:249-276`. Update them per spec §6.0:

```ts
listReviews: (
  accountId: string,
  input: { locationId: string; pageSize?: number; pageToken?: string },
) =>
  request<{ reviews: ZernioReview[]; nextPageToken?: string }>({
    method: 'GET',
    path: `/v1/accounts/${encodeURIComponent(accountId)}/gmb-reviews?locationId=${encodeURIComponent(input.locationId)}&pageSize=${input.pageSize ?? 50}${input.pageToken ? `&pageToken=${encodeURIComponent(input.pageToken)}` : ''}`,
    endpointKind: 'list_reviews',
    timeoutMs: 15_000,
  }),

listAllReviews: async (
  accountId: string,
  opts: { locationId: string; pageSize: number; maxPages: number },
): Promise<ZernioReview[]> => {
  const all: ZernioReview[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < opts.maxPages; i++) {
    const page = await zernioClient.listReviews(accountId, {
      locationId: opts.locationId,
      pageSize: opts.pageSize,
      pageToken,
    });
    all.push(...page.reviews);
    if (!page.nextPageToken) break;
    pageToken = page.nextPageToken;
  }
  return all;
},
```

> **VERIFY before merging.** The exact query-param name is `locationId` per Zernio's Get Reviews docs as of 2026-04-29. Open the current Zernio API docs and confirm the param name matches. If Zernio uses `location_id` or `location` instead, adjust the URL string. If Zernio doesn't expose location filtering on this endpoint, fall back to client-side filtering using `extractLocationFromReviewName` (introduced in Task 7); the cost is one extra page-fetch in the multi-location case.

- [ ] **Step 6.2: Update existing field-match caller in zernio-publisher.ts**

In `src/lib/publishing/zernio-publisher.ts` around lines 63-66, the existing `listAllReviews` call must now pass `locationId`. The publisher caller already loads `zernioConnection.zernio_location_id`. Update:

```ts
// Before:
//   const reviews = await zernioClient.listAllReviews(accountId, {
//     pageSize: 50, maxPages: 4,
//   });

// After:
const reviews = await zernioClient.listAllReviews(accountId, {
  locationId: zernioConnection.zernio_location_id,
  pageSize: 50,
  maxPages: 4,
});
```

The exact callsite is in the legacy field-match path used for `provider='serpapi_poll'` rows. Pass `locationId` from the connection scope already in context.

- [ ] **Step 6.3: Mock-mode behavior unchanged**

Verify `src/lib/zernio/client.ts:199-201` still returns `{ reviews: [], nextPageToken: undefined }` for `list_reviews`. The new `locationId` param is ignored in mock mode — no change required there.

- [ ] **Step 6.4: Type-check**

Run: `pnpm tsc --noEmit`

Expected: PASS for `client.ts` and `zernio-publisher.ts`. Other files referencing the old signature will show errors; those callsites are introduced/updated in later tasks.

- [ ] **Step 6.5: Commit**

```bash
git add src/lib/zernio/client.ts src/lib/publishing/zernio-publisher.ts
git commit -m "$(cat <<'EOF'
feat(zernio): listReviews + listAllReviews require locationId

Server-side scoping per spec §6.0. Without this, same-account-multi-
location fan-out would return reviews for the account's default
location, not the connection's location, causing every cross-location
webhook to escalate to review_exceptions.

zernio-publisher's legacy field-match callsite passes
zernioConnection.zernio_location_id from existing scope.

VERIFY query-param name matches current Zernio Get Reviews docs before
flag flip.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: `zernio-normalize.ts` (NEW)

**Files:**
- Create: `src/lib/reviews/zernio-normalize.ts`
- Create: `src/lib/reviews/__tests__/zernio-normalize.test.ts`

- [ ] **Step 7.1: Write the failing tests**

Create `src/lib/reviews/__tests__/zernio-normalize.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  zernioReviewToNormalized,
  buildZernioMonitoredReview,
  extractLocationFromReviewName,
  ZernioReviewNormalizationError,
} from '../zernio-normalize';
import type { ZernioReview } from '@/lib/zernio/types';

const baseReview: ZernioReview = {
  id: 'rev_abc',
  name: 'accounts/A/locations/L/reviews/rev_abc',
  rating: 4,
  comment: 'Great place',
  createTime: '2026-04-15T10:00:00Z',
  updateTime: '2026-04-15T10:00:00Z',
  reviewer: { displayName: 'Alice', profilePhotoUrl: '' },
  reviewReply: null,
};

describe('zernioReviewToNormalized', () => {
  it('builds a NormalizedReview from a happy-path Zernio review', () => {
    const out = zernioReviewToNormalized(baseReview);
    expect(out.reviewerName).toBe('Alice');
    expect(out.starRating).toBe(4);
    expect(out.reviewText).toBe('Great place');
    expect(out.reviewDate).toBe('2026-04-15T10:00:00Z');
  });

  it('falls back to "Anonymous" when displayName is empty/whitespace', () => {
    const out = zernioReviewToNormalized({
      ...baseReview,
      reviewer: { displayName: '   ', profilePhotoUrl: '' },
    });
    expect(out.reviewerName).toBe('Anonymous');
  });

  it('returns reviewText=null when comment is empty/whitespace', () => {
    const out = zernioReviewToNormalized({ ...baseReview, comment: '   ' });
    expect(out.reviewText).toBeNull();
  });

  it('throws on missing review.id', () => {
    expect(() => zernioReviewToNormalized({ ...baseReview, id: '' as string }))
      .toThrow(ZernioReviewNormalizationError);
  });

  it('throws on out-of-range rating', () => {
    expect(() => zernioReviewToNormalized({ ...baseReview, rating: 0 as number }))
      .toThrow(ZernioReviewNormalizationError);
    expect(() => zernioReviewToNormalized({ ...baseReview, rating: 6 as number }))
      .toThrow(ZernioReviewNormalizationError);
  });

  it('throws on unparseable createTime', () => {
    expect(() => zernioReviewToNormalized({ ...baseReview, createTime: 'not-a-date' }))
      .toThrow(ZernioReviewNormalizationError);
  });
});

describe('buildZernioMonitoredReview', () => {
  it('constructs identity with location-scoped resource names', () => {
    const out = buildZernioMonitoredReview(baseReview, 'acct-X', 'loc-Y');
    expect(out.identity.provider).toBe('zernio');
    expect(out.identity.providerReviewId).toBe('rev_abc');
    expect(out.identity.providerReviewName).toBe('zernio://acct-X/locations/loc-Y/reviews/rev_abc');
    expect(out.identity.providerLocationName).toBe('zernio://acct-X/locations/loc-Y');
    expect(out.identity.identityStrategy).toBe('zernio_id');
    expect(out.contentHash).toEqual(expect.any(String));
    expect(out.contentHash).toHaveLength(64);  // SHA-256 hex
  });

  it('produces deterministic contentHash for same review', () => {
    const a = buildZernioMonitoredReview(baseReview, 'A', 'L');
    const b = buildZernioMonitoredReview(baseReview, 'A', 'L');
    expect(a.contentHash).toBe(b.contentHash);
  });

  it('produces different contentHash when star rating changes', () => {
    const a = buildZernioMonitoredReview(baseReview, 'A', 'L');
    const b = buildZernioMonitoredReview({ ...baseReview, rating: 5 }, 'A', 'L');
    expect(a.contentHash).not.toBe(b.contentHash);
  });
});

describe('extractLocationFromReviewName', () => {
  it('extracts location from a canonical review.name', () => {
    expect(extractLocationFromReviewName('accounts/A/locations/L/reviews/R')).toBe('L');
  });

  it('returns null on malformed name', () => {
    expect(extractLocationFromReviewName('accounts/A/locations/L')).toBeNull();
    expect(extractLocationFromReviewName('foo/bar/baz')).toBeNull();
    expect(extractLocationFromReviewName('')).toBeNull();
  });
});
```

- [ ] **Step 7.2: Run test to verify it fails**

Run: `pnpm test -- src/lib/reviews/__tests__/zernio-normalize.test.ts`

Expected: FAIL with "Cannot find module '../zernio-normalize'".

- [ ] **Step 7.3: Write the implementation**

Create `src/lib/reviews/zernio-normalize.ts`:

```ts
// src/lib/reviews/zernio-normalize.ts
//
// Normalizes Zernio review payloads into the project's MonitoredReview /
// NormalizedReview shape. Mirrors the per-review isolation pattern from
// serpapi-monitor.ts so a single malformed review can't abort a batch.
//
// Identity:
//   provider              = 'zernio'
//   provider_review_id    = ZernioReview.id (stable across reviewer edits)
//   provider_review_name  = 'zernio://{accountId}/locations/{locationId}/reviews/{reviewId}'
//   provider_location_name = 'zernio://{accountId}/locations/{locationId}'
//   identityStrategy      = 'zernio_id'
//
// See spec §6.2.

import { detectLanguage } from './detect-language';
import { computeContentHash } from './types';
import type { MonitoredReview, NormalizedReview } from './types';
import type { ZernioReview } from '@/lib/zernio/types';

const LOG_PREFIX = '[zernio-normalize]';

export class ZernioReviewNormalizationError extends Error {
  constructor(reason: string, readonly raw: unknown) {
    super(`${LOG_PREFIX} ${reason}`);
    this.name = 'ZernioReviewNormalizationError';
  }
}

export function zernioReviewToNormalized(z: ZernioReview): NormalizedReview {
  if (!z.id || typeof z.id !== 'string' || z.id.trim().length === 0) {
    throw new ZernioReviewNormalizationError('missing review.id', z);
  }
  if (typeof z.rating !== 'number' || z.rating < 1 || z.rating > 5) {
    throw new ZernioReviewNormalizationError(`invalid rating: ${z.rating}`, z);
  }
  if (!z.createTime || isNaN(new Date(z.createTime).getTime())) {
    throw new ZernioReviewNormalizationError(`unparseable createTime: ${z.createTime}`, z);
  }

  const reviewerName = (z.reviewer?.displayName ?? '').trim() || 'Anonymous';
  const reviewText = (z.comment ?? '').trim() || null;

  const review: NormalizedReview = {
    reviewerName,
    starRating: z.rating,
    reviewText,
    reviewDate: z.createTime,
    detectedLanguage: detectLanguage(reviewText),
  };
  return review;
}

export function buildZernioMonitoredReview(
  z: ZernioReview,
  accountId: string,
  locationId: string,
): MonitoredReview {
  const review = zernioReviewToNormalized(z);
  return {
    review,
    identity: {
      provider: 'zernio',
      providerReviewId: z.id,
      providerReviewName: `zernio://${accountId}/locations/${locationId}/reviews/${z.id}`,
      providerLocationName: `zernio://${accountId}/locations/${locationId}`,
      identityStrategy: 'zernio_id',
    },
    contentHash: computeContentHash(review),
  };
}

/**
 * Extract the location id from Zernio's `review.name` field.
 * Format: `accounts/{accountId}/locations/{locationId}/reviews/{reviewId}`.
 * Returns null on any deviation — caller MUST treat null as fail-closed
 * per spec §6.3 (do NOT process a review whose location can't be parsed,
 * since fan-out across same-account-multi-location businesses would route
 * it to every business otherwise).
 */
export function extractLocationFromReviewName(name: string): string | null {
  if (typeof name !== 'string' || !name) return null;
  const m = name.match(/^accounts\/[^/]+\/locations\/([^/]+)\/reviews\/.+$/);
  return m ? m[1] : null;
}
```

- [ ] **Step 7.4: Update `src/lib/reviews/index.ts` exports**

In `src/lib/reviews/index.ts`:
- Drop any `export ... from './serpapi-monitor'` and `export ... from './mock-monitor'` lines (those files are deleted in Task 23, but stop exporting from them now).
- Add: `export { buildZernioMonitoredReview, zernioReviewToNormalized, extractLocationFromReviewName, ZernioReviewNormalizationError } from './zernio-normalize';`

- [ ] **Step 7.5: Run tests**

Run: `pnpm test -- src/lib/reviews/__tests__/zernio-normalize.test.ts`

Expected: all 12 tests PASS.

- [ ] **Step 7.6: Type-check + lint**

Run: `pnpm tsc --noEmit && pnpm lint`

Expected: `zernio-normalize.ts` compiles. Pre-existing TS errors elsewhere are acceptable until later tasks land.

- [ ] **Step 7.7: Commit**

```bash
git add src/lib/reviews/zernio-normalize.ts src/lib/reviews/__tests__/zernio-normalize.test.ts src/lib/reviews/index.ts
git commit -m "$(cat <<'EOF'
feat(reviews): zernio-normalize.ts — Zernio→MonitoredReview adapter

zernioReviewToNormalized + buildZernioMonitoredReview build the
project's NormalizedReview / MonitoredReview from a Zernio payload.
Per-review validation throws ZernioReviewNormalizationError so workers
can isolate one bad review without aborting a batch.

extractLocationFromReviewName parses the
'accounts/{a}/locations/{l}/reviews/{r}' resource path. Returns null on
malformed input — callers MUST fail closed per spec §6.3.

Drops SerpAPI monitor barrel re-exports from src/lib/reviews/index.ts;
those files are deleted in a later commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: `process-review.ts` — ON CONFLICT race-handling + `suppressNotification` propagation

**Files:**
- Modify: `src/lib/reviews/process-review.ts`

- [ ] **Step 8.1: Refactor — extract existing-row branch into helper**

Locate `processReview` in `src/lib/reviews/process-review.ts`. The current shape (around line 33) is:
1. `SELECT FOR UPDATE` for an existing row by `(provider, provider_review_name)`.
2. If none → INSERT + enqueue `generate_response`.
3. If existing → content-hash branching (lines ~75-228).

Extract the existing-row branch (3) into an inner function `processExistingReview(tx, existing, monitored, businessId, correlationId, suppressNotification)`. Both the original-found path AND the new race-loss path will call this helper. Refer to spec §6.6 implementation note.

- [ ] **Step 8.2: Update `processReview` signature and body**

Wrap the body to accept the new options arg and emit ON CONFLICT DO NOTHING:

```ts
export async function processReview(
  monitored: MonitoredReview,
  businessId: string,
  correlationId?: string,
  options?: { suppressNotification?: boolean },
): Promise<ProcessResult> {
  const { review, identity, contentHash } = monitored;
  const suppressNotification = options?.suppressNotification ?? false;

  return await sql.begin(async (tx) => {
    const [existing] = await tx<{ id: string; review_content_hash: string | null }[]>`
      SELECT id, review_content_hash
      FROM reviews
      WHERE provider = ${identity.provider}
        AND provider_review_name = ${identity.providerReviewName}
      FOR UPDATE
    `;

    if (!existing) {
      const reviewId = uuidv7();

      const inserted = await tx`
        INSERT INTO reviews (
          id, business_id, provider, provider_review_id,
          provider_review_name, provider_location_name,
          reviewer_name, star_rating, review_text, review_date,
          detected_language, review_content_hash, status, detected_at
        ) VALUES (
          ${reviewId}, ${businessId}, ${identity.provider}, ${identity.providerReviewId},
          ${identity.providerReviewName}, ${identity.providerLocationName},
          ${review.reviewerName}, ${review.starRating}, ${review.reviewText}, ${review.reviewDate},
          ${review.detectedLanguage}, ${contentHash}, 'new', NOW()
        )
        ON CONFLICT (provider, provider_review_name) DO NOTHING
      `;

      if (inserted.count > 0) {
        // We won the race. Enqueue generate_response with suppress flag.
        const outboxPayload: GenerateResponsePayload = {
          review_id: reviewId,
          business_id: businessId,
          version: 1,
          correlation_id: correlationId,
          suppress_notification: suppressNotification,
        };

        await tx`
          INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
          VALUES (
            ${uuidv7()}, 'generate_response', 'review', ${reviewId},
            ${jsonb(outboxPayload)}, 'pending'
          )
        `;

        return 'new' as const;
      }

      // Race-loss path. Re-read FOR UPDATE; fall through to existing-row branch
      // so newer content from our payload doesn't get silently dropped.
      const [winner] = await tx<{ id: string; review_content_hash: string | null }[]>`
        SELECT id, review_content_hash
        FROM reviews
        WHERE provider = ${identity.provider}
          AND provider_review_name = ${identity.providerReviewName}
        FOR UPDATE
      `;
      if (!winner) {
        // Race-loser AND row vanished — extreme edge case (deletion mid-tx).
        // Fall through to existing handling: throw, BullMQ retries.
        throw new Error(
          `process-review: race-loss without winner row for ${identity.providerReviewName}`,
        );
      }
      return processExistingReview(
        tx, winner, monitored, businessId, correlationId, suppressNotification,
      );
    }

    return processExistingReview(
      tx, existing, monitored, businessId, correlationId, suppressNotification,
    );
  });
}
```

- [ ] **Step 8.3: Thread `suppressNotification` into the helper's `generate_response` enqueue**

Inside `processExistingReview`, every place that enqueues a `generate_response` outbox row (the content-changed branch and any `version` bump branch) MUST include `suppress_notification: suppressNotification` in the payload, mirroring the new-row branch above. Do not enqueue with the flag missing.

- [ ] **Step 8.4: Add tests for race-loss + suppressNotification**

Append to `src/lib/reviews/__tests__/process-review.test.ts` (create file if it doesn't exist; otherwise extend):

```ts
import { describe, it, expect } from 'vitest';
// ... existing imports ...

describe('processReview — ON CONFLICT race handling', () => {
  it('returns "unchanged" when race-loss winner has identical content', async () => {
    // Seed: another tx wins the insert with identical contentHash. Run
    // processReview on the same payload. Expect 'unchanged' result and NO
    // generate_response outbox row queued.
    // Implementation: vitest mock or real-Postgres integration test per
    // existing pattern in this test file.
  });

  it('falls through to existing-row branch when race-loss winner has DIFFERENT content', async () => {
    // Seed: another tx wins with stale contentHash. Run processReview with
    // newer contentHash. Expect either 'updated' (content-hash branch path)
    // OR a new generate_response row with the higher version. Critically:
    // the newer payload's content must NOT be silently dropped.
  });
});

describe('processReview — suppressNotification propagation', () => {
  it('propagates suppress_notification=true into generate_response payload', async () => {
    // Run processReview with options={suppressNotification:true}. Assert
    // the inserted job_outbox row's payload->>'suppress_notification' = 'true'.
  });

  it('defaults suppress_notification to false when options omitted', async () => {
    // Same as above with no options arg. Assert payload->>'suppress_notification'
    // is null/undefined or 'false' — explicitly NOT 'true'.
  });
});
```

(For each test stub, expand into a real assertion using the existing test harness in this file. If the project uses an integration-test pattern with real Postgres, replicate that.)

- [ ] **Step 8.5: Run tests**

Run: `pnpm test -- src/lib/reviews/__tests__/process-review.test.ts`

Expected: all tests PASS (existing + new).

- [ ] **Step 8.6: Commit**

```bash
git add src/lib/reviews/process-review.ts src/lib/reviews/__tests__/process-review.test.ts
git commit -m "$(cat <<'EOF'
feat(reviews): processReview ON CONFLICT race-handling + suppress flag

INSERT now uses ON CONFLICT (provider, provider_review_name) DO NOTHING.
On race-loss the function re-reads FOR UPDATE and falls through to the
existing-row branch, ensuring newer content from a race-loser is NOT
silently dropped (round-2 fix). The existing-row content-hash branch is
extracted into processExistingReview for reuse from both paths.

processReview accepts options.suppressNotification; the flag rides into
every generate_response outbox payload. Used by ZernioBackfillWorker so
the first-connect backfill of up to 75 reviews does not produce 75
approval emails.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: `ResponseGeneratorWorker` — gate `send_notification` enqueue on suppress flag

**Files:**
- Modify: `worker/jobs/ResponseGeneratorWorker.ts`

- [ ] **Step 9.1: Read the flag and conditionally enqueue**

Locate the section of `worker/jobs/ResponseGeneratorWorker.ts` that, after generating the response, enqueues a `send_notification` outbox row. Wrap that enqueue with the suppress flag check (per spec §6.7):

```ts
const suppressNotification = job.data.suppress_notification === true;

if (!suppressNotification) {
  const sendPayload: SendNotificationPayload = {
    response_id: responseId,
    business_id: businessId,
    correlation_id: correlationId,
  };
  await tx`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    VALUES (
      ${uuidv7()}, 'send_notification', 'response', ${responseId},
      ${jsonb(sendPayload)}, 'pending'
    )
  `;
} else {
  logger.log(`suppress_notification=true — skipping send_notification enqueue for response ${responseId}`);
}
```

**No `notification_deliveries` row is written when suppressed.** The response sits in `pending_approval` and is visible in the dashboard. The `NotificationFailoverPoller` filters on `EXISTS notification_deliveries WHERE template='approval_request'` so missing rows are safely skipped — no false-positive admin alerts. Verify this guard exists at `worker/jobs/NotificationFailoverPoller.ts:152-167, 260-265` before merging.

- [ ] **Step 9.2: Add unit test**

In `worker/__tests__/ResponseGeneratorWorker.test.ts`, add:

```ts
describe('ResponseGeneratorWorker — suppress_notification', () => {
  it('skips send_notification outbox enqueue when suppress_notification=true', async () => {
    // Run the worker with payload.suppress_notification=true. Assert
    // job_outbox has zero rows with topic='send_notification' for this
    // response_id. Assert the response itself was created normally.
    // Assert NO notification_deliveries row was written.
  });

  it('enqueues send_notification when suppress_notification=false / undefined', async () => {
    // Run worker with the flag absent. Assert exactly one
    // job_outbox row with topic='send_notification' exists.
  });
});
```

- [ ] **Step 9.3: Run tests**

Run: `pnpm test -- worker/__tests__/ResponseGeneratorWorker.test.ts`

Expected: PASS.

- [ ] **Step 9.4: Commit**

```bash
git add worker/jobs/ResponseGeneratorWorker.ts worker/__tests__/ResponseGeneratorWorker.test.ts
git commit -m "$(cat <<'EOF'
feat(workers): ResponseGeneratorWorker honors suppress_notification

When job.data.suppress_notification === true, skip the send_notification
outbox enqueue entirely. No notification_deliveries row is written either.
Used by ZernioBackfillWorker for first-connect backfill (spec §4.6, §6.7).

NotificationFailoverPoller already filters on EXISTS
notification_deliveries WHERE template='approval_request', so missing
rows are safely skipped — no false-positive admin alerts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: `applyIngestionAuthErrorFallback` helper

**Files:**
- Create: `src/lib/zernio/auth-error-fallback.ts`
- Create: `src/lib/zernio/__tests__/auth-error-fallback.test.ts`

- [ ] **Step 10.1: Write the failing test**

Create `src/lib/zernio/__tests__/auth-error-fallback.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { applyIngestionAuthErrorFallback } from '../auth-error-fallback';
// Use the existing project test-DB harness — match the pattern from
// existing src/lib/zernio/__tests__ (likely a withTestDb wrapper).

describe('applyIngestionAuthErrorFallback', () => {
  it('disconnects only the matching active connection (account+location pinned)', async () => {
    // Seed: business B has TWO active zernio_connections — one at
    // accountA/locationL (the publish target) and one at accountA/locationM.
    // Run applyIngestionAuthErrorFallback(B, accountA, locationL, '401 expired').
    // Assert: the locationL row is now status='disconnected' with
    // last_error='401 expired'; the locationM row is unchanged.
  });

  it('enqueues notify_owner_connection_lost outbox row on disconnect', async () => {
    // Seed: one active connection. Run helper. Assert exactly one
    // job_outbox row with topic='notify_owner_connection_lost' for the
    // business, payload.kind='connection_lost'.
  });

  it('no-ops when matching connection is already disconnected', async () => {
    // Seed: connection already in 'disconnected'. Run helper.
    // Assert: no UPDATE applied; no notify_owner_connection_lost row added.
  });

  it('respects migration-026 dedup index — concurrent calls produce ≤1 connection_lost email per UTC day', async () => {
    // Run the helper twice in quick succession. The
    // notification_deliveries_connection_lost_dedup index from migration 026
    // caps to one email per business per UTC day; assert that subsequent
    // NotificationWorker dispatches only send once.
  });
});
```

- [ ] **Step 10.2: Run test to verify failure**

Run: `pnpm test -- src/lib/zernio/__tests__/auth-error-fallback.test.ts`

Expected: FAIL (module not found).

- [ ] **Step 10.3: Write the implementation**

Create `src/lib/zernio/auth-error-fallback.ts` (verbatim from spec §6.5b):

```ts
// src/lib/zernio/auth-error-fallback.ts
//
// Distinct from publisher's applyTransientExhaustionFallback (which requires
// a response_id to park) — ingestion has no response to park. This helper
// handles the connection-side cleanup only.
//
// See spec §6.5b.

import { createHash, randomUUID as uuidv7 } from 'node:crypto';
import { sql } from '@/lib/db/server';
import { jsonb } from '@/lib/db/jsonb';

export async function applyIngestionAuthErrorFallback(
  businessId: string,
  accountId: string,
  locationId: string,
  reason: string,
): Promise<void> {
  await sql.begin(async (tx) => {
    // Disconnect the matching active connection. Scoped by location to avoid
    // accidentally disconnecting a sibling business sharing the same account
    // at a different location.
    const updated = await tx`
      UPDATE zernio_connections
      SET status = 'disconnected',
          disconnected_at = NOW(),
          disconnect_reason = 'auth_error_on_ingest',
          last_error = ${reason},
          last_error_at = NOW(),
          updated_at = NOW()
      WHERE business_id = ${businessId}
        AND zernio_account_id = ${accountId}
        AND zernio_location_id = ${locationId}
        AND status = 'active'
      RETURNING 1
    `;

    if (updated.count === 0) {
      // Connection already disconnected by another worker. Don't enqueue
      // another connection_lost notify — the prior path already did.
      return;
    }

    // Enqueue connection_lost notify. Migration 026's dedup index
    // notification_deliveries_connection_lost_dedup caps to one email per
    // business per UTC day, so this is safe across concurrent ingest jobs.
    await tx`
      INSERT INTO job_outbox (
        id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts
      ) VALUES (
        ${uuidv7()},
        'notify_owner_connection_lost',
        'business',
        ${businessId},
        ${jsonb({ kind: 'connection_lost', business_id: businessId })},
        0, 5
      )
    `;
  });
}
```

> **Note on the `randomUUID as uuidv7` import shape.** The codebase uses `import { createHash, randomUUID } from 'node:crypto'` per CLAUDE.md, then aliases `randomUUID` to `uuidv7` in helpers that need UUIDv7-style sortable ids. If the existing project pattern is different (e.g. a custom helper), follow it instead.

- [ ] **Step 10.4: Run test to verify it passes**

Run: `pnpm test -- src/lib/zernio/__tests__/auth-error-fallback.test.ts`

Expected: PASS.

- [ ] **Step 10.5: Commit**

```bash
git add src/lib/zernio/auth-error-fallback.ts src/lib/zernio/__tests__/auth-error-fallback.test.ts
git commit -m "$(cat <<'EOF'
feat(zernio): applyIngestionAuthErrorFallback helper

Connection-side cleanup for ZernioAuthError on ingestion paths (no
response_id to park, so the existing applyTransientExhaustionFallback
isn't a drop-in). Disconnects the matching active connection (pinned
by account + location to avoid racing a fresh sibling reconnect),
records last_error, and enqueues notify_owner_connection_lost.

Idempotent — concurrent invocations on an already-disconnected row
no-op cleanly (UPDATE…WHERE status='active' RETURNING 1).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: `zernio-ingest-shared.ts` — error dispatcher + reconcile helper

**Files:**
- Create: `worker/jobs/zernio-ingest-shared.ts`
- Create: `worker/__tests__/zernio-ingest-shared.test.ts`

- [ ] **Step 11.1: Write the implementation**

Create `worker/jobs/zernio-ingest-shared.ts`. This contains TWO helpers used by both ingest worker and backfill worker.

```ts
// worker/jobs/zernio-ingest-shared.ts
//
// Shared helpers used by ZernioReviewIngestWorker and ZernioBackfillWorker.
//   1. handleZernioIngestError — error-class dispatcher per spec §6.3 table.
//   2. reconcileExternallyAnsweredReview — supersedes local active responses
//      when the customer already replied via Google directly (spec §6.3b).

import { createHash, randomUUID as uuidv7 } from 'node:crypto';
import { sql } from '@/lib/db/server';
import {
  ZernioAuthError,
  ZernioPermanentError,
  ZernioTransientError,
  ZernioValidationError,
} from '@/lib/zernio/errors';
import { applyIngestionAuthErrorFallback } from '@/lib/zernio/auth-error-fallback';
import { canonicalizeReplyText } from '@/lib/zernio/canonicalize-reply';
import type { ZernioReview } from '@/lib/zernio/types';
import { markOutboxCompleted, markOutboxFailed } from '@/lib/shared/outbox-helpers';
import type { WorkerLogger } from '@/lib/shared/logger';

export interface IngestErrorContext {
  business_id: string;
  zernio_account_id: string;
  zernio_location_id: string;
}

/**
 * Dispatches Zernio HTTP errors to the right disposition per spec §6.3 table.
 * - ZernioAuthError → applyIngestionAuthErrorFallback + markOutboxFailed permanent.
 * - ZernioPermanentError / ZernioValidationError → markOutboxFailed permanent.
 * - ZernioTransientError → rethrow (BullMQ retries with exponential backoff).
 * - Unknown → rethrow (BullMQ retries; on exhaustion the worker's onFailed
 *   hook decides; spec §6.3 says treat unknown as a code bug to investigate).
 */
export async function handleZernioIngestError(
  err: unknown,
  outboxId: string,
  attempt: number,
  ctx: IngestErrorContext,
  logger: WorkerLogger,
): Promise<void> {
  if (err instanceof ZernioAuthError) {
    const reason = err.body ? String(err.body).slice(0, 500) : err.message;
    logger.warn(`ZernioAuthError on ingest — running connection fallback: ${reason}`);
    await applyIngestionAuthErrorFallback(
      ctx.business_id, ctx.zernio_account_id, ctx.zernio_location_id, reason,
    );
    await markOutboxFailed(outboxId, 'zernio_auth_error_on_ingest', attempt);
    return;
  }
  if (err instanceof ZernioPermanentError) {
    logger.error(`ZernioPermanentError on ingest: ${err.message}`);
    await markOutboxFailed(outboxId, `zernio_permanent_error: ${err.message}`, attempt);
    return;
  }
  if (err instanceof ZernioValidationError) {
    logger.error(`ZernioValidationError on ingest: ${err.message}`);
    await markOutboxFailed(outboxId, `zernio_validation_error: ${err.message}`, attempt);
    return;
  }
  if (err instanceof ZernioTransientError) {
    logger.warn(`ZernioTransientError on ingest — rethrowing for retry: ${err.message}`);
    throw err;
  }
  // Unknown error class — rethrow so BullMQ retries; on exhaustion the
  // worker-specific onFailed handler decides what to do.
  throw err;
}

/**
 * Called from both ingest worker and backfill worker when a fetched Zernio
 * review has reviewReply !== null. Matches local rows by EITHER:
 *   1. provider='zernio' rows with exact identity (the new path), OR
 *   2. legacy provider='serpapi_poll' rows by field-match (reviewer_name +
 *      star_rating + review_text + createTime ±24h, mirroring zernio-publisher's
 *      MATCH_WINDOW_MS).
 *
 * For matched rows: load active responses; protect those whose canonicalized
 * approved_text equals the canonicalized external reply (those are OUR reply
 * being reflected back via review.updated); supersede everything else with
 * posting_error='already_replied_external'. Mixed legacy/Zernio set is
 * supported — protect-set is computed per-response, not all-or-nothing.
 *
 * The IN clause MUST NOT include 'awaiting_manual_post' — that status is
 * decommissioned in migration 029 (spec §6.12b). Spec §13 grep acceptance
 * criterion enforces this.
 */
export async function reconcileExternallyAnsweredReview(
  target: ZernioReview,
  businessId: string,
  accountId: string,
  locationId: string,
  logger: WorkerLogger,
): Promise<void> {
  const providerReviewName = `zernio://${accountId}/locations/${locationId}/reviews/${target.id}`;
  const targetCreatedAtMs = new Date(target.createTime).getTime();
  const targetReviewerName = (target.reviewer.displayName ?? '').trim() || 'Anonymous';
  const targetComment = (target.comment ?? '').trim();

  await sql.begin(async (tx) => {
    const matchedRows = await tx<{ id: string; provider: string }[]>`
      SELECT id, provider FROM reviews
      WHERE business_id = ${businessId}
        AND (
          (provider = 'zernio' AND provider_review_name = ${providerReviewName})
          OR (
            provider = 'serpapi_poll'
            AND reviewer_name = ${targetReviewerName}
            AND star_rating = ${target.rating}
            AND COALESCE(NULLIF(trim(review_text), ''), '') = ${targetComment}
            AND ABS(EXTRACT(EPOCH FROM (review_date - to_timestamp(${targetCreatedAtMs} / 1000.0)))) < 86400
          )
        )
      FOR UPDATE
    `;

    if (matchedRows.length === 0) {
      logger.log(`External reply on previously-unseen review ${target.id} — not ingesting`);
      return;
    }

    const reviewIds = matchedRows.map(r => r.id);
    const externalReplyText = canonicalizeReplyText(target.reviewReply?.comment);

    const activeResponses = await tx<{
      id: string;
      status: string;
      approved_text: string | null;
    }[]>`
      SELECT id, status, approved_text
      FROM responses
      WHERE review_id = ANY(${reviewIds}::uuid[])
        AND status IN ('pending_approval', 'approved', 'edited',
                       'awaiting_owner_connect')
    `;
    // NOTE: 'awaiting_manual_post' is deliberately omitted — decommissioned
    // in migration 029. Spec §13 grep acceptance criterion forbids
    // re-introduction.

    if (activeResponses.length === 0) {
      logger.log(`External reply detected but no active responses for review row(s) ${reviewIds.join(',')} — no-op`);
      return;
    }

    // Protect responses whose approved_text matches the external reply
    // (those are OUR reply that Zernio is reflecting back via review.updated).
    const protectedIds = new Set(
      activeResponses
        .filter(r =>
          r.approved_text !== null &&
          canonicalizeReplyText(r.approved_text) === externalReplyText &&
          r.status !== 'pending_approval',
        )
        .map(r => r.id),
    );

    const supersedeIds = activeResponses
      .filter(r => !protectedIds.has(r.id))
      .map(r => r.id);

    if (supersedeIds.length === 0) {
      logger.log(
        `External reply matches every active response's approved_text ` +
        `(${protectedIds.size}) — likely our publish; no supersession`,
      );
      return;
    }

    const supersededRows = await tx`
      UPDATE responses
      SET status = 'superseded',
          posting_error = 'already_replied_external',
          updated_at = NOW()
      WHERE id = ANY(${supersedeIds}::uuid[])
      RETURNING id
    `;

    if (supersededRows.count > 0) {
      const providers = matchedRows.map(r => r.provider).join(',');
      logger.log(
        `Superseded ${supersededRows.count} active response(s) across ` +
        `${matchedRows.length} review row(s) [${providers}] because customer ` +
        `replied externally on Google. Protected ${protectedIds.size} ` +
        `matching response(s) (our reply).`,
      );
    }
  });
}
```

- [ ] **Step 11.2: Write tests**

Create `worker/__tests__/zernio-ingest-shared.test.ts` covering the spec §10.1 + §6.3b test list:

```ts
import { describe, it, expect, vi } from 'vitest';
import {
  handleZernioIngestError,
  reconcileExternallyAnsweredReview,
} from '../jobs/zernio-ingest-shared';
import {
  ZernioAuthError,
  ZernioPermanentError,
  ZernioTransientError,
  ZernioValidationError,
} from '@/lib/zernio/errors';

describe('handleZernioIngestError — dispatch matrix', () => {
  it('ZernioAuthError → applyIngestionAuthErrorFallback + markOutboxFailed', async () => {
    // Spy on applyIngestionAuthErrorFallback. Run helper. Assert spy called
    // with (business_id, account_id, location_id, reason). Assert markOutboxFailed
    // called with reason='zernio_auth_error_on_ingest'.
  });
  it('ZernioPermanentError → markOutboxFailed permanent', async () => { /* ... */ });
  it('ZernioValidationError → markOutboxFailed permanent', async () => { /* ... */ });
  it('ZernioTransientError → rethrow (BullMQ retry)', async () => {
    await expect(
      handleZernioIngestError(
        new ZernioTransientError('timeout', {}),
        'outbox-1', 1,
        { business_id: 'B', zernio_account_id: 'A', zernio_location_id: 'L' },
        { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
      ),
    ).rejects.toBeInstanceOf(ZernioTransientError);
  });
  it('unknown Error → rethrow', async () => {
    await expect(
      handleZernioIngestError(
        new Error('boom'),
        'outbox-1', 1,
        { business_id: 'B', zernio_account_id: 'A', zernio_location_id: 'L' },
        { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
      ),
    ).rejects.toThrow('boom');
  });
});

describe('reconcileExternallyAnsweredReview', () => {
  it('mixed legacy/Zernio: protects matching zernio response, supersedes stale legacy serpapi_poll response', async () => {
    // Round-9 regression. Seed:
    //  - reviews table: one zernio row (id Rz) and one serpapi_poll row (id Rs)
    //    matching the same physical Google review (same reviewer + rating +
    //    text + date within 24h).
    //  - responses table: active 'approved' on Rz with approved_text = "thanks"
    //    (matches external reply). Active 'approved' on Rs with approved_text
    //    = "different".
    // Call helper with target.reviewReply.comment = "thanks".
    // Assert: Rz response remains 'approved' (protected). Rs response now
    // 'superseded' with posting_error='already_replied_external'.
  });

  it('all-protected: all active responses match external reply → no supersession', async () => { /* ... */ });

  it('all-stale: no active response matches → all superseded', async () => { /* ... */ });

  it('pending_approval response (approved_text=NULL) is always superseded when external reply detected', async () => { /* ... */ });

  it('no matched rows → log + no-op, no UPDATE', async () => { /* ... */ });

  it('does NOT include awaiting_manual_post in active-status filter (regression for §6.12b)', async () => {
    // Seed: response with status='awaiting_manual_post' (legacy fixture
    // bypassing migration 029). Run helper. Assert that response is NOT
    // included in any UPDATE — the helper must ignore this dead status.
  });
});
```

Fill the test bodies with the project's existing test-DB harness (likely a `withTestDb` wrapper from `worker/__tests__/test-utils.ts` or similar — match what other worker tests use).

- [ ] **Step 11.3: Run tests**

Run: `pnpm test -- worker/__tests__/zernio-ingest-shared.test.ts`

Expected: PASS.

- [ ] **Step 11.4: Type-check + lint**

Run: `pnpm tsc --noEmit && pnpm lint`

Expected: PASS for these files. (Other files referencing the soon-to-exist ingest worker may still fail; resolved in Task 12.)

- [ ] **Step 11.5: Commit**

```bash
git add worker/jobs/zernio-ingest-shared.ts worker/__tests__/zernio-ingest-shared.test.ts
git commit -m "$(cat <<'EOF'
feat(workers): zernio-ingest-shared.ts — dispatcher + reconcile helper

handleZernioIngestError dispatches Zernio HTTP errors per spec §6.3 table:
auth → ingestion-fallback + markFailed; permanent/validation → markFailed;
transient → rethrow; unknown → rethrow.

reconcileExternallyAnsweredReview supersedes local active responses on
reviews the customer already replied to via Google directly. Matches
both zernio rows by exact identity AND legacy serpapi_poll rows by
field-match (mirrors zernio-publisher MATCH_WINDOW_MS). Per-response
protect-set distinguishes "our reply" (text-match against approved_text)
from "external reply" — supports mixed legacy/Zernio scenarios where one
zernio row protects and one legacy row supersedes from a single helper
call (round-9 regression).

Active-status filter deliberately excludes 'awaiting_manual_post' per
spec §6.12b / migration 029 / §13 grep acceptance criterion.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: `ZernioReviewIngestWorker.ts`

**Files:**
- Create: `worker/jobs/ZernioReviewIngestWorker.ts`
- Create: `worker/__tests__/ZernioReviewIngestWorker.test.ts`

- [ ] **Step 12.1: Write the implementation**

Create `worker/jobs/ZernioReviewIngestWorker.ts` per spec §6.3:

```ts
// worker/jobs/ZernioReviewIngestWorker.ts
//
// Handles ingest_zernio_review outbox topic (one row per active connection
// at the firing Zernio account, fanned out by worker/ingress/zernio.ts).
//
// Flow per spec §4.2:
//   1. Subscription guard.
//   2. Verify zernio_connections row still active for (business, account, location).
//   3. Mock-mode short-circuit (markOutboxCompleted + return).
//   4. Walk up to 2 listReviews pages (locationId-scoped).
//   5. Not found → throw ZernioIngestReviewNotFoundError → BullMQ retries →
//      onFailed hook escalates to review_exceptions type='zernio_review_not_found'.
//   6. Verify location segment: missing/unparseable → throw
//      ZernioIngestUnparseableLocationError (also escalates via onFailed).
//      Mismatch → no-op (sibling business's review).
//   7. External reply present → reconcileExternallyAnsweredReview + return.
//   8. Build MonitoredReview; on ZernioReviewNormalizationError → log + complete.
//   9. processReview + markOutboxCompleted.

import type { Job } from 'bullmq';
import { sql } from '@/lib/db/server';
import { checkSubscription } from '@/lib/shared/subscription-guard';
import { extractOutboxHandle } from '@/lib/shared/outbox-helpers';
import { markOutboxCompleted } from '@/lib/shared/outbox-helpers';
import { createWorkerLogger } from '@/lib/shared/logger';
import { zernioClient } from '@/lib/zernio/client';
import {
  buildZernioMonitoredReview,
  extractLocationFromReviewName,
  ZernioReviewNormalizationError,
} from '@/lib/reviews/zernio-normalize';
import { processReview } from '@/lib/reviews/process-review';
import {
  handleZernioIngestError,
  reconcileExternallyAnsweredReview,
} from './zernio-ingest-shared';
import type { IngestZernioReviewPayload } from '@/lib/shared/worker-types';
import type { MonitoredReview } from '@/lib/reviews/types';
import type { ZernioReview } from '@/lib/zernio/types';

export class ZernioIngestReviewNotFoundError extends Error {
  constructor(
    readonly businessId: string,
    readonly zernioAccountId: string,
    readonly zernioLocationId: string,
    readonly zernioReviewId: string,
  ) {
    super(`Zernio review ${zernioReviewId} not found in latest 100 — retrying`);
    this.name = 'ZernioIngestReviewNotFoundError';
  }
}

export class ZernioIngestUnparseableLocationError extends Error {
  constructor(
    readonly businessId: string,
    readonly zernioAccountId: string,
    readonly zernioLocationId: string,
    readonly zernioReviewId: string,
    readonly reviewName: string,
  ) {
    super(`Unparseable Zernio review.name: ${reviewName.slice(0, 200)}`);
    this.name = 'ZernioIngestUnparseableLocationError';
  }
}

export async function handleZernioReviewIngest(job: Job<IngestZernioReviewPayload>) {
  const logger = createWorkerLogger('[ZernioReviewIngestWorker]', job.data.correlation_id);
  const { business_id, zernio_account_id, zernio_location_id, zernio_review_id } = job.data;
  const { outboxId, attempt } = extractOutboxHandle(job.data, job.id!);

  // 1. Subscription guard
  const [biz] = await sql<{ subscription_status: string; updated_at: Date }[]>`
    SELECT subscription_status, updated_at FROM businesses WHERE id = ${business_id}
  `;
  if (!biz || !checkSubscription(biz.subscription_status, biz.updated_at, 'generator').allowed) {
    return markOutboxCompleted(outboxId, attempt);
  }

  // 2. Verify the connection still exists at the same location
  const [conn] = await sql<{ id: string }[]>`
    SELECT id FROM zernio_connections
    WHERE business_id = ${business_id}
      AND zernio_account_id = ${zernio_account_id}
      AND zernio_location_id = ${zernio_location_id}
      AND status = 'active'
  `;
  if (!conn) {
    logger.warn(`Connection mismatch — skipping`);
    return markOutboxCompleted(outboxId, attempt);
  }

  // 3. Mock-mode short-circuit (spec §7)
  if (process.env.MOCK_EXTERNAL_APIS === 'true') {
    logger.log(`Mock mode — short-circuiting ingest for ${zernio_review_id}`);
    return markOutboxCompleted(outboxId, attempt);
  }

  // 4. Fetch + locate (up to 2 pages = 100 reviews), locationId-scoped.
  let target: ZernioReview | undefined;
  let pageToken: string | undefined;
  try {
    for (let i = 0; i < 2; i++) {
      const page = await zernioClient.listReviews(zernio_account_id, {
        locationId: zernio_location_id,
        pageSize: 50,
        pageToken,
      });
      target = page.reviews.find(r => r.id === zernio_review_id);
      if (target) break;
      if (!page.nextPageToken) break;
      pageToken = page.nextPageToken;
    }
  } catch (err) {
    return handleZernioIngestError(err, outboxId, attempt, { business_id, zernio_account_id, zernio_location_id }, logger);
  }

  if (!target) {
    throw new ZernioIngestReviewNotFoundError(
      business_id, zernio_account_id, zernio_location_id, zernio_review_id,
    );
  }

  // 5. Verify location match — FAIL CLOSED on missing/unparseable.
  const reviewLocationId = extractLocationFromReviewName(target.name);
  if (!reviewLocationId) {
    logger.error(`Review ${zernio_review_id} name has unparseable location: ${target.name}`);
    throw new ZernioIngestUnparseableLocationError(
      business_id, zernio_account_id, zernio_location_id, zernio_review_id, target.name,
    );
  }
  if (reviewLocationId !== zernio_location_id) {
    logger.log(`Review belongs to different location (${reviewLocationId} vs ${zernio_location_id}) — no-op`);
    return markOutboxCompleted(outboxId, attempt);
  }

  // 6. External-reply reconciliation.
  if (target.reviewReply !== null) {
    await reconcileExternallyAnsweredReview(
      target, business_id, zernio_account_id, zernio_location_id, logger,
    );
    return markOutboxCompleted(outboxId, attempt);
  }

  // 7. Process via existing pipeline.
  let monitored: MonitoredReview;
  try {
    monitored = buildZernioMonitoredReview(target, zernio_account_id, zernio_location_id);
  } catch (err) {
    if (err instanceof ZernioReviewNormalizationError) {
      logger.warn(`Skipping malformed review ${zernio_review_id}: ${err.message}`);
      return markOutboxCompleted(outboxId, attempt);
    }
    throw err;
  }

  await processReview(monitored, business_id, job.data.correlation_id);
  await markOutboxCompleted(outboxId, attempt);
}
```

- [ ] **Step 12.2: Write tests**

Create `worker/__tests__/ZernioReviewIngestWorker.test.ts` covering spec §10.1 list:

```ts
import { describe, it, expect, vi } from 'vitest';
import {
  handleZernioReviewIngest,
  ZernioIngestReviewNotFoundError,
  ZernioIngestUnparseableLocationError,
} from '../jobs/ZernioReviewIngestWorker';

describe('handleZernioReviewIngest', () => {
  it('finds review on page 1 → processReview called', async () => { /* ... */ });
  it('finds review on page 2 → processReview called', async () => { /* ... */ });
  it('not found in 2 pages → throws ZernioIngestReviewNotFoundError', async () => { /* ... */ });
  it('location parseable but != payload location → no-op (sibling business)', async () => { /* ... */ });
  it('location unparseable → throws ZernioIngestUnparseableLocationError', async () => { /* ... */ });
  it('subscription cancelled → markOutboxCompleted, no Zernio call', async () => { /* ... */ });
  it('connection no longer active → markOutboxCompleted, no Zernio call', async () => { /* ... */ });
  it('MOCK_EXTERNAL_APIS=true → short-circuit (no listReviews call, no review_exceptions)', async () => {
    process.env.MOCK_EXTERNAL_APIS = 'true';
    // Run worker. Assert listReviews spy NOT called. Assert outbox marked
    // completed. Assert NO review_exceptions row created.
  });
  it('target.reviewReply !== null → reconcileExternallyAnsweredReview, no processReview', async () => { /* ... */ });
  it('ZernioAuthError on listReviews → applyIngestionAuthErrorFallback called', async () => { /* ... */ });
  it('ZernioReviewNormalizationError → markOutboxCompleted with warning, no retry', async () => { /* ... */ });
});
```

- [ ] **Step 12.3: Run tests + commit**

Run: `pnpm test -- worker/__tests__/ZernioReviewIngestWorker.test.ts`

Expected: PASS.

```bash
git add worker/jobs/ZernioReviewIngestWorker.ts worker/__tests__/ZernioReviewIngestWorker.test.ts
git commit -m "$(cat <<'EOF'
feat(workers): ZernioReviewIngestWorker

Handles ingest_zernio_review outbox topic. Flow: subscription guard →
verify connection active at the supplied location → mock-mode short-
circuit → walk up to 2 listReviews pages (locationId-scoped) → fail
closed on unparseable review.name → no-op on location mismatch (sibling
fan-out target) → reconcileExternallyAnsweredReview if external reply →
buildZernioMonitoredReview + processReview.

Typed errors ZernioIngestReviewNotFoundError and
ZernioIngestUnparseableLocationError survive retry exhaustion so the
worker.on('failed') hook (registered in worker/index.ts) can escalate
to review_exceptions with the right type.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: `ZernioBackfillWorker.ts`

**Files:**
- Create: `worker/jobs/ZernioBackfillWorker.ts`
- Create: `worker/__tests__/ZernioBackfillWorker.test.ts`

- [ ] **Step 13.1: Write the implementation**

Create `worker/jobs/ZernioBackfillWorker.ts` per spec §6.4:

```ts
// worker/jobs/ZernioBackfillWorker.ts
//
// Handles zernio_initial_backfill outbox topic. One-shot per business.
// Idempotent via zernio_backfill_runs.completed_at IS NOT NULL sentinel —
// row-existence alone is NOT the done marker (a listAllReviews timeout
// after row insert would otherwise lose backfill on retry).
//
// Buckets reviews by createTime vs subscription_activated_at:
//   gap (>= activated, reviewReply=null) → cap 25, all tiers
//   historical (< activated, reviewReply=null) → cap 50, premium only
// Reviews already replied to externally are routed through
// reconcileExternallyAnsweredReview (not bucket-processing) so any
// pre-existing local active draft is correctly superseded.
//
// All processed responses ride suppress_notification=true so the first-
// connect dashboard doesn't blast 75 emails (spec §4.6).

import type { Job } from 'bullmq';
import { randomUUID as uuidv7 } from 'node:crypto';
import { sql } from '@/lib/db/server';
import { checkSubscription } from '@/lib/shared/subscription-guard';
import { extractOutboxHandle, markOutboxCompleted } from '@/lib/shared/outbox-helpers';
import { createWorkerLogger } from '@/lib/shared/logger';
import { zernioClient } from '@/lib/zernio/client';
import {
  buildZernioMonitoredReview,
  extractLocationFromReviewName,
  ZernioReviewNormalizationError,
} from '@/lib/reviews/zernio-normalize';
import { processReview } from '@/lib/reviews/process-review';
import {
  handleZernioIngestError,
  reconcileExternallyAnsweredReview,
} from './zernio-ingest-shared';
import type { ZernioInitialBackfillPayload } from '@/lib/shared/worker-types';
import type { MonitoredReview } from '@/lib/reviews/types';
import type { ZernioReview } from '@/lib/zernio/types';

export async function handleZernioBackfill(job: Job<ZernioInitialBackfillPayload>) {
  const logger = createWorkerLogger('[ZernioBackfillWorker]', job.data.correlation_id);
  const {
    business_id,
    zernio_account_id,
    zernio_location_id,
    subscription_tier,
    subscription_activated_at,
  } = job.data;
  const { outboxId, attempt } = extractOutboxHandle(job.data, job.id!);

  // Idempotent claim.
  const runId = uuidv7();
  await sql`
    INSERT INTO zernio_backfill_runs (
      id, business_id, zernio_account_id, zernio_location_id,
      subscription_tier, subscription_activated_at
    ) VALUES (
      ${runId}, ${business_id}, ${zernio_account_id}, ${zernio_location_id},
      ${subscription_tier}, ${subscription_activated_at}
    )
    ON CONFLICT (business_id) DO NOTHING
  `;

  const [run] = await sql<{ id: string; completed_at: Date | null }[]>`
    SELECT id, completed_at FROM zernio_backfill_runs WHERE business_id = ${business_id}
  `;

  if (!run) {
    throw new Error(`Backfill row not found for business=${business_id} after upsert`);
  }
  if (run.completed_at !== null) {
    logger.log(`Backfill already completed for business=${business_id} — skipping`);
    return markOutboxCompleted(outboxId, attempt);
  }

  // Subscription guard
  const [biz] = await sql<{ subscription_status: string; updated_at: Date }[]>`
    SELECT subscription_status, updated_at FROM businesses WHERE id = ${business_id}
  `;
  if (!biz || !checkSubscription(biz.subscription_status, biz.updated_at, 'generator').allowed) {
    await sql`UPDATE zernio_backfill_runs SET completed_at = NOW() WHERE business_id = ${business_id}`;
    return markOutboxCompleted(outboxId, attempt);
  }

  let all: ZernioReview[];
  try {
    all = await zernioClient.listAllReviews(zernio_account_id, {
      locationId: zernio_location_id,
      pageSize: 50,
      maxPages: 4,
    });
  } catch (err) {
    return handleZernioIngestError(err, outboxId, attempt, { business_id, zernio_account_id, zernio_location_id }, logger);
  }

  const activeSinceMs = new Date(subscription_activated_at).getTime();

  // Defense-in-depth client-side filter.
  const locationScoped = all.filter(z => extractLocationFromReviewName(z.name) === zernio_location_id);

  const answered = locationScoped.filter(z => z.reviewReply !== null);
  const unanswered = locationScoped
    .filter(z => z.reviewReply === null)
    .sort((a, b) => new Date(b.createTime).getTime() - new Date(a.createTime).getTime());

  // Reconcile already-answered reviews. Collect failures; throw at end so
  // BullMQ retries the whole backfill on partial failure (idempotent thanks
  // to processReview ON CONFLICT + supersession idempotency).
  const reconcileFailures: { reviewId: string; error: string }[] = [];
  for (const z of answered) {
    try {
      await reconcileExternallyAnsweredReview(
        z, business_id, zernio_account_id, zernio_location_id, logger,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Backfill reconcile failed for review ${z.id}: ${msg}`);
      reconcileFailures.push({ reviewId: z.id, error: msg });
    }
  }

  const gapAll = unanswered.filter(z => new Date(z.createTime).getTime() >= activeSinceMs);
  const histAll = unanswered.filter(z => new Date(z.createTime).getTime() < activeSinceMs);

  const gap = gapAll.slice(0, 25);
  const historical = subscription_tier === 'premium' ? histAll.slice(0, 50) : [];

  const gapSkipped = gapAll.length - gap.length;
  const historicalSkipped = subscription_tier === 'premium'
    ? histAll.length - historical.length
    : histAll.length;
  const oldestSkipped = [...gapAll.slice(25), ...histAll.slice(historical.length)]
    .reduce((oldest: string | null, z) =>
      !oldest || z.createTime < oldest ? z.createTime : oldest, null);

  for (const z of [...gap, ...historical]) {
    let monitored: MonitoredReview;
    try {
      monitored = buildZernioMonitoredReview(z, zernio_account_id, zernio_location_id);
    } catch (err) {
      if (err instanceof ZernioReviewNormalizationError) {
        logger.warn(`Skipping malformed review ${z.id}: ${err.message}`);
        continue;
      }
      throw err;
    }
    await processReview(monitored, business_id, job.data.correlation_id, {
      suppressNotification: true,
    });
  }

  // Always update partial counts so ops can audit.
  await sql`
    UPDATE zernio_backfill_runs
    SET gap_processed_count = ${gap.length},
        historical_processed_count = ${historical.length},
        gap_skipped_count = ${gapSkipped},
        historical_skipped_count = ${historicalSkipped},
        oldest_skipped_create_time = ${oldestSkipped},
        updated_at = NOW()
    WHERE business_id = ${business_id}
  `;

  if (reconcileFailures.length > 0) {
    throw new Error(
      `Backfill reconciliation failed for ${reconcileFailures.length} review(s): ` +
      reconcileFailures.map(f => `${f.reviewId} (${f.error})`).join('; ') +
      ` — re-running on retry`,
    );
  }

  // All reconciles succeeded → fully completed.
  await sql`
    UPDATE zernio_backfill_runs
    SET completed_at = NOW(), updated_at = NOW()
    WHERE business_id = ${business_id}
  `;

  logger.log(
    `Backfill complete business=${business_id} tier=${subscription_tier}: ` +
    `gap=${gap.length}/${gapAll.length} historical=${historical.length}/${histAll.length}`,
  );

  await markOutboxCompleted(outboxId, attempt);
}
```

- [ ] **Step 13.2: Write tests**

Create `worker/__tests__/ZernioBackfillWorker.test.ts` covering spec §10.1 list:

```ts
describe('handleZernioBackfill', () => {
  it('first run: gap-only fixture → processes ≤25, writes counts, completed_at set', async () => { /* ... */ });
  it('first run: historical-only fixture, premium tier → processes ≤50', async () => { /* ... */ });
  it('first run: historical fixture, founding tier → historical=0, historicalSkipped=total', async () => { /* ... */ });
  it('mixed gap+historical: caps applied per bucket; oldest_skipped_create_time set', async () => { /* ... */ });
  it('answered review with active legacy SerpAPI draft → reconcile supersedes it', async () => { /* ... */ });
  it('answered review whose reply text matches our approved_text → reconcile no-ops (no false supersession)', async () => { /* ... */ });
  it('createTime DESC sort applied BEFORE slice(0, cap)', async () => {
    // Seed 30 unanswered reviews with dates spanning 2 years. Run backfill.
    // Assert the 25 processed reviews are the 25 newest (not the first 25
    // returned by Zernio).
  });
  it('subscription cancelled → no Zernio call, completed_at set, outbox completed', async () => { /* ... */ });
  it('suppress_notification=true propagates into every generate_response payload', async () => { /* ... */ });
  it('zernio_backfill_runs row populated with bucket counts + tier + activated_at snapshot', async () => { /* ... */ });
  it('MOCK_EXTERNAL_APIS=true: empty listAllReviews → backfill_runs row written with all-zero counts and completed_at', async () => { /* ... */ });
  it('one reconcile throws → counts updated, completed_at NULL, worker throws → BullMQ retry → resume runs cleanly (round-6 fix)', async () => {
    // Seed: two answered reviews, second one's reconcile throws. Run worker.
    // Assert: counts updated, completed_at IS NULL, worker rejected.
    // Re-invoke the worker (simulating BullMQ retry); assert it picks up
    // (row exists with completed_at NULL → resumes), reconcile both, sets
    // completed_at.
  });
});
```

- [ ] **Step 13.3: Run + commit**

Run: `pnpm test -- worker/__tests__/ZernioBackfillWorker.test.ts`

Expected: PASS.

```bash
git add worker/jobs/ZernioBackfillWorker.ts worker/__tests__/ZernioBackfillWorker.test.ts
git commit -m "$(cat <<'EOF'
feat(workers): ZernioBackfillWorker — first-connect tier-aware backfill

Idempotent via zernio_backfill_runs.completed_at IS NOT NULL sentinel
(round-3 fix). Buckets reviews by createTime vs subscription_activated_at;
gap cap=25 all tiers, historical cap=50 premium only. Already-answered
reviews routed through reconcileExternallyAnsweredReview so pre-existing
legacy drafts are correctly superseded (round-5 fix). All processed
responses ride suppress_notification=true so 75 emails don't blast on
first connect (spec §4.6).

Reconcile failures collected per-review; if any failed, throw at end
BEFORE setting completed_at so BullMQ retries the whole backfill
(round-6 fix). Partial counts are always written so ops can audit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: `worker/ingress/zernio.ts` — fan-out webhook handler

**Files:**
- Modify: `worker/ingress/zernio.ts`

- [ ] **Step 14.1: Replace counter with fan-out outbox enqueue**

Locate the existing `review.new` / `review.updated` handler in `worker/ingress/zernio.ts:185-193`. Replace the counter increment with:

```ts
import { parseZernioReviewWebhook, ZernioReviewWebhookParseError } from '@/lib/zernio/parse-review-webhook';

// ... existing imports retained (claim_inbound_event, sql, signature verify, etc.) ...

case 'review.new':
case 'review.updated': {
  let parsed;
  try {
    parsed = parseZernioReviewWebhook(body);
  } catch (err) {
    if (err instanceof ZernioReviewWebhookParseError) {
      console.warn(`${LOG_PREFIX} ${eventType} unparseable: ${err.message}`);
      break;  // 200 OK — Zernio shouldn't retry malformed payloads
    }
    throw err;
  }

  // Fan out: one outbox row per active connection at this Zernio account.
  // The ingest worker filters by location AFTER fetching the review.
  await sql`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    SELECT
      gen_random_uuid(),
      'ingest_zernio_review',
      'business',
      zc.business_id,
      jsonb_build_object(
        'business_id', zc.business_id,
        'zernio_account_id', ${parsed.accountId},
        'zernio_location_id', zc.zernio_location_id,
        'zernio_review_id', ${parsed.reviewId},
        'correlation_id', ${eventId}
      ),
      'pending'
    FROM zernio_connections zc
    WHERE zc.zernio_account_id = ${parsed.accountId}
      AND zc.status = 'active'
  `;
  break;
}
```

Preserve the existing `claim_inbound_event` flow ABOVE this case — webhook dedup runs first. Also preserve the `account.disconnected` handler verbatim (the `body.account?.id` nested-shape lab note from CLAUDE.md still applies there).

- [ ] **Step 14.2: Add ingress test**

In `worker/ingress/__tests__/zernio-ingress.test.ts` (or whichever file currently tests this route):

```ts
describe('worker/ingress/zernio — review.new fan-out', () => {
  it('two active connections at the same account → two outbox rows', async () => {
    // Seed: businesses B1 and B2 each with active zernio_connection at
    // accountA (different locations). Fire review.new webhook with
    // accountId=accountA. Assert: two ingest_zernio_review outbox rows
    // created, one per business, each with the corresponding location_id.
  });

  it('parse error → 200 OK without outbox enqueue', async () => {
    // Fire webhook with malformed body (missing review). Assert: 200 OK,
    // zero new ingest_zernio_review rows.
  });

  it('no active connections at the account → 200 OK, zero outbox rows', async () => { /* ... */ });
});
```

- [ ] **Step 14.3: Run + commit**

Run: `pnpm test -- worker/ingress/__tests__/zernio-ingress.test.ts`

Expected: PASS.

```bash
git add worker/ingress/zernio.ts worker/ingress/__tests__/zernio-ingress.test.ts
git commit -m "$(cat <<'EOF'
feat(zernio): webhook fan-out for review.new / review.updated

Replaces the counter-increment placeholder with parseZernioReviewWebhook
+ a single INSERT … SELECT that emits one ingest_zernio_review outbox row
per active connection at the firing Zernio account. The ingest worker
filters by location after fetching the review (per §4.3 fan-out
architecture).

Malformed payloads return 200 OK with a console.warn — Zernio retries
7× over 51h, and we don't want to retry permanent bad shapes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: Register ingest + backfill workers in `worker/index.ts`

**Files:**
- Modify: `worker/index.ts`

- [ ] **Step 15.1: Register the new BullMQ workers**

In `worker/index.ts`:
- Locate the section where existing workers (`ResponseGeneratorWorker`, `ResponsePublisherWorker`, `NotificationWorker`, etc.) are constructed via `new Worker(QUEUE_NAMES.X, handler, { connection })`.
- Remove the `ReviewSyncWorker` and any `startReconciliationPoller()` calls (those are deleted in Task 23, but stop registering them here now).
- Add the two new workers:

```ts
import {
  handleZernioReviewIngest,
  ZernioIngestReviewNotFoundError,
  ZernioIngestUnparseableLocationError,
} from './jobs/ZernioReviewIngestWorker';
import { handleZernioBackfill } from './jobs/ZernioBackfillWorker';
import { extractOutboxHandle, markOutboxFailed } from '@/lib/shared/outbox-helpers';
import { jsonb } from '@/lib/db/jsonb';
import { randomUUID as uuidv7 } from 'node:crypto';
import { sql } from '@/lib/db/server';

// ... existing worker construction ...

const ingestZernioReviewWorker = new Worker<IngestZernioReviewPayload>(
  QUEUE_NAMES.INGEST_ZERNIO_REVIEW,
  handleZernioReviewIngest,
  { connection: redisConnection, concurrency: 5 },
);

const zernioBackfillWorker = new Worker<ZernioInitialBackfillPayload>(
  QUEUE_NAMES.ZERNIO_INITIAL_BACKFILL,
  handleZernioBackfill,
  { connection: redisConnection, concurrency: 1 },  // serial — backfill is heavy
);
```

Pick concurrency values consistent with existing workers (review the file's existing `concurrency:` settings; 5 for ingest is a sensible default since each job is short).

- [ ] **Step 15.2: Register `on('failed')` hook for ingest worker**

Per spec §6.5, register a hook on `ingestZernioReviewWorker` that escalates typed errors to `review_exceptions` after retry exhaustion:

```ts
ingestZernioReviewWorker.on('failed', async (job, err) => {
  if (!job) return;
  if (job.attemptsMade < (job.opts.attempts ?? 5)) return;  // not yet exhausted

  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);

  // ── ZernioIngestReviewNotFoundError ──────────────────────────────
  if (err instanceof ZernioIngestReviewNotFoundError) {
    await sql`
      INSERT INTO review_exceptions (id, business_id, type, status, payload)
      VALUES (
        ${uuidv7()}, ${err.businessId}, 'zernio_review_not_found', 'open',
        ${jsonb({
          provider: 'zernio',
          provider_review_id: err.zernioReviewId,
          zernio_account_id: err.zernioAccountId,
          zernio_location_id: err.zernioLocationId,
          retries_exhausted_at: new Date().toISOString(),
        })}
      )
      ON CONFLICT (business_id, type, (payload->>'provider_review_id'))
        WHERE status = 'open' AND review_id IS NULL
      DO NOTHING
    `;
    // Note: NOT enqueueing notify_admin_review_exception — high-volume during
    // Zernio outages would spam admin email. Ops watches review_exceptions
    // table directly. Spec §6.5.
    await markOutboxFailed(outboxId, 'zernio_review_not_found_after_retries', outboxAttempt);
    return;
  }

  // ── ZernioIngestUnparseableLocationError ─────────────────────────
  if (err instanceof ZernioIngestUnparseableLocationError) {
    const [exception] = await sql<{ id: string }[]>`
      INSERT INTO review_exceptions (id, business_id, type, status, payload)
      VALUES (
        ${uuidv7()}, ${err.businessId}, 'zernio_unparseable_review_name', 'open',
        ${jsonb({
          provider: 'zernio',
          provider_review_id: err.zernioReviewId,
          zernio_account_id: err.zernioAccountId,
          zernio_location_id: err.zernioLocationId,
          review_name_truncated: err.reviewName.slice(0, 500),
          retries_exhausted_at: new Date().toISOString(),
        })}
      )
      ON CONFLICT (business_id, type, (payload->>'provider_review_id'))
        WHERE status = 'open' AND review_id IS NULL
      DO NOTHING
      RETURNING id
    `;

    if (exception) {
      // Unparseable shape DOES warrant admin notify — signals contract change.
      await sql`
        INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts)
        VALUES (
          ${uuidv7()}, 'notify_admin_review_exception', 'business',
          ${err.businessId},
          ${jsonb({ review_exception_id: exception.id, business_id: err.businessId })},
          0, 5
        )
      `;
    }
    await markOutboxFailed(outboxId, 'zernio_unparseable_review_name', outboxAttempt);
    return;
  }

  // Anything else: bare markOutboxFailed (existing behavior).
  const reason = err instanceof Error ? err.message : String(err);
  await markOutboxFailed(outboxId, reason, outboxAttempt);
});
```

The ON CONFLICT clause MUST use `(payload->>'provider_review_id')` byte-for-byte — that matches the existing `idx_review_exceptions_collision_dedup` partial unique index from migration 005.

- [ ] **Step 15.3: Update graceful shutdown**

Add `ingestZernioReviewWorker` and `zernioBackfillWorker` to the existing `await Promise.all([...].map(w => w.close()))` shutdown block (or whatever pattern the file uses). Verify nothing was missed by grepping for `.close()` in `worker/index.ts` after the edit.

- [ ] **Step 15.4: Type-check + commit**

Run: `pnpm tsc --noEmit`

Expected: PASS for `worker/index.ts`. Other files referencing `sync_reviews` may still fail; resolved in Tasks 22-23.

```bash
git add worker/index.ts
git commit -m "$(cat <<'EOF'
feat(workers): register ingest + backfill workers; ingest onFailed hook

Registers ingestZernioReviewWorker (concurrency 5) and
zernioBackfillWorker (concurrency 1, serial) in the worker boot.
Unregisters ReviewSyncWorker + ReconciliationPoller (file deletions
follow in a later commit).

ingestZernioReviewWorker.on('failed') escalates typed errors after
retry exhaustion: ZernioIngestReviewNotFoundError → review_exceptions
type='zernio_review_not_found' (no admin notify, high-volume); 
ZernioIngestUnparseableLocationError → review_exceptions
type='zernio_unparseable_review_name' + admin notify (signals Zernio
contract change). ON CONFLICT clause matches the migration-005 partial
unique index byte-for-byte.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 16: Connect callback — enqueue backfill on first activation

**Files:**
- Modify: `src/app/api/zernio/connect/select-location/route.ts`

- [ ] **Step 16.1: Verify the file path**

Run:

```bash
ls src/app/api/zernio/connect/select-location/route.ts
```

Expected: file exists. (Spec §6.8 verified the path; do NOT use `/api/dashboard/connect/...` which doesn't exist.)

- [ ] **Step 16.2: Add the same-tx backfill enqueue**

Locate the `sql.begin(async (tx) => {...})` block where `zernio_connections.status` is flipped to `'active'`. Inside the SAME transaction, after the activation UPDATE, add the `needs_backfill` predicate + outbox enqueue per spec §6.8:

```ts
import { randomUUID as uuidv7 } from 'node:crypto';
import { jsonb } from '@/lib/db/jsonb';

await sql.begin(async (tx) => {
  // ... existing logic that updates zernio_connections to status='active' ...
  // (assume this binds `justActivatedConnectionId`, `accountId`, `locationId`,
  //  and `businessId` in scope)

  // Backfill-needed predicate (round-final M2 fix). Fires when EITHER:
  //   (a) this is the first time the business has had a connected_at-set
  //       Zernio connection (original first-activation case), OR
  //   (b) prior connections existed but no backfill has ever COMPLETED
  //       (zernio_backfill_runs has no row OR row exists with completed_at IS NULL).
  const [{ needs_backfill }] = await tx<{ needs_backfill: boolean }[]>`
    SELECT (
      NOT EXISTS (
        SELECT 1 FROM zernio_connections
        WHERE business_id = ${businessId}
          AND id != ${justActivatedConnectionId}
          AND connected_at IS NOT NULL
      )
      OR NOT EXISTS (
        SELECT 1 FROM zernio_backfill_runs
        WHERE business_id = ${businessId}
          AND completed_at IS NOT NULL
      )
    ) AS needs_backfill
  `;

  if (needs_backfill) {
    const [bizRow] = await tx<{
      subscription_tier: string;
      subscription_activated_at: Date | null;
    }[]>`
      SELECT subscription_tier, subscription_activated_at
      FROM businesses WHERE id = ${businessId}
    `;

    if (bizRow.subscription_activated_at) {
      const correlationId = uuidv7();
      await tx`
        INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
        VALUES (
          ${uuidv7()},
          'zernio_initial_backfill',
          'business',
          ${businessId},
          ${jsonb({
            business_id: businessId,
            zernio_account_id: accountId,
            zernio_location_id: locationId,
            subscription_tier: bizRow.subscription_tier,
            subscription_activated_at: bizRow.subscription_activated_at,
            correlation_id: correlationId,
          })},
          'pending'
        )
      `;
    } else {
      // Pre-payment connect — connect flow is gated on active subscription
      // upstream, so this branch is unreachable. Defensive log.
      console.warn(`[zernio-connect] Connect succeeded but subscription_activated_at NULL for ${businessId}`);
    }
  }
});
```

- [ ] **Step 16.3: Add a route test**

In `src/app/api/zernio/connect/select-location/__tests__/route.test.ts` (create if absent):

```ts
describe('POST /api/zernio/connect/select-location — backfill enqueue', () => {
  it('first activation: zernio_initial_backfill outbox row created in same tx', async () => { /* ... */ });
  it('prior completed backfill exists: NO new backfill enqueue (skipped)', async () => { /* ... */ });
  it('prior connection but no completed backfill: enqueues backfill (round-final M2 fix)', async () => {
    // Seed: zernio_connections row with connected_at IS NOT NULL but no
    // zernio_backfill_runs row (or row with completed_at IS NULL — partial
    // crash). Activate a new connection. Assert backfill outbox enqueued.
  });
  it('subscription_activated_at IS NULL: no backfill enqueued, warn logged', async () => { /* ... */ });
});
```

- [ ] **Step 16.4: Run + commit**

Run: `pnpm test -- src/app/api/zernio/connect/select-location`

Expected: PASS.

```bash
git add src/app/api/zernio/connect/select-location/route.ts \
        src/app/api/zernio/connect/select-location/__tests__/route.test.ts
git commit -m "$(cat <<'EOF'
feat(zernio): enqueue zernio_initial_backfill on connect callback

Same-transaction enqueue of zernio_initial_backfill when the
needs_backfill predicate is satisfied. Predicate fires when EITHER no
prior connect existed for this business OR no completed backfill row
exists (handles the case where a prior backfill auth-failed mid-flight
— round-final M2 fix). Worker's ON CONFLICT (business_id) DO NOTHING
on zernio_backfill_runs is the second-line guard.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 17: `publisher-error-handlers.ts` — extract terminal helpers + new error classes

**Files:**
- Create: `worker/jobs/publisher-error-handlers.ts`
- Create: `worker/__tests__/publisher-error-handlers.test.ts`

This task extracts the existing in-worker auth + permanent error blocks from `ResponsePublisherWorker.ts:294-440` into shared helpers (per spec §6.10b prerequisite) AND adds two new error classes (`PublisherTransientWithContext`, `ZernioReplyVerificationIndeterminateError`) needed by the 409 verifier. The publisher itself is updated in Task 19.

- [ ] **Step 17.1: Write the implementation**

Create `worker/jobs/publisher-error-handlers.ts`:

```ts
// worker/jobs/publisher-error-handlers.ts
//
// Shared terminal-sequence helpers extracted from ResponsePublisherWorker
// in/around lines 294-440 (spec §6.10b prerequisite). Both the in-worker
// branches AND the new 409 verifier (spec §6.10b) call into these helpers
// so the canonical sequences (disconnect-pinned-to-account-and-location +
// park response + notify; mark response failed + open exception + notify
// admin) live in ONE place.
//
// Also exports two new error classes used by the 409 verifier path:
//   PublisherTransientWithContext — wraps ZernioTransientError with the
//     attempt's account+location so the failed-hook can pin the disconnect
//     (round-11/12 fix).
//   ZernioReplyVerificationIndeterminateError — thrown when the 409
//     verifier can't determine whether the existing reply is ours or
//     external (review not found after pagination, OR found-but-reply-null).

import { randomUUID as uuidv7 } from 'node:crypto';
import { sql } from '@/lib/db/server';
import { jsonb } from '@/lib/db/jsonb';
import { ZernioTransientError } from '@/lib/zernio/errors';
import { markOutboxCompleted } from '@/lib/shared/outbox-helpers';
import type { WorkerLogger } from '@/lib/shared/logger';

// ────────────────────────────────────────────────────────────────────────
// Error classes
// ────────────────────────────────────────────────────────────────────────

/** Wraps a ZernioTransientError with the publisher's attempt context so
 *  the failed hook can pin the disconnect to the attempted account+location.
 *  Subclasses ZernioTransientError so existing `instanceof ZernioTransientError`
 *  checks continue to pass.
 *
 *  ZernioTransientError's constructor signature is (kind: string, meta:
 *  Record<string, unknown>) per src/lib/zernio/errors.ts. Forward inner.kind
 *  verbatim so retry-classification logic that switches on kind keeps working.
 */
export class PublisherTransientWithContext extends ZernioTransientError {
  constructor(
    inner: ZernioTransientError,
    readonly attemptContext: {
      response_id: string;
      business_id: string;
      account_id: string;
      location_id: string;
    },
  ) {
    super(inner.kind, inner.meta);
    this.cause = inner;
    this.name = 'PublisherTransientWithContext';
  }
}

/** Thrown by the publisher 409 verifier when the existing reply on Google
 *  cannot be verified as ours-vs-external (review not found after walking
 *  4 pages, OR found but reviewReply=null which suggests Zernio listReviews
 *  lag). The publisher's failed-hook lands the full terminal sequence on
 *  retry exhaustion: response→failed, review_exception type=
 *  'zernio_reply_verification_indeterminate', admin notify. */
export class ZernioReplyVerificationIndeterminateError extends Error {
  constructor(readonly meta: {
    response_id: string;
    business_id: string;
    review_id: string;
    account_id: string;
    location_id: string;
    zernio_review_id: string;
    reason:
      | 'review_not_found_after_pagination'
      | 'review_found_but_reply_null'
      | 'verifier_unknown_error';
    pages_walked?: number;
    reviews_seen?: number;
    /** Underlying error message when reason='verifier_unknown_error'. */
    underlying_error?: string;
  }) {
    super(`[409 verifier indeterminate] ${meta.reason} (response=${meta.response_id})`);
    this.name = 'ZernioReplyVerificationIndeterminateError';
  }
}

// ────────────────────────────────────────────────────────────────────────
// Terminal helpers
// ────────────────────────────────────────────────────────────────────────

interface AuthErrorTerminalArgs {
  response_id: string;
  business_id: string;
  account_id: string;
  location_id: string;
  error_body: string;
  outboxId: string;
  outboxAttempt: number;
  correlation_id?: string;
  logger: WorkerLogger;
}

/**
 * Full terminal sequence for ZernioAuthError on the publish path:
 *   1. Disconnect the matching active zernio_connections row (PINNED to
 *      account_id + location_id — round-10 fix; un-pinned races a fresh
 *      reconnect at a different location).
 *   2. Park the response at status='awaiting_owner_connect' with
 *      posting_error='zernio_auth_error'.
 *   3. Enqueue notify_owner_reconnect (response-scoped, response.review_id).
 *   4. Enqueue notify_owner_connection_lost (business-scoped, capped to one
 *      per UTC day via migration 026 dedup index).
 *   5. markOutboxCompleted.
 *
 * Idempotent: re-call on already-disconnected connection / already-parked
 * response no-ops cleanly (UPDATE…RETURNING 1 + count checks).
 */
export async function handlePublisherAuthErrorTerminal(args: AuthErrorTerminalArgs): Promise<void> {
  const {
    response_id, business_id, account_id, location_id,
    error_body, outboxId, outboxAttempt, logger,
  } = args;

  await sql.begin(async (tx) => {
    // 1. Disconnect — pinned to account + location.
    const disconnected = await tx`
      UPDATE zernio_connections
      SET status = 'disconnected',
          disconnected_at = NOW(),
          disconnect_reason = 'auth_error_on_publish',
          last_error = ${error_body},
          last_error_at = NOW(),
          updated_at = NOW()
      WHERE business_id = ${business_id}
        AND zernio_account_id = ${account_id}
        AND zernio_location_id = ${location_id}
        AND status = 'active'
      RETURNING 1
    `;

    // 2. Park the response.
    const parked = await tx<{ review_id: string }[]>`
      UPDATE responses
      SET status = 'awaiting_owner_connect',
          posting_error = 'zernio_auth_error',
          updated_at = NOW()
      WHERE id = ${response_id}
        AND business_id = ${business_id}
        AND status IN ('approved', 'edited')
      RETURNING review_id
    `;

    if (parked.length === 0) {
      // Already terminal — skip notify enqueues so we don't spam the owner.
      logger.warn(`Response ${response_id} already terminal — skipping reconnect notify`);
      return;
    }

    const reviewId = parked[0].review_id;

    // 3. Enqueue notify_owner_reconnect (response-scoped).
    await tx`
      INSERT INTO job_outbox (
        id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts
      ) VALUES (
        ${uuidv7()}, 'notify_owner_reconnect', 'response', ${response_id},
        ${jsonb({ response_id, business_id, review_id: reviewId })}, 0, 5
      )
    `;

    // 4. Enqueue notify_owner_connection_lost (business-scoped) ONLY if we
    //    actually disconnected something. Otherwise a sibling worker already
    //    enqueued it.
    if (disconnected.count > 0) {
      await tx`
        INSERT INTO job_outbox (
          id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts
        ) VALUES (
          ${uuidv7()}, 'notify_owner_connection_lost', 'business', ${business_id},
          ${jsonb({ kind: 'connection_lost', business_id })}, 0, 5
        )
      `;
    }
  });

  await markOutboxCompleted(outboxId, outboxAttempt);
}

interface PermanentErrorTerminalArgs {
  response_id: string;
  business_id: string;
  review_id: string;
  endpoint_kind: string;
  http_status: number;
  error_body: unknown;
  outboxId: string;
  outboxAttempt: number;
  logger: WorkerLogger;
}

/**
 * Full terminal sequence for ZernioPermanentError / ZernioValidationError on
 * the publish path:
 *   1. Mark response failed with posting_error='zernio_permanent_4xx'.
 *   2. Open review_exception type='zernio_permanent_4xx' (idempotent
 *      ON CONFLICT (review_id, type) DO UPDATE).
 *   3. Enqueue notify_admin_review_exception.
 *   4. markOutboxCompleted.
 */
export async function handlePublisherPermanentErrorTerminal(args: PermanentErrorTerminalArgs): Promise<void> {
  const {
    response_id, business_id, review_id, endpoint_kind, http_status,
    error_body, outboxId, outboxAttempt, logger,
  } = args;

  await sql.begin(async (tx) => {
    const updated = await tx`
      UPDATE responses
      SET status = 'failed',
          posting_error = 'zernio_permanent_4xx',
          updated_at = NOW()
      WHERE id = ${response_id}
        AND business_id = ${business_id}
        AND status IN ('approved', 'edited', 'awaiting_owner_connect')
      RETURNING 1
    `;
    if (updated.count === 0) return;

    const [exception] = await tx<{ id: string }[]>`
      INSERT INTO review_exceptions (id, business_id, review_id, response_id, type, payload)
      VALUES (
        ${uuidv7()}, ${business_id}, ${review_id}, ${response_id},
        'zernio_permanent_4xx',
        ${jsonb({
          endpoint_kind,
          http_status,
          error_body,
          retries_exhausted_at: new Date().toISOString(),
        })}
      )
      ON CONFLICT (review_id, type) WHERE status = 'open'
      DO UPDATE SET payload = review_exceptions.payload
      RETURNING id
    `;

    if (exception) {
      await tx`
        INSERT INTO job_outbox (
          id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts
        ) VALUES (
          ${uuidv7()}, 'notify_admin_review_exception', 'review',
          ${review_id},
          ${jsonb({ review_exception_id: exception.id, business_id })},
          0, 5
        )
      `;
    }
  });

  await markOutboxCompleted(outboxId, outboxAttempt);
  logger.warn(`Response ${response_id} permanently failed (${endpoint_kind} ${http_status}) — exception opened`);
}
```

> **Note on `ON CONFLICT (review_id, type) WHERE status = 'open'`.** Verify this matches the existing partial unique index in the codebase (likely from migration 005 or similar). If the actual index differs, adjust the ON CONFLICT clause byte-for-byte (Postgres requires exact match).

- [ ] **Step 17.2: Write tests**

Create `worker/__tests__/publisher-error-handlers.test.ts`:

```ts
describe('handlePublisherAuthErrorTerminal', () => {
  it('disconnects only the connection at the supplied account_id + location_id (regression for round-10)', async () => {
    // Seed: business B with TWO active connections — accountA/locL and
    // accountA/locM. Run helper for accountA/locL. Assert: locL row
    // disconnected; locM row UNCHANGED.
  });

  it('does NOT disconnect a sibling fresh active row at different account', async () => { /* ... */ });

  it('skips notify_owner_reconnect enqueue when response is already terminal', async () => {
    // Mirrors existing in-worker behavior at lines 324-332.
  });

  it('connection already disconnected → no connection_lost enqueue (sibling already did)', async () => { /* ... */ });

  it('happy path: response → awaiting_owner_connect, both notify rows enqueued', async () => { /* ... */ });
});

describe('handlePublisherPermanentErrorTerminal', () => {
  it('inserts review_exception with ON CONFLICT DO UPDATE (idempotent on re-call)', async () => { /* ... */ });
  it('skips notify enqueue when response already terminal', async () => { /* ... */ });
  it('payload contains endpoint_kind, http_status, error_body', async () => { /* ... */ });
});

describe('PublisherTransientWithContext', () => {
  it('subclasses ZernioTransientError (instanceof check passes)', () => {
    const inner = new ZernioTransientError('timeout', { httpStatus: 504 });
    const wrapped = new PublisherTransientWithContext(inner, {
      response_id: 'R', business_id: 'B', account_id: 'A', location_id: 'L',
    });
    expect(wrapped instanceof ZernioTransientError).toBe(true);
  });

  it('forwards inner.kind to super constructor', () => {
    const inner = new ZernioTransientError('http_5xx', { httpStatus: 503 });
    const wrapped = new PublisherTransientWithContext(inner, {
      response_id: 'R', business_id: 'B', account_id: 'A', location_id: 'L',
    });
    expect((wrapped as ZernioTransientError).kind).toBe('http_5xx');
  });

  it('exposes attemptContext for failed-hook unwrap', () => {
    const wrapped = new PublisherTransientWithContext(
      new ZernioTransientError('network_error', {}),
      { response_id: 'R', business_id: 'B', account_id: 'A', location_id: 'L' },
    );
    expect(wrapped.attemptContext).toEqual({
      response_id: 'R', business_id: 'B', account_id: 'A', location_id: 'L',
    });
  });
});

describe('ZernioReplyVerificationIndeterminateError', () => {
  it('carries meta with reason + ids + optional underlying_error', () => {
    const e = new ZernioReplyVerificationIndeterminateError({
      response_id: 'R', business_id: 'B', review_id: 'rev', account_id: 'A',
      location_id: 'L', zernio_review_id: 'zr', reason: 'verifier_unknown_error',
      underlying_error: 'connection refused',
    });
    expect(e.meta.reason).toBe('verifier_unknown_error');
    expect(e.meta.underlying_error).toBe('connection refused');
  });
});
```

- [ ] **Step 17.3: Run + commit**

Run: `pnpm test -- worker/__tests__/publisher-error-handlers.test.ts`

Expected: PASS.

```bash
git add worker/jobs/publisher-error-handlers.ts worker/__tests__/publisher-error-handlers.test.ts
git commit -m "$(cat <<'EOF'
feat(workers): publisher-error-handlers — shared terminal helpers

handlePublisherAuthErrorTerminal + handlePublisherPermanentErrorTerminal
extract the canonical disconnect-park-notify and fail-exception-notify
sequences from ResponsePublisherWorker so the new 409 verifier can call
the same code instead of duplicating it.

Auth helper pins disconnect to (business + account + location) — round-10
fix for the race where a sibling fresh reconnect at a different location
could be disconnected by a stale auth error.

Also exports PublisherTransientWithContext (wraps ZernioTransientError
with attempt context for failed-hook pinning — round-11/12) and
ZernioReplyVerificationIndeterminateError (thrown by 409 verifier on
review-not-found-after-pagination / found-but-reply-null /
verifier-unknown-error — round-8/9).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 18: Widen `applyTransientExhaustionFallback` + `lookupZernioReviewId` location pin

**Files:**
- Modify: `src/lib/publishing/zernio-publisher.ts`

- [ ] **Step 18.1: Widen `applyTransientExhaustionFallback`**

Locate the helper in `src/lib/publishing/zernio-publisher.ts` (around line 140 per spec). Add optional `account_id` + `location_id` params to its signature; when both are provided, the disconnect WHERE clause adds `AND zernio_account_id = ${account_id} AND zernio_location_id = ${location_id}`. Backwards compatible — when either is absent, fall back to existing un-pinned behavior (kept as a safety net for any caller that lacks context).

```ts
export async function applyTransientExhaustionFallback(args: {
  response_id: string;
  business_id: string;
  correlation_id?: string;
  account_id?: string;       // ADDED — round-11
  location_id?: string;      // ADDED — round-11
}): Promise<void> {
  const { response_id, business_id, correlation_id, account_id, location_id } = args;

  await sql.begin(async (tx) => {
    // Disconnect — pin when context provided.
    if (account_id && location_id) {
      await tx`
        UPDATE zernio_connections
        SET status = 'disconnected',
            disconnected_at = NOW(),
            disconnect_reason = 'transient_exhaustion',
            updated_at = NOW()
        WHERE business_id = ${business_id}
          AND zernio_account_id = ${account_id}
          AND zernio_location_id = ${location_id}
          AND status = 'active'
      `;
    } else {
      await tx`
        UPDATE zernio_connections
        SET status = 'disconnected',
            disconnected_at = NOW(),
            disconnect_reason = 'transient_exhaustion',
            updated_at = NOW()
        WHERE business_id = ${business_id}
          AND status = 'active'
      `;
    }

    // ... existing response-park + notify enqueues unchanged ...
  });
}
```

(Preserve the existing response-park + notify enqueue logic; only the disconnect WHERE clause changes.)

- [ ] **Step 18.2: Update `lookupZernioReviewId` signature + early-return**

Locate `lookupZernioReviewId` in `src/lib/publishing/zernio-publisher.ts:48`. Per spec §6.11, expand SELECT, add `locationId` arg, gate early-return on EXACT location match:

```ts
export async function lookupZernioReviewId(
  businessId: string,
  ourReviewId: string,
  accountId: string,
  locationId: string,        // ADDED — required (round-2 M4 fix)
): Promise<string> {
  const cacheKey = `zernio:reviewId:${businessId}:${ourReviewId}`;
  const cached = await redis.get(cacheKey);
  if (cached) return cached;

  type OurReviewRowExpanded = {
    reviewer_name: string;
    review_date: Date;
    review_text: string | null;
    star_rating: number;
    provider: string;
    provider_review_id: string | null;
    provider_location_name: string | null;
  };

  const [ourReview] = await sql<OurReviewRowExpanded[]>`
    SELECT reviewer_name, review_date, review_text, star_rating,
           provider, provider_review_id, provider_location_name
    FROM reviews
    WHERE id = ${ourReviewId} AND business_id = ${businessId}
    LIMIT 1
  `;

  if (!ourReview) {
    throw new ZernioReviewNotFoundError({ ourReviewId, accountId, reason: 'review_not_found' });
  }

  // Early-return for Zernio-sourced rows: provider_review_id IS canonical.
  // REQUIRE EXACT location match — same-account different-location row is
  // NOT safe to short-circuit (would target the wrong GBP location).
  if (ourReview.provider === 'zernio') {
    const expectedLocationName = `zernio://${accountId}/locations/${locationId}`;
    if (
      ourReview.provider_location_name === expectedLocationName &&
      ourReview.provider_review_id !== null
    ) {
      await redis.setex(cacheKey, CACHE_TTL_SECONDS, ourReview.provider_review_id);
      return ourReview.provider_review_id;
    }
    // provider says zernio but location MISMATCH — fall through to field-match
    // (which will throw ReviewNotFoundError if it can't reconcile).
  }

  // Existing field-match path for legacy provider='serpapi_poll' rows
  // (or zernio rows where the connection swapped to a different location).
  // Preserve existing field-match logic verbatim. The listAllReviews call
  // here was updated to pass locationId in Task 6.
  // ... existing field-match impl ...
}
```

- [ ] **Step 18.3: Update the publisher caller**

`worker/jobs/ResponsePublisherWorker.ts:111-116` already loads `zernioConnection.zernio_location_id`. Find the `lookupZernioReviewId(...)` call site and add the fourth argument — `zernioConnection.zernio_location_id`. (This is a single-line edit at the call site; the actual publisher refactor lands in Task 19.)

- [ ] **Step 18.4: Tests**

In `src/lib/publishing/__tests__/zernio-publisher.test.ts`:

```ts
describe('lookupZernioReviewId — early-return location gating', () => {
  it('exact provider_location_name match → returns provider_review_id from cache', async () => { /* ... */ });
  it('provider=zernio but location MISMATCH → falls through to field-match', async () => { /* ... */ });
  it('provider=serpapi_poll → always falls through to field-match (regression)', async () => { /* ... */ });
});

describe('applyTransientExhaustionFallback — pinned vs un-pinned', () => {
  it('with account_id + location_id: disconnects ONLY the matching active connection', async () => { /* ... */ });
  it('without account_id / location_id: disconnects all active rows for the business (legacy behavior)', async () => { /* ... */ });
  it('round-11 regression: stale transient exhaustion for accountA/loc1 does NOT disconnect fresh active row at accountA/loc2 when pinned', async () => { /* ... */ });
});
```

- [ ] **Step 18.5: Run + commit**

Run: `pnpm test -- src/lib/publishing/__tests__/zernio-publisher.test.ts`

Expected: PASS.

```bash
git add src/lib/publishing/zernio-publisher.ts src/lib/publishing/__tests__/zernio-publisher.test.ts
git commit -m "$(cat <<'EOF'
fix(zernio): lookupZernioReviewId location pin + transient fallback context

lookupZernioReviewId now requires locationId. Early-return for
provider='zernio' gates on EXACT provider_location_name match
('zernio://{accountId}/locations/{locationId}') — same-account
different-location rows fall through to field-match instead of
short-circuiting to the wrong GBP location (round-2 M4).

applyTransientExhaustionFallback signature widened to accept optional
account_id + location_id. When both supplied, disconnect WHERE clause
pins to that specific connection — closes the same stale-disconnect race
that round-10 fixed for the auth path. Un-pinned mode preserved as
safety net for any caller that lacks context (round-11/12).

Caller in ResponsePublisherWorker passes zernio_location_id from the
connection row already in scope. Field-match listAllReviews call uses
locationId per Task 6.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 19: `ResponsePublisherWorker` — refactor + 409 verify-first flow

**Files:**
- Modify: `worker/jobs/ResponsePublisherWorker.ts`
- Modify: `worker/__tests__/ResponsePublisherWorker.test.ts`

This is the biggest refactor in the plan. Three sub-changes inside one file:
1. Replace inline auth-error block (lines 294-368) with call to `handlePublisherAuthErrorTerminal`.
2. Replace inline permanent-error block (lines 371-440) with call to `handlePublisherPermanentErrorTerminal`.
3. Replace unconditional 409 mark-posted (lines 278-292) with verify-first flow.
Also: wrap every `ZernioTransientError` rethrow with `PublisherTransientWithContext`.

- [ ] **Step 19.1: Replace inline auth-error block**

Locate the existing in-worker auth handler block (around lines 294-368). Replace with:

```ts
import {
  handlePublisherAuthErrorTerminal,
  handlePublisherPermanentErrorTerminal,
  PublisherTransientWithContext,
  ZernioReplyVerificationIndeterminateError,
} from './publisher-error-handlers';
import { canonicalizeReplyText } from '@/lib/zernio/canonicalize-reply';
import { createHash } from 'node:crypto';

// ... in the postReply error-classification chain ...

if (err instanceof ZernioAuthError) {
  await handlePublisherAuthErrorTerminal({
    response_id,
    business_id,
    account_id: zernioConnection.zernio_account_id,
    location_id: zernioConnection.zernio_location_id,
    error_body: err.body ? String(err.body).slice(0, 500) : err.message,
    outboxId,
    outboxAttempt,
    correlation_id: job.data.correlation_id,
    logger,
  });
  return;
}
```

- [ ] **Step 19.2: Replace inline permanent-error block**

Locate the existing permanent block (lines 371-440). Replace with:

```ts
if (err instanceof ZernioPermanentError || err instanceof ZernioValidationError) {
  const endpointKind =
    err instanceof ZernioPermanentError && typeof err.meta?.endpointKind === 'string'
      ? err.meta.endpointKind
      : 'publish_reply';
  const errBody =
    err instanceof ZernioPermanentError ? err.meta : { code: err.code, body: err.body };

  await handlePublisherPermanentErrorTerminal({
    response_id,
    business_id,
    review_id: response.review_id,
    endpoint_kind: endpointKind,
    http_status: 400,
    error_body: errBody,
    outboxId,
    outboxAttempt,
    logger,
  });
  return;
}
```

- [ ] **Step 19.3: Replace 409 mark-posted with verify-first flow**

Locate the existing 409 branch (lines 278-292). Replace with the full verify-first flow per spec §6.10b:

```ts
if (err instanceof ZernioReplyAlreadyExistsError) {
  // Walk pages — Zernio paginates at 50, target review may be older than
  // the most recent 50.
  let allReviews: ZernioReview[];
  try {
    allReviews = await zernioClient.listAllReviews(
      zernioConnection.zernio_account_id,
      {
        locationId: zernioConnection.zernio_location_id,
        pageSize: 50,
        maxPages: 4,
      },
    );
  } catch (lookupErr) {
    if (lookupErr instanceof ZernioTransientError) {
      // Wrap with attempt context so retry-exhaustion hits pinned fallback.
      logger.warn(
        `409 verifier hit transient error for response ${response_id}: ${lookupErr.message} — wrapping for retry`,
      );
      throw new PublisherTransientWithContext(lookupErr, {
        response_id,
        business_id,
        account_id: zernioConnection.zernio_account_id,
        location_id: zernioConnection.zernio_location_id,
      });
    }
    if (lookupErr instanceof ZernioAuthError) {
      logger.warn(`409 verifier hit auth error for response ${response_id}`);
      await handlePublisherAuthErrorTerminal({
        response_id,
        business_id,
        account_id: zernioConnection.zernio_account_id,
        location_id: zernioConnection.zernio_location_id,
        error_body: lookupErr.body ? String(lookupErr.body).slice(0, 500) : lookupErr.message,
        outboxId,
        outboxAttempt,
        correlation_id: job.data.correlation_id,
        logger,
      });
      return;
    }
    if (lookupErr instanceof ZernioPermanentError || lookupErr instanceof ZernioValidationError) {
      logger.error(`409 verifier hit permanent error for response ${response_id}: ${lookupErr.message}`);
      const endpointKind =
        lookupErr instanceof ZernioPermanentError && typeof lookupErr.meta?.endpointKind === 'string'
          ? lookupErr.meta.endpointKind
          : 'list_reviews';
      const errBody =
        lookupErr instanceof ZernioPermanentError
          ? lookupErr.meta
          : { code: lookupErr.code, body: lookupErr.body };
      await handlePublisherPermanentErrorTerminal({
        response_id,
        business_id,
        review_id: response.review_id,
        endpoint_kind: endpointKind,
        http_status: 400,
        error_body: errBody,
        outboxId,
        outboxAttempt,
        logger,
      });
      return;
    }
    // Unknown error — wrap as indeterminate so failed-hook escalates cleanly
    // on retry exhaustion (round-9 fix).
    logger.warn(
      `409 verifier hit unknown error for response ${response_id}: ` +
      `${lookupErr instanceof Error ? lookupErr.message : lookupErr} — wrapping as indeterminate, retrying`,
    );
    throw new ZernioReplyVerificationIndeterminateError({
      response_id, business_id, review_id: response.review_id,
      account_id: zernioConnection.zernio_account_id,
      location_id: zernioConnection.zernio_location_id,
      zernio_review_id: zernioReviewId,
      reason: 'verifier_unknown_error',
      underlying_error: lookupErr instanceof Error ? lookupErr.message : String(lookupErr),
    });
  }

  const found = allReviews.find(r => r.id === zernioReviewId);

  if (!found) {
    logger.warn(
      `409 verifier could not locate review ${zernioReviewId} after walking ${allReviews.length} reviews — indeterminate, retrying`,
    );
    throw new ZernioReplyVerificationIndeterminateError({
      response_id, business_id, review_id: response.review_id,
      account_id: zernioConnection.zernio_account_id,
      location_id: zernioConnection.zernio_location_id,
      zernio_review_id: zernioReviewId,
      reason: 'review_not_found_after_pagination',
      pages_walked: 4, reviews_seen: allReviews.length,
    });
  }

  const existingReply = found.reviewReply ?? null;

  if (existingReply === null) {
    // Zernio said reply_already_exists (409) but listReviews shows no reply.
    // Eventual-consistency lag — indeterminate.
    logger.warn(
      `409 verifier found review ${zernioReviewId} but reviewReply=null — indeterminate (Zernio lag?), retrying`,
    );
    throw new ZernioReplyVerificationIndeterminateError({
      response_id, business_id, review_id: response.review_id,
      account_id: zernioConnection.zernio_account_id,
      location_id: zernioConnection.zernio_location_id,
      zernio_review_id: zernioReviewId,
      reason: 'review_found_but_reply_null',
    });
  }

  const existingText = canonicalizeReplyText(existingReply.comment);
  const ourText = canonicalizeReplyText(approvedText);

  if (existingText === ourText) {
    // Our previously-posted reply — idempotent success.
    await sql`
      UPDATE responses
      SET status = 'posted', posted_at = NOW(), updated_at = NOW()
      WHERE id = ${response_id}
        AND business_id = ${business_id}
        AND status IN ('approved', 'edited', 'awaiting_owner_connect')
    `;
    logger.log(`Response ${response_id} already posted on Zernio (409, text match), marked posted`);
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  // Different text — external reply confirmed. Supersede.
  await sql`
    UPDATE responses
    SET status = 'superseded',
        posting_error = 'already_replied_external',
        updated_at = NOW()
    WHERE id = ${response_id}
      AND business_id = ${business_id}
      AND status IN ('approved', 'edited', 'awaiting_owner_connect')
  `;
  // Log lengths + 12-char hash prefixes — never plaintext (round-9 fix).
  const fp = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);
  logger.warn(
    `Response ${response_id} 409 text mismatch — ` +
    `existing(len=${existingText.length},fp=${fp(existingText)}) ` +
    `ours(len=${ourText.length},fp=${fp(ourText)}) ` +
    `— superseded as already_replied_external`,
  );
  await markOutboxCompleted(outboxId, outboxAttempt);
  return;
}
```

- [ ] **Step 19.4: Wrap transient throws**

Locate every place in `ResponsePublisherWorker.ts` where a `ZernioTransientError` is rethrown (the postReply catch + any other transient-propagation point). Each one becomes:

```ts
if (err instanceof ZernioTransientError) {
  throw new PublisherTransientWithContext(err, {
    response_id,
    business_id,
    account_id: zernioConnection.zernio_account_id,
    location_id: zernioConnection.zernio_location_id,
  });
}
throw err;
```

This is required so the `worker/index.ts` failed-hook (Task 20) can unwrap and pin the disconnect.

- [ ] **Step 19.5: Update call to `lookupZernioReviewId`**

Add `zernioConnection.zernio_location_id` as the fourth argument (per Task 18.3):

```ts
const zernioReviewId = await lookupZernioReviewId(
  business_id,
  response.review_id,
  zernioConnection.zernio_account_id,
  zernioConnection.zernio_location_id,
);
```

- [ ] **Step 19.6: Add publisher tests per spec §6.10d**

In `worker/__tests__/ResponsePublisherWorker.test.ts`:

```ts
describe('ResponsePublisherWorker — 409 verify-first flow', () => {
  it('409 + target found on page 1 with matching text → response marked posted', async () => { /* ... */ });
  it('409 + target found on page 2 with matching text → response marked posted (round-7 page-2 regression)', async () => { /* ... */ });
  it('409 + target found with different text → response superseded with already_replied_external', async () => { /* ... */ });
  it('409 + target found but reviewReply=null → throws ZernioReplyVerificationIndeterminateError reason=review_found_but_reply_null; response NOT superseded (round-8)', async () => { /* ... */ });
  it('409 + target NOT found after 4 pages → throws indeterminate reason=review_not_found_after_pagination; response NOT superseded (round-7)', async () => { /* ... */ });
  it('final-attempt exhaustion: failed-hook fires → response failed + review_exception zernio_reply_verification_indeterminate + admin notify', async () => {
    // Mock BullMQ to invoke on('failed') with attemptsMade === maxAttempts.
    // Assert response.status='failed', posting_error='zernio_reply_verification_indeterminate'.
    // Assert review_exception row inserted with type='zernio_reply_verification_indeterminate'.
    // Assert admin notify outbox enqueued.
    // Assert outbox completed.
  });
  it('409 + listReviews ZernioTransientError → caught + rethrown as PublisherTransientWithContext (round-12)', async () => {
    // Assert thrown instance is PublisherTransientWithContext (NOT bare ZernioTransientError).
    // Assert attemptContext = { response_id, business_id, account_id, location_id }.
  });
  it('409 + listReviews ZernioAuthError → handlePublisherAuthErrorTerminal called with attempted account_id (round-7 unpinned-disconnect regression)', async () => { /* ... */ });
  it('409 + listReviews ZernioPermanentError → handlePublisherPermanentErrorTerminal called; review_exception inserted (round-7)', async () => { /* ... */ });
  it('409 + listReviews unknown error → wrapped in ZernioReplyVerificationIndeterminateError reason=verifier_unknown_error with underlying_error populated (round-9)', async () => { /* ... */ });

  it('canonicalization: existing reply has CRLF, ours has LF → text match → posted (round-8)', async () => {
    // existingReply.comment = 'hello\r\nworld'; approvedText = 'hello\nworld'.
    // Assert response marked 'posted' (NOT falsely superseded).
  });
  it('canonicalization: NFC vs NFD Unicode forms → text match → posted', async () => { /* ... */ });
  it('log redaction: text-mismatch log line contains len= and fp= but NO plaintext slice (round-9)', async () => {
    // Trigger text-mismatch path. Capture logger output. Assert no chunk of
    // either reply's plaintext (e.g. first 8 chars) appears in any log line.
  });
});
```

- [ ] **Step 19.7: Run + commit**

Run: `pnpm test -- worker/__tests__/ResponsePublisherWorker.test.ts`

Expected: PASS.

```bash
git add worker/jobs/ResponsePublisherWorker.ts worker/__tests__/ResponsePublisherWorker.test.ts
git commit -m "$(cat <<'EOF'
fix(publisher): 409 verify-first + extracted helpers + transient context wrap

Replaces unconditional 409 mark-posted (lines 278-292) with verify-first
flow: walk listAllReviews up to 4 pages, classify lookup errors, and
mark posted only on confirmed text-match. Mismatch → supersede.
Indeterminate (not-found-after-pagination, found-but-reply-null,
verifier-unknown-error) → throw ZernioReplyVerificationIndeterminateError
which the worker/index.ts failed-hook escalates on retry exhaustion.

Inline auth + permanent error blocks (lines 294-440) refactored to call
shared handlePublisherAuthErrorTerminal +
handlePublisherPermanentErrorTerminal — same canonical sequences are
now reused by the 409 verifier (round-7).

Every ZernioTransientError rethrow wraps with PublisherTransientWithContext
so the failed-hook can pin the disconnect to the attempted account+
location (round-11/12).

lookupZernioReviewId callsite passes zernio_location_id from the
connection in scope (round-2 M4 fix).

Log redaction on text-mismatch: lengths + 12-char SHA-256 fingerprints,
never plaintext (round-9).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 20: `worker/index.ts` — publisher onFailed hook update

**Files:**
- Modify: `worker/index.ts`

- [ ] **Step 20.1: Add indeterminate branch BEFORE existing transient branch**

In `worker/index.ts:139-194` (or wherever `publisherWorker.on('failed', ...)` is registered), update the hook per spec §6.10c:

```ts
import {
  PublisherTransientWithContext,
  ZernioReplyVerificationIndeterminateError,
} from './jobs/publisher-error-handlers';

publisherWorker.on('failed', async (job, err) => {
  if (!job) return;

  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);

  // ── ZernioReplyVerificationIndeterminateError (round-8/9) ──────────
  // BEFORE the transient branch — full terminal sequence on retry exhaustion.
  if (err instanceof ZernioReplyVerificationIndeterminateError) {
    await sql.begin(async (tx) => {
      const updated = await tx`
        UPDATE responses
        SET status = 'failed',
            posting_error = 'zernio_reply_verification_indeterminate',
            updated_at = NOW()
        WHERE id = ${err.meta.response_id}
          AND business_id = ${err.meta.business_id}
          AND status IN ('approved', 'edited', 'awaiting_owner_connect')
        RETURNING 1
      `;
      if (updated.count === 0) return;

      const [exception] = await tx<{ id: string }[]>`
        INSERT INTO review_exceptions (
          id, business_id, review_id, response_id, type, payload
        ) VALUES (
          ${uuidv7()}, ${err.meta.business_id}, ${err.meta.review_id},
          ${err.meta.response_id}, 'zernio_reply_verification_indeterminate',
          ${jsonb({
            reason: err.meta.reason,
            zernio_account_id: err.meta.account_id,
            zernio_location_id: err.meta.location_id,
            zernio_review_id: err.meta.zernio_review_id,
            pages_walked: err.meta.pages_walked,
            reviews_seen: err.meta.reviews_seen,
            underlying_error: err.meta.underlying_error,
            retries_exhausted_at: new Date().toISOString(),
          })}
        )
        ON CONFLICT (review_id, type) WHERE status = 'open'
        DO UPDATE SET payload = review_exceptions.payload
        RETURNING id
      `;

      if (exception) {
        await tx`
          INSERT INTO job_outbox (
            id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts
          ) VALUES (
            ${uuidv7()}, 'notify_admin_review_exception', 'review',
            ${err.meta.review_id},
            ${jsonb({ review_exception_id: exception.id, business_id: err.meta.business_id })},
            0, 5
          )
        `;
      }
    });
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  // ── ZernioTransientError — UPDATED to unwrap PublisherTransientWithContext ─────
  if (err instanceof ZernioTransientError) {
    const ctx = err instanceof PublisherTransientWithContext ? err.attemptContext : null;
    try {
      await applyTransientExhaustionFallback({
        response_id: ctx?.response_id ?? job.data.response_id,
        business_id: ctx?.business_id ?? job.data.business_id,
        correlation_id: job.data.correlation_id,
        account_id: ctx?.account_id,
        location_id: ctx?.location_id,
      });
      await markOutboxCompleted(outboxId, outboxAttempt);
    } catch (fallbackErr) {
      const reason = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      await markOutboxFailed(
        outboxId,
        `zernio_transient_max_attempts_fallback_failed: ${reason}`,
        outboxAttempt,
      );
    }
    return;
  }

  // ── Non-transient unhandled errors — existing behavior ──
  const reason = err instanceof Error ? err.message : String(err);
  await markOutboxFailed(outboxId, reason, outboxAttempt);
});
```

- [ ] **Step 20.2: Verify ordering**

The indeterminate branch MUST land BEFORE the transient branch. PublisherTransientWithContext extends ZernioTransientError; the transient branch's `instanceof` check would otherwise match indeterminate-wrapped errors that aren't actually transient (though indeterminate doesn't extend transient — defense is keeping order explicit anyway).

- [ ] **Step 20.3: Type-check + commit**

Run: `pnpm tsc --noEmit`

Expected: PASS.

```bash
git add worker/index.ts
git commit -m "$(cat <<'EOF'
fix(workers): publisher failed-hook indeterminate branch + transient unwrap

ZernioReplyVerificationIndeterminateError gets a dedicated branch BEFORE
the transient branch — full terminal sequence on retry exhaustion:
response → 'failed' with posting_error='zernio_reply_verification_indeterminate',
review_exceptions ON CONFLICT (review_id, type) DO UPDATE so concurrent
indeterminates dedup, admin notify enqueue, outbox completed (round-8/9).

ZernioTransientError branch unwraps PublisherTransientWithContext when
present so applyTransientExhaustionFallback receives account_id +
location_id and pins the disconnect (round-11/12). Bare
ZernioTransientError still falls through to un-pinned mode as a safety
net for any non-publisher caller.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 21: `AdminExceptionWorker.ts` — type-aware `renderExceptionBody`

**Files:**
- Modify: `worker/jobs/AdminExceptionWorker.ts`
- Modify: `worker/__tests__/AdminExceptionWorker.test.ts`

- [ ] **Step 21.1: Update SELECT to include `re.review_id`**

In `worker/jobs/AdminExceptionWorker.ts:27-34` (or current location of the exception SELECT), add `re.review_id` to the column list:

```ts
const [exception] = await sql<ExceptionRow[]>`
  SELECT
    re.id, re.business_id, re.review_id, re.response_id, re.type, re.status,
    re.payload, re.created_at,
    r.reviewer_name, r.star_rating, r.review_text,
    b.business_name
  FROM review_exceptions re
  LEFT JOIN reviews r ON r.id = re.review_id
  LEFT JOIN businesses b ON b.id = re.business_id
  WHERE re.id = ${reviewExceptionId}
`;
```

Update `ExceptionRow` to include `review_id: string | null`.

- [ ] **Step 21.2: Replace hardcoded body with `renderExceptionBody` switch**

Locate `worker/jobs/AdminExceptionWorker.ts:61-72` (the hardcoded `review_edited_after_post` copy). Extract into a `renderExceptionBody(exception, payload)` function with a type switch. Use the implementation from spec §6.10b' verbatim. The reviewer block gates on `exception.review_id !== null`, NOT `reviewer_name` (round-11):

```ts
function renderExceptionBody(
  exception: ExceptionRow,
  payload: Record<string, unknown>,
): string {
  const reviewerBlock = exception.review_id !== null
    ? `<p><strong>Reviewer:</strong> ${escapeHtml(exception.reviewer_name ?? 'Unknown reviewer')} ${exception.star_rating ? `(${'★'.repeat(exception.star_rating)}${'☆'.repeat(5 - exception.star_rating)})` : ''}</p>` +
      `<p><strong>Current review text:</strong></p>` +
      `<blockquote style="border-left:3px solid #ccc;padding:8px 12px;margin:8px 0;color:#555;">` +
      `${exception.review_text ? escapeHtml(exception.review_text) : '<em>No text</em>'}</blockquote>`
    : '<p><em>No local review record (this exception was opened before the review was ingested).</em></p>';

  const fmt = (v: unknown) => v == null ? '—' : escapeHtml(String(v));

  switch (exception.type) {
    case 'review_edited_after_post':
      return `${reviewerBlock}
        <p><strong>What happened:</strong> The reviewer edited their review after a response was already posted. The response may no longer be appropriate for the updated review.</p>
        <p><strong>Response status at time of edit:</strong> ${fmt(payload.response_status)}</p>
        <p><strong>Action needed:</strong> Review the situation and decide whether to regenerate a new response, dismiss the exception, or handle it manually.</p>`;

    case 'zernio_review_not_found':
      return `${reviewerBlock}
        <p><strong>What happened:</strong> Zernio sent a webhook for a review (id <code>${fmt(payload.provider_review_id)}</code>), but after retries the worker could not locate it via Zernio's listReviews API. The review may have been deleted at Zernio, or there may be eventual-consistency lag.</p>
        <p><strong>Zernio account / location:</strong> ${fmt(payload.zernio_account_id)} / ${fmt(payload.zernio_location_id)}</p>
        <p><strong>Retries exhausted at:</strong> ${fmt(payload.retries_exhausted_at)}</p>
        <p><strong>Action needed:</strong> Verify the review's current state in the customer's Google Business Profile. If it still exists, manual reconciliation may be needed; if deleted, dismiss the exception.</p>`;

    case 'zernio_permanent_4xx':
      return `${reviewerBlock}
        <p><strong>What happened:</strong> Posting the reply via Zernio failed with a permanent 4xx error. This is request-specific (likely malformed input or a Zernio config drift), not a connection issue.</p>
        <p><strong>Endpoint:</strong> ${fmt(payload.endpoint_kind)}</p>
        <p><strong>HTTP status:</strong> ${fmt(payload.http_status)}</p>
        <p><strong>Action needed:</strong> Inspect the error_body in the exception payload, fix the underlying issue, and either regenerate or dismiss.</p>`;

    case 'zernio_reply_verification_indeterminate':
      return `${reviewerBlock}
        <p><strong>What happened:</strong> Zernio rejected our reply with 409 reply_already_exists, but verification could not determine whether the existing reply is ours or external (after retries).</p>
        <p><strong>Reason:</strong> ${fmt(payload.reason)}</p>
        <p><strong>Zernio account / location / review:</strong> ${fmt(payload.zernio_account_id)} / ${fmt(payload.zernio_location_id)} / ${fmt(payload.zernio_review_id)}</p>
        ${payload.underlying_error ? `<p><strong>Underlying error:</strong> ${fmt(payload.underlying_error)}</p>` : ''}
        <p><strong>Action needed:</strong> Check the customer's Google Business Profile to see what reply (if any) is now visible on this review. If it's our text, mark the response posted manually; if it's external, dismiss as already-replied-external.</p>`;

    case 'zernio_unparseable_review_name':
      return `${reviewerBlock}
        <p><strong>What happened:</strong> Zernio's review.name field did not match the expected <code>accounts/{a}/locations/{l}/reviews/{r}</code> resource path. The ingest worker refused to process the review (fail-closed) because routing depends on extracting the location segment.</p>
        <p><strong>Affected review:</strong></p>
        <pre style="background:#f5f5f5;padding:8px;border-radius:4px;overflow:auto;">${escapeHtml(String(payload.review_name_truncated ?? '—'))}</pre>
        <p><strong>Zernio account / location:</strong> ${fmt(payload.zernio_account_id)} / ${fmt(payload.zernio_location_id)}</p>
        <p><strong>Action needed:</strong> Verify Zernio's API documentation for review.name shape changes. If Zernio's contract changed, update <code>extractLocationFromReviewName</code> and <code>REVIEW_NAME_RE</code> in <code>src/lib/reviews/zernio-normalize.ts</code> + <code>src/lib/zernio/parse-review-webhook.ts</code> to accept the new shape. Once fixed, re-enqueue affected ingest_zernio_review outbox rows. This is a cross-cutting Zernio API contract change — investigate immediately.</p>`;

    default: {
      const safeFields = Object.entries(payload)
        .filter(([_, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null)
        .map(([k, v]) => `<li><code>${escapeHtml(k)}</code>: ${fmt(v)}</li>`)
        .join('');
      return `${reviewerBlock}
        <p><strong>Exception type:</strong> <code>${escapeHtml(exception.type)}</code></p>
        <p>This exception type does not have a specific email template yet. Payload fields:</p>
        <ul>${safeFields}</ul>
        <p>See the admin dashboard for full payload + handling guidance.</p>`;
    }
  }
}
```

Wire `renderExceptionBody(exception, payload)` into the email-body construction (replacing the hardcoded `<p><strong>What happened:</strong> The reviewer edited their review...</p>` literal).

- [ ] **Step 21.3: Tests per spec §6.10b'**

In `worker/__tests__/AdminExceptionWorker.test.ts`:

```ts
describe('renderExceptionBody', () => {
  it('review_edited_after_post: renders existing copy (regression)', () => { /* ... */ });
  it('zernio_review_not_found with review_id IS NULL: no reviewer block / "no local review record" copy', () => { /* ... */ });
  it('zernio_review_not_found: payload.provider_review_id, account_id, location_id appear in body', () => { /* ... */ });
  it('zernio_permanent_4xx: endpoint + http_status appear; no "reviewer edited" copy', () => { /* ... */ });
  it('zernio_reply_verification_indeterminate: reason, account/location/review ids, underlying_error appear', () => { /* ... */ });
  it('zernio_unparseable_review_name: payload.review_name_truncated appears in <pre>', () => { /* ... */ });
  it('anonymous reviewer (review_id non-null, reviewer_name=null) → renders block with "Unknown reviewer" (round-11)', () => { /* ... */ });
  it('unknown type: falls through to generic fallback; lists payload primitives; does NOT render misleading review_edited copy', () => { /* ... */ });
});
```

- [ ] **Step 21.4: Run + commit**

Run: `pnpm test -- worker/__tests__/AdminExceptionWorker.test.ts`

Expected: PASS.

```bash
git add worker/jobs/AdminExceptionWorker.ts worker/__tests__/AdminExceptionWorker.test.ts
git commit -m "$(cat <<'EOF'
fix(workers): AdminExceptionWorker renders type-aware email bodies

renderExceptionBody switches on exception.type to surface the right
fields per type. Five cases plus a generic fallback that lists payload
primitives — never the misleading "reviewer edited" copy as default
(round-10).

SELECT now includes re.review_id so the reviewer block can gate on row
presence, not reviewer_name. Anonymous reviewers (reviewer_name=NULL but
real review_id) correctly render the block with "Unknown reviewer"
copy (round-11).

zernio_review_not_found rows have review_id=NULL (review never ingested)
so the reviewer block is replaced with a "no local review record" note.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 22: Remove SerpAPI `sync_reviews` producers

**Files:**
- Modify: `src/app/api/onboarding/business/route.ts`
- Modify: `src/lib/onboarding/create-business.ts`
- Modify: `worker/jobs/PlaceIdValidationWorker.ts`
- Modify: `worker/__tests__/PlaceIdValidationWorker.test.ts`

- [ ] **Step 22.1: `src/app/api/onboarding/business/route.ts`**

Locate lines 179-191 (the `topic='sync_reviews'` enqueue branch in the PlaceAutocomplete-verified path). Remove the entire branch. The path now just sets `place_id_verified=true` and exits.

- [ ] **Step 22.2: `src/lib/onboarding/create-business.ts`**

Locate lines 246-262 (the `placeIdVerified` branch's sync_reviews enqueue). Remove the sync_reviews INSERT. Keep the `else if (googleMapsUrl)` branch's `validate_place_id` enqueue intact — the validation worker still resolves URLs.

- [ ] **Step 22.3: `worker/jobs/PlaceIdValidationWorker.ts`**

Remove the entire `enqueueSyncReviews` helper (likely around lines 101-122) and its call site. The worker still:
- Resolves the URL → placeId
- Persists the result to `businesses.place_id`
- Marks `place_id_verified=true`

It just doesn't enqueue review sync anymore.

- [ ] **Step 22.4: `worker/__tests__/PlaceIdValidationWorker.test.ts`**

Update tests at lines 85, 120, 165 (or wherever the worker is asserted to enqueue sync_reviews). FLIP the assertions:

```ts
it('does NOT enqueue sync_reviews after marking place_id_verified=true', async () => {
  // Run worker. Assert place_id_verified=true on business row. Assert
  // ZERO job_outbox rows with topic='sync_reviews'.
});
```

- [ ] **Step 22.5: Run + commit**

Run:

```bash
pnpm test -- worker/__tests__/PlaceIdValidationWorker.test.ts
pnpm test -- src/app/api/onboarding/__tests__
```

Expected: PASS.

```bash
git add src/app/api/onboarding/business/route.ts \
        src/lib/onboarding/create-business.ts \
        worker/jobs/PlaceIdValidationWorker.ts \
        worker/__tests__/PlaceIdValidationWorker.test.ts
git commit -m "$(cat <<'EOF'
refactor: remove SerpAPI sync_reviews producers

Three producers eliminated per spec §6.9: the PlaceAutocomplete-verified
branch in onboarding/business/route.ts; the placeIdVerified branch in
create-business.ts; the enqueueSyncReviews helper in
PlaceIdValidationWorker.

PlaceIdValidationWorker still resolves URL → placeId + marks
place_id_verified=true; it just doesn't fan out to review sync.

PlaceIdValidationWorker tests now ASSERT that no sync_reviews row is
enqueued (inverse of prior behavior).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 23: Delete SerpAPI consumer files + tests

**Files:**
- Delete: `worker/jobs/ReviewSyncWorker.ts`
- Delete: `worker/__tests__/ReviewSyncWorker.test.ts`
- Delete: `worker/jobs/ReconciliationPoller.ts`
- Delete: `src/lib/reviews/serpapi-monitor.ts`
- Delete: `src/lib/reviews/mock-monitor.ts`
- Delete: `src/lib/reviews/__tests__/serpapi-monitor.test.ts` (if present)
- Modify: `src/lib/shared/mock-mode.ts`
- Modify: `worker/__tests__/correlation-chain.test.ts`

> **`SerpApiSource` is NOT deleted** — it's still used by `DemoGenerationWorker` (spec §1, §2 non-goals). Keep `src/lib/reviews/serpapi-source.ts` intact.

- [ ] **Step 23.1: Delete files**

```bash
rm worker/jobs/ReviewSyncWorker.ts
rm worker/__tests__/ReviewSyncWorker.test.ts
rm worker/jobs/ReconciliationPoller.ts
rm src/lib/reviews/serpapi-monitor.ts
rm src/lib/reviews/mock-monitor.ts
```

If `src/lib/reviews/__tests__/serpapi-monitor.test.ts` exists, delete it too:

```bash
[ -f src/lib/reviews/__tests__/serpapi-monitor.test.ts ] && rm src/lib/reviews/__tests__/serpapi-monitor.test.ts
```

- [ ] **Step 23.2: Update `src/lib/shared/mock-mode.ts`**

Drop `getReviewMonitor()` (unused after consumer deletion). Keep `isMockMode()` and any other unrelated exports.

- [ ] **Step 23.3: Rewrite `worker/__tests__/correlation-chain.test.ts` part A**

The "review-sync produces correlation chain" test must be rewritten to test `ingest_zernio_review → generate_response`:

```ts
describe('correlation chain — ingest_zernio_review', () => {
  it('correlation_id from ingest_zernio_review payload propagates to generate_response payload', async () => {
    // Seed: zernio_connections row, business active, mock listReviews to
    // return one review. Insert ingest_zernio_review outbox row with
    // correlation_id='corr-test-1'. Run dispatcher → ingest worker.
    // Assert: a generate_response outbox row exists with payload.correlation_id='corr-test-1'.
  });
});
```

- [ ] **Step 23.4: Run lint + tests**

Run:

```bash
pnpm lint
pnpm test
```

Expected: PASS. Any references to the deleted files in OTHER source files surface here — fix those import errors before committing.

- [ ] **Step 23.5: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor: delete SerpAPI ingestion consumers

Removes the consumer side of sync_reviews per spec §6.9:
  - worker/jobs/ReviewSyncWorker.ts
  - worker/__tests__/ReviewSyncWorker.test.ts
  - worker/jobs/ReconciliationPoller.ts
  - src/lib/reviews/serpapi-monitor.ts
  - src/lib/reviews/mock-monitor.ts
  - src/lib/reviews/__tests__/serpapi-monitor.test.ts (if present)

src/lib/shared/mock-mode.ts: drop getReviewMonitor (unused).

worker/__tests__/correlation-chain.test.ts part A rewritten to assert
correlation_id propagates from ingest_zernio_review → generate_response.

SerpApiSource is preserved — still used by DemoGenerationWorker for
prospect demo generation (spec §2 non-goal).

Migrations 004 + 018 remain in place (immutable). The
idx_jo_sync_reviews_inflight partial index becomes dead after producer
removal — harmless.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 24: Premium tier wiring

**Files:** ten file edits per spec §6.10.

- [ ] **Step 24.1: `src/lib/shared/schemas.ts`**

Update `SelectPlanSchema` enum at line 329:

```ts
export const SelectPlanSchema = z.object({
  tier: z.enum(['founding', 'standard', 'premium']),
  // ... preserve other fields ...
});
```

- [ ] **Step 24.2: `src/app/onboarding/pay/PlanPickerClient.tsx`**

Widen `Plan.tier` to `'founding' | 'standard' | 'premium'`. Add a Premium plan card to the PLANS array at line 6:

```ts
const PLANS: Plan[] = [
  { tier: 'founding',  /* ... existing ... */ },
  { tier: 'standard',  /* ... existing ... */ },
  {
    tier: 'premium',
    name: 'Premium',
    monthlyPriceCents: 19_900,           // confirm with the actual Stripe Price
    description: 'For multi-location brands and high-volume reviewers',
    features: [
      'Everything in Standard',
      'Up to 50 historical reviews backfilled on connect',
      'Priority support',
      // ... reflect actual offering — confirm with stakeholder ...
    ],
  },
];
```

> Confirm with the user the exact display copy + price for the Premium card before merging. The structure is what matters here.

- [ ] **Step 24.3: `src/lib/payments/payment-link.ts`**

Add Premium to the TIER_ENV map:

```ts
export const TIER_ENV: Record<'founding' | 'standard' | 'premium', string> = {
  founding: 'STRIPE_PAYMENT_LINK_FOUNDING',
  standard: 'STRIPE_PAYMENT_LINK_STANDARD',
  premium:  'STRIPE_PAYMENT_LINK_PREMIUM',
};

export function buildPaymentLinkUrl(tier: 'founding' | 'standard' | 'premium', /* ... */): string {
  // ... existing impl with widened tier param ...
}
```

- [ ] **Step 24.4: `worker/ingress/stripe.ts`**

Around lines 179-182, expand the `priceToTier` map:

```ts
const priceToTier: Record<string, 'founding' | 'standard' | 'premium'> = {
  [process.env.STRIPE_PRICE_FOUNDING ?? '']: 'founding',
  [process.env.STRIPE_PRICE_STANDARD ?? '']: 'standard',
  [process.env.STRIPE_PRICE_PREMIUM  ?? '']: 'premium',
};
```

- [ ] **Step 24.5: `src/app/api/onboarding/__tests__/select-plan.test.ts:159`**

Locate the test asserting `tier: 'premium'` returns 400. FLIP it:

```ts
it('accepts tier="premium" and returns the Premium payment link', async () => {
  // Run the endpoint with tier='premium'. Assert 200 + redirect URL
  // matches process.env.STRIPE_PAYMENT_LINK_PREMIUM (mock if needed).
});
```

- [ ] **Step 24.6: `worker/startup-assert.ts`**

In `assertSelfServeSignupEnv` (around lines 21-22), add `STRIPE_PAYMENT_LINK_PREMIUM` to the required env list. Worker must boot-assert it when `SELF_SERVE_SIGNUP_ENABLED=true`. (`MOCK_EXTERNAL_APIS=true` continues to bypass.)

- [ ] **Step 24.7: `.env.example`**

Add (or update) two lines:

```
STRIPE_PAYMENT_LINK_PREMIUM=https://buy.stripe.com/...
STRIPE_PRICE_PREMIUM=price_...
```

- [ ] **Step 24.8: Verify already-correct locations**

Per spec §6.10, three locations ALREADY reference `'premium'`:
- `src/lib/costs/tracker.ts:42-45` (`premium: 2_000` cost limit)
- `src/lib/responses/types.ts:20,42` (`'premium'` in `BusinessContext` union)
- `src/app/api/admin/costs/route.ts:61` (references `DAILY_COST_LIMIT_CENTS_PREMIUM`)

Run `pnpm grep "'premium'"` (or `Grep` tool) to confirm those references exist and look correct. NO change required for these three.

- [ ] **Step 24.9: Run + commit**

Run:

```bash
pnpm tsc --noEmit
pnpm test -- src/app/api/onboarding/__tests__/select-plan.test.ts
pnpm lint
```

Expected: PASS.

```bash
git add src/lib/shared/schemas.ts \
        src/app/onboarding/pay/PlanPickerClient.tsx \
        src/lib/payments/payment-link.ts \
        worker/ingress/stripe.ts \
        worker/startup-assert.ts \
        .env.example \
        src/app/api/onboarding/__tests__/select-plan.test.ts
git commit -m "$(cat <<'EOF'
feat(billing): wire 'premium' tier end-to-end

Activates the existing 'premium' slot (already in cost limits + types)
across schema validation (SelectPlanSchema), the onboarding plan picker,
the Stripe Payment Link map, the Stripe webhook price→tier map, and the
worker startup assertion. .env.example documents the two new vars
STRIPE_PAYMENT_LINK_PREMIUM + STRIPE_PRICE_PREMIUM.

Tests: select-plan.test.ts:159 flipped from "rejects premium" to
"accepts premium" and asserts the Payment Link redirect.

Required prod actions before flag flip: set both env vars in Vercel +
Railway; create the Stripe Price + Payment Link.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 25: Migration 029 — drop `awaiting_manual_post`

**Files:**
- Create: `supabase/migrations/029_drop_awaiting_manual_post.sql`

- [ ] **Step 25.1: Pre-flight audit**

In Supabase SQL editor (dev), run:

```sql
SELECT id, business_id, status, posting_error, updated_at
FROM responses
WHERE status = 'awaiting_manual_post';
```

Expected: zero rows in prod (per CLAUDE.md status). Document any rows found in dev/staging — they'll be terminated by the migration.

- [ ] **Step 25.2: Write migration SQL**

Create `supabase/migrations/029_drop_awaiting_manual_post.sql`:

```sql
-- supabase/migrations/029_drop_awaiting_manual_post.sql
--
-- Decommission the manual-post fallback (spec §6.12b).
--
-- 1. Bulk-fail any orphan 'awaiting_manual_post' rows. Prod has zero
--    such rows per CLAUDE.md; this is defensive for dev/staging fixtures
--    and any rare legacy in-flight data.
-- 2. Rebuild the migration-026 partial unique index without the dead
--    status in its predicate. The index name is preserved so any code
--    that references the constraint name continues to find it.
-- 3. Drop the migration-024 dedup index whose predicate is no longer
--    satisfiable (template='admin_manual_post' won't be produced again
--    after manual-post is deleted in code).
--
-- Apply order: AFTER migration 028 (per spec §12 rollout step 1).

-- 1. Terminate orphan rows.
UPDATE responses
  SET status = 'failed',
      posting_error = 'manual_post_deprecated_2026_04',
      updated_at = NOW()
  WHERE status = 'awaiting_manual_post';

-- 2. Rebuild the non-terminal uniqueness index without 'awaiting_manual_post'.
DROP INDEX IF EXISTS responses_one_non_terminal_per_review;

CREATE UNIQUE INDEX IF NOT EXISTS responses_one_non_terminal_per_review
  ON responses (review_id)
  WHERE status IN (
    'pending_approval',
    'approved',
    'edited',
    'awaiting_owner_connect'
  );

COMMENT ON INDEX responses_one_non_terminal_per_review IS
  'Enforces "at most one non-terminal response per review". Migration 029 '
  'dropped awaiting_manual_post from the predicate after the manual-post '
  'fallback was decommissioned.';

-- 3. Drop the migration-024 dedup index. Predicate template='admin_manual_post'
--    is no longer satisfiable after manual-post code deletion.
DROP INDEX IF EXISTS notification_deliveries_response_template_uniq;
```

- [ ] **Step 25.3: Tell user to run**

Output:

> "Migration 029 SQL ready. Apply it in Supabase SQL editor AFTER migration 028. Verify the index predicate via `\d+ responses_one_non_terminal_per_review` (status list should NOT include `awaiting_manual_post`). Verify removal via `SELECT indexname FROM pg_indexes WHERE indexname = 'notification_deliveries_response_template_uniq'` returns zero rows. Confirm here when done."

- [ ] **Step 25.4: Wait for user, then commit**

```bash
git add supabase/migrations/029_drop_awaiting_manual_post.sql
git commit -m "$(cat <<'EOF'
feat(zernio): migration 029 — drop awaiting_manual_post

Manual-post fallback is decommissioned (spec §6.12b). Migration:
  1. Bulk-fail any orphan 'awaiting_manual_post' rows with
     posting_error='manual_post_deprecated_2026_04' (defensive — prod
     has zero per CLAUDE.md, drains dev/staging fixtures).
  2. Rebuild responses_one_non_terminal_per_review WITHOUT the dead
     status. Index name preserved for any code referencing it.
  3. Drop notification_deliveries_response_template_uniq from migration
     024 — its predicate template='admin_manual_post' is no longer
     satisfiable after the code deletion in the next commit.

Apply order: 028 BEFORE 029.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 26: Delete manual-post UI/code/templates

**Files:**
- Delete: `src/app/admin/businesses/[id]/manual-post-section.tsx`
- Delete: `src/app/admin/businesses/[id]/components/ManualPostFlow.tsx`
- Delete: `src/app/api/admin/businesses/[id]/mark-posted/route.ts`
- Delete: `src/lib/notifications/email/templates/manual-post.ts`
- Delete: `src/lib/notifications/email/templates/__tests__/manual-post.test.ts` (if present)

- [ ] **Step 26.1: Delete files**

```bash
rm src/app/admin/businesses/\[id\]/manual-post-section.tsx
rm src/app/admin/businesses/\[id\]/components/ManualPostFlow.tsx
rm -rf src/app/api/admin/businesses/\[id\]/mark-posted
rm src/lib/notifications/email/templates/manual-post.ts
[ -f src/lib/notifications/email/templates/__tests__/manual-post.test.ts ] && \
  rm src/lib/notifications/email/templates/__tests__/manual-post.test.ts
```

(On Windows bash you may need different escape patterns. Use `rm -rf` for the directory under `[id]/mark-posted` since it likely contains `route.ts` and possibly tests.)

- [ ] **Step 26.2: Modify referencing files (drop imports + render calls + status references)**

| File | Change |
|---|---|
| `src/app/admin/businesses/[id]/page.tsx` | Drop the `awaitingPost` filter at line 51; drop `<ManualPostFlow ... />` render call. |
| `src/components/dashboard/ReviewsList.tsx:13` | Remove the `awaiting_manual_post: 'bg-orange-100 text-orange-800'` color class entry. |
| `src/app/admin/businesses/[id]/components/ReviewsList.tsx:21` | Same color-class removal. |
| `src/lib/shared/response-status.ts` | Remove `'awaiting_manual_post'` from `HANDLED_STATUSES`, `AWAITING_PUBLISH_STATUSES`, `ResponseStatus` union, and any other helper sets in this file. |
| `src/lib/shared/__tests__/response-status.test.ts` | Update tests — remove `'awaiting_manual_post'` assertions; keep `'awaiting_owner_connect'` ones. |
| `src/lib/shared/constants.ts:9` | Remove `AWAITING_MANUAL_POST: 'awaiting_manual_post'` constant. |
| `src/lib/reviews/process-review.ts:161` | Remove `activeResponse.status === 'awaiting_manual_post' \|\|` from the active-status check. |
| `worker/jobs/ResponsePublisherWorker.ts:82-86` | Rewrite the legacy comment about excluding `'awaiting_manual_post'` from `ZERNIO_PUBLISHABLE_STATES` to reflect that the status no longer exists. |
| `worker/__tests__/ResponsePublisherWorker.test.ts:133` | Drop the `['awaiting_manual_post']` table-row test case. |
| `src/app/admin/businesses/[id]/components/ZernioConnectionPanel.tsx:186` | Replace "fall back to the manual-post path until the owner connects" with "stay queued in the dashboard until the owner connects Google". |
| `src/app/admin/businesses/[id]/components/ZernioConnectionPanel.tsx:237-239` | Remove or rewrite comments referencing `awaiting_manual_post` transitions. |
| `src/app/admin/runbook/page.tsx:67` | Replace "Manual posting is normal for MVP" copy with Zernio-only flow language. |
| `src/lib/notifications/email.ts:13` | Remove `export * from './email/templates/manual-post';` barrel re-export. |
| `src/lib/notifications/email/headers.ts:10` | Comment cleanup — replace "manual-post instructions" example with another remaining one (admin exception, partner alerts). |
| `src/lib/notifications/email/templates/internal.ts:3` | Same comment cleanup. |
| `src/lib/notifications/email/templates/shared.ts:7` | Drop `manual-post` from the family enumeration in the comment. |
| `src/lib/notifications/delivery.ts:8` | Drop "ResponsePublisherWorker (admin manual-post emails)" from the comment. |
| `worker/ingress/resend.ts:122,270` | Drop `admin_manual_post` from comment enumerations. |
| `src/lib/notifications/__tests__/delivery.test.ts:51-55` | Replace `'admin_manual_post'` template fixture with `'admin_exception'` (still-valid admin-directed template). |
| `worker/__tests__/resend-webhook-bounce.test.ts:192-197` | Delete the dead `'does NOT flag owner_email_bounced when hard bounce comes from admin_manual_post template'` test case. |

For each item, open the file, locate the line(s) referenced (line numbers approximate as of spec drafting; use Grep to find current locations), and apply the change.

- [ ] **Step 26.3: Run lint + type-check + tests**

Run:

```bash
pnpm lint
pnpm tsc --noEmit
pnpm test
```

Expected: PASS. Fix any leftover compile errors from missed references — grep for `awaiting_manual_post` and `admin_manual_post` to find them:

```bash
# Use Grep tool, not raw grep:
#   pattern: "awaiting_manual_post"  (search whole repo)
#   pattern: "admin_manual_post"
#   pattern: "ManualPostFlow"
#   pattern: "manual-post"
# Acceptance per spec §13: only matches should be in:
#   - Historical migrations: 001, 023, 026
#   - The new migration 029
#   - The plan itself (this file) and the spec
```

- [ ] **Step 26.4: Verify §13 grep acceptance criterion**

Grep for `'awaiting_manual_post'` across `src/` and `worker/`. Expected: zero matches in production code (only in `supabase/migrations/{001,023,026}.sql` — historical/immutable — plus migration 029 which is the cleanup itself).

- [ ] **Step 26.5: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor: decommission manual-post fallback

Deletes:
  - src/app/admin/businesses/[id]/manual-post-section.tsx
  - src/app/admin/businesses/[id]/components/ManualPostFlow.tsx
  - src/app/api/admin/businesses/[id]/mark-posted/
  - src/lib/notifications/email/templates/manual-post.ts (+ tests if present)

Removes 'awaiting_manual_post' from response-status helpers, dashboard
color maps, process-review.ts active-status check, ResponsePublisherWorker
excluded-states list, runbook copy, ZernioConnectionPanel copy, email
headers/templates/delivery comments, resend ingress comments, delivery
test fixture (replaced with admin_exception), resend bounce test case.

Per spec §6.12b — manual-post is dormant in shipped code already (publisher
no-connection branch transitions to awaiting_owner_connect). Migration 029
terminates any orphan rows; this commit removes the code.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 27: Reconnect banner + email — two-clause v17 wording

**Files:** vary depending on where the dashboard banner copy + the `notify_owner_reconnect` email template body live.

- [ ] **Step 27.1: Locate the banner copy**

Run Grep for an existing fragment like "Connect Google Business" or "reconnect" to find the dashboard component (likely `src/components/dashboard/ConnectGoogleBanner.tsx` per CLAUDE.md directory structure).

- [ ] **Step 27.2: Update banner text**

Replace the existing copy with the EXACT v17 two-clause wording from spec §6.12b / §13:

> Reconnect Google Business to resume publishing. If you've already reconnected and this still appears, our Google Reviews integration may be temporarily unavailable; we'll resume automatically once it's restored.

The leading clause prompts the reconnect (correct action ~95% of the time). The trailing clause covers the rare Zernio-outage case for owners who already reconnected.

- [ ] **Step 27.3: Update `notify_owner_reconnect` email body**

Locate the email template (likely `src/lib/notifications/email/templates/reconnect.ts` or similar). Update the body to use the same two-clause wording. Preserve other structure (subject line, button, headers).

- [ ] **Step 27.4: Snapshot test**

Add (or update) a snapshot test in the email-template tests directory:

```ts
it('notify_owner_reconnect email body contains the exact v17 two-clause wording', () => {
  const html = buildReconnectEmail({ /* ... fixture args ... */ });
  expect(html).toContain('Reconnect Google Business to resume publishing');
  expect(html).toContain("If you've already reconnected and this still appears, our Google Reviews integration may be temporarily unavailable");
  expect(html).toContain("we'll resume automatically once it's restored");
});
```

- [ ] **Step 27.5: Run + commit**

Run: `pnpm test -- <reconnect-template-test-path>`

Expected: PASS.

```bash
git add <touched files>
git commit -m "$(cat <<'EOF'
fix(copy): two-clause reconnect wording for banner + email

Per spec §6.12b. Leads with the reconnect ask (the right action ~95% of
the time) and only THEN offers the temporarily-unavailable explanation
for owners who have already reconnected. Single message covers both
genuine auth-disconnect AND Zernio outage without needing a programmatic
"is Zernio up?" indicator.

Snapshot test pins the exact wording so future copy edits don't silently
drift away from the §13 grep acceptance criterion.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 28: Update CLAUDE.md

**Files:**
- Modify: `.claude/CLAUDE.md`

- [ ] **Step 28.1: Update tech stack section**

In `.claude/CLAUDE.md`:
- The `Tech stack` section already lists Zernio. No change needed beyond confirming it.
- The `Reviews: SerpAPI` line should now read: `Reviews: Zernio webhooks (production); SerpAPI (demo + onboarding-prefill + URL→placeId fallback only)`.

- [ ] **Step 28.2: Update response status enum**

Locate the `Response status values` section (around line 139). Remove `'awaiting_manual_post'` from the enum list. Delete the description paragraph at line 142 explaining `awaiting_manual_post`.

- [ ] **Step 28.3: Update Migrations section**

Add entries 028 and 029:

```md
- 028 — Zernio first-connect backfill: `zernio_backfill_runs` table (per-business summary of gap/historical processed + skipped counts; tier and subscription_activated_at snapshotted; partial unique index `zernio_backfill_runs_one_per_business`).
- 029 — Decommission manual-post: bulk-fail orphan `awaiting_manual_post` rows with `posting_error='manual_post_deprecated_2026_04'`, rebuild `responses_one_non_terminal_per_review` without the dead status, drop the migration-024 stale `notification_deliveries_response_template_uniq` index. Apply AFTER migration 028.
```

- [ ] **Step 28.4: Update Current status / pending merges**

Add a new bullet:

```md
6. **Zernio ingestion replace SerpAPI: MERGED YYYY-MM-DD (#NN).** Apply migrations 028+029 in prod Supabase (in that order). Set `STRIPE_PAYMENT_LINK_PREMIUM` + `STRIPE_PRICE_PREMIUM` in prod env. Confirm Zernio webhook URL still points at `${WORKER_PUBLIC_URL}/ingress/zernio`. Manual smoke on staging Zernio sandbox (post a real review on the sandbox GBP, verify webhook → ingest → response in dashboard). Then `ZERNIO_PUBLISHING_ENABLED=true` already controls both publishing + ingestion paths (single flag). No new flag.
```

- [ ] **Step 28.5: Add lab note**

Append to the lab notes section:

```md
- [2026-04-29] Postgres ON CONFLICT clause must reference partial-unique-index expressions BYTE-FOR-BYTE. The migration-005 `idx_review_exceptions_collision_dedup` predicate uses `(payload->>'provider_review_id')`, NOT `provider_review_id` — using the latter as the conflict key in INSERT statements (e.g. for the new zernio_review_not_found exception type) returns "no matching unique constraint" at runtime even when the values are semantically equivalent.
```

- [ ] **Step 28.6: Commit**

```bash
git add .claude/CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: reconcile CLAUDE.md after Zernio ingestion merge

Updates the response status enum (drops awaiting_manual_post),
migrations list (adds 028 + 029 with apply order), tech stack pointer
(Zernio for production, SerpAPI for demo+prefill only), and the pending
prod actions checklist. Adds a lab note about ON CONFLICT byte-for-byte
matching of partial-index predicates (motivated by review_exceptions
migration-005 index reuse).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 29: Integration tests — end-to-end webhook → ingest → generate

**Files:**
- Create or extend: `worker/__tests__/zernio-end-to-end.integration.test.ts`

These tests run against a real Postgres + mocked Zernio HTTP. Per spec §10.2.

- [ ] **Step 29.1: Write the integration test**

```ts
// worker/__tests__/zernio-end-to-end.integration.test.ts
//
// Runs against the project's standard test-DB harness. Skips gracefully
// without TEST_DATABASE_POOL_URL.

describe('Zernio end-to-end pipeline', () => {
  it('webhook → outbox fan-out → ingest worker → review row → response generated', async () => {
    // Seed: one business B with active zernio_connection (acct=A, loc=L).
    // Mock zernioClient.listReviews to return one fixture review.
    // POST a parsed-shape webhook to /worker/ingress/zernio with valid HMAC.
    // Run OutboxPoller dispatch + ingest worker once.
    // Assert: reviews row created with provider='zernio', provider_review_name
    //   matching expected pattern. responses row with status='pending_approval'.
    //   ingest_zernio_review outbox row marked 'completed'.
  });

  it('multi-connection fan-out: 2 businesses sharing one zernio_account, different locations → only correct business gets the review', async () => {
    // Seed: B1 with conn (A, L1), B2 with conn (A, L2). Mock listReviews
    // for accountA: with locationId=L1 returns review at L1; with locationId=L2
    // returns review at L2 (or empty, simulating per-location scoping).
    // Fire webhook for accountA, reviewId=R-at-L1.
    // Assert: B1 gets a reviews row; B2 does NOT.
  });

  it('first-connect backfill: seeded connection + first-activation predicate trip → backfill outbox → worker fetches mocked Zernio response → reviews + responses created → backfill_runs row populated → ZERO approval emails fired', async () => {
    // Seed: business + just-activated connection. Insert
    // zernio_initial_backfill outbox row (mock the connect callback's enqueue).
    // Mock listAllReviews to return a fixture with 30 reviews (15 gap, 15 historical).
    // Run worker. Assert:
    //   - reviews rows created for the 15 gap (cap=25 not hit) + 0 historical
    //     (founding tier).
    //   - responses rows in pending_approval.
    //   - zero send_notification outbox rows enqueued (suppress flag).
    //   - zero notification_deliveries rows.
    //   - zernio_backfill_runs row populated with gap_processed_count=15,
    //     historical_skipped_count=15.
    //   - completed_at IS NOT NULL.
  });

  it('race: backfill mid-loop pauses; webhook arrives for same review id → both serialize via ON CONFLICT → exactly one review row', async () => {
    // Trickier — use a programmable mock to pause the backfill loop after
    // the FOR UPDATE SELECT but before the INSERT, then fire the webhook
    // and let it complete first. Resume backfill. Assert exactly one
    // reviews row exists; the second processReview returned 'unchanged'.
  });
});
```

- [ ] **Step 29.2: Run + commit**

Run: `pnpm test -- worker/__tests__/zernio-end-to-end.integration.test.ts`

Expected: PASS (or skipped gracefully if `TEST_DATABASE_POOL_URL` unset).

```bash
git add worker/__tests__/zernio-end-to-end.integration.test.ts
git commit -m "$(cat <<'EOF'
test(zernio): end-to-end integration coverage for ingest + backfill

Webhook → outbox fan-out → ingest worker → review row → response.
Multi-location fan-out separation. First-connect backfill counts +
suppress-notification invariant. Backfill-vs-webhook race serializes
via ON CONFLICT.

Skips gracefully without TEST_DATABASE_POOL_URL.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 30: Acceptance + rollout checklist

This task is a manual checklist — no code changes. Run AFTER the branch is merged to a deploy branch.

- [ ] **Step 30.1: Pre-merge gates**

Run:

```bash
pnpm test
pnpm lint
pnpm tsc --noEmit
```

Expected: all PASS.

- [ ] **Step 30.2: §13 acceptance grep**

Run Grep:
- Pattern: `'sync_reviews'` — expected matches: only in historical migrations (`004_sync_reviews_dedup_constraint.sql`, `018_correlation_and_dispatching_indexes.sql`) and updated tests in `worker/__tests__/PlaceIdValidationWorker.test.ts` asserting NO enqueue.
- Pattern: `awaiting_manual_post` — expected matches: only in historical migrations (001, 023, 026), the new migration 029, the spec, and this plan.
- Pattern: `admin_manual_post` — expected matches: only in resend ingress historical comment (if cleanup missed) — investigate and clean if found in code.
- Pattern: `buildManualPostEmailHtml` — expected: zero matches.
- Pattern: `ManualPostFlow` — expected: zero matches in code.
- Pattern: `getReviewMonitor` — expected: zero matches.

If any unexpected matches surface, return to the earlier task that should have removed them and fix.

- [ ] **Step 30.3: Apply migrations in prod (in order)**

Per `feedback_supabase_migrations.md` — user runs migrations manually in Supabase SQL editor:

1. **First:** `028_zernio_backfill_runs.sql`. Verify with `\d+ zernio_backfill_runs` that the partial unique index `zernio_backfill_runs_one_per_business` is present.
2. **Then:** `029_drop_awaiting_manual_post.sql`. Verify:
   - `\d+ responses_one_non_terminal_per_review` shows the predicate WITHOUT `awaiting_manual_post`.
   - `SELECT indexname FROM pg_indexes WHERE indexname = 'notification_deliveries_response_template_uniq'` returns zero rows.
   - `SELECT count(*) FROM responses WHERE status='awaiting_manual_post'` returns zero.

- [ ] **Step 30.4: Set premium tier env vars in prod**

Set in Vercel + Railway:
- `STRIPE_PAYMENT_LINK_PREMIUM=https://buy.stripe.com/...`
- `STRIPE_PRICE_PREMIUM=price_...`

Worker startup assertion (when `SELF_SERVE_SIGNUP_ENABLED=true`) requires the Payment Link.

- [ ] **Step 30.5: Verify Zernio webhook configuration**

In the Zernio dashboard, confirm the webhook URL still points at `${WORKER_PUBLIC_URL}/ingress/zernio`. No URL change is required — the existing endpoint now handles `review.new` and `review.updated` in addition to `account.disconnected`.

- [ ] **Step 30.6: Manual smoke — staging Zernio sandbox**

1. Connect a staging business to a real Zernio sandbox profile.
2. On the sandbox GBP, post a fresh review.
3. Watch logs: webhook → outbox row → ingest worker → review row → response generated.
4. Verify in the dashboard: response visible, status `pending_approval`. Owner email received (if no suppress).
5. Approve via email. Verify response posted via Zernio.

Capture this as an amendment to `docs/zernio-launch-runbook.md` (existing).

- [ ] **Step 30.7: Manual smoke — premium plan**

Complete a Stripe Checkout via the new Payment Link with a test card. Verify:
- Webhook flips `subscription_tier` to `'premium'`.
- Onboarding completes.
- On Zernio connect, backfill respects historical bucket cap (=50).
- `zernio_backfill_runs` row written with `subscription_tier='premium'`.

- [ ] **Step 30.8: Flip the flag**

Set `ZERNIO_PUBLISHING_ENABLED=true` in prod (Vercel + Railway). The same flag gates BOTH publishing + ingestion — no separate ingestion flag.

- [ ] **Step 30.9: Pilot customer onboarding**

Onboard one pilot customer per `docs/zernio-launch-runbook.md`. Watch:
- Connect flow completes.
- Backfill outbox row appears + completes within ~60 s.
- Dashboard shows backfilled responses (founding/standard tier: ≤25 gap; premium: ≤25 gap + ≤50 historical).
- Zero approval emails fired during backfill (suppress flag).
- New review on Google → webhook → response generated → email fired (steady state).

- [ ] **Step 30.10: Schedule one-time verification followup**

Offer the user:

> "Want me to /schedule an agent in 7 days to verify Zernio webhook delivery rate, ingest_zernio_review outbox completion stats, and the absence of `zernio_review_not_found` review_exceptions? Catches Zernio API drift early."

- [ ] **Step 30.11: Document the rollout date**

Update `.claude/CLAUDE.md` with the actual merge date (replace `YYYY-MM-DD` and `#NN` from Task 28.4).

```bash
git add .claude/CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: backfill rollout date for Zernio ingestion merge

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Spec coverage cross-check

- §1 motivation, §2 non-goals → handled by SerpAPI removal scope (Tasks 22+23 keep `SerpApiSource`, `serpapi-prefill`, place-id-resolver).
- §3 goals 1–6 → Tasks 14 (eliminate poll), 11–13 (webhook ingestion), 13 (tier-aware backfill), 24 (premium tier), 16 + 13 (use existing `subscription_activated_at`), Task 30.8 (single flag).
- §4.1 three buckets → Task 13 (`ZernioBackfillWorker`).
- §4.2 webhook-driven steady state → Tasks 11, 12, 14, 15.
- §4.3 account-id non-uniqueness fan-out → Task 14 (webhook handler) + Task 12 (worker location filter).
- §4.4 identity strategy → Task 7 (`buildZernioMonitoredReview`).
- §4.5 no reconciliation poller v1 → no task (deferred).
- §4.6 backfill notification suppression → Tasks 8 (process-review propagates flag), 9 (generator gate), 13 (backfill sets flag).
- §5 schema (migration 028) → Task 1.
- §6.0 listReviews/listAllReviews locationId → Task 6.
- §6.1 dropped ZernioReviewSource → no task (architectural decision; workers call `zernioClient` directly per Tasks 12/13).
- §6.2 zernio-normalize → Task 7.
- §6.3 `ZernioReviewIngestWorker` + typed errors → Task 12; onFailed hook → Task 15.
- §6.3b `reconcileExternallyAnsweredReview` → Task 11.
- §6.4 `ZernioBackfillWorker` → Task 13.
- §6.5 onFailed escalation → Task 15.
- §6.5b `applyIngestionAuthErrorFallback` → Task 10.
- §6.6 `processReview` ON CONFLICT + suppressNotification → Task 8.
- §6.6b `parseZernioReviewWebhook` → Task 5; ingress handler → Task 14.
- §6.7 `ResponseGeneratorWorker` skip enqueue → Task 9.
- §6.8 connect callback enqueue backfill → Task 16.
- §6.9 SerpAPI removal (3 producers + consumers) → Tasks 22 + 23.
- §6.10 premium tier wiring → Task 24.
- §6.10b publisher 409 verify-first + helper extraction + transient-with-context wrap → Tasks 17 (helpers + classes), 18 (`applyTransientExhaustionFallback` widen + lookupZernioReviewId pin), 19 (publisher refactor).
- §6.10b' `AdminExceptionWorker` renderExceptionBody → Task 21.
- §6.10c indeterminate failed-hook branch + transient unwrap → Task 20.
- §6.10d `canonicalizeReplyText` → Task 4 (helper) + Tasks 11, 19 (consumers).
- §6.11 `lookupZernioReviewId` location pin → Task 18.
- §6.12 file modification list → coverage spread across all tasks; cross-checked here.
- §6.12b decommission `awaiting_manual_post` → Task 25 (migration 029) + Task 26 (code deletion) + Task 27 (banner/email copy) + Task 28 (CLAUDE.md).
- §6.13 NEW files list → covered by Tasks 4, 5, 7, 10, 11, 12, 13, 17.
- §7 mock mode → Task 12 has the §6.3 short-circuit branch.
- §8 concurrency & idempotency → relied on across Tasks 8, 11, 13, 14.
- §9 cost model → no task (descriptive only).
- §10 testing strategy → unit/integration tests baked into each task; integration in Task 29; manual in Task 30.
- §11 future work → no tasks (intentionally deferred).
- §12 rollout → Task 30.
- §13 acceptance criteria → Task 30.2 grep audit + Task 30.6/30.7 manual smoke.

## Self-review notes

- **Migration apply order is enforced verbally** (Task 1, Task 25, Task 30.3) AND in CLAUDE.md (Task 28.3). 028 BEFORE 029.
- **`createBusinessTx` self_serve mode** is unaffected — no SerpAPI sync_reviews enqueue lives there per current code (the sync_reviews enqueue was admin-only and is removed in Task 22).
- **`SerpApiSource` is preserved** because `DemoGenerationWorker` still uses it for prospect demos (spec §2 non-goal). Verify by Grep for `SerpApiSource` after Task 23 — expected matches only in `worker/jobs/DemoGenerationWorker.ts` and `src/lib/reviews/serpapi-source.ts`.
- **`MOCK_EXTERNAL_APIS=true`** continues to short-circuit Zernio HTTP per Task 12.3 — backfill writes a backfill_runs row with all-zero counts (harmless), ingest worker exits early without burning retries.
- **Index byte-for-byte match** for ON CONFLICT clauses (Task 15 + Task 17 + lab note in Task 28.5) — must use the existing migration-005 partial-index expression `(payload->>'provider_review_id')`, NOT `provider_review_id`.
- **Zernio query-param verification** (Task 6.1) — implementer MUST check current Zernio Get Reviews docs for the exact query-param name (`locationId`) before merging.
- **Premium tier copy** (Task 24.2) — confirm display copy + price with stakeholder before flag flip.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-29-zernio-ingestion-replace-serpapi-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks. Each task is self-contained; subagent gets the spec section + the task's file list and code blocks.

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batching related tasks (e.g. 4-7 as a single foundation batch, 11-15 as ingest pipeline batch) with checkpoints between phases.

Which approach?


