import type { Sql, TransactionSql } from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import {
  getOffboardingState,
  isBillingMutationBlocked,
  isOperationalUIBlocked,
} from '@/lib/account-offboarding/gate';
import { tierGrantsAutopilot } from '@/lib/accounts/tier-config';
import { writeAccountAuditLog } from '@/lib/audit/log';
import { isPreviewEnvironment } from '@/lib/config/flags';
import { autopilotPurchasable } from '@/lib/payments/tier-purchasability';
import type { AccountFlagsInput } from '@/lib/shared/past-due-recovery';
import { subscriptionGrantsFullAccess } from '@/lib/shared/subscription-status';
import { assertWritableSubscriptionStatus } from '@/lib/shared/writable-subscription';
import {
  autoApprovalRuntimeEnabled,
  providerModerationEnabled,
  providerModerationValidated,
} from './flags';
import {
  DEFAULT_VETO_WINDOW_MINUTES,
  classifyPolicyExposure,
  exposureRank,
  resolveDailyCap,
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
  PolicyExposureClassification,
  VetoWindowMinutes,
} from './types';
import {
  POLICY_ACTION_POSTING,
  POLICY_PERSONA_REPLY,
  isAutoApprovalThreshold,
  isVetoWindowMinutes,
} from './types';

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
  veto_window_minutes: number;
  daily_auto_post_cap: number | null;
  suspended_at: Date | null;
  suspended_reason: string | null;
}

// suspended_reason is surfaced only by the settings API today, so the field
// extends the shared row state here instead of widening PolicyRowState for
// every consumer (the worker evaluator and admin mappers never read it).
interface SettingsPolicyRow extends PolicyRowState {
  suspendedReason: string | null;
}

interface LocationPolicyRow {
  location_id: string;
  display_name: string;
  policy_id: string | null;
  policy_account_id: string | null;
  auto_approve_min_star: number | null;
  veto_window_minutes: number | null;
  daily_auto_post_cap: number | null;
  suspended_at: Date | null;
  suspended_reason: string | null;
}

interface TargetLocationRow {
  id: string;
  name: string;
  display_label: string | null;
  archived_at: Date | null;
}

interface SettingsAccountEntitlementRow {
  id: string;
  subscription_tier: string;
  subscription_status: string;
  past_due_at: Date | string | null;
  flags: AccountFlagsInput;
}

// One point-in-time view of the targeted policy: its API row plus the effective
// policy that results for the targeted scope.
interface PolicySnapshot {
  row: AutoApprovalPolicyApiState;
  effective: EffectiveAutoApprovalPolicy;
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
  accountDefault: SettingsPolicyRow | null;
  // The raw row for the TARGETED scope (accountDefault for account ops, the
  // location override for location ops): the base an upsert merges into.
  targetRow: SettingsPolicyRow | null;
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
  return loadAutoApprovalSettings(db, input);
}

async function loadAutoApprovalSettings(
  db: SqlExecutor,
  input: GetAutoApprovalSettingsInput,
  lockedAccount?: SettingsAccountEntitlementRow,
): Promise<AutoApprovalSettingsResponse> {
  const accountDefault = await loadAccountDefault(db, input.accountId);
  const locations = await loadActiveLocationSettings(db, input.accountId, accountDefault);
  // PATCH passes the account row captured by its opening FOR UPDATE. GET has no
  // mutation lock, so it loads the same projection once for its point-in-time
  // readiness response.
  const account = lockedAccount ?? await loadSettingsAccount(db, input.accountId);
  // FP: all three reads share one db SqlExecutor (single pooled connection) and the prior read consumes accountDefault; sequential by design, not safely parallelizable.
  // react-doctor-disable-next-line react-doctor/server-sequential-independent-await
  const readiness = await buildReadiness(db, input.accountId, {
    impersonated: input.impersonated,
    policySuspended: Boolean(accountDefault?.suspendedAt),
  }, account);

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
    const lockedAccount = await updatePolicyInTransaction(tx, input);
    return loadAutoApprovalSettings(tx, {
      accountId: input.accountId,
      impersonated: input.impersonated,
    }, lockedAccount);
  });
}

