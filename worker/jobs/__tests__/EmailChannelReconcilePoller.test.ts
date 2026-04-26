// worker/jobs/__tests__/EmailChannelReconcilePoller.test.ts
//
// Reconciliation poller for the durable channel_enrollments retry path.
// Critical invariants tested:
//   - Active business missing an email channel → INSERT one (the happy path)
//   - Active business with an existing verified email channel → no INSERT
//   - Active business with an ARCHIVED email channel → no INSERT
//     (B16 finding #4 — the previous query treated archived rows as missing,
//      which would silently resubscribe an intentionally unsubscribed owner)
//   - INSERT ON CONFLICT is honored — second-runner observation logs no INSERT

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlQueue, sqlCalls, consume, mockLog, mockError } = vi.hoisted(() => {
  const sqlQueue: unknown[] = [];
  const sqlCalls: Array<{ template: string; values: unknown[] }> = [];
  const consume = vi.fn(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      sqlCalls.push({ template: strings.join('?'), values });
      const next = sqlQueue.shift();
      // Postgres.js returns an array with .count attached.
      if (Array.isArray(next)) {
        const arr = [...next] as unknown[] & { count?: number };
        Object.defineProperty(arr, 'count', {
          value: (next as { count?: number }).count ?? next.length,
          enumerable: false,
        });
        return Promise.resolve(arr);
      }
      const empty = [] as unknown[] & { count?: number };
      Object.defineProperty(empty, 'count', { value: 0, enumerable: false });
      return Promise.resolve(empty);
    },
  );
  return {
    sqlQueue,
    sqlCalls,
    consume,
    mockLog: vi.fn(),
    mockError: vi.fn(),
  };
});

vi.mock('@/lib/db/server', () => ({
  sql: consume,
}));

vi.mock('@/lib/shared/logger', () => ({
  createWorkerLogger: () => ({
    log: mockLog,
    warn: vi.fn(),
    error: mockError,
  }),
}));

import { runOnce } from '../EmailChannelReconcilePoller';

beforeEach(() => {
  sqlQueue.length = 0;
  sqlCalls.length = 0;
  consume.mockClear();
  mockLog.mockClear();
  mockError.mockClear();
  delete process.env.EMAIL_CHANNEL_RECONCILE_BATCH_SIZE;
});

