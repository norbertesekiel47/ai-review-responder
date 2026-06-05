import type postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { writeAccountAuditLog } from '@/lib/audit/log';
import { sql } from '@/lib/db/server';
import { assertWritableSubscriptionForAccount } from '@/lib/shared/writable-subscription';
import {
  autoApprovalRuntimeEnabled,
  isPreviewEnvironment,
  providerModerationEnabled,
  providerModerationValidated,
} from './flags';
import {
  exposureRank,
  isThresholdExpansion,
  resolveEffectivePolicy,
} from './policy';
import { buildAutoApprovalReadiness } from './readiness';
import type {
  AutoApprovalConfirmationLevel,
  AutoApprovalPatchRequest,
  AutoApprovalPolicyApiState,
  AutoApprovalReadiness,
  AutoApprovalReadinessBlockReason,
  AutoApprovalSettingsResponse,
  AutoApprovalThreshold,
  EffectiveAutoApprovalPolicy,
  PolicyRowState,
} from './types';
import { isAutoApprovalThreshold } from './types';

type SqlExecutor = typeof sql | postgres.TransactionSql;

interface GetAutoApprovalSettingsInput {
  accountId: string;
  impersonated: boolean;
}

export type PatchAutoApprovalSettingsInput = AutoApprovalPatchRequest & {
  accountId: string;
  actorUserId: string | null;
  impersonated: boolean;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
};

interface PolicyDbRow {
  id: string;
  account_id: string;
  location_id: string | null;
  auto_approve_min_star: number | null;
}

interface LocationPolicyRow {
  location_id: string;
  display_name: string;
  policy_id: string | null;
  policy_account_id: string | null;
  auto_approve_min_star: number | null;
}

interface TargetLocationRow {
  id: string;
  name: string;
  display_label: string | null;
  archived_at: Date | null;
}

interface MutationBeforeAfter {
  beforeRow: AutoApprovalPolicyApiState;
  afterRow: AutoApprovalPolicyApiState;
  beforeEffective: EffectiveAutoApprovalPolicy;
  afterEffective: EffectiveAutoApprovalPolicy;
  affectedActiveLocationCount: number;
  scope: 'account_default' | 'location_override';
  locationId: string | null;
}

export class AutoApprovalConfirmationRequiredError extends Error {
  constructor(readonly confirmationLevel: AutoApprovalConfirmationLevel) {
    super('auto_approval_confirmation_required');
    this.name = 'AutoApprovalConfirmationRequiredError';
  }
}

export class AutoApprovalExpansionBlockedError extends Error {
  constructor(readonly blockReasons: AutoApprovalReadinessBlockReason[]) {
    super('auto_approval_expansion_blocked');
    this.name = 'AutoApprovalExpansionBlockedError';
  }
}

export class AutoApprovalSettingsError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 403 | 404 | 409 | 500 = 400,
  ) {
    super(code);
    this.name = 'AutoApprovalSettingsError';
  }
}

export async function getAutoApprovalSettings(
  input: GetAutoApprovalSettingsInput,
  db: SqlExecutor = sql,
): Promise<AutoApprovalSettingsResponse> {
  const accountDefault = await loadAccountDefault(db, input.accountId);
  const locations = await loadActiveLocationSettings(db, input.accountId, accountDefault);
  const readiness = await buildReadiness(db, input.accountId, input.impersonated);

  return {
    accountDefault: toApiState(accountDefault),
    locations,
    readiness,
  };
}

export async function patchAutoApprovalSettings(
  input: PatchAutoApprovalSettingsInput,
): Promise<AutoApprovalSettingsResponse> {
  if (input.impersonated) {
    throw new AutoApprovalExpansionBlockedError(['impersonation_not_allowed']);
  }

  return sql.begin(async (tx) => {
    await updatePolicyInTransaction(tx, input);
    return getAutoApprovalSettings(
      {
        accountId: input.accountId,
        impersonated: input.impersonated,
      },
      tx,
    );
  });
}

async function updatePolicyInTransaction(
  tx: postgres.TransactionSql,
  input: PatchAutoApprovalSettingsInput,
): Promise<void> {
  await lockAccount(tx, input.accountId);

  const before = await captureBefore(tx, input);
  await applyMutation(tx, input);
  const after = await captureAfter(tx, input, before);
  const auditContext = await buildAuditContext(tx, input, before, after);
  await writePolicyChangeAudit(tx, input, before, after, auditContext);
}

