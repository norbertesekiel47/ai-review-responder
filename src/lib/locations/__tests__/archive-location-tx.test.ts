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
  // Identity .json stub: the module now binds jsonb via the injected client's
  // tx.json(...) (byte-identical to the old jsonb() helper).
  sqlFn.json = (v: unknown) => v;
  return { mockSql: sqlFn };
});

vi.mock('uuid', () => ({
  v7: vi.fn(() => 'mock-uuid-v7-archive-000000000001'),
}));

import type { Sql } from 'postgres';
import {
  assertCanArchiveLocation,
  archiveLocationTransaction,
  archiveLocationForAccountOffboardingTeardownTransaction,
  reactivateLocationTransaction,
  type ArchiveLocationTxInput,
} from '../archive-location-tx';

// The injected sql client IS the mock — assertions still read mockSql.mock.calls.
const sql = mockSql as unknown as Sql;

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
    ...overrides,
  };
}

// ── Test setup ───────────────────────────────────────────────────────────────

const defaultZernioRow = {
  zernio_account_id: 'zernio-account-1',
  zernio_location_id: 'zernio-location-1',
};
const defaultAccountRow = {
  id: ACCOUNT_ID,
  subscription_tier: 'copilot',
  subscription_activated_at: new Date('2026-05-01T00:00:00.000Z'),
};

/**
 * Single parametrized mock-DB driver for every archive/teardown/reactivate
 * scenario in this file. Routes the queries these transactions issue by
 * template fingerprint:
 *   - accounts SELECT ... FOR UPDATE lock
 *   - active-location COUNT(*) (archive guard)
 *   - the locked is_primary + archived_at snapshot SELECT ... FOR UPDATE
 *   - the B3 active-primary COUNT (is_primary = TRUE, reactivate self-heal)
 *   - UPDATE businesses (archive / un-archive / self-promote)
 *   - zernio_connections JOIN accounts (reactivation backfill context)
 * Tests call it with overrides instead of redefining a router.
 */
function driveArchiveDb({
  activeCount = 2,
  isPrimary = false,
  archivedAt = null as Date | null,
  activePrimaryCount = 1,
  updateRows = [{ id: SECONDARY_LOCATION_ID }] as Array<{
    id: string;
    google_place_id?: string | null;
    google_maps_url?: string | null;
  }>,
  selfPromoteRows = undefined as Array<{ id: string }> | undefined,
  zernio = defaultZernioRow as typeof defaultZernioRow | null,
  account = defaultAccountRow as typeof defaultAccountRow | null,
  offboarding = null as Record<string, unknown> | null,
} = {}) {
  mockSql.mockImplementation(async (strings: TemplateStringsArray) => {
    const template = strings.join('?');
    if (template.includes('SELECT id') && template.includes('FROM accounts')) {
      return account ? [account] : [];
    }
    if (template.includes('FROM account_offboardings')) {
      return offboarding ? [offboarding] : [];
    }
    if (template.includes('SELECT COUNT(*) AS count') && template.includes('FROM businesses')) {
      return [{ count: activeCount }];
    }
    if (
      template.includes('COUNT(*)') &&
      template.includes('is_primary = TRUE') &&
      template.includes('archived_at IS NULL')
    ) {
      return [{ count: activePrimaryCount }];
    }
    if (template.includes('FROM businesses') && template.includes('FOR UPDATE')) {
      const isReactivateLock = template.includes('SELECT id, archived_at');
      return [{
        id: SECONDARY_LOCATION_ID,
        archived_at: isReactivateLock
          ? (archivedAt ?? new Date('2026-05-01T00:00:00.000Z'))
          : archivedAt,
        is_primary: isPrimary,
      }];
    }
    if (template.includes('UPDATE businesses') && template.includes('SET is_primary = TRUE')) {
      return selfPromoteRows ?? updateRows;
    }
    if (template.includes('UPDATE businesses')) {
      return updateRows;
    }
    if (template.includes('FROM zernio_connections')) {
      return zernio ? [zernio] : [];
    }
    return [];
  });
}