describe('EmailChannelReconcilePoller — runOnce', () => {
  it('candidate query EXCLUDES archived rows (NOT EXISTS without archived_at filter)', async () => {
    sqlQueue.push([]); // empty candidate set is fine for template assertion
    await runOnce();

    const candidatesCall = sqlCalls[0];
    expect(candidatesCall).toBeDefined();
    // Strip SQL line comments (-- ...) before regex matching — the human-
    // readable comment inside the NOT EXISTS block contains the word
    // "archived_at" intentionally, but it's not executed SQL.
    const text = candidatesCall!.template.replace(/--[^\n]*/g, '');

    // Critical regression guard from B16 finding #4 (refined as B17 #4):
    // The NOT EXISTS subquery must NOT filter on archived_at IS NULL —
    // otherwise an archived row would still appear "missing" and we'd
    // recreate it, silently resubscribing an unsubscribed owner.
    const notExistsBlock = text.match(/NOT EXISTS\s*\([\s\S]*?\)/);
    expect(notExistsBlock).not.toBeNull();
    expect(notExistsBlock![0]).not.toMatch(/archived_at/);

    // Defense-in-depth: confirm we DO filter on subscription_status='active'.
    expect(text).toMatch(/subscription_status\s*=\s*'active'/);
    expect(text).toMatch(/role\s*=\s*'owner'/);
    expect(text).toMatch(/auth_id\s+IS\s+NOT\s+NULL/);
  });

  it('active business with NO email enrollment → INSERTs verified row', async () => {
    sqlQueue.push([
      { business_id: 'biz-1', owner_email: 'owner@example.com' },
    ]); // candidates
    sqlQueue.push(Object.assign([], { count: 1 })); // INSERT — count=1 means landed

    const result = await runOnce();

    expect(result.candidates).toBe(1);
    expect(result.inserted).toBe(1);
    expect(result.failed).toBe(0);

    const insertCall = sqlCalls.find((c) =>
      c.template.includes('INSERT INTO channel_enrollments'),
    );
    expect(insertCall).toBeDefined();
    expect(insertCall!.template).toContain("'email'");
    expect(insertCall!.template).toContain("'verified'");
    // Idempotent partial-unique target — required for concurrent reconcile-
    // poller / verify-otp INSERT racing the same row.
    expect(insertCall!.template).toContain(
      'ON CONFLICT (business_id, channel) WHERE archived_at IS NULL DO NOTHING',
    );
    expect(insertCall!.values).toContain('biz-1');
    expect(insertCall!.values).toContain('owner@example.com');
  });

  it('active business with EXISTING active email enrollment → query yields 0 candidates, no INSERT', async () => {
    // The candidate query's NOT EXISTS rules out businesses with any email
    // enrollment row. Empty result simulates the production happy state.
    sqlQueue.push([]);

    const result = await runOnce();

    expect(result.candidates).toBe(0);
    expect(result.inserted).toBe(0);

    const insertCall = sqlCalls.find((c) =>
      c.template.includes('INSERT INTO channel_enrollments'),
    );
    expect(insertCall).toBeUndefined();
  });

  it('active business with ARCHIVED email enrollment → still excluded (no resubscribe)', async () => {
    // The candidate query's NOT EXISTS does NOT scope to archived_at IS NULL,
    // so archived rows still satisfy the EXISTS check and the business is
    // EXCLUDED from the candidates list. This is the regression guard for
    // B16 finding #4. Empty result here simulates that exclusion working.
    sqlQueue.push([]);

    const result = await runOnce();

    expect(result.candidates).toBe(0);
    expect(result.inserted).toBe(0);

    // Anti-regression: the SQL template must NOT scope its EXISTS to
    // archived_at IS NULL. (We assert the template shape in test #1 above
    // but pin it here too because this is the exact bug class — if a
    // refactor adds the filter back, this test catches it.)
    const candidatesCall = sqlCalls[0];
    expect(candidatesCall).toBeDefined();
    const stripped = candidatesCall!.template.replace(/--[^\n]*/g, '');
    const notExistsBlock = stripped.match(/NOT EXISTS\s*\([\s\S]*?\)/);
    expect(notExistsBlock).not.toBeNull();
    expect(notExistsBlock![0]).not.toMatch(/archived_at/);
  });

  it('INSERT race: ON CONFLICT returns 0 rows → counted as not-inserted (no double-count)', async () => {
    sqlQueue.push([
      { business_id: 'biz-2', owner_email: 'owner2@example.com' },
    ]);
    // Race: a sibling writer (verify-otp) inserted the row first. Our
    // INSERT ... ON CONFLICT DO NOTHING returns count=0.
    sqlQueue.push(Object.assign([], { count: 0 }));

    const result = await runOnce();

    expect(result.candidates).toBe(1);
    expect(result.inserted).toBe(0); // not counted as inserted
    expect(result.failed).toBe(0); // not an error either — race was benign
  });

  it('INSERT throws → counted as failed, loop continues to next candidate', async () => {
    sqlQueue.push([
      { business_id: 'biz-3', owner_email: 'owner3@example.com' },
      { business_id: 'biz-4', owner_email: 'owner4@example.com' },
    ]);
    // First INSERT throws (transient db error)
    consume.mockImplementationOnce((strings: TemplateStringsArray) => {
      sqlCalls.push({ template: strings.join('?'), values: [] });
      const next = sqlQueue.shift();
      if (Array.isArray(next)) {
        const arr = [...next] as unknown[] & { count?: number };
        Object.defineProperty(arr, 'count', {
          value: arr.length,
          enumerable: false,
        });
        return Promise.resolve(arr);
      }
      return Promise.resolve([]);
    });
    // Override the SECOND call (the candidates query) to return our list,
    // then the THIRD (first INSERT) to reject.
    consume
      .mockImplementationOnce((strings: TemplateStringsArray) => {
        sqlCalls.push({ template: strings.join('?'), values: [] });
        return Promise.reject(new Error('transient'));
      })
      .mockImplementationOnce((strings: TemplateStringsArray) => {
        sqlCalls.push({ template: strings.join('?'), values: [] });
        const arr = [] as unknown[] & { count?: number };
        Object.defineProperty(arr, 'count', { value: 1, enumerable: false });
        return Promise.resolve(arr);
      });

    const result = await runOnce();

    expect(result.candidates).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.inserted).toBe(1); // second candidate succeeded
    expect(mockError).toHaveBeenCalled();
  });
});
