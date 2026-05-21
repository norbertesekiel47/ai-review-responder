# Edit Existing Replies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingest already-replied Google reviews into RepWorth as `posted` responses, surface them in a new "Past Replies" tab, and let owners edit/regenerate/republish within their tier — with a publisher that DELETE+POSTs against Zernio under explicit lock + orphan-recovery semantics.

**Architecture:** Single feature-flag (`EDIT_EXISTING_REPLIES_ENABLED`) gates BOTH the ingestion path inside `reconcileExternallyAnsweredReview` and the Past Replies UI. The async edit-publisher branch in `ResponsePublisherWorker` runs DELETE-before-POST inside one open transaction, holding `reviews FOR UPDATE` + `responses FOR UPDATE` across the external Zernio I/O so `processReview` content-changes serialize against it. Per-CATCH commit semantics handle each external outcome (success/permanent/transient/auth/409 verifier matches/mismatch/indeterminate). Recovery from "DELETE-success + POST-failure" orphan state goes via two new owner-driven routes (`/retry`, `/restore-original`) with branch-shape validation that prevents `/retry` from undoing a previously-applied `/restore-original`.

**Tech Stack:** TypeScript 5 strict + Next.js 14 App Router (Vercel UI) + Postgres.js v3 (`@/lib/db/server`) + BullMQ + Vitest + Playwright + Supabase migrations + Zernio HTTP client (`src/lib/zernio/client.ts`).

**Spec reference:** `docs/superpowers/specs/2026-05-01-edit-existing-replies-design.md`. Where this plan and the spec disagree, the spec wins.

**Migration number:** This spec uses migration **031** (next free; 030 is the most recent landed one).

**Branching:** All work lands on a single feature branch `feat/edit-existing-replies`. Phase A (code shipped, flag off) is the merge target; Phase B is a one-line env config change after staging soak.

---

## File Structure

**New files**

- `supabase/migrations/031_edit_existing_replies.sql` — adds `reviews.external_reply_ingested_at`, `zernio_backfill_runs.external_reply_ingested_count`, partial unique index `responses_one_posted_per_review` (CONCURRENTLY), optional `idx_reviews_business_review_date` (CONCURRENTLY, only if absent).
- `src/lib/responses/edit-existing.ts` — exports `assertCanEditReply` (tier+ownership gate) + `validateOptimisticConcurrency` (in-tx hash+version check) + structured error classes (`PremiumRequiredError`, `ReviewChangedError`, `ResponseChangedError`, `ForbiddenError`, `NotFoundError`).
- `src/lib/responses/__tests__/edit-existing.test.ts` — unit tests for the helpers.
- `src/app/api/dashboard/past-replies/draft/route.ts` — POST handler (manual + regenerate modes).
- `src/app/api/dashboard/past-replies/draft/[responseId]/route.ts` — PATCH (edit further) + DELETE (cancel).
- `src/app/api/dashboard/past-replies/draft-status/route.ts` — GET poll.
- `src/app/api/dashboard/past-replies/publish/route.ts` — POST publish (transition to approved/edited + outbox).
- `src/app/api/dashboard/past-replies/[responseId]/retry/route.ts` — POST recovery for `delete_failed_*` / `post_after_delete_failed_*` rows.
- `src/app/api/dashboard/past-replies/[responseId]/restore-original/route.ts` — POST recovery that INSERTs a fresh `pending_approval` row from a previously-posted superseded sibling.
- `src/app/api/dashboard/past-replies/__tests__/draft.test.ts`, `publish.test.ts`, `retry.test.ts`, `restore-original.test.ts`, `cross-origin.test.ts` — route tests.
- `src/app/(authenticated)/dashboard/past-replies/page.tsx` — server component that paginates and bucket-renders past replies.
- `src/components/dashboard/PastReplyCard.tsx` — single-row card (review + reply text + Edit/lock badge).
- `src/components/dashboard/EditReplyDrawer.tsx` — slide-out editor with 6 states (initial, manual, regenerating, regenerate-preview, publishing, recovery).
- `src/components/dashboard/HistoricalUpgradeBanner.tsx` — single banner above non-premium historical section.
- `worker/jobs/__tests__/ResponsePublisherWorker-edit.test.ts` — branch-outcome + lock-protocol tests for the new edit-publisher branch.
- `worker/__tests__/integration-edit-existing-reply.test.ts` — full-pipeline integration tests against real Postgres.
- `e2e/edit-existing-reply.spec.ts` — Playwright happy-path + tier gate + cancel.
- `scripts/zernio-backfill-external-replies.ts` — one-off CLI for retroactive ingestion.

**Modified files**

- `src/lib/zernio/types.ts` — add `'delete_reply'` to `EndpointKind`.
- `src/lib/zernio/errors.ts` — add `ZernioReplyAlreadyDeletedError`.
- `src/lib/zernio/client.ts` — add `deleteReply()`, special-case 404 + 403/`inbox_addon_required`, extend `mockResponse` switch, extend `NO_BODY_ENDPOINTS`.
- `src/lib/zernio/__tests__/client.test.ts` — coverage for new branches.
- `worker/jobs/zernio-ingest-shared.ts` — extend `reconcileExternallyAnsweredReview` with two new flag-gated branches (`insertImportedReview` + `insertImportedResponse`); bump `external_reply_ingested_count`.
- `worker/jobs/__tests__/zernio-ingest-shared.test.ts` — flag-on / flag-off coverage for the new branches.
- `worker/jobs/ResponsePublisherWorker.ts` — Phase A pre-flight + Phase B locked tx for the edit-publisher branch (gated by `EDIT_EXISTING_REPLIES_ENABLED`); reuse `verify409InTx`.
- `worker/jobs/publisher-error-handlers.ts` — add `verify409InTx(tx, ...)` (tx-aware variant of `verify409AndDispose`).
- `worker/index.ts` — extend the publisher `onFailed` hook with the orphan-marker conversion (BEFORE the existing transient fallback).
- `src/lib/reviews/process-review.ts` — add unconditional stale-marking UPDATE at the TOP of the content-change block.
- `src/components/OwnerNav.tsx` — add "Past Replies" nav link (pointing at `/dashboard/past-replies`).
- `src/lib/responses/voice-learning.ts` — **no functional change**, just a doc comment about imported-reply non-inclusion (per spec §8 follow-up).
- `docs/runbooks/zernio-launch-runbook.md` — append a "Edit existing replies" section (Phase A/B rollout, monitoring thresholds).

**File responsibilities at a glance**

| File | Owns |
|---|---|
| `supabase/migrations/031_edit_existing_replies.sql` | Schema additions + the `responses_one_posted_per_review` invariant. |
| `src/lib/responses/edit-existing.ts` | Permission + optimistic-concurrency primitives, called from every API route. |
| `src/app/api/dashboard/past-replies/**/*.ts` | All seven HTTP routes; each wrapped with `withSameOrigin` (mutating routes) + `requireRole('owner')` + flag check. |
| `src/lib/zernio/client.ts` | `deleteReply` + new error classifications. |
| `worker/jobs/zernio-ingest-shared.ts` | The two new branches inside `reconcileExternallyAnsweredReview`. |
| `worker/jobs/ResponsePublisherWorker.ts` | Phase A non-locking pre-flight + Phase B locked DELETE+POST tx with per-CATCH commit semantics. |
| `worker/jobs/publisher-error-handlers.ts` | `verify409InTx` (tx-aware verifier returning a discriminated union). |
| `worker/index.ts` | Orphan-marker → `'failed'` + `'post_after_delete_failed_retry_exhausted'` conversion in `onFailed`. |
| `src/lib/reviews/process-review.ts` | Mark `failed` rows with allowlisted prefixes as `stale_after_review_changed` when the customer edits the review. |
| `src/app/(authenticated)/dashboard/past-replies/**` | Server-rendered tab + client drawer. |

---

## Task Sequence

Tasks 1–4 land the data layer + Zernio client + ingestion. Tasks 5–10 land the publisher rewrite (locked tx + 409 verifier + onFailed hook + process-review change). Tasks 11–14 land the edit-existing helper + the 7 API routes. Tasks 15–17 land the frontend (page + drawer + nav). Tasks 18–20 land tests + the backfill script + runbook update. Each commit is atomic and tests pass before moving on. **Use `process.env.EDIT_EXISTING_REPLIES_ENABLED === 'true'` everywhere — no `NEXT_PUBLIC_*` companion (server-authoritative; the dashboard learns the flag via the page server component).**

---

### Task 1: Migration 031 — schema + indexes

**Files:**
- Create: `supabase/migrations/031_edit_existing_replies.sql`

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/031_edit_existing_replies.sql`:

```sql
-- supabase/migrations/031_edit_existing_replies.sql
-- IMPORTANT: this file mixes transactional DDL with CONCURRENTLY index
-- creation. Apply non-transactionally — uncheck the "single transaction" box
-- in the Supabase SQL editor, OR split at the obvious boundary if your
-- runner doesn't support per-statement isolation.
--
-- See docs/superpowers/specs/2026-05-01-edit-existing-replies-design.md §4.2.

-- 1. Track which reviews came in already-replied at first ingest.
ALTER TABLE reviews
  ADD COLUMN IF NOT EXISTS external_reply_ingested_at TIMESTAMPTZ NULL;

-- 2. Counter for backfill summary visibility.
ALTER TABLE zernio_backfill_runs
  ADD COLUMN IF NOT EXISTS external_reply_ingested_count INTEGER NOT NULL DEFAULT 0;

-- 3. At any time exactly ONE responses row per review can be 'posted'
--    (Google has at most one live reply per review). Protects against
--    publisher bugs that might double-post.
--
--    CONCURRENTLY is REQUIRED — migration 023's note (supabase/migrations/
--    023_non_terminal_response_uniqueness.sql) flags that plain index
--    creation can take ACCESS EXCLUSIVE on responses. CONCURRENTLY uses
--    a less-blocking approach (RowExclusive + ShareUpdateExclusive) at the
--    cost of doing two table scans and not running inside a transaction.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS responses_one_posted_per_review
  ON responses (review_id)
  WHERE status = 'posted';

-- 4. Index that supports the Past Replies query
--    (ORDER BY review_date DESC, scoped to business_id). Most existing
--    per-business queries already use a similar pattern, but plan-time
--    inspection didn't find an exact match for (business_id, review_date DESC).
--    Use IF NOT EXISTS so re-running is safe; CONCURRENTLY because reviews
--    is sizable in production. Drop this clause if a regression query plan
--    shows an existing index already serves the query.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_reviews_business_review_date
  ON reviews (business_id, review_date DESC);
```

- [ ] **Step 2: Pre-flight check (run in Supabase SQL editor BEFORE applying)**

Run:

```sql
SELECT review_id, count(*) FROM responses
  WHERE status = 'posted'
  GROUP BY review_id
  HAVING count(*) > 1;
-- expect: 0 rows
```

If non-empty, BLOCK and investigate the duplicate `posted` rows before proceeding. Migration MUST NOT be applied until this is empty.

- [ ] **Step 3: Apply on local Supabase + verify the index is valid**

After applying the migration:

```sql
SELECT indexname, indisvalid FROM pg_indexes
  JOIN pg_class ON pg_class.relname = indexname
  JOIN pg_index ON pg_index.indexrelid = pg_class.oid
  WHERE indexname IN ('responses_one_posted_per_review', 'idx_reviews_business_review_date');
-- expect: indisvalid = true for both
```

If `indisvalid=false`, the CONCURRENTLY build was interrupted: `DROP INDEX <name>;` then re-run.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/031_edit_existing_replies.sql
git commit -m "feat(migration-031): add external_reply_ingested_at + responses_one_posted_per_review index"
```

---

### Task 2: Zernio client — `deleteReply` + new error class

**Files:**
- Modify: `src/lib/zernio/types.ts`
- Modify: `src/lib/zernio/errors.ts`
- Modify: `src/lib/zernio/client.ts`
- Test: `src/lib/zernio/__tests__/client.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/lib/zernio/__tests__/client.test.ts`:

```ts
describe('zernioClient.deleteReply', () => {
  it('issues DELETE /v1/inbox/reviews/{reviewId}/reply with 15s timeout', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(null, { status: 204 }) as unknown as Response,
    );
    process.env.ZERNIO_API_KEY = 'test-key';
    process.env.MOCK_EXTERNAL_APIS = 'false';

    await zernioClient.deleteReply('acct-1', 'review-abc');

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/v1/inbox/reviews/review-abc/reply'),
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('throws ZernioReplyAlreadyDeletedError on 404', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('{}', { status: 404 }) as unknown as Response,
    );
    process.env.ZERNIO_API_KEY = 'test-key';
    process.env.MOCK_EXTERNAL_APIS = 'false';

    await expect(zernioClient.deleteReply('acct-1', 'review-abc'))
      .rejects.toBeInstanceOf(ZernioReplyAlreadyDeletedError);
  });

  it('throws ZernioPermanentError(inbox_addon_required) on 403 with that code', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 'inbox_addon_required' }), { status: 403 }) as unknown as Response,
    );
    process.env.ZERNIO_API_KEY = 'test-key';
    process.env.MOCK_EXTERNAL_APIS = 'false';

    await expect(zernioClient.deleteReply('acct-1', 'review-abc'))
      .rejects.toMatchObject({ name: 'ZernioPermanentError', kind: 'inbox_addon_required' });
  });

  it('falls through to ZernioAuthError on plain 403', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('{"code":"forbidden"}', { status: 403 }) as unknown as Response,
    );
    process.env.ZERNIO_API_KEY = 'test-key';
    process.env.MOCK_EXTERNAL_APIS = 'false';

    await expect(zernioClient.deleteReply('acct-1', 'review-abc'))
      .rejects.toBeInstanceOf(ZernioAuthError);
  });

  it('mock-mode short-circuits to undefined success', async () => {
    process.env.MOCK_EXTERNAL_APIS = 'true';
    await expect(zernioClient.deleteReply('acct-1', 'review-abc')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
pnpm vitest run src/lib/zernio/__tests__/client.test.ts -t deleteReply
```
Expected: FAIL — `zernioClient.deleteReply is not a function`, `ZernioReplyAlreadyDeletedError is not defined`.

