import { describe, expect, it, vi } from 'vitest';

import {
  enqueueAccountOffboardingEmail,
  enqueueAccountOffboardingReactivation,
} from '../outbox';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';

function createMockTx() {
  const tx = vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => Promise.resolve([])) as any;
  // Stand-in for Postgres.js's tx.json(value) (the injected JSONB bind these
  // enqueue helpers use in place of the composition-root `jsonb()` helper) —
  // identity pass-through so the raw payload object is inspectable via objectArgs.
  tx.json = vi.fn((value: unknown) => value);
  return tx;
}

function sqlText(call: unknown[]): string {
  return (
    (call[0] as TemplateStringsArray)
      .join('?')
      // SQL line comments (the audit's trailing `-- topic-audit-ignore`
      // pragma) are lexer trivia to Postgres — strip them BEFORE collapsing
      // whitespace so the byte-for-byte predicate assertions compare the
      // expression Postgres actually parses.
      .replace(/--[^\n]*/g, '')
      .replace(/\s+/g, ' ')
  );
}

function objectArgs(tx: ReturnType<typeof createMockTx>): Record<string, unknown>[] {
  return tx.mock.calls
    .flat()
    .filter(
      (arg: unknown): arg is Record<string, unknown> =>
        !!arg && typeof arg === 'object' && !Array.isArray(arg),
    );
}

describe('account offboarding outbox helpers', () => {
  it('dedupes account offboarding email outbox rows by offboarding id and email type', async () => {
    const tx = createMockTx();

    const first = await enqueueAccountOffboardingEmail(tx, {
      accountOffboardingId: 'offboarding-1',
      accountId: 'account-1',
      idempotencyKeyHash: 'idem-hash-1',
      correlationId: 'corr-1',
      emailType: 'delete_data_confirmation',
    });
    const second = await enqueueAccountOffboardingEmail(tx, {
      accountOffboardingId: 'offboarding-1',
      accountId: 'account-1',
      emailType: 'delete_data_confirmation',
    });
    const differentType = await enqueueAccountOffboardingEmail(tx, {
      accountOffboardingId: 'offboarding-1',
      accountId: 'account-1',
      emailType: 'keep_my_data_confirmation',
    });

    expect(first).toBe(second);
    expect(differentType).not.toBe(first);
    expect(tx).toHaveBeenCalledTimes(3);
    for (const call of tx.mock.calls) {
      expect(sqlText(call)).toContain('ON CONFLICT (id) DO NOTHING');
      expect(call).toContain(QUEUE_NAMES.ACCOUNT_OFFBOARDING_EMAIL);
    }
    const payloads = objectArgs(tx).filter((arg) => arg.account_offboarding_id === 'offboarding-1');
    expect(payloads).toContainEqual({
      account_offboarding_id: 'offboarding-1',
      account_id: 'account-1',
      email_type: 'delete_data_confirmation',
      idempotency_key_hash: 'idem-hash-1',
      correlation_id: 'corr-1',
    });
    expect(payloads).toContainEqual({
      account_offboarding_id: 'offboarding-1',
      account_id: 'account-1',
      email_type: 'keep_my_data_confirmation',
    });
  });

  it('dedupes account offboarding reactivation outbox rows by offboarding id and idempotency hash', async () => {
    const tx = createMockTx();

    const first = await enqueueAccountOffboardingReactivation(tx, {
      accountOffboardingId: 'offboarding-1',
      accountId: 'account-1',
      actorUserId: 'user-1',
      idempotencyKeyHash: 'idem-hash-1',
      requestId: 'req-1',
      ip: '203.0.113.10',
      userAgent: 'vitest',
      correlationId: 'req-1',
    });
    const second = await enqueueAccountOffboardingReactivation(tx, {
      accountOffboardingId: 'offboarding-1',
      accountId: 'account-1',
      actorUserId: 'user-1',
      idempotencyKeyHash: 'idem-hash-1',
    });

    expect(first).toBe(second);
    expect(tx).toHaveBeenCalledTimes(2);
    for (const call of tx.mock.calls) {
      expect(sqlText(call)).toContain('ON CONFLICT (id) DO NOTHING');
      expect(call).toContain(QUEUE_NAMES.ACCOUNT_OFFBOARDING_REACTIVATION);
    }
    const payloads = objectArgs(tx).filter((arg) => arg.account_offboarding_id === 'offboarding-1');
    expect(payloads).toContainEqual({
      account_offboarding_id: 'offboarding-1',
      account_id: 'account-1',
      actor_user_id: 'user-1',
      idempotency_key_hash: 'idem-hash-1',
      request_id: 'req-1',
      ip: '203.0.113.10',
      user_agent: 'vitest',
      correlation_id: 'req-1',
    });
    expect(payloads).toContainEqual({
      account_offboarding_id: 'offboarding-1',
      account_id: 'account-1',
      actor_user_id: 'user-1',
      idempotency_key_hash: 'idem-hash-1',
    });
  });
});
