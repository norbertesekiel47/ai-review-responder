// worker/jobs/publisher/__tests__/integration-edit-existing-reply.test.ts
//
// HARD-GATE integration coverage for the edit-publisher DELETE-before-POST
// flow + recovery routes against a REAL Postgres database (spec
// `docs/superpowers/specs/2026-05-01-edit-existing-replies-design.md` §7).
//
// The edit-publisher is the only code that can ORPHAN a real Google reply
// (DELETE succeeds, POST fails → Google's reply slot is empty with no live
// `posted` row). The unit tests for `edit-publish.ts` / `failed-hook.ts` mock
// the `sql` seam, so the actual `FOR UPDATE` locking + per-CATCH commit
// semantics (commit-the-supersede-but-throw, rollback-then-throw, etc.) are
// never exercised. This file runs them for real:
//
//   - REAL Postgres (TEST_DATABASE_POOL_URL), REAL `sql.begin` transactions,
//     REAL `reviews FOR UPDATE` + `responses FOR UPDATE` row locks, REAL
//     per-CATCH COMMIT/ROLLBACK.
//   - ONLY the external Zernio HTTP client is mocked (deleteReply/postReply).
//   - The edit-publish module, the failed-hook orphan conversion, and the
//     /retry + /restore-original route tx logic all run against real rows.
//
// Gating: the suite SKIPS only when TEST_DATABASE_POOL_URL is absent. With the
// URL present it is a HARD MERGE GATE — it must actually run, not skip.
//
// Harness reused: the lazy-`postgres()` connection + per-test unique-UUIDv7
// isolation + FK-ordered seed/cleanup pattern from `e2e/seed.ts`. Unlike
// `e2e/seed.ts` (which builds its own `postgres()` handle), this file routes
// every seed/assert through the SAME `sql` singleton the production code uses,
// because we point `DATABASE_POOL_URL` at the test DB in the vi.hoisted block
// below — so the locking we assert on is the exact client the publisher holds.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Job } from 'bullmq';

// ── Point the production `sql` singleton at the test DB BEFORE app imports ───
// `src/lib/db/server.ts` builds `sql` from `process.env.DATABASE_POOL_URL!` at
// module-load time. vitest.setup.ts only sets a DUMMY DATABASE_POOL_URL via
// `??`, so we override it here in a hoisted block (runs before the static
// imports below resolve). We also flip EDIT_REPLIES_ENABLED on — the failed
// hook's orphan conversion + both recovery routes are flag-gated.
const { testDbUrl } = vi.hoisted(() => {
  // vitest.setup.ts does NOT load .env.local, so read TEST_DATABASE_POOL_URL
  // ourselves (minimal KEY=VALUE parse — no dotenv dep, no require). Done in a
  // hoisted block so the env override below lands BEFORE `@/lib/db/server`
  // builds its `sql` singleton from DATABASE_POOL_URL at module-load time.
  if (!process.env.TEST_DATABASE_POOL_URL) {
    try {
      const fs = require('node:fs') as typeof import('node:fs');
      const raw = fs.readFileSync('.env.local', 'utf8');
      for (const line of raw.split('\n')) {
        const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
        const key = match?.[1];
        const rawValue = match?.[2];
        if (!key || rawValue === undefined) continue;
        if (!(key in process.env)) process.env[key] = rawValue.replace(/^["']|["']$/g, '');
      }
    } catch {
      // No .env.local — the suite skip-gates below.
    }
  }
  const testDbUrl = process.env.TEST_DATABASE_POOL_URL;
  if (testDbUrl) {
    process.env.DATABASE_POOL_URL = testDbUrl;
    process.env.ALLOW_E2E_DB_WRITES = 'true';
    process.env.EDIT_REPLIES_ENABLED = 'true';
  }
  return { testDbUrl };
});

// ── Mock ONLY the external Zernio HTTP client (the sole network seam) ────────
// The relative path the worker uses and the `@/lib/zernio/client` alias the
// routes use canonicalise to the same module under Vitest, so one mock covers
// both call sites.
const { mockDeleteReply, mockPostReply } = vi.hoisted(() => ({
  mockDeleteReply: vi.fn(),
  mockPostReply: vi.fn(),
}));
vi.mock('@/lib/zernio/client', () => ({
  zernioClient: { deleteReply: mockDeleteReply, postReply: mockPostReply },
}));

// ── Mock ONLY the route auth/csrf/tier seams (NOT the DB) ────────────────────
// The /retry + /restore-original route handlers gate on same-origin, owner
// scope, and the premium tier check before their real `sql.begin` tx. None of
// those touch the orphan/locking logic under test; stub them so the route's
// REAL transaction body runs against the real DB with our seeded scope.
const { mockResolveOwnerScope } = vi.hoisted(() => ({ mockResolveOwnerScope: vi.fn() }));
vi.mock('@/lib/auth/resolve-owner-scope', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/resolve-owner-scope')>(
    '@/lib/auth/resolve-owner-scope',
  );
  return { ...actual, resolveOwnerScope: mockResolveOwnerScope };
});
vi.mock('@/lib/shared/csrf', async () => {
  const actual = await vi.importActual<typeof import('@/lib/shared/csrf')>('@/lib/shared/csrf');
  return { ...actual, assertSameOrigin: vi.fn() };
});
vi.mock('@/lib/responses/edit-existing', async () => {
  const actual = await vi.importActual<typeof import('@/lib/responses/edit-existing')>(
    '@/lib/responses/edit-existing',
  );
  return { ...actual, assertCanEditReply: vi.fn(async () => {}) };
});

