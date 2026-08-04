import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';

const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql } = await vi.hoisted(async () => {
  const { createMockSql } = await import('../../../../worker/__tests__/helpers/mock-sql');
  return { ...createMockSql() };
});

import { getAdminDemos } from '../demos-service';

describe('getAdminDemos', () => {
  it('maps rows to DemoListItem, converting both timestamps to ISO strings', async () => {
    resetMockSql();
    sqlReturnQueue.push([
      {
        id: 'demo-1',
        demo_url_slug: 'bella-italia-abc123',
        business_name: 'Bella Italia',
        generation_status: 'completed',
        generation_error: null,
        view_count: 4,
        // Real Dates, exactly what Postgres.js decodes timestamptz into. The
        // RSC boundary preserves Date instances, so a DTO field typed `string`
        // holding a Date breaks the server page on first paint.
        generated_at: new Date('2026-08-01T12:30:00.000Z'),
        expires_at: new Date('2026-09-01T12:30:00.000Z'),
      },
      {
        id: 'demo-2',
        demo_url_slug: 'failed-shop-xyz789',
        business_name: 'Failed Shop',
        generation_status: 'failed',
        generation_error: 'SerpAPI returned no reviews',
        view_count: 0,
        generated_at: new Date('2026-07-30T09:00:00.000Z'),
        expires_at: new Date('2026-08-30T09:00:00.000Z'),
      },
    ]);

    const demos = await getAdminDemos(mockSql as unknown as Sql);

    expect(demos).toEqual([
      {
        id: 'demo-1',
        slug: 'bella-italia-abc123',
        businessName: 'Bella Italia',
        generationStatus: 'completed',
        generationError: null,
        viewCount: 4,
        createdAt: '2026-08-01T12:30:00.000Z',
        expiresAt: '2026-09-01T12:30:00.000Z',
      },
      {
        id: 'demo-2',
        slug: 'failed-shop-xyz789',
        businessName: 'Failed Shop',
        generationStatus: 'failed',
        generationError: 'SerpAPI returned no reviews',
        viewCount: 0,
        createdAt: '2026-07-30T09:00:00.000Z',
        expiresAt: '2026-08-30T09:00:00.000Z',
      },
    ]);

    // The trap guard: `toEqual` above would also pass for a Date whose ISO
    // string matches, so assert the runtime type explicitly.
    expect(typeof demos[0]!.createdAt).toBe('string');
    expect(typeof demos[0]!.expiresAt).toBe('string');

    expect(sqlCalls[0]!.text).toContain('FROM prospect_demos');
    expect(sqlCalls[0]!.text).toContain('ORDER BY generated_at DESC');
    expect(sqlCalls[0]!.values).toEqual([]);
  });

  it('returns an empty array for empty results', async () => {
    resetMockSql();
    sqlReturnQueue.push([]);

    expect(await getAdminDemos(mockSql as unknown as Sql)).toEqual([]);
  });
});