async function updatePolicyInTransaction(
  tx: TransactionSql,
  input: PatchAutoApprovalSettingsInput,
): Promise<SettingsAccountEntitlementRow> {
  const lockedAccount = await lockAccount(tx, input.accountId);
  const offboardingState = await getOffboardingState(input.accountId, tx);
  if (isOperationalUIBlocked(offboardingState)) {
    throw new AutoApprovalSettingsError('account_offboarding_blocked', 403);
  }

  // Gate BEFORE write: read the current state, derive the after-state purely,
  // assert the mutation is allowed (throws before any write), THEN mutate. The
  // "blocked => nothing written" guarantee is structural here, not a rollback
  // side effect. The lock + writes remain inside the caller's sql.begin().
  const before = await readBeforeState(tx, input);
  const newPolicyId = uuidv7();
  const after = computeAfterState(before, input, newPolicyId);
  const auditContext = await assertMutationAllowed(tx, input, before, after, lockedAccount);
  await applyMutation(tx, input, newPolicyId, before);
  await writeAudit(tx, input, before, after, auditContext);
  return lockedAccount;
}

interface PolicyChangeAuditContext {
  beforeRank: number;
  afterRank: number;
  expansion: boolean;
  exposureClassification: PolicyExposureClassification;
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

// Every expansion requires the 'standard' confirmation ('all_ratings' died
// with the 1-star threshold in WS4). Any submitted level satisfies it — a
// stale cached client may still send 'all_ratings', and the pre-WS4
// confirmationSatisfies already accepted it as covering 'standard'; that
// tolerance is kept for one release (see the schema comment in types.ts).
// Returns the required level (or null) for the audit row.
function assertConfirmationProvided(
  input: PatchAutoApprovalSettingsInput,
  expansion: boolean,
): AutoApprovalConfirmationLevel | null {
  if (!expansion) return null;
  if (input.confirmationLevel === undefined) {
    throw new AutoApprovalConfirmationRequiredError('standard');
  }
  return 'standard';
}

// Reads readiness once (for the expansion gate) and returns it so the audit row
// can reuse it without a second read. Throws when an expansion isn't ready.
// The suspension input is the targeted scope's effective flag (account-default
// OR winning row suspended — spec §2.4), so a suspended policy blocks
// expansion while contractions and dial changes stay allowed.
async function assertExpansionReady(
  tx: TransactionSql,
  input: PatchAutoApprovalSettingsInput,
  before: PolicyMutationBeforeState,
  expansion: boolean,
  lockedAccount: SettingsAccountEntitlementRow,
): Promise<AutoApprovalReadiness> {
  const readiness = await buildReadiness(tx, input.accountId, {
    impersonated: input.impersonated,
    policySuspended: before.snapshot.effective.suspended,
  }, lockedAccount);
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
  lockedAccount: SettingsAccountEntitlementRow,
): Promise<PolicyChangeAuditContext> {
  const exposureClassification = classifyPolicyExposure(
    before.snapshot.effective,
    after.snapshot.effective,
    { completeDisable: isCompleteDisable(input, before, after.snapshot.effective) },
  );
  const expansion = exposureClassification === 'expansion';

  assertArchivedPolicyAllowed(before, input, expansion);
  const requiredConfirmationLevel = assertConfirmationProvided(input, expansion);
  const readiness = await assertExpansionReady(tx, input, before, expansion, lockedAccount);

  return {
    beforeRank: exposureRank(before.snapshot.effective.threshold),
    afterRank: exposureRank(after.snapshot.effective.threshold),
    expansion,
    exposureClassification,
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
      beforeEffectiveVetoWindowMinutes: before.snapshot.effective.vetoWindowMinutes,
      afterEffectiveVetoWindowMinutes: after.snapshot.effective.vetoWindowMinutes,
      beforeEffectiveDailyAutoPostCap: before.snapshot.effective.dailyAutoPostCap,
      afterEffectiveDailyAutoPostCap: after.snapshot.effective.dailyAutoPostCap,
      beforeEffectiveDailyCap: resolveDailyCap(before.snapshot.effective),
      afterEffectiveDailyCap: resolveDailyCap(after.snapshot.effective),
      beforeEffectiveSource: before.snapshot.effective.source,
      afterEffectiveSource: after.snapshot.effective.source,
      beforeExposureRank: context.beforeRank,
      afterExposureRank: context.afterRank,
      // Which shape a clear/delete op ran (null for non-clear ops): 'delete'
      // removed the row, 'threshold_null_suspended' preserved a suspended row
      // by NULLing only the threshold (see clearsSuspendedRow).
      clearedVia: clearShapeFor(input, before),
      exposureClassification: context.exposureClassification,
      expansion: context.expansion,
      requiredConfirmationLevel: context.requiredConfirmationLevel,
      submittedConfirmationLevel: input.confirmationLevel ?? null,
      readiness: context.readiness,
      affectedActiveLocationCount: before.affectedActiveLocationCount,
      futureDefaultApplies: before.scope === 'account_default',
    },
  });
}

