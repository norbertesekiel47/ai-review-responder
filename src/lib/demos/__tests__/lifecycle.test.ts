import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from '@/lib/db/server';
import { claimDemo, completeDemo, failDemo } from '../lifecycle';
import { makeReview, makeGenerationResult } from './fixtures';

// Real-DB integration test. `vitest.setup.ts` always sets a dummy
// DATABASE_POOL_URL so module-load doesn't crash, so we can't trust it
// as a signal — only TEST_DATABASE_POOL_URL means "a real test DB is
// reachable" (mirrors the convention used by zernio-end-to-end and the
// e2e/Playwright suites).
const testDb = process.env.TEST_DATABASE_POOL_URL;

describe('lifecycle', () => {
  if (!testDb) {
    it.skip('skipping — TEST_DATABASE_POOL_URL not set', () => {});
    return;
  }

  // Generate a unique slug prefix for THIS test run so cleanup never touches
  // unrelated data. Postgres VARCHAR(20) cap means we use a short suffix.
  const SLUG_PREFIX = `t-${Date.now().toString(36).slice(-6)}-`;

  async function insertProspectDemo(opts: {
    generation_status: string;
    started_at?: Date | null;
  }): Promise<string> {
    const id = crypto.randomUUID();
    const slug = `${SLUG_PREFIX}${Math.random().toString(36).slice(2, 8)}`;
    await sql`
      INSERT INTO prospect_demos (id, business_name, demo_url_slug, generation_status, started_at)
      VALUES (${id}, 'Test Biz', ${slug}, ${opts.generation_status}, ${opts.started_at ?? null})
    `;
    return id;
  }

  async function insertOutboxRow(): Promise<string> {
    const id = crypto.randomUUID();
    await sql`
      INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status, attempts)
      VALUES (${id}, 'generate_demo_test', 'demo', ${id}::uuid, ${sql.json({})}, 'dispatched', 0)
    `;
    return id;
  }

  beforeEach(async () => {
    await sql`DELETE FROM prospect_demos WHERE demo_url_slug LIKE ${SLUG_PREFIX + '%'}`;
    await sql`DELETE FROM job_outbox WHERE topic = 'generate_demo_test'`;
  });

  afterEach(async () => {
    await sql`DELETE FROM prospect_demos WHERE demo_url_slug LIKE ${SLUG_PREFIX + '%'}`;
    await sql`DELETE FROM job_outbox WHERE topic = 'generate_demo_test'`;
  });

  it('claimDemo returns not_found for missing row', async () => {
    const result = await claimDemo('prospect_demos', '00000000-0000-0000-0000-000000000000', console);
    expect(result).toBe('not_found');
  });

  it('claimDemo claims queued → running', async () => {
    const id = await insertProspectDemo({ generation_status: 'queued' });
    const result = await claimDemo('prospect_demos', id, console);
    expect(result).toBe('claimed');
    const [row] = await sql<{ generation_status: string }[]>`
      SELECT generation_status FROM prospect_demos WHERE id = ${id}
    `;
    expect(row?.generation_status).toBe('running');
  });

  it('claimDemo returns already_terminal for completed', async () => {
    const id = await insertProspectDemo({ generation_status: 'completed' });
    const result = await claimDemo('prospect_demos', id, console);
    expect(result).toBe('already_terminal');
  });

  it('claimDemo returns already_terminal for failed', async () => {
    const id = await insertProspectDemo({ generation_status: 'failed' });
    const result = await claimDemo('prospect_demos', id, console);
    expect(result).toBe('already_terminal');
  });

  it('claimDemo resets stale running (>5min)', async () => {
    const id = await insertProspectDemo({
      generation_status: 'running',
      started_at: new Date(Date.now() - 6 * 60 * 1000),
    });
    const result = await claimDemo('prospect_demos', id, console);
    expect(result).toBe('reset_to_queued');
    const [row] = await sql<{ generation_status: string; started_at: Date | null }[]>`
      SELECT generation_status, started_at FROM prospect_demos WHERE id = ${id}
    `;
    expect(row?.generation_status).toBe('queued');
    expect(row?.started_at).toBeNull();
  });

  it('claimDemo throws for non-stale running', async () => {
    const id = await insertProspectDemo({ generation_status: 'running', started_at: new Date() });
    await expect(claimDemo('prospect_demos', id, console)).rejects.toThrow('is running');
  });

  it('completeDemo writes reviews, responses, status=completed', async () => {
    const id = await insertProspectDemo({ generation_status: 'running' });
    const outboxId = await insertOutboxRow();
    await completeDemo('prospect_demos', id, outboxId, 0, {
      reviews: [makeReview({ reviewerName: 'A', starRating: 5, reviewText: 'Great' })],
      responses: [makeGenerationResult({ responseText: 'Thanks!' })],
    });
    const [row] = await sql<{
      generation_status: string;
      reviews_snapshot: unknown;
      generated_responses: unknown;
    }[]>`
      SELECT generation_status, reviews_snapshot, generated_responses
      FROM prospect_demos WHERE id = ${id}
    `;
    expect(row?.generation_status).toBe('completed');
    // reviews_snapshot is JSONB; postgres.js may return it as object or string
    // depending on PgBouncer. Guard against both.
    const reviewsParsed = typeof row?.reviews_snapshot === 'string'
      ? JSON.parse(row.reviews_snapshot)
      : row?.reviews_snapshot;
    expect(Array.isArray(reviewsParsed)).toBe(true);
    const [outbox] = await sql<{ status: string }[]>`SELECT status FROM job_outbox WHERE id = ${outboxId}`;
    expect(outbox?.status).toBe('completed');
  });

  it('completeDemo handles outboxAttempt=undefined (legacy branch)', async () => {
    const id = await insertProspectDemo({ generation_status: 'running' });
    const outboxId = await insertOutboxRow();
    await completeDemo('prospect_demos', id, outboxId, undefined, {
      reviews: [makeReview({ reviewerName: 'A', starRating: 5, reviewText: 'Great' })],
      responses: [makeGenerationResult({ responseText: 'Thanks!' })],
    });
    const [row] = await sql<{ generation_status: string }[]>`
      SELECT generation_status FROM prospect_demos WHERE id = ${id}
    `;
    expect(row?.generation_status).toBe('completed');
    const [outbox] = await sql<{ status: string }[]>`SELECT status FROM job_outbox WHERE id = ${outboxId}`;
    expect(outbox?.status).toBe('completed');
  });

  it('failDemo writes error and status=failed', async () => {
    const id = await insertProspectDemo({ generation_status: 'running' });
    const outboxId = await insertOutboxRow();
    await failDemo('prospect_demos', id, outboxId, 0, new Error('SerpAPI down'));
    const [row] = await sql<{ generation_status: string; generation_error: string }[]>`
      SELECT generation_status, generation_error FROM prospect_demos WHERE id = ${id}
    `;
    expect(row?.generation_status).toBe('failed');
    expect(row?.generation_error).toBe('SerpAPI down');
    const [outbox] = await sql<{ status: string; last_error: string }[]>`
      SELECT status, last_error FROM job_outbox WHERE id = ${outboxId}
    `;
    expect(outbox?.status).toBe('failed');
    expect(outbox?.last_error).toBe('SerpAPI down');
  });

  // ── PR #2: 23505 race-loser recovery on onboarding_demos ─────────

  async function insertOnboardingUser(): Promise<{ userId: string; businessId: string }> {
    const userId = crypto.randomUUID();
    const businessId = crypto.randomUUID();
    const authId = crypto.randomUUID();
    const ownerEmail = `${SLUG_PREFIX}${Math.random().toString(36).slice(2, 8)}@test.invalid`;
    await sql`
      INSERT INTO businesses (id, name, owner_email, subscription_status)
      VALUES (${businessId}, 'Test Biz', ${ownerEmail}, 'pending_payment')
    `;
    await sql`
      INSERT INTO users (id, business_id, auth_id, email, role)
      VALUES (${userId}, ${businessId}, ${authId}, ${ownerEmail}, 'owner')
    `;
    return { userId, businessId };
  }

  async function insertOnboardingDemo(opts: {
    userId: string;
    businessId: string;
    generation_status: string;
    source?: string;
    completed_at?: Date | null;
  }): Promise<string> {
    const id = crypto.randomUUID();
    const correlationId = crypto.randomUUID();
    await sql`
      INSERT INTO onboarding_demos (
        id, user_id, business_id, business_name, generation_status,
        source, completed_at, correlation_id
      ) VALUES (
        ${id}, ${opts.userId}::uuid, ${opts.businessId}::uuid,
        'Test Biz', ${opts.generation_status},
        ${opts.source ?? null}, ${opts.completed_at ?? null},
        ${correlationId}::uuid
      )
    `;
    return id;
  }

  it('completeDemo on onboarding_demos: 23505 race loser archives self + closes outbox', async () => {
    const { userId, businessId } = await insertOnboardingUser();
    try {
      // Winner already completed (occupies the partial unique index slot).
      const winnerId = await insertOnboardingDemo({
        userId,
        businessId,
        generation_status: 'completed',
        source: 'serpapi',
        completed_at: new Date(Date.now() - 60_000),
      });
      // Loser is mid-flight (running) and was created LATER than the winner.
      // completeDemo should trip 23505 then recover by archiving + closing
      // the outbox.
      const loserId = await insertOnboardingDemo({
        userId,
        businessId,
        generation_status: 'running',
      });
      const outboxId = await insertOutboxRow();

      await completeDemo('onboarding_demos', loserId, outboxId, 0, {
        reviews: [makeReview({ reviewerName: 'X', starRating: 5, reviewText: 'Hi' })],
        responses: [makeGenerationResult({ responseText: 'Thanks' })],
        source: 'serpapi',
      });

      const [loserRow] = await sql<{ generation_status: string }[]>`
        SELECT generation_status FROM onboarding_demos WHERE id = ${loserId}
      `;
      expect(loserRow?.generation_status).toBe('archived');

      const [outbox] = await sql<{ status: string }[]>`
        SELECT status FROM job_outbox WHERE id = ${outboxId}
      `;
      expect(outbox?.status).toBe('completed');

      // Page-level read invariant: the latest non-archived row for this user
      // must be the WINNER, not the archived loser. /onboarding/demo and
      // /api/onboarding/demo/status both filter `generation_status <> 'archived'`
      // for exactly this reason; this test exercises the same predicate.
      const [latestVisible] = await sql<{ id: string; generation_status: string }[]>`
        SELECT id, generation_status
        FROM onboarding_demos
        WHERE user_id = ${userId}::uuid
          AND generation_status <> 'archived'
        ORDER BY created_at DESC
        LIMIT 1
      `;
      expect(latestVisible?.id).toBe(winnerId);
      expect(latestVisible?.generation_status).toBe('completed');
    } finally {
      await sql`DELETE FROM onboarding_demos WHERE user_id = ${userId}::uuid`;
      await sql`DELETE FROM users WHERE id = ${userId}::uuid`;
      await sql`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
    }
  });

  it('failDemo handles outboxAttempt=undefined (legacy branch)', async () => {
    const id = await insertProspectDemo({ generation_status: 'running' });
    const outboxId = await insertOutboxRow();
    await failDemo('prospect_demos', id, outboxId, undefined, new Error('Place ID resolution failed'));
    const [row] = await sql<{ generation_status: string; generation_error: string }[]>`
      SELECT generation_status, generation_error FROM prospect_demos WHERE id = ${id}
    `;
    expect(row?.generation_status).toBe('failed');
    expect(row?.generation_error).toBe('Place ID resolution failed');
    const [outbox] = await sql<{ status: string; last_error: string }[]>`
      SELECT status, last_error FROM job_outbox WHERE id = ${outboxId}
    `;
    expect(outbox?.status).toBe('failed');
    expect(outbox?.last_error).toBe('Place ID resolution failed');
  });
});
