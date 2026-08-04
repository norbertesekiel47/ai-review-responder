import { randomUUID } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql, mkTaggedResult } = await vi.hoisted(
  async () => {
    const helpers = await import('../../../../worker/__tests__/helpers/mock-sql');
    return { ...helpers.createMockSql(), mkTaggedResult: helpers.mkTaggedResult };
  },
);

import { lookupSuppressions, recordAdminManualSuppression } from '../suppressions-service';

// Unit suite for the admin-owned Suppression ledger paths (#645; locked spec
// docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md §7.3).
// `../suppressions-service` does not exist until Task 4, so this file is red at
// import time — the intended state of the eval task.
//
// Scope split, deliberately: this file owns what a fake `sql` can prove — the
// Normalized handle is normalized before it is ever bound, and the row the
// admin path writes is a `global` / `admin_manual` one carrying its actor and
// its required note. Everything that depends on the real partial unique
// indexes (first-write-wins, the Correction path's single-statement atomicity)
// belongs in suppressions-correction.integration.test.ts and cannot be faked
// here.

const ADMIN_ID = '22222222-2222-4222-8222-222222222222';

describe('recordAdminManualSuppression (§7.3 admin manual entry)', () => {
  beforeEach(() => {
    resetMockSql();
  });

  it('records a global admin_manual row with created_by_user_id and the required note', async () => {
    // The INSERT reports one written row, then recordSuppression enqueues its
    // §9.4 analytics event in the same transaction.
    sqlReturnQueue.push(mkTaggedResult([{ id: randomUUID() }]), mkTaggedResult([]));

    const result = await recordAdminManualSuppression(
      mockSql as unknown as TransactionSql,
      {
        rawEmail: '  Person@Example.COM  ',
        adminUserId: ADMIN_ID,
        note: 'forwarded mailbox reply 2026-08-03',
      },
    );

    // The Normalized handle is lowercased and trimmed before it is bound —
    // a raw address never reaches the ledger.
    expect(result).toEqual({ ok: true, created: true, handle: 'person@example.com' });

    const insert = sqlCalls[0]!;
    expect(insert.text).toContain('INSERT INTO solicitation_suppressions');
    // Suppression scope and source are SQL literals in the writer, so they are
    // asserted on the text; everything else is a bound value.
    expect(insert.text).toContain('\'global\'');
    expect(insert.text).toContain(
      'ON CONFLICT (channel, normalized_handle) WHERE scope = \'global\'',
    );
    expect(insert.values).toContain('person@example.com');
    expect(insert.values).toContain('email');
    expect(insert.values).toContain('admin_manual');
    // §7.3 requires both: an actor and the originating message reference. A
    // global admin row without them is not auditable ten business days later.
    expect(insert.values).toContain(ADMIN_ID);
    expect(insert.values).toContain('forwarded mailbox reply 2026-08-03');
    // account_id is deliberately null: a mailbox reply names no account, and
    // guessing one would write false provenance into a compliance record.
    expect(insert.values).toContain(null);
    // The raw, un-normalized input is never bound anywhere.
    expect(insert.values).not.toContain('  Person@Example.COM  ');
  });

  it('rejects an address that fails normalizeEmail instead of minting a wrong handle', async () => {
    const result = await recordAdminManualSuppression(
      mockSql as unknown as TransactionSql,
      { rawEmail: 'not an email', adminUserId: ADMIN_ID, note: 'ref #1' },
    );

    expect(result).toEqual({ ok: false, error: 'invalid_handle' });
    // No INSERT was attempted. A ledger row keyed on a handle nothing will ever
    // match is worse than a rejected entry: it reads as an opt-out on record
    // while suppressing nobody.
    expect(sqlCalls).toHaveLength(0);
  });

  it('lookupSuppressions rejects an invalid email without issuing either cross-tenant query', async () => {
    // A `sql` that throws if it is touched at all: the admin lookup reads
    // across every tenant, so an unnormalizable input must be refused BEFORE
    // any query is issued, not filtered out of the results afterwards.
    const throwingSql = (() => {
      throw new Error('lookupSuppressions must not query on an invalid handle');
    }) as unknown as Sql;

    await expect(lookupSuppressions(throwingSql, 'not an email'))
      .resolves.toEqual({ ok: false, error: 'invalid_handle' });
  });
});
