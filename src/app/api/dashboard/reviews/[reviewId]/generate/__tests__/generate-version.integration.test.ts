// src/app/api/dashboard/reviews/[reviewId]/generate/__tests__/generate-version.integration.test.ts
//
// T1 EVAL suite for #678 — F9: the C1 chain against LIVE Postgres.
//
// `discarding a v1 Generate draft retains it and the next POST generate enqueues
// v2` cannot be proved with a mocked `sql` tag: seeding `MAX(version) = 2` and
// then asserting the payload says 2 passes vacuously and proves nothing about
// the RETENTION the cost policy depends on. The whole point of D-B is that the
// discard sets `status='superseded'` and KEEPS the row, so `COALESCE(MAX(version),
// 0) + 1` climbs and **On-demand generation**'s per-review daily cap self-arms.
// Hardcoding `1` would create an unbounded free-regeneration loop, and only a
// real transaction over real rows can tell the two apart.
//
// Live-DB conventions (CLAUDE.md gotcha, `ci:live-db-suites`): named
// `*.integration.test.ts`, gated by `describeWithDb`, ASSERTS its schema with
// `assertSchemaReady`, and NEVER applies migration SQL.
//
// Harness: the `vi.hoisted()` DATABASE_POOL_URL override from
// worker/jobs/publisher/__tests__/edit-existing-reply.integration.test.ts, so
// both route handlers run against the same `sql` singleton the production code
// holds. Only the auth / rate-limit seams are mocked — never the DB.

import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';

// ── Point the production `sql` singleton at the test DB BEFORE app imports ───
const { testDbUrl, originalEnv } = vi.hoisted(() => {
  const originalEnv = {
    DATABASE_POOL_URL: process.env.DATABASE_POOL_URL,
    ALLOW_E2E_DB_WRITES: process.env.ALLOW_E2E_DB_WRITES,
    EDIT_REPLIES_ENABLED: process.env.EDIT_REPLIES_ENABLED,
    PAST_REPLIES_VIEW_ENABLED: process.env.PAST_REPLIES_VIEW_ENABLED,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    TEST_DATABASE_POOL_URL: process.env.TEST_DATABASE_POOL_URL,
  };

  // vitest.setup.ts does not load .env.local; read TEST_DATABASE_POOL_URL here
  // so the override lands before `@/lib/db/server` builds `sql` at module load.
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
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
    // The discard route (DELETE /past-replies/draft/:id) is flag-gated. Both
    // names are set so this suite is correct on either side of Task 8's
    // `flags.ts` collapse — after it, only EDIT_REPLIES_ENABLED is read.
    process.env.EDIT_REPLIES_ENABLED = 'true';
    process.env.PAST_REPLIES_VIEW_ENABLED = 'true';
  }
  return { testDbUrl, originalEnv };
});

// ── Mock ONLY the auth / rate-limit seams (NEVER the DB) ─────────────────────

const { mockRequireRole, mockResolveOwnerScope, mockEnforceRegenLimit, mockEnforceRegenBudget } =
  vi.hoisted(() => ({
    mockRequireRole: vi.fn(),
    mockResolveOwnerScope: vi.fn(),
    mockEnforceRegenLimit: vi.fn(),
    mockEnforceRegenBudget: vi.fn(),
  }));

vi.mock('@/lib/db/auth', () => {
  class AuthError extends Error {
    constructor(message: string, public readonly statusCode: number) {
      super(message);
      this.name = 'AuthError';
    }
  }
  return { requireRole: (...args: unknown[]) => mockRequireRole(...args), AuthError };
});

vi.mock('@/lib/auth/resolve-owner-scope', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/resolve-owner-scope')>(
    '@/lib/auth/resolve-owner-scope',
  );
  return { ...actual, resolveOwnerScope: mockResolveOwnerScope };
});

// Redis-backed and orthogonal to the version arithmetic — both fail open in
// production anyway. Stubbed so this suite needs only Postgres.
vi.mock('@/lib/shared/dashboard-regen-rate-limit', () => ({
  enforceDashboardRegenRateLimit: (...args: unknown[]) => mockEnforceRegenLimit(...args),
  enforceRegenBudgetForReview: (...args: unknown[]) => mockEnforceRegenBudget(...args),
}));

