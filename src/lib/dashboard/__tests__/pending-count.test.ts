import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSqlResults, sqlCallCounter, capturedSqlTexts } = vi.hoisted(() => ({
  mockSqlResults: [] as unknown[][],
  sqlCallCounter: { value: 0 },
  capturedSqlTexts: [] as string[],
}));

vi.mock('@/lib/db/server', () => ({
  sql: new Proxy(() => {}, {
    apply: (_t, _a, args: unknown[]) => {
      const first = args[0];
      if (first != null && typeof first === 'object' && 'raw' in (first as object)) {
        capturedSqlTexts.push((first as TemplateStringsArray).raw.join('?'));
      }
      const result = mockSqlResults[sqlCallCounter.value] ?? [];
      sqlCallCounter.value++;
      return Promise.resolve(result);
    },
  }),
}));

import { getPendingApprovalCount } from '../pending-count';

beforeEach(() => {
  mockSqlResults.length = 0;
  capturedSqlTexts.length = 0;
  sqlCallCounter.value = 0;
});

describe('getPendingApprovalCount', () => {
  it('returns the scalar count', async () => {
    mockSqlResults[0] = [{ count: 4 }];
    expect(await getPendingApprovalCount('biz-1')).toBe(4);
  });

  it('returns 0 when the query yields no row', async () => {
    mockSqlResults[0] = [];
    expect(await getPendingApprovalCount('biz-1')).toBe(0);
  });

  it('scopes by business_id, counts only pending_approval, and excludes open-flagged drafts', async () => {
    mockSqlResults[0] = [{ count: 0 }];
    await getPendingApprovalCount('biz-XYZ');
    const text = capturedSqlTexts[0]!;
    expect(text).toContain('business_id = ?');
    expect(text).toContain("status = 'pending_approval'");
    expect(text).toContain('NOT EXISTS');
    expect(text).toContain('flagged_responses');
    expect(text).toContain("fr.status = 'open'");
  });
});
