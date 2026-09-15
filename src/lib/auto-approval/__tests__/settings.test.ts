import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SubscriptionTier } from '@/lib/accounts/tier-config';
import { resetServerConfigForTests } from '@/lib/config/server';
import type { TransactionSql } from 'postgres';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import type { PatchAutoApprovalSettingsInput } from '../settings';
import type { AutoApprovalThreshold } from '../types';

const { mockWriteAccountAuditLog } = vi.hoisted(() => ({
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
// #631 D20: the Solicitation persona's one policy row (account default only).
type SolicitationPolicy = {
  id: string;
  vetoWindowMinutes: 30 | 60;
  dailySendCap: number | null;
  suspendedAt?: Date | null;
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
  subscriptionTier: SubscriptionTier.AUTOPILOT as string,
  subscriptionStatus: SubscriptionStatus.ACTIVE as string,
  pastDueAt: null as Date | string | null,
  flags: null as Record<string, unknown> | string | null,
  accountDefault: null as Policy | null,
  solicitationDefault: null as SolicitationPolicy | null,
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

// Mirrors the real upsert semantics: every INSERT now binds the full seeded
// (threshold, veto, cap) triple starting at `offset` in the values array; the
// conflict path applies only the single DO UPDATE column (EXCLUDED.<col> is
// the corresponding insert param).
function applyUpsertColumn(base: Policy, text: string, values: unknown[], offset: number): Policy {
  if (text.includes('auto_approve_min_star = EXCLUDED.auto_approve_min_star')) {
    return { ...base, threshold: values[offset] as AutoApprovalThreshold | null };
  }
  if (text.includes('veto_window_minutes = EXCLUDED.veto_window_minutes')) {
    return { ...base, vetoWindowMinutes: values[offset + 1] as 15 | 30 };
  }
  if (text.includes('daily_auto_post_cap = EXCLUDED.daily_auto_post_cap')) {
    return { ...base, dailyAutoPostCap: values[offset + 2] as number | null };
  }
  throw new Error(`unrecognized auto_approval_policies upsert: ${text}`);
}

// The fresh-insert path persists the whole seed, exactly like the real INSERT.
function freshPolicyFromInsert(values: unknown[], offset: number): Policy {
  return {
    id: values[0] as string,
    threshold: values[offset] as AutoApprovalThreshold | null,
    vetoWindowMinutes: values[offset + 1] as 15 | 30,
    dailyAutoPostCap: values[offset + 2] as number | null,
  };
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

  if (text.includes('FROM accounts') && text.includes('WHERE id =')) {
    return dbState.accountExists
      ? [{
          id: accountId,
          subscription_tier: dbState.subscriptionTier,
          subscription_status: dbState.subscriptionStatus,
          past_due_at: dbState.pastDueAt,
          flags: dbState.flags,
        }]
      : [];
  }

  if (text.includes('FROM account_offboardings')) {
    return dbState.offboarding ? [dbState.offboarding] : [];
  }

  // Solicitation branches route BEFORE their Reply counterparts: the SELECT
  // and INSERT texts are discriminated by the daily_send_cap column, the
  // DELETE (textually identical to the Reply account-default delete) by the
  // bound persona value.
  if (
    text.includes('FROM auto_approval_policies') &&
    text.includes('daily_send_cap') &&
    text.includes('LIMIT 1')
  ) {
    return dbState.solicitationDefault
      ? [{
          id: dbState.solicitationDefault.id,
          veto_window_minutes: dbState.solicitationDefault.vetoWindowMinutes,
          daily_send_cap: dbState.solicitationDefault.dailySendCap,
          suspended_at: dbState.solicitationDefault.suspendedAt ?? null,
        }]
      : [];
  }

  if (text.includes('SELECT EXISTS') && text.includes('suspended_at IS NOT NULL')) {
    const anySuspended =
      Boolean(dbState.accountDefault?.suspendedAt)
      || Boolean(dbState.solicitationDefault?.suspendedAt)
      || [...dbState.overrides.values()].some((policy) => Boolean(policy.suspendedAt));
    return [{ any_suspended: anySuspended }];
  }

  if (
    text.includes('INSERT INTO auto_approval_policies') &&
    text.includes('daily_send_cap = EXCLUDED.daily_send_cap')
  ) {
    // values: [policyId, accountId, persona, action_class, veto, cap]; the
    // conflict path keeps the existing row id, exactly like the real upsert.
    const existing = dbState.solicitationDefault;
    dbState.solicitationDefault = {
      id: existing?.id ?? (values[0] as string),
      vetoWindowMinutes: values[4] as 30 | 60,
      dailySendCap: values[5] as number | null,
      suspendedAt: existing?.suspendedAt ?? null,
    };
    return [];
  }

  if (
    text.includes('DELETE FROM auto_approval_policies') &&
    values.includes('solicitation')
  ) {
    dbState.solicitationDefault = null;
    return [];
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

  // Mirrors the real upserts: the INSERT arm persists the full seeded
  // (threshold, veto, cap) triple; the conflict path applies only the single
  // DO UPDATE column. Value positions follow the INSERT lists in settings.ts
  // (persona and action_class are bound parameters, so they occupy value
  // slots; the account default's location_id is a literal NULL).
  if (
    text.includes('INSERT INTO auto_approval_policies') &&
    text.includes('ON CONFLICT (account_id, persona, action_class) WHERE location_id IS NULL')
  ) {
    dbState.accountDefault = dbState.accountDefault
      ? applyUpsertColumn(dbState.accountDefault, text, values, 4)
      : freshPolicyFromInsert(values, 4);
    return [];
  }

  if (
    text.includes('INSERT INTO auto_approval_policies') &&
    text.includes(
      'ON CONFLICT (account_id, location_id, persona, action_class) WHERE location_id IS NOT NULL',
    )
  ) {
    const locationId = values[2] as string;
    const existing = dbState.overrides.get(locationId);
    dbState.overrides.set(
      locationId,
      existing ? applyUpsertColumn(existing, text, values, 5) : freshPolicyFromInsert(values, 5),
    );
    return [];
  }

  // Suspension-preserving clear: NULL the threshold, keep everything else.
  if (text.includes('UPDATE auto_approval_policies') && text.includes('location_id IS NULL')) {
    if (dbState.accountDefault) {
      dbState.accountDefault = { ...dbState.accountDefault, threshold: null };
    }
    return [];
  }

  if (text.includes('UPDATE auto_approval_policies') && text.includes('location_id =')) {
    const locationId = values[1] as string;
    const override = dbState.overrides.get(locationId);
    if (override) dbState.overrides.set(locationId, { ...override, threshold: null });
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
  dbState.subscriptionTier = SubscriptionTier.AUTOPILOT;
  dbState.subscriptionStatus = SubscriptionStatus.ACTIVE;
  dbState.pastDueAt = null;
  dbState.flags = null;
  dbState.accountDefault = null;
  dbState.solicitationDefault = null;
  dbState.locations = [
    { id: LOCATION_1, name: 'Main Cafe', displayLabel: 'Main', archivedAt: null },
    { id: LOCATION_2, name: 'East Cafe', displayLabel: null, archivedAt: null },
  ];
  dbState.overrides = new Map();
  dbState.offboarding = null;
}

function enableReadiness(): void {
  process.env.AUTO_APPROVAL_ENABLED = 'true';
  process.env.AUTOPILOT_PURCHASABLE = 'true';
  process.env.OPENAI_MODERATION_ENABLED = 'true';
  process.env.AUTO_APPROVAL_PROVIDER_MODERATION_READY = 'true';
  delete process.env.VERCEL_ENV;
  resetServerConfigForTests();
}

function expectSuccessfulRowlessDialContraction(): void {
  expect(sqlCalls.filter((call) => call.text.includes('FROM accounts') && call.text.includes('FOR UPDATE')))
    .toHaveLength(1);
  expect(sqlCalls.filter((call) => call.text.includes('FROM account_offboardings')))
    .toHaveLength(3);
  expect(sqlCalls.filter((call) => call.text.includes('INSERT INTO auto_approval_policies')))
    .toHaveLength(1);
  expect(mockWriteAccountAuditLog).toHaveBeenCalledTimes(1);
  expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
    mockSql,
    expect.objectContaining({
      payload: expect.objectContaining({
        exposureClassification: 'contraction',
        expansion: false,
        requiredConfirmationLevel: null,
        submittedConfirmationLevel: null,
      }),
    }),
  );
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
    const { patchAutoApprovalSettings } = await import('../settings');
    const { AutoApprovalConfirmationRequiredError } = await import('../settings-guards');

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
    const accountReads = sqlCalls.filter((call) => call.text.includes('FROM accounts'));
    expect(accountReads).toHaveLength(1);
    expect(accountReads[0]?.text).toContain('subscription_tier');
    expect(accountReads[0]?.text).toContain('subscription_status');
    expect(accountReads[0]?.text).toContain('FOR UPDATE');
  });

  it('GET reports only autopilot_unavailable for a writable Copilot account', async () => {
    dbState.subscriptionTier = SubscriptionTier.COPILOT;
    const { getAutoApprovalSettings } = await import('../settings');

    const result = await getAutoApprovalSettings(mockSql, {
      accountId: ACCOUNT_ID,
      impersonated: false,
    });

    expect(result.readiness).toMatchObject({
      accountWritable: true,
      canExpand: false,
      blockReasons: ['autopilot_unavailable'],
    });
    expect(result.readiness).not.toHaveProperty('autopilotPurchasable');
  });

  it('allows a trialing Autopilot account to expand', async () => {
    dbState.subscriptionStatus = SubscriptionStatus.TRIALING;
    const { patchAutoApprovalSettings } = await import('../settings');

    const result = await patchAutoApprovalSettings(mockSql, {
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
      impersonated: false,
      operation: 'set_account_default',
      threshold: 5,
      confirmationLevel: 'standard',
    });

    expect(result.readiness.canExpand).toBe(true);
    expect(result.accountDefault).toMatchObject({ exists: true, threshold: 5 });
    expect(dbState.accountDefault).toMatchObject({ threshold: 5 });
    expect(mockWriteAccountAuditLog).toHaveBeenCalledTimes(1);
    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      mockSql,
      expect.objectContaining({
        accountId: ACCOUNT_ID,
        actorUserId: ACTOR_USER_ID,
        eventType: 'auto_approval_policy_changed',
        payload: expect.objectContaining({
          operation: 'set_account_default',
          expansion: true,
          afterEffectiveThreshold: 5,
        }),
      }),
    );
  });

  it('allows past-due grace but blocks expansion after the grace window', async () => {
    dbState.subscriptionStatus = SubscriptionStatus.PAST_DUE;
    dbState.pastDueAt = new Date(Date.now() - 86_400_000);
    const { patchAutoApprovalSettings } = await import('../settings');
    const { AutoApprovalExpansionBlockedError } = await import('../settings-guards');

    const result = await patchAutoApprovalSettings(mockSql, {
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
      impersonated: false,
      operation: 'set_account_default',
      threshold: 5,
      confirmationLevel: 'standard',
    });

    expect(result.readiness.accountWritable).toBe(true);
    expect(result.accountDefault).toMatchObject({ exists: true, threshold: 5 });
    expect(dbState.accountDefault).toMatchObject({ threshold: 5 });

    dbState.accountDefault = null;
    dbState.pastDueAt = new Date(Date.now() - 8 * 86_400_000);
    await expect(patchAutoApprovalSettings(mockSql, {
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
      impersonated: false,
      operation: 'set_account_default',
      threshold: 5,
      confirmationLevel: 'standard',
    })).rejects.toBeInstanceOf(AutoApprovalExpansionBlockedError);
    expect(mockWriteAccountAuditLog).toHaveBeenCalledTimes(1);
  });

  it('blocks expansion when the sale gate closes but still allows contraction', async () => {
    dbState.accountDefault = { id: 'policy-default', threshold: 5 };
    process.env.AUTOPILOT_PURCHASABLE = 'false';
    resetServerConfigForTests();
    const { patchAutoApprovalSettings } = await import('../settings');

    await expect(patchAutoApprovalSettings(mockSql, {
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
      impersonated: false,
      operation: 'set_account_default',
      threshold: 4,
      confirmationLevel: 'standard',
    })).rejects.toMatchObject({
      name: 'AutoApprovalExpansionBlockedError',
      blockReasons: ['autopilot_unavailable'],
    });

    const contracted = await patchAutoApprovalSettings(mockSql, {
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
      impersonated: false,
      operation: 'set_account_manual',
    });
    expect(contracted.accountDefault.threshold).toBeNull();
    expect(contracted.readiness.blockReasons).toEqual(['autopilot_unavailable']);
  });

  it('allows a Copilot rowless location veto change that creates a manual override', async () => {
    dbState.subscriptionTier = SubscriptionTier.COPILOT;
    dbState.accountDefault = {
      id: 'policy-default',
      threshold: 4,
      vetoWindowMinutes: 30,
      dailyAutoPostCap: 2,
    };
    const { patchAutoApprovalSettings } = await import('../settings');

    const result = await patchAutoApprovalSettings(mockSql, {
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
      impersonated: false,
      operation: 'set_location_veto_window',
      locationId: LOCATION_1,
      minutes: 15,
    });

    expect(result.locations.find((entry) => entry.locationId === LOCATION_1)?.override)
      .toMatchObject({ exists: true, threshold: null, vetoWindowMinutes: 15 });
    expectSuccessfulRowlessDialContraction();
  });

  it('allows a rowless location cap change when the Autopilot sale gate is closed', async () => {
    dbState.accountDefault = {
      id: 'policy-default',
      threshold: 4,
      vetoWindowMinutes: 30,
      dailyAutoPostCap: 2,
    };
    process.env.AUTOPILOT_PURCHASABLE = 'false';
    resetServerConfigForTests();
    const { patchAutoApprovalSettings } = await import('../settings');

    const result = await patchAutoApprovalSettings(mockSql, {
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
      impersonated: false,
      operation: 'set_location_daily_cap',
      locationId: LOCATION_1,
      cap: 5,
    });

    expect(result.locations.find((entry) => entry.locationId === LOCATION_1)?.override)
      .toMatchObject({ exists: true, threshold: null, dailyAutoPostCap: 5 });
    expectSuccessfulRowlessDialContraction();
  });

  it('allows a rowless location veto change while the inherited policy is suspended', async () => {
    dbState.accountDefault = {
      id: 'policy-default',
      threshold: 4,
      vetoWindowMinutes: 30,
      dailyAutoPostCap: 2,
      suspendedAt: new Date('2026-07-08T00:00:00.000Z'),
      suspendedReason: 'governor_negative_feedback',
    };
    const { patchAutoApprovalSettings } = await import('../settings');

    const result = await patchAutoApprovalSettings(mockSql, {
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
      impersonated: false,
      operation: 'set_location_veto_window',
      locationId: LOCATION_1,
      minutes: 15,
    });

    expect(result.locations.find((entry) => entry.locationId === LOCATION_1)?.effective)
      .toMatchObject({ threshold: null, vetoWindowMinutes: 15, suspended: true });
    expectSuccessfulRowlessDialContraction();
  });

  it('still blocks widening a dial on an existing location override for Copilot', async () => {
    dbState.subscriptionTier = SubscriptionTier.COPILOT;
    dbState.accountDefault = {
      id: 'policy-default',
      threshold: 4,
      vetoWindowMinutes: 30,
      dailyAutoPostCap: 2,
    };
    dbState.overrides.set(LOCATION_1, {
      id: 'policy-location',
      threshold: 4,
      vetoWindowMinutes: 30,
      dailyAutoPostCap: 2,
    });
    const { patchAutoApprovalSettings } = await import('../settings');

    await expect(patchAutoApprovalSettings(mockSql, {
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
      impersonated: false,
      operation: 'set_location_veto_window',
      locationId: LOCATION_1,
      minutes: 15,
      confirmationLevel: 'standard',
    })).rejects.toMatchObject({ blockReasons: ['autopilot_unavailable'] });

    expect(sqlCalls.filter((call) => call.text.includes('FROM accounts') && call.text.includes('FOR UPDATE')))
      .toHaveLength(1);
    expect(sqlCalls.filter((call) => call.text.includes('FROM account_offboardings')))
      .toHaveLength(2);
    expect(sqlCalls.filter((call) => call.text.includes('INSERT INTO auto_approval_policies')))
      .toHaveLength(0);
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
  });

  it('blocks Copilot expansion but permits an equal/no-op write with an honest audit', async () => {
    dbState.subscriptionTier = SubscriptionTier.COPILOT;
    dbState.accountDefault = { id: 'policy-default', threshold: 5 };
    const { patchAutoApprovalSettings } = await import('../settings');

    await expect(patchAutoApprovalSettings(mockSql, {
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
      impersonated: false,
      operation: 'set_account_default',
      threshold: 4,
      confirmationLevel: 'standard',
    })).rejects.toMatchObject({ blockReasons: ['autopilot_unavailable'] });
    expect(sqlCalls.filter((call) => call.text.includes('INSERT INTO auto_approval_policies'))).toHaveLength(0);

    await patchAutoApprovalSettings(mockSql, {
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
      impersonated: false,
      operation: 'set_account_default',
      threshold: 5,
    });
    expect(sqlCalls.filter((call) => call.text.includes('INSERT INTO auto_approval_policies'))).toHaveLength(1);
    expect(mockWriteAccountAuditLog).toHaveBeenCalledTimes(1);
    expect(mockWriteAccountAuditLog).toHaveBeenLastCalledWith(
      mockSql,
      expect.objectContaining({
        payload: expect.objectContaining({
          exposureClassification: 'no_change',
          expansion: false,
        }),
      }),
    );
  });

  it.each([
    {
      name: 'veto shortening',
      policy: { vetoWindowMinutes: 30 as const, dailyAutoPostCap: 5 },
      request: { operation: 'set_account_veto_window' as const, minutes: 15 as const, confirmationLevel: 'standard' as const },
      classification: 'expansion',
      blocked: true,
    },
    {
      name: 'veto lengthening',
      policy: { vetoWindowMinutes: 15 as const, dailyAutoPostCap: 5 },
      request: { operation: 'set_account_veto_window' as const, minutes: 30 as const },
      classification: 'contraction',
      blocked: false,
    },
    {
      name: 'cap raising',
      policy: { vetoWindowMinutes: 30 as const, dailyAutoPostCap: 5 },
      request: { operation: 'set_account_daily_cap' as const, cap: 6, confirmationLevel: 'standard' as const },
      classification: 'expansion',
      blocked: true,
    },
    {
      name: 'cap lowering',
      policy: { vetoWindowMinutes: 30 as const, dailyAutoPostCap: 6 },
      request: { operation: 'set_account_daily_cap' as const, cap: 5 },
      classification: 'contraction',
      blocked: false,
    },
    {
      name: 'cap removal',
      policy: { vetoWindowMinutes: 30 as const, dailyAutoPostCap: 5 },
      request: { operation: 'set_account_daily_cap' as const, cap: null, confirmationLevel: 'standard' as const },
      classification: 'expansion',
      blocked: true,
    },
    {
      name: 'cap below the effective platform default',
      policy: { vetoWindowMinutes: 30 as const, dailyAutoPostCap: null },
      request: { operation: 'set_account_daily_cap' as const, cap: 1 },
      classification: 'contraction',
      blocked: false,
    },
    {
      name: 'cap equal to the effective platform default',
      policy: { vetoWindowMinutes: 30 as const, dailyAutoPostCap: null },
      request: { operation: 'set_account_daily_cap' as const, cap: 10 },
      classification: 'no_change',
      blocked: false,
    },
    {
      name: 'cap above the effective platform default',
      policy: { vetoWindowMinutes: 30 as const, dailyAutoPostCap: null },
      request: {
        operation: 'set_account_daily_cap' as const,
        cap: 50,
        confirmationLevel: 'standard' as const,
      },
      classification: 'expansion',
      blocked: true,
    },
  ])('classifies and gates $name for Copilot', async ({ policy, request, classification, blocked }) => {
    dbState.subscriptionTier = SubscriptionTier.COPILOT;
    dbState.accountDefault = { id: 'policy-default', threshold: 5, ...policy };
    const { patchAutoApprovalSettings } = await import('../settings');

    const action = patchAutoApprovalSettings(mockSql, {
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
      impersonated: false,
      ...request,
    });

    if (blocked) {
      await expect(action).rejects.toMatchObject({ blockReasons: ['autopilot_unavailable'] });
      expect(sqlCalls.filter((call) => call.text.includes('INSERT INTO auto_approval_policies'))).toHaveLength(0);
      expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
      return;
    }

    await expect(action).resolves.toBeDefined();
    expect(sqlCalls.filter((call) => call.text.includes('INSERT INTO auto_approval_policies'))).toHaveLength(1);
    expect(mockWriteAccountAuditLog).toHaveBeenCalledTimes(1);
    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      mockSql,
      expect.objectContaining({
        payload: expect.objectContaining({ exposureClassification: classification }),
      }),
    );
  });

  it('allows a confirmed NULL-to-50 cap expansion for ready Autopilot and projects it to inheriting locations', async () => {
    dbState.accountDefault = {
      id: 'policy-default',
      threshold: 5,
      vetoWindowMinutes: 30,
      dailyAutoPostCap: null,
    };
    const { patchAutoApprovalSettings } = await import('../settings');

    const result = await patchAutoApprovalSettings(mockSql, {
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
      impersonated: false,
      operation: 'set_account_daily_cap',
      cap: 50,
      confirmationLevel: 'standard',
    });

    expect(result.accountDefault).toMatchObject({
      dailyAutoPostCap: 50,
      effectiveDailyCap: 50,
    });
    expect(result.locations).toHaveLength(2);
    for (const location of result.locations) {
      expect(location.effective).toMatchObject({
        inherited: true,
        dailyAutoPostCap: 50,
        effectiveDailyCap: 50,
      });
    }
    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      mockSql,
      expect.objectContaining({
        payload: expect.objectContaining({
          beforeEffectiveDailyAutoPostCap: null,
          beforeEffectiveDailyCap: 10,
          afterEffectiveDailyAutoPostCap: 50,
          afterEffectiveDailyCap: 50,
          exposureClassification: 'expansion',
          expansion: true,
        }),
      }),
    );
  });

  it('blocks NULL-to-50 but allows NULL-to-1 when the Autopilot sale gate is closed', async () => {
    dbState.accountDefault = { id: 'policy-default', threshold: 5, dailyAutoPostCap: null };
    process.env.AUTOPILOT_PURCHASABLE = 'false';
    resetServerConfigForTests();
    const { patchAutoApprovalSettings } = await import('../settings');

    await expect(patchAutoApprovalSettings(mockSql, {
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
      impersonated: false,
      operation: 'set_account_daily_cap',
      cap: 50,
      confirmationLevel: 'standard',
    })).rejects.toMatchObject({ blockReasons: ['autopilot_unavailable'] });

    const contracted = await patchAutoApprovalSettings(mockSql, {
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
      impersonated: false,
      operation: 'set_account_daily_cap',
      cap: 1,
    });
    expect(contracted.accountDefault).toMatchObject({
      dailyAutoPostCap: 1,
      effectiveDailyCap: 1,
    });
    expect(mockWriteAccountAuditLog).toHaveBeenCalledTimes(1);
    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      mockSql,
      expect.objectContaining({
        payload: expect.objectContaining({
          exposureClassification: 'contraction',
          expansion: false,
        }),
      }),
    );
  });

  it('blocks NULL-to-50 but allows NULL-to-1 while the policy is suspended', async () => {
    dbState.accountDefault = {
      id: 'policy-default',
      threshold: 5,
      dailyAutoPostCap: null,
      suspendedAt: new Date('2026-07-08T00:00:00.000Z'),
      suspendedReason: 'governor_negative_feedback',
    };
    const { patchAutoApprovalSettings } = await import('../settings');

    await expect(patchAutoApprovalSettings(mockSql, {
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
      impersonated: false,
      operation: 'set_account_daily_cap',
      cap: 50,
      confirmationLevel: 'standard',
    })).rejects.toMatchObject({ blockReasons: ['policy_suspended'] });

    const contracted = await patchAutoApprovalSettings(mockSql, {
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
      impersonated: false,
      operation: 'set_account_daily_cap',
      cap: 1,
    });
    expect(contracted.accountDefault.dailyAutoPostCap).toBe(1);
    expect(contracted.readiness.blockReasons).toEqual(['policy_suspended']);
    expect(mockWriteAccountAuditLog).toHaveBeenCalledTimes(1);
  });

  it('keeps an impersonated contraction blocked before opening a transaction', async () => {
    dbState.accountDefault = { id: 'policy-default', threshold: 4 };
    const { patchAutoApprovalSettings } = await import('../settings');

    await expect(patchAutoApprovalSettings(mockSql, {
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
      impersonated: true,
      operation: 'set_account_manual',
    })).rejects.toMatchObject({ blockReasons: ['impersonation_not_allowed'] });
    expect(mockSql.begin).not.toHaveBeenCalled();
    expect(sqlCalls).toHaveLength(0);
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
  });

  it('keeps a contraction blocked during operational offboarding before any policy write', async () => {
    dbState.accountDefault = { id: 'policy-default', threshold: 4 };
    dbState.offboarding = {
      id: '22222222-2222-7333-8444-555555555555',
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
    };
    const { patchAutoApprovalSettings } = await import('../settings');

    await expect(patchAutoApprovalSettings(mockSql, {
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
      impersonated: false,
      operation: 'set_account_manual',
    })).rejects.toMatchObject({ code: 'account_offboarding_blocked', status: 403 });
    expect(sqlCalls.filter((call) => call.text.includes('FOR UPDATE'))).toHaveLength(1);
    expect(sqlCalls.filter((call) => call.text.includes('INSERT INTO auto_approval_policies'))).toHaveLength(0);
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
  });

  it('allows contractions while readiness is blocked and writes audit in the same transaction', async () => {
    dbState.accountDefault = { id: 'policy-default', threshold: 4 };
    process.env.AUTO_APPROVAL_ENABLED = 'false';
    process.env.OPENAI_MODERATION_ENABLED = 'false';
    dbState.subscriptionStatus = SubscriptionStatus.PENDING_PAYMENT;

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

    const { patchAutoApprovalSettings } = await import('../settings');
    const { AutoApprovalExpansionBlockedError } = await import('../settings-guards');

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
          clearedVia: 'delete',
          expansion: false,
        }),
      }),
    );
  });

  it('blocks deleting a dial-restrictive override when inheritance widens another dial', async () => {
    dbState.subscriptionTier = SubscriptionTier.COPILOT;
    dbState.accountDefault = {
      id: 'policy-default',
      threshold: 5,
      vetoWindowMinutes: 15,
      dailyAutoPostCap: null,
    };
    dbState.overrides.set(LOCATION_1, {
      id: 'policy-restrictive',
      threshold: 5,
      vetoWindowMinutes: 30,
      dailyAutoPostCap: 2,
    });
    const { patchAutoApprovalSettings } = await import('../settings');

    await expect(patchAutoApprovalSettings(mockSql, {
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
      impersonated: false,
      operation: 'delete_location_override',
      locationId: LOCATION_1,
      confirmationLevel: 'standard',
    })).rejects.toMatchObject({ blockReasons: ['autopilot_unavailable'] });
    expect(dbState.overrides.get(LOCATION_1)?.id).toBe('policy-restrictive');
    expect(sqlCalls.filter((call) => call.text.includes('DELETE FROM auto_approval_policies'))).toHaveLength(0);
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
  });

  it('allows Copilot to delete a permissive override and inherit a stricter policy', async () => {
    dbState.subscriptionTier = SubscriptionTier.COPILOT;
    dbState.accountDefault = {
      id: 'policy-default',
      threshold: 5,
      vetoWindowMinutes: 30,
      dailyAutoPostCap: 2,
    };
    dbState.overrides.set(LOCATION_1, {
      id: 'policy-permissive',
      threshold: 4,
      vetoWindowMinutes: 15,
      dailyAutoPostCap: null,
    });
    const { patchAutoApprovalSettings } = await import('../settings');

    const result = await patchAutoApprovalSettings(mockSql, {
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
      impersonated: false,
      operation: 'delete_location_override',
      locationId: LOCATION_1,
    });

    expect(result.locations.find((entry) => entry.locationId === LOCATION_1)?.effective)
      .toMatchObject({ threshold: 5, vetoWindowMinutes: 30, dailyAutoPostCap: 2 });
    expect(sqlCalls.filter((call) => call.text.includes('DELETE FROM auto_approval_policies'))).toHaveLength(1);
    expect(mockWriteAccountAuditLog).toHaveBeenCalledTimes(1);
    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      mockSql,
      expect.objectContaining({
        payload: expect.objectContaining({ exposureClassification: 'contraction' }),
      }),
    );
  });

  it('blocks manual-to-manual override deletion when inheritance widens restrictive dials', async () => {
    dbState.subscriptionTier = SubscriptionTier.COPILOT;
    dbState.accountDefault = {
      id: 'policy-default',
      threshold: null,
      vetoWindowMinutes: 15,
      dailyAutoPostCap: null,
    };
    dbState.overrides.set(LOCATION_1, {
      id: 'policy-manual-restrictive',
      threshold: null,
      vetoWindowMinutes: 30,
      dailyAutoPostCap: 2,
    });
    const { patchAutoApprovalSettings } = await import('../settings');

    await expect(patchAutoApprovalSettings(mockSql, {
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
      impersonated: false,
      operation: 'delete_location_override',
      locationId: LOCATION_1,
      confirmationLevel: 'standard',
    })).rejects.toMatchObject({ blockReasons: ['autopilot_unavailable'] });

    expect(dbState.overrides.get(LOCATION_1)?.id).toBe('policy-manual-restrictive');
    expect(sqlCalls.filter((call) => call.text.includes('DELETE FROM auto_approval_policies')))
      .toHaveLength(0);
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
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
    const { patchAutoApprovalSettings } = await import('../settings');
    const { AutoApprovalExpansionBlockedError } = await import('../settings-guards');

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
    await patchAutoApprovalSettings(mockSql, {
      ...base,
      operation: 'set_account_daily_cap',
      cap: 25,
      confirmationLevel: 'standard',
    });
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
          beforeEffectiveThreshold: 4,
          afterEffectiveThreshold: 4,
          beforeEffectiveVetoWindowMinutes: 15,
          afterEffectiveVetoWindowMinutes: 30,
          beforeEffectiveDailyAutoPostCap: 25,
          afterEffectiveDailyAutoPostCap: 25,
          beforeEffectiveDailyCap: 25,
          afterEffectiveDailyCap: 25,
          exposureClassification: 'contraction',
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
      confirmationLevel: 'standard',
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
    const { getAutoApprovalSettings, patchAutoApprovalSettings } =
      await import('../settings');
    const { AutoApprovalExpansionBlockedError } = await import('../settings-guards');

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

  it('allows complete disablement and veto-window contraction while the policy is suspended', async () => {
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

  it('preserves a suspended account default on clear and keeps expansion blocked afterward', async () => {
    // Finding-1 laundering hole: DELETE would erase governor-owned
    // suspended_at, so a later re-create reads suspended=false and re-arms
    // auto-posting. A clear on a suspended row must instead NULL the
    // threshold and keep the row (dials + suspension intact).
    dbState.accountDefault = {
      id: 'policy-default',
      threshold: 5,
      vetoWindowMinutes: 30,
      dailyAutoPostCap: 2,
      suspendedAt: new Date('2026-07-08T00:00:00.000Z'),
      suspendedReason: 'governor_negative_feedback',
    };
    const { patchAutoApprovalSettings } = await import('../settings');
    const { AutoApprovalExpansionBlockedError } = await import('../settings-guards');

    const cleared = await patchAutoApprovalSettings(mockSql, {
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
      impersonated: false,
      operation: 'clear_account_default',
    });

    expect(cleared.accountDefault).toMatchObject({
      policyId: 'policy-default',
      exists: true,
      threshold: null,
      vetoWindowMinutes: 30,
      dailyAutoPostCap: 2,
      suspended: true,
      suspendedReason: 'governor_negative_feedback',
    });
    expect(
      sqlCalls.some((call) => call.text.includes('DELETE FROM auto_approval_policies')),
    ).toBe(false);
    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      mockSql,
      expect.objectContaining({
        payload: expect.objectContaining({
          operation: 'clear_account_default',
          clearedVia: 'threshold_null_suspended',
          expansion: false,
        }),
      }),
    );

    // The surviving suspension still blocks the follow-up expansion.
    let caught: unknown;
    try {
      await patchAutoApprovalSettings(mockSql, {
        accountId: ACCOUNT_ID,
        actorUserId: ACTOR_USER_ID,
        impersonated: false,
        operation: 'set_account_default',
        threshold: 5,
        confirmationLevel: 'standard',
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AutoApprovalExpansionBlockedError);
    expect(caught).toMatchObject({ blockReasons: ['policy_suspended'] });
  });

  it('still deletes an unsuspended account default on clear', async () => {
    dbState.accountDefault = { id: 'policy-default', threshold: 5 };
    const { patchAutoApprovalSettings } = await import('../settings');

    const cleared = await patchAutoApprovalSettings(mockSql, {
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
      impersonated: false,
      operation: 'clear_account_default',
    });

    expect(cleared.accountDefault).toMatchObject({ exists: false, threshold: null });
    expect(dbState.accountDefault).toBeNull();
    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      mockSql,
      expect.objectContaining({
        payload: expect.objectContaining({
          operation: 'clear_account_default',
          clearedVia: 'delete',
        }),
      }),
    );
  });

  it('preserves a suspended location override on delete and keeps expansion blocked afterward', async () => {
    dbState.overrides.set(LOCATION_1, {
      id: 'policy-main',
      threshold: 4,
      dailyAutoPostCap: 3,
      suspendedAt: new Date('2026-07-08T00:00:00.000Z'),
      suspendedReason: 'governor_negative_feedback',
    });
    const { patchAutoApprovalSettings } = await import('../settings');

    const deleted = await patchAutoApprovalSettings(mockSql, {
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
      impersonated: false,
      operation: 'delete_location_override',
      locationId: LOCATION_1,
    });

    const location = deleted.locations.find((entry) => entry.locationId === LOCATION_1);
    expect(location?.override).toMatchObject({
      policyId: 'policy-main',
      exists: true,
      threshold: null,
      dailyAutoPostCap: 3,
      suspended: true,
    });
    expect(
      sqlCalls.some((call) => call.text.includes('DELETE FROM auto_approval_policies')),
    ).toBe(false);
    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      mockSql,
      expect.objectContaining({
        payload: expect.objectContaining({
          operation: 'delete_location_override',
          clearedVia: 'threshold_null_suspended',
          expansion: false,
        }),
      }),
    );

    await expect(
      patchAutoApprovalSettings(mockSql, {
        accountId: ACCOUNT_ID,
        actorUserId: ACTOR_USER_ID,
        impersonated: false,
        operation: 'set_location_override',
        locationId: LOCATION_1,
        threshold: 4,
        confirmationLevel: 'standard',
      }),
    ).rejects.toMatchObject({
      name: 'AutoApprovalExpansionBlockedError',
      blockReasons: ['policy_suspended'],
    });
  });

  it('seeds an implicitly created override with the account default cap when the veto window is the target', async () => {
    // Finding-2: a dial-only op on a rowless location must not silently swap
    // the account's stricter explicit dial values for schema defaults.
    dbState.accountDefault = {
      id: 'policy-default',
      threshold: 4,
      vetoWindowMinutes: 30,
      dailyAutoPostCap: 2,
    };
    const { patchAutoApprovalSettings } = await import('../settings');

    const result = await patchAutoApprovalSettings(mockSql, {
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
      impersonated: false,
      operation: 'set_location_veto_window',
      locationId: LOCATION_1,
      minutes: 15,
    });

    const location = result.locations.find((entry) => entry.locationId === LOCATION_1);
    expect(location?.override).toMatchObject({
      exists: true,
      threshold: null,
      vetoWindowMinutes: 15,
      dailyAutoPostCap: 2,
      effectiveDailyCap: 2,
    });
  });

  it('seeds an implicitly created override with the account default veto window when the cap is the target', async () => {
    dbState.accountDefault = {
      id: 'policy-default',
      threshold: 4,
      vetoWindowMinutes: 30,
      dailyAutoPostCap: 2,
    };
    const { patchAutoApprovalSettings } = await import('../settings');

    const result = await patchAutoApprovalSettings(mockSql, {
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
      impersonated: false,
      operation: 'set_location_daily_cap',
      locationId: LOCATION_1,
      cap: 5,
    });

    const location = result.locations.find((entry) => entry.locationId === LOCATION_1);
    expect(location?.override).toMatchObject({
      exists: true,
      threshold: null,
      vetoWindowMinutes: 30,
      dailyAutoPostCap: 5,
    });
  });

  it('seeds both dials from the account default when a threshold op creates the override', async () => {
    dbState.accountDefault = {
      id: 'policy-default',
      threshold: 4,
      vetoWindowMinutes: 30,
      dailyAutoPostCap: 2,
    };
    const { patchAutoApprovalSettings } = await import('../settings');

    const result = await patchAutoApprovalSettings(mockSql, {
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
      impersonated: false,
      operation: 'set_location_manual',
      locationId: LOCATION_1,
    });

    const location = result.locations.find((entry) => entry.locationId === LOCATION_1);
    expect(location?.override).toMatchObject({
      exists: true,
      threshold: null,
      vetoWindowMinutes: 30,
      dailyAutoPostCap: 2,
    });
    // The audit afterRow mirrors the persisted seed (computeAfterState is
    // never re-read from the DB).
    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      mockSql,
      expect.objectContaining({
        payload: expect.objectContaining({
          afterRow: expect.objectContaining({
            vetoWindowMinutes: 30,
            dailyAutoPostCap: 2,
          }),
        }),
      }),
    );
  });

  it('keeps schema defaults for an implicitly created override when no account default exists', async () => {
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
      vetoWindowMinutes: 15,
      dailyAutoPostCap: 25,
    });
  });
});