async function lockAccount(
  db: TransactionSql,
  accountId: string,
): Promise<SettingsAccountEntitlementRow> {
  const [account] = await db<SettingsAccountEntitlementRow[]>`
    SELECT id, subscription_tier, subscription_status, past_due_at, flags
    FROM accounts
    WHERE id = ${accountId}::uuid
    FOR UPDATE
  `;
  if (!account) {
    throw new AutoApprovalSettingsError('account_not_found', 404);
  }
  return account;
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
      targetRow: accountDefault,
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
    targetRow: locationOverride,
  };
}

// The single column a mutation writes; every other column carries over from
// the targeted row (or the column default on a fresh insert). Mirrors the
// per-operation upserts in applyMutation exactly.
type PolicyRowPatch =
  | { threshold: AutoApprovalThreshold | null }
  | { vetoWindowMinutes: VetoWindowMinutes }
  | { dailyAutoPostCap: number | null };

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
    case 'set_location_override':
      return upsertAfter(before, input.accountId, upsertPolicyId, { threshold: input.threshold });
    case 'set_account_manual':
    case 'set_location_manual':
      return upsertAfter(before, input.accountId, upsertPolicyId, { threshold: null });
    case 'set_account_veto_window':
    case 'set_location_veto_window':
      return upsertAfter(before, input.accountId, upsertPolicyId, { vetoWindowMinutes: input.minutes });
    case 'set_account_daily_cap':
    case 'set_location_daily_cap':
      return upsertAfter(before, input.accountId, upsertPolicyId, { dailyAutoPostCap: input.cap });
    // A clear/delete on a suspended row degrades to a threshold-NULL update
    // (clearsSuspendedRow) — the row, its dials, and the suspension survive.
    case 'clear_account_default':
      if (clearsSuspendedRow(before)) {
        return upsertAfter(before, input.accountId, upsertPolicyId, { threshold: null });
      }
      return { snapshot: { row: toApiState(null), effective: noneEffective() } };
    case 'delete_location_override':
      if (clearsSuspendedRow(before)) {
        return upsertAfter(before, input.accountId, upsertPolicyId, { threshold: null });
      }
      return {
        snapshot: {
          row: toApiState(null),
          effective: resolveEffectivePolicy(before.accountDefault, null),
        },
      };
  }
}

const LOCATION_DIAL_OPERATIONS = new Set<PatchAutoApprovalSettingsInput['operation']>([
  'set_location_veto_window',
  'set_location_daily_cap',
]);

const COMPLETE_DISABLE_OPERATIONS = new Set<PatchAutoApprovalSettingsInput['operation']>([
  'set_account_manual',
  'clear_account_default',
  'set_location_manual',
  'delete_location_override',
]);

function createsManualLocationOverride(
  input: PatchAutoApprovalSettingsInput,
  before: PolicyMutationBeforeState,
): boolean {
  return before.scope === 'location_override'
    && before.targetRow === null
    && LOCATION_DIAL_OPERATIONS.has(input.operation);
}

function transitionsEnabledPolicyToManual(
  input: PatchAutoApprovalSettingsInput,
  before: PolicyMutationBeforeState,
  after: EffectiveAutoApprovalPolicy,
): boolean {
  return before.snapshot.effective.threshold !== null
    && after.threshold === null
    && COMPLETE_DISABLE_OPERATIONS.has(input.operation);
}

function isCompleteDisable(
  input: PatchAutoApprovalSettingsInput,
  before: PolicyMutationBeforeState,
  after: EffectiveAutoApprovalPolicy,
): boolean {
  // WS4 §6: a veto/cap PATCH that creates a previously-rowless location
  // override always switches that location to manual approval. That operation
  // is a contraction/non-expansion even when the target dial by itself widens.
  if (createsManualLocationOverride(input, before)) return true;

  // A clear/manual operation is a complete disable only when it actually
  // transitions enabled automation to manual. Manual -> manual delete/clear
  // must still classify inherited dial widening (for example 30 -> 15 or a
  // finite cap -> NULL) as an expansion.
  return transitionsEnabledPolicyToManual(input, before, after);
}