- [ ] **Step 3: Add `'delete_reply'` to `EndpointKind`**

In `src/lib/zernio/types.ts`, extend the union:

```ts
export type EndpointKind =
  | 'select_location'
  | 'publish_reply'
  | 'list_reviews'
  | 'list_locations'
  | 'create_profile'
  | 'delete_profile'
  | 'delete_account'
  | 'start_connect'
  | 'delete_reply';
```

- [ ] **Step 4: Add `ZernioReplyAlreadyDeletedError`**

Append to `src/lib/zernio/errors.ts`:

```ts
export class ZernioReplyAlreadyDeletedError extends Error {
  constructor() {
    super('Zernio reply already deleted (404)');
    this.name = 'ZernioReplyAlreadyDeletedError';
  }
}
```

- [ ] **Step 5: Implement `deleteReply` + classifier branches + mock case**

In `src/lib/zernio/client.ts`:

1. Import `ZernioReplyAlreadyDeletedError` at the top.
2. Add `'delete_reply'` to the existing `NO_BODY_ENDPOINTS` constant: `new Set<EndpointKind>(['delete_profile', 'delete_account', 'delete_reply']);`.
3. In `classifyAndParse`, BEFORE the generic 401/403 branch (around line 60) AND BEFORE the catch-all 4xx branch, insert:

```ts
if (res.status === 404 && endpointKind === 'delete_reply') {
  throw new ZernioReplyAlreadyDeletedError();
}
if (res.status === 403 && endpointKind === 'delete_reply') {
  const body = (await res.json().catch(() => ({}))) as { code?: string };
  if (body?.code === 'inbox_addon_required') {
    throw new ZernioPermanentError('inbox_addon_required', { endpointKind, body });
  }
  // Fall through to existing 401/403 handler — re-throw the auth error.
  throw new ZernioAuthError(res.status, JSON.stringify(body));
}
```

4. In the `mockResponse` switch, add:

```ts
case 'delete_reply':
  return undefined as unknown as T;
```

5. Append the `deleteReply` method to the `zernioClient` object literal:

```ts
deleteReply: (accountId: string, reviewId: string) =>
  request<void>({
    method: 'DELETE',
    path: `/v1/inbox/reviews/${encodeURIComponent(reviewId)}/reply`,
    endpointKind: 'delete_reply',
    timeoutMs: 15_000,            // explicit; matches postReply (publisher lock-window assumption)
    body: { accountId },          // see spec §6.4 manual QA notes
  }),
```

- [ ] **Step 6: Run tests — verify they pass**

```bash
pnpm vitest run src/lib/zernio/__tests__/client.test.ts -t deleteReply
```
Expected: PASS for all 5 cases.

- [ ] **Step 7: Commit**

```bash
git add src/lib/zernio/types.ts src/lib/zernio/errors.ts src/lib/zernio/client.ts src/lib/zernio/__tests__/client.test.ts
git commit -m "feat(zernio-client): add deleteReply + ZernioReplyAlreadyDeletedError + inbox_addon_required classification"
```

---

### Task 3: Ingestion — extend `reconcileExternallyAnsweredReview` (flag-gated)