interface PolicyChangeAuditContext {
  beforeRank: number;
  afterRank: number;
  expansion: boolean;
  requiredConfirmationLevel: AutoApprovalConfirmationLevel | null;
  readiness: AutoApprovalReadiness;
}

async function buildAuditContext(
  tx: postgres.TransactionSql,
  input: PatchAutoApprovalSettingsInput,
  before: MutationBeforeAfter,
  after: MutationBeforeAfter,
): Promise<PolicyChangeAuditContext> {
  const expansion = isThresholdExpansion(before.beforeEffective.threshold, after.afterEffective.threshold);
  const requiredConfirmationLevel = expansion ? requiredConfirmation(after.afterEffective.threshold) : null;

  if (requiredConfirmationLevel && !confirmationSatisfies(input.confirmationLevel, requiredConfirmationLevel)) {
    throw new AutoApprovalConfirmationRequiredError(requiredConfirmationLevel);
  }

  const readiness = await buildReadiness(tx, input.accountId, input.impersonated);
  if (expansion && !readiness.canExpand) {
    throw new AutoApprovalExpansionBlockedError(readiness.blockReasons);
  }

  return {
    beforeRank: exposureRank(before.beforeEffective.threshold),
    afterRank: exposureRank(after.afterEffective.threshold),
    expansion,
    requiredConfirmationLevel,
    readiness,
  };
}

async function writePolicyChangeAudit(
  tx: postgres.TransactionSql,
  input: PatchAutoApprovalSettingsInput,
  before: MutationBeforeAfter,
  after: MutationBeforeAfter,
  context: PolicyChangeAuditContext,
): Promise<void> {
  await writeAccountAuditLog(
    {
      accountId: input.accountId,
      locationId: after.locationId,
      actorUserId: input.actorUserId,
      eventType: 'auto_approval_policy_changed',
      entityType: 'auto_approval_policy',
      entityId: after.afterRow.policyId ?? before.beforeRow.policyId,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      requestId: input.requestId ?? null,
      payload: {
        operation: input.operation,
        scope: after.scope,
        locationId: after.locationId,
        beforeRow: before.beforeRow,
        afterRow: after.afterRow,
        beforeEffectiveThreshold: before.beforeEffective.threshold,
        afterEffectiveThreshold: after.afterEffective.threshold,
        beforeEffectiveSource: before.beforeEffective.source,
        afterEffectiveSource: after.afterEffective.source,
        beforeExposureRank: context.beforeRank,
        afterExposureRank: context.afterRank,
        expansion: context.expansion,
        requiredConfirmationLevel: context.requiredConfirmationLevel,
        submittedConfirmationLevel: input.confirmationLevel ?? null,
        readiness: context.readiness,
        affectedActiveLocationCount: after.affectedActiveLocationCount,
        futureDefaultApplies: after.scope === 'account_default',
      },
    },
    tx,
  );
}

async function lockAccount(db: postgres.TransactionSql, accountId: string): Promise<void> {
  const [account] = await db<{ id: string }[]>`
    SELECT id
    FROM accounts
    WHERE id = ${accountId}::uuid
    FOR UPDATE
  `;
  if (!account) {
    throw new AutoApprovalSettingsError('account_not_found', 404);
  }
}

async function captureBefore(
  db: postgres.TransactionSql,
  input: PatchAutoApprovalSettingsInput,
): Promise<MutationBeforeAfter> {
  const accountDefault = await loadAccountDefault(db, input.accountId);

  if (!('locationId' in input)) {
    const beforeState = toApiState(accountDefault);
    return {
      beforeRow: beforeState,
      afterRow: beforeState,
      beforeEffective: effectiveForAccountDefault(accountDefault),
      afterEffective: effectiveForAccountDefault(accountDefault),
      affectedActiveLocationCount: await countActiveInheritingLocations(db, input.accountId),
      scope: 'account_default',
      locationId: null,
    };
  }

  const target = await loadTargetLocation(db, input.accountId, input.locationId);
  if (!target) {
    throw new AutoApprovalSettingsError('location_not_found', 404);
  }
  if (input.operation === 'set_location_override' && target.archived_at !== null) {
    throw new AutoApprovalSettingsError('location_inactive', 409);
  }

  const locationOverride = await loadLocationOverride(db, input.accountId, input.locationId);
  const effective = resolveEffectivePolicy(accountDefault, locationOverride);
  const beforeState = toApiState(locationOverride);

  return {
    beforeRow: beforeState,
    afterRow: beforeState,
    beforeEffective: effective,
    afterEffective: effective,
    affectedActiveLocationCount: target.archived_at === null ? 1 : 0,
    scope: 'location_override',
    locationId: input.locationId,
  };
}