// Run C T1: the transaction-aware writer. Both seams run the same
// lock -> gate -> write -> audit -> reload sequence, so the behavioral cases
// run against each; only the transaction boundary differs. Rollback and real
// lock blocking need Postgres and live in settings.integration.test.ts.
type SettingsSeam = 'wrapper' | 'tx export';
const SETTINGS_SEAMS: SettingsSeam[] = ['wrapper', 'tx export'];

const SEAM_BASE = {
  accountId: ACCOUNT_ID,
  actorUserId: ACTOR_USER_ID,
  impersonated: false,
} as const;

async function runSeam(seam: SettingsSeam, input: PatchAutoApprovalSettingsInput) {
  const settings = await import('../settings');
  return seam === 'wrapper'
    ? settings.patchAutoApprovalSettings(mockSql, input)
    : settings.patchAutoApprovalSettingsInTransaction(mockSql, input);
}

function policyInserts() {
  return sqlCalls.filter((call) => call.text.includes('INSERT INTO auto_approval_policies'));
}

const LOCK_ORDER_CASES: { name: string; input: PatchAutoApprovalSettingsInput }[] = [
  { name: 'an account threshold write', input: { ...SEAM_BASE, operation: 'set_account_manual' } },
  {
    name: 'an account dial write',
    input: { ...SEAM_BASE, operation: 'set_account_veto_window', minutes: 30 },
  },
  {
    name: 'a location threshold write',
    input: { ...SEAM_BASE, operation: 'set_location_manual', locationId: LOCATION_1 },
  },
  {
    name: 'a location dial write',
    input: { ...SEAM_BASE, operation: 'set_location_daily_cap', locationId: LOCATION_1, cap: 3 },
  },
];

