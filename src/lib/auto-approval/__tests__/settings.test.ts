import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutoApprovalThreshold } from '../types';

const {
  mockSql,
  sqlCalls,
  mockAssertWritableSubscriptionForAccount,
  mockWriteAccountAuditLog,
  dbState,
} = vi.hoisted(() => {
  type Policy = { id: string; threshold: AutoApprovalThreshold | null };
  type Location = {
    id: string;
    name: string;
    displayLabel: string | null;
    archivedAt: Date | null;
  };
  type Offboarding = {
    id: string;
    account_id: string;
    mode: string;
    status: string;
    failed_step: string | null;
    terminal_at: null;
    access_ends_at: Date | null;
    teardown_started_at: Date | null;
    purge_after: Date | null;
    purge_started_at: Date | null;
    purge_cancelled_at: Date | null;
  };
  const sqlCalls: { text: string; values: unknown[] }[] = [];
  const dbState = {
    accountExists: true,
    accountDefault: null as Policy | null,
    locations: [] as Location[],
    overrides: new Map<string, Policy>(),
    offboarding: null as Offboarding | null,
  };

  const policyRow = (
    policy: Policy,
    accountId: string,
    locationId: string | null,
  ) => ({
    id: policy.id,
    account_id: accountId,
    location_id: locationId,
    auto_approve_min_star: policy.threshold,
  });

  const sqlFn: any = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    sqlCalls.push({ text, values });
    const accountId = values[0] as string;

    if (text.includes('FROM accounts') && text.includes('FOR UPDATE')) {
      return dbState.accountExists ? [{ id: accountId }] : [];
    }

    if (text.includes('FROM account_offboardings')) {
      return dbState.offboarding ? [dbState.offboarding] : [];
    }

    if (
      text.includes('FROM auto_approval_policies') &&
      text.includes('location_id IS NULL') &&
      text.includes('LIMIT 1')
    ) {
      return dbState.accountDefault
        ? [policyRow(dbState.accountDefault, accountId, null)]
        : [];
    }

    if (
      text.includes('FROM auto_approval_policies') &&
      text.includes('location_id =') &&
      text.includes('LIMIT 1')
    ) {
      const locationId = values[1] as string;
      const override = dbState.overrides.get(locationId);
      return override ? [policyRow(override, accountId, locationId)] : [];
    }

    if (
      text.includes('FROM businesses b') &&
      text.includes('LEFT JOIN auto_approval_policies p') &&
      !text.includes('COUNT(*)')
    ) {
      return dbState.locations
        .filter((location) => location.archivedAt === null)
        .map((location) => {
          const override = dbState.overrides.get(location.id);
          return {
            location_id: location.id,
            display_name: location.displayLabel ?? location.name,
            policy_id: override?.id ?? null,
            policy_account_id: override ? accountId : null,
            auto_approve_min_star: override?.threshold ?? null,
          };
        });
    }

    if (text.includes('SELECT id, name, display_label, archived_at') && text.includes('FROM businesses')) {
      const locationId = values[1] as string;
      const location = dbState.locations.find((candidate) => candidate.id === locationId);
      return location
        ? [{
            id: location.id,
            name: location.name,
            display_label: location.displayLabel,
            archived_at: location.archivedAt,
          }]
        : [];
    }

    if (text.includes('COUNT(*)::int AS count') && text.includes('p.id IS NULL')) {
      const count = dbState.locations.filter(
        (location) => location.archivedAt === null && !dbState.overrides.has(location.id),
      ).length;
      return [{ count }];
    }

    if (
      text.includes('INSERT INTO auto_approval_policies') &&
      text.includes('ON CONFLICT (account_id) WHERE location_id IS NULL')
    ) {
      dbState.accountDefault = {
        id: dbState.accountDefault?.id ?? 'policy-account-default',
        threshold: values[2] as AutoApprovalThreshold | null,
      };
      return [];
    }

    if (
      text.includes('INSERT INTO auto_approval_policies') &&
      text.includes('ON CONFLICT (account_id, location_id) WHERE location_id IS NOT NULL')
    ) {
      const locationId = values[1] as string;
      dbState.overrides.set(locationId, {
        id: dbState.overrides.get(locationId)?.id ?? `policy-${locationId}`,
        threshold: values[3] as AutoApprovalThreshold | null,
      });
      return [];
    }

    if (text.includes('DELETE FROM auto_approval_policies') && text.includes('location_id IS NULL')) {
      dbState.accountDefault = null;
      return [];
    }

    if (text.includes('DELETE FROM auto_approval_policies') && text.includes('location_id =')) {
      dbState.overrides.delete(values[1] as string);
      return [];
    }

    return [];
  });
  sqlFn.begin = vi.fn(async (cb: (tx: typeof sqlFn) => Promise<unknown>) => cb(sqlFn));

  return {
    mockSql: sqlFn,
    sqlCalls,
    dbState,
    mockAssertWritableSubscriptionForAccount: vi.fn(),
    mockWriteAccountAuditLog: vi.fn(),
  };
});

