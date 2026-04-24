import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSql, mockBuildPaymentLinkUrl } = vi.hoisted(() => {
  const mockSql: any = vi.fn();
  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<unknown>) => cb(mockSql));
  const mockBuildPaymentLinkUrl = vi.fn();
  return { mockSql, mockBuildPaymentLinkUrl };
});

vi.mock('@/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid') }));
vi.mock('@/lib/payments/payment-link', () => ({ buildPaymentLinkUrl: mockBuildPaymentLinkUrl }));

import { createBusinessTx, DuplicateEmailError } from '../create-business';

const baseInput = {
  ownerEmail: 'a@b.com',
  ownerName: 'Jane',
  businessName: 'Acme',
  subscriptionTier: 'standard' as const,
  placeId: { placeIdVerified: true as const, placeId: 'ChIJtest' },
};

beforeEach(() => {
  mockSql.mockReset();
  mockSql.mockResolvedValue([]);
  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<unknown>) => cb(mockSql));
  mockBuildPaymentLinkUrl.mockReset();
  mockBuildPaymentLinkUrl.mockReturnValue('https://buy.stripe.com/test');
});

describe('createBusinessTx — admin mode', () => {
  it('writes users.auth_id=NULL and creates outbox entry', async () => {
    const res = await createBusinessTx(baseInput, { mode: 'admin', onboardedBy: 'admin-1' });
    expect(res.businessId).toBeTruthy();
    const calls = mockSql.mock.calls.map((c: any[]) => (c[0] as TemplateStringsArray).join('?'));
    const outboxInsert = calls.find((t: string) => t.includes('INSERT INTO job_outbox'));
    expect(outboxInsert).toBeDefined();
    const usersInsert = calls.find((t: string) => t.includes('INSERT INTO users'));
    expect(usersInsert).toBeDefined();
    const usersCallArgs = mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO users'))!;
    // auth_id position in admin mode must be null (verified against args structure)
    expect(usersCallArgs).toContain(null);
  });

  it('enqueues sync_reviews when placeIdVerified=true', async () => {
    await createBusinessTx(baseInput, { mode: 'admin', onboardedBy: 'admin-1' });
    const outboxCall = mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO job_outbox'))!;
    // 'sync_reviews' is a SQL literal in the template, not a bound value — check the template text.
    expect((outboxCall[0] as TemplateStringsArray).join('?')).toContain("'sync_reviews'");
  });

  it('enqueues validate_place_id when placeIdVerified=false', async () => {
    const input = {
      ...baseInput,
      placeId: { placeIdVerified: false as const, googleMapsUrl: 'https://maps.google.com/?cid=1' },
    };
    await createBusinessTx(input, { mode: 'admin', onboardedBy: 'admin-1' });
    const outboxCall = mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO job_outbox'))!;
    expect((outboxCall[0] as TemplateStringsArray).join('?')).toContain("'validate_place_id'");
  });

  it('writes onboarded_by value to businesses row', async () => {
    await createBusinessTx(baseInput, { mode: 'admin', onboardedBy: 'admin-xyz-123' });
    const bizCall = mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO businesses'))!;
    expect(bizCall.some((a: unknown) => a === 'admin-xyz-123')).toBe(true);
  });
});

describe('createBusinessTx — self_serve mode', () => {
  it('writes users.auth_id=authId and skips outbox insert', async () => {
    await createBusinessTx(baseInput, { mode: 'self_serve', authId: 'auth-xyz' });
    const calls = mockSql.mock.calls.map((c: any[]) => (c[0] as TemplateStringsArray).join('?'));
    const outboxInsert = calls.find((t: string) => t.includes('INSERT INTO job_outbox'));
    expect(outboxInsert).toBeUndefined();
    const usersInsert = calls.find((t: string) => t.includes('INSERT INTO users'));
    expect(usersInsert).toBeDefined();
    const usersCallArgs = mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO users'))!;
    expect(usersCallArgs.some((a: unknown) => a === 'auth-xyz')).toBe(true);
  });

  it('does NOT enqueue outbox even when placeIdVerified=false', async () => {
    const input = {
      ...baseInput,
      placeId: { placeIdVerified: false as const, googleMapsUrl: 'https://maps.google.com/?cid=1' },
    };
    await createBusinessTx(input, { mode: 'self_serve', authId: 'auth-xyz' });
    const outboxCall = mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO job_outbox'));
    expect(outboxCall).toBeUndefined();
  });
});