async function captureAfter(
  db: postgres.TransactionSql,
  input: PatchAutoApprovalSettingsInput,
  before: MutationBeforeAfter,
): Promise<MutationBeforeAfter> {
  const accountDefault = await loadAccountDefault(db, input.accountId);

  if (!('locationId' in input)) {
    const afterState = toApiState(accountDefault);
    return {
      ...before,
      afterRow: afterState,
      afterEffective: effectiveForAccountDefault(accountDefault),
      affectedActiveLocationCount: await countActiveInheritingLocations(db, input.accountId),
    };
  }

  const locationOverride = await loadLocationOverride(db, input.accountId, input.locationId);
  return {
    ...before,
    afterRow: toApiState(locationOverride),
    afterEffective: resolveEffectivePolicy(accountDefault, locationOverride),
  };
}

async function applyMutation(
  db: postgres.TransactionSql,
  input: PatchAutoApprovalSettingsInput,
): Promise<void> {
  switch (input.operation) {
    case 'set_account_default':
      await upsertAccountDefault(db, input.accountId, input.threshold);
      return;
    case 'set_account_manual':
      await upsertAccountDefault(db, input.accountId, null);
      return;
    case 'clear_account_default':
      await db`
        DELETE FROM auto_approval_policies
        WHERE account_id = ${input.accountId}::uuid
          AND location_id IS NULL
      `;
      return;
    case 'set_location_override':
      await upsertLocationOverride(db, input.accountId, input.locationId, input.threshold);
      return;
    case 'set_location_manual':
      await upsertLocationOverride(db, input.accountId, input.locationId, null);
      return;
    case 'delete_location_override':
      await db`
        DELETE FROM auto_approval_policies
        WHERE account_id = ${input.accountId}::uuid
          AND location_id = ${input.locationId}::uuid
      `;
      return;
  }
}

async function upsertAccountDefault(
  db: postgres.TransactionSql,
  accountId: string,
  threshold: AutoApprovalThreshold | null,
): Promise<void> {
  await db`
    INSERT INTO auto_approval_policies (
      id,
      account_id,
      location_id,
      auto_approve_min_star,
      updated_at
    ) VALUES (
      ${uuidv7()}::uuid,
      ${accountId}::uuid,
      NULL,
      ${threshold},
      NOW()
    )
    ON CONFLICT (account_id) WHERE location_id IS NULL
    DO UPDATE SET
      auto_approve_min_star = EXCLUDED.auto_approve_min_star,
      updated_at = NOW()
  `;
}

async function upsertLocationOverride(
  db: postgres.TransactionSql,
  accountId: string,
  locationId: string,
  threshold: AutoApprovalThreshold | null,
): Promise<void> {
  await db`
    INSERT INTO auto_approval_policies (
      id,
      account_id,
      location_id,
      auto_approve_min_star,
      updated_at
    ) VALUES (
      ${uuidv7()}::uuid,
      ${accountId}::uuid,
      ${locationId}::uuid,
      ${threshold},
      NOW()
    )
    ON CONFLICT (account_id, location_id) WHERE location_id IS NOT NULL
    DO UPDATE SET
      auto_approve_min_star = EXCLUDED.auto_approve_min_star,
      updated_at = NOW()
  `;
}

async function loadAccountDefault(
  db: SqlExecutor,
  accountId: string,
): Promise<PolicyRowState | null> {
  const [row] = await db<PolicyDbRow[]>`
    SELECT id, account_id, location_id, auto_approve_min_star
    FROM auto_approval_policies
    WHERE account_id = ${accountId}::uuid
      AND location_id IS NULL
    LIMIT 1
  `;

  return row ? toPolicyRow(row) : null;
}

async function loadLocationOverride(
  db: SqlExecutor,
  accountId: string,
  locationId: string,
): Promise<PolicyRowState | null> {
  const [row] = await db<PolicyDbRow[]>`
    SELECT id, account_id, location_id, auto_approve_min_star
    FROM auto_approval_policies
    WHERE account_id = ${accountId}::uuid
      AND location_id = ${locationId}::uuid
    LIMIT 1
  `;

  return row ? toPolicyRow(row) : null;
}