// Finding-1 rule (spec §6): a policy mutation never DELETEs a row carrying a
// governor-owned suspension. Deleting would launder the suspension — clearing
// is a contraction (allowed while suspended), and a later re-create would read
// suspended=false, silently re-arming auto-posting past the governor. Instead
// the clear NULLs auto_approve_min_star (the scope returns to manual approval)
// while suspended_at/suspended_reason and the dial columns survive.
function clearsSuspendedRow(before: PolicyMutationBeforeState): boolean {
  return before.targetRow?.suspendedAt != null;
}

// Which shape a clear/delete op runs, recorded on the audit row. Null for
// operations that are not clears.
function clearShapeFor(
  input: PatchAutoApprovalSettingsInput,
  before: PolicyMutationBeforeState,
): 'delete' | 'threshold_null_suspended' | null {
  if (input.operation !== 'clear_account_default' && input.operation !== 'delete_location_override') {
    return null;
  }
  return clearsSuspendedRow(before) ? 'threshold_null_suspended' : 'delete';
}

// The full row an operation persists when it must CREATE the target row (the
// INSERT arm of the upserts). Every column not targeted by the patch is
// seeded: a location override snapshots the account default's stored dial
// values — finding-2 rule (spec §6): a dial-only or threshold op that
// implicitly creates an override must not silently swap the account's
// stricter explicit cap/window for schema defaults ("gives this location its
// own settings" means: what the location effectively had). Account-default
// rows have no parent, so schema defaults stand — as they do for a location
// when no account default exists. The threshold is never seeded: a fresh row
// starts on manual approval (NULL threshold — a contraction, never an
// expansion needing confirmation).
interface PolicyInsertSeed {
  threshold: AutoApprovalThreshold | null;
  vetoWindowMinutes: VetoWindowMinutes;
  dailyAutoPostCap: number | null;
}

function freshRowSeed(
  before: PolicyMutationBeforeState,
  patch: PolicyRowPatch,
): PolicyInsertSeed {
  const inheritFrom = before.scope === 'location_override' ? before.accountDefault : null;
  return {
    threshold: 'threshold' in patch ? patch.threshold : null,
    vetoWindowMinutes:
      'vetoWindowMinutes' in patch
        ? patch.vetoWindowMinutes
        : inheritFrom?.vetoWindowMinutes ?? DEFAULT_VETO_WINDOW_MINUTES,
    dailyAutoPostCap:
      'dailyAutoPostCap' in patch
        ? patch.dailyAutoPostCap
        : inheritFrom?.dailyAutoPostCap ?? null,
  };
}

// The upserted row: the targeted row's values merged with the patch, or — when
// no row exists — the freshly seeded row (freshRowSeed). Suspension fields are
// governor-owned and carry over untouched. A present location override shadows
// the account default entirely, so the location-scope effective policy is the
// override itself.
function upsertAfter(
  before: PolicyMutationBeforeState,
  accountId: string,
  policyId: string,
  patch: PolicyRowPatch,
): PolicyMutationAfterState {
  const current = before.targetRow;
  const seed = freshRowSeed(before, patch);
  const afterRow: SettingsPolicyRow = {
    id: policyId,
    accountId,
    locationId: before.locationId,
    autoApproveMinStar:
      'threshold' in patch ? patch.threshold : current ? current.autoApproveMinStar : seed.threshold,
    vetoWindowMinutes:
      'vetoWindowMinutes' in patch
        ? patch.vetoWindowMinutes
        : current
          ? current.vetoWindowMinutes
          : seed.vetoWindowMinutes,
    dailyAutoPostCap:
      'dailyAutoPostCap' in patch
        ? patch.dailyAutoPostCap
        : current
          ? current.dailyAutoPostCap
          : seed.dailyAutoPostCap,
    suspendedAt: current?.suspendedAt ?? null,
    suspendedReason: current?.suspendedReason ?? null,
  };

  return {
    snapshot: {
      row: toApiState(afterRow),
      effective:
        before.scope === 'account_default'
          ? resolveEffectivePolicy(afterRow, null)
          : resolveEffectivePolicy(before.accountDefault, afterRow),
    },
  };
}