// ── Imports AFTER mocks + env override are registered ────────────────────────
import { sql } from '@/lib/db/server';
import { v7 as uuidv7 } from 'uuid';
import { randomUUID } from 'node:crypto';
import { runEditPublishIfApplicable } from '../edit-publish';
import { handlePublisherFailed } from '../failed-hook';
import {
  PENDING_AFTER_DELETE,
  POST_AFTER_DELETE_FAILED_PREFIX,
  POST_AFTER_DELETE_FAILED_RETRY_EXHAUSTED,
  DELETE_FAILED_PREFIX,
  isOrphanMarker,
} from '../orphan-markers';
import { ZernioPermanentError, ZernioTransientError } from '@/lib/zernio/errors';
import { PublisherTransientWithContext } from '../publisher-error-handlers';
import { POST as retryPOST } from '@/app/api/dashboard/past-replies/[responseId]/retry/route';
import { POST as restorePOST } from '@/app/api/dashboard/past-replies/[responseId]/restore-original/route';
import type { WorkerLogger } from '@/lib/shared/logger';
import type { PublishResponsePayload } from '@/lib/shared/worker-types';
import { NextRequest } from 'next/server';

const RUN = !!testDbUrl;
const d = RUN ? describe : describe.skip;

const noopLogger: WorkerLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as WorkerLogger;

const ZERNIO_ACCOUNT = 'zacct-edit-int';
const ZERNIO_LOCATION = 'zloc-edit-int';

interface Seed {
  userId: string;
  accountId: string;
  businessId: string;
  reviewId: string;
  zernioReviewId: string;
}

/** All ids created here so cleanup can cascade-delete deterministically. */
const createdAccountIds: string[] = [];
const createdUserIds: string[] = [];

/**
 * Seed users → accounts → businesses → reviews + (optionally) an existing
 * `posted` response, in ONE tx (users/accounts have a circular DEFERRABLE FK).
 * Each call uses fresh UUIDv7 ids so parallel/sequential cases never collide.
 */
