import type { Sql, TransactionSql } from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import {
  getOffboardingState,
  isBillingMutationBlocked,
} from '@/lib/account-offboarding/gate';
import { writeAccountAuditLog } from '@/lib/audit/log';
import { assertWritableSubscriptionForAccount } from '@/lib/shared/writable-subscription';
import { isPreviewEnvironment } from '@/lib/config/flags';
import {
  autoApprovalRuntimeEnabled,
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

type SqlExecutor = Sql | TransactionSql;

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

// One point-in-time view of the targeted policy: its API row plus the effective
// policy that results for the targeted scope.
interface PolicySnapshot {
  row: AutoApprovalPolicyApiState;
  // Threshold facts only: settings mutations don't touch the WS4 dial fields
  // (veto window / daily cap / suspension) yet. WS4 Task 12 removes this
  // narrowing when the dial operations land.
  effective: Pick<EffectiveAutoApprovalPolicy, 'source' | 'threshold' | 'policyId'>;
}

// The before-state plus the facts about the mutation target that do NOT change
// across the mutation (scope, location, archived flag, affected-count, and the
// inherited account default). A policy op never alters which scope/location is
// targeted nor which active locations inherit, so the audit can read these from
// `before` and get exactly the value the old code re-read into `after`.
interface PolicyMutationBeforeState {
  snapshot: PolicySnapshot;
  scope: 'account_default' | 'location_override';
  locationId: string | null;
  locationArchived: boolean;
  affectedActiveLocationCount: number;
  accountDefault: PolicyRowState | null;
}

// The derived after-state. A pure function of (before, operation, newPolicyId) —
// see computeAfterState; never re-read from the DB.
interface PolicyMutationAfterState {
  snapshot: PolicySnapshot;
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
  db: SqlExecutor,
  input: GetAutoApprovalSettingsInput,
): Promise<AutoApprovalSettingsResponse> {
  const accountDefault = await loadAccountDefault(db, input.accountId);
  const locations = await loadActiveLocationSettings(db, input.accountId, accountDefault);
  // FP: all three reads share one db SqlExecutor (single pooled connection) and the prior read consumes accountDefault; sequential by design, not safely parallelizable.
  // react-doctor-disable-next-line react-doctor/server-sequential-independent-await
  const readiness = await buildReadiness(db, input.accountId, input.impersonated);

  return {
    accountDefault: toApiState(accountDefault),
    locations,
    readiness,
  };
}

export async function patchAutoApprovalSettings(
  sql: Sql,
  input: PatchAutoApprovalSettingsInput,
): Promise<AutoApprovalSettingsResponse> {
  if (input.impersonated) {
    throw new AutoApprovalExpansionBlockedError(['impersonation_not_allowed']);
  }

  return sql.begin(async (tx) => {
    await updatePolicyInTransaction(tx, input);
    return getAutoApprovalSettings(tx, {
      accountId: input.accountId,
      impersonated: input.impersonated,
    });
  });
}

async function updatePolicyInTransaction(
  tx: TransactionSql,
  input: PatchAutoApprovalSettingsInput,
): Promise<void> {
  await lockAccount(tx, input.accountId);

  // Gate BEFORE write: read the current state, derive the after-state purely,
  // assert the mutation is allowed (throws before any write), THEN mutate. The
  // "blocked => nothing written" guarantee is structural here, not a rollback
  // side effect. The lock + writes remain inside the caller's sql.begin().
  const before = await readBeforeState(tx, input);
  const newPolicyId = uuidv7();
  const after = computeAfterState(before, input, newPolicyId);
  const auditContext = await assertMutationAllowed(tx, input, before, after);
  await applyMutation(tx, input, newPolicyId);
  await writeAudit(tx, input, before, after, auditContext);
}

interface PolicyChangeAuditContext {
  beforeRank: number;
  afterRank: number;
  expansion: boolean;
  requiredConfirmationLevel: AutoApprovalConfirmationLevel | null;
  readiness: AutoApprovalReadiness;
}

// Spec §6, unified archived-location rules: a location's effective policy may
// not be expanded while archived, and an override may not be (re)set on an
// archived location at all. Setting an override re-arms auto-posting the moment
// the location reactivates; an expanding delete/manual exposes a higher account
// default. Previously split between captureBefore (set_location_override) and
// buildAuditContext (the expansion case); housed together here, before any write.
function assertArchivedPolicyAllowed(
  before: PolicyMutationBeforeState,
  input: PatchAutoApprovalSettingsInput,
  expansion: boolean,
): void {
  if (before.scope !== 'location_override' || !before.locationArchived) return;
  if (input.operation === 'set_location_override' || expansion) {
    throw new AutoApprovalSettingsError('location_inactive', 409);
  }
}

// Expansions past the confirmation threshold require the matching confirmation
// level. Returns the required level (or null) for the audit row.
function assertConfirmationProvided(
  input: PatchAutoApprovalSettingsInput,
  expansion: boolean,
): AutoApprovalConfirmationLevel | null {
  const requiredConfirmationLevel = expansion ? requiredConfirmation() : null;
  if (requiredConfirmationLevel && !confirmationSatisfies(input.confirmationLevel, requiredConfirmationLevel)) {
    throw new AutoApprovalConfirmationRequiredError(requiredConfirmationLevel);
  }
  return requiredConfirmationLevel;
}

// Reads readiness once (for the expansion gate) and returns it so the audit row
// can reuse it without a second read. Throws when an expansion isn't ready.
async function assertExpansionReady(
  tx: TransactionSql,
  input: PatchAutoApprovalSettingsInput,
  expansion: boolean,
): Promise<AutoApprovalReadiness> {
  const readiness = await buildReadiness(tx, input.accountId, input.impersonated);
  if (expansion && !readiness.canExpand) {
    throw new AutoApprovalExpansionBlockedError(readiness.blockReasons);
  }
  return readiness;
}

// Runs every reject gate BEFORE applyMutation and returns the context the audit
// row needs. Throws => the caller never reaches applyMutation, so nothing is
// written. Gate order is preserved: archived -> confirmation -> readiness.
async function assertMutationAllowed(
  tx: TransactionSql,
  input: PatchAutoApprovalSettingsInput,
  before: PolicyMutationBeforeState,
  after: PolicyMutationAfterState,
): Promise<PolicyChangeAuditContext> {
  const expansion = isThresholdExpansion(
    before.snapshot.effective.threshold,
    after.snapshot.effective.threshold,
  );

  assertArchivedPolicyAllowed(before, input, expansion);
  const requiredConfirmationLevel = assertConfirmationProvided(input, expansion);
  const readiness = await assertExpansionReady(tx, input, expansion);

  return {
    beforeRank: exposureRank(before.snapshot.effective.threshold),
    afterRank: exposureRank(after.snapshot.effective.threshold),
    expansion,
    requiredConfirmationLevel,
    readiness,
  };
}

async function writeAudit(
  tx: TransactionSql,
  input: PatchAutoApprovalSettingsInput,
  before: PolicyMutationBeforeState,
  after: PolicyMutationAfterState,
  context: PolicyChangeAuditContext,
): Promise<void> {
  await writeAccountAuditLog(tx, {
    accountId: input.accountId,
    locationId: before.locationId,
    actorUserId: input.actorUserId,
    eventType: 'auto_approval_policy_changed',
    entityType: 'auto_approval_policy',
    entityId: after.snapshot.row.policyId ?? before.snapshot.row.policyId,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
    requestId: input.requestId ?? null,
    payload: {
      operation: input.operation,
      scope: before.scope,
      locationId: before.locationId,
      beforeRow: before.snapshot.row,
      afterRow: after.snapshot.row,
      beforeEffectiveThreshold: before.snapshot.effective.threshold,
      afterEffectiveThreshold: after.snapshot.effective.threshold,
      beforeEffectiveSource: before.snapshot.effective.source,
      afterEffectiveSource: after.snapshot.effective.source,
      beforeExposureRank: context.beforeRank,
      afterExposureRank: context.afterRank,
      expansion: context.expansion,
      requiredConfirmationLevel: context.requiredConfirmationLevel,
      submittedConfirmationLevel: input.confirmationLevel ?? null,
      readiness: context.readiness,
      affectedActiveLocationCount: before.affectedActiveLocationCount,
      futureDefaultApplies: before.scope === 'account_default',
    },
  });
}

async function lockAccount(db: TransactionSql, accountId: string): Promise<void> {
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

async function readBeforeState(
  db: TransactionSql,
  input: PatchAutoApprovalSettingsInput,
): Promise<PolicyMutationBeforeState> {
  const accountDefault = await loadAccountDefault(db, input.accountId);

  if (!('locationId' in input)) {
    return {
      snapshot: {
        row: toApiState(accountDefault),
        effective: effectiveForAccountDefault(accountDefault),
      },
      scope: 'account_default',
      locationId: null,
      locationArchived: false,
      affectedActiveLocationCount: await countActiveInheritingLocations(db, input.accountId),
      accountDefault,
    };
  }

  // location_not_found is a read precondition (you cannot snapshot a location
  // that doesn't exist), so it stays here. The archived-location policy gates
  // live in assertMutationAllowed.
  const target = await loadTargetLocation(db, input.accountId, input.locationId);
  if (!target) {
    throw new AutoApprovalSettingsError('location_not_found', 404);
  }

  const locationOverride = await loadLocationOverride(db, input.accountId, input.locationId);

  return {
    snapshot: {
      row: toApiState(locationOverride),
      effective: resolveEffectivePolicy(accountDefault, locationOverride),
    },
    scope: 'location_override',
    locationId: input.locationId,
    locationArchived: target.archived_at !== null,
    affectedActiveLocationCount: target.archived_at === null ? 1 : 0,
    accountDefault,
  };
}

// PURE: the after-state is fully determined by (before, operation, newPolicyId).
// policyId mirrors the ON CONFLICT upsert: an update keeps the existing row id, a
// fresh insert uses newPolicyId (which applyMutation threads into the INSERT so
// the persisted row id equals this derived id — afterRow stays truthful).
function computeAfterState(
  before: PolicyMutationBeforeState,
  input: PatchAutoApprovalSettingsInput,
  newPolicyId: string,
): PolicyMutationAfterState {
  const upsertPolicyId = before.snapshot.row.exists
    ? (before.snapshot.row.policyId ?? newPolicyId)
    : newPolicyId;

  switch (input.operation) {
    case 'set_account_default':
      return accountDefaultAfter(upsertPolicyId, input.threshold);
    case 'set_account_manual':
      return accountDefaultAfter(upsertPolicyId, null);
    case 'clear_account_default':
      return { snapshot: { row: emptyApiState(), effective: noneEffective() } };
    case 'set_location_override':
      return locationOverrideAfter(upsertPolicyId, input.threshold);
    case 'set_location_manual':
      return locationOverrideAfter(upsertPolicyId, null);
    case 'delete_location_override':
      return {
        snapshot: {
          row: emptyApiState(),
          effective: resolveEffectivePolicy(before.accountDefault, null),
        },
      };
  }
}

function accountDefaultAfter(
  policyId: string,
  threshold: AutoApprovalThreshold | null,
): PolicyMutationAfterState {
  return {
    snapshot: {
      row: { policyId, threshold, exists: true },
      effective: { source: 'account_default', threshold, policyId },
    },
  };
}

// A present location override shadows the account default entirely, so its
// effective policy is the override itself.
function locationOverrideAfter(
  policyId: string,
  threshold: AutoApprovalThreshold | null,
): PolicyMutationAfterState {
  return {
    snapshot: {
      row: { policyId, threshold, exists: true },
      effective: { source: 'location_override', threshold, policyId },
    },
  };
}

function emptyApiState(): AutoApprovalPolicyApiState {
  return { policyId: null, threshold: null, exists: false };
}

function noneEffective(): EffectiveAutoApprovalPolicy {
  return resolveEffectivePolicy(null, null);
}

async function applyMutation(
  db: TransactionSql,
  input: PatchAutoApprovalSettingsInput,
  newPolicyId: string,
): Promise<void> {
  switch (input.operation) {
    case 'set_account_default':
      await upsertAccountDefault(db, newPolicyId, input.accountId, input.threshold);
      return;
    case 'set_account_manual':
      await upsertAccountDefault(db, newPolicyId, input.accountId, null);
      return;
    case 'clear_account_default':
      await db`
        DELETE FROM auto_approval_policies
        WHERE account_id = ${input.accountId}::uuid
          AND location_id IS NULL
      `;
      return;
    case 'set_location_override':
      await upsertLocationOverride(db, newPolicyId, input.accountId, input.locationId, input.threshold);
      return;
    case 'set_location_manual':
      await upsertLocationOverride(db, newPolicyId, input.accountId, input.locationId, null);
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
  db: TransactionSql,
  policyId: string,
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
      ${policyId}::uuid,
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
  db: TransactionSql,
  policyId: string,
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
      ${policyId}::uuid,
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
  // FP: both reads share one db SqlExecutor (single pooled connection); kept sequential rather than parallelized on the shared executor.
  // react-doctor-disable-next-line react-doctor/server-sequential-independent-await
  const offboardingState = await getOffboardingState(accountId, db);

  return buildAutoApprovalReadiness({
    runtimeEnabled,
    providerModerationEnabled: moderationEnabled,
    providerModerationValidated: moderationValidated,
    accountWritable: writable.ok && !isBillingMutationBlocked(offboardingState),
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
    // WS4 Task 12 removes this: the settings SELECTs don't load the dial
    // columns yet; safe defaults (migration-074 column defaults, not suspended).
    vetoWindowMinutes: 15,
    dailyAutoPostCap: null,
    suspendedAt: null,
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
  return resolveEffectivePolicy(policy, null);
}

function requiredConfirmation(): AutoApprovalConfirmationLevel {
  // WS4 Task 12 removes this: 'all_ratings' died with the 1-star option when
  // the threshold narrowed to the positive quadrant; every expansion now needs
  // the standard confirmation.
  return 'standard';
}

function confirmationSatisfies(
  submitted: AutoApprovalConfirmationLevel | undefined,
  required: AutoApprovalConfirmationLevel,
): boolean {
  if (required === 'all_ratings') return submitted === 'all_ratings';
  return submitted === 'standard' || submitted === 'all_ratings';
}