function noneEffective(): EffectiveAutoApprovalPolicy {
  return resolveEffectivePolicy(null, null);
}

async function applyMutation(
  db: TransactionSql,
  input: PatchAutoApprovalSettingsInput,
  newPolicyId: string,
  before: PolicyMutationBeforeState,
): Promise<void> {
  switch (input.operation) {
    case 'set_account_default':
      await upsertAccountDefault(db, newPolicyId, input.accountId, freshRowSeed(before, { threshold: input.threshold }));
      return;
    case 'set_account_manual':
      await upsertAccountDefault(db, newPolicyId, input.accountId, freshRowSeed(before, { threshold: null }));
      return;
    case 'set_account_veto_window':
      await upsertAccountVetoWindow(db, newPolicyId, input.accountId, freshRowSeed(before, { vetoWindowMinutes: input.minutes }));
      return;
    case 'set_account_daily_cap':
      await upsertAccountDailyCap(db, newPolicyId, input.accountId, freshRowSeed(before, { dailyAutoPostCap: input.cap }));
      return;
    case 'clear_account_default':
      // Finding-1 rule: never DELETE a suspended row (see clearsSuspendedRow).
      if (clearsSuspendedRow(before)) {
        await db`
          UPDATE auto_approval_policies
          SET auto_approve_min_star = NULL, updated_at = NOW()
          WHERE account_id = ${input.accountId}::uuid
            AND location_id IS NULL
            AND persona = ${POLICY_PERSONA_REPLY}
            AND action_class = ${POLICY_ACTION_POSTING}
        `;
        return;
      }
      await db`
        DELETE FROM auto_approval_policies
        WHERE account_id = ${input.accountId}::uuid
          AND location_id IS NULL
          AND persona = ${POLICY_PERSONA_REPLY}
          AND action_class = ${POLICY_ACTION_POSTING}
      `;
      return;
    case 'set_location_override':
      await upsertLocationOverride(db, newPolicyId, input.accountId, input.locationId, freshRowSeed(before, { threshold: input.threshold }));
      return;
    case 'set_location_manual':
      await upsertLocationOverride(db, newPolicyId, input.accountId, input.locationId, freshRowSeed(before, { threshold: null }));
      return;
    case 'set_location_veto_window':
      await upsertLocationVetoWindow(db, newPolicyId, input.accountId, input.locationId, freshRowSeed(before, { vetoWindowMinutes: input.minutes }));
      return;
    case 'set_location_daily_cap':
      await upsertLocationDailyCap(db, newPolicyId, input.accountId, input.locationId, freshRowSeed(before, { dailyAutoPostCap: input.cap }));
      return;
    case 'delete_location_override':
      // Finding-1 rule: never DELETE a suspended row (see clearsSuspendedRow).
      if (clearsSuspendedRow(before)) {
        await db`
          UPDATE auto_approval_policies
          SET auto_approve_min_star = NULL, updated_at = NOW()
          WHERE account_id = ${input.accountId}::uuid
            AND location_id = ${input.locationId}::uuid
            AND persona = ${POLICY_PERSONA_REPLY}
            AND action_class = ${POLICY_ACTION_POSTING}
        `;
        return;
      }
      await db`
        DELETE FROM auto_approval_policies
        WHERE account_id = ${input.accountId}::uuid
          AND location_id = ${input.locationId}::uuid
          AND persona = ${POLICY_PERSONA_REPLY}
          AND action_class = ${POLICY_ACTION_POSTING}
      `;
      return;
  }
}

// Every upsert's ON CONFLICT target matches its migration-074 partial unique
// index BYTE-FOR-BYTE (documented Postgres gotcha — a mismatched clause fails
// with no-matching-constraint): account default rows conflict on
// `(account_id, persona, action_class) WHERE location_id IS NULL`, location
// override rows on
// `(account_id, location_id, persona, action_class) WHERE location_id IS NOT NULL`.
// Each DO UPDATE arm updates exactly ONE owner-facing column so a dial change
// never clobbers the threshold and vice versa. The INSERT arm persists the
// full freshRowSeed — target column plus the seeded non-target columns (a
// location row inherits the account default's stored dial values; upsertAfter
// mirrors this merge semantics exactly).