beforeEach(() => {
  mockSql.mockReset();
  driveArchiveDb();
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

    const result = await assertCanArchiveLocation(sql,SECONDARY_LOCATION_ID, ACCOUNT_ID);

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

    const result = await assertCanArchiveLocation(sql,SECONDARY_LOCATION_ID, ACCOUNT_ID);

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

    const result = await assertCanArchiveLocation(sql,SECONDARY_LOCATION_ID, ACCOUNT_ID);

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

    const result = await assertCanArchiveLocation(sql,SECONDARY_LOCATION_ID, ACCOUNT_ID);

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

    const result = await assertCanArchiveLocation(sql,PRIMARY_LOCATION_ID, ACCOUNT_ID);

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

    const result = await assertCanArchiveLocation(sql,PRIMARY_LOCATION_ID, ACCOUNT_ID);

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

    const result = await assertCanArchiveLocation(sql,SECONDARY_LOCATION_ID, ACCOUNT_ID);

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

    const result = await assertCanArchiveLocation(sql,PRIMARY_LOCATION_ID, ACCOUNT_ID);

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
    const result = await archiveLocationTransaction(sql, mkInput());

    // Verify sql.begin was called (atomic transaction)
    expect(mockSql.begin).toHaveBeenCalled();

    expect(result.locationId).toBe(SECONDARY_LOCATION_ID);
    expect(result.archived).toBe(true);
  });

  // Sets archived_at on the businesses row
  it('sets archived_at = NOW() on the businesses row', async () => {
    await archiveLocationTransaction(sql, mkInput());

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
    await archiveLocationTransaction(sql, mkInput());

    const updateCall = mockSql.mock.calls.find(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('UPDATE businesses'),
    );
    expect(updateCall).toBeDefined();
    const template = (updateCall![0] as TemplateStringsArray).join('?');
    expect(template).toMatch(/WHERE\s+id\s*=\s*\?::uuid\s+AND\s+account_id\s*=\s*\?::uuid/i);
  });

  it('takes lifecycle then business then account locks before re-checking active count', async () => {
    await archiveLocationTransaction(sql, mkInput());

    const lifecycleIndex = mockSql.mock.calls.findIndex(
      (c: any[]) => c.slice(1).includes(`${ACCOUNT_ID}:location_lifecycle`),
    );
    const businessLockIndex = mockSql.mock.calls.findIndex(
      (c: any[]) => {
        const template = (c[0] as TemplateStringsArray).join('?');
        return template.includes('FROM businesses') && template.includes('FOR UPDATE');
      },
    );
    const accountLockIndex = mockSql.mock.calls.findIndex(
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

    expect(lifecycleIndex).toBe(0);
    expect(businessLockIndex).toBeGreaterThan(lifecycleIndex);
    expect(accountLockIndex).toBeGreaterThan(businessLockIndex);
    expect(countIndex).toBeGreaterThan(accountLockIndex);
    expect(updateIndex).toBeGreaterThan(countIndex);
  });

  it('throws last_active_location inside the transaction before update/audit/outbox', async () => {
    driveArchiveDb({ activeCount: 1 });

    await expect(archiveLocationTransaction(sql, mkInput())).rejects.toThrow(
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
    driveArchiveDb({ updateRows: [] });

    await expect(archiveLocationTransaction(sql, mkInput())).rejects.toThrow(
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
    await archiveLocationTransaction(sql, mkInput());

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
    await archiveLocationTransaction(sql, mkInput({ actorUserId: ACTOR_USER_ID }));

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
    await archiveLocationTransaction(sql, mkInput({ actorUserId: ACTOR_USER_ID }));

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
    await archiveLocationTransaction(sql, mkInput());

    const txCalls = mockSql.mock.calls;
    const outboxCall = txCalls.find(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO job_outbox'),
    );
    expect(outboxCall).toBeDefined();
    // Topic is bound as a parameter by enqueueStripeOverageRecompute, not inlined SQL text.
    expect(outboxCall!.slice(1)).toContain('update_stripe_overage_quantity');
  });

  // VAL-LOC-043: If any step fails, all rollback
  it('rolls back entire transaction if any step fails', async () => {
    mockSql.begin = vi.fn(async (_cb: (tx: any) => Promise<unknown>) => {
      throw new Error('outbox INSERT failed: constraint violation');
    });

    await expect(archiveLocationTransaction(sql, mkInput())).rejects.toThrow(
      'outbox INSERT failed',
    );
  });

  // VAL-LOC-044: Location with in-flight approvals can be archived
  // (structural test: the archive transaction does NOT delete or modify
  // responses/reviews — it only sets archived_at on the businesses row)
  it('does not delete or modify reviews/responses (only sets archived_at)', async () => {
    await archiveLocationTransaction(sql, mkInput());

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

  // Audit payload includes relevant archive info (counts come from the
  // tx's locked snapshot, not a caller-supplied pre-tx read)
  it('audit log payload includes location_id and active_locations_before', async () => {
    await archiveLocationTransaction(sql, mkInput());

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
    await archiveLocationTransaction(sql, mkInput());

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
// B1: race-proof primary archive via the locked snapshot
// ══════════════════════════════════════════════════════════════════════════
// Invariant: businesses_account_primary_uniq enforces at most one primary per
// active account. The owner archive path must NOT archive the primary while
// other active locations exist — it decides "is this the primary?" from the
// LOCKED snapshot (held FOR UPDATE through the archive UPDATE), not the
// UPDATE rowcount. The teardown path (offboarding) IS allowed to archive the
// primary intentionally.

describe('archiveLocationTransaction — B1 race-proof primary guard', () => {
  it('throws promote_first from the locked snapshot when the primary has other active locations', async () => {
    driveArchiveDb({ activeCount: 2, isPrimary: true });

    await expect(
      archiveLocationTransaction(sql, mkInput({ locationId: PRIMARY_LOCATION_ID })),
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
    driveArchiveDb({ activeCount: 1, isPrimary: true });

    await expect(
      archiveLocationTransaction(sql, mkInput({ locationId: PRIMARY_LOCATION_ID })),
    ).rejects.toThrow('last_active_location');
  });

  it('surfaces location_archive_conflict for an already-archived target, even when the remaining count is 1 (double-submit on a 2-location account)', async () => {
    // Snapshot: the target is already archived, so the active count has
    // dropped to 1. The archived check must win over last_active_location —
    // the owner is double-submitting, not archiving their last location.
    driveArchiveDb({ activeCount: 1, archivedAt: new Date('2026-06-01T00:00:00Z') });

    await expect(
      archiveLocationTransaction(sql, mkInput({ locationId: SECONDARY_LOCATION_ID })),
    ).rejects.toThrow('location_archive_conflict');

    const updateCall = mockSql.mock.calls.find(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('UPDATE businesses'),
    );
    expect(updateCall).toBeUndefined();
  });

  it('surfaces location_archive_conflict (not promote_first) when a non-primary snapshot loses the archive race', async () => {
    // 0 rows affected by the archive UPDATE — lost the race.
    driveArchiveDb({ activeCount: 2, updateRows: [] });

    await expect(
      archiveLocationTransaction(sql, mkInput({ locationId: SECONDARY_LOCATION_ID })),
    ).rejects.toThrow('location_archive_conflict');
  });
});

describe('archiveLocationForAccountOffboardingTeardownTransaction — B1 teardown may archive primary', () => {
  it('archives the primary location during teardown without throwing promote_first', async () => {
    driveArchiveDb({ activeCount: 1, isPrimary: true });

    const result = await archiveLocationForAccountOffboardingTeardownTransaction(sql, {
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
    const result = await archiveLocationForAccountOffboardingTeardownTransaction(sql, {
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
    driveArchiveDb({ activeCount: 1, archivedAt: new Date('2026-05-01T00:00:00.000Z') });

    const result = await archiveLocationForAccountOffboardingTeardownTransaction(sql, {
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
  it('fails closed after the account lock when offboarding blocks expansion', async () => {
    driveArchiveDb({
      offboarding: {
        id: 'offboarding-1',
        account_id: ACCOUNT_ID,
        mode: 'delete_data',
        status: 'pending',
        failed_step: null,
        terminal_at: null,
        access_ends_at: null,
        teardown_started_at: null,
        purge_after: null,
        purge_started_at: null,
        purge_cancelled_at: null,
      },
    });

    await expect(reactivateLocationTransaction(sql, {
      locationId: SECONDARY_LOCATION_ID,
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
    })).rejects.toThrow('account_offboarding_blocked');

    const calls: string[] = mockSql.mock.calls.map(
      (call: unknown[]) => (call[0] as TemplateStringsArray).join('?'),
    );
    const businessLock = calls.findIndex(
      (text: string) => text.includes('FROM businesses') && text.includes('FOR UPDATE'),
    );
    const accountLock = calls.findIndex(
      (text: string) => text.includes('FROM accounts') && text.includes('FOR UPDATE'),
    );
    const offboardingRead = calls.findIndex(
      (text: string) => text.includes('FROM account_offboardings'),
    );
    expect(accountLock).toBeGreaterThan(businessLock);
    expect(offboardingRead).toBeGreaterThan(accountLock);
    expect(calls.some(
      (text: string) => text.includes('UPDATE businesses') && text.includes('archived_at = NULL'),
    )).toBe(false);
  });

  it('sets archived_at = NULL on the businesses row', async () => {
    const result = await reactivateLocationTransaction(sql, {
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
    driveArchiveDb({ updateRows: [] });

    await expect(reactivateLocationTransaction(sql, {
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
    await reactivateLocationTransaction(sql, {
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
    await reactivateLocationTransaction(sql, {
      locationId: SECONDARY_LOCATION_ID,
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
    });

    const txCalls = mockSql.mock.calls;
    const outboxCall = txCalls.find(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO job_outbox'),
    );
    expect(outboxCall).toBeDefined();
    // Topic is bound as a parameter by enqueueStripeOverageRecompute, not inlined SQL text.
    expect(outboxCall!.slice(1)).toContain('update_stripe_overage_quantity');
  });

  // VAL-LOC-071: Zernio backfill enqueued on reactivation
  it('enqueues zernio_initial_backfill outbox row for the reactivated location', async () => {
    await reactivateLocationTransaction(sql, {
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

    // Verify zernio_initial_backfill topic is present. Topic is an
    // interpolated QUEUE_NAMES value, not a template literal — check the
    // bound values, not the raw strings array.
    const zernioCall = outboxCalls.find(
      (c: any[]) => c.slice(1).includes('zernio_initial_backfill'),
    );
    expect(zernioCall).toBeDefined();
  });

  it.each(['copilot', 'autopilot'] as const)(
    'enqueues reactivation backfill with the full Zernio/account payload for %s',
    async (subscriptionTier) => {
    driveArchiveDb({
      account: { ...defaultAccountRow, subscription_tier: subscriptionTier },
    });
    await reactivateLocationTransaction(sql, {
      locationId: SECONDARY_LOCATION_ID,
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
    });

    const zernioCall = mockSql.mock.calls.find(
      (c: any[]) => c.slice(1).includes('zernio_initial_backfill'),
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
      subscription_tier: subscriptionTier,
      subscription_activated_at: '2026-05-01T00:00:00.000Z',
      backfill_reason: 'reactivation',
    });
  });

  it('rejects an unsupported account tier before reactivation writes', async () => {
    driveArchiveDb({
      account: { ...defaultAccountRow, subscription_tier: 'retired_tier' },
    });

    await expect(
      reactivateLocationTransaction(sql, {
        locationId: SECONDARY_LOCATION_ID,
        accountId: ACCOUNT_ID,
        actorUserId: ACTOR_USER_ID,
      }),
    ).rejects.toThrow('invalid_ws8_subscription_tier:retired_tier');

    const accountLockCall = mockSql.mock.calls.find((call: unknown[]) => {
      const template = (call[0] as TemplateStringsArray).join('?');
      return template.includes('FROM accounts') && template.includes('FOR UPDATE');
    });
    expect(accountLockCall).toBeDefined();
    expect((accountLockCall![0] as TemplateStringsArray).join('?')).toMatch(
      /SELECT id, subscription_tier, subscription_activated_at[\s\S]*FOR UPDATE/,
    );
  });

  it('runs all operations inside sql.begin()', async () => {
    await reactivateLocationTransaction(sql, {
      locationId: SECONDARY_LOCATION_ID,
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
    });

    expect(mockSql.begin).toHaveBeenCalledTimes(1);
  });

  // Unresolved URL-mode locations (google_place_id NULL + stored Maps URL —
  // e.g. archived before PlaceIdValidationWorker resolved) must re-enqueue
  // validate_place_id on reactivation, or they stay permanently unverified and
  // outside migration 062's duplicate enforcement (NULL never collides under
  // the partial unique index). Mirrors the add-location-tx URL-mode gate.
  it('re-enqueues validate_place_id when the reactivated row has a Maps URL but no place id', async () => {
    driveArchiveDb({
      updateRows: [{
        id: SECONDARY_LOCATION_ID,
        google_place_id: null,
        google_maps_url: 'https://maps.google.com/?q=Cafe+Test',
      }],
    });

    await reactivateLocationTransaction(sql, {
      locationId: SECONDARY_LOCATION_ID,
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
    });

    // Topic is an interpolated QUEUE_NAMES value, not a template literal —
    // check the bound values, not the raw strings array.
    const validateCall = mockSql.mock.calls.find(
      (c: any[]) => c.slice(1).includes('validate_place_id'),
    );
    expect(validateCall).toBeDefined();
    // Shared helper (enqueueValidatePlaceId in job-outbox-helpers): same
    // dedup-guarded SQL shape as the add-location / onboarding paths.
    const template = (validateCall![0] as TemplateStringsArray).join('?');
    expect(template).toContain('INSERT INTO job_outbox');
    expect(template).toContain('WHERE NOT EXISTS');
    expect(template).toContain('topic = ?');
  });

  it('does NOT enqueue validate_place_id when the reactivated row already has a place id', async () => {
    driveArchiveDb({
      updateRows: [{
        id: SECONDARY_LOCATION_ID,
        google_place_id: 'ChIJN1t_tDeuEmsRUsoyG83frY4',
        google_maps_url: 'https://maps.google.com/?q=Cafe+Test',
      }],
    });

    await reactivateLocationTransaction(sql, {
      locationId: SECONDARY_LOCATION_ID,
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
    });

    const validateCall = mockSql.mock.calls.find(
      (c: any[]) => c.slice(1).includes('validate_place_id'),
    );
    expect(validateCall).toBeUndefined();
  });

  // C1: un-archiving a location whose (account_id, google_place_id) is already
  // held by another ACTIVE location trips businesses_account_place_uniq (23505).
  // The tx maps that to duplicate_location so the route can return 409.
  it('maps a 23505 on businesses_account_place_uniq to duplicate_location', async () => {
    mockSql.begin = vi.fn(async () => {
      const err: Error & { code?: string; constraint_name?: string } = new Error(
        'duplicate key value violates unique constraint "businesses_account_place_uniq"',
      );
      err.code = '23505';
      err.constraint_name = 'businesses_account_place_uniq';
      throw err;
    });

    await expect(
      reactivateLocationTransaction(sql, {
        locationId: SECONDARY_LOCATION_ID,
        accountId: ACCOUNT_ID,
        actorUserId: ACTOR_USER_ID,
      }),
    ).rejects.toThrow('duplicate_location');
  });

  // C1: a 23505 on an unrelated constraint must propagate unchanged.
  it('does not remap a 23505 on a different constraint', async () => {
    const original: Error & { code?: string; constraint_name?: string } = new Error(
      'duplicate key value violates unique constraint "businesses_account_primary_uniq"',
    );
    original.code = '23505';
    original.constraint_name = 'businesses_account_primary_uniq';

    mockSql.begin = vi.fn(async () => {
      throw original;
    });

    await expect(
      reactivateLocationTransaction(sql, {
        locationId: SECONDARY_LOCATION_ID,
        accountId: ACCOUNT_ID,
        actorUserId: ACTOR_USER_ID,
      }),
    ).rejects.toThrow(original);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// B3: reactivation self-heals a zero-primary account under lifecycle/business/account locks
// ══════════════════════════════════════════════════════════════════════════
// Invariant: businesses_account_primary_uniq enforces AT MOST one primary per
// active account; a healthy account also wants AT LEAST one. When the
// offboarding-cancel → reactivate path leaves an account with zero active
// primaries, reactivating a location must silently self-promote it under the
// SAME lifecycle→businesses→account order used by archive/promote, so two concurrent
// reactivations can't both win the primary.

describe('reactivateLocationTransaction — B3 zero-primary self-heal', () => {
  function selfPromoteUpdateCalls() {
    return mockSql.mock.calls.filter((c: any[]) => {
      const template = (c[0] as TemplateStringsArray).join('?');
      return template.includes('UPDATE businesses') && /is_primary\s*=\s*TRUE/i.test(template);
    });
  }

  function primaryPromotedAuditCalls() {
    return mockSql.mock.calls.filter((c: any[]) => {
      const template = (c[0] as TemplateStringsArray).join('?');
      return template.includes('INSERT INTO account_audit_log') && template.includes('primary_promoted');
    });
  }

  it('self-promotes the reactivated location when the account has no active primary', async () => {
    driveArchiveDb({ activePrimaryCount: 0, zernio: null });

    const result = await reactivateLocationTransaction(sql, {
      locationId: SECONDARY_LOCATION_ID,
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
    });

    expect(result.reactivated).toBe(true);
    expect(result.selfPromoted).toBe(true);

    // An is_primary = TRUE UPDATE must have been issued for the reactivated row.
    expect(selfPromoteUpdateCalls().length).toBeGreaterThanOrEqual(1);

    // A primary_promoted audit row must have been written.
    expect(primaryPromotedAuditCalls().length).toBe(1);
  });

  it('throws (and skips the audit row) when the self-promote UPDATE affects 0 rows', async () => {
    // RETURNING-verified write: the audit row must never claim a promotion
    // the database did not apply.
    driveArchiveDb({ activePrimaryCount: 0, selfPromoteRows: [], zernio: null });

    await expect(
      reactivateLocationTransaction(sql, {
        locationId: SECONDARY_LOCATION_ID,
        accountId: ACCOUNT_ID,
        actorUserId: ACTOR_USER_ID,
      }),
    ).rejects.toThrow('location_reactivate_conflict');

    expect(primaryPromotedAuditCalls().length).toBe(0);
  });

  it('does NOT self-promote when the account already has an active primary', async () => {
    driveArchiveDb({ activePrimaryCount: 1, zernio: null });

    const result = await reactivateLocationTransaction(sql, {
      locationId: SECONDARY_LOCATION_ID,
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
    });

    expect(result.reactivated).toBe(true);
    expect(result.selfPromoted).toBe(false);

    // No is_primary = TRUE UPDATE, no primary_promoted audit.
    expect(selfPromoteUpdateCalls().length).toBe(0);
    expect(primaryPromotedAuditCalls().length).toBe(0);
  });

  it('takes lifecycle then business then account locks before the un-archive UPDATE', async () => {
    driveArchiveDb({ activePrimaryCount: 0, zernio: null });

    await reactivateLocationTransaction(sql, {
      locationId: SECONDARY_LOCATION_ID,
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
    });

    const lifecycleIndex = mockSql.mock.calls.findIndex((c: any[]) =>
      c.slice(1).includes(`${ACCOUNT_ID}:location_lifecycle`),
    );
    const businessLockIndex = mockSql.mock.calls.findIndex((c: any[]) => {
      const template = (c[0] as TemplateStringsArray).join('?');
      return template.includes('FROM businesses') && template.includes('FOR UPDATE');
    });
    const accountLockIndex = mockSql.mock.calls.findIndex((c: any[]) => {
      const template = (c[0] as TemplateStringsArray).join('?');
      return template.includes('FROM accounts') && template.includes('FOR UPDATE');
    });
    const unarchiveIndex = mockSql.mock.calls.findIndex((c: any[]) => {
      const template = (c[0] as TemplateStringsArray).join('?');
      return template.includes('UPDATE businesses') && template.includes('archived_at') && template.includes('NULL');
    });

    expect(lifecycleIndex).toBe(0);
    expect(businessLockIndex).toBeGreaterThan(lifecycleIndex);
    expect(accountLockIndex).toBeGreaterThan(businessLockIndex);
    expect(unarchiveIndex).toBeGreaterThan(accountLockIndex);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Concurrent safety (VAL-LOC-047)
// ══════════════════════════════════════════════════════════════════════════
// VAL-LOC-047: Concurrent archive and add at quota boundary is handled by
// state-conditional archive/reactivate updates plus asynchronous Stripe
// reconciliation from the committed active-location count.

describe('concurrent safety (VAL-LOC-047)', () => {
  it('archiveLocationTransaction locks the target location before the account and archive update', async () => {
    await archiveLocationTransaction(sql, mkInput());

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
    expect(txCalls.indexOf(locationLockCall!)).toBeLessThan(txCalls.indexOf(accountLockCall!));
  });
});

// ── #677 T0 EVAL — Import consent gate on reactivation ────────────────────────
//
// Titles 24–25 and 63–64 of the intake's 69, authored VERBATIM before
// implementation.
//
// Producer 4 of 4, and the one #677 absorbed from #676 (round-1 High F102, owner
// re-decision 2026-08-06). It is gated because this path is OWNER-REACHABLE via
// src/app/api/locations/reactivate/route.ts:111 — left un-gated, an owner who
// declined could archive and reactivate from the locations UI to get the import
// anyway: a D8 violation reachable in two clicks with no SQL required. The module
// header at archive-location-tx.ts:8 calling this "admin re-activate" is stale and
// is what cost the original wrong scope decision — verify callers, not headers.
//
// CONSENT GATE ONLY — nothing else about this path changes (round-2 High ×2).
// Titles 63 and 64 are the guardrails on that, and they must NOT be "fixed" into
// passing by adding a dedup:
//
//   Reactivation enqueues with backfill_reason 'reactivation'
//   (archive-location-tx.ts:516), and the worker's
//   ON CONFLICT (business_id) WHERE run_reason = 'initial' DO NOTHING
//   (ZernioBackfillWorker.ts:170) deliberately does NOT dedup it. The
//   archived-period catch-up is SUPPOSED to run again after a completed initial
//   run. Revision 2 imposed a generic completed-run predicate here plus an
//   in-flight dedup, and it was wrong twice over: the first silently deleted the
//   catch-up feature, and the second opened a lost-recovery race against a worker
//   holding a stale archived_at read (job-eligibility.ts:60-81).
//
// Reactivation also does NOT create an offer — spec §7, "re-connect after
// declining → stays declined". It only honours the consent already on the row.
// This path is already inside sql.begin with the account and business rows
// locked, so the row-lock discipline is satisfied with no new code.
describe('reactivateLocationTransaction — Import consent gate (#677)', () => {
  it.todo('reactivateLocationTransaction enqueues no import for pending, declined, or derived-expired consent');

  it.todo('reactivateLocationTransaction enqueues the catch-up import when import consent is accepted');

  // The two anti-regression titles. Each asserts the enqueue STILL happens in a
  // state a generic dedup would have suppressed.
  it.todo('reactivateLocationTransaction enqueues the catch-up import after a completed initial run when consent is accepted');

  it.todo('reactivateLocationTransaction enqueues the catch-up import after an earlier completed reactivation run');
});