describe('transaction-aware settings writer seam (Run C T1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlCalls.length = 0;
    resetDb();
    enableReadiness();
    mockSql.begin = vi.fn(async (cb: (tx: typeof mockSql) => Promise<unknown>) => cb(mockSql));
  });

  it.each(
    SETTINGS_SEAMS.flatMap((seam) => LOCK_ORDER_CASES.map((entry) => ({ seam, ...entry }))),
  )('$seam: the account FOR UPDATE precedes the first policy statement for $name', async ({ seam, input }) => {
    dbState.accountDefault = { id: 'policy-default', threshold: 4 };

    await runSeam(seam, input);

    // Ordered indices in the one SQL call log. Moving readBeforeState (or any
    // other auto_approval_policies read) above lockAccount fails this test.
    const lockIndex = sqlCalls.findIndex(
      (call) => call.text.includes('FROM accounts') && call.text.includes('FOR UPDATE'),
    );
    const firstPolicyIndex = sqlCalls.findIndex((call) => call.text.includes('auto_approval_policies'));
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(firstPolicyIndex).toBeGreaterThan(lockIndex);
  });

  it.each(SETTINGS_SEAMS)('%s rejects an impersonated actor before any statement or audit', async (seam) => {
    dbState.accountDefault = { id: 'policy-default', threshold: 4 };

    // A contraction: readiness alone would allow it, so only the seam's own
    // early rejection stops it. The tx case never passes through the wrapper.
    await expect(runSeam(seam, {
      ...SEAM_BASE,
      impersonated: true,
      operation: 'set_account_manual',
    })).rejects.toMatchObject({
      name: 'AutoApprovalExpansionBlockedError',
      blockReasons: ['impersonation_not_allowed'],
    });

    expect(mockSql.begin).not.toHaveBeenCalled();
    expect(sqlCalls).toHaveLength(0);
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
    expect(dbState.accountDefault?.threshold).toBe(4);
  });

  it('the tx export runs every statement and the audit on the caller transaction without opening its own', async () => {
    dbState.accountDefault = {
      id: 'policy-default',
      threshold: 4,
      vetoWindowMinutes: 30,
      dailyAutoPostCap: 2,
    };
    // A distinct caller handle: mockSql is reachable ONLY through it, so the
    // call counts prove no statement ran on another executor.
    const callerTx = vi.fn(
      (strings: TemplateStringsArray, ...values: unknown[]) => mockSql(strings, ...values),
    );
    const { patchAutoApprovalSettingsInTransaction } = await import('../settings');

    const result = await patchAutoApprovalSettingsInTransaction(callerTx as unknown as TransactionSql, {
      ...SEAM_BASE,
      operation: 'set_location_veto_window',
      locationId: LOCATION_1,
      minutes: 15,
    });

    expect(mockSql.begin).not.toHaveBeenCalled();
    expect(sqlCalls.length).toBeGreaterThan(0);
    expect(callerTx).toHaveBeenCalledTimes(sqlCalls.length);
    expect(mockWriteAccountAuditLog).toHaveBeenCalledTimes(1);
    expect(mockWriteAccountAuditLog.mock.calls[0]?.[0]).toBe(callerTx);
    expect(result.locations.find((entry) => entry.locationId === LOCATION_1)?.override)
      .toMatchObject({ exists: true, threshold: null, vetoWindowMinutes: 15, dailyAutoPostCap: 2 });
  });

  it.each(SETTINGS_SEAMS)(
    '%s seeds a first location dial write as manual with the other dial inherited (complete-disable contraction)',
    async (seam) => {
      dbState.accountDefault = {
        id: 'policy-default',
        threshold: 4,
        vetoWindowMinutes: 30,
        dailyAutoPostCap: 2,
      };

      // cap 2 -> 5 alone would widen; creating the rowless override switches
      // the location to manual, so the whole write is a contraction.
      const result = await runSeam(seam, {
        ...SEAM_BASE,
        operation: 'set_location_daily_cap',
        locationId: LOCATION_1,
        cap: 5,
      });

      expect(dbState.overrides.get(LOCATION_1)).toEqual({
        id: '019dc366-29ce-7000-a000-000000000123',
        threshold: null,
        vetoWindowMinutes: 30,
        dailyAutoPostCap: 5,
      });
      expect(result.locations.find((entry) => entry.locationId === LOCATION_1)?.effective)
        .toMatchObject({
          source: 'location_override',
          threshold: null,
          vetoWindowMinutes: 30,
          dailyAutoPostCap: 5,
        });
      expect(dbState.accountDefault).toMatchObject({
        threshold: 4,
        vetoWindowMinutes: 30,
        dailyAutoPostCap: 2,
      });
      expect(policyInserts()).toHaveLength(1);
      expect(mockWriteAccountAuditLog).toHaveBeenCalledTimes(1);
      expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
        mockSql,
        expect.objectContaining({
          payload: expect.objectContaining({
            exposureClassification: 'contraction',
            expansion: false,
            requiredConfirmationLevel: null,
          }),
        }),
      );
      expect(mockSql.begin).toHaveBeenCalledTimes(seam === 'wrapper' ? 1 : 0);
    },
  );

  it.each(SETTINGS_SEAMS)('%s preserves untouched fields when a dial write hits an existing override', async (seam) => {
    dbState.accountDefault = {
      id: 'policy-default',
      threshold: 4,
      vetoWindowMinutes: 15,
      dailyAutoPostCap: 9,
    };
    dbState.overrides.set(LOCATION_1, {
      id: 'policy-location',
      threshold: 5,
      vetoWindowMinutes: 30,
      dailyAutoPostCap: 3,
    });

    const result = await runSeam(seam, {
      ...SEAM_BASE,
      operation: 'set_location_daily_cap',
      locationId: LOCATION_1,
      cap: 2,
    });

    expect(dbState.overrides.get(LOCATION_1)).toEqual({
      id: 'policy-location',
      threshold: 5,
      vetoWindowMinutes: 30,
      dailyAutoPostCap: 2,
    });
    expect(result.locations.find((entry) => entry.locationId === LOCATION_1)?.override)
      .toMatchObject({ policyId: 'policy-location', threshold: 5, vetoWindowMinutes: 30, dailyAutoPostCap: 2 });
    expect(mockWriteAccountAuditLog).toHaveBeenCalledTimes(1);
    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      mockSql,
      expect.objectContaining({
        payload: expect.objectContaining({
          exposureClassification: 'contraction',
          afterRow: expect.objectContaining({
            policyId: 'policy-location',
            threshold: 5,
            vetoWindowMinutes: 30,
            dailyAutoPostCap: 2,
          }),
        }),
      }),
    );
  });

  it.each(SETTINGS_SEAMS)('%s refuses set_location_override on an archived location before any write', async (seam) => {
    dbState.locations = [
      { id: LOCATION_1, name: 'Old Cafe', displayLabel: 'Old', archivedAt: new Date('2026-01-01T00:00:00Z') },
    ];

    await expect(runSeam(seam, {
      ...SEAM_BASE,
      operation: 'set_location_override',
      locationId: LOCATION_1,
      threshold: 5,
      confirmationLevel: 'standard',
    })).rejects.toMatchObject({ name: 'AutoApprovalSettingsError', code: 'location_inactive', status: 409 });

    expect(policyInserts()).toHaveLength(0);
    expect(dbState.overrides.has(LOCATION_1)).toBe(false);
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
  });

  it.each(SETTINGS_SEAMS)('%s requires standard confirmation for an expansion and writes nothing', async (seam) => {
    dbState.accountDefault = { id: 'policy-default', threshold: 5 };

    await expect(runSeam(seam, {
      ...SEAM_BASE,
      operation: 'set_account_default',
      threshold: 4,
    })).rejects.toMatchObject({ confirmationLevel: 'standard' });

    expect(policyInserts()).toHaveLength(0);
    expect(dbState.accountDefault?.threshold).toBe(5);
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
  });
});