async function upsertAccountDefault(
  db: TransactionSql,
  policyId: string,
  accountId: string,
  seed: PolicyInsertSeed,
): Promise<void> {
  await db`
    INSERT INTO auto_approval_policies (
      id,
      account_id,
      location_id,
      persona,
      action_class,
      auto_approve_min_star,
      veto_window_minutes,
      daily_auto_post_cap,
      updated_at
    ) VALUES (
      ${policyId}::uuid,
      ${accountId}::uuid,
      NULL,
      ${POLICY_PERSONA_REPLY},
      ${POLICY_ACTION_POSTING},
      ${seed.threshold},
      ${seed.vetoWindowMinutes},
      ${seed.dailyAutoPostCap},
      NOW()
    )
    ON CONFLICT (account_id, persona, action_class) WHERE location_id IS NULL
    DO UPDATE SET
      auto_approve_min_star = EXCLUDED.auto_approve_min_star,
      updated_at = NOW()
  `;
}

async function upsertAccountVetoWindow(
  db: TransactionSql,
  policyId: string,
  accountId: string,
  seed: PolicyInsertSeed,
): Promise<void> {
  await db`
    INSERT INTO auto_approval_policies (
      id,
      account_id,
      location_id,
      persona,
      action_class,
      auto_approve_min_star,
      veto_window_minutes,
      daily_auto_post_cap,
      updated_at
    ) VALUES (
      ${policyId}::uuid,
      ${accountId}::uuid,
      NULL,
      ${POLICY_PERSONA_REPLY},
      ${POLICY_ACTION_POSTING},
      ${seed.threshold},
      ${seed.vetoWindowMinutes},
      ${seed.dailyAutoPostCap},
      NOW()
    )
    ON CONFLICT (account_id, persona, action_class) WHERE location_id IS NULL
    DO UPDATE SET
      veto_window_minutes = EXCLUDED.veto_window_minutes,
      updated_at = NOW()
  `;
}

async function upsertAccountDailyCap(
  db: TransactionSql,
  policyId: string,
  accountId: string,
  seed: PolicyInsertSeed,
): Promise<void> {
  await db`
    INSERT INTO auto_approval_policies (
      id,
      account_id,
      location_id,
      persona,
      action_class,
      auto_approve_min_star,
      veto_window_minutes,
      daily_auto_post_cap,
      updated_at
    ) VALUES (
      ${policyId}::uuid,
      ${accountId}::uuid,
      NULL,
      ${POLICY_PERSONA_REPLY},
      ${POLICY_ACTION_POSTING},
      ${seed.threshold},
      ${seed.vetoWindowMinutes},
      ${seed.dailyAutoPostCap},
      NOW()
    )
    ON CONFLICT (account_id, persona, action_class) WHERE location_id IS NULL
    DO UPDATE SET
      daily_auto_post_cap = EXCLUDED.daily_auto_post_cap,
      updated_at = NOW()
  `;
}

async function upsertLocationOverride(
  db: TransactionSql,
  policyId: string,
  accountId: string,
  locationId: string,
  seed: PolicyInsertSeed,
): Promise<void> {
  await db`
    INSERT INTO auto_approval_policies (
      id,
      account_id,
      location_id,
      persona,
      action_class,
      auto_approve_min_star,
      veto_window_minutes,
      daily_auto_post_cap,
      updated_at
    ) VALUES (
      ${policyId}::uuid,
      ${accountId}::uuid,
      ${locationId}::uuid,
      ${POLICY_PERSONA_REPLY},
      ${POLICY_ACTION_POSTING},
      ${seed.threshold},
      ${seed.vetoWindowMinutes},
      ${seed.dailyAutoPostCap},
      NOW()
    )
    ON CONFLICT (account_id, location_id, persona, action_class) WHERE location_id IS NOT NULL
    DO UPDATE SET
      auto_approve_min_star = EXCLUDED.auto_approve_min_star,
      updated_at = NOW()
  `;
}

