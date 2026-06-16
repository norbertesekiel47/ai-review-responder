import { describe, it, expect, vi, beforeEach } from 'vitest';

// F-5: belt-and-suspenders publisher moderation-hold gate. The helper wraps the
// shared hasOpenFlag check in a FOR-UPDATE-locked transaction so it serializes
// against the admin disposition that closes flags (hasOpenFlag's contract).

const { mockSql, mockHasOpenFlag, sqlCalls } = vi.hoisted(() => {
  const sqlCalls: string[] = [];
  const mockSql: {
    (strings: TemplateStringsArray, ...vals: unknown[]): Promise<unknown[]>;
    begin: ReturnType<typeof vi.fn>;
  } = Object.assign(
    vi.fn((strings: TemplateStringsArray) => {
      sqlCalls.push(strings.join('?'));
      return Promise.resolve([]);
    }),
    { begin: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockSql)) },
  );
  return { mockSql, mockHasOpenFlag: vi.fn(), sqlCalls };
});

vi.mock('../../../../src/lib/db/server', () => ({ sql: mockSql }));
vi.mock('../../../../src/lib/moderation/held-draft', () => ({ hasOpenFlag: mockHasOpenFlag }));

import { isHeldForModerationReview } from '../held-flag-gate';

describe('isHeldForModerationReview (F-5 publisher hold gate)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlCalls.length = 0;
  });

  it('returns true when an open moderation flag exists', async () => {
    mockHasOpenFlag.mockResolvedValue(true);
    await expect(isHeldForModerationReview('resp-1', 'biz-1')).resolves.toBe(true);
  });

  it('returns false when no open flag exists', async () => {
    mockHasOpenFlag.mockResolvedValue(false);
    await expect(isHeldForModerationReview('resp-1', 'biz-1')).resolves.toBe(false);
  });

  it('locks the business-scoped response row FOR UPDATE and delegates to hasOpenFlag in-tx', async () => {
    mockHasOpenFlag.mockResolvedValue(false);
    await isHeldForModerationReview('resp-1', 'biz-1');
    expect(mockSql.begin).toHaveBeenCalledOnce();
    expect(
      sqlCalls.some((q) => /FOR UPDATE/.test(q) && /responses/.test(q) && /business_id/.test(q)),
    ).toBe(true);
    expect(mockHasOpenFlag).toHaveBeenCalledWith(mockSql, 'resp-1');
  });
});