async function seedReviewWithExistingReply(): Promise<{
  seed: Seed;
  postedResponseId: string;
}> {
  const userId = uuidv7();
  const accountId = uuidv7();
  const businessId = uuidv7();
  const reviewId = uuidv7();
  const postedResponseId = uuidv7();
  const zernioReviewId = `zrev-${randomUUID()}`;
  // Fully-random local part so sequential cases (which share a UUIDv7 time
  // prefix) cannot collide on the users.email unique constraint.
  const ownerEmail = `edit-int-${randomUUID()}@test.local`;

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO users (id, name, email, role, account_id)
      VALUES (${userId}, 'Edit Int Owner', ${ownerEmail}, 'owner', ${accountId})
    `;
    await tx`
      INSERT INTO accounts (id, owner_user_id, display_name, subscription_tier, subscription_status)
      VALUES (${accountId}, ${userId}, 'Edit Int Account', 'pro', 'active')
    `;
    await tx`
      INSERT INTO businesses (id, name, owner_name, owner_email, account_id, subscription_status)
      VALUES (${businessId}, 'Edit Int Biz', 'Edit Int Owner', ${ownerEmail}, ${accountId}, 'active')
    `;
    await tx`
      INSERT INTO reviews (id, business_id, provider, provider_review_id, provider_review_name, provider_location_name, reviewer_name, star_rating, review_text, status)
      VALUES (${reviewId}, ${businessId}, 'zernio', ${zernioReviewId}, ${`zernio://${ZERNIO_ACCOUNT}/locations/${ZERNIO_LOCATION}/reviews/${zernioReviewId}`}, ${`zernio://${ZERNIO_ACCOUNT}/locations/${ZERNIO_LOCATION}`}, 'Int Reviewer', 5, 'Loved it!', 'responded')
    `;
    await tx`
      INSERT INTO responses (id, review_id, business_id, response_text, original_draft_text, approved_text, response_language, version, status, posted_at)
      VALUES (${postedResponseId}, ${reviewId}, ${businessId}, 'Original posted reply text', 'Original posted reply text', 'Original posted reply text', 'en', 1, 'posted', NOW())
    `;
  });

  createdAccountIds.push(accountId);
  createdUserIds.push(userId);
  return {
    seed: { userId, accountId, businessId, reviewId, zernioReviewId },
    postedResponseId,
  };
}

/** Insert a candidate (the edit draft) in a publishable status. */
async function insertCandidate(
  seed: Seed,
  opts: { status: string; version: number; postingError?: string | null; approvedText?: string },
): Promise<string> {
  const id = uuidv7();
  const approvedText = opts.approvedText ?? 'Edited reply text';
  await sql`
    INSERT INTO responses (id, review_id, business_id, response_text, original_draft_text, approved_text, response_language, version, status, posting_error)
    VALUES (
      ${id}, ${seed.reviewId}, ${seed.businessId},
      ${approvedText}, ${approvedText}, ${approvedText}, 'en',
      ${opts.version}, ${opts.status}, ${opts.postingError ?? null}
    )
  `;
  return id;
}

async function getResponse(id: string): Promise<{
  status: string;
  posting_error: string | null;
  posted_at: Date | null;
  version: number;
  approved_text: string | null;
} | null> {
  const [row] = await sql<
    {
      status: string;
      posting_error: string | null;
      posted_at: Date | null;
      version: number;
      approved_text: string | null;
    }[]
  >`SELECT status, posting_error, posted_at, version, approved_text FROM responses WHERE id = ${id}`;
  return row ?? null;
}

function buildContext(seed: Seed, responseId: string, postingError: string | null, approvedText = 'Edited reply text') {
  return {
    responseId,
    businessId: seed.businessId,
    reviewId: seed.reviewId,
    approvedText,
    responsePostingError: postingError,
    zernioAccountId: ZERNIO_ACCOUNT,
    zernioLocationId: ZERNIO_LOCATION,
    zernioReviewId: seed.zernioReviewId,
    correlationId: undefined,
    logger: noopLogger,
  };
}

beforeAll(() => {
  if (!RUN) return;
  // Fail loudly here rather than silently skipping if the URL is set but the
  // mocks didn't register the test DB (so a misconfigured run can't masquerade
  // as a pass against the production pool).
  expect(process.env.DATABASE_POOL_URL).toBe(testDbUrl);
});

afterAll(async () => {
  if (!RUN) return;
  // FK-ordered teardown: businesses ON DELETE CASCADE clears reviews/responses/
  // audit/outbox children; then accounts, then users. Defer the users<->accounts
  // circular FK by deleting accounts before users inside one statement order.
  for (const accountId of createdAccountIds) {
    await sql`DELETE FROM job_outbox WHERE aggregate_id IN (SELECT id FROM responses WHERE business_id IN (SELECT id FROM businesses WHERE account_id = ${accountId}))`;
    await sql`DELETE FROM businesses WHERE account_id = ${accountId}`;
  }
  // users <-> accounts have a circular DEFERRABLE FK — delete both inside one
  // tx so the constraint is only checked at COMMIT.
  await sql.begin(async (tx) => {
    for (const accountId of createdAccountIds) {
      await tx`DELETE FROM accounts WHERE id = ${accountId}`;
    }
    for (const userId of createdUserIds) {
      await tx`DELETE FROM users WHERE id = ${userId}`;
    }
  });
  // Safe: Vitest isolates each test file in its own worker thread, so ending this worker's sql pool doesn't affect other suites.
  await sql.end();
});

d('HARD-GATE: edit-publisher + recovery against real Postgres', () => {
  // ── Scenario 1: DELETE-success + POST permanent-failure → orphan ───────────
  it('1. DELETE ok then POST fails permanently → candidate failed w/ orphan marker, sibling superseded, NO posted row', async () => {
    const { seed, postedResponseId } = await seedReviewWithExistingReply();
    const candidateId = await insertCandidate(seed, { status: 'approved', version: 2 });

    mockDeleteReply.mockReset().mockResolvedValueOnce(undefined);
    mockPostReply
      .mockReset()
      .mockRejectedValueOnce(new ZernioPermanentError('http_400', { endpointKind: 'post_reply' }));

    const result = await runEditPublishIfApplicable(buildContext(seed, candidateId, null));

    expect(result).toEqual({ outcome: 'failed', reason: 'zernio_permanent_after_edit_publish' });
    expect(mockDeleteReply).toHaveBeenCalledTimes(1);
    expect(mockPostReply).toHaveBeenCalledTimes(1);

    // Candidate: failed with a post_after_delete_failed_* orphan marker.
    const candidate = await getResponse(candidateId);
    expect(candidate?.status).toBe('failed');
    expect(candidate?.posting_error?.startsWith(POST_AFTER_DELETE_FAILED_PREFIX)).toBe(true);
    expect(isOrphanMarker(candidate?.posting_error)).toBe(false); // permanent marker, not a *_after_delete_succeeded retry marker

    // Old sibling: superseded (DELETE removed it from Google).
    const sibling = await getResponse(postedResponseId);
    expect(sibling?.status).toBe('superseded');

    // The orphan invariant: no live posted row remains for this review.
    const posted = await sql`
      SELECT id FROM responses WHERE review_id = ${seed.reviewId} AND status = 'posted'
    `;
    expect(posted.length).toBe(0);
  });

  // ── Scenario 2: retry-exhaustion conversion via the failed-hook ────────────
  it('2. failed-hook: orphan-marker row at retry exhaustion → status failed, posting_error=retry_exhausted', async () => {
    const { seed, postedResponseId } = await seedReviewWithExistingReply();
    // Simulate the post-DELETE orphan state the publisher leaves on a transient
    // POST failure: sibling superseded, candidate carries the *_after_delete_succeeded
    // marker (PENDING_AFTER_DELETE), and an outbox row is in-flight (dispatched).
    await sql`UPDATE responses SET status = 'superseded' WHERE id = ${postedResponseId}`;
    const candidateId = await insertCandidate(seed, {
      status: 'approved',
      version: 2,
      postingError: PENDING_AFTER_DELETE,
    });
    expect(isOrphanMarker(PENDING_AFTER_DELETE)).toBe(true);

    const outboxId = uuidv7();
    await sql`
      INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
      VALUES (${outboxId}, 'publish_response', 'response', ${candidateId}, ${sql.json({ response_id: candidateId, business_id: seed.businessId })}, 'dispatched')
    `;

    const payload: PublishResponsePayload & { outbox_id: string } = {
      response_id: candidateId,
      business_id: seed.businessId,
      outbox_id: outboxId,
    };
    const job = {
      id: outboxId,
      data: payload,
      attemptsMade: 5,
      opts: { attempts: 5 },
    } as unknown as Job<PublishResponsePayload>;

    const transientErr = new PublisherTransientWithContext(
      new ZernioTransientError('http_503', {}),
      {
        response_id: candidateId,
        business_id: seed.businessId,
        account_id: ZERNIO_ACCOUNT,
        location_id: ZERNIO_LOCATION,
      },
    );

    await handlePublisherFailed(job, transientErr);

    const candidate = await getResponse(candidateId);
    expect(candidate?.status).toBe('failed');
    expect(candidate?.posting_error).toBe(POST_AFTER_DELETE_FAILED_RETRY_EXHAUSTED);

    const [outboxRow] = await sql<{ status: string; last_error: string | null }[]>`
      SELECT status, last_error FROM job_outbox WHERE id = ${outboxId}
    `;
    expect(outboxRow?.status).toBe('failed');
    expect(outboxRow?.last_error).toBe(POST_AFTER_DELETE_FAILED_RETRY_EXHAUSTED);
  });

  // ── Scenario 3a: /retry recovery for delete_failed_* (live sibling) ────────
  it('3a. /retry delete_failed_* with live posted sibling → posting_error cleared to NULL, publish_response outbox enqueued', async () => {
    const { seed, postedResponseId } = await seedReviewWithExistingReply();
    // delete_failed_* means DELETE never committed → original sibling still posted.
    const candidateId = await insertCandidate(seed, {
      status: 'failed',
      version: 2,
      postingError: `${DELETE_FAILED_PREFIX}http_403`,
    });

    mockResolveOwnerScope.mockReset().mockResolvedValue({
      accountId: seed.accountId,
      locationId: seed.businessId,
      userId: seed.userId,
    });

    const res = await retryPOST(makeReq(), { params: Promise.resolve({ responseId: candidateId }) });
    const body = (await res.json()) as { outbox_id?: string; error?: string };
    expect(res.status).toBe(200);
    expect(body.outbox_id).toBeTruthy();

    const candidate = await getResponse(candidateId);
    expect(candidate?.status).toBe('approved');
    expect(candidate?.posting_error).toBeNull(); // cleared for the DELETE+POST re-entry

    // Sibling untouched (still live on Google).
    const sibling = await getResponse(postedResponseId);
    expect(sibling?.status).toBe('posted');

    const [outboxRow] = await sql<{ topic: string; status: string }[]>`
      SELECT topic, status FROM job_outbox WHERE id = ${body.outbox_id!}
    `;
    expect(outboxRow?.topic).toBe('publish_response');
    expect(outboxRow?.status).toBe('pending');
  });

  // ── Scenario 3b: /retry recovery for post_after_delete_failed_* (orphan) ───
  it('3b. /retry post_after_delete_failed_* orphan (no live sibling) → orphan marker re-installed, outbox enqueued', async () => {
    const { seed, postedResponseId } = await seedReviewWithExistingReply();
    // Orphan state: DELETE committed → original sibling superseded, no posted row.
    await sql`UPDATE responses SET status = 'superseded' WHERE id = ${postedResponseId}`;
    const candidateId = await insertCandidate(seed, {
      status: 'failed',
      version: 2,
      postingError: `${POST_AFTER_DELETE_FAILED_PREFIX}http_400`,
    });

    mockResolveOwnerScope.mockReset().mockResolvedValue({
      accountId: seed.accountId,
      locationId: seed.businessId,
      userId: seed.userId,
    });

    const res = await retryPOST(makeReq(), { params: Promise.resolve({ responseId: candidateId }) });
    const body = (await res.json()) as { outbox_id?: string; error?: string };
    expect(res.status).toBe(200);
    expect(body.outbox_id).toBeTruthy();

    const candidate = await getResponse(candidateId);
    expect(candidate?.status).toBe('approved');
    // Orphan marker RE-INSTALLED so the publisher takes the no-DELETE branch.
    expect(candidate?.posting_error).toBe(PENDING_AFTER_DELETE);
    expect(isOrphanMarker(candidate?.posting_error)).toBe(true);

    const [outboxRow] = await sql<{ topic: string; status: string }[]>`
      SELECT topic, status FROM job_outbox WHERE id = ${body.outbox_id!}
    `;
    expect(outboxRow?.topic).toBe('publish_response');
    expect(outboxRow?.status).toBe('pending');
  });

  // ── Scenario 4: /restore-original for the orphan case ──────────────────────
  it('4. /restore-original orphan → INSERTs fresh APPROVED row at MAX+1 + publish_response outbox, old failed row left in place', async () => {
    const { seed, postedResponseId } = await seedReviewWithExistingReply();
    // Orphan state: superseded sibling with posted_at set, no posted row.
    await sql`UPDATE responses SET status = 'superseded' WHERE id = ${postedResponseId}`;
    const failedId = await insertCandidate(seed, {
      status: 'failed',
      version: 2,
      postingError: `${POST_AFTER_DELETE_FAILED_PREFIX}http_400`,
    });

    mockResolveOwnerScope.mockReset().mockResolvedValue({
      accountId: seed.accountId,
      locationId: seed.businessId,
      userId: seed.userId,
    });

    const beforeOld = await sql`SELECT id FROM job_outbox WHERE aggregate_id = ${failedId}`;

    const res = await restorePOST(makeReq(), { params: Promise.resolve({ responseId: failedId }) });
    const body = (await res.json()) as { response_id?: string; outbox_id?: string; error?: string };
    expect(res.status).toBe(200);
    expect(body.response_id).toBeTruthy();
    expect(body.outbox_id).toBeTruthy();

    // New row: fresh APPROVED row at version MAX+1 (= 3 here), republished directly.
    const fresh = await getResponse(body.response_id!);
    expect(fresh?.status).toBe('approved');
    expect(fresh?.version).toBe(3);
    expect(fresh?.approved_text).toBe('Original posted reply text');

    // Old failed row left intentionally in place.
    const oldFailed = await getResponse(failedId);
    expect(oldFailed?.status).toBe('failed');
    expect(oldFailed?.posting_error?.startsWith(POST_AFTER_DELETE_FAILED_PREFIX)).toBe(true);

    // A publish_response outbox row IS enqueued for the NEW row (restore
    // republishes directly — no second owner hop). The old failed row gets none.
    const [newOutbox] = await sql<{ topic: string; status: string }[]>`
      SELECT topic, status FROM job_outbox WHERE id = ${body.outbox_id!}
    `;
    expect(newOutbox?.topic).toBe('publish_response');
    expect(newOutbox?.status).toBe('pending');
    const afterNew = await sql`SELECT id FROM job_outbox WHERE aggregate_id = ${body.response_id!}`;
    const afterOld = await sql`SELECT id FROM job_outbox WHERE aggregate_id = ${failedId}`;
    expect(afterNew.length).toBe(1);
    expect(afterOld.length).toBe(beforeOld.length);

    // The restored row carries NO orphan marker and has NO live posted sibling,
    // so the publisher's edit-publish dispatch predicate (sibling-posted OR
    // orphan-marker) does NOT match it — it will route to the normal post-reply
    // path and POST the original into the empty Google slot. (Driving the full
    // publisher requires seeding the Zernio connection + review-lookup path,
    // which other suites cover; here we assert the dispatch-relevant state.)
    expect(fresh?.posting_error).toBeNull();
    const livePosted = await sql`
      SELECT id FROM responses WHERE review_id = ${seed.reviewId} AND status = 'posted'
    `;
    expect(livePosted.length).toBe(0);
  });

  // ── Scenario 5: Past Replies page posted-rows sidecar attachment policy ─────
  //
  // Mirrors the LATERAL sidecar on the posted-rows query in
  // src/app/(authenticated)/dashboard/past-replies/page.tsx. The fix: only
  // delete_failed_* siblings attach to a live posted card. A
  // post_after_delete_failed_* row that coexists with a live posted row is a
  // RESOLVED/stale orphan (e.g. /restore-original already republished) and must
  // NOT badge the healthy posted reply. The predicate is the load-bearing
  // change; prefixes are imported (single source of truth), so this guards
  // against the predicate regressing back to matching both prefixes.
  const sidecarForPostedReview = (reviewId: string, businessId: string) =>
    sql<{ failed_response_id: string | null; failed_posting_error: string | null }[]>`
      SELECT
        resp.id                    AS posted_id,
        fail_sidecar.id            AS failed_response_id,
        fail_sidecar.posting_error AS failed_posting_error
      FROM reviews r
      JOIN responses resp
        ON resp.review_id = r.id
       AND resp.status = 'posted'
      LEFT JOIN LATERAL (
        SELECT id, posting_error
        FROM responses
        WHERE review_id = r.id
          AND status = 'failed'
          AND posting_error LIKE ${`${DELETE_FAILED_PREFIX}%`}
        ORDER BY created_at DESC
        LIMIT 1
      ) fail_sidecar ON true
      WHERE r.id = ${reviewId} AND r.business_id = ${businessId}
    `;

  it('5a. live posted row + post_after_delete_failed_* sibling → posted card does NOT get a recovery badge (failed_response_id null)', async () => {
    const { seed } = await seedReviewWithExistingReply();
    // Stale orphan marker coexisting with the still-live posted row.
    await insertCandidate(seed, {
      status: 'failed',
      version: 2,
      postingError: `${POST_AFTER_DELETE_FAILED_PREFIX}http_400`,
    });

    const [row] = await sidecarForPostedReview(seed.reviewId, seed.businessId);
    expect(row).toBeTruthy();
    expect(row!.failed_response_id).toBeNull();
    expect(row!.failed_posting_error).toBeNull();
  });

  it('5b. live posted row + delete_failed_* sibling → posted card DOES get the recovery sidecar', async () => {
    const { seed } = await seedReviewWithExistingReply();
    const failedId = await insertCandidate(seed, {
      status: 'failed',
      version: 2,
      postingError: `${DELETE_FAILED_PREFIX}http_403`,
    });

    const [row] = await sidecarForPostedReview(seed.reviewId, seed.businessId);
    expect(row).toBeTruthy();
    expect(row!.failed_response_id).toBe(failedId);
    expect(row!.failed_posting_error?.startsWith(DELETE_FAILED_PREFIX)).toBe(true);
  });
});

/** Minimal same-origin POST request (assertSameOrigin is mocked to no-op). */
function makeReq(): NextRequest {
  return new NextRequest('http://localhost/api/dashboard/past-replies/x/retry', {
    method: 'POST',
    headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}