async function upsertLocationVetoWindow(
  db: TransactionSql,
  policyId: string,
  accountId: string,
  locationId: string,
  seed: PolicyInsertSeed,
): Promise<void> {
  await db`
    INSERT INTO auto_approval_policies (
      id,
      account_id,
      location_id,
      persona,
      action_class,
      auto_approve_min_star,
      veto_window_minutes,
      daily_auto_post_cap,
      updated_at
    ) VALUES (
      ${policyId}::uuid,
      ${accountId}::uuid,
      ${locationId}::uuid,
      ${POLICY_PERSONA_REPLY},
      ${POLICY_ACTION_POSTING},
      ${seed.threshold},
      ${seed.vetoWindowMinutes},
      ${seed.dailyAutoPostCap},
      NOW()
    )
    ON CONFLICT (account_id, location_id, persona, action_class) WHERE location_id IS NOT NULL
    DO UPDATE SET
      veto_window_minutes = EXCLUDED.veto_window_minutes,
      updated_at = NOW()
  `;
}

async function upsertLocationDailyCap(
  db: TransactionSql,
  policyId: string,
  accountId: string,
  locationId: string,
  seed: PolicyInsertSeed,
): Promise<void> {
  await db`
    INSERT INTO auto_approval_policies (
      id,
      account_id,
      location_id,
      persona,
      action_class,
      auto_approve_min_star,
      veto_window_minutes,
      daily_auto_post_cap,
      updated_at
    ) VALUES (
      ${policyId}::uuid,
      ${accountId}::uuid,
      ${locationId}::uuid,
      ${POLICY_PERSONA_REPLY},
      ${POLICY_ACTION_POSTING},
      ${seed.threshold},
      ${seed.vetoWindowMinutes},
      ${seed.dailyAutoPostCap},
      NOW()
    )
    ON CONFLICT (account_id, location_id, persona, action_class) WHERE location_id IS NOT NULL
    DO UPDATE SET
      daily_auto_post_cap = EXCLUDED.daily_auto_post_cap,
      updated_at = NOW()
  `;
}

async function loadAccountDefault(
  db: SqlExecutor,
  accountId: string,
): Promise<SettingsPolicyRow | null> {
  const [row] = await db<PolicyDbRow[]>`
    SELECT id, account_id, location_id, auto_approve_min_star,
           veto_window_minutes, daily_auto_post_cap, suspended_at, suspended_reason
    FROM auto_approval_policies
    WHERE account_id = ${accountId}::uuid
      AND location_id IS NULL
      AND persona = ${POLICY_PERSONA_REPLY}
      AND action_class = ${POLICY_ACTION_POSTING}
    LIMIT 1
  `;

  return row ? toPolicyRow(row) : null;
}

async function loadLocationOverride(
  db: SqlExecutor,
  accountId: string,
  locationId: string,
): Promise<SettingsPolicyRow | null> {
  const [row] = await db<PolicyDbRow[]>`
    SELECT id, account_id, location_id, auto_approve_min_star,
           veto_window_minutes, daily_auto_post_cap, suspended_at, suspended_reason
    FROM auto_approval_policies
    WHERE account_id = ${accountId}::uuid
      AND location_id = ${locationId}::uuid
      AND persona = ${POLICY_PERSONA_REPLY}
      AND action_class = ${POLICY_ACTION_POSTING}
    LIMIT 1
  `;

  return row ? toPolicyRow(row) : null;
}

async function loadActiveLocationSettings(
  db: SqlExecutor,
  accountId: string,
  accountDefault: SettingsPolicyRow | null,
): Promise<AutoApprovalSettingsResponse['locations']> {
  const rows = await db<LocationPolicyRow[]>`
    SELECT
      b.id AS location_id,
      COALESCE(b.display_label, b.name) AS display_name,
      p.id AS policy_id,
      p.account_id AS policy_account_id,
      p.auto_approve_min_star,
      p.veto_window_minutes,
      p.daily_auto_post_cap,
      p.suspended_at,
      p.suspended_reason
    FROM businesses b
    LEFT JOIN auto_approval_policies p
      ON p.account_id = ${accountId}::uuid
     AND p.account_id = b.account_id
     AND p.location_id = b.id
     AND p.persona = ${POLICY_PERSONA_REPLY}
     AND p.action_class = ${POLICY_ACTION_POSTING}
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
          // LEFT JOIN nulls only when policy_id is null, which this branch excludes.
          veto_window_minutes: row.veto_window_minutes ?? DEFAULT_VETO_WINDOW_MINUTES,
          daily_auto_post_cap: row.daily_auto_post_cap,
          suspended_at: row.suspended_at,
          suspended_reason: row.suspended_reason,
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
        vetoWindowMinutes: effective.vetoWindowMinutes,
        dailyAutoPostCap: effective.dailyAutoPostCap,
        effectiveDailyCap: resolveDailyCap(effective),
        suspended: effective.suspended,
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
     AND p.persona = ${POLICY_PERSONA_REPLY}
     AND p.action_class = ${POLICY_ACTION_POSTING}
    WHERE b.account_id = ${accountId}::uuid
      AND b.archived_at IS NULL
      AND p.id IS NULL
  `;
  return row?.count ?? 0;
}