vi.mock('@/lib/db/server', () => ({
  sql: mockSql,
  jsonb: (value: unknown) => ({ __jsonb: value }),
}));

vi.mock('@/lib/shared/writable-subscription', () => ({
  assertWritableSubscriptionForAccount: (...args: unknown[]) =>
    mockAssertWritableSubscriptionForAccount(...args),
}));

vi.mock('@/lib/audit/log', () => ({
  writeAccountAuditLog: (...args: unknown[]) => mockWriteAccountAuditLog(...args),
}));

vi.mock('uuid', () => ({
  v7: vi.fn(() => '019dc366-29ce-7000-a000-000000000123'),
}));

const ACCOUNT_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const ACTOR_USER_ID = '11111111-0000-0000-0000-000000000001';
const LOCATION_1 = 'bbbbbbbb-0000-0000-0000-000000000001';
const LOCATION_2 = 'bbbbbbbb-0000-0000-0000-000000000002';

function resetDb(): void {
  dbState.accountExists = true;
  dbState.accountDefault = null;
  dbState.locations = [
    { id: LOCATION_1, name: 'Main Cafe', displayLabel: 'Main', archivedAt: null },
    { id: LOCATION_2, name: 'East Cafe', displayLabel: null, archivedAt: null },
  ];
  dbState.overrides = new Map();
  dbState.offboarding = null;
}

function enableReadiness(): void {
  process.env.AUTO_APPROVAL_ENABLED = 'true';
  process.env.OPENAI_MODERATION_ENABLED = 'true';
  process.env.AUTO_APPROVAL_PROVIDER_MODERATION_READY = 'true';
  delete process.env.VERCEL_ENV;
  mockAssertWritableSubscriptionForAccount.mockResolvedValue({ ok: true });
}