describe('internal Reply policy restore validation', () => {
  const state = { threshold: 5, vetoWindowMinutes: 30, dailyAutoPostCap: 2 } as const;

  beforeEach(() => {
    vi.clearAllMocks();
    sqlCalls.length = 0;
  });

  it('the public settings schema rejects an internal restore and full-row state on ordinary operations', async () => {
    const { AutoApprovalPatchSchema } = await import('../types');
    expect(AutoApprovalPatchSchema.safeParse({
      operation: 'restore_reply_policy', locationId: LOCATION_1, state,
    }).success).toBe(false);
    expect(AutoApprovalPatchSchema.safeParse({
      operation: 'set_location_override', locationId: LOCATION_1, threshold: 5, state,
    }).success).toBe(false);
  });

  it.each([
    { ...state, threshold: 3 },
    { ...state, vetoWindowMinutes: 60 },
    { ...state, dailyAutoPostCap: 0 },
    { ...state, dailyAutoPostCap: 51 },
    { ...state, dailyAutoPostCap: 1.5 },
    { ...state, suspendedAt: null },
    { ...state, suspendedReason: 'historical suspension' },
  ])('rejects invalid or historical suspension fields before any database statement: %j', async (invalidState) => {
    const { patchAutoApprovalSettingsInTransaction } = await import('../settings');
    await expect(patchAutoApprovalSettingsInTransaction(mockSql, {
      ...SEAM_BASE, operation: 'restore_reply_policy', locationId: LOCATION_1,
      state: invalidState as unknown as import('../types').RestoreReplyPolicyRequest['state'],
    })).rejects.toMatchObject({ code: 'invalid_policy_restore' });
    expect(sqlCalls).toHaveLength(0);
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
  });
});

