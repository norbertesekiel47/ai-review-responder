# Reviews list: unanswered-first sort + per-row Generate/Regenerate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Widen `dashboard/reviews/history` in place into the **Reviews list** — Unanswered-then-Answered grouping over *all* reviews, per-row `Generate` / `Regenerate` wired to the existing **On-demand generation** cost policy, provenance badges replacing the gap/historical split, and `PAST_REPLIES_VIEW_ENABLED` retired.

**Architecture:** One new **Origin lane** (`on_demand_generate`) makes a Generate draft structurally ineligible for auto-approval; two new sibling routes under `api/dashboard/reviews/[reviewId]/` (`generate` + `draft-status`) form the Generate door, keyed on `reviewId` so a page refresh resumes the poll; `load-replies.ts` swaps its posted-only `JOIN` for a `LEFT JOIN` plus four LATERALs (live non-posted response with its moderation-held flag, in-flight outbox row, and the two that absorb the deleted orphan query) and derives a six-way **row state** in `replies-view.ts` so the card *renders* a state rather than computing one. Nothing about the publish transport, the auto-approval guard, or the regen-budget `version > 1` guard changes.

**Tech Stack:** Next.js 16 App Router (server components + route handlers), Postgres.js tagged templates, ioredis (Upstash cache), BullMQ via the transactional outbox, Vitest + fast-check, Playwright.

---

## Ticket & spec provenance