async function loadActiveLocationSettings(
  db: SqlExecutor,
  accountId: string,
  accountDefault: PolicyRowState | null,
): Promise<AutoApprovalSettingsResponse['locations']> {
  const rows = await db<LocationPolicyRow[]>`
    SELECT
      b.id AS location_id,
      COALESCE(b.display_label, b.name) AS display_name,
      p.id AS policy_id,
      p.account_id AS policy_account_id,
      p.auto_approve_min_star
    FROM businesses b
    LEFT JOIN auto_approval_policies p
      ON p.account_id = ${accountId}::uuid
     AND p.account_id = b.account_id
     AND p.location_id = b.id
    WHERE b.account_id = ${accountId}::uuid
      AND b.archived_at IS NULL
    ORDER BY b.is_primary DESC, b.created_at ASC
  `;

  return rows.map((row) => {
    const override = row.policy_id
      ? toPolicyRow({
          id: row.policy_id,
          account_id: row.policy_account_id ?? accountId,
          location_id: row.location_id,
          auto_approve_min_star: row.auto_approve_min_star,
        })
      : null;
    const effective = resolveEffectivePolicy(accountDefault, override);

    return {
      locationId: row.location_id,
      displayName: row.display_name,
      override: toApiState(override),
      effective: {
        threshold: effective.threshold,
        source: effective.source,
        inherited: effective.source !== 'location_override',
      },
    };
  });
}

async function loadTargetLocation(
  db: SqlExecutor,
  accountId: string,
  locationId: string,
): Promise<TargetLocationRow | null> {
  const [location] = await db<TargetLocationRow[]>`
    SELECT id, name, display_label, archived_at
    FROM businesses
    WHERE account_id = ${accountId}::uuid
      AND id = ${locationId}::uuid
    LIMIT 1
  `;
  return location ?? null;
}

async function countActiveInheritingLocations(
  db: SqlExecutor,
  accountId: string,
): Promise<number> {
  const [row] = await db<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM businesses b
    LEFT JOIN auto_approval_policies p
      ON p.account_id = ${accountId}::uuid
     AND p.account_id = b.account_id
     AND p.location_id = b.id
    WHERE b.account_id = ${accountId}::uuid
      AND b.archived_at IS NULL
      AND p.id IS NULL
  `;
  return row?.count ?? 0;
}

async function buildReadiness(
  db: SqlExecutor,
  accountId: string,
  impersonated: boolean,
): Promise<AutoApprovalReadiness> {
  const runtimeEnabled = autoApprovalRuntimeEnabled();
  const moderationEnabled = providerModerationEnabled();
  const moderationValidated = providerModerationValidated();
  const preview = isPreviewEnvironment();
  const writable = await assertWritableSubscriptionForAccount(accountId, db);

  return buildAutoApprovalReadiness({
    runtimeEnabled,
    providerModerationEnabled: moderationEnabled,
    providerModerationValidated: moderationValidated,
    accountWritable: writable.ok,
    previewEnvironment: preview,
    impersonated,
  });
}

function toPolicyRow(row: PolicyDbRow): PolicyRowState {
  return {
    id: row.id,
    accountId: row.account_id,
    locationId: row.location_id,
    autoApproveMinStar: toThreshold(row.auto_approve_min_star),
  };
}

function toThreshold(value: number | null): AutoApprovalThreshold | null {
  if (value === null) return null;
  if (!isAutoApprovalThreshold(value)) {
    throw new AutoApprovalSettingsError('invalid_policy_threshold', 500);
  }
  return value;
}

function toApiState(policy: PolicyRowState | null): AutoApprovalPolicyApiState {
  return {
    policyId: policy?.id ?? null,
    threshold: policy?.autoApproveMinStar ?? null,
    exists: Boolean(policy),
  };
}

function effectiveForAccountDefault(
  policy: PolicyRowState | null,
): EffectiveAutoApprovalPolicy {
  return {
    source: policy ? 'account_default' : 'none',
    threshold: policy?.autoApproveMinStar ?? null,
    policyId: policy?.id ?? null,
  };
}

function requiredConfirmation(
  threshold: AutoApprovalThreshold | null,
): AutoApprovalConfirmationLevel {
  return threshold === 1 ? 'all_ratings' : 'standard';
}

function confirmationSatisfies(
  submitted: AutoApprovalConfirmationLevel | undefined,
  required: AutoApprovalConfirmationLevel,
): boolean {
  if (required === 'all_ratings') return submitted === 'all_ratings';
  return submitted === 'standard' || submitted === 'all_ratings';
}
