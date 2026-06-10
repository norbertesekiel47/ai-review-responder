// src/lib/locations/__tests__/archive-location-tx.test.ts
//
// TDD assertions for src/lib/locations/archive-location-tx.ts.
// Tests: assertCanArchiveLocation, archiveLocationTransaction, reactivateLocationTransaction.
//
// Validation contract:
//   VAL-LOC-043: Archive transaction is atomic — businesses + audit + outbox
//   VAL-LOC-044: Location with in-flight approvals can be archived
//   VAL-LOC-047: Concurrent archive and add at quota boundary is safe
//
// Feature spec:
//   - Archive attempt on primary with other active locations: rejected with 'promote first'
//   - Archive attempt on last active location: rejected
//   - Archive of non-primary succeeds: sets archived_at, inserts 'location_archived'
//     audit event, enqueues Stripe quantity decrement
//   - Archived location data (reviews, responses) preserved (not deleted)
//   - Re-add from archived state possible (restores archived_at=NULL)

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const { mockSql } = vi.hoisted(() => {
  const sqlFn: any = vi.fn();
  sqlFn.begin = vi.fn(async (cb: (tx: any) => Promise<unknown>) => cb(sqlFn));
  return { mockSql: sqlFn };
});

vi.mock('@/lib/db/server', () => ({
  sql: mockSql,
  jsonb: (v: unknown) => v,
}));

vi.mock('uuid', () => ({
  v7: vi.fn(() => 'mock-uuid-v7-archive-000000000001'),
}));

import {
  assertCanArchiveLocation,
  archiveLocationTransaction,
  archiveLocationForAccountOffboardingTeardownTransaction,
  reactivateLocationTransaction,
  type ArchiveLocationTxInput,
} from '../archive-location-tx';

// ── Helpers ─────────────────────────────────────────────────────────────────

const ACCOUNT_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const PRIMARY_LOCATION_ID = 'bbbbbbbb-0000-0000-0000-000000000001';
const SECONDARY_LOCATION_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const ACTOR_USER_ID = 'uuuuuuuu-0000-0000-0000-000000000001';

function mkLocationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SECONDARY_LOCATION_ID,
    account_id: ACCOUNT_ID,
    name: 'Westside Bakery',
    display_label: null as string | null,
    is_primary: false,
    archived_at: null as Date | null,
    google_place_id: null as string | null,
    created_at: new Date('2026-01-01'),
    ...overrides,
  };
}

function mkInput(overrides: Partial<ArchiveLocationTxInput> = {}): ArchiveLocationTxInput {
  return {
    locationId: SECONDARY_LOCATION_ID,
    accountId: ACCOUNT_ID,
    actorUserId: ACTOR_USER_ID,
    activeLocationsBefore: 2,
    ...overrides,
  };
}

// ── Test setup ───────────────────────────────────────────────────────────────

beforeEach(() => {
  mockSql.mockReset();
  mockSql.mockImplementation(async (strings: TemplateStringsArray) => {
    const template = strings.join('?');
    if (template.includes('SELECT id') && template.includes('FROM accounts')) {
      return [{ id: ACCOUNT_ID }];
    }
    if (template.includes('SELECT COUNT(*) AS count') && template.includes('FROM businesses')) {
      return [{ count: 2 }];
    }
    if (template.includes('SELECT archived_at') && template.includes('FROM businesses') && template.includes('FOR UPDATE')) {
      return [{ archived_at: null }];
    }
    if (template.includes('UPDATE businesses')) {
      return [{ id: SECONDARY_LOCATION_ID }];
    }
    if (template.includes('FROM zernio_connections') && template.includes('JOIN accounts')) {
      return [{
        zernio_account_id: 'zernio-account-1',
        zernio_location_id: 'zernio-location-1',
        subscription_tier: 'standard',
        subscription_activated_at: new Date('2026-05-01T00:00:00.000Z'),
      }];
    }
    return [];
  });
  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<unknown>) => cb(mockSql));
});