**Files:**
- Modify: `worker/jobs/zernio-ingest-shared.ts`
- Test: `worker/jobs/__tests__/zernio-ingest-shared.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `worker/jobs/__tests__/zernio-ingest-shared.test.ts`:

```ts
describe('reconcileExternallyAnsweredReview — flag-gated import branches', () => {
  beforeEach(() => { delete process.env.EDIT_EXISTING_REPLIES_ENABLED; });

  it('flag OFF: no-match branch is silent no-op (today\'s behavior)', async () => {
    // Seed: business + zernio_backfill_runs row, NO matching review row.
    // Call reconcileExternallyAnsweredReview with reviewReply set.
    // Assert: reviews count unchanged, responses count unchanged,
    //         external_reply_ingested_count == 0.
  });

  it('flag ON + no-match: INSERTs reviews row + posted response + bumps counter', async () => {
    process.env.EDIT_EXISTING_REPLIES_ENABLED = 'true';
    // Seed: business + zernio_backfill_runs row (completed_at IS NULL),
    //       NO matching review row.
    // Call.
    // Assert:
    //   - 1 row inserted into reviews with provider='zernio',
    //     external_reply_ingested_at IS NOT NULL.
    //   - 1 row inserted into responses with status='posted', version=1,
    //     all 3 text columns equal canonicalized reply, llm_provider IS NULL.
    //   - external_reply_ingested_count == 1 on the active backfill run.
  });

  it('flag ON + matched but no active responses: INSERTs response only, version > 1 if prior terminals exist', async () => {
    process.env.EDIT_EXISTING_REPLIES_ENABLED = 'true';
    // Seed: review row + a prior 'failed' response at version=2.
    // Call.
    // Assert:
    //   - reviews count unchanged.
    //   - new responses row inserted at version=3, status='posted'.
    //   - external_reply_ingested_count bumped.
  });

  it('flag ON + matched WITH active response: today\'s supersede/protect logic, no new INSERTs, no counter bump', async () => {
    process.env.EDIT_EXISTING_REPLIES_ENABLED = 'true';
    // Today's regression coverage continues to apply.
  });

  it('reply text is canonicalized (BOM, NFC, CRLF stripped)', async () => {
    process.env.EDIT_EXISTING_REPLIES_ENABLED = 'true';
    // Seed BOM + CRLF in reviewReply.comment.
    // Assert response.response_text contains no BOM and only LF newlines.
  });

  it('idempotent: re-running on same Zernio review is a no-op', async () => {
    process.env.EDIT_EXISTING_REPLIES_ENABLED = 'true';
    // Run twice; reviews count == 1, responses count == 1, counter == 1.
  });

  it('does not fire when reviewReply === null', async () => {
    process.env.EDIT_EXISTING_REPLIES_ENABLED = 'true';
    // reviewReply: null.
    // Assert: no INSERTs anywhere.
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
pnpm vitest run worker/jobs/__tests__/zernio-ingest-shared.test.ts -t "flag-gated import branches"
```
Expected: FAIL on the new cases (flag-OFF case may pass already).

- [ ] **Step 3: Add the helper functions and extend the reconcile flow**

In `worker/jobs/zernio-ingest-shared.ts`, replace the body of the `if (matchedRows.length === 0)` early-return AND the `if (activeResponses.length === 0)` early-return with flag-gated branches. Pseudocode-converted SQL:

```ts
// Insert this near the top of the file (after the imports), preserving
// existing helpers:

import { fromZernioReview } from '../../src/lib/reviews/zernio-field-match';
// (existing imports stay)

const FLAG_ON = () => process.env.EDIT_EXISTING_REPLIES_ENABLED === 'true';

async function insertImportedReview(
  tx: postgres.TransactionSql,
  businessId: string,
  accountId: string,
  locationId: string,
  target: ZernioReview,
): Promise<string> {
  const matchFields = fromZernioReview(target);
  const providerReviewName = `zernio://${accountId}/locations/${locationId}/reviews/${target.id}`;
  const providerLocationName = `zernio://${accountId}/locations/${locationId}`;

  // Race-safe via ON CONFLICT DO UPDATE (DO NOTHING + RETURNING is not
  // race-safe: snapshot can't see the just-committed sibling).
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO reviews (
      id, business_id, provider, provider_review_id, provider_review_name,
      provider_location_name, reviewer_name, star_rating, review_text,
      review_date, detected_language, review_content_hash, detected_at,
      status, external_reply_ingested_at
    )
    VALUES (
      gen_random_uuid(), ${businessId}, 'zernio', ${target.id},
      ${providerReviewName}, ${providerLocationName},
      ${matchFields.reviewer_name}, ${matchFields.star_rating},
      ${matchFields.review_text_trimmed},
      to_timestamp(${matchFields.created_at_ms} / 1000.0),
      ${detectLanguageOrNull(matchFields.review_text_trimmed)},
      ${computeReviewContentHash(matchFields)},
      NOW(), 'new', NOW()
    )
    ON CONFLICT (provider, provider_review_name) DO UPDATE
      SET id = reviews.id
    RETURNING id
  `;
  return row!.id;
}

async function insertImportedResponse(
  tx: postgres.TransactionSql,
  businessId: string,
  reviewId: string,
  reviewLanguage: string | null,
  externalReply: { comment: string; updateTime: string },
): Promise<void> {
  const replyText = canonicalizeReplyText(externalReply.comment);

  // version = COALESCE(MAX(version), 0) + 1 — protects against pre-existing
  // terminal rows occupying v1 in the "matched but no active" branch.
  await tx`
    INSERT INTO responses (
      id, review_id, business_id,
      response_text, approved_text, original_draft_text, edited_text,
      response_language, version, status,
      approved_at, posted_at,
      llm_provider, llm_model, prompt_tokens, completion_tokens
    )
    SELECT
      gen_random_uuid(), ${reviewId}, ${businessId},
      ${replyText}, ${replyText}, ${replyText}, NULL,
      ${reviewLanguage},
      COALESCE((SELECT MAX(version) FROM responses WHERE review_id = ${reviewId}), 0) + 1,
      'posted',
      ${externalReply.updateTime}::timestamptz, ${externalReply.updateTime}::timestamptz,
      NULL, NULL, NULL, NULL
    ON CONFLICT (review_id) WHERE status = 'posted' DO NOTHING
  `;
}

async function bumpExternalReplyIngestedCount(
  tx: postgres.TransactionSql,
  businessId: string,
): Promise<void> {
  // Bump the ACTIVE backfill run (completed_at IS NULL); no-op for review-
  // ingest worker calls (no active row → this UPDATE just touches 0 rows).
  await tx`
    UPDATE zernio_backfill_runs
    SET external_reply_ingested_count = external_reply_ingested_count + 1,
        updated_at = NOW()
    WHERE business_id = ${businessId} AND completed_at IS NULL
  `;
}
```

In the existing `reconcileExternallyAnsweredReview` body, replace the two no-op early returns:

```ts
// (replace existing early-return at "matchedRows.length === 0")
if (matchedRows.length === 0) {
  if (!FLAG_ON()) {
    logger.log(`External reply on previously-unseen review ${target.id} — flag off, not ingesting`);
    return;
  }
  const newReviewId = await insertImportedReview(tx, businessId, accountId, locationId, target);
  await insertImportedResponse(
    tx, businessId, newReviewId,
    detectLanguageOrNull(target.comment),
    target.reviewReply!,
  );
  await bumpExternalReplyIngestedCount(tx, businessId);
  logger.log(`Imported external reply for previously-unseen review ${target.id}`);
  return;
}

// (replace existing early-return at "activeResponses.length === 0")
if (activeResponses.length === 0) {
  if (!FLAG_ON()) {
    logger.log(`External reply detected but no active responses for review row(s) ${reviewIds.join(',')} — flag off, no-op`);
    return;
  }
  // We know matchedRows[0] is the canonical review row; pick the first.
  await insertImportedResponse(
    tx, businessId, matchedRows[0]!.id,
    null,  // language unknown for legacy serpapi rows; falls back to NULL
    target.reviewReply!,
  );
  await bumpExternalReplyIngestedCount(tx, businessId);
  logger.log(`Imported external reply onto existing review row ${matchedRows[0]!.id}`);
  return;
}
```

`detectLanguageOrNull` and `computeReviewContentHash` already exist in the worker dependencies (used elsewhere in this file's import graph). If they don't, the implementer adds thin wrappers in this file (no fancy logic — `franc` for language, `crypto.createHash('sha256').update(...)` for hash). Reuse the already-imported `canonicalizeReplyText`.

- [ ] **Step 4: Run tests — verify they pass**

```bash
pnpm vitest run worker/jobs/__tests__/zernio-ingest-shared.test.ts
```
Expected: PASS for all cases (incl. existing regression cases).

- [ ] **Step 5: Commit**

```bash
git add worker/jobs/zernio-ingest-shared.ts worker/jobs/__tests__/zernio-ingest-shared.test.ts
git commit -m "feat(zernio-ingest): import external replies as posted responses (flag-gated)"
```

---

### Task 4: Process-review — stale-marking for failed orphan rows

**Files:**
- Modify: `src/lib/reviews/process-review.ts`
- Test: `src/lib/reviews/__tests__/process-review.test.ts` (existing) — add cases.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/reviews/__tests__/process-review.test.ts`:

```ts
describe('processReview — stale-marking for failed orphan rows', () => {
  it('flips delete_failed_* failed row to stale_after_review_changed when content changes', async () => {
    // Seed: review with hash A, failed response with posting_error='delete_failed_inbox_addon_required'.
    // Call processReview with hash B.
    // Assert: failed row's posting_error === 'stale_after_review_changed'.
  });

  it('flips post_after_delete_failed_* failed row to stale_after_review_changed when content changes', async () => {
    // Same shape; posting_error='post_after_delete_failed_<kind>'.
    // Assert: posting_error === 'stale_after_review_changed'.
  });

  it('does NOT touch failed rows with other posting_error values (review_content_changed, generic, etc.)', async () => {
    // Seed: failed row with posting_error='review_content_changed'.
    // Call processReview with new hash.
    // Assert: posting_error UNCHANGED.
  });

  it('runs even when there is no active response (insertion point A)', async () => {
    // Seed: failed row with delete_failed_*, NO active response.
    // Call processReview with new hash.
    // Assert: stale-marking applied; outbox enqueued for fresh generation
    //         (today's "no activeResponse" branch behavior unchanged).
  });

  it('runs even when active response is approved/edited (insertion point C)', async () => {
    // Seed: failed row with delete_failed_*, active response status='approved'.
    // Call processReview with new hash.
    // Assert: stale-marking applied AND active 'approved' row superseded.
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
pnpm vitest run src/lib/reviews/__tests__/process-review.test.ts -t "stale-marking"
```
Expected: FAIL.

- [ ] **Step 3: Add the unconditional UPDATE at the TOP of the content-change block**

In `src/lib/reviews/process-review.ts`, inside `processExistingReview` immediately after the `existingHash === contentHash` early-return AND BEFORE the `UPDATE reviews ...` statement, add:

```ts
// ─── Stale-mark recoverable orphan-state failed rows BEFORE branching ───
// Spec §4.5 "Stale-edit invalidation" — runs unconditionally whenever a
// content change is detected, regardless of whether an active response
// exists or what its status is. The reviews FOR UPDATE lock acquired
// in processReview() above serializes us against /retry and
// /restore-original — they wait for our COMMIT before reading the failed
// row's posting_error.
await tx`
  UPDATE responses
  SET posting_error = 'stale_after_review_changed',
      updated_at = NOW()
  WHERE review_id = ${existing.id}
    AND status = 'failed'
    AND (posting_error LIKE 'delete_failed_%'
         OR posting_error LIKE 'post_after_delete_failed_%')
`;
```

This MUST be ABOVE the existing `UPDATE reviews ...` and ALL three branches (`if (!activeResponse)`, `if (status === 'pending_approval')`, the supersede branch). Placement is load-bearing — see spec §4.5.

- [ ] **Step 4: Run tests — verify they pass**

```bash
pnpm vitest run src/lib/reviews/__tests__/process-review.test.ts
```
Expected: PASS for new + existing cases.

- [ ] **Step 5: Commit**

```bash
git add src/lib/reviews/process-review.ts src/lib/reviews/__tests__/process-review.test.ts
git commit -m "feat(process-review): mark recoverable orphan-state failed rows stale on review content change"
```

---

### Task 5: Publisher — add `verify409InTx` (tx-aware verifier)

**Files:**
- Modify: `worker/jobs/publisher-error-handlers.ts`
- Test: `worker/jobs/__tests__/publisher-error-handlers.test.ts` (existing)

- [ ] **Step 1: Write the failing test**

Append:

```ts
describe('verify409InTx — tx-aware verifier returning a discriminated union', () => {
  it('returns matches_our_text when canonicalized text equals approved_text', async () => {
    // Mock listAllReviews to return [{ id: 'rev-X', reviewReply: { comment: 'Thanks!' } }].
    // approved_text = 'Thanks!\n\n'  (canonicalize strips trailing whitespace).
    // Call verify409InTx(tx, ...) inside sql.begin.
    // Assert: { disposition: 'matches_our_text', verifierText: 'Thanks!' }.
  });

  it('returns mismatch with verifier-observed text when canonical text differs', async () => {
    // Mock listAllReviews to return reviewReply.comment = 'Different reply'.
    // Assert: { disposition: 'mismatch', verifierText: 'Different reply' }.
  });

  it('returns indeterminate review_not_found_after_pagination when target not in walk', async () => {
    // Mock listAllReviews to return reviews without our zernio_review_id.
    // Assert: { disposition: 'indeterminate', reason: 'review_not_found_after_pagination' }.
  });

  it('returns indeterminate review_found_but_reply_null when target reviewReply is null', async () => {
    // Mock listAllReviews to return [{ id: 'rev-X', reviewReply: null }].
    // Assert: { disposition: 'indeterminate', reason: 'review_found_but_reply_null' }.
  });

  it('does NOT call markOutboxCompleted itself (caller is responsible)', async () => {
    // Spy on markOutboxCompleted.
    // Assert spy not called.
  });

  it('does NOT mutate responses or sibling rows (caller is responsible)', async () => {
    // Run all three dispositions; assert no UPDATE FROM responses.
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
pnpm vitest run worker/jobs/__tests__/publisher-error-handlers.test.ts -t verify409InTx
```
Expected: FAIL — `verify409InTx is not a function`.

- [ ] **Step 3: Implement `verify409InTx`**

In `worker/jobs/publisher-error-handlers.ts`, BELOW `verify409AndDispose`:

```ts
/**
 * Tx-aware variant of verify409AndDispose used by the edit-publisher branch.
 * The outer tx holds responses FOR UPDATE on the candidate row; the existing
 * verify409AndDispose opens a separate connection and would self-deadlock.
 *
 * - Reads via the open `tx` (no separate connection).
 * - Returns a discriminated union; caller dispatches.
 * - Does NOT call markOutboxCompleted.
 * - Does NOT update responses / sibling rows.
 */
export type Verify409Disposition =
  | { disposition: 'matches_our_text'; verifierText: string }
  | { disposition: 'mismatch'; verifierText: string }
  | { disposition: 'indeterminate'; reason: 'review_not_found_after_pagination' | 'review_found_but_reply_null' | 'verifier_unknown_error'; meta: { pages_walked?: number; reviews_seen?: number; underlying_error?: string } }
  | { disposition: 'auth'; lookupErr: ZernioAuthError }
  | { disposition: 'permanent'; lookupErr: ZernioPermanentError | ZernioValidationError }
  | { disposition: 'transient'; lookupErr: ZernioTransientError };

interface Verify409InTxArgs {
  tx: postgres.TransactionSql;          // currently unused; reserved for future reads
  account_id: string;
  location_id: string;
  zernio_review_id: string;
  approved_text: string;
  logger: WorkerLogger;
}

export async function verify409InTx(args: Verify409InTxArgs): Promise<Verify409Disposition> {
  const { account_id, location_id, zernio_review_id, approved_text, logger } = args;

  // Reuse the page-cache + maxPages logic from verify409AndDispose.
  let maxPages = 4;
  try {
    const cachedPage = await getCachedZernioReviewPage(account_id, location_id, zernio_review_id);
    if (cachedPage !== null) maxPages = Math.min(cachedPage + 1, 4);
  } catch { /* fall back to 4 */ }

  let allReviews;
  try {
    allReviews = await zernioClient.listAllReviews(account_id, {
      locationId: location_id, pageSize: 50, maxPages,
    });
  } catch (lookupErr) {
    if (lookupErr instanceof ZernioAuthError) return { disposition: 'auth', lookupErr };
    if (lookupErr instanceof ZernioTransientError) return { disposition: 'transient', lookupErr };
    if (lookupErr instanceof ZernioPermanentError || lookupErr instanceof ZernioValidationError) {
      return { disposition: 'permanent', lookupErr };
    }
    return {
      disposition: 'indeterminate',
      reason: 'verifier_unknown_error',
      meta: { underlying_error: lookupErr instanceof Error ? lookupErr.message : String(lookupErr) },
    };
  }

  const found = allReviews.find((r) => r.id === zernio_review_id);
  if (!found) {
    return {
      disposition: 'indeterminate',
      reason: 'review_not_found_after_pagination',
      meta: { pages_walked: maxPages, reviews_seen: allReviews.length },
    };
  }
  if (found.reviewReply === null) {
    return { disposition: 'indeterminate', reason: 'review_found_but_reply_null', meta: {} };
  }

  const verifierText = canonicalizeReplyText(found.reviewReply.comment);
  const ourText = canonicalizeReplyText(approved_text);
  if (verifierText === ourText) return { disposition: 'matches_our_text', verifierText };
  return { disposition: 'mismatch', verifierText };
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
pnpm vitest run worker/jobs/__tests__/publisher-error-handlers.test.ts -t verify409InTx
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/jobs/publisher-error-handlers.ts worker/jobs/__tests__/publisher-error-handlers.test.ts
git commit -m "feat(publisher): add verify409InTx for the edit-publisher locked-tx branch"
```

---

### Task 6: Publisher — Phase A pre-flight (sub-task of Task 7)

**Files:**
- Modify: `worker/jobs/ResponsePublisherWorker.ts`
- Test: `worker/jobs/__tests__/ResponsePublisherWorker-edit.test.ts` (new file from Task 7 step 1; this task adds only the pre-flight)

- [ ] **Step 1: Implement Phase A pre-flight at the top of `handlePublishResponse`**

After the existing subscription guard + Zernio connection load, BEFORE the existing `lookupZernioReviewId` call, insert the pre-flight read + branch decision. Use spec §4.5 Phase A pseudocode verbatim. The branch goes one of three ways:

1. `existingPostedProbe IS NULL AND NOT isOrphanRetry` → fall through to the existing fresh-publish code (shape (a) from spec — control just continues; no `return`, no sentinel).
2. `existingPostedProbe IS NOT NULL OR isOrphanRetry` AND flag is on → enter Phase B locked tx (Task 7).
3. **Flag off** AND any of the above → fall through to today's behavior (existing fresh-publish code; the new edit-publisher branch is dormant).

```ts
// ── Phase A pre-flight (NEW; spec §4.5) ────────────────────────────────
const FLAG_ON = process.env.EDIT_EXISTING_REPLIES_ENABLED === 'true';

const [r0] = await sql<{ posting_error: string | null }[]>`
  SELECT posting_error FROM responses
  WHERE id = ${response_id} AND business_id = ${business_id}
`;
const isOrphanRetry =
  FLAG_ON &&
  typeof r0?.posting_error === 'string' &&
  r0.posting_error.endsWith('_after_delete_succeeded');

const [existingPostedProbe] = await sql<{ id: string }[]>`
  SELECT id FROM responses
  WHERE review_id = ${response.review_id}
    AND status = 'posted'
    AND id != ${response_id}
  LIMIT 1
`;

const enterEditPublisher = FLAG_ON && (existingPostedProbe || isOrphanRetry);
```

If `!enterEditPublisher`, fall through to the existing inline fresh-publish code (control continues; no `return`).

If `enterEditPublisher`, jump to the Task 7 Phase B implementation.

- [ ] **Step 2: Run the existing publisher tests — verify regression-clean**

```bash
pnpm vitest run worker/jobs/__tests__/ResponsePublisherWorker.test.ts
```
Expected: PASS (no behavior change for fresh-publish; pre-flight is non-locking and additive).

(No commit yet — Phase A is integrated with Phase B in Task 7.)

---

### Task 7: Publisher — Phase B locked tx (DELETE-before-POST)

**Files:**
- Modify: `worker/jobs/ResponsePublisherWorker.ts`
- Create: `worker/jobs/__tests__/ResponsePublisherWorker-edit.test.ts`

- [ ] **Step 1: Write the failing tests (full suite from spec §6.1)**

Create `worker/jobs/__tests__/ResponsePublisherWorker-edit.test.ts` with the following test cases (one `describe` per group):

```ts
describe('ResponsePublisherWorker — edit-publisher branch (Phase B)', () => {
  beforeEach(() => { process.env.EDIT_EXISTING_REPLIES_ENABLED = 'true'; });
  afterEach(() => { delete process.env.EDIT_EXISTING_REPLIES_ENABLED; vi.restoreAllMocks(); });

  // Pre-flight guards
  it('subscription cancelled → no Zernio call, outbox completed', async () => { /* per spec §6.1 */ });
  it('subscription past_due past grace → no Zernio call, outbox completed', async () => { /* */ });
  it('subscription active → proceeds to Phase B', async () => { /* */ });
  it('missing business row → outbox completed (no crash)', async () => { /* */ });

  // Branch decisions
  it('no sibling AND no orphan-marker → delegates to fresh-publish (no lock, no DELETE)', async () => { /* */ });
  it('no sibling BUT orphan-marker → enters Phase B no-DELETE branch', async () => { /* */ });
  it('sibling exists → DELETE called before POST', async () => { /* */ });

  // Per-CATCH commit semantics
  it('DELETE 404 → treated as DELETE-success; proceeds to POST', async () => { /* */ });
  it('DELETE permanent (inbox_addon_required) → response failed with delete_failed_inbox_addon_required, sibling UNCHANGED', async () => { /* */ });
  it('DELETE auth → handlePublisherAuthErrorTerminal fires, sibling UNCHANGED', async () => { /* */ });
  it('DELETE transient → ROLLBACK + throw (BullMQ retries)', async () => { /* */ });
  it('DELETE success + POST permanent → response failed with post_after_delete_failed_*, sibling SUPERSEDED', async () => { /* */ });
  it('DELETE success + POST transient → sibling SUPERSEDED committed, candidate stays publishable with posting_error=pending_after_delete_succeeded, throw retry', async () => { /* */ });
  it('DELETE success + POST auth → sibling SUPERSEDED, candidate awaiting_owner_connect with zernio_auth_error_after_delete_succeeded suffix', async () => { /* */ });

  // 409 verifier dispositions
  it('Edit-publisher 409 matches after DELETE success → sibling superseded, candidate posted, posting_error cleared', async () => { /* */ });
  it('Edit-publisher 409 mismatch after DELETE success → sibling superseded, candidate superseded, review_exception type=edit_publish_409_mismatch_after_delete inserted', async () => { /* */ });
  it('Edit-publisher 409 indeterminate after DELETE success → sibling superseded, posting_error=pending_after_delete_succeeded, throw retry', async () => { /* */ });
  it('Orphan-retry 409 matches → candidate posted (no sibling supersede; none exists)', async () => { /* */ });
  it('Orphan-retry 409 mismatch → candidate superseded, exception inserted', async () => { /* */ });

  // Lock-protocol (require TEST_DATABASE_POOL_URL)
  it.runIf(process.env.TEST_DATABASE_POOL_URL)('publisher holds reviews FOR UPDATE while processReview blocks', async () => { /* per spec §6.1 */ });
  it.runIf(process.env.TEST_DATABASE_POOL_URL)('POST-failure-after-DELETE commits the orphan state (sibling superseded + candidate failed)', async () => { /* */ });
  it.runIf(process.env.TEST_DATABASE_POOL_URL)('POST-transient-after-DELETE: second attempt does NOT call deleteReply again', async () => { /* */ });
  it.runIf(process.env.TEST_DATABASE_POOL_URL)('409 verifier no-deadlock (verify409InTx reads via open tx)', async () => { /* */ });
  it.runIf(process.env.TEST_DATABASE_POOL_URL)('affected-row-count assertion fires + retries with clean read', async () => { /* */ });
  it.runIf(process.env.TEST_DATABASE_POOL_URL)('orphan-marker retry exhaustion converts row to failed + post_after_delete_failed_retry_exhausted', async () => { /* */ });
  it.runIf(process.env.TEST_DATABASE_POOL_URL)('auth-after-DELETE-success preserves orphan marker through drain re-enqueue', async () => { /* */ });
  it.runIf(process.env.TEST_DATABASE_POOL_URL)('drain re-enqueue races processReview on suffixed orphan row → publisher early-exits idempotently', async () => { /* */ });
  it.runIf(process.env.TEST_DATABASE_POOL_URL)('worker/index.ts onFailed hook lock-order serialization (waits for processReview commit)', async () => { /* */ });
});
```

(Each test body is filled in per spec §6.1; the structure above is the full inventory. Use `setupZernioWorkerHarness()` shared helper if one exists in the existing publisher tests; otherwise reuse the existing `mockZernioClient` pattern from `worker/jobs/__tests__/ResponsePublisherWorker.test.ts`.)

- [ ] **Step 2: Run tests — verify they fail**

```bash
pnpm vitest run worker/jobs/__tests__/ResponsePublisherWorker-edit.test.ts
```
Expected: ALL FAIL (the Phase B branch doesn't exist yet).

- [ ] **Step 3: Implement Phase B locked-tx branch**

In `worker/jobs/ResponsePublisherWorker.ts`, when `enterEditPublisher` is true (from Task 6), enter `sql.begin(async (tx) => { ... })`. Inside the tx, follow spec §4.5 Phase B pseudocode literally:

1. **Lock acquisition (canonical order: review → response):**

```ts
const [reviewLock] = await tx`
  SELECT id FROM reviews
  WHERE id = ${response.review_id} AND business_id = ${business_id}
  FOR UPDATE
`;
if (!reviewLock) {
  await markOutboxFailed(outboxId, 'publish_orphan_response_review', outboxAttempt);
  Sentry.captureMessage('publish_orphan_response_review', { extra: { response_id, business_id } });
  return;
}

const [lockedResp] = await tx<{ id: string; status: string; approved_text: string | null; version: number; posting_error: string | null; review_id: string }[]>`
  SELECT id, status, approved_text, version, posting_error, review_id
  FROM responses
  WHERE id = ${response_id}
    AND status IN ('approved', 'edited', 'awaiting_owner_connect')
    AND business_id = ${business_id}
  FOR UPDATE
`;
if (!lockedResp) {
  // Row moved out of publishable state between Phase A and now. Idempotent exit.
  await markOutboxCompleted(outboxId, outboxAttempt);
  return;
}
if (lockedResp.review_id !== response.review_id) {
  await markOutboxFailed(outboxId, 'publish_review_id_drift', outboxAttempt);
  return;
}
const lockedIsOrphanRetry = typeof lockedResp.posting_error === 'string'
  && lockedResp.posting_error.endsWith('_after_delete_succeeded');
```

2. **Existing-posted lock + branch re-decision:**

```ts
const [existingPosted] = await tx<{ id: string; version: number }[]>`
  SELECT id, version FROM responses
  WHERE review_id = ${response.review_id}
    AND status = 'posted'
    AND id != ${response_id}
  LIMIT 1
  FOR UPDATE
`;

if (!existingPosted && !lockedIsOrphanRetry) {
  // Sibling superseded between Phase A and now AND no orphan marker.
  // Release locks; control falls through to existing fresh-publish code
  // (matching the chosen Phase A shape — DO NOT also return).
  // (Implementer note: tx COMMIT happens at sql.begin's then; fresh-publish
  // code lives outside this block and reads the response row again.)
  return;     // exits the sql.begin callback; commits release the locks
}
```

3. **DELETE branch (only if `existingPosted`):**

Wrap `zernioClient.deleteReply(...)` in TRY/CATCH for `ZernioReplyAlreadyDeletedError` → treat as success, `ZernioAuthError` → call `handlePublisherAuthErrorTerminal` style logic INSIDE the tx (set `awaiting_owner_connect` + `posting_error='zernio_auth_error'`, COMMIT, mark outbox completed), `ZernioTransientError` → ROLLBACK + throw, `ZernioPermanentError` → set candidate failed with `delete_failed_<kind>` + COMMIT + mark outbox failed. Exact disposition per spec §4.5 outcome table.

4. **POST branch:** wrap `zernioClient.postReply(...)` similarly. On `ZernioReplyAlreadyExistsError` call `verify409InTx` and dispatch on the returned disposition (matches/mismatch/indeterminate/auth/permanent/transient — exact behavior per spec §4.5b + outcome table). On `ZernioAuthError`, if `postDeleteCommitted`, set `posting_error='zernio_auth_error_after_delete_succeeded'` (suffixed); else plain `'zernio_auth_error'`. On `ZernioPermanentError`, set `posting_error='post_after_delete_failed_<kind>'` if `postDeleteCommitted`, else generic. On `ZernioTransientError`, if `postDeleteCommitted`, COMMIT the sibling-supersede + set `posting_error='pending_after_delete_succeeded'` on candidate, then throw; else ROLLBACK + throw.

5. **Success path:** sibling supersede + candidate posted + clear `posting_error`. Use affected-row-count `RETURNING 1` assertions: throw `'sibling_lost_during_publish'` / `'candidate_lost_during_publish'` if affected != 1.

(Full SQL is reproduced in spec §4.5 — do not re-invent; copy it.)

- [ ] **Step 4: Run tests — verify they pass**

```bash
pnpm vitest run worker/jobs/__tests__/ResponsePublisherWorker-edit.test.ts
```
Expected: PASS for all non-`runIf` cases. The `runIf` lock-protocol cases skip without `TEST_DATABASE_POOL_URL`; verify in CI that they pass when set.

- [ ] **Step 5: Commit**

```bash
git add worker/jobs/ResponsePublisherWorker.ts worker/jobs/__tests__/ResponsePublisherWorker-edit.test.ts
git commit -m "feat(publisher): edit-publisher branch — locked DELETE+POST tx with per-CATCH commit semantics"
```

---

### Task 8: `worker/index.ts` — orphan-marker retry-exhaustion conversion

**Files:**
- Modify: `worker/index.ts`
- Test: `worker/jobs/__tests__/ResponsePublisherWorker-edit.test.ts` (extends existing test from Task 7)

- [ ] **Step 1: Write the failing test (test added in Task 7's `runIf` block)**

The "orphan-marker retry exhaustion converts to recoverable failed" test from Task 7's spec is the failing test for this task. Verify it's currently failing because `worker/index.ts` doesn't yet convert.

- [ ] **Step 2: Insert the orphan-marker conversion BEFORE `applyTransientExhaustionFallback`**

In `worker/index.ts` inside `publisherWorker.on('failed', async (job, err) => { ... })`, BEFORE the `if (err instanceof ZernioTransientError)` block (line ~359), add the orphan-marker conversion. Use spec §4.5 "Retry exhaustion conversion" SQL block verbatim:

```ts
// ── Orphan-marker retry exhaustion (spec §4.5) ──────────────────────
// Runs BEFORE the generic transient fallback. Lock order MUST match
// processReview (review → response). Business-scoped throughout.
//
// Only applies when EDIT_EXISTING_REPLIES_ENABLED is on; otherwise no
// orphan marker can exist on a row, and this is a no-op.
if (process.env.EDIT_EXISTING_REPLIES_ENABLED === 'true') {
  const responseId = (job.data as PublishResponsePayload).response_id;
  const businessId = (job.data as PublishResponsePayload).business_id;

  let converted = false;
  await sql.begin(async (tx) => {
    const [r0] = await tx<{ review_id: string }[]>`
      SELECT review_id FROM responses
      WHERE id = ${responseId} AND business_id = ${businessId}
    `;
    if (!r0) {
      // Row not visible to this business → close outbox cleanly.
      converted = true;  // fall through to markOutboxCompleted below
      return;
    }

    const [rev] = await tx<{ id: string }[]>`
      SELECT id FROM reviews
      WHERE id = ${r0.review_id} AND business_id = ${businessId}
      FOR UPDATE
    `;
    if (!rev) {
      converted = true;
      Sentry.captureMessage('orphan_response_review', { extra: { responseId, businessId } });
      return;
    }

    const [resp] = await tx<{ status: string; posting_error: string | null }[]>`
      SELECT status, posting_error FROM responses
      WHERE id = ${responseId} AND business_id = ${businessId}
      FOR UPDATE
    `;
    if (!resp) { converted = true; return; }

    if (!['approved', 'edited', 'awaiting_owner_connect'].includes(resp.status)) {
      // processReview already moved the row to terminal. Idempotent benign no-op.
      converted = true;
      return;
    }

    if (typeof resp.posting_error !== 'string'
        || !resp.posting_error.endsWith('_after_delete_succeeded')) {
      // No orphan marker → fall through to today's transient fallback below.
      return;
    }

    // Convert. Affected-row check.
    const updated = await tx`
      UPDATE responses
      SET status = 'failed',
          posting_error = 'post_after_delete_failed_retry_exhausted',
          updated_at = NOW()
      WHERE id = ${responseId} AND business_id = ${businessId}
        AND status IN ('approved', 'edited', 'awaiting_owner_connect')
    `;
    if (updated.count !== 1) {
      throw new Error(`onFailed orphan conversion expected 1 row, got ${updated.count}`);
    }
    converted = true;
  });

  if (converted) {
    // Disposition split (spec §4.5):
    //   - status guard caught terminal → markOutboxCompleted (idempotent no-op).
    //   - orphan-marker conversion → markOutboxFailed (genuine retry exhaustion).
    // Distinguished by whether the response.status NOW is 'failed' with the
    // exhaustion sentinel.
    const [post] = await sql<{ status: string; posting_error: string | null }[]>`
      SELECT status, posting_error FROM responses
      WHERE id = ${responseId} AND business_id = ${businessId}
    `;
    if (post?.status === 'failed' && post?.posting_error === 'post_after_delete_failed_retry_exhausted') {
      await markOutboxFailed(outboxId, 'post_after_delete_failed_retry_exhausted', outboxAttempt);
    } else {
      await markOutboxCompleted(outboxId, outboxAttempt);
    }
    return;
  }
  // else: no orphan marker, fall through to existing transient fallback
}
```

- [ ] **Step 3: Run tests — verify they pass**

```bash
pnpm vitest run worker/jobs/__tests__/ResponsePublisherWorker-edit.test.ts -t "orphan-marker retry exhaustion"
```
Expected: PASS (requires `TEST_DATABASE_POOL_URL`).

- [ ] **Step 4: Commit**

```bash
git add worker/index.ts
git commit -m "feat(worker): convert orphan-marker rows to recoverable failed on publish_response retry exhaustion"
```

---

### Task 9: `edit-existing.ts` helper — assertCanEditReply + validateOptimisticConcurrency

**Files:**
- Create: `src/lib/responses/edit-existing.ts`
- Create: `src/lib/responses/__tests__/edit-existing.test.ts`

- [ ] **Step 1: Write the failing tests (full inventory per spec §6.1)**

```ts
// src/lib/responses/__tests__/edit-existing.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { assertCanEditReply, validateOptimisticConcurrency,
         PremiumRequiredError, ReviewChangedError, ResponseChangedError,
         ForbiddenError, NotFoundError } from '../edit-existing';

describe('assertCanEditReply', () => {
  it('premium owner + historical → passes', async () => {});
  it('standard owner + gap → passes', async () => {});
  it('standard owner + historical → throws PremiumRequiredError', async () => {});
  it('standard owner + business with NULL subscription_activated_at → fails closed (PremiumRequiredError)', async () => {});
  it('premium owner + business with NULL subscription_activated_at → passes', async () => {});
  it('owner of different business → throws ForbiddenError', async () => {});
  it('non-existent review → throws NotFoundError', async () => {});
  it('boundary: review_date == subscription_activated_at counts as gap', async () => {});
});

describe('validateOptimisticConcurrency', () => {
  it('hash + version match → passes', async () => {});
  it('hash mismatch → throws ReviewChangedError with current review text in payload', async () => {});
  it('version mismatch → throws ResponseChangedError', async () => {});
  it('no posted row exists → throws ResponseChangedError', async () => {});
  it('after /draft INSERTs a draft, /publish-time validation against the still-posted row passes (regression)', async () => {});
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
pnpm vitest run src/lib/responses/__tests__/edit-existing.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/lib/responses/edit-existing.ts`**

```ts
// src/lib/responses/edit-existing.ts
//
// Two primitives shared by all seven Past Replies API routes:
//   1. assertCanEditReply — permission gate (tier + ownership).
//   2. validateOptimisticConcurrency — in-tx hash + version check.
//
// Both throw structured errors that map cleanly to HTTP codes in route handlers.

import type postgres from 'postgres';
import { sql as defaultSql } from '@/lib/db/server';

type TxClient = postgres.TransactionSql;

export class PremiumRequiredError extends Error {
  constructor() { super('premium_required'); this.name = 'PremiumRequiredError'; }
}
export class ReviewChangedError extends Error {
  constructor(public readonly current: { reviewText: string | null; reviewHash: string | null }) {
    super('review_changed'); this.name = 'ReviewChangedError';
  }
}
export class ResponseChangedError extends Error {
  constructor() { super('response_changed'); this.name = 'ResponseChangedError'; }
}
export class ForbiddenError extends Error {
  constructor() { super('forbidden'); this.name = 'ForbiddenError'; }
}
export class NotFoundError extends Error {
  constructor(message: string) { super(message); this.name = 'NotFoundError'; }
}

export interface EditUser {
  businessId: string;
  // (id is captured separately by callers as actorUserId for the audit log)
}

/**
 * Tier + ownership gate. Throws on denial; resolves on permit.
 *
 * Tier rule:
 *   isHistorical = activated_at IS NULL OR review_date < activated_at
 *   isPremium    = tier === 'premium'
 *   canEdit      = NOT isHistorical OR isPremium
 *
 * NULL activation timestamp → fail-closed: ALL reviews treated as historical.
 * Standard owners → PremiumRequiredError; premium → still allowed.
 *
 * Boundary: review_date == subscription_activated_at counts as gap (>= predicate).
 */
export async function assertCanEditReply(
  reviewId: string,
  user: EditUser,
): Promise<void> {
  const rows = await defaultSql<{
    review_business_id: string;
    review_date: Date;
    activated_at: Date | null;
    tier: string;
  }[]>`
    SELECT r.business_id AS review_business_id,
           r.review_date,
           b.subscription_activated_at AS activated_at,
           b.subscription_tier AS tier
    FROM reviews r
    JOIN businesses b ON b.id = r.business_id
    WHERE r.id = ${reviewId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw new NotFoundError('review_not_found');
  if (row.review_business_id !== user.businessId) throw new ForbiddenError();

  const isHistorical =
    row.activated_at === null ||
    new Date(row.review_date).getTime() < new Date(row.activated_at).getTime();
  const isPremium = row.tier === 'premium';
  if (isHistorical && !isPremium) throw new PremiumRequiredError();
}

/**
 * In-tx hash + version check. Caller MUST have already acquired
 *   SELECT FROM reviews WHERE id = $reviewId FOR UPDATE
 * inside the same transaction (otherwise the check is racy).
 *
 * Validates against the LIVE 'posted' row (NOT the latest non-terminal),
 * because at /publish time a sibling pending_approval/edited draft would
 * naturally have version = posted.version + 1.
 */
export async function validateOptimisticConcurrency(
  tx: TxClient,
  reviewId: string,
  snapshot: { hash: string; version: number },
): Promise<void> {
  const [review] = await tx<{ review_content_hash: string | null; review_text: string | null }[]>`
    SELECT review_content_hash, review_text FROM reviews WHERE id = ${reviewId}
  `;
  if (!review) throw new NotFoundError('review_not_found');
  if (review.review_content_hash !== snapshot.hash) {
    throw new ReviewChangedError({
      reviewText: review.review_text,
      reviewHash: review.review_content_hash,
    });
  }

  const [posted] = await tx<{ version: number }[]>`
    SELECT version FROM responses
    WHERE review_id = ${reviewId} AND status = 'posted'
  `;
  if (!posted) throw new ResponseChangedError();
  if (posted.version !== snapshot.version) throw new ResponseChangedError();
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
pnpm vitest run src/lib/responses/__tests__/edit-existing.test.ts
```
Expected: PASS for all 13 cases.

- [ ] **Step 5: Commit**

```bash
git add src/lib/responses/edit-existing.ts src/lib/responses/__tests__/edit-existing.test.ts
git commit -m "feat(responses): add assertCanEditReply + validateOptimisticConcurrency primitives"
```

---

### Task 10: API route — POST /api/dashboard/past-replies/draft (manual + regenerate)

**Files:**
- Create: `src/app/api/dashboard/past-replies/draft/route.ts`
- Create: `src/app/api/dashboard/past-replies/__tests__/draft.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/app/api/dashboard/past-replies/__tests__/draft.test.ts
describe('POST /api/dashboard/past-replies/draft', () => {
  it('returns 503 feature_disabled when EDIT_EXISTING_REPLIES_ENABLED is off', async () => {});
  it('returns 401 when no owner session', async () => {});
  it('returns 403 cross-origin when wrong Origin header (withSameOrigin)', async () => {});
  it('returns 403 PremiumRequiredError when standard owner attacks historical review', async () => {});
  it('returns 409 review_changed when hash mismatches', async () => {});
  it('returns 409 response_changed when version mismatches', async () => {});
  it('returns 409 draft_already_exists when a non-terminal response exists', async () => {});
  it('returns 409 regenerate_in_progress when a generate_response outbox row is pending', async () => {});
  it('manual mode happy path → INSERTs response status=pending_approval, edited_text=new_text, returns { response_id }', async () => {});
  it('regenerate mode happy path → INSERTs job_outbox topic=generate_response with version=MAX+1, returns { outbox_id }', async () => {});
  it('two simultaneous manual /draft calls on same review → first succeeds, second 409 (lock serialization)', async () => {});
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
pnpm vitest run src/app/api/dashboard/past-replies/__tests__/draft.test.ts
```
Expected: FAIL — route module not found.

- [ ] **Step 3: Implement the route**

Create `src/app/api/dashboard/past-replies/draft/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { sql, jsonb } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import {
  assertCanEditReply, validateOptimisticConcurrency,
  PremiumRequiredError, ReviewChangedError, ResponseChangedError,
  ForbiddenError, NotFoundError,
} from '@/lib/responses/edit-existing';
import type { GenerateResponsePayload } from '@/lib/shared/worker-types';

export const dynamic = 'force-dynamic';

const bodySchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('manual'),
    review_id: z.string().uuid(),
    new_text: z.string().trim().min(1).max(2000),
    snapshot: z.object({ hash: z.string().min(1), version: z.number().int().positive() }),
  }),
  z.object({
    mode: z.literal('regenerate'),
    review_id: z.string().uuid(),
    snapshot: z.object({ hash: z.string().min(1), version: z.number().int().positive() }),
  }),
]);

async function handler(request: NextRequest): Promise<Response> {
  if (process.env.EDIT_EXISTING_REPLIES_ENABLED !== 'true') {
    return NextResponse.json({ error: 'feature_disabled' }, { status: 503 });
  }

  let user;
  try { user = await requireRole(request, 'owner'); }
  catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.statusCode });
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!user.businessId) return NextResponse.json({ error: 'no_business' }, { status: 403 });

  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: 'invalid_body', details: parsed.error.flatten() }, { status: 400 });

  try {
    await assertCanEditReply(parsed.data.review_id, { businessId: user.businessId });
  } catch (err) {
    if (err instanceof PremiumRequiredError) return NextResponse.json({ error: 'premium_required' }, { status: 403 });
    if (err instanceof ForbiddenError) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    if (err instanceof NotFoundError) return NextResponse.json({ error: 'review_not_found' }, { status: 404 });
    throw err;
  }

  try {
    return await sql.begin(async (tx) => {
      // 1. Lock review row.
      const [reviewRow] = await tx`SELECT id FROM reviews WHERE id = ${parsed.data.review_id} AND business_id = ${user.businessId} FOR UPDATE`;
      if (!reviewRow) return NextResponse.json({ error: 'review_not_found' }, { status: 404 });

      // 2a. In-flight non-terminal response?
      const [existing] = await tx`
        SELECT 1 FROM responses
        WHERE review_id = ${parsed.data.review_id}
          AND status IN ('pending_approval', 'approved', 'edited', 'awaiting_owner_connect')
      `;
      if (existing) return NextResponse.json({ error: 'draft_already_exists' }, { status: 409 });

      // 2b. In-flight regenerate outbox row?
      const [pendingGen] = await tx`
        SELECT 1 FROM job_outbox
        WHERE topic = 'generate_response'
          AND aggregate_id = ${parsed.data.review_id}
          AND status IN ('pending', 'dispatching', 'dispatched')
      `;
      if (pendingGen) return NextResponse.json({ error: 'regenerate_in_progress' }, { status: 409 });

      // 3. Optimistic concurrency check.
      try {
        await validateOptimisticConcurrency(tx, parsed.data.review_id, parsed.data.snapshot);
      } catch (err) {
        if (err instanceof ReviewChangedError) {
          return NextResponse.json({
            error: 'review_changed',
            current_review_text: err.current.reviewText,
            current_review_hash: err.current.reviewHash,
          }, { status: 409 });
        }
        if (err instanceof ResponseChangedError) {
          return NextResponse.json({ error: 'response_changed' }, { status: 409 });
        }
        throw err;
      }

      // 4. Compute next version for both modes.
      const [maxRow] = await tx<{ next_version: number }[]>`
        SELECT COALESCE(MAX(version), 0) + 1 AS next_version
        FROM responses WHERE review_id = ${parsed.data.review_id}
      `;
      const nextVersion = maxRow?.next_version ?? 1;

      // 5. Manual: INSERT response. Regenerate: INSERT outbox.
      if (parsed.data.mode === 'manual') {
        // Read the current posted row's text for response_text + original_draft_text.
        const [posted] = await tx<{ approved_text: string | null; response_text: string | null; response_language: string | null }[]>`
          SELECT approved_text, response_text, response_language
          FROM responses WHERE review_id = ${parsed.data.review_id} AND status = 'posted'
        `;
        if (!posted) return NextResponse.json({ error: 'response_changed' }, { status: 409 });
        const beforeText = posted.approved_text ?? posted.response_text ?? '';
        const responseId = uuidv7();
        await tx`
          INSERT INTO responses (
            id, review_id, business_id,
            response_text, approved_text, original_draft_text, edited_text,
            response_language, version, status
          ) VALUES (
            ${responseId}, ${parsed.data.review_id}, ${user.businessId},
            ${beforeText}, ${parsed.data.new_text}, ${beforeText}, ${parsed.data.new_text},
            ${posted.response_language}, ${nextVersion}, 'pending_approval'
          )
        `;
        return NextResponse.json({ response_id: responseId }, { status: 200 });
      }

      // Regenerate mode.
      const outboxId = uuidv7();
      const payload: GenerateResponsePayload = {
        review_id: parsed.data.review_id,
        business_id: user.businessId,
        version: nextVersion,
        suppress_notification: true,
      };
      await tx`
        INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
        VALUES (${outboxId}, 'generate_response', 'review', ${parsed.data.review_id}, ${jsonb(payload)}, 'pending')
      `;
      return NextResponse.json({ outbox_id: outboxId }, { status: 200 });
    });
  } catch (err) {
    console.error('[past-replies/draft] unexpected:', err);
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

export const POST = withSameOrigin()(handler);
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
pnpm vitest run src/app/api/dashboard/past-replies/__tests__/draft.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/dashboard/past-replies/draft/route.ts src/app/api/dashboard/past-replies/__tests__/draft.test.ts
git commit -m "feat(api): POST /api/dashboard/past-replies/draft (manual + regenerate)"
```

---

### Task 11: API routes — PATCH/DELETE /draft/:id + GET /draft-status

**Files:**
- Create: `src/app/api/dashboard/past-replies/draft/[responseId]/route.ts` (PATCH + DELETE)
- Create: `src/app/api/dashboard/past-replies/draft-status/route.ts` (GET)
- Create: `src/app/api/dashboard/past-replies/__tests__/draft-id.test.ts`
- Create: `src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts`

- [ ] **Step 1: Write the failing tests**

For PATCH/DELETE — the same withSameOrigin/auth/flag/optimistic-concurrency cases as Task 10, plus:
- PATCH idempotent (running twice is the same as once).
- PATCH refuses 409 if response.status !== 'pending_approval'.
- DELETE flips response → 'superseded' with FOR UPDATE; safe no-op if already moved past.

For GET /draft-status:
- Auth + tenant ownership check (verify `payload->>'business_id' === user.businessId`).
- Returns `{ status: 'generating' }` while outbox is pending/dispatching/dispatched.
- Returns `{ response_id, status: 'pending_approval', response_text }` on completion.
- Returns `{ status: 'failed', error }` on outbox failure.
- Returns 403 if outbox payload's business_id != user.businessId.

- [ ] **Step 2: Run tests — verify they fail**

```bash
pnpm vitest run src/app/api/dashboard/past-replies/__tests__/draft-id.test.ts src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts
```
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement PATCH + DELETE**

`src/app/api/dashboard/past-replies/draft/[responseId]/route.ts`:

```ts
// PATCH: edit-further on an existing pending_approval row.
// DELETE: cancel — flip to 'superseded' with FOR UPDATE.
//
// Both wrapped with withSameOrigin; both validate flag + auth + ownership.
// PATCH validates optimistic concurrency in-tx. DELETE is idempotent and
// skips concurrency validation per spec §4.4.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import {
  assertCanEditReply, validateOptimisticConcurrency,
  PremiumRequiredError, ReviewChangedError, ResponseChangedError,
  ForbiddenError, NotFoundError,
} from '@/lib/responses/edit-existing';

export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  new_text: z.string().trim().min(1).max(2000),
  snapshot: z.object({ hash: z.string().min(1), version: z.number().int().positive() }),
});

async function patchHandler(
  request: NextRequest,
  { params }: { params: Promise<{ responseId: string }> },
): Promise<Response> {
  if (process.env.EDIT_EXISTING_REPLIES_ENABLED !== 'true') {
    return NextResponse.json({ error: 'feature_disabled' }, { status: 503 });
  }
  let user;
  try { user = await requireRole(request, 'owner'); }
  catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.statusCode });
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!user.businessId) return NextResponse.json({ error: 'no_business' }, { status: 403 });

  const { responseId } = await params;
  const body = await request.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

  // Resolve review_id for the candidate so we can lock + tier-gate.
  const [resp] = await sql<{ review_id: string }[]>`
    SELECT review_id FROM responses WHERE id = ${responseId} AND business_id = ${user.businessId}
  `;
  if (!resp) return NextResponse.json({ error: 'response_not_found' }, { status: 404 });

  try {
    await assertCanEditReply(resp.review_id, { businessId: user.businessId });
  } catch (err) {
    if (err instanceof PremiumRequiredError) return NextResponse.json({ error: 'premium_required' }, { status: 403 });
    if (err instanceof ForbiddenError) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    if (err instanceof NotFoundError) return NextResponse.json({ error: 'review_not_found' }, { status: 404 });
    throw err;
  }

  return await sql.begin(async (tx) => {
    await tx`SELECT id FROM reviews WHERE id = ${resp.review_id} AND business_id = ${user.businessId} FOR UPDATE`;
    try {
      await validateOptimisticConcurrency(tx, resp.review_id, parsed.data.snapshot);
    } catch (err) {
      if (err instanceof ReviewChangedError) {
        return NextResponse.json({
          error: 'review_changed',
          current_review_text: err.current.reviewText,
          current_review_hash: err.current.reviewHash,
        }, { status: 409 });
      }
      if (err instanceof ResponseChangedError) return NextResponse.json({ error: 'response_changed' }, { status: 409 });
      throw err;
    }

    const [locked] = await tx<{ status: string }[]>`
      SELECT status FROM responses
      WHERE id = ${responseId} AND business_id = ${user.businessId}
      FOR UPDATE
    `;
    if (!locked) return NextResponse.json({ error: 'response_not_found' }, { status: 404 });
    if (locked.status !== 'pending_approval') {
      return NextResponse.json({ error: 'response_changed' }, { status: 409 });
    }

    await tx`
      UPDATE responses
      SET approved_text = ${parsed.data.new_text},
          edited_text = ${parsed.data.new_text},
          updated_at = NOW()
      WHERE id = ${responseId}
    `;
    return new NextResponse(null, { status: 204 });
  });
}

async function deleteHandler(
  request: NextRequest,
  { params }: { params: Promise<{ responseId: string }> },
): Promise<Response> {
  if (process.env.EDIT_EXISTING_REPLIES_ENABLED !== 'true') {
    return NextResponse.json({ error: 'feature_disabled' }, { status: 503 });
  }
  let user;
  try { user = await requireRole(request, 'owner'); }
  catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.statusCode });
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!user.businessId) return NextResponse.json({ error: 'no_business' }, { status: 403 });

  const { responseId } = await params;
  await sql.begin(async (tx) => {
    const [locked] = await tx<{ status: string }[]>`
      SELECT status FROM responses
      WHERE id = ${responseId} AND business_id = ${user.businessId}
      FOR UPDATE
    `;
    if (!locked) return;  // 204 idempotent
    if (locked.status === 'pending_approval') {
      await tx`
        UPDATE responses SET status = 'superseded', updated_at = NOW()
        WHERE id = ${responseId}
      `;
    }
    // Other statuses: idempotent no-op.
  });
  return new NextResponse(null, { status: 204 });
}

export const PATCH = withSameOrigin()(patchHandler as any);
export const DELETE = withSameOrigin()(deleteHandler as any);
```

`src/app/api/dashboard/past-replies/draft-status/route.ts`:

```ts
// GET-only — no withSameOrigin (CSRF doesn't apply to GETs). Auth + tenant
// ownership still required (the outbox payload's business_id MUST match
// the session's business or we leak generation status across tenants).

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<Response> {
  if (process.env.EDIT_EXISTING_REPLIES_ENABLED !== 'true') {
    return NextResponse.json({ error: 'feature_disabled' }, { status: 503 });
  }
  let user;
  try { user = await requireRole(request, 'owner'); }
  catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.statusCode });
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!user.businessId) return NextResponse.json({ error: 'no_business' }, { status: 403 });

  const url = new URL(request.url);
  const outboxId = url.searchParams.get('outbox_id');
  if (!outboxId) return NextResponse.json({ error: 'missing_outbox_id' }, { status: 400 });

  const [row] = await sql<{
    status: string; payload: unknown; last_error: string | null; aggregate_id: string;
  }[]>`
    SELECT status, payload, last_error, aggregate_id
    FROM job_outbox WHERE id = ${outboxId}
  `;
  if (!row) return NextResponse.json({ error: 'outbox_not_found' }, { status: 404 });

  // Tenant ownership guard.
  const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  if ((payload as { business_id?: string })?.business_id !== user.businessId) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  if (['pending', 'dispatching', 'dispatched'].includes(row.status)) {
    return NextResponse.json({ status: 'generating' });
  }
  if (row.status === 'failed') {
    return NextResponse.json({ status: 'failed', error: row.last_error });
  }
  // completed: look up the response row keyed on aggregate_id (review_id).
  const [resp] = await sql<{ id: string; status: string; response_text: string | null; business_id: string }[]>`
    SELECT id, status, response_text, business_id
    FROM responses
    WHERE review_id = ${row.aggregate_id}
      AND status IN ('pending_approval', 'approved', 'edited')
    ORDER BY version DESC
    LIMIT 1
  `;
  if (!resp || resp.business_id !== user.businessId) {
    return NextResponse.json({ error: 'response_not_found' }, { status: 404 });
  }
  return NextResponse.json({
    response_id: resp.id, status: resp.status, response_text: resp.response_text,
  });
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
pnpm vitest run src/app/api/dashboard/past-replies/__tests__/draft-id.test.ts src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/dashboard/past-replies/draft/\[responseId\]/route.ts src/app/api/dashboard/past-replies/draft-status/route.ts src/app/api/dashboard/past-replies/__tests__/draft-id.test.ts src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts
git commit -m "feat(api): PATCH/DELETE /past-replies/draft/:id + GET /draft-status"
```

---

### Task 12: API route — POST /past-replies/publish

**Files:**
- Create: `src/app/api/dashboard/past-replies/publish/route.ts`
- Create: `src/app/api/dashboard/past-replies/__tests__/publish.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
describe('POST /api/dashboard/past-replies/publish', () => {
  it('feature_disabled / unauthorized / cross-origin / premium_required cases', async () => {});
  it('happy path manual edit: response transitions pending_approval → edited, approval_audit_log row written, publish_response outbox enqueued — ALL in one tx', async () => {});
  it('happy path regen-as-is: response transitions pending_approval → approved, approved_text = response_text via COALESCE', async () => {});
  it('happy path regen-then-edit: response transitions pending_approval → edited (because edited_text was set by PATCH)', async () => {});
  it('rejects with 409 review_changed when hash drifted between /draft and /publish', async () => {});
  it('rejects with 409 response_changed when status is not pending_approval', async () => {});
  it('rejects with 404 when response_id belongs to a different business', async () => {});
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
pnpm vitest run src/app/api/dashboard/past-replies/__tests__/publish.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement the route**

```ts
// src/app/api/dashboard/past-replies/publish/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { sql, jsonb } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import {
  assertCanEditReply, validateOptimisticConcurrency,
  PremiumRequiredError, ReviewChangedError, ResponseChangedError,
  ForbiddenError, NotFoundError,
} from '@/lib/responses/edit-existing';
import { insertAuditLogSession } from '@/lib/approval/audit';
import type { PublishResponsePayload } from '@/lib/shared/worker-types';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  response_id: z.string().uuid(),
  snapshot: z.object({ hash: z.string().min(1), version: z.number().int().positive() }),
});

async function handler(request: NextRequest): Promise<Response> {
  if (process.env.EDIT_EXISTING_REPLIES_ENABLED !== 'true') {
    return NextResponse.json({ error: 'feature_disabled' }, { status: 503 });
  }
  let user;
  try { user = await requireRole(request, 'owner'); }
  catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.statusCode });
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!user.businessId) return NextResponse.json({ error: 'no_business' }, { status: 403 });

  const body = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

  // Resolve the review_id from the candidate; tier-gate.
  const [respRow] = await sql<{ review_id: string }[]>`
    SELECT review_id FROM responses WHERE id = ${parsed.data.response_id} AND business_id = ${user.businessId}
  `;
  if (!respRow) return NextResponse.json({ error: 'response_not_found' }, { status: 404 });

  try {
    await assertCanEditReply(respRow.review_id, { businessId: user.businessId });
  } catch (err) {
    if (err instanceof PremiumRequiredError) return NextResponse.json({ error: 'premium_required' }, { status: 403 });
    if (err instanceof ForbiddenError) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    if (err instanceof NotFoundError) return NextResponse.json({ error: 'review_not_found' }, { status: 404 });
    throw err;
  }

  const ip = request.headers.get('x-forwarded-for') ?? null;

  return await sql.begin(async (tx) => {
    // Lock review FIRST (canonical order).
    await tx`SELECT id FROM reviews WHERE id = ${respRow.review_id} AND business_id = ${user.businessId} FOR UPDATE`;

    try {
      await validateOptimisticConcurrency(tx, respRow.review_id, parsed.data.snapshot);
    } catch (err) {
      if (err instanceof ReviewChangedError) {
        return NextResponse.json({
          error: 'review_changed',
          current_review_text: err.current.reviewText,
          current_review_hash: err.current.reviewHash,
        }, { status: 409 });
      }
      if (err instanceof ResponseChangedError) return NextResponse.json({ error: 'response_changed' }, { status: 409 });
      throw err;
    }

    const [candidate] = await tx<{ status: string; edited_text: string | null; response_text: string; llm_provider: string | null }[]>`
      SELECT status, edited_text, response_text, llm_provider
      FROM responses WHERE id = ${parsed.data.response_id} AND business_id = ${user.businessId}
      FOR UPDATE
    `;
    if (!candidate) return NextResponse.json({ error: 'response_not_found' }, { status: 404 });
    if (candidate.status !== 'pending_approval') {
      return NextResponse.json({ error: 'response_changed' }, { status: 409 });
    }

    // Status transition: 'edited' if edited_text was set (manual or
    // regen-then-edit); 'approved' otherwise (regen-as-is).
    // approved_text = COALESCE(approved_text, response_text) so the regen-as-is
    // case ends up with the AI-generated text in approved_text.
    const newStatus = candidate.edited_text !== null ? 'edited' : 'approved';
    await tx`
      UPDATE responses
      SET status = ${newStatus},
          approved_at = NOW(),
          approved_text = COALESCE(approved_text, response_text),
          updated_at = NOW()
      WHERE id = ${parsed.data.response_id}
    `;

    // Compute audit-log mode per spec §4.4 step 5. The discriminator is
    // (llm_provider IS NULL, edited_text IS NULL):
    //   - llm_provider NULL + edited_text set     → 'manual'
    //   - llm_provider set  + edited_text NULL    → 'regenerate_as_is'
    //   - llm_provider set  + edited_text set     → 'regenerate_edited'
    // (llm_provider NULL + edited_text NULL is impossible at /publish — every
    //  candidate row was created by either /draft manual mode (sets edited_text)
    //  or ResponseGeneratorWorker (sets llm_provider).)
    const mode =
      candidate.llm_provider === null
        ? 'manual'
        : candidate.edited_text === null
          ? 'regenerate_as_is'
          : 'regenerate_edited';

    // Audit + outbox in same tx.
    await insertAuditLogSession(
      tx, parsed.data.response_id, user.businessId,
      'approve_edit',
      { actorUserId: user.id, ipAddress: ip },
      { mode },
    );

    const outboxId = uuidv7();
    const payload: PublishResponsePayload = {
      response_id: parsed.data.response_id,
      business_id: user.businessId,
    };
    await tx`
      INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
      VALUES (${outboxId}, 'publish_response', 'response', ${parsed.data.response_id}, ${jsonb(payload)}, 'pending')
    `;
    return NextResponse.json({ outbox_id: outboxId }, { status: 200 });
  });
}

export const POST = withSameOrigin()(handler);
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
pnpm vitest run src/app/api/dashboard/past-replies/__tests__/publish.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/dashboard/past-replies/publish/route.ts src/app/api/dashboard/past-replies/__tests__/publish.test.ts
git commit -m "feat(api): POST /api/dashboard/past-replies/publish (transition + audit + outbox in one tx)"
```

---

### Task 13: API routes — POST /retry + POST /restore-original

**Files:**
- Create: `src/app/api/dashboard/past-replies/[responseId]/retry/route.ts`
- Create: `src/app/api/dashboard/past-replies/[responseId]/restore-original/route.ts`
- Create: `src/app/api/dashboard/past-replies/__tests__/retry.test.ts`
- Create: `src/app/api/dashboard/past-replies/__tests__/restore-original.test.ts`

- [ ] **Step 1: Write the failing tests (full inventory per spec §6.1)**

```ts
// retry.test.ts
describe('POST /retry', () => {
  it('feature_disabled / unauthorized / cross-origin', async () => {});
  it('post_after_delete_failed_* (orphan branch) → row → approved with posting_error=pending_after_delete_succeeded → publisher takes no-DELETE branch → posted', async () => {});
  it('delete_failed_* (sibling-still-alive) → row → approved with posting_error=NULL → publisher re-enters DELETE+POST', async () => {});
  it('rejected by review_content_changed → 409 not_recoverable_via_retry', async () => {});
  it('rejected by stale_after_review_changed → 409 not_recoverable_via_retry', async () => {});
  it('rejected with 409 already_recovered when status is not failed', async () => {});
  it('rejected with 409 newer_draft_exists when a non-terminal sibling exists (per step 1a)', async () => {});
  it('rejected with 409 sibling_state_mismatch when delete_failed_* row has no live posted sibling', async () => {});
  it('rejected with 409 live_reply_exists when post_after_delete_failed_* row has a live posted sibling (post-restore)', async () => {});
  it('lock-protocol: blocks on reviews FOR UPDATE held by processReview', async () => {});
});

// restore-original.test.ts
describe('POST /restore-original', () => {
  it('feature_disabled / unauthorized / cross-origin', async () => {});
  it('happy path: orphan row + superseded sibling with posted_at → INSERTs new pending_approval row at MAX(version)+1 with original text in all 3 text columns', async () => {});
  it('rejected with 409 not_in_orphan_state for delete_failed_* row', async () => {});
  it('rejected with 409 live_reply_exists when a posted sibling already exists', async () => {});
  it('rejected with 409 newer_draft_exists when non-terminal sibling exists', async () => {});
  it('OLD failed row stays failed (NOT retired)', async () => {});
  it('after restore-original publishes, /retry on the OLD failed row gets 409 live_reply_exists', async () => {});
  it('after restore draft is canceled (DELETE), /retry on the OLD failed row succeeds (back-stop recovery)', async () => {});
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
pnpm vitest run src/app/api/dashboard/past-replies/__tests__/retry.test.ts src/app/api/dashboard/past-replies/__tests__/restore-original.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement /retry**

`src/app/api/dashboard/past-replies/[responseId]/retry/route.ts` — implements spec §4.7 [Retry posting] SQL block verbatim. Key shape:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import {
  assertCanEditReply, PremiumRequiredError, ForbiddenError, NotFoundError,
} from '@/lib/responses/edit-existing';
import { insertAuditLogSession } from '@/lib/approval/audit';
import type { PublishResponsePayload } from '@/lib/shared/worker-types';

export const dynamic = 'force-dynamic';

async function handler(
  request: NextRequest,
  { params }: { params: Promise<{ responseId: string }> },
): Promise<Response> {
  if (process.env.EDIT_EXISTING_REPLIES_ENABLED !== 'true') {
    return NextResponse.json({ error: 'feature_disabled' }, { status: 503 });
  }
  let user;
  try { user = await requireRole(request, 'owner'); }
  catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.statusCode });
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!user.businessId) return NextResponse.json({ error: 'no_business' }, { status: 403 });
  const { responseId } = await params;
  const ip = request.headers.get('x-forwarded-for') ?? null;

  // Tier gate (spec §4.4 cross-cutting requirements: applies to ALL routes
  // except /draft-status, including the recovery routes). Resolve review_id
  // first via a non-locking read, then call the gate.
  const [respGate] = await sql<{ review_id: string }[]>`
    SELECT review_id FROM responses WHERE id = ${responseId} AND business_id = ${user.businessId}
  `;
  if (!respGate) return NextResponse.json({ error: 'response_not_found' }, { status: 404 });
  try {
    await assertCanEditReply(respGate.review_id, { businessId: user.businessId });
  } catch (err) {
    if (err instanceof PremiumRequiredError) return NextResponse.json({ error: 'premium_required' }, { status: 403 });
    if (err instanceof ForbiddenError) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    if (err instanceof NotFoundError) return NextResponse.json({ error: 'review_not_found' }, { status: 404 });
    throw err;
  }

  return await sql.begin(async (tx) => {
    // 0. Resolve review_id (scoped) + lock review.
    const [resp0] = await tx<{ review_id: string }[]>`
      SELECT review_id FROM responses WHERE id = ${responseId} AND business_id = ${user.businessId}
    `;
    if (!resp0) return NextResponse.json({ error: 'response_not_found' }, { status: 404 });
    const [revLock] = await tx`SELECT id FROM reviews WHERE id = ${resp0.review_id} AND business_id = ${user.businessId} FOR UPDATE`;
    if (!revLock) return NextResponse.json({ error: 'review_not_found' }, { status: 404 });

    // 1. Lock failed candidate.
    const [row] = await tx<{ status: string; posting_error: string | null }[]>`
      SELECT status, posting_error FROM responses
      WHERE id = ${responseId} AND business_id = ${user.businessId}
      FOR UPDATE
    `;
    if (!row) return NextResponse.json({ error: 'response_not_found' }, { status: 404 });
    if (row.status !== 'failed') return NextResponse.json({ error: 'already_recovered' }, { status: 409 });

    // 1a. Non-terminal sibling check.
    const [nonTerm] = await tx`
      SELECT 1 FROM responses
      WHERE review_id = ${resp0.review_id}
        AND status IN ('pending_approval', 'approved', 'edited', 'awaiting_owner_connect')
    `;
    if (nonTerm) return NextResponse.json({ error: 'newer_draft_exists' }, { status: 409 });

    // 2. Allowlist.
    const isDeleteFail = row.posting_error?.startsWith('delete_failed_') ?? false;
    const isPostAfterDeleteFail = row.posting_error?.startsWith('post_after_delete_failed_') ?? false;
    if (!isDeleteFail && !isPostAfterDeleteFail) {
      return NextResponse.json({ error: 'not_recoverable_via_retry' }, { status: 409 });
    }

    // 2a. Branch-shape validation.
    const [livePosted] = await tx`
      SELECT id FROM responses WHERE review_id = ${resp0.review_id} AND status = 'posted' LIMIT 1
    `;
    if (isDeleteFail && !livePosted) return NextResponse.json({ error: 'sibling_state_mismatch' }, { status: 409 });
    if (isPostAfterDeleteFail && livePosted) return NextResponse.json({ error: 'live_reply_exists' }, { status: 409 });

    // 3. Transition.
    const newPostingError = isPostAfterDeleteFail ? 'pending_after_delete_succeeded' : null;
    await tx`
      UPDATE responses
      SET status = 'approved',
          posting_error = ${newPostingError},
          approved_at = NOW(),
          approved_text = COALESCE(approved_text, response_text),
          updated_at = NOW()
      WHERE id = ${responseId}
    `;

    // 4. Audit + outbox in same tx.
    await insertAuditLogSession(
      tx, responseId, user.businessId,
      'retry_after_failure',
      { actorUserId: user.id, ipAddress: ip },
      { previous_posting_error: row.posting_error },
    );
    const outboxId = uuidv7();
    const payload: PublishResponsePayload = {
      response_id: responseId, business_id: user.businessId,
    };
    await tx`
      INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
      VALUES (${outboxId}, 'publish_response', 'response', ${responseId}, ${jsonb(payload)}, 'pending')
    `;
    return NextResponse.json({ outbox_id: outboxId });
  });
}

export const POST = withSameOrigin()(handler as any);
```

- [ ] **Step 4: Implement /restore-original**

`src/app/api/dashboard/past-replies/[responseId]/restore-original/route.ts` — implements spec §4.7 [Restore original] SQL block verbatim. Same overall shape as `/retry`:

- Wrapped with `withSameOrigin`. Flag check + auth as in `/retry`.
- **Tier gate via `assertCanEditReply`** (spec §4.4 cross-cutting — applies here too) — non-locking SELECT for `review_id` first, then `assertCanEditReply(reviewId, { businessId })`. Catch `PremiumRequiredError`/`ForbiddenError`/`NotFoundError` and return appropriate HTTP codes (same pattern as `/retry` above).
- Inside `sql.begin`:
  - Lock review row first (canonical lock order).
  - Lock failed candidate; refuse if `status != 'failed'` (`already_recovered`) OR `posting_error NOT LIKE 'post_after_delete_failed_%'` (`not_in_orphan_state`).
  - Refuse if a live posted sibling exists (`live_reply_exists`).
  - Refuse if any non-terminal sibling exists (`newer_draft_exists`).
  - Find the superseded sibling with `posted_at IS NOT NULL` ordered by `(posted_at DESC, version DESC)` `LIMIT 1 FOR UPDATE`. If none found → 404 `no_original_to_restore`.
  - INSERT a new `pending_approval` row with `version = COALESCE(MAX(version), 0) + 1` and all three text columns set to `COALESCE(_superseded.approved_text, _superseded.response_text, _superseded.original_draft_text)`. `edited_text = NULL`. `llm_provider`/`llm_model`/`prompt_tokens`/`completion_tokens` = NULL.
  - The OLD failed row is intentionally LEFT in place (do NOT update it — see spec §4.7 long comment block on why).
  - Audit log via `insertAuditLogSession(tx, _new_id, businessId, 'restore_original', { actorUserId: user.id, ipAddress: ip }, { failed_response_id: responseId, restored_from_superseded_id: _superseded.id })`.
  - Return `{ response_id: _new_id }`.

- [ ] **Step 5: Run tests — verify they pass**

```bash
pnpm vitest run src/app/api/dashboard/past-replies/__tests__/retry.test.ts src/app/api/dashboard/past-replies/__tests__/restore-original.test.ts
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/dashboard/past-replies/\[responseId\]/retry/route.ts src/app/api/dashboard/past-replies/\[responseId\]/restore-original/route.ts src/app/api/dashboard/past-replies/__tests__/retry.test.ts src/app/api/dashboard/past-replies/__tests__/restore-original.test.ts
git commit -m "feat(api): /retry + /restore-original recovery routes"
```

---

### Task 14: Cross-origin guard test (single regression file)

**Files:**
- Create: `src/app/api/dashboard/past-replies/__tests__/cross-origin.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe('Past Replies routes — cross-origin enforcement', () => {
  beforeEach(() => { process.env.EDIT_EXISTING_REPLIES_ENABLED = 'true'; });

  const mutating: Array<{ method: 'POST' | 'PATCH' | 'DELETE'; path: string }> = [
    { method: 'POST', path: '/api/dashboard/past-replies/draft' },
    { method: 'PATCH', path: '/api/dashboard/past-replies/draft/00000000-0000-0000-0000-000000000001' },
    { method: 'DELETE', path: '/api/dashboard/past-replies/draft/00000000-0000-0000-0000-000000000001' },
    { method: 'POST', path: '/api/dashboard/past-replies/publish' },
    { method: 'POST', path: '/api/dashboard/past-replies/00000000-0000-0000-0000-000000000001/retry' },
    { method: 'POST', path: '/api/dashboard/past-replies/00000000-0000-0000-0000-000000000001/restore-original' },
  ];

  for (const { method, path } of mutating) {
    it(`${method} ${path} returns 403 when Origin header is wrong`, async () => {
      // Send the request with an Origin that does not equal NEXT_PUBLIC_APP_URL.
      // Assert: 403 forbidden.
    });
  }

  it('GET /api/dashboard/past-replies/draft-status is exempt (no Origin requirement)', async () => {
    // Assert: 200 (or whatever the route returns) regardless of Origin.
  });
});
```

- [ ] **Step 2: Run tests — verify they pass**

```bash
pnpm vitest run src/app/api/dashboard/past-replies/__tests__/cross-origin.test.ts
```
Expected: PASS — every mutating route is wrapped with `withSameOrigin` from Tasks 10-13.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/dashboard/past-replies/__tests__/cross-origin.test.ts
git commit -m "test(api): regression-guard cross-origin enforcement on all 6 mutating Past Replies routes"
```

---

### Task 15: Frontend — Past Replies page (server component)

**Files:**
- Create: `src/app/(authenticated)/dashboard/past-replies/page.tsx`
- Create: `src/components/dashboard/HistoricalUpgradeBanner.tsx`

- [ ] **Step 1: Create `HistoricalUpgradeBanner.tsx`**

```tsx
// src/components/dashboard/HistoricalUpgradeBanner.tsx
import Link from 'next/link';

export function HistoricalUpgradeBanner() {
  return (
    <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4">
      <p className="text-sm text-amber-900">
        <strong>Premium customers</strong> can edit replies to historical reviews using their current brand voice.{' '}
        <Link href="/onboarding/pay" className="underline">See Premium plans →</Link>
      </p>
    </div>
  );
}
```

- [ ] **Step 2: Create the page server component**

```tsx
// src/app/(authenticated)/dashboard/past-replies/page.tsx
import { notFound } from 'next/navigation';
import { sql } from '@/lib/db/server';
import { requireOwnerAccess } from '@/lib/auth/require-owner-access';
import { PastReplyCard } from '@/components/dashboard/PastReplyCard';
import { HistoricalUpgradeBanner } from '@/components/dashboard/HistoricalUpgradeBanner';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

export default async function PastRepliesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  if (process.env.EDIT_EXISTING_REPLIES_ENABLED !== 'true') notFound();
  const owner = await requireOwnerAccess();
  const sp = await searchParams;
  const page = Math.max(1, parseInt(sp.page ?? '1', 10) || 1);

  const [biz] = await sql<{
    subscription_tier: string;
    subscription_activated_at: Date | null;
  }[]>`
    SELECT subscription_tier, subscription_activated_at FROM businesses WHERE id = ${owner.businessId}
  `;
  if (!biz) notFound();
  const isPremium = biz.subscription_tier === 'premium';
  const activatedAtIso = biz.subscription_activated_at
    ? new Date(biz.subscription_activated_at).toISOString()
    : null;

  const offset = (page - 1) * PAGE_SIZE;
  const rows = await sql<{
    review_id: string;
    review_text: string | null;
    review_date: Date;
    review_content_hash: string | null;
    response_id: string;
    approved_text: string | null;
    posted_at: Date | null;
    version: number;
    external_reply_ingested_at: Date | null;
    star_rating: number | null;
    reviewer_name: string | null;
  }[]>`
    SELECT r.id AS review_id, r.review_text, r.review_date, r.review_content_hash,
           r.external_reply_ingested_at, r.star_rating, r.reviewer_name,
           resp.id AS response_id, resp.approved_text, resp.posted_at, resp.version
    FROM reviews r
    JOIN responses resp ON resp.review_id = r.id AND resp.status = 'posted'
    WHERE r.business_id = ${owner.businessId}
    ORDER BY r.review_date DESC
    LIMIT ${PAGE_SIZE} OFFSET ${offset}
  `;

  const [{ count: gapTotal }] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM reviews r
    JOIN responses resp ON resp.review_id = r.id AND resp.status = 'posted'
    WHERE r.business_id = ${owner.businessId}
      AND ( ${activatedAtIso}::timestamptz IS NULL OR r.review_date >= ${activatedAtIso}::timestamptz )
  `;
  const [{ count: histTotal }] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM reviews r
    JOIN responses resp ON resp.review_id = r.id AND resp.status = 'posted'
    WHERE r.business_id = ${owner.businessId}
      AND ( ${activatedAtIso}::timestamptz IS NOT NULL AND r.review_date < ${activatedAtIso}::timestamptz )
  `;

  const isHistorical = (rd: Date) =>
    activatedAtIso === null || new Date(rd).getTime() < new Date(activatedAtIso).getTime();
  const gapRows = rows.filter((r) => !isHistorical(r.review_date));
  const histRows = rows.filter((r) => isHistorical(r.review_date));

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">Past Replies</h1>

      <section className="mb-8">
        <h2 className="mb-3 text-lg font-semibold">From your active period ({gapTotal})</h2>
        {gapRows.map((row) => (
          <PastReplyCard key={row.response_id} row={row} canEdit={true} isImported={row.external_reply_ingested_at !== null} />
        ))}
      </section>

      {histTotal > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-lg font-semibold">From before you joined ({histTotal})</h2>
          {!isPremium && <HistoricalUpgradeBanner />}
          {histRows.map((row) => (
            <PastReplyCard key={row.response_id} row={row} canEdit={isPremium} isImported={row.external_reply_ingested_at !== null} />
          ))}
        </section>
      )}

      <Pagination page={page} total={gapTotal + histTotal} pageSize={PAGE_SIZE} />
    </div>
  );
}

function Pagination({ page, total, pageSize }: { page: number; total: number; pageSize: number }) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <nav className="flex items-center justify-between">
      <a className={page <= 1 ? 'opacity-50 pointer-events-none' : ''} href={`?page=${page - 1}`}>← Previous</a>
      <span>Page {page} of {totalPages}</span>
      <a className={page >= totalPages ? 'opacity-50 pointer-events-none' : ''} href={`?page=${page + 1}`}>Next →</a>
    </nav>
  );
}
```

- [ ] **Step 3: Verify the page renders without throwing**

Run `pnpm dev` and navigate to `/dashboard/past-replies`. With flag off, expect 404. With flag on locally, expect either an empty state or seeded rows.

- [ ] **Step 4: Commit**

```bash
git add src/app/\(authenticated\)/dashboard/past-replies/page.tsx src/components/dashboard/HistoricalUpgradeBanner.tsx
git commit -m "feat(dashboard): /dashboard/past-replies server component + upgrade banner"
```

---

### Task 16: Frontend — PastReplyCard + EditReplyDrawer

**Files:**
- Create: `src/components/dashboard/PastReplyCard.tsx`
- Create: `src/components/dashboard/EditReplyDrawer.tsx`

- [ ] **Step 1: Create `PastReplyCard.tsx`**

A presentational client component that shows the review (reviewer + rating + text + date), the current Google reply, and either an "Edit" button (when `canEdit`) or a "🔒 Premium feature" badge. Clicking Edit opens `EditReplyDrawer` with the row data. An "Imported from Google · YYYY-MM-DD" / "Posted via RepWorth · YYYY-MM-DD" label distinguishes provenance.

- [ ] **Step 2: Create `EditReplyDrawer.tsx`**

A client component implementing the 6 states from spec §5.2:

1. **Initial** — review snapshot + read-only Google reply + two CTAs ("Edit manually" / "Regenerate with AI").
2. **Manual editing** — textarea pre-filled with current reply, character count, "Update on Google" / "Cancel".
3. **Regenerating** — loading indicator, polls `/draft-status?outbox_id=...` every 1500ms, max 60s.
4. **Regenerate preview** — AI draft visible, two CTAs ("Update on Google" / "Edit further" → state 2).
5. **Publishing** — loading indicator after `/publish` returns; polls publisher outbox status (or sets a timer to refresh the page after a few seconds — the publisher outcome surfaces on the dashboard's recent-reviews section).
6. **Recovery** — shown if a `failed` row is detected; renders [Retry posting] / [Restore original] CTAs that call `/retry` and `/restore-original` respectively.

**Snapshot pattern:** the drawer captures `{ hash: row.review_content_hash, version: row.version }` from the page-level data on open and sends it with every mutating call. On 409, the drawer surfaces a "The customer updated this review. Refresh to see the latest." prompt with a Refresh button that re-loads the page.

(Implementation is straightforward React with `useState` for the state machine, `useEffect` for polling. No new shared utility code needed.)

- [ ] **Step 3: Smoke test in dev**

Manually verify: open the page locally with flag on, click Edit, edit text, click Update on Google, observe the publisher mock-mode happy path.

- [ ] **Step 4: Commit**

```bash
git add src/components/dashboard/PastReplyCard.tsx src/components/dashboard/EditReplyDrawer.tsx
git commit -m "feat(dashboard): PastReplyCard + EditReplyDrawer with 6-state UI"
```

---

### Task 17: Nav link

**Files:**
- Modify: `src/components/OwnerNav.tsx`

- [ ] **Step 1: Add the nav item**

In `src/components/OwnerNav.tsx`, add a Link between Dashboard and Settings (only render when flag is on; gate via a server-side prop or simple `process.env.NEXT_PUBLIC_*` ... wait — the spec is server-authoritative with no `NEXT_PUBLIC_*`, so we either always render and let the page itself 404, or pass a flag prop down from `(authenticated)/layout.tsx`).

Implementation: pass a `pastRepliesEnabled` boolean prop from `(authenticated)/layout.tsx` (which reads `process.env.EDIT_EXISTING_REPLIES_ENABLED` server-side) into `OwnerNav`. Only render the link when true.

```tsx
// In layout.tsx, replace `<OwnerNav businessName={businessName} />` with:
<OwnerNav businessName={businessName}
          pastRepliesEnabled={process.env.EDIT_EXISTING_REPLIES_ENABLED === 'true'} />

// In OwnerNav.tsx, accept the new prop and conditionally render:
{pastRepliesEnabled && (
  <Link href="/dashboard/past-replies" className="rounded-md px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 hover:text-gray-900">
    Past Replies
  </Link>
)}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/OwnerNav.tsx src/app/\(authenticated\)/layout.tsx
git commit -m "feat(dashboard): wire Past Replies nav link (flag-gated server-side)"
```

---

### Task 18: Integration tests + E2E

**Files:**
- Create: `worker/__tests__/integration-edit-existing-reply.test.ts`
- Create: `e2e/edit-existing-reply.spec.ts`

- [ ] **Step 1: Write the integration test suite (per spec §6.2)**

Cover all 9 cases listed in spec §6.2 against real Postgres (skip gracefully when `TEST_DATABASE_POOL_URL` is unset). Use the existing `worker/__tests__/integration-*.test.ts` files in this repo as the seeding pattern.

- [ ] **Step 2: Write the E2E spec (per spec §6.3)**

```ts
// e2e/edit-existing-reply.spec.ts
import { test, expect } from '@playwright/test';

test.skip(!process.env.TEST_DATABASE_POOL_URL, 'requires TEST_DATABASE_POOL_URL');
test.skip(process.env.EDIT_EXISTING_REPLIES_ENABLED !== 'true', 'requires flag on');

test('premium owner happy path', async ({ page }) => { /* */ });
test('standard tier gate (gap rows have Edit, historical rows show lock + banner)', async ({ page }) => { /* */ });
test('regenerate flow with stubbed LLM', async ({ page }) => { /* */ });
test('cancel mid-edit (no DB writes)', async ({ page }) => { /* */ });
```

- [ ] **Step 3: Run all tests**

```bash
pnpm test
pnpm test:e2e
```
Expected: PASS for all unit + integration; E2E skips gracefully without `TEST_DATABASE_POOL_URL`.

- [ ] **Step 4: Commit**

```bash
git add worker/__tests__/integration-edit-existing-reply.test.ts e2e/edit-existing-reply.spec.ts
git commit -m "test(edit-existing): integration + E2E coverage"
```

---

### Task 19: Backfill script for retroactive ingestion

**Files:**
- Create: `scripts/zernio-backfill-external-replies.ts`

- [ ] **Step 1: Write the script**

Implements rollout option B from spec §7.2:

```ts
#!/usr/bin/env node
// scripts/zernio-backfill-external-replies.ts
//
// Walks Zernio for the given business and ingests any already-replied
// reviews that don't yet have a 'posted' response in our DB. Idempotent —
// rerunning on the same business produces zero new rows after the first
// successful run.
//
// Usage:
//   pnpm tsx scripts/zernio-backfill-external-replies.ts <business-id>

import 'dotenv/config';
import { sql } from '../src/lib/db/server';
import { zernioClient } from '../src/lib/zernio/client';
import { reconcileExternallyAnsweredReview } from '../worker/jobs/zernio-ingest-shared';
import { createWorkerLogger } from '../src/lib/shared/logger';

async function main() {
  const businessId = process.argv[2];
  if (!businessId) { console.error('Usage: ... <business-id>'); process.exit(1); }
  if (process.env.EDIT_EXISTING_REPLIES_ENABLED !== 'true') {
    console.error('Set EDIT_EXISTING_REPLIES_ENABLED=true before running.');
    process.exit(1);
  }

  const [conn] = await sql<{ zernio_account_id: string; zernio_location_id: string }[]>`
    SELECT zernio_account_id, zernio_location_id
    FROM zernio_connections WHERE business_id = ${businessId} AND status = 'active'
    LIMIT 1
  `;
  if (!conn) { console.error('No active Zernio connection.'); process.exit(1); }

  const logger = createWorkerLogger('[backfill-external-replies]');
  const reviews = await zernioClient.listAllReviews(conn.zernio_account_id, {
    locationId: conn.zernio_location_id, pageSize: 50, maxPages: 20,
  });
  const answered = reviews.filter((r) => r.reviewReply !== null);

  for (const r of answered) {
    try {
      await reconcileExternallyAnsweredReview(
        r, businessId, conn.zernio_account_id, conn.zernio_location_id, logger,
      );
    } catch (err) {
      console.error(`Failed for review ${r.id}:`, err);
    }
  }
  console.log(`Done. ${answered.length} answered review(s) processed.`);
  process.exit(0);
}
main();
```

- [ ] **Step 2: Smoke-run against staging Zernio sandbox** (manual; not part of CI)

- [ ] **Step 3: Commit**

```bash
git add scripts/zernio-backfill-external-replies.ts
git commit -m "feat(scripts): one-off CLI to backfill external Zernio replies for a business"
```

---

### Task 20: Runbook update

**Files:**
- Modify: `docs/runbooks/zernio-launch-runbook.md`

- [ ] **Step 1: Append the new section**

Add a new section "Edit existing replies (Phase A/B rollout)" to `docs/runbooks/zernio-launch-runbook.md` with:

- The two-phase rollout (apply migration → ship code with flag off → soak ≥1 week → flip flag).
- Pre-flight check SQL block (the duplicate-`posted` query).
- Post-migration index validity check.
- Monitoring thresholds from spec §7.3 (failed-with-DELETE-prefix > 1%, 409 review_changed > 5%, 403 inbox_addon_required = any → Sentry).
- Rollback steps from spec §7.4.

- [ ] **Step 2: Commit**

```bash
git add docs/runbooks/zernio-launch-runbook.md
git commit -m "docs(runbook): edit-existing-replies Phase A/B rollout + monitoring thresholds"
```

---

### Task 21: Final verification

- [ ] **Step 1: Run full test suite + tsc + lint**

```bash
pnpm test
pnpm build      # tsc as part of next build
pnpm lint
```
Expected: ALL PASS (1707+ baseline + ~30-40 new cases).

- [ ] **Step 2: Manual QA checklist from spec §6.4**

Run the 6-item checklist on staging (per spec §6.4) BEFORE flipping `EDIT_EXISTING_REPLIES_ENABLED=true` in prod.

- [ ] **Step 3: Self-review against spec §6.6 acceptance criteria**

- All existing tests pass.
- ~30-40 new test cases.
- TSC clean.
- Lint clean.
- Manual QA on staging completes the 6-item checklist successfully.
- Migration applies on staging without violating the new unique-index pre-flight.

- [ ] **Step 4: Open PR**

PR title: `feat: edit existing replies (tier-mirrored, flag-gated)`. Body links to spec, calls out the migration + the two-phase rollout, and lists the env vars introduced (`EDIT_EXISTING_REPLIES_ENABLED`).