| Artifact | Path / ref |
|---|---|
| Ticket | `gh issue view 678` (map #667) |
| Spec — surface (S1–S7) | `docs/superpowers/specs/2026-08-05-consented-review-import-design.md` §6.3a |
| Spec — cost policy (C1–C4) | same file §6.3b |
| Spec — Regenerate risk | same file §6.4 |
| Glossary (verbatim terms) | `CONTEXT.md` → **Reviews list**, **On-demand generation**, **Import offer**, **Live-ingest cutoff** |
| Intake contract | `.feature/intake.json` (arming copy) · `docs/superpowers/plans/feat-678-reviews-list-generate-intake.json` (audit copy) |

**Glossary terms used verbatim throughout — do not paraphrase:** Reviews list, Needs Action, On-demand generation, Origin lane, Import window, Live-ingest cutoff, Import consent.

---

## Design decisions taken during planning (beyond the map)

These were resolved in this session's grilling; they are contract, not suggestion.

**D-A — The Generate door lives at `api/dashboard/reviews/[reviewId]/generate`.** Beside `/regenerate` and `/approve`, using `requireDashboardReviewOwner` + `withSameOrigin`. C3's "third caller of `enforceDashboardRegenRateLimit`" then reads literally. Its in-transaction body mirrors `past-replies/draft/route.ts` **inline** (that file is the named precedent and keeps its tx body inline at 253 lines) — do **not** extract a `src/lib/responses/on-demand-generate.ts` module: one caller, and `src/lib/responses/**` is outside the allowed edit surface.

**D-B — Version comes from `COALESCE(MAX(version),0)+1`, never hardcoded `1`.** C1's self-arming depends on it: discarding a draft sets `status='superseded'` and **retains the row** (verified in `past-replies/draft/[responseId]/route.ts`), so `MAX(version)` is preserved and the next Generate is version ≥ 2 and charged. Hardcoding `1` would create an unbounded free-regeneration loop.

**D-C — Poll by `reviewId`, not `outbox_id`, via a NEW `GET api/dashboard/reviews/[reviewId]/draft-status`.** The existing `past-replies/draft-status` is unusable for this lane on two counts: it returns `503 feature_disabled` when `EDIT_REPLIES_ENABLED` is off (Generate must not depend on that flag — it never touches a live Google reply), and `outbox_id` is client state a refresh loses, which cannot deliver the locked "`Generating…` survives a refresh" behavior. `past-replies/draft-status` is **untouched** (it stays the drawer lane's poller). Two adapters at one seam with genuinely different keys, scopes, and flag gates — a real seam. Do not factor a shared helper on first duplication.

**D-D — The card renders a row state; it does not compute one.** `replies-view.ts` derives a six-way discriminant (`generate` | `regenerate` | `draft_ready` | `held` | `generating` | `recover`) as a pure function. (`held` was added by round-2 Defect B — see D9.) All "never offer Generate on X" rules live in that one place, which is where the invariant-adjacent risk sits.

**D-E — Provenance badge is four-valued.** `external_reply_ingested_at IS NOT NULL` splits on activation: before → `Posted by you before joining`, at-or-after → `Replied on Google` (the owner replied in Google's UI while subscribed). Otherwise `approval_method` decides: `auto_policy` → `Auto-approved`, `owner` → `You approved`. The fourth string is a deliberate, owner-approved widening of S3's three.

**D-F — The regen-budget counter is one batched round trip, fail-open.** `peekRegenBudgetBatch(reviewIds)` deepens `src/lib/costs/tracker.ts` (which already privately owns `regenBudgetKey` + `MAX_REGEN_PER_SUBJECT_PER_DAY`). Only **answered** rows get a counter — a Generate is free by C1. Redis failure → empty map → no counters, every button enabled.

**D-G — Orphan rows group under `Unanswered`, render the recovery card, and never offer `Generate`.** They have no live Google reply (so `Unanswered` is honest) but do have a superseded draft; offering `Generate` would race `/retry` and `/restore-original`.

**D-H — Assert invariant #3, never re-gate it.** The whole production change is one entry in `GENERATE_RESPONSE_ORIGIN_LANE`. `isAutoApprovalCandidate` already requires `live_ingest_new`, so `on_demand_generate` is excluded structurally; `suppress_notification: true` is belt-and-braces per the #669 audit. `worker/jobs/response-generation/**` production files are **outside** the edit surface — only its `__tests__/**`.

---

## File structure

### Created

| File | Responsibility |
|---|---|
| `src/app/api/dashboard/reviews/[reviewId]/generate/route.ts` | The Generate door. Auth → shared rate limit → tenant lookup → writable-subscription → offboarding → budget peek → in-tx guards + `enqueueGenerateResponse`. |
| `src/app/api/dashboard/reviews/[reviewId]/generate/__tests__/route.test.ts` | 12 route tests. |
| `src/app/api/dashboard/reviews/[reviewId]/draft-status/route.ts` | Poll a review's in-flight generation by `reviewId`. Account-scoped, ungated. |
| `src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts` | Poller tenant-scope + state tests. |
| `src/components/dashboard/reviews/useInlineGenerate.ts` | Client state machine for the inline Generate lane (POST → poll → settle). |
| `src/components/dashboard/reviews/InlineGeneratePanel.tsx` | The in-row expansion: draft text + `Approve & post`. |
| `src/lib/past-replies/__tests__/load-replies.integration.test.ts` | Live-schema suite: ordering + count denominators. |

### Modified

| File | Change |
|---|---|
| `src/lib/shared/worker-types.ts` | One entry: `ON_DEMAND_GENERATE: 'on_demand_generate'`. |
| `src/lib/past-replies/load-replies.ts` | `LEFT JOIN` + 4 LATERALs (2 new + 2 folding in the deleted orphan query, F3); separate orphan query **deleted**; counts → unanswered/answered; `ORDER BY (resp.id IS NOT NULL), r.review_date DESC, r.id DESC`; avg over all reviews; batched budget peek. |
| `src/lib/past-replies/replies-view.ts` | `bucketReplies` → `groupReplies`; add `deriveRowState` + `provenanceBadge`; delete `isHistorical` as a *bucketing* predicate (kept as a badge input). |
| `src/lib/past-replies/flags.ts` | Collapse three functions → one `editRepliesEnabled()`. |
| `src/lib/costs/tracker.ts` | Add `peekRegenBudgetBatch`. |
| `src/components/dashboard/reviews/PastReplyCard.tsx` | Render `row_state` + provenance badge + counter; add Generate/Regenerate/Draft-ready affordances. |
| `src/components/dashboard/reviews/ReviewsTabs.tsx` | `History` → `All Reviews`; drop `historyEnabled`. |
| `src/components/dashboard/reviews/ReviewsContent.tsx` | Drop the `historyEnabled` prop. |
| `src/app/(authenticated)/dashboard/reviews/page.tsx` | Drop the flag read. |
| `src/app/(authenticated)/dashboard/reviews/history/page.tsx` | Drop `notFound()` gate; new prop names; TopBar copy. |
| `src/app/(authenticated)/dashboard/reviews/history/PastRepliesClient.tsx` | Two sections → Unanswered/Answered; new stat tiles; wire inline generate. |
| `src/app/(authenticated)/_styles/past-replies.css` | Row-state affordance + badge + counter styles. |
| `.env.example`, `.claude/reference/env-vars.md` | Retire `PAST_REPLIES_VIEW_ENABLED`; update `EDIT_REPLIES_ENABLED`'s cross-reference. |
| `CONTEXT.md`, `docs/currents.md`, `docs/directory.md`, spec §6.3 | Record as-built. |
| `e2e/edit-replies-runbook.spec.ts` | Drop the retired flag. |

---

## Task graph

```
T1 (eval)  ─────────────────────────────────────────────  runs ALONE (enforcement spot check)
   ├── T2 (origin lane)   ┐
   ├── T4 (query)         ├─ mutually independent → parallel dispatch
   └── T6 (budget peek)   ┘
   T2 ──> T3 (Generate door + poller)
   T4 ──> T5 (view: grouping / row state / provenance)
   T5 + T6 ──> T7 (UI)
   T7 ──> T8 (flag retirement + docs)
```

`T2`, `T4`, `T6` have no blocking edges between them and touch disjoint files (`src/lib/shared/worker-types.ts` + `worker/**/__tests__` · `src/lib/past-replies/load-replies.ts` · `src/lib/costs/tracker.ts`). Everything else is serial.

---

## Task 1: Eval — the spec in executable form

**Files:**
- Create: `src/lib/past-replies/__tests__/reviews-list.test.ts`
- Create: `src/lib/past-replies/__tests__/load-replies.integration.test.ts`
- Create: `src/app/api/dashboard/reviews/[reviewId]/generate/__tests__/route.test.ts`
- Create: `src/app/api/dashboard/reviews/[reviewId]/generate/__tests__/generate-version.integration.test.ts` — **F9**: the C1 chain (`discarding a v1 Generate draft retains it and the next POST generate enqueues v2`) needs live Postgres; a mocked `MAX(version)=2` passes vacuously and proves nothing about the retention C1 depends on. Live-DB conventions apply: `*.integration.test.ts` name, **no** migration SQL, must call `assertSchemaReady` (`ci:live-db-suites`).
- Create: `src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts`
- Create: `src/lib/costs/__tests__/regen-budget-batch.test.ts`
- Create: `worker/jobs/response-generation/__tests__/on-demand-lane.property.test.ts`
- Create: `src/components/dashboard/reviews/__tests__/past-reply-card-states.test.tsx`
- Modify: `src/lib/past-replies/__tests__/flags.test.ts`

All **52** titles from `.feature/intake.json` → `tests_to_add` must appear **VERBATIM**. The `promised-tests` gate row matches them literally; a retitle is a deviations-file entry, not a silent edit. (37 at intake → 50 after round 1 (D3) → 52 after round 2 (D8).)

- [ ] **Step 1: Author every test body that can be written against types that already exist**

Write real assertions where the module exists today (`flags.ts`, `tracker.ts`, `replies-view.ts` helpers). For behavior whose module does not exist yet, write the test with `it.todo(...)` **only** where the assertion cannot be expressed without the new type; prefer a real `it()` that imports the not-yet-existing symbol and therefore fails to resolve — a red test beats a todo.

Example of the shape required — the two invariant-#3 property tests (these are mandatory: the feature touches auto-approval):

```ts
// worker/jobs/response-generation/__tests__/on-demand-lane.property.test.ts
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  GENERATE_RESPONSE_ORIGIN_LANE,
  GENERATE_RESPONSE_ORIGIN_LANES,
} from '../../../../src/lib/shared/worker-types';

// Mirrors worker/jobs/response-generation/persist.ts:86-90 exactly. This is an
// ASSERTION of the existing guard (ticket #678: "Do NOT add a second
// auto-approval guard"), not a second gate.
const isAutoApprovalCandidate = (
  runtimeEnabled: boolean,
  originLane: string | null,
  version: number,
  suppressNotification: boolean,
): boolean =>
  runtimeEnabled
  && originLane === GENERATE_RESPONSE_ORIGIN_LANE.LIVE_INGEST_NEW
  && version === 1
  && !suppressNotification;

describe('invariants', () => {
  it('property: isAutoApprovalCandidate is false for every origin lane other than live_ingest_new', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...GENERATE_RESPONSE_ORIGIN_LANES),
        fc.integer({ min: 1, max: 50 }),
        fc.boolean(),
        (lane, version, suppress) => {
          if (lane === GENERATE_RESPONSE_ORIGIN_LANE.LIVE_INGEST_NEW) return true;
          return isAutoApprovalCandidate(true, lane, version, suppress) === false;
        },
      ),
    );
  });

  it('property: a suppress_notification draft is never an auto-approval candidate at any version', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...GENERATE_RESPONSE_ORIGIN_LANES),
        fc.integer({ min: 1, max: 50 }),
        (lane, version) => isAutoApprovalCandidate(true, lane, version, true) === false,
      ),
    );
  });
});
```

Note the first property is vacuous until T2 adds `on_demand_generate` to the lane list — that is the point: T2 is what gives it teeth.

- [ ] **Step 2: Run the eval suite and confirm it is RED**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-678-reviews-list-generate && \
  pnpm vitest run src/lib/past-replies src/lib/costs src/components/dashboard/reviews \
    "src/app/api/dashboard/reviews" worker/jobs/response-generation 2>&1 | tail -40
```
Expected: failures naming unresolved imports (`deriveRowState`, `provenanceBadge`, `peekRegenBudgetBatch`, the two new routes) — **not** passes.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "test(#678): eval task — 52 failing specs for the Reviews list + Generate door"
```

---

## Task 2: Origin lane `on_demand_generate`

**Blocking edges:** T1. **Independent of:** T4, T6.

**Files:**
- Modify: `src/lib/shared/worker-types.ts:24-29`
- Test: `worker/jobs/response-generation/__tests__/on-demand-lane.property.test.ts`

- [ ] **Step 1: Add the lane entry**

```ts
export const GENERATE_RESPONSE_ORIGIN_LANE = {
  LIVE_INGEST_NEW: 'live_ingest_new',
  LIVE_INGEST_UPDATE: 'live_ingest_update',
  BACKFILL: 'backfill',
  REGENERATE: 'regenerate',
  /**
   * Owner-initiated `Generate` from the Reviews list on a never-replied review
   * (On-demand generation, spec §6.3b). Deliberately distinct from
   * LIVE_INGEST_NEW: a Generate draft is version 1, so this lane value is the
   * ONLY thing excluding it from `isAutoApprovalCandidate`
   * (worker/jobs/response-generation/persist.ts:86-90) — invariant #3.
   */
  ON_DEMAND_GENERATE: 'on_demand_generate',
} as const;
```

`GENERATE_RESPONSE_ORIGIN_LANES`, the `GenerateResponseOriginLane` type, and `KNOWN_ORIGIN_LANES` in `job-outbox-helpers.ts` all derive from this object — no other production edit is needed. There is no DB `CHECK` on `origin_lane` (verified: no hit in `supabase/migrations/`); it is outbox-payload only.

- [ ] **Step 2: Run the property tests**

```bash
pnpm vitest run worker/jobs/response-generation/__tests__/on-demand-lane.property.test.ts
```
Expected: PASS, and the first property is now non-vacuous (it exercises `on_demand_generate`).

- [ ] **Step 3: Commit**

```bash
git add src/lib/shared/worker-types.ts worker/jobs/response-generation/__tests__/ && \
  git commit -m "feat(#678): add on_demand_generate origin lane; assert invariant #3 exclusion"
```

---

## Task 3: The Generate door + the reviewId poller

**Blocking edges:** T2.

**Files:**
- Create: `src/app/api/dashboard/reviews/[reviewId]/generate/route.ts`
- Create: `src/app/api/dashboard/reviews/[reviewId]/draft-status/route.ts`
- Test: the two `__tests__/route.test.ts` from T1

- [ ] **Step 1: Write `generate/route.ts`**

Guard order is contract — the rate limit fires **before** any DB work (C3), the budget peek before the transaction.

```ts
// src/app/api/dashboard/reviews/[reviewId]/generate/route.ts
//
// POST /api/dashboard/reviews/[reviewId]/generate
//
// The Generate door: creates the FIRST draft for a never-replied review from
// the Reviews list (On-demand generation, spec §6.3b). Neither existing lane
// creates a first draft — past-replies/draft hard-requires a status='posted'
// row and the dashboard reviews lane 404s without an existing responses row
// (#669 reuse audit).
//
// Shape mirrors past-replies/draft/route.ts (mode='regenerate') MINUS
// validateOptimisticConcurrency and the version snapshot — there is no live
// reply to be concurrent with. Publish reuses reviews/[reviewId]/approve, NOT
// past-replies/publish.
//
// Invariant #3: the enqueue pins originLane = ON_DEMAND_GENERATE and
// suppressNotification = true. A Generate draft is version 1, so the lane is
// the ONLY thing excluding it from isAutoApprovalCandidate. Do not add a
// second guard here (ticket #678).
//
// Invariant #2: the outbox row is written inside the same tx that takes the
// review lock, via enqueueGenerateResponse.

import { NextRequest, NextResponse } from 'next/server';
import { v7 as uuidv7 } from 'uuid';
import { sql } from '@/lib/db/server';
import { requireDashboardReviewOwner } from '@/lib/approval/http-routes';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { assertWritableSubscriptionForAccount } from '@/lib/shared/writable-subscription';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import { NON_TERMINAL_STATUSES } from '@/lib/shared/response-status';
import { statusArraySql } from '@/lib/shared/response-status-sql';
import { GENERATE_RESPONSE_ORIGIN_LANE } from '@/lib/shared/worker-types';
import { enqueueGenerateResponse } from '@/lib/shared/job-outbox-helpers';
import {
  enforceDashboardRegenRateLimit,
  enforceRegenBudgetForReview,
} from '@/lib/shared/dashboard-regen-rate-limit';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { createWorkerLogger } from '@/lib/shared/logger';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';

export const dynamic = 'force-dynamic';

async function generateFirstDraft(
  request: NextRequest,
  { params }: { params: Promise<{ reviewId: string }> },
): Promise<NextResponse> {
  const owner = await requireDashboardReviewOwner(request);
  if (owner instanceof NextResponse) return owner;

  // C3: the THIRD caller of the shared per-owner counter. Before any DB work,
  // matching regenerate/route.ts. Fails open by design.
  const limited = await enforceDashboardRegenRateLimit(owner.accountId);
  if (limited) return limited;

  const { reviewId } = await params;

  // Tenant proof: the review must belong to a live location under this account.
  // This is the ownership gate — do NOT trust a location cookie here.
  const ownedRows = await sql<{ business_id: string }[]>`
    SELECT rv.business_id
    FROM reviews rv
    JOIN businesses b ON b.id = rv.business_id
    WHERE rv.id = ${reviewId}::uuid
      AND b.account_id = ${owner.accountId}::uuid
      AND b.archived_at IS NULL
    LIMIT 1
  `;
  const owned = ownedRows[0];
  if (!owned) {
    return NextResponse.json(
      { error: 'review_not_found' },
      { status: 404, headers: NO_STORE_HEADERS },
    );
  }
  const businessId = owned.business_id;

  // ONE guard, not two. assertWritableSubscriptionForAccount already resolves
  // the offboarding state in the SAME query (LEFT JOIN account_offboardings)
  // and returns { status: 403, error: 'account_offboarding_blocked' } when
  // isProcessingBlocked — so a separate getOffboardingState call here would be
  // a duplicate round trip AND a second spelling of a guard that already has
  // one owner. `past-replies/draft` calls the gate directly only because it
  // needs the operational_ui intent class for its manual mode; Generate is
  // processing-class, which is exactly this helper's default.
  const writable = await assertWritableSubscriptionForAccount(owner.accountId, sql);
  if (!writable.ok) {
    return NextResponse.json(
      { error: writable.error },
      { status: writable.status, headers: NO_STORE_HEADERS },
    );
  }

  // Read-only peek — consumes no budget, fails open. Authoritative gate stays
  // the worker's Lua INCR in generate-draft.ts.
  const capped = await enforceRegenBudgetForReview(reviewId);
  if (capped) return capped;

  try {
    return await sql.begin(async (tx) => {
      // Lock the review: two concurrent Generate clicks serialize here.
      const locked = await tx<{ id: string }[]>`
        SELECT id FROM reviews
        WHERE id = ${reviewId}::uuid AND business_id = ${businessId}::uuid
        FOR UPDATE
      `;
      if (locked.length === 0) {
        return NextResponse.json({ error: 'review_not_found' }, { status: 404 });
      }

      // Generate is for NEVER-REPLIED reviews only. A posted sibling means the
      // owner wants Regenerate (which replaces a live Google reply, §6.4).
      const posted = await tx<{ id: string }[]>`
        SELECT id FROM responses
        WHERE review_id = ${reviewId}::uuid AND status = 'posted'
        LIMIT 1
      `;
      if (posted.length > 0) {
        return NextResponse.json({ error: 'already_answered' }, { status: 409 });
      }

      const existing = await tx<{ id: string; status: string }[]>`
        SELECT id, status FROM responses
        WHERE review_id = ${reviewId}::uuid
          AND status = ANY(${statusArraySql(sql, NON_TERMINAL_STATUSES)})
        ORDER BY version DESC
        LIMIT 1
      `;
      if (existing[0]) {
        return NextResponse.json(
          { error: 'draft_already_exists', existing: { response_id: existing[0].id, status: existing[0].status } },
          { status: 409 },
        );
      }

      const pendingGen = await tx<{ exists: number }[]>`
        SELECT 1 AS exists FROM job_outbox
        WHERE topic = ${QUEUE_NAMES.GENERATE_RESPONSE}
          AND aggregate_id = ${reviewId}
          AND status IN ('pending', 'dispatching', 'dispatched')
        LIMIT 1
      `;
      if (pendingGen.length > 0) {
        return NextResponse.json({ error: 'regenerate_in_progress' }, { status: 409 });
      }

      // D-B: MAX-derived, never hardcoded 1. A discarded draft is retained at
      // status='superseded', so version climbs and C1's per-review budget
      // self-arms on the next attempt.
      const versionRows = await tx<{ next_version: number }[]>`
        SELECT COALESCE(MAX(version), 0) + 1 AS next_version
        FROM responses WHERE review_id = ${reviewId}::uuid
      `;
      const nextVersion = versionRows[0]?.next_version ?? 1;

      const outboxId = uuidv7();
      await enqueueGenerateResponse(tx, {
        outboxId,
        reviewId,
        businessId,
        version: nextVersion,
        originLane: GENERATE_RESPONSE_ORIGIN_LANE.ON_DEMAND_GENERATE,
        suppressNotification: true,
      });

      createWorkerLogger('[OnDemandGenerate]').log({
        event: 'on_demand_generate_enqueued',
        reviewId,
        businessId,
        version: nextVersion,
        outboxId,
      });

      return NextResponse.json({ outbox_id: outboxId, version: nextVersion }, { status: 200 });
    });
  } catch (err) {
    reportCaughtError('reviews/generate', err, { accountId: owner.accountId, businessId, reviewId });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

export const POST = withSameOrigin()(generateFirstDraft);
```

- [ ] **Step 2: Write `draft-status/route.ts`**

Keyed on `reviewId` (D-C) so a refresh resumes. Account-scoped to match its `generate` sibling. No `EDIT_REPLIES_ENABLED` gate. No `withSameOrigin` — GET is exempt, matching the `past-replies/draft-status` precedent.

```ts
// src/app/api/dashboard/reviews/[reviewId]/draft-status/route.ts
//
// GET /api/dashboard/reviews/[reviewId]/draft-status
//
// Polls the On-demand generation lane for one review. Distinct from
// past-replies/draft-status (D-C): keyed on reviewId (which the Reviews list
// row already carries, so a refresh resumes the poll) rather than outbox_id
// (client state a refresh loses), account-scoped rather than
// location-cookie-scoped, and NOT gated on EDIT_REPLIES_ENABLED — Generate
// never touches a live Google reply.
//
// States: { status: 'generating' } | { status: 'failed', error } |
//         { status: 'ready', response_id, response_text }
//         { status: 'idle' }  — nothing in flight and no draft

import { NextRequest, NextResponse } from 'next/server';
import { sql, sqlRead } from '@/lib/db/server';
import { requireDashboardReviewOwner } from '@/lib/approval/http-routes';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import { NON_TERMINAL_STATUSES } from '@/lib/shared/response-status';
import { statusArraySql } from '@/lib/shared/response-status-sql';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ reviewId: string }> },
): Promise<Response> {
  const owner = await requireDashboardReviewOwner(request);
  if (owner instanceof NextResponse) return owner;

  const { reviewId } = await params;

  // Tenant proof FIRST — identical shape to the generate door, so a caller can
  // never observe another account's generation status or draft text.
  const ownedRows = await sql<{ business_id: string }[]>`
    SELECT rv.business_id
    FROM reviews rv
    JOIN businesses b ON b.id = rv.business_id
    WHERE rv.id = ${reviewId}::uuid
      AND b.account_id = ${owner.accountId}::uuid
      AND b.archived_at IS NULL
    LIMIT 1
  `;
  if (!ownedRows[0]) {
    return NextResponse.json({ error: 'review_not_found' }, { status: 404, headers: NO_STORE_HEADERS });
  }
  const businessId = ownedRows[0].business_id;

  try {
    // F5 / invariant #4: a high-severity moderation flag leaves the draft at
    // `pending_approval` with an OPEN `flagged_responses` row. Returning it as
    // `ready` would hand the owner held text plus an `Approve & post` button —
    // the exact release path `src/lib/moderation/held-draft.ts` exists to block.
    // The `held` flag is SELECTed (not filtered) so a held draft is
    // distinguishable from "no draft at all"; filtering would make this route
    // report `idle` for both and the list fall through to `generate` (D9).
    const draftRows = await sqlRead<
      { id: string; status: string; response_text: string | null; held: boolean }[]
    >`
      SELECT
        resp.id, resp.status, resp.response_text,
        EXISTS (
          SELECT 1 FROM flagged_responses f
          WHERE f.response_id = resp.id AND f.status = 'open'
        ) AS held
      FROM responses resp
      WHERE resp.review_id = ${reviewId}::uuid
        AND resp.business_id = ${businessId}::uuid
        AND resp.status = ANY(${statusArraySql(sql, NON_TERMINAL_STATUSES)})
      ORDER BY resp.version DESC
      LIMIT 1
    `;
    if (draftRows[0]?.held) {
      // Never `ready`, never `response_text`. `idle` stops the poller; the list
      // row re-renders as `held` from its own query. Admin re-notification at
      // /admin/flagged is the owner's only path back.
      return NextResponse.json({ status: 'idle' }, { status: 200, headers: NO_STORE_HEADERS });
    }
    if (draftRows[0]) {
      return NextResponse.json(
        { status: 'ready', response_id: draftRows[0].id, response_text: draftRows[0].response_text },
        { status: 200, headers: NO_STORE_HEADERS },
      );
    }

    const outboxRows = await sqlRead<{ status: string; last_error: string | null }[]>`
      SELECT status, last_error
      FROM job_outbox
      WHERE topic = ${QUEUE_NAMES.GENERATE_RESPONSE}
        AND aggregate_id = ${reviewId}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const outbox = outboxRows[0];
    if (!outbox) {
      return NextResponse.json({ status: 'idle' }, { status: 200, headers: NO_STORE_HEADERS });
    }
    if (outbox.status === 'pending' || outbox.status === 'dispatching' || outbox.status === 'dispatched') {
      return NextResponse.json({ status: 'generating' }, { status: 200, headers: NO_STORE_HEADERS });
    }
    if (outbox.status === 'completed') {
      // Completed but no non-terminal draft: the draft was held by moderation
      // (invariant #4) or already settled. Nothing for the row to expand.
      return NextResponse.json({ status: 'idle' }, { status: 200, headers: NO_STORE_HEADERS });
    }
    return NextResponse.json(
      { status: 'failed', error: outbox.last_error },
      { status: 200, headers: NO_STORE_HEADERS },
    );
  } catch (err) {
    reportCaughtError('reviews/draft-status', err, { accountId: owner.accountId, businessId, reviewId });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
```

- [ ] **Step 3: Run the route tests**

```bash
pnpm vitest run "src/app/api/dashboard/reviews/[reviewId]/generate" "src/app/api/dashboard/reviews/[reviewId]/draft-status"
```
Expected: the 12 generate titles + the poller titles PASS.

- [ ] **Step 4: Commit**

```bash
git add "src/app/api/dashboard/reviews/[reviewId]" && \
  git commit -m "feat(#678): Generate door + reviewId-keyed draft-status poller"
```

---

## Task 4: The list query

**Blocking edges:** T1. **Independent of:** T2, T6.

**Files:**
- Modify: `src/lib/past-replies/load-replies.ts`
- Test: `src/lib/past-replies/__tests__/reviews-list.test.ts`, `__tests__/load-replies.integration.test.ts`

- [ ] **Step 1: Replace the posted-only JOIN with the LEFT JOIN + four LATERALs**

The main query becomes the **single row source** for the page (F3 — the separate
orphan query is deleted in Step 2a). Comments abbreviated here; keep the existing
file's comment density, which is high and load-bearing, and keep every
`-- review-status-ignore:` comment verbatim — they are what stops `ci:reviews-status`
from flagging the unqualified `responses.status` literals inside these subqueries.

```sql
SELECT
  r.id AS review_id, r.review_text, r.review_date, r.review_content_hash,
  r.external_reply_ingested_at, r.star_rating, r.reviewer_name,
  resp.id AS response_id, resp.approved_text, resp.approval_method,
  resp.posted_at, resp.version,
  fail_sidecar.id AS failed_response_id,
  fail_sidecar.posting_error AS failed_posting_error,
  draft.id AS draft_response_id,
  COALESCE(draft.held, false) AS draft_held,
  (pending_gen.exists IS NOT NULL) AS generation_in_flight,
  -- F3: orphan is now DATA, not caller discipline. An orphan is a
  -- post_after_delete_failed_* sibling with NO live posted sibling — the
  -- `resp.id IS NULL` conjunct is what the deleted query's NOT EXISTS did.
  (orphan_sidecar.id IS NOT NULL AND resp.id IS NULL) AS is_orphan,
  orphan_sidecar.id AS orphan_failed_response_id,
  orphan_sidecar.posting_error AS orphan_posting_error,
  orphan_superseded.approved_text AS superseded_text
FROM reviews r
LEFT JOIN responses resp
  ON resp.review_id = r.id AND resp.status = 'posted'
LEFT JOIN LATERAL ( ...existing delete_failed_* sidecar, unchanged... ) fail_sidecar ON true
-- NEW: live non-posted response → `Draft ready`, never `Generate` (S2).
-- F5 / invariant #4: carry `held` rather than filtering held drafts out. If a
-- held draft were excluded here, `draft_response_id` would be NULL and
-- `deriveRowState` would fall through to `generate` — offering an LLM spend the
-- partial unique index would then reject (at most one non-terminal response per
-- review). Selected, it resolves to the `held` state instead (D9).
LEFT JOIN LATERAL (
  SELECT
    resp2.id,
    EXISTS (
      SELECT 1 FROM flagged_responses f
      WHERE f.response_id = resp2.id AND f.status = 'open'
    ) AS held
  FROM responses resp2
  WHERE resp2.review_id = r.id
    AND resp2.status = ANY(${statusArraySql(sql, NON_TERMINAL_STATUSES)})
  ORDER BY resp2.version DESC LIMIT 1
) draft ON true
-- NEW: in-flight generation → `Generating…`, survives a refresh (D-C).
LEFT JOIN LATERAL (
  SELECT 1 AS exists FROM job_outbox
  WHERE topic = ${QUEUE_NAMES.GENERATE_RESPONSE}
    AND aggregate_id = r.id
    AND status IN ('pending', 'dispatching', 'dispatched')
  LIMIT 1
) pending_gen ON true
-- NEW (F3): the deleted orphan query's JOIN LATERAL, now LEFT and folded in.
-- LEFT, not JOIN — this query must still return non-orphan reviews.
LEFT JOIN LATERAL (
  SELECT id, posting_error FROM responses
  WHERE review_id = r.id
    AND status = 'failed'
    AND posting_error LIKE ${postAfterPfx}
  ORDER BY created_at DESC LIMIT 1
) orphan_sidecar ON true
-- NEW (F3): superseded text for the recovery drawer's "original" pane.
LEFT JOIN LATERAL (
  SELECT COALESCE(approved_text, response_text) AS approved_text FROM responses
  WHERE review_id = r.id AND status = 'superseded'
  ORDER BY created_at DESC LIMIT 1
) orphan_superseded ON true
WHERE r.business_id = ${locationId}
ORDER BY (resp.id IS NOT NULL), r.review_date DESC, r.id DESC
LIMIT ${PAGE_SIZE} OFFSET ${offset}
```

`fail_sidecar` and `orphan_sidecar` stay **separate** columns rather than one
COALESCEd pair: they carry different meanings (a `delete_failed_*` badge on a
healthy posted reply vs. the `post_after_delete_failed_*` failure that IS the
`recover` state), and only the latter may drive `deriveRowState`. Their scopes are
mutually exclusive by construction — `fail_sidecar` is read only when
`resp.id IS NOT NULL`, `orphan_sidecar` only when it is NULL.

`false` sorts before `true` in Postgres, so unanswered lead (S6). The `status IN ('pending','dispatching','dispatched')` list is the byte-for-byte in-flight contract from `src/lib/shared/job-outbox-status.ts` — re-spelled by hand exactly as every other site does; `ci:outbox-status` checks members **and order**.

- [ ] **Step 2: Replace the two activation-split COUNTs with the group counts**

```sql
-- unansweredTotal
SELECT COUNT(*)::int AS count FROM reviews r
WHERE r.business_id = ${locationId}
  AND NOT EXISTS (SELECT 1 FROM responses p WHERE p.review_id = r.id AND p.status = 'posted')

-- answeredTotal
SELECT COUNT(*)::int AS count FROM reviews r
WHERE r.business_id = ${locationId}
  AND EXISTS (SELECT 1 FROM responses p WHERE p.review_id = r.id AND p.status = 'posted')
```

And the average now spans all reviews:

```sql
SELECT AVG(r.star_rating)::float AS avg FROM reviews r WHERE r.business_id = ${locationId}
```

`totalPages = Math.max(1, Math.ceil((unansweredTotal + answeredTotal) / PAGE_SIZE))` — now a true denominator over all reviews, so the tail pages of a fresh import are reachable.

- [ ] **Step 2a: Delete the separate orphan query and its merge (F3)**

**Why (plan review round 1, High).** The orphan query's `NOT EXISTS` clause
guaranteed disjointness only because the main query INNER JOINed `posted`. Under
`LEFT JOIN` the main query returns *every* review, so each orphan review would
appear **twice** — once as `generate`, once as `recover` — and its un-offset
`LIMIT 50` would merge into *every* page.

Concretely, in `load-replies.ts`:

- Delete the `sql<OrphanRow[]>` query (today `:162-205`) from the `Promise.all`
  array, and the `orphanRows` binding it destructures into.
- Its data now arrives per-row from the `orphan_sidecar` / `orphan_superseded`
  LATERALs added in Step 1 — including `superseded_text`, which the recovery
  drawer needs and which no other LATERAL carries.
- Delete the `bucketReplies(…, orphanRows, …)` merge and the `orphanGapCount` /
  `orphanHistCount` it returned (Task 5 replaces the whole bucketing step).
- `OrphanRow` and `toOrphanCardRow` live in `replies-view.ts` (`:28`, `:100`),
  **not** `types.ts`. `load-replies.ts` is their only non-test consumer, so both
  are deleted in Task 5 when that file is rewritten — this step only drops the
  `OrphanRow` import at `load-replies.ts:11`. `orphan-markers.ts` constants
  (`postAfterPfx`, `deletePfx`) are still needed by the Step 1 LATERALs.

**Consequence for pagination — state it in the test.** Orphans are now inside the
`LIMIT ${PAGE_SIZE} OFFSET ${offset}` window and inside `unansweredTotal` (they
have no posted sibling, so Step 2's `NOT EXISTS` count already includes them).
That is the correct fix to the un-offset `LIMIT 50`, and it means orphan cards
are now paginated like every other row rather than being repeated on each page.

`deriveRowState` reads `is_orphan` from the row instead of from caller
discipline, which also closes the plan's own self-declared "known gap".

- [ ] **Step 3: Rename the returned view fields**

`PastRepliesPageView` becomes: `locationDisplayName`, `unansweredRows`, `answeredRows`, `unansweredTotal`, `answeredTotal`, `avgStarRating`, `page`, `totalPages`. `gapRows`/`histRows`/`gapTotal`/`histTotal`/`hasHistoricalSection`/`hasGapOrphans` are **deleted** — no compatibility shims (pre-launch codebase, no external consumer).

- [ ] **Step 4: Run the query tests**

```bash
pnpm vitest run src/lib/past-replies/__tests__/reviews-list.test.ts
TEST_DATABASE_POOL_URL=... pnpm vitest run src/lib/past-replies/__tests__/load-replies.integration.test.ts
```
Expected: the 9 query titles + the integration title PASS. The integration suite must be named `*.integration.test.ts`, must **not** apply migration SQL, and must call `assertSchemaReady` (`ci:live-db-suites` enforces this).

- [ ] **Step 5: Commit**

```bash
git add src/lib/past-replies/load-replies.ts src/lib/past-replies/__tests__/ && \
  git commit -m "feat(#678): Reviews list query — unanswered-first over all reviews"
```

---

## Task 5: Grouping, row state, provenance

**Blocking edges:** T4.

**Files:**
- Modify: `src/lib/past-replies/replies-view.ts`
- Test: `src/lib/past-replies/__tests__/reviews-list.test.ts`

- [ ] **Step 1: Add the row-state discriminant (D-D)**

```ts
/**
 * What the row offers. Derived ONCE here so every "never offer Generate on X"
 * rule lives in one place — the card renders a state, it never computes one.
 * Order is precedence, not preference.
 */
export type ReviewRowState =
  | 'recover'      // orphan: repost failed, no live reply — /retry or /restore-original
  | 'regenerate'   // posted sibling exists — EditReplyDrawer, replaces a LIVE Google reply
  | 'held'         // draft held by moderation — no text, no affordance (invariant #4)
  | 'draft_ready'  // live non-posted response — cross-link to Needs Action (S2)
  | 'generating'   // generate_response outbox row in flight
  | 'generate';    // never replied, nothing in flight

export function deriveRowState(r: {
  response_id: string | null;
  failed_response_id: string | null;
  draft_response_id: string | null;
  draft_held: boolean;
  generation_in_flight: boolean;
  is_orphan: boolean;
}): ReviewRowState {
  if (r.is_orphan) return 'recover';
  if (r.response_id !== null) return 'regenerate';
  if (r.draft_response_id !== null) return r.draft_held ? 'held' : 'draft_ready';
  if (r.generation_in_flight) return 'generating';
  return 'generate';
}
```

Precedence rationale, in order: an orphan has a superseded draft and must reach recovery, never Generate (D-G); a posted sibling always means Regenerate; a held draft outranks `draft_ready` because invariant #4 makes the hold absolute — and it is checked on the SAME branch as `draft_ready` so a held draft can never fall through to `generate` (D9); a live draft outranks an in-flight outbox row because the response row is the settled fact.

**`held` is a sixth state, not a variant of `draft_ready`.** Round 1's F5 fix said a held draft "groups as unanswered with no affordance", but the five-state union had no way to represent that: filtering the draft out yields `generate` (offers an LLM spend the partial unique index would reject), keeping it yields `draft_ready` (surfaces held content and `Approve & post`). Neither satisfies invariant #4 — see deviations D9.

- [ ] **Step 2: Add the four-valued provenance badge (D-E)**

```ts
export type ProvenanceBadge =
  | 'posted_before_joining'
  | 'replied_on_google'
  | 'auto_approved'
  | 'owner_approved';

/**
 * Why RepWorth is showing a reply, so an owner never wonders where it came
 * from or why we are offering to replace it (S3). Answered rows only.
 */
export function provenanceBadge(
  r: { external_reply_ingested_at: string | null; approval_method: ApprovalMethod | null; review_date: string },
  activatedAtIso: string | null,
): ProvenanceBadge | null {
  if (r.external_reply_ingested_at !== null) {
    // isHistorical survives ONLY as a badge input — it is no longer a
    // bucketing predicate (S3 deletes the gap/historical split).
    return isHistorical(new Date(r.review_date), activatedAtIso)
      ? 'posted_before_joining'
      : 'replied_on_google';
  }
  if (r.approval_method === APPROVAL_METHOD.AUTO_POLICY) return 'auto_approved';
  if (r.approval_method === APPROVAL_METHOD.OWNER) return 'owner_approved';
  return null;
}
```

Import `APPROVAL_METHOD` from `@/lib/auto-approval/types` — no string literals for approval methods.

- [ ] **Step 2b: Replace `bucketReplies` with `groupReplies`**

Same merge-and-sort shape as today, but the predicate is `deriveRowState(row) === 'regenerate'` (answered) vs everything else (unanswered), and orphan rows land in `unanswered` (D-G). Keep `sortByDateDesc` and `canEdit` unchanged.

`groupReplies` now takes **one** row array, not two — post-F3 there is no separate orphan list to merge, so the `orphanRows` parameter (`replies-view.ts:143`) and the `orphanGapCount` / `orphanHistCount` it returned are deleted, as are `OrphanRow` (`:28`) and `toOrphanCardRow` (`:100`). The section denominators are exactly `unansweredTotal` / `answeredTotal` — orphans need no separate term because they have no posted sibling and Step 2's `NOT EXISTS` count already includes them.

**Carry `toOrphanCardRow`'s field mapping into `toCardRow` before deleting it.** Deleting the mapper without this silently breaks recovery: `PastReplyCard` decides an orphan is recoverable via `!!row.failed_response_id && row.posted_at === null` (`PastReplyCard.tsx:157`) and gates the recovery actions on `row.failed_response_id` (`:201`). The old mapper (`replies-view.ts:100-117`) fed those from the orphan query's columns; post-F3 they come from the Step 1 LATERALs. So `toCardRow` must map, **when `is_orphan` is true**:

| `PastReplyRow` field | Source (Step 1 column) | Why |
|---|---|---|
| `failed_response_id` | `orphan_failed_response_id` | what `PastReplyCard:157,201` reads to offer recovery at all |
| `response_id` | `orphan_failed_response_id` | the old mapper set both; `/retry` + `/restore-original` address the failed response by id |
| `failed_posting_error` | `orphan_posting_error` | drives the recovery copy |
| `approved_text` | `superseded_text ?? null` | the "original" pane of the recovery drawer |
| `posted_at`, `approval_method`, `version` | `null` | an orphan has no live posted reply — and `posted_at === null` is half of the card's own orphan predicate |

For non-orphan rows these keep reading `resp.*` / `fail_sidecar.*` exactly as today. A test title pins it (D8): `an orphan row keeps its failed_response_id and superseded text after the single-query merge`.

- [ ] **Step 3: Run and commit**

```bash
pnpm vitest run src/lib/past-replies
git add src/lib/past-replies/ && git commit -m "feat(#678): row-state + provenance derivation; retire gap/historical bucketing"
```

---

## Task 6: Batched regen-budget peek

**Blocking edges:** T1. **Independent of:** T2, T4.

**Files:**
- Modify: `src/lib/costs/tracker.ts`
- Test: `src/lib/costs/__tests__/regen-budget-batch.test.ts`

- [ ] **Step 1: Add `peekRegenBudgetBatch`**

```ts
/**
 * Batched sibling of peekRegenBudget for the Reviews list, which needs a
 * counter per ANSWERED row (a Generate is free by construction — C1 — so
 * unanswered rows are never passed in). One MGET instead of N GETs.
 *
 * FAILS OPEN exactly like peekRegenBudget's callers: a Redis outage returns an
 * EMPTY map, so no counter renders and every Regenerate button stays enabled.
 * The authoritative gate remains the worker's Lua INCR (checkRegenBudget).
 */
export async function peekRegenBudgetBatch(
  reviewIds: readonly string[],
): Promise<Map<string, RegenBudgetStatus>> {
  const out = new Map<string, RegenBudgetStatus>();
  if (reviewIds.length === 0) return out;

  const keys = reviewIds.map(regenBudgetKey);
  const raw = await getCacheRedis().mget(...keys);

  reviewIds.forEach((reviewId, i) => {
    const parsed = Number.parseInt(raw[i] ?? '', 10);
    const used = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    out.set(reviewId, {
      used,
      limit: MAX_REGEN_PER_SUBJECT_PER_DAY,
      remaining: Math.max(0, MAX_REGEN_PER_SUBJECT_PER_DAY - used),
    });
  });
  return out;
}
```

`regenBudgetKey` embeds `todayDateStr()` (UTC), so the whole batch shares one date — consistent with the single-key peek.

- [ ] **Step 2: Call it from `loadPastRepliesPageView`, fail-open**

In `load-replies.ts`, after the rows are grouped, peek only the answered rows and swallow failures:

```ts
let regenBudgets = new Map<string, RegenBudgetStatus>();
try {
  regenBudgets = await peekRegenBudgetBatch(answeredRows.map((r) => r.review_id));
} catch (err) {
  // Fail open (D-F): no counters render, every Regenerate stays enabled.
  createWorkerLogger('[ReviewsList]').warn({
    event: 'regen_budget_peek_failed',
    route: 'reviews_list',
    reason: err instanceof Error ? err.message : 'unknown',
  });
}
```

Reuse the existing `regen_budget_peek_failed` event name so the two peek sites are one observable stream.

- [ ] **Step 3: Run and commit**

```bash
pnpm vitest run src/lib/costs
git add src/lib/costs/ src/lib/past-replies/load-replies.ts && \
  git commit -m "feat(#678): batched regen-budget peek for the Reviews list"
```

---

## Task 7: The surface

**Blocking edges:** T5, T6.

**Files:**
- Modify: `PastRepliesClient.tsx`, `PastReplyCard.tsx`, `history/page.tsx`, `past-replies.css`
- Create: `useInlineGenerate.ts`, `InlineGeneratePanel.tsx`
- Test: `src/components/dashboard/reviews/__tests__/past-reply-card-states.test.tsx`

- [ ] **Step 1: `useInlineGenerate` — POST then poll by reviewId**

New hook rather than extending `useEditReplyDraft`: that hook's interface requires a snapshot and an existing posted reply, neither of which exists for a first draft. Follow its poll-and-settle shape. On mount, if the server-rendered `row_state` is `generating`, start polling immediately — that is what makes the state survive a refresh (D-C). Poll `GET /api/dashboard/reviews/{reviewId}/draft-status` until `ready` | `failed` | `idle`; surface `rate_limited` and `regen_limit_reached` 429 bodies verbatim (the messages are owned by `dashboard-regen-rate-limit.ts`).

- [ ] **Step 2: `InlineGeneratePanel` — the in-row expansion (S7)**

Draft text + `Approve & post` posting to `POST /api/dashboard/reviews/{reviewId}/approve`, and `Edit` to `/edit`. **Not** the two-pane drawer: a never-replied review has nothing live on Google, so an empty left pane would overstate the risk.

- [ ] **Step 3: `PastReplyCard` renders `row_state`**

A `switch` on the **six** states — no derivation in the component. `regenerate` also renders `{used} of {limit} today` from the budget map and disables the button at `remaining === 0`; when the map has no entry (fail-open), render no counter and leave the button enabled. Answered rows render the provenance badge.

`held` renders a neutral, non-actionable row: the review text, a muted `Under review` marker, and **no button, no draft text, no cross-link** — the draft is not the owner's to see or act on until an admin disposition at `/admin/flagged` releases it (invariant #4; `held-draft.ts` header). Do not reuse the `draft_ready` cross-link: Needs Action does not surface held drafts either, so it would lead nowhere. Exhaustiveness: give the `switch` a `never`-typed default so adding a seventh state fails typecheck rather than rendering blank (`assert impossible states` — anti-slop).

- [ ] **Step 4: `PastRepliesClient` — two sections, four tiles**

`Unanswered` then `Answered`; tiles become Total reviews / Unanswered / Answered / Avg rating. Delete `hasHistoricalSection`, `hasGapOrphans`, and the `gapOrphanCount`/`histOrphanCount` arithmetic in `useReplyFilters`. Keep the search + rating-chip toolbar and pagination unchanged.

- [ ] **Step 5: `history/page.tsx`**

Delete the `pastRepliesViewEnabled()` `notFound()` gate. TopBar title becomes `All Reviews`; subtitle: `Every review for {location} — unanswered first.` Pass the new prop names.

- [ ] **Step 6: Run, then commit**

```bash
pnpm vitest run src/components/dashboard/reviews && pnpm build
git add -A && git commit -m "feat(#678): Reviews list surface — grouping, row states, inline Generate"
```

---

## Task 8: Retire `PAST_REPLIES_VIEW_ENABLED` + docs

**Blocking edges:** T7.

- [ ] **Step 1: Capture the flag's current per-environment values BEFORE deleting it**

Invoke the `flag-flip` skill and record the current Railway + Vercel values for `PAST_REPLIES_VIEW_ENABLED` in each environment. These go in the PR description as the **revert precondition** — reverting this PR restores the flag read, and a missing env var would 404 the list.

- [ ] **Step 2: Collapse `flags.ts` to one function**

```ts
/**
 * Single authoritative owner for the reply-editing feature flag.
 *
 * PAST_REPLIES_VIEW_ENABLED was retired at #678 (spec §6.3a S4): once the
 * Reviews list is the consented Review import's only destination, the flag
 * would let import_decision='accepted' coexist with the imported reviews
 * landing on a notFound(). EDIT_REPLIES_ENABLED is KEPT — it gates the
 * live-Google mutation, a different and larger risk.
 *
 * Server-authoritative (invariant #13): never add a NEXT_PUBLIC_* companion.
 */
import { readFlag } from '@/lib/config/flags';

export function editRepliesEnabled(): boolean {
  return readFlag('EDIT_REPLIES_ENABLED');
}
```

- [ ] **Step 3: Update every call site**

`ReviewsTabs.tsx` (drop `historyEnabled`, label → `All Reviews`), `ReviewsContent.tsx` (drop the prop), `reviews/page.tsx` (drop the flag read), the seven `past-replies/__tests__/*` files, `flags.test.ts`, `e2e/edit-replies-runbook.spec.ts`, and the worker integration test. Every `editRepliesEnabled()` and `replyEditingFlagEnabled()` caller now points at the one function.

- [ ] **Step 4: Registry + docs, same change**

Delete the `PAST_REPLIES_VIEW_ENABLED` row from `.claude/reference/env-vars.md` and `.env.example`, and fix `EDIT_REPLIES_ENABLED`'s cross-reference to it. Grep the filename across `docs/` and clean every stale cross-reference (working rule). Update `CONTEXT.md` → **Reviews list** and **On-demand generation** to "implemented at #678", spec §6.3a/§6.3b as-built, `docs/currents.md`, `docs/directory.md`.

**F8 — the three LIVE (non-`docs/`) references must be edited here too**, not just grepped. These are why D1 widened the surface; a `docs/`-only sweep leaves them stale and `ci:process-env` red:

- [ ] `scripts/ci/process-env-baseline.ts` — drop the `PAST_REPLIES_VIEW_ENABLED` entry. **Run `pnpm ci:process-env` after**; this file IS the audit's baseline, so a stale entry fails the gate rather than merely reading wrong.
- [ ] `.claude/reference/env-vars.md` — the registry row (above) plus any prose mention.
- [ ] `.claude/reference/review-ingestion.md` and `.claude/reference/lab-notes.md` — rewrite the sentences that describe the flag's behaviour; do not merely delete the flag name and leave a dangling clause.

**Leave historical plans and completed runbooks alone** — `docs/superpowers/plans/2026-0*` and `docs/runbooks/evidence/**` are history, not cross-references to fix. The working rule targets live pointers.

- [ ] **Step 5: Full gate, then commit**

```bash
bash scripts/verify-gate.sh
git add -A && git commit -m "feat(#678): retire PAST_REPLIES_VIEW_ENABLED; History becomes All Reviews"
```

---

## Self-review

**Spec coverage.** S1 → T4/T7 (widened in place, no new page). S2 → T5 `draft_ready` state + T4 draft LATERAL. S3 → T5 `provenanceBadge` + T7 badge render. S4 → T8. S5 → `PAGE_SIZE` untouched. S6 → T4 `ORDER BY`. S7 → T7 (`InlineGeneratePanel` vs `EditReplyDrawer`). C1 → T3 D-B (`MAX`-derived version; `generate-draft.ts` untouched). C2 → nothing to do (shipped). C3 → T3 (`enforceDashboardRegenRateLimit` before DB work). C4 → non-goal, carried into the PR body. §6.4 → unchanged Regenerate lane, still `EDIT_REPLIES_ENABLED`-gated. Ticket "do NOT add a second auto-approval guard" → T2 assertion only.

**Placeholders.** None: every code step carries real code; every command is runnable.

**Type consistency.** `ReviewRowState`, `ProvenanceBadge`, `deriveRowState`, `provenanceBadge`, `groupReplies`, `peekRegenBudgetBatch`, `PastRepliesPageView`'s four renamed fields, and the route error strings (`review_not_found`, `already_answered`, `draft_already_exists`, `regenerate_in_progress`, `rate_limited`, `regen_limit_reached`) are spelled identically in every task that mentions them.

**Closed by F3 — was the known gap.** `is_orphan` used to be caller-set (orphan rows arrived from a separate query, not a column), making the discriminant depend on mapper discipline. Step 1's `orphan_sidecar` LATERAL makes it a column on the single row source, so `deriveRowState` reads data in every path and `toOrphanCardRow` disappears along with the query that fed it.

---

# Round-1 revisions (apply before executing)

Plan review round 1 returned `VERDICT: REVISE` — 9 findings, all accepted.
Full triage: `docs/reviews/feat-678-reviews-list-generate/plan-round1.md`.
Owner decisions on the two that needed one: `…-deviations.md` D1, D2.

Already patched into the tasks above: **F3** (orphan query folded into the main
query — Task 4 Step 1 LATERALs + Step 2a deletion), **F7** (`, r.id DESC`
tie-breaker — Task 4), **D5** (`generate-draft.ts:107`, not `:106`).

> **F3 was completed pre-round-2, not in the round-1 commit.** The round-1 commit
> recorded F3 as a rationale paragraph under Task 4 while leaving Step 1's SQL
> block and the Self-review "known gap" describing the *pre-fix* design — a
> subagent following Step 1 verbatim would have built no orphan LATERAL and left
> `deriveRowState` with no `is_orphan` source. Applied for real at `7300c480+`:
> Step 1 gained `orphan_sidecar` + `orphan_superseded` and the `is_orphan` column,
> Step 2a now deletes the separate query and its merge, Task 5 Step 2b drops
> `groupReplies`' second parameter, and the "known gap" note is retired. Recorded
> here because "the fix is described" and "the fix is applied" are different
> states, and only the second one survives into code.

Apply the rest as follows.

## F1 — the property test must exercise production (Task 1 / Task 2)

The two `fast-check` properties stay (they satisfy the property-test-per-invariant
requirement and are cheap regression on the lane *set*), but they are **no longer
the primary evidence** — a hand-copied predicate drifts from `persist.ts`. Add a
test through the real `persistResponseAndNotify`:

`persistResponseAndNotify keeps an on_demand_generate v1 draft owner-only when AUTO_APPROVAL_ENABLED is true even if suppress_notification is false`

Assert: `approval_method` stays null, **no** `publish_response` outbox row, **no**
auto-policy audit row, and the candidate-only policy evaluation is skipped.
Passing `suppress_notification: false` is deliberate — it isolates `origin_lane`
as the guard actually under test.

## F5 — moderation-held drafts must not surface (Task 3 + Task 4)

**Invariant #4.** A high-severity moderated draft stays `pending_approval` with an
open `flagged_responses` row. As drafted, the poller returns *any* non-terminal
response as `ready` **with its text**, and the list renders `Draft ready` — both
surface held content and offer `Approve & post`.

Use `hasOpenFlag` (`src/lib/moderation/held-draft.ts`) — already the owner of this
fact and already imported by `http-routes.ts`. In the poller, a held response
returns `{ status: 'idle' }` (never `ready`, never `response_text`). In the list
query, a held response must not produce `draft_ready`; it groups as unanswered
with no affordance, since the owner's only path is admin re-notification.

New title: `GET draft-status never returns response_text or ready for a moderation-held response`

## F4 — poller titles (Task 1)

Three titles were added to `tests_to_add` (see D3). Task 3's "the poller titles"
previously referred to titles that did not exist — the #643 fabricated-citation
class. The third title pins the **intended** authorization model: same-account
sibling-location access is correct, not a leak; only cross-account is a leak.

## F6 — fail-open at the consumer (Task 7)

New title: `PastReplyCard leaves Regenerate enabled and hides the counter when the budget map has no entry`.
A missing map entry means **unknown**, never **0 remaining** — inverting that
disables every Regenerate button during a Redis outage.

## F2 — the race (Task 3, test only)

Add the two serialization titles plus the live-ingest race title. **Do not fix
`process-review.ts` here** — owner deferred to #680 (deviations D2). The file is
in-surface for the flag rename only.

## F8 — flags.ts truly collapses (Task 8, amendment #1)

Surface widened (deviations D1). One function survives:

```ts
export function editRepliesEnabled(): boolean {
  return readFlag('EDIT_REPLIES_ENABLED');
}
```

`replyEditingFlagEnabled` and `pastRepliesViewEnabled` are both **deleted**.
Rename the six call sites: `process-review.ts`, `ResponsePublisherWorker.ts`,
`failed-hook.ts` (these three called the raw-flag name) and the three
`past-replies` routes (`draft-status`, `draft/[responseId]`,
`_shared/edit-reply-request.ts`). Zero behaviour change — with the view flag gone
the composite and the raw read are the same predicate.

Also sweep the live non-`docs/` references codex found: `.claude/reference/review-ingestion.md`,
`.claude/reference/lab-notes.md`, `scripts/ci/process-env-baseline.ts`. **Leave
historical plans and completed runbooks alone** — they are history, not
cross-references to fix.

New title: `EDIT_REPLIES_ENABLED alone preserves stale-marking, edit-publish dispatch, and orphan conversion after view-flag retirement`

## F9 — C1 through the real chain (Task 3)

`discarding a v1 Generate draft retains it and the next POST generate enqueues v2`
must run against live Postgres. A mocked `MAX(version)=2` passes vacuously and
proves nothing about the retention behaviour C1 depends on.

---

# Round-2 revisions (applied)

Plan review round 2 (verification-only) returned `VERDICT: REVISE`. It confirmed
F1, F2, F3, F4, F6, F7 landed in the executable steps; **F5 and F9 had not, and
F8 was partial** — all three existed only in the Round-1 appendix above, exactly
the failure mode the F3 pre-dispatch catch had already exposed once. It also
found two defects the fixes themselves introduced. Full table:
`docs/reviews/feat-678-reviews-list-generate/plan-round2.md`.

**The systematic lesson — the round-1 revision pass wrote an appendix and patched
only two tasks.** Four of nine fixes never reached a checkbox. Any future round's
brief must ask "does the executable step do it?", never "does the plan say it?".

| # | Was | Now applied at |
|---|---|---|
| F5 | Appendix only; Task 3's poller returned every non-terminal draft as `ready` with text, Task 4's LATERAL had no held check | Task 3 poller `EXISTS(... flagged_responses ...) AS held` → `{status:'idle'}`; Task 4 draft LATERAL carries `held`; Task 5 `held` state |
| F8 | Appendix only; Task 8 Step 4 grepped `docs/` and never edited the 3 live refs | Task 8 Step 4 checkboxes for `process-env-baseline.ts`, `review-ingestion.md`, `lab-notes.md` |
| F9 | Appendix only; Task 1 created no integration suite for the generate route | Task 1 creates `generate-version.integration.test.ts` |
| Defect A | F3's deletion of `toOrphanCardRow` left the orphan field mapping unspecified — recovery silently unreachable | Task 5 mapping table (`failed_response_id`, `response_id`, `failed_posting_error`, `approved_text`, nulls) |
| Defect B | Five-state union could not represent "held, no affordance" — filtered → `generate`, kept → `draft_ready` | Sixth `held` state + `draft_held` on the same branch as `draft_ready` (D9) |

Also corrected: the stale "37 titles" count at Task 1 (now 52 — see D8).

**Not adopted from round 1's F5 wording:** "use `hasOpenFlag`". That function is
`(tx: TransactionSql, responseId)` — an in-tx, post-`FOR UPDATE` release gate
(`held-draft.ts:38`). Neither new site is a transaction, and `held-draft.ts` is
**outside `allowed_edit_surface`**, so adding a read-path helper there would burn
surface amendment #2 of 2 and trip the abort criteria. Both sites spell the
`EXISTS` inline against `flagged_responses`, with a comment naming `held-draft.ts`
as the semantic owner. Consolidating the predicate is a #680 follow-up (D6).
