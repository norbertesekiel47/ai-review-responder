import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from '@/lib/db/server';
import { claimDemo, completeDemo, failDemo } from '../lifecycle';

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
      reviews: [
        {
          reviewerName: 'A',
          starRating: 5,
          reviewText: 'Great',
          reviewDate: '2026-01-01T00:00:00Z',
          detectedLanguage: 'en',
        } as never,
      ],
      responses: [
        {
          responseText: 'Thanks!',
          costUsd: 0.01,
          modelUsed: 'test',
          tokensUsed: 10,
          latencyMs: 100,
        } as never,
      ],
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
});