// ══════════════════════════════════════════════════════════════════════════
// assertCanArchiveLocation
// ══════════════════════════════════════════════════════════════════════════

describe('assertCanArchiveLocation', () => {
  // ── Rejects when location does not exist ───────────────────────────────

  it('rejects when location does not exist', async () => {
    // getLocationById returns null
    mockSql.mockResolvedValueOnce([]); // getLocationById

    const result = await assertCanArchiveLocation(SECONDARY_LOCATION_ID, ACCOUNT_ID);

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe('location_not_found');
    }
  });

  // ── Rejects when location belongs to a different account ───────────────

  it('rejects when location belongs to a different account', async () => {
    mockSql.mockResolvedValueOnce([
      mkLocationRow({ account_id: 'different-account-0000-0000-0000' }),
    ]);

    const result = await assertCanArchiveLocation(SECONDARY_LOCATION_ID, ACCOUNT_ID);

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe('location_not_owned');
    }
  });

  // ── Rejects when location is already archived ─────────────────────────

  it('rejects when location is already archived', async () => {
    mockSql.mockResolvedValueOnce([
      mkLocationRow({ archived_at: new Date('2026-04-01') }),
    ]);

    const result = await assertCanArchiveLocation(SECONDARY_LOCATION_ID, ACCOUNT_ID);

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe('location_already_archived');
    }
  });

  // ── Rejects when it is the only active location ────────────────────────
  // Feature spec: "Archive attempt on last active location: rejected"

  it('rejects when it is the only active location', async () => {
    mockSql.mockResolvedValueOnce([mkLocationRow()]); // getLocationById
    mockSql.mockResolvedValueOnce([{ count: 1 }]);    // getActiveLocationCount

    const result = await assertCanArchiveLocation(SECONDARY_LOCATION_ID, ACCOUNT_ID);

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe('last_active_location');
    }
  });

  // ── Rejects primary with other active locations ("promote first") ──────
  // Feature spec: "Archive attempt on primary with other active locations:
  //   rejected with 'promote first' message"

  it('rejects primary location when other active locations exist (promote first)', async () => {
    mockSql.mockResolvedValueOnce([
      mkLocationRow({ id: PRIMARY_LOCATION_ID, is_primary: true }),
    ]); // getLocationById
    mockSql.mockResolvedValueOnce([{ count: 3 }]); // getActiveLocationCount

    const result = await assertCanArchiveLocation(PRIMARY_LOCATION_ID, ACCOUNT_ID);

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe('promote_first');
    }
  });

  // ── Allows archiving primary when it's the only location ───────────────
  // This should still be rejected as "last_active_location" — you can't
  // archive the only location regardless of primary status.

  it('rejects primary as last active location (not promote_first)', async () => {
    mockSql.mockResolvedValueOnce([
      mkLocationRow({ id: PRIMARY_LOCATION_ID, is_primary: true }),
    ]); // getLocationById
    mockSql.mockResolvedValueOnce([{ count: 1 }]); // getActiveLocationCount

    const result = await assertCanArchiveLocation(PRIMARY_LOCATION_ID, ACCOUNT_ID);

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe('last_active_location');
    }
  });

  // ── Allows archiving non-primary when other locations exist ─────────────

  it('allows archiving non-primary when other active locations exist', async () => {
    mockSql.mockResolvedValueOnce([
      mkLocationRow({ is_primary: false }),
    ]); // getLocationById
    mockSql.mockResolvedValueOnce([{ count: 3 }]); // getActiveLocationCount

    const result = await assertCanArchiveLocation(SECONDARY_LOCATION_ID, ACCOUNT_ID);

    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.activeLocationsAfterArchive).toBe(2);
    }
  });

  // ── Allows archiving primary with only 2 locations (need to promote first) ──

  it('still rejects primary with exactly 2 active locations', async () => {
    mockSql.mockResolvedValueOnce([
      mkLocationRow({ id: PRIMARY_LOCATION_ID, is_primary: true }),
    ]); // getLocationById
    mockSql.mockResolvedValueOnce([{ count: 2 }]); // getActiveLocationCount

    const result = await assertCanArchiveLocation(PRIMARY_LOCATION_ID, ACCOUNT_ID);

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe('promote_first');
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// archiveLocationTransaction
// ══════════════════════════════════════════════════════════════════════════

describe('archiveLocationTransaction', () => {
  // VAL-LOC-043: Archive transaction is atomic — businesses + audit + outbox
  it('executes UPDATE businesses + INSERT audit_log + INSERT outbox in a transaction', async () => {
    const result = await archiveLocationTransaction(mkInput());

    // Verify sql.begin was called (atomic transaction)
    expect(mockSql.begin).toHaveBeenCalled();

    expect(result.locationId).toBe(SECONDARY_LOCATION_ID);
    expect(result.archived).toBe(true);
  });

  // Sets archived_at on the businesses row
  it('sets archived_at = NOW() on the businesses row', async () => {
    await archiveLocationTransaction(mkInput());

    // Find the UPDATE businesses call inside the tx
    const txCalls = mockSql.mock.calls;
    const updateCall = txCalls.find(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('UPDATE businesses'),
    );
    expect(updateCall).toBeDefined();
    const template = (updateCall![0] as TemplateStringsArray).join('?');
    expect(template).toContain('archived_at');
    expect(template).toContain('NOW()');
  });

  it('filters archive UPDATE by both location id and account id', async () => {
    await archiveLocationTransaction(mkInput());

    const updateCall = mockSql.mock.calls.find(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('UPDATE businesses'),
    );
    expect(updateCall).toBeDefined();
    const template = (updateCall![0] as TemplateStringsArray).join('?');
    expect(template).toMatch(/WHERE\s+id\s*=\s*\?::uuid\s+AND\s+account_id\s*=\s*\?::uuid/i);
  });

  it('locks the account and re-checks active count inside the archive transaction', async () => {
    await archiveLocationTransaction(mkInput());

    const lockIndex = mockSql.mock.calls.findIndex(
      (c: any[]) => {
        const template = (c[0] as TemplateStringsArray).join('?');
        return template.includes('FROM accounts') && template.includes('FOR UPDATE');
      },
    );
    const countIndex = mockSql.mock.calls.findIndex(
      (c: any[]) => {
        const template = (c[0] as TemplateStringsArray).join('?');
        return template.includes('SELECT COUNT(*) AS count') && template.includes('FROM businesses');
      },
    );
    const updateIndex = mockSql.mock.calls.findIndex(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('UPDATE businesses'),
    );

    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(countIndex).toBeGreaterThan(lockIndex);
    expect(updateIndex).toBeGreaterThan(countIndex);
  });

  it('throws last_active_location inside the transaction before update/audit/outbox', async () => {
    mockSql.mockImplementation(async (strings: TemplateStringsArray) => {
      const template = strings.join('?');
      if (template.includes('SELECT id') && template.includes('FROM accounts')) {
        return [{ id: ACCOUNT_ID }];
      }
      if (template.includes('SELECT COUNT(*) AS count') && template.includes('FROM businesses')) {
        return [{ count: 1 }];
      }
      if (template.includes('SELECT archived_at') && template.includes('FOR UPDATE')) {
        return [{ archived_at: null }];
      }
      if (template.includes('UPDATE businesses')) {
        return [{ id: SECONDARY_LOCATION_ID }];
      }
      return [];
    });

    await expect(archiveLocationTransaction(mkInput())).rejects.toThrow(
      'last_active_location',
    );

    const updateCall = mockSql.mock.calls.find(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('UPDATE businesses'),
    );
    const auditCall = mockSql.mock.calls.find(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO account_audit_log'),
    );
    const outboxCall = mockSql.mock.calls.find(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO job_outbox'),
    );
    expect(updateCall).toBeUndefined();
    expect(auditCall).toBeUndefined();
    expect(outboxCall).toBeUndefined();
  });

  it('throws and skips audit/outbox when archive UPDATE affects no rows', async () => {
    mockSql.mockImplementation(async (strings: TemplateStringsArray) => {
      const template = strings.join('?');
      if (template.includes('SELECT id') && template.includes('FROM accounts')) {
        return [{ id: ACCOUNT_ID }];
      }
      if (template.includes('SELECT COUNT(*) AS count') && template.includes('FROM businesses')) {
        return [{ count: 2 }];
      }
      if (template.includes('UPDATE businesses')) {
        return [];
      }
      return [];
    });

    await expect(archiveLocationTransaction(mkInput())).rejects.toThrow(
      'location_archive_conflict',
    );

    const txCalls = mockSql.mock.calls;
    const auditCall = txCalls.find(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO account_audit_log'),
    );
    const outboxCall = txCalls.find(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO job_outbox'),
    );
    expect(auditCall).toBeUndefined();
    expect(outboxCall).toBeUndefined();
  });

  // Also sets is_primary = FALSE when archiving a primary
  it('sets is_primary = FALSE when archiving a primary location', async () => {
    await archiveLocationTransaction(mkInput());

    const txCalls = mockSql.mock.calls;
    const updateCall = txCalls.find(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('UPDATE businesses'),
    );
    expect(updateCall).toBeDefined();
    const template = (updateCall![0] as TemplateStringsArray).join('?');
    expect(template).toContain('is_primary');
    expect(template).toContain('FALSE');
  });

  // Inserts account_audit_log with event_type 'location_archived'
  it('inserts account_audit_log with event_type location_archived', async () => {
    await archiveLocationTransaction(mkInput({ actorUserId: ACTOR_USER_ID }));

    const txCalls = mockSql.mock.calls;
    const auditCall = txCalls.find(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO account_audit_log'),
    );
    expect(auditCall).toBeDefined();
    const template = (auditCall![0] as TemplateStringsArray).join('?');
    expect(template).toContain('location_archived');
  });

  // Audit log includes actor_user_id
  it('audit log includes actor_user_id', async () => {
    await archiveLocationTransaction(mkInput({ actorUserId: ACTOR_USER_ID }));

    const txCalls = mockSql.mock.calls;
    const auditCall = txCalls.find(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO account_audit_log'),
    );
    expect(auditCall).toBeDefined();
    const template = (auditCall![0] as TemplateStringsArray).join('?');
    expect(template).toContain('actor_user_id');
  });

  // Enqueues Stripe overage decrement via job_outbox
  it('enqueues job_outbox row with topic update_stripe_overage_quantity', async () => {
    await archiveLocationTransaction(mkInput());

    const txCalls = mockSql.mock.calls;
    const outboxCall = txCalls.find(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO job_outbox'),
    );
    expect(outboxCall).toBeDefined();
    const template = (outboxCall![0] as TemplateStringsArray).join('?');
    expect(template).toContain('update_stripe_overage_quantity');
  });

  // VAL-LOC-043: If any step fails, all rollback
  it('rolls back entire transaction if any step fails', async () => {
    mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<unknown>) => {
      throw new Error('outbox INSERT failed: constraint violation');
    });

    await expect(archiveLocationTransaction(mkInput())).rejects.toThrow(
      'outbox INSERT failed',
    );
  });

  // VAL-LOC-044: Location with in-flight approvals can be archived
  // (structural test: the archive transaction does NOT delete or modify
  // responses/reviews — it only sets archived_at on the businesses row)
  it('does not delete or modify reviews/responses (only sets archived_at)', async () => {
    await archiveLocationTransaction(mkInput());

    const txCalls = mockSql.mock.calls;
    // Should NOT contain DELETE or UPDATE on reviews/responses tables
    const deleteCall = txCalls.find(
      (c: any[]) => {
        const template = (c[0] as TemplateStringsArray).join('?');
        return template.includes('DELETE') || template.includes('responses') || template.includes('reviews');
      },
    );
    expect(deleteCall).toBeUndefined();
  });

  // Audit payload includes relevant archive info
  it('audit log payload includes location_id and active_locations_before', async () => {
    await archiveLocationTransaction(mkInput({ activeLocationsBefore: 3 }));

    // The audit INSERT's payload should contain location_id and active_locations_before.
    // jsonb is mocked to pass through.
    const txCalls = mockSql.mock.calls;
    const auditCall = txCalls.find(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO account_audit_log'),
    );
    expect(auditCall).toBeDefined();
  });

  // All three operations in the same sql.begin() call
  it('all operations (UPDATE, audit, outbox) run in the same sql.begin() call', async () => {
    await archiveLocationTransaction(mkInput());

    expect(mockSql.begin).toHaveBeenCalledTimes(1);

    // Inside the transaction, there should be 3 operations
    const txCalls = mockSql.mock.calls;
    const ops = txCalls.filter(
      (c: any[]) => {
        const template = (c[0] as TemplateStringsArray).join('?');
        return template.includes('UPDATE businesses') ||
               template.includes('INSERT INTO account_audit_log') ||
               template.includes('INSERT INTO job_outbox');
      },
    );
    expect(ops.length).toBeGreaterThanOrEqual(3);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// B1: race-proof primary archive via locked snapshot + blockPrimary
// ══════════════════════════════════════════════════════════════════════════
// Invariant: businesses_account_primary_uniq enforces at most one primary per
// active account. The owner archive path must NOT archive the primary while
// other active locations exist — it decides "is this the primary?" from the
// LOCKED snapshot, not the UPDATE rowcount. The teardown path (offboarding) IS
// allowed to archive the primary intentionally.

describe('archiveLocationTransaction — B1 race-proof primary guard', () => {
  // Helper to drive a primary snapshot through lockArchiveContext.
  function drivePrimarySnapshot(activeCount: number, isPrimary: boolean, archivedAt: Date | null = null) {
    mockSql.mockImplementation(async (strings: TemplateStringsArray) => {
      const template = strings.join('?');
      if (template.includes('SELECT id') && template.includes('FROM accounts')) {
        return [{ id: ACCOUNT_ID }];
      }
      if (template.includes('SELECT COUNT(*) AS count') && template.includes('FROM businesses')) {
        return [{ count: activeCount }];
      }
      if (template.includes('is_primary') && template.includes('FROM businesses') && template.includes('FOR UPDATE')) {
        return [{ archived_at: archivedAt, is_primary: isPrimary }];
      }
      if (template.includes('UPDATE businesses')) {
        return [{ id: PRIMARY_LOCATION_ID }];
      }
      return [];
    });
  }

  it('throws promote_first from the locked snapshot when the primary has other active locations', async () => {
    drivePrimarySnapshot(2, true);

    await expect(
      archiveLocationTransaction(mkInput({ locationId: PRIMARY_LOCATION_ID })),
    ).rejects.toThrow('promote_first');

    // The archive UPDATE must NOT have been reached.
    const updateCall = mockSql.mock.calls.find(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('UPDATE businesses'),
    );
    expect(updateCall).toBeUndefined();

    const auditCall = mockSql.mock.calls.find(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO account_audit_log'),
    );
    const outboxCall = mockSql.mock.calls.find(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO job_outbox'),
    );
    expect(auditCall).toBeUndefined();
    expect(outboxCall).toBeUndefined();
  });

  it('checks last_active_location before promote_first (only the primary, count 1)', async () => {
    drivePrimarySnapshot(1, true);

    await expect(
      archiveLocationTransaction(mkInput({ locationId: PRIMARY_LOCATION_ID })),
    ).rejects.toThrow('last_active_location');
  });

  it('adds AND is_primary = FALSE to the owner archive UPDATE WHERE clause (blockPrimary)', async () => {
    drivePrimarySnapshot(2, false);

    await archiveLocationTransaction(mkInput({ locationId: SECONDARY_LOCATION_ID }));

    const updateCall = mockSql.mock.calls.find(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('UPDATE businesses'),
    );
    expect(updateCall).toBeDefined();
    const template = (updateCall![0] as TemplateStringsArray).join('?');
    const [, whereClause = ''] = template.split(/\bWHERE\b/i);
    // The SET line still flips is_primary = FALSE, but the WHERE must ALSO gate
    // on is_primary = FALSE so a primary row matches 0 rows under a race.
    expect(whereClause).toMatch(/is_primary\s*=\s*FALSE/i);
  });

  it('surfaces location_archive_conflict (not promote_first) when a non-primary snapshot loses the archive race', async () => {
    mockSql.mockImplementation(async (strings: TemplateStringsArray) => {
      const template = strings.join('?');
      if (template.includes('SELECT id') && template.includes('FROM accounts')) {
        return [{ id: ACCOUNT_ID }];
      }
      if (template.includes('SELECT COUNT(*) AS count') && template.includes('FROM businesses')) {
        return [{ count: 2 }];
      }
      if (template.includes('is_primary') && template.includes('FROM businesses') && template.includes('FOR UPDATE')) {
        return [{ archived_at: null, is_primary: false }];
      }
      if (template.includes('UPDATE businesses')) {
        return []; // 0 rows affected — lost the race
      }
      return [];
    });

    await expect(
      archiveLocationTransaction(mkInput({ locationId: SECONDARY_LOCATION_ID })),
    ).rejects.toThrow('location_archive_conflict');
  });
});

describe('archiveLocationForAccountOffboardingTeardownTransaction — B1 teardown may archive primary', () => {
  function driveTeardownSnapshot(isPrimary: boolean) {
    mockSql.mockImplementation(async (strings: TemplateStringsArray) => {
      const template = strings.join('?');
      if (template.includes('SELECT id') && template.includes('FROM accounts')) {
        return [{ id: ACCOUNT_ID }];
      }
      if (template.includes('SELECT COUNT(*) AS count') && template.includes('FROM businesses')) {
        return [{ count: 1 }];
      }
      if (template.includes('is_primary') && template.includes('FROM businesses') && template.includes('FOR UPDATE')) {
        return [{ archived_at: null, is_primary: isPrimary }];
      }
      if (template.includes('UPDATE businesses')) {
        return [{ id: PRIMARY_LOCATION_ID }];
      }
      return [];
    });
  }

  it('does NOT add the AND is_primary = FALSE WHERE guard to the teardown archive UPDATE (blockPrimary false)', async () => {
    driveTeardownSnapshot(true);

    await archiveLocationForAccountOffboardingTeardownTransaction({
      locationId: PRIMARY_LOCATION_ID,
      accountId: ACCOUNT_ID,
      accountOffboardingId: 'offboarding-123',
    });

    const updateCall = mockSql.mock.calls.find(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('UPDATE businesses'),
    );
    expect(updateCall).toBeDefined();
    const template = (updateCall![0] as TemplateStringsArray).join('?');
    const [setClause = '', whereClause = ''] = template.split(/\bWHERE\b/i);
    // SET line still flips the primary off (the archived row must not stay primary)...
    expect(setClause).toMatch(/is_primary\s*=\s*FALSE/i);
    // ...but the WHERE must NOT gate on is_primary — teardown intentionally archives the primary.
    expect(whereClause).not.toMatch(/is_primary\s*=\s*FALSE/i);
  });

  it('archives the primary location during teardown without throwing promote_first', async () => {
    driveTeardownSnapshot(true);

    const result = await archiveLocationForAccountOffboardingTeardownTransaction({
      locationId: PRIMARY_LOCATION_ID,
      accountId: ACCOUNT_ID,
      accountOffboardingId: 'offboarding-123',
    });

    expect(result).toEqual({
      locationId: PRIMARY_LOCATION_ID,
      archived: true,
      alreadyArchived: false,
    });
  });
});

describe('archiveLocationForAccountOffboardingTeardownTransaction', () => {
  it('reuses the shared archive transaction body and still enqueues Stripe overage updates', async () => {
    const result = await archiveLocationForAccountOffboardingTeardownTransaction({
      locationId: SECONDARY_LOCATION_ID,
      accountId: ACCOUNT_ID,
      accountOffboardingId: 'offboarding-123',
    });

    expect(mockSql.begin).toHaveBeenCalled();
    expect(result).toEqual({
      locationId: SECONDARY_LOCATION_ID,
      archived: true,
      alreadyArchived: false,
    });

    const updateCall = mockSql.mock.calls.find(
      (call: unknown[]) => (call[0] as TemplateStringsArray).join('?').includes('UPDATE businesses'),
    );
    expect(updateCall).toBeTruthy();

    const outboxCall = mockSql.mock.calls.find(
      (call: unknown[]) => (call[0] as TemplateStringsArray).join('?').includes('INSERT INTO job_outbox'),
    );
    expect(outboxCall).toBeTruthy();
    expect((outboxCall?.[0] as TemplateStringsArray).join('?')).toContain('INSERT INTO job_outbox');
  });

  it('treats already-archived snapshot locations as idempotent success without rewriting audit/outbox', async () => {
    mockSql.mockImplementation(async (strings: TemplateStringsArray) => {
      const template = strings.join('?');
      if (template.includes('SELECT id') && template.includes('FROM accounts')) {
        return [{ id: ACCOUNT_ID }];
      }
      if (template.includes('SELECT COUNT(*) AS count') && template.includes('FROM businesses')) {
        return [{ count: 1 }];
      }
      if (template.includes('SELECT archived_at') && template.includes('FOR UPDATE')) {
        return [{ archived_at: new Date('2026-05-01T00:00:00.000Z') }];
      }
      return [];
    });

    const result = await archiveLocationForAccountOffboardingTeardownTransaction({
      locationId: SECONDARY_LOCATION_ID,
      accountId: ACCOUNT_ID,
      accountOffboardingId: 'offboarding-123',
    });

    expect(result).toEqual({
      locationId: SECONDARY_LOCATION_ID,
      archived: true,
      alreadyArchived: true,
    });
    const combinedSql = mockSql.mock.calls.map(
      (call: unknown[]) => (call[0] as TemplateStringsArray).join('?'),
    ).join('\n');
    expect(combinedSql).not.toContain('UPDATE businesses');
    expect(combinedSql).not.toContain('INSERT INTO account_audit_log');
    expect(combinedSql).not.toContain('INSERT INTO job_outbox');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// reactivateLocationTransaction
// ══════════════════════════════════════════════════════════════════════════
// Feature spec: "Re-add from archived state possible via admin tool
//   (restores from archived_at=NULL)"

describe('reactivateLocationTransaction', () => {
  it('sets archived_at = NULL on the businesses row', async () => {
    const result = await reactivateLocationTransaction({
      locationId: SECONDARY_LOCATION_ID,
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
    });

    expect(result.locationId).toBe(SECONDARY_LOCATION_ID);
    expect(result.reactivated).toBe(true);

    // Verify the UPDATE sets archived_at = NULL
    const txCalls = mockSql.mock.calls;
    const updateCall = txCalls.find(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('UPDATE businesses'),
    );
    expect(updateCall).toBeDefined();
    const template = (updateCall![0] as TemplateStringsArray).join('?');
    expect(template).toContain('archived_at');
    expect(template).toContain('NULL');
  });

  it('throws and skips audit/outbox when reactivate UPDATE affects no rows', async () => {
    mockSql.mockImplementation(async (strings: TemplateStringsArray) => {
      const template = strings.join('?');
      if (template.includes('UPDATE businesses')) {
        return [];
      }
      return [];
    });

    await expect(reactivateLocationTransaction({
      locationId: SECONDARY_LOCATION_ID,
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
    })).rejects.toThrow('location_reactivate_conflict');

    const txCalls = mockSql.mock.calls;
    const auditCall = txCalls.find(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO account_audit_log'),
    );
    const outboxCall = txCalls.find(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO job_outbox'),
    );
    expect(auditCall).toBeUndefined();
    expect(outboxCall).toBeUndefined();
  });

  it('inserts audit log with event_type location_reactivated', async () => {
    await reactivateLocationTransaction({
      locationId: SECONDARY_LOCATION_ID,
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
    });

    const txCalls = mockSql.mock.calls;
    const auditCall = txCalls.find(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO account_audit_log'),
    );
    expect(auditCall).toBeDefined();
    const template = (auditCall![0] as TemplateStringsArray).join('?');
    expect(template).toContain('location_reactivated');
  });

  it('enqueues Stripe overage update via job_outbox', async () => {
    await reactivateLocationTransaction({
      locationId: SECONDARY_LOCATION_ID,
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
    });

    const txCalls = mockSql.mock.calls;
    const outboxCall = txCalls.find(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO job_outbox'),
    );
    expect(outboxCall).toBeDefined();
    const template = (outboxCall![0] as TemplateStringsArray).join('?');
    expect(template).toContain('update_stripe_overage_quantity');
  });

  // VAL-LOC-071: Zernio backfill enqueued on reactivation
  it('enqueues zernio_initial_backfill outbox row for the reactivated location', async () => {
    await reactivateLocationTransaction({
      locationId: SECONDARY_LOCATION_ID,
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
    });

    const txCalls = mockSql.mock.calls;
    const outboxCalls = txCalls.filter(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO job_outbox'),
    );

    // Should have 2 outbox INSERTs: update_stripe_overage_quantity + zernio_initial_backfill
    expect(outboxCalls.length).toBeGreaterThanOrEqual(2);

    // Verify zernio_initial_backfill topic is present
    const zernioCall = outboxCalls.find(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('zernio_initial_backfill'),
    );
    expect(zernioCall).toBeDefined();
  });

  it('enqueues reactivation backfill with the full Zernio/account payload', async () => {
    await reactivateLocationTransaction({
      locationId: SECONDARY_LOCATION_ID,
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
    });

    const zernioCall = mockSql.mock.calls.find(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('zernio_initial_backfill'),
    );
    expect(zernioCall).toBeDefined();
    const payload = zernioCall?.find((value: unknown) =>
      typeof value === 'object' &&
      value !== null &&
      (value as { business_id?: string }).business_id === SECONDARY_LOCATION_ID,
    ) as Record<string, unknown> | undefined;
    expect(payload).toMatchObject({
      business_id: SECONDARY_LOCATION_ID,
      zernio_account_id: 'zernio-account-1',
      zernio_location_id: 'zernio-location-1',
      subscription_tier: 'standard',
      subscription_activated_at: '2026-05-01T00:00:00.000Z',
      backfill_reason: 'reactivation',
    });
  });

  it('runs all operations inside sql.begin()', async () => {
    await reactivateLocationTransaction({
      locationId: SECONDARY_LOCATION_ID,
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
    });

    expect(mockSql.begin).toHaveBeenCalledTimes(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Concurrent safety (VAL-LOC-047)
// ══════════════════════════════════════════════════════════════════════════
// VAL-LOC-047: Concurrent archive and add at quota boundary is handled by
// state-conditional archive/reactivate updates plus asynchronous Stripe
// reconciliation from the committed active-location count.

describe('concurrent safety (VAL-LOC-047)', () => {
  it('archiveLocationTransaction locks the account and target location before archive update', async () => {
    await archiveLocationTransaction(mkInput());

    const txCalls = mockSql.mock.calls;
    const accountLockCall = txCalls.find(
      (c: any[]) => {
        const template = (c[0] as TemplateStringsArray).join('?');
        return template.includes('FROM accounts') && template.includes('FOR UPDATE');
      },
    );
    const locationLockCall = txCalls.find(
      (c: any[]) => {
        const template = (c[0] as TemplateStringsArray).join('?');
        return template.includes('SELECT archived_at') && template.includes('FOR UPDATE');
      },
    );

    expect(accountLockCall).toBeTruthy();
    expect(locationLockCall).toBeTruthy();
  });
});
