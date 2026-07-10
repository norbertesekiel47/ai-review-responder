import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutoApprovalThreshold } from '../types';

const {
  mockAssertWritableSubscriptionForAccount,
  mockWriteAccountAuditLog,
} = vi.hoisted(() => ({
  mockAssertWritableSubscriptionForAccount: vi.fn(),
  mockWriteAccountAuditLog: vi.fn(),
}));

type Policy = {
  id: string;
  threshold: AutoApprovalThreshold | null;
  vetoWindowMinutes?: 15 | 30;
  dailyAutoPostCap?: number | null;
  suspendedAt?: Date | null;
  suspendedReason?: string | null;
};
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
  veto_window_minutes: policy.vetoWindowMinutes ?? 15,
  daily_auto_post_cap: policy.dailyAutoPostCap ?? null,
  suspended_at: policy.suspendedAt ?? null,
  suspended_reason: policy.suspendedReason ?? null,
});

function applyUpsertColumn(base: Policy, text: string, value: unknown): Policy {
  if (text.includes('auto_approve_min_star = EXCLUDED.auto_approve_min_star')) {
    return { ...base, threshold: value as AutoApprovalThreshold | null };
  }
  if (text.includes('veto_window_minutes = EXCLUDED.veto_window_minutes')) {
    return { ...base, vetoWindowMinutes: value as 15 | 30 };
  }
  if (text.includes('daily_auto_post_cap = EXCLUDED.daily_auto_post_cap')) {
    return { ...base, dailyAutoPostCap: value as number | null };
  }
  throw new Error(`unrecognized auto_approval_policies upsert: ${text}`);
}