// ── Imports AFTER the mocks + env override ───────────────────────────────────

import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { sql } from '@/lib/db/server';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  cleanupTenantAccount,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import {
  assertSchemaReady,
  MIGRATION_100_IMPORT_CONSENT,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import { GENERATE_RESPONSE_ORIGIN_LANE } from '@/lib/shared/worker-types';
import { REVIEW_STATUS } from '@/lib/reviews/status';

const APP_URL = 'http://localhost:3000';
const RUN = !!testDbUrl;

let tenant: TenantSeed | undefined;
const businessId = randomUUID();
const reviewId = randomUUID();
const firstDraftId = randomUUID();

interface GeneratePayload {
  version: number;
  origin_lane: string;
  suppress_notification?: boolean;
}

function generateRequest(): NextRequest {
  return new NextRequest(`${APP_URL}/api/dashboard/reviews/${reviewId}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: APP_URL },
  });
}

function discardRequest(responseId: string): NextRequest {
  return new NextRequest(`${APP_URL}/api/dashboard/past-replies/draft/${responseId}`, {
    method: 'DELETE',
    headers: { Origin: APP_URL },
  });
}

async function generateOutboxRows(): Promise<
  { id: string; status: string; payload: GeneratePayload | string }[]
> {
  return sql<{ id: string; status: string; payload: GeneratePayload | string }[]>`
    SELECT id, status, payload FROM job_outbox
    WHERE topic = ${QUEUE_NAMES.GENERATE_RESPONSE}
      AND aggregate_id = ${reviewId}
    ORDER BY created_at ASC
  `;
}

/** PgBouncer can hand JSONB back as a string (CLAUDE.md gotcha). */
function readPayload(raw: GeneratePayload | string): GeneratePayload {
  const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!parsed || typeof parsed !== 'object' || !('version' in parsed)) {
    throw new Error('generate_response payload did not parse to an object');
  }
  return parsed as GeneratePayload;
}

describeWithDb(
  'On-demand generation version arithmetic against live Postgres',
  { enabled: RUN, timeout: 30_000 },
  () => {
    beforeAll(async () => {
      // #678 ships no migration; 100 is asserted as the head proxy so a
      // behind-head container fails with the actionable `pnpm test:db:setup`
      // message rather than an unrelated assertion.
      await assertSchemaReady(sql, [MIGRATION_100_IMPORT_CONSENT]);
      tenant = await seedTenantAccount(sql, {
        userName: 'Generate Version Owner',
        accountDisplayName: 'Generate Version Account',
      });
      await sql`
        INSERT INTO businesses (id, name, owner_name, owner_email, account_id, subscription_status)
        VALUES (${businessId}::uuid, 'Generate Version Location', 'Generate Version Owner',
                ${tenant.ownerEmail}, ${tenant.accountId}::uuid, 'active')
      `;
      await sql`
        INSERT INTO reviews (
          id, business_id, provider, provider_review_id, provider_review_name,
          provider_location_name, reviewer_name, star_rating, review_text,
          review_date, status
        ) VALUES (
          ${reviewId}::uuid, ${businessId}::uuid, 'zernio',
          ${`genver-${reviewId}`}, ${`zernio://genver/reviews/${reviewId}`},
          'zernio://genver/locations/1', 'Generate Version Customer', 4,
          'Never replied to this one.', NOW(), ${REVIEW_STATUS.NEW}
        )
      `;
    });

    afterAll(async () => {
      if (!RUN) return;
      if (tenant) {
        await sql`DELETE FROM job_outbox WHERE aggregate_id = ${reviewId}`;
        await sql`DELETE FROM responses WHERE business_id = ${businessId}::uuid`;
        await sql`DELETE FROM reviews WHERE business_id = ${businessId}::uuid`;
        await sql`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
        await cleanupTenantAccount(sql, tenant);
      }
      process.env.DATABASE_POOL_URL = originalEnv.DATABASE_POOL_URL;
      process.env.ALLOW_E2E_DB_WRITES = originalEnv.ALLOW_E2E_DB_WRITES;
      process.env.EDIT_REPLIES_ENABLED = originalEnv.EDIT_REPLIES_ENABLED;
      process.env.PAST_REPLIES_VIEW_ENABLED = originalEnv.PAST_REPLIES_VIEW_ENABLED;
      process.env.NEXT_PUBLIC_APP_URL = originalEnv.NEXT_PUBLIC_APP_URL;
    });

    beforeEach(() => {
      vi.clearAllMocks();
      mockRequireRole.mockResolvedValue({
        id: tenant!.userId,
        name: 'Generate Version Owner',
        email: tenant!.ownerEmail,
        role: 'owner',
        accountId: tenant!.accountId,
      });
      mockResolveOwnerScope.mockResolvedValue({
        accountId: tenant!.accountId,
        locationId: businessId,
      });
      mockEnforceRegenLimit.mockResolvedValue(null);
      mockEnforceRegenBudget.mockResolvedValue(null);
    });

    it('discarding a v1 Generate draft retains it and the next POST generate enqueues v2', async () => {
      const { POST: generatePOST } = await import('../route');
      const { DELETE: discardDELETE } = await import(
        '@/app/api/dashboard/past-replies/draft/[responseId]/route'
      );

      // 1. First Generate on a never-replied review → version 1 (free by C1).
      const first = await generatePOST(generateRequest(), {
        params: Promise.resolve({ reviewId }),
      });
      expect(first.status).toBe(200);
      expect((await first.json()).version).toBe(1);

      const afterFirst = await generateOutboxRows();
      expect(afterFirst).toHaveLength(1);
      expect(GENERATE_RESPONSE_ORIGIN_LANE.ON_DEMAND_GENERATE).toBe('on_demand_generate');
      expect(readPayload(afterFirst[0]!.payload).origin_lane).toBe(
        GENERATE_RESPONSE_ORIGIN_LANE.ON_DEMAND_GENERATE,
      );

      // 2. Stand in for the worker: persist the v1 draft and settle the outbox
      //    row so the in-flight guard no longer refuses a second attempt.
      await sql`
        INSERT INTO responses (
          id, review_id, business_id, response_text, original_draft_text,
          response_language, version, status
        ) VALUES (
          ${firstDraftId}::uuid, ${reviewId}::uuid, ${businessId}::uuid,
          'Thanks so much for the kind words.', 'Thanks so much for the kind words.',
          'en', 1, 'pending_approval'
        )
      `;
      await sql`
        UPDATE job_outbox SET status = 'completed', completed_at = NOW()
        WHERE id = ${afterFirst[0]!.id}
      `;

      // 3. Discard it through the REAL route.
      const discarded = await discardDELETE(discardRequest(firstDraftId), {
        params: Promise.resolve({ responseId: firstDraftId }),
      });
      expect(discarded.status).toBe(204);

      // RETENTION — the fact C1 self-arms on. The row must still be there.
      const [retained] = await sql<{ status: string; version: number }[]>`
        SELECT status, version FROM responses WHERE id = ${firstDraftId}::uuid
      `;
      expect(retained).toBeDefined();
      expect(retained!.status).toBe('superseded');
      expect(retained!.version).toBe(1);

      // 4. The next Generate is version 2 — charged, not free.
      const second = await generatePOST(generateRequest(), {
        params: Promise.resolve({ reviewId }),
      });
      expect(second.status).toBe(200);
      expect((await second.json()).version).toBe(2);

      const afterSecond = await generateOutboxRows();
      expect(afterSecond).toHaveLength(2);
      const secondPayload = readPayload(afterSecond[1]!.payload);
      expect(secondPayload.version).toBe(2);
      expect(secondPayload.origin_lane).toBe(GENERATE_RESPONSE_ORIGIN_LANE.ON_DEMAND_GENERATE);
      expect(secondPayload.suppress_notification).toBe(true);
    });
  },
);