async function loadSettingsAccount(
  db: SqlExecutor,
  accountId: string,
): Promise<SettingsAccountEntitlementRow | undefined> {
  const [account] = await db<SettingsAccountEntitlementRow[]>`
    SELECT id, subscription_tier, subscription_status, past_due_at, flags
    FROM accounts
    WHERE id = ${accountId}::uuid
    LIMIT 1
  `;
  return account;
}

async function buildReadiness(
  db: SqlExecutor,
  accountId: string,
  context: { impersonated: boolean; policySuspended: boolean },
  account: SettingsAccountEntitlementRow | undefined,
): Promise<AutoApprovalReadiness> {
  const runtimeEnabled = autoApprovalRuntimeEnabled();
  const moderationEnabled = providerModerationEnabled();
  const moderationValidated = providerModerationValidated();
  const preview = isPreviewEnvironment();
  const offboardingState = await getOffboardingState(accountId, db);
  const accountWritable = Boolean(account && accountSubscriptionWritable(account))
    && !isBillingMutationBlocked(offboardingState);
  const autopilotAvailable = Boolean(
    tierGrantsAutopilot(account?.subscription_tier)
      && autopilotPurchasable(),
  );

  return buildAutoApprovalReadiness({
    runtimeEnabled,
    autopilotAvailable,
    providerModerationEnabled: moderationEnabled,
    providerModerationValidated: moderationValidated,
    accountWritable,
    policySuspended: context.policySuspended,
    previewEnvironment: preview,
    impersonated: context.impersonated,
  });
}

function accountSubscriptionWritable(account: SettingsAccountEntitlementRow): boolean {
  if (subscriptionGrantsFullAccess(account.subscription_status)) return true;
  return assertWritableSubscriptionStatus({
    subscriptionStatus: account.subscription_status,
    pastDueAt: account.past_due_at,
    accountFlags: account.flags,
  }).ok;
}

function toPolicyRow(row: PolicyDbRow): SettingsPolicyRow {
  return {
    id: row.id,
    accountId: row.account_id,
    locationId: row.location_id,
    autoApproveMinStar: toThreshold(row.auto_approve_min_star),
    vetoWindowMinutes: toVetoWindow(row.veto_window_minutes),
    dailyAutoPostCap: row.daily_auto_post_cap,
    suspendedAt: row.suspended_at,
    suspendedReason: row.suspended_reason,
  };
}

function toThreshold(value: number | null): AutoApprovalThreshold | null {
  if (value === null) return null;
  if (!isAutoApprovalThreshold(value)) {
    throw new AutoApprovalSettingsError('invalid_policy_threshold', 500);
  }
  return value;
}

function toVetoWindow(value: number): VetoWindowMinutes {
  if (!isVetoWindowMinutes(value)) {
    throw new AutoApprovalSettingsError('invalid_policy_veto_window', 500);
  }
  return value;
}

// null (no row) yields the column defaults: 15-minute window, platform cap,
// not suspended — the values a fresh upsert would persist.
function toApiState(policy: SettingsPolicyRow | null): AutoApprovalPolicyApiState {
  const dailyAutoPostCap = policy?.dailyAutoPostCap ?? null;
  return {
    policyId: policy?.id ?? null,
    threshold: policy?.autoApproveMinStar ?? null,
    exists: Boolean(policy),
    vetoWindowMinutes: policy?.vetoWindowMinutes ?? DEFAULT_VETO_WINDOW_MINUTES,
    dailyAutoPostCap,
    effectiveDailyCap: resolveDailyCap({ dailyAutoPostCap }),
    suspended: Boolean(policy?.suspendedAt),
    suspendedReason: policy?.suspendedReason ?? null,
  };
}

function effectiveForAccountDefault(
  policy: SettingsPolicyRow | null,
): EffectiveAutoApprovalPolicy {
  return resolveEffectivePolicy(policy, null);
}