// Content-routing mock (not the generic FIFO `createMockSql` harness): the
// flows under test interleave many distinct reads/writes against mutable
// `dbState`, so each query must resolve based on WHICH query it is, not just
// "next queued result" — precise, not permissive (spec §2.1's target is
// killing hand-rolled mocks that weaken assertions; this one is stricter).
// `settings.ts` now takes `sql` as an explicit parameter, so this stands in
// for that argument directly — no `vi.mock('@/lib/db/server', ...)` needed.
const mockSql: any = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
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
          veto_window_minutes: override ? override.vetoWindowMinutes ?? 15 : null,
          daily_auto_post_cap: override?.dailyAutoPostCap ?? null,
          suspended_at: override?.suspendedAt ?? null,
          suspended_reason: override?.suspendedReason ?? null,
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

  // Mirrors the real upserts: one owner-facing column per operation, chosen by
  // the DO UPDATE SET column; a fresh insert starts from a NULL threshold.
  // Value positions follow the INSERT lists in settings.ts (persona and
  // action_class are bound parameters, so they occupy value slots).
  if (
    text.includes('INSERT INTO auto_approval_policies') &&
    text.includes('ON CONFLICT (account_id, persona, action_class) WHERE location_id IS NULL')
  ) {
    const base: Policy = dbState.accountDefault ?? {
      id: 'policy-account-default',
      threshold: null,
    };
    dbState.accountDefault = applyUpsertColumn(base, text, values[4]);
    return [];
  }

  if (
    text.includes('INSERT INTO auto_approval_policies') &&
    text.includes(
      'ON CONFLICT (account_id, location_id, persona, action_class) WHERE location_id IS NOT NULL',
    )
  ) {
    const locationId = values[2] as string;
    const base: Policy = dbState.overrides.get(locationId) ?? {
      id: `policy-${locationId}`,
      threshold: null,
    };
    dbState.overrides.set(locationId, applyUpsertColumn(base, text, values[5]));
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
mockSql.begin = vi.fn(async (cb: (tx: typeof mockSql) => Promise<unknown>) => cb(mockSql));

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
    dbState.accountDefault = {
      id: 'policy-default',
      threshold: 4,
      vetoWindowMinutes: 30,
      dailyAutoPostCap: 25,
    };
    dbState.overrides.set(LOCATION_2, { id: 'policy-east-manual', threshold: null });

    const { getAutoApprovalSettings } = await import('../settings');

    const result = await getAutoApprovalSettings(mockSql, {
      accountId: ACCOUNT_ID,
      impersonated: false,
    });

    expect(result.accountDefault).toEqual({
      policyId: 'policy-default',
      threshold: 4,
      exists: true,
      vetoWindowMinutes: 30,
      dailyAutoPostCap: 25,
      effectiveDailyCap: 25,
      suspended: false,
      suspendedReason: null,
    });
    expect(result.locations).toEqual([
      {
        locationId: LOCATION_1,
        displayName: 'Main',
        override: {
          policyId: null,
          threshold: null,
          exists: false,
          vetoWindowMinutes: 15,
          dailyAutoPostCap: null,
          effectiveDailyCap: 10,
          suspended: false,
          suspendedReason: null,
        },
        // Inherits the account default's dial values along with the threshold.
        effective: {
          threshold: 4,
          source: 'account_default',
          inherited: true,
          vetoWindowMinutes: 30,
          dailyAutoPostCap: 25,
          effectiveDailyCap: 25,
          suspended: false,
        },
      },
      {
        locationId: LOCATION_2,
        displayName: 'East Cafe',
        override: {
          policyId: 'policy-east-manual',
          threshold: null,
          exists: true,
          vetoWindowMinutes: 15,
          dailyAutoPostCap: null,
          effectiveDailyCap: 10,
          suspended: false,
          suspendedReason: null,
        },
        // A present override shadows the account default's dial values too.
        effective: {
          threshold: null,
          source: 'location_override',
          inherited: false,
          vetoWindowMinutes: 15,
          dailyAutoPostCap: null,
          effectiveDailyCap: 10,
          suspended: false,
        },
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
      await patchAutoApprovalSettings(mockSql, {
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

    const result = await patchAutoApprovalSettings(mockSql, {
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
    dbState.accountDefault = { id: 'policy-default', threshold: 4 };
    process.env.AUTO_APPROVAL_ENABLED = 'false';
    process.env.OPENAI_MODERATION_ENABLED = 'false';
    mockAssertWritableSubscriptionForAccount.mockResolvedValue({
      ok: false,
      status: 403,
      error: 'subscription_inactive',
    });

    const { patchAutoApprovalSettings } = await import('../settings');

    const result = await patchAutoApprovalSettings(mockSql, {
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
      impersonated: false,
      operation: 'set_account_manual',
    });

    expect(result.accountDefault).toMatchObject({
      policyId: 'policy-default',
      threshold: null,
      exists: true,
    });
    expect(result.readiness.blockReasons).toContain('auto_approval_disabled');
    expect(result.readiness.blockReasons).toContain('provider_moderation_disabled');
    expect(result.readiness.blockReasons).toContain('subscription_not_writable');
    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      mockSql,
      expect.objectContaining({
        accountId: ACCOUNT_ID,
        actorUserId: ACTOR_USER_ID,
        eventType: 'auto_approval_policy_changed',
        payload: expect.objectContaining({
          operation: 'set_account_manual',
          expansion: false,
        }),
      }),
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
      await patchAutoApprovalSettings(mockSql, {
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

  it('requires standard confirmation when deleting a manual override inherits an expansion', async () => {
    dbState.accountDefault = { id: 'policy-default', threshold: 4 };
    dbState.overrides.set(LOCATION_1, { id: 'policy-main-manual', threshold: null });
    const { patchAutoApprovalSettings } = await import('../settings');

    await expect(
      patchAutoApprovalSettings(mockSql, {
        accountId: ACCOUNT_ID,
        actorUserId: ACTOR_USER_ID,
        impersonated: false,
        operation: 'delete_location_override',
        locationId: LOCATION_1,
      }),
    ).rejects.toMatchObject({ confirmationLevel: 'standard' });
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
      await patchAutoApprovalSettings(mockSql, {
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
      patchAutoApprovalSettings(mockSql, {
        accountId: ACCOUNT_ID,
        actorUserId: ACTOR_USER_ID,
        impersonated: false,
        operation: 'delete_location_override',
        locationId: LOCATION_1,
      }),
    ).resolves.toBeDefined();
    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      mockSql,
      expect.objectContaining({
        payload: expect.objectContaining({
          operation: 'delete_location_override',
          expansion: false,
        }),
      }),
    );
  });

  it('rejects a locationId that does not belong to the session account', async () => {
    const FOREIGN_LOCATION = 'cccccccc-0000-0000-0000-000000000099';
    const { AutoApprovalSettingsError, patchAutoApprovalSettings } = await import('../settings');

    let caught: unknown;
    try {
      await patchAutoApprovalSettings(mockSql, {
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

    const result = await patchAutoApprovalSettings(mockSql, {
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
      impersonated: false,
      operation: 'delete_location_override',
      locationId: LOCATION_1,
    });

    const location = result.locations.find((entry) => entry.locationId === LOCATION_1);
    expect(location?.override).toMatchObject({ policyId: null, threshold: null, exists: false });
    expect(location?.effective.threshold).toBeNull();
    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      mockSql,
      expect.objectContaining({
        payload: expect.objectContaining({
          operation: 'delete_location_override',
          expansion: false,
        }),
      }),
    );
  });

  it('records affectedActiveLocationCount across inheriting active locations', async () => {
    const { patchAutoApprovalSettings } = await import('../settings');

    await patchAutoApprovalSettings(mockSql, {
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
      impersonated: false,
      operation: 'set_account_default',
      threshold: 4,
      confirmationLevel: 'standard',
    });

    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      mockSql,
      expect.objectContaining({
        payload: expect.objectContaining({
          operation: 'set_account_default',
          expansion: true,
          affectedActiveLocationCount: 2,
          futureDefaultApplies: true,
        }),
      }),
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
      await patchAutoApprovalSettings(mockSql, {
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

  it('accepts a stale all_ratings confirmation as satisfying the standard expansion confirmation', async () => {
    // Stale-client tolerance (types.ts schema comment): 'all_ratings' died
    // with the 1-star threshold but must keep satisfying 'standard' for one
    // release, exactly as the pre-WS4 confirmationSatisfies did.
    const { patchAutoApprovalSettings } = await import('../settings');

    const result = await patchAutoApprovalSettings(mockSql, {
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
      impersonated: false,
      operation: 'set_account_default',
      threshold: 4,
      confirmationLevel: 'all_ratings',
    });

    expect(result.accountDefault.threshold).toBe(4);
  });

  it('pins every upsert ON CONFLICT target byte-for-byte against the migration-074 rebuilt indexes', async () => {
    dbState.accountDefault = { id: 'policy-default', threshold: 4 };
    const { patchAutoApprovalSettings } = await import('../settings');
    const base = {
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
      impersonated: false,
    } as const;

    await patchAutoApprovalSettings(mockSql, { ...base, operation: 'set_account_manual' });
    await patchAutoApprovalSettings(mockSql, { ...base, operation: 'set_account_veto_window', minutes: 30 });
    await patchAutoApprovalSettings(mockSql, { ...base, operation: 'set_account_daily_cap', cap: 25 });
    await patchAutoApprovalSettings(mockSql, { ...base, operation: 'set_location_manual', locationId: LOCATION_1 });
    await patchAutoApprovalSettings(mockSql, { ...base, operation: 'set_location_veto_window', locationId: LOCATION_1, minutes: 30 });
    await patchAutoApprovalSettings(mockSql, { ...base, operation: 'set_location_daily_cap', locationId: LOCATION_1, cap: 25 });

    const upserts = sqlCalls
      .filter((call) => call.text.includes('INSERT INTO auto_approval_policies'))
      .map((call) => call.text.replace(/\s+/g, ' '));
    expect(upserts).toHaveLength(6);

    // Byte-for-byte the predicates of auto_approval_policies_one_account_default
    // and auto_approval_policies_one_location_override (migration 074) — a
    // drifted clause fails at runtime with no-matching-constraint.
    const accountTarget = 'ON CONFLICT (account_id, persona, action_class) WHERE location_id IS NULL';
    const locationTarget = 'ON CONFLICT (account_id, location_id, persona, action_class) WHERE location_id IS NOT NULL';
    for (const text of upserts.slice(0, 3)) expect(text).toContain(accountTarget);
    for (const text of upserts.slice(3)) expect(text).toContain(locationTarget);
  });

  it('sets the account veto window without confirmation and preserves the threshold', async () => {
    dbState.accountDefault = { id: 'policy-default', threshold: 4, dailyAutoPostCap: 25 };
    const { patchAutoApprovalSettings } = await import('../settings');

    const result = await patchAutoApprovalSettings(mockSql, {
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
      impersonated: false,
      operation: 'set_account_veto_window',
      minutes: 30,
    });

    expect(result.accountDefault).toMatchObject({
      policyId: 'policy-default',
      threshold: 4,
      vetoWindowMinutes: 30,
      dailyAutoPostCap: 25,
    });
    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      mockSql,
      expect.objectContaining({
        payload: expect.objectContaining({
          operation: 'set_account_veto_window',
          expansion: false,
          requiredConfirmationLevel: null,
        }),
      }),
    );
  });

  it('reverts the account daily cap to the platform default with a null cap', async () => {
    dbState.accountDefault = { id: 'policy-default', threshold: 4, dailyAutoPostCap: 25 };
    const { patchAutoApprovalSettings } = await import('../settings');

    const result = await patchAutoApprovalSettings(mockSql, {
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
      impersonated: false,
      operation: 'set_account_daily_cap',
      cap: null,
    });

    expect(result.accountDefault).toMatchObject({
      threshold: 4,
      dailyAutoPostCap: null,
      effectiveDailyCap: 10,
    });
  });

  it('creates a NULL-threshold override row when a dial change targets a location without one', async () => {
    // Pinned semantics: the dial is meaningful before a threshold is chosen,
    // and a fresh override starts on manual approval — creating it via a dial
    // change therefore CONTRACTS the location to manual (override shadows the
    // account default), never expands, so no confirmation is required.
    dbState.accountDefault = { id: 'policy-default', threshold: 4 };
    const { patchAutoApprovalSettings } = await import('../settings');

    const result = await patchAutoApprovalSettings(mockSql, {
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
      impersonated: false,
      operation: 'set_location_daily_cap',
      locationId: LOCATION_1,
      cap: 25,
    });

    const location = result.locations.find((entry) => entry.locationId === LOCATION_1);
    expect(location?.override).toMatchObject({
      exists: true,
      threshold: null,
      dailyAutoPostCap: 25,
      effectiveDailyCap: 25,
    });
    expect(location?.effective).toMatchObject({
      threshold: null,
      source: 'location_override',
      inherited: false,
      effectiveDailyCap: 25,
    });
    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      mockSql,
      expect.objectContaining({
        payload: expect.objectContaining({
          operation: 'set_location_daily_cap',
          expansion: false,
          beforeEffectiveThreshold: 4,
          afterEffectiveThreshold: null,
        }),
      }),
    );
  });

  it('surfaces suspension in the GET payload and blocks expansion with policy_suspended', async () => {
    dbState.accountDefault = {
      id: 'policy-default',
      threshold: 5,
      suspendedAt: new Date('2026-07-08T00:00:00.000Z'),
      suspendedReason: 'governor_negative_feedback',
    };
    const {
      AutoApprovalExpansionBlockedError,
      getAutoApprovalSettings,
      patchAutoApprovalSettings,
    } = await import('../settings');

    const state = await getAutoApprovalSettings(mockSql, {
      accountId: ACCOUNT_ID,
      impersonated: false,
    });
    expect(state.accountDefault).toMatchObject({
      suspended: true,
      suspendedReason: 'governor_negative_feedback',
    });
    expect(state.readiness.canExpand).toBe(false);
    expect(state.readiness.blockReasons).toEqual(['policy_suspended']);
    // The account-level suspension rides the effective policy of every
    // inheriting location.
    expect(state.locations[0]?.effective.suspended).toBe(true);

    // 5★-only -> 4-5 loosens exposure: an expansion, blocked while suspended.
    await expect(
      patchAutoApprovalSettings(mockSql, {
        accountId: ACCOUNT_ID,
        actorUserId: ACTOR_USER_ID,
        impersonated: false,
        operation: 'set_account_default',
        threshold: 4,
        confirmationLevel: 'standard',
      }),
    ).rejects.toBeInstanceOf(AutoApprovalExpansionBlockedError);
  });

  it('allows contractions and dial changes while the policy is suspended', async () => {
    dbState.accountDefault = {
      id: 'policy-default',
      threshold: 4,
      suspendedAt: new Date('2026-07-08T00:00:00.000Z'),
      suspendedReason: 'governor_negative_feedback',
    };
    const { patchAutoApprovalSettings } = await import('../settings');

    const afterVeto = await patchAutoApprovalSettings(mockSql, {
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
      impersonated: false,
      operation: 'set_account_veto_window',
      minutes: 30,
    });
    expect(afterVeto.accountDefault.vetoWindowMinutes).toBe(30);

    const afterManual = await patchAutoApprovalSettings(mockSql, {
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
      impersonated: false,
      operation: 'set_account_manual',
    });
    expect(afterManual.accountDefault.threshold).toBeNull();
  });
});