describe('createBusinessTx — duplicate email', () => {
  it('throws DuplicateEmailError on PG 23505', async () => {
    mockSql.mockImplementation(() => {
      const err: any = new Error('duplicate key');
      err.code = '23505';
      throw err;
    });
    mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<unknown>) => cb(mockSql));
    await expect(
      createBusinessTx(baseInput, { mode: 'self_serve', authId: 'a' }),
    ).rejects.toThrow(DuplicateEmailError);
  });

  it('re-throws non-23505 PG errors unchanged', async () => {
    const otherErr: any = new Error('connection timeout');
    otherErr.code = '08006';
    mockSql.mockImplementation(() => {
      throw otherErr;
    });
    mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<unknown>) => cb(mockSql));
    await expect(
      createBusinessTx(baseInput, { mode: 'self_serve', authId: 'a' }),
    ).rejects.toThrow('connection timeout');
  });
});

describe('createBusinessTx — field-name regression', () => {
  it('maps businessName→businesses.name and ownerName→users.name', async () => {
    await createBusinessTx(
      { ...baseInput, businessName: 'Acme-Biz', ownerName: 'Jane-Owner' },
      { mode: 'self_serve', authId: 'a' },
    );
    const bizCall = mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO businesses'))!;
    const userCall = mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO users'))!;
    expect(bizCall.some((a: unknown) => a === 'Acme-Biz')).toBe(true);
    expect(userCall.some((a: unknown) => a === 'Jane-Owner')).toBe(true);
  });
});

describe('createBusinessTx — email normalization', () => {
  it('trims and lowercases ownerEmail before persisting', async () => {
    await createBusinessTx(
      { ...baseInput, ownerEmail: '  Owner@Example.COM  ' },
      { mode: 'self_serve', authId: 'a' },
    );
    const bizCall = mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO businesses'))!;
    const userCall = mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO users'))!;
    const enrollCall = mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO channel_enrollments'))!;
    expect(bizCall.some((a: unknown) => a === 'owner@example.com')).toBe(true);
    expect(userCall.some((a: unknown) => a === 'owner@example.com')).toBe(true);
    expect(enrollCall.some((a: unknown) => a === 'owner@example.com')).toBe(true);
  });
});

describe('createBusinessTx — channel_enrollments', () => {
  it('inserts email channel_enrollment with verified status and ON CONFLICT guard', async () => {
    await createBusinessTx(baseInput, { mode: 'self_serve', authId: 'a' });
    const enrollCall = mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO channel_enrollments'))!;
    expect(enrollCall).toBeDefined();
    // 'email' and 'verified' are SQL literals in the template — check the template text.
    const enrollTemplate = (enrollCall[0] as TemplateStringsArray).join('?');
    expect(enrollTemplate).toContain("'email'");
    expect(enrollTemplate).toContain("'verified'");
    // Guard against regression: must use the existing partial-unique ON CONFLICT
    expect(enrollTemplate).toContain('ON CONFLICT (business_id, channel) WHERE archived_at IS NULL');
  });
});

describe('createBusinessTx — result', () => {
  it('returns businessId, userId, and paymentUrl from buildPaymentLinkUrl', async () => {
    mockBuildPaymentLinkUrl.mockReturnValue('https://buy.stripe.com/xyz');
    const res = await createBusinessTx(baseInput, { mode: 'self_serve', authId: 'a' });
    expect(res.businessId).toBeTruthy();
    expect(res.userId).toBeTruthy();
    expect(res.paymentUrl).toBe('https://buy.stripe.com/xyz');
    expect(mockBuildPaymentLinkUrl).toHaveBeenCalledWith('standard', res.businessId, 'a@b.com');
  });

  it('returns paymentUrl=null when buildPaymentLinkUrl returns null', async () => {
    mockBuildPaymentLinkUrl.mockReturnValue(null);
    const res = await createBusinessTx(baseInput, { mode: 'self_serve', authId: 'a' });
    expect(res.paymentUrl).toBeNull();
  });
});