describe('auto-approval settings service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlCalls.length = 0;
    resetDb();
    enableReadiness();
    mockSql.begin = vi.fn(async (cb: (tx: typeof mockSql) => Promise<unknown>) => cb(mockSql));
  });

  it('returns account default, per-location overrides, effective policy, and readiness', async () => {
    dbState.accountDefault = { id: 'policy-default', threshold: 4 };
    dbState.overrides.set(LOCATION_2, { id: 'policy-east-manual', threshold: null });

    const { getAutoApprovalSettings } = await import('../settings');

    const result = await getAutoApprovalSettings({
      accountId: ACCOUNT_ID,
      impersonated: false,
    });

    expect(result.accountDefault).toEqual({
      policyId: 'policy-default',
      threshold: 4,
      exists: true,
    });
    expect(result.locations).toEqual([
      {
        locationId: LOCATION_1,
        displayName: 'Main',
        override: { policyId: null, threshold: null, exists: false },
        effective: { threshold: 4, source: 'account_default', inherited: true },
      },
      {
        locationId: LOCATION_2,
        displayName: 'East Cafe',
        override: { policyId: 'policy-east-manual', threshold: null, exists: true },
        effective: { threshold: null, source: 'location_override', inherited: false },
      },
    ]);
    expect(result.readiness).toMatchObject({
      runtimeEnabled: true,
      providerModerationEnabled: true,
      providerModerationValidated: true,
      accountWritable: true,
      canExpand: true,
      blockReasons: [],
    });
  });

  it('requires standard confirmation for account-default expansion even with zero active inheriting locations', async () => {
    dbState.locations = [];
    const { AutoApprovalConfirmationRequiredError, patchAutoApprovalSettings } =
      await import('../settings');

    let caught: unknown;
    try {
      await patchAutoApprovalSettings({
        accountId: ACCOUNT_ID,
        actorUserId: ACTOR_USER_ID,
        impersonated: false,
        operation: 'set_account_default',
        threshold: 4,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AutoApprovalConfirmationRequiredError);
    expect(caught).toMatchObject({ confirmationLevel: 'standard' });
    expect(mockSql.begin).toHaveBeenCalled();
    expect(sqlCalls.some((call) => call.text.includes('FOR UPDATE'))).toBe(true);
  });

  it('allows confirmed account-default expansion even with zero active inheriting locations', async () => {
    dbState.locations = [];
    const { patchAutoApprovalSettings } = await import('../settings');

    const result = await patchAutoApprovalSettings({
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
      impersonated: false,
      operation: 'set_account_default',
      threshold: 4,
      confirmationLevel: 'standard',
    });

    expect(result.accountDefault.threshold).toBe(4);
  });

  it('allows contractions while readiness is blocked and writes audit in the same transaction', async () => {
    dbState.accountDefault = { id: 'policy-default', threshold: 3 };
    process.env.AUTO_APPROVAL_ENABLED = 'false';
    process.env.OPENAI_MODERATION_ENABLED = 'false';
    mockAssertWritableSubscriptionForAccount.mockResolvedValue({
      ok: false,
      status: 403,
      error: 'subscription_inactive',
    });

    const { patchAutoApprovalSettings } = await import('../settings');

    const result = await patchAutoApprovalSettings({
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
      impersonated: false,
      operation: 'set_account_manual',
    });

    expect(result.accountDefault).toEqual({
      policyId: 'policy-default',
      threshold: null,
      exists: true,
    });
    expect(result.readiness.blockReasons).toContain('auto_approval_disabled');
    expect(result.readiness.blockReasons).toContain('provider_moderation_disabled');
    expect(result.readiness.blockReasons).toContain('subscription_not_writable');
    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: ACCOUNT_ID,
        actorUserId: ACTOR_USER_ID,
        eventType: 'auto_approval_policy_changed',
        payload: expect.objectContaining({
          operation: 'set_account_manual',
          expansion: false,
        }),
      }),
      mockSql,
    );
  });

  it('blocks expansion while cancel-only scheduled offboarding is active', async () => {
    dbState.offboarding = {
      id: '22222222-2222-7333-8444-555555555555',
      account_id: ACCOUNT_ID,
      mode: 'cancel_only',
      status: 'scheduled',
      failed_step: null,
      terminal_at: null,
      access_ends_at: new Date('2026-07-01T00:00:00.000Z'),
      teardown_started_at: null,
      purge_after: null,
      purge_started_at: null,
      purge_cancelled_at: null,
    };

    const { AutoApprovalExpansionBlockedError, patchAutoApprovalSettings } =
      await import('../settings');

    let caught: unknown;
    try {
      await patchAutoApprovalSettings({
        accountId: ACCOUNT_ID,
        actorUserId: ACTOR_USER_ID,
        impersonated: false,
        operation: 'set_account_default',
        threshold: 4,
        confirmationLevel: 'standard',
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AutoApprovalExpansionBlockedError);
    expect(caught).toMatchObject({
      blockReasons: ['subscription_not_writable'],
    });
  });

  it('requires all-ratings confirmation when deleting a manual override inherits all rated', async () => {
    dbState.accountDefault = { id: 'policy-default', threshold: 1 };
    dbState.overrides.set(LOCATION_1, { id: 'policy-main-manual', threshold: null });
    const { patchAutoApprovalSettings } = await import('../settings');

    await expect(
      patchAutoApprovalSettings({
        accountId: ACCOUNT_ID,
        actorUserId: ACTOR_USER_ID,
        impersonated: false,
        operation: 'delete_location_override',
        locationId: LOCATION_1,
        confirmationLevel: 'standard',
      }),
    ).rejects.toMatchObject({ confirmationLevel: 'all_ratings' });
  });

  it('rejects deleting a manual override on an archived location when it would expand', async () => {
    dbState.accountDefault = { id: 'policy-default', threshold: 4 };
    dbState.locations = [
      { id: LOCATION_1, name: 'Old Cafe', displayLabel: 'Old', archivedAt: new Date('2026-01-01T00:00:00Z') },
    ];
    dbState.overrides.set(LOCATION_1, { id: 'policy-main-manual', threshold: null });
    const { AutoApprovalSettingsError, patchAutoApprovalSettings } = await import('../settings');

    let caught: unknown;
    try {
      await patchAutoApprovalSettings({
        accountId: ACCOUNT_ID,
        actorUserId: ACTOR_USER_ID,
        impersonated: false,
        operation: 'delete_location_override',
        locationId: LOCATION_1,
        confirmationLevel: 'all_ratings',
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AutoApprovalSettingsError);
    expect(caught).toMatchObject({ code: 'location_inactive', status: 409 });
  });

  it('allows deleting an override on an archived location when it does not expand', async () => {
    dbState.accountDefault = null;
    dbState.locations = [
      { id: LOCATION_1, name: 'Old Cafe', displayLabel: 'Old', archivedAt: new Date('2026-01-01T00:00:00Z') },
    ];
    dbState.overrides.set(LOCATION_1, { id: 'policy-main', threshold: 4 });
    const { patchAutoApprovalSettings } = await import('../settings');

    await expect(
      patchAutoApprovalSettings({
        accountId: ACCOUNT_ID,
        actorUserId: ACTOR_USER_ID,
        impersonated: false,
        operation: 'delete_location_override',
        locationId: LOCATION_1,
      }),
    ).resolves.toBeDefined();
    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          operation: 'delete_location_override',
          expansion: false,
        }),
      }),
      mockSql,
    );
  });

  it('rejects a locationId that does not belong to the session account', async () => {
    const FOREIGN_LOCATION = 'cccccccc-0000-0000-0000-000000000099';
    const { AutoApprovalSettingsError, patchAutoApprovalSettings } = await import('../settings');

    let caught: unknown;
    try {
      await patchAutoApprovalSettings({
        accountId: ACCOUNT_ID,
        actorUserId: ACTOR_USER_ID,
        impersonated: false,
        operation: 'set_location_manual',
        locationId: FOREIGN_LOCATION,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AutoApprovalSettingsError);
    expect(caught).toMatchObject({ code: 'location_not_found', status: 404 });
  });

  it('allows deleting a location override that contracts exposure without confirmation', async () => {
    dbState.accountDefault = null;
    dbState.overrides.set(LOCATION_1, { id: 'policy-main', threshold: 4 });
    const { patchAutoApprovalSettings } = await import('../settings');

    const result = await patchAutoApprovalSettings({
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
      impersonated: false,
      operation: 'delete_location_override',
      locationId: LOCATION_1,
    });

    const location = result.locations.find((entry) => entry.locationId === LOCATION_1);
    expect(location?.override).toEqual({ policyId: null, threshold: null, exists: false });
    expect(location?.effective.threshold).toBeNull();
    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          operation: 'delete_location_override',
          expansion: false,
        }),
      }),
      mockSql,
    );
  });

  it('records affectedActiveLocationCount across inheriting active locations', async () => {
    const { patchAutoApprovalSettings } = await import('../settings');

    await patchAutoApprovalSettings({
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
      impersonated: false,
      operation: 'set_account_default',
      threshold: 4,
      confirmationLevel: 'standard',
    });

    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          operation: 'set_account_default',
          expansion: true,
          affectedActiveLocationCount: 2,
          futureDefaultApplies: true,
        }),
      }),
      mockSql,
    );
  });

  it('performs no policy write when an expansion is blocked (gate runs before applyMutation)', async () => {
    // Readiness is not ready, so an expansion must be rejected. The structural
    // guarantee under test: the upsert/delete never runs and no audit row is
    // written — proven directly via the sql call log, NOT via transaction rollback.
    process.env.AUTO_APPROVAL_ENABLED = 'false';
    const { AutoApprovalExpansionBlockedError, patchAutoApprovalSettings } =
      await import('../settings');

    let caught: unknown;
    try {
      await patchAutoApprovalSettings({
        accountId: ACCOUNT_ID,
        actorUserId: ACTOR_USER_ID,
        impersonated: false,
        operation: 'set_account_default',
        threshold: 4,
        confirmationLevel: 'standard',
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AutoApprovalExpansionBlockedError);

    const wrotePolicy = sqlCalls.some(
      (call) =>
        call.text.includes('INSERT INTO auto_approval_policies') ||
        call.text.includes('DELETE FROM auto_approval_policies'),
    );
    expect(wrotePolicy).toBe(false);
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
  });
});