// #631 Task 8 (docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md) —
// the D20 Solicitation persona opt-in surface. Titles verbatim from intake
// rev 2. The lane's PATCH operations share the account lock + offboarding
// gate with the Reply lane but none of its snapshot machinery.
describe('solicitation persona opt-in (#631)', () => {
  const SET_BASE = {
    accountId: ACCOUNT_ID,
    actorUserId: ACTOR_USER_ID,
    impersonated: false,
  } as const;

  beforeEach(() => {
    vi.clearAllMocks();
    sqlCalls.length = 0;
    resetDb();
    enableReadiness();
    process.env.SOLICITATION_SEND_ENABLED = 'true';
    process.env.SOLICITATION_AUTO_APPROVAL_ENABLED = 'true';
    mockSql.begin = vi.fn(async (cb: (tx: typeof mockSql) => Promise<unknown>) => cb(mockSql));
  });

  it('PATCH creates the solicitation policy row only for an Autopilot account', async () => {
    dbState.subscriptionTier = SubscriptionTier.COPILOT;
    const { patchAutoApprovalSettings } = await import('../settings');

    await expect(patchAutoApprovalSettings(mockSql, {
      ...SET_BASE,
      operation: 'set_solicitation_account_default',
      dailySendCap: 5,
      confirmationLevel: 'standard',
    })).rejects.toMatchObject({
      name: 'AutoApprovalExpansionBlockedError',
      blockReasons: ['autopilot_unavailable'],
    });
    expect(dbState.solicitationDefault).toBeNull();
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();

    dbState.subscriptionTier = SubscriptionTier.AUTOPILOT;
    const result = await patchAutoApprovalSettings(mockSql, {
      ...SET_BASE,
      operation: 'set_solicitation_account_default',
      dailySendCap: 5,
      confirmationLevel: 'standard',
    });

    expect(dbState.solicitationDefault).toMatchObject({ dailySendCap: 5, vetoWindowMinutes: 60 });
    expect(result.solicitation).toEqual({
      available: true,
      enabled: true,
      dailySendCap: 5,
      vetoWindowMinutes: 60,
    });
    expect(mockWriteAccountAuditLog).toHaveBeenCalledTimes(1);
    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      mockSql,
      expect.objectContaining({
        payload: expect.objectContaining({
          operation: 'set_solicitation_account_default',
          persona: 'solicitation',
          exposureClassification: 'expansion',
          expansion: true,
          requiredConfirmationLevel: 'standard',
        }),
      }),
    );
  });

  it('PATCH rejects daily_send_cap outside 1..50 and veto windows other than 30 or 60', async () => {
    // The zod schema is the PATCH contract's single source of truth — the
    // route validates every body against it (types.ts).
    const { AutoApprovalPatchSchema } = await import('../types');
    const parse = (patch: Record<string, unknown>) =>
      AutoApprovalPatchSchema.safeParse({ operation: 'set_solicitation_account_default', ...patch });

    expect(parse({ dailySendCap: 0 }).success).toBe(false);
    expect(parse({ dailySendCap: 51 }).success).toBe(false);
    expect(parse({ dailySendCap: 10.5 }).success).toBe(false);
    expect(parse({ dailySendCap: 5, vetoWindowMinutes: 15 }).success).toBe(false);
    expect(parse({ dailySendCap: 5, vetoWindowMinutes: 45 }).success).toBe(false);

    expect(parse({ dailySendCap: 1 }).success).toBe(true);
    expect(parse({ dailySendCap: 50, vetoWindowMinutes: 30 }).success).toBe(true);
    expect(parse({ dailySendCap: null, vetoWindowMinutes: 60 }).success).toBe(true);
  });

  it('PATCH round-trips valid dials and defaults an omitted veto window to 60', async () => {
    const { getAutoApprovalSettings, patchAutoApprovalSettings } = await import('../settings');

    const first = await patchAutoApprovalSettings(mockSql, {
      ...SET_BASE,
      operation: 'set_solicitation_account_default',
      dailySendCap: 25,
      confirmationLevel: 'standard',
    });
    expect(first.solicitation).toMatchObject({
      enabled: true,
      dailySendCap: 25,
      vetoWindowMinutes: 60,
    });

    const second = await patchAutoApprovalSettings(mockSql, {
      ...SET_BASE,
      operation: 'set_solicitation_account_default',
      dailySendCap: 3,
      vetoWindowMinutes: 30,
      confirmationLevel: 'standard',
    });
    expect(second.solicitation).toMatchObject({
      enabled: true,
      dailySendCap: 3,
      vetoWindowMinutes: 30,
    });

    const readBack = await getAutoApprovalSettings(mockSql, {
      accountId: ACCOUNT_ID,
      impersonated: false,
    });
    expect(readBack.solicitation).toEqual({
      available: true,
      enabled: true,
      dailySendCap: 3,
      vetoWindowMinutes: 30,
    });
  });

  it('enabling Solicitation twice upserts exactly one account-default row', async () => {
    const { patchAutoApprovalSettings } = await import('../settings');

    await patchAutoApprovalSettings(mockSql, {
      ...SET_BASE,
      operation: 'set_solicitation_account_default',
      dailySendCap: 5,
      confirmationLevel: 'standard',
    });
    const firstId = dbState.solicitationDefault?.id;
    expect(firstId).toBeTruthy();

    await patchAutoApprovalSettings(mockSql, {
      ...SET_BASE,
      operation: 'set_solicitation_account_default',
      dailySendCap: 8,
      vetoWindowMinutes: 30,
      confirmationLevel: 'standard',
    });

    const upserts = sqlCalls.filter((call) =>
      call.text.includes('INSERT INTO auto_approval_policies')
      && call.text.includes('daily_send_cap'));
    expect(upserts).toHaveLength(2);
    // Byte-for-byte the migration-074 account-default index predicate — a
    // drifted clause fails at runtime with no-matching-constraint.
    for (const upsert of upserts) {
      expect(upsert.text.replace(/\s+/g, ' '))
        .toContain('ON CONFLICT (account_id, persona, action_class) WHERE location_id IS NULL');
    }
    // The conflict path updated the one existing row in place.
    expect(dbState.solicitationDefault).toMatchObject({
      id: firstId,
      dailySendCap: 8,
      vetoWindowMinutes: 30,
    });
  });

  it('removing the opt-in deletes only the solicitation account-default row and the lane stays off', async () => {
    dbState.accountDefault = { id: 'policy-reply-default', threshold: 4, vetoWindowMinutes: 30 };
    dbState.overrides.set(LOCATION_1, { id: 'policy-reply-loc', threshold: 5 });
    dbState.solicitationDefault = {
      id: 'policy-solicitation',
      vetoWindowMinutes: 60,
      dailySendCap: 5,
    };
    const { getAutoApprovalSettings, patchAutoApprovalSettings } = await import('../settings');

    const result = await patchAutoApprovalSettings(mockSql, {
      ...SET_BASE,
      operation: 'clear_solicitation_account_default',
    });

    expect(result.solicitation).toEqual({
      available: true,
      enabled: false,
      dailySendCap: null,
      vetoWindowMinutes: null,
    });
    expect(dbState.solicitationDefault).toBeNull();
    // The Reply account default and the location override both survive.
    expect(dbState.accountDefault?.id).toBe('policy-reply-default');
    expect(dbState.overrides.get(LOCATION_1)?.id).toBe('policy-reply-loc');

    const deletes = sqlCalls.filter((call) => call.text.includes('DELETE FROM auto_approval_policies'));
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.values).toContain('solicitation');
    expect(mockWriteAccountAuditLog).toHaveBeenCalledTimes(1);
    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      mockSql,
      expect.objectContaining({
        payload: expect.objectContaining({
          operation: 'clear_solicitation_account_default',
          exposureClassification: 'contraction',
          expansion: false,
        }),
      }),
    );

    const readBack = await getAutoApprovalSettings(mockSql, {
      accountId: ACCOUNT_ID,
      impersonated: false,
    });
    expect(readBack.solicitation.enabled).toBe(false);
  });

  it('GET marks solicitation available only when both server flags and tierGrantsAutopilot hold', async () => {
    dbState.solicitationDefault = {
      id: 'policy-solicitation',
      vetoWindowMinutes: 60,
      dailySendCap: 5,
    };
    const { getAutoApprovalSettings } = await import('../settings');
    const read = () => getAutoApprovalSettings(mockSql, {
      accountId: ACCOUNT_ID,
      impersonated: false,
    });

    await expect(read()).resolves.toMatchObject({
      solicitation: { available: true, enabled: true, dailySendCap: 5, vetoWindowMinutes: 60 },
    });

    process.env.SOLICITATION_SEND_ENABLED = 'false';
    // `enabled` reports the stored row regardless of availability.
    await expect(read()).resolves.toMatchObject({
      solicitation: { available: false, enabled: true },
    });
    process.env.SOLICITATION_SEND_ENABLED = 'true';

    process.env.SOLICITATION_AUTO_APPROVAL_ENABLED = 'false';
    await expect(read()).resolves.toMatchObject({ solicitation: { available: false } });
    process.env.SOLICITATION_AUTO_APPROVAL_ENABLED = 'true';

    dbState.subscriptionTier = SubscriptionTier.COPILOT;
    await expect(read()).resolves.toMatchObject({ solicitation: { available: false } });

    dbState.subscriptionTier = SubscriptionTier.AUTOPILOT;
    await expect(read()).resolves.toMatchObject({ solicitation: { available: true } });
  });
});
