import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { Sql } from 'postgres';
import type { StripeSubscriptionMirrorSyncPayload } from '../../../../src/lib/shared/worker-types';

const { mockMarkOutboxCompleted, events } = vi.hoisted(() => ({
  mockMarkOutboxCompleted: vi.fn(async (..._args: unknown[]) => undefined),
  events: [] as string[],
}));

vi.mock('../../../../src/lib/shared/outbox', () => ({
  extractOutboxHandle: (data: StripeSubscriptionMirrorSyncPayload, fallback: string) => ({
    outboxId: data.outbox_id ?? fallback,
    attempt: data.outbox_attempt,
  }),
  markOutboxCompleted: (...args: unknown[]) => {
    events.push('complete');
    return mockMarkOutboxCompleted(args[0], args[1], args[2]);
  },
}));

import { handleStripeSubscriptionMirrorSync } from '../StripeSubscriptionMirrorSyncWorker';

const ACCOUNT_ID = '019dc366-29ce-7000-a000-000000000001';

function job(): Job<StripeSubscriptionMirrorSyncPayload> {
  return {
    id: 'outbox-fallback',
    data: {
      account_id: ACCOUNT_ID,
      outbox_id: 'outbox-1',
      outbox_attempt: 2,
    },
  } as Job<StripeSubscriptionMirrorSyncPayload>;
}

function harness(results: unknown[]) {
  const calls: { text: string; values: unknown[] }[] = [];
  const tx = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = Array.from(strings).join('?');
    calls.push({ text, values });
    events.push(text.replace(/\s+/g, ' ').trim());
    const next = results.shift();
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next ?? []);
  });
  const sql = Object.assign(tx, {
    begin: vi.fn(async (callback: (inner: typeof tx) => Promise<void>) => callback(tx)),
  }) as unknown as Sql;
  return { sql, tx, calls, results };
}

beforeEach(() => {
  mockMarkOutboxCompleted.mockClear();
  events.length = 0;
});

describe('StripeSubscriptionMirrorSyncWorker', () => {
  it('locks every business before entitlement, reads canonical state, then mirrors active', async () => {
    const activatedAt = new Date('2026-07-15T00:00:00Z');
    const h = harness([
      [{ id: 'biz-1' }, { id: 'biz-2' }],
      [],
      [{ subscription_status: 'active', subscription_activated_at: activatedAt }],
      Object.assign([], { count: 1 }),
    ]);

    await handleStripeSubscriptionMirrorSync(h.sql, job());

    expect(h.calls).toHaveLength(4);
    expect(h.calls[0]!.text).toMatch(/FROM businesses[\s\S]*ORDER BY id[\s\S]*FOR UPDATE/);
    expect(h.calls[1]!.text).toContain('pg_advisory_xact_lock');
    expect(h.calls[2]!.text).toMatch(/FROM accounts/);
    expect(h.calls[2]!.text).not.toMatch(/FOR UPDATE/);
    expect(h.calls[3]!.text).toMatch(/UPDATE businesses/);
    expect(h.calls[3]!.text).toMatch(/subscription_activated_at\s*=\s*COALESCE/);
    expect(h.calls[3]!.text).toMatch(/is_primary\s*=\s*TRUE/);
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(h.tx, 'outbox-1', 2);
    expect(events.at(-1)).toBe('complete');
    expect(h.results).toHaveLength(0);
  });

  it('mirrors past_due to all locations without changing activation time', async () => {
    const h = harness([
      [{ id: 'biz-1' }],
      [],
      [{ subscription_status: 'past_due', subscription_activated_at: null }],
      Object.assign([], { count: 1 }),
    ]);

    await handleStripeSubscriptionMirrorSync(h.sql, job());

    expect(h.calls).toHaveLength(4);
    expect(h.calls[3]!.text).not.toMatch(/subscription_activated_at/);
    expect(h.calls[3]!.text).not.toMatch(/is_primary/);
    expect(mockMarkOutboxCompleted).toHaveBeenCalledTimes(1);
    expect(h.results).toHaveLength(0);
  });

  it('completes when the account is gone and performs no mirror update', async () => {
    const h = harness([[], [], []]);

    await handleStripeSubscriptionMirrorSync(h.sql, job());

    expect(h.calls).toHaveLength(3);
    expect(h.calls.some((call) => /UPDATE businesses/.test(call.text))).toBe(false);
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(h.tx, 'outbox-1', 2);
    expect(h.results).toHaveLength(0);
  });

  it('throws transient database failures and leaves the outbox incomplete', async () => {
    const h = harness([
      [{ id: 'biz-1' }],
      [],
      [{ subscription_status: 'cancelled', subscription_activated_at: null }],
      new Error('connection terminated'),
    ]);

    await expect(handleStripeSubscriptionMirrorSync(h.sql, job())).rejects.toThrow(
      'connection terminated',
    );

    expect(h.calls).toHaveLength(4);
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
    expect(h.results).toHaveLength(0);
  });
});
