// ── The Solicitation lane of the auto-approval settings (#631 D20) ──────────
//
// Extracted from `settings.ts` in #631's round-1 review (standards finding 7):
// the lane is a self-contained unit — its own row-state type, exposure
// classifier, expansion gate, audit writer, loader and upsert — and shares
// only the `./settings-guards` write-guards (`assertConfirmationProvided`,
// `accountSubscriptionWritable`, the entitlement row type) and
// `buildAutoApprovalReadiness` with the Reply machinery. `settings.ts` keeps the public interface: its
// `updatePolicyInTransaction` branches here for the two solicitation
// operations (the one PATCH join point), and its settings loader calls
// {@link loadSolicitationApiState} (the one GET join point).
//
// The Solicitation persona's opt-in is ONE row: the account default
// (`persona='solicitation'`, `action_class='sending'`, `location_id IS NULL`,
// migration 091). Enabling it is the D20 trust-dial opt-in the auto-approval
// gate (`src/lib/solicitation/auto-approval.ts`) reads; disabling DELETEs only
// that row — safe against suspension laundering because the Governor's
// account-wide kill switch is written on the REPLY account-default row
// (`suspendAccountAutonomy`), which this lane never touches, and the gate's
// suspension read is account-wide over any policy row (D19).
//
// Invariant #15: takes its DB client as an explicit parameter; invariant #14:
// server-owned — no browser code touches `auto_approval_policies`.

import type { Sql, TransactionSql } from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import type { getOffboardingState } from '@/lib/account-offboarding/gate';
import { isBillingMutationBlocked } from '@/lib/account-offboarding/gate';
import { tierGrantsAutopilot } from '@/lib/accounts/tier-config';
import { writeAccountAuditLog } from '@/lib/audit/log';
import { isPreviewEnvironment } from '@/lib/config/flags';
import { readAccountWideSuspension } from '@/lib/solicitation/auto-approval';
import {
  solicitationAutoApprovalEnabled,
  solicitationSendEnabled,
} from '@/lib/solicitation/flags';
import { resolveAccountDailySendCap } from '@/lib/solicitation/send-caps';
import { buildAutoApprovalReadiness } from './readiness';
import {
  AutoApprovalExpansionBlockedError,
  accountSubscriptionWritable,
  assertConfirmationProvided,
} from './settings-guards';
import type { SettingsAccountEntitlementRow } from './settings-guards';
import type { SolicitationPatchInput } from './settings';
import type {
  AutoApprovalConfirmationLevel,
  PolicyExposureClassification,
  SolicitationAutoApprovalApiState,
  SolicitationVetoWindowMinutes,
} from './types';
import {
  POLICY_ACTION_SENDING,
  POLICY_PERSONA_SOLICITATION,
  SOLICITATION_DEFAULT_VETO_WINDOW_MINUTES,
} from './types';

type SqlExecutor = Sql | TransactionSql;

interface SolicitationPolicyRowState {
  id: string;
  vetoWindowMinutes: number;
  dailySendCap: number | null;
  suspendedAt: Date | null;
}

interface SolicitationLaneConfig {
  vetoWindowMinutes: SolicitationVetoWindowMinutes;
  dailySendCap: number | null;
}

export async function applySolicitationMutation(
  tx: TransactionSql,
  input: SolicitationPatchInput,
  lockedAccount: SettingsAccountEntitlementRow,
  offboardingState: Awaited<ReturnType<typeof getOffboardingState>>,
): Promise<void> {
  const before = await loadSolicitationAccountDefault(tx, input.accountId);

  if (input.operation === 'clear_solicitation_account_default') {
    // A contraction is always allowed — no confirmation, no availability or
    // tier gate (a downgraded Copilot account must still be able to remove
    // its opt-in), mirroring the Reply lane's contraction rules.
    if (before !== null) {
      await tx`
        DELETE FROM auto_approval_policies
        WHERE account_id = ${input.accountId}::uuid
          AND location_id IS NULL
          AND persona = ${POLICY_PERSONA_SOLICITATION}
          AND action_class = ${POLICY_ACTION_SENDING}
      `;
    }
    await writeSolicitationAudit(tx, input, before, null, {
      exposureClassification: before !== null ? 'contraction' : 'no_change',
      expansion: false,
      requiredConfirmationLevel: null,
    });
    return;
  }

  // Declarative lane config: an omitted veto window means the 60-minute
  // default, never "keep stored" (types.ts schema comment).
  const after: SolicitationLaneConfig = {
    vetoWindowMinutes: input.vetoWindowMinutes ?? SOLICITATION_DEFAULT_VETO_WINDOW_MINUTES,
    dailySendCap: input.dailySendCap,
  };

  // Gate BEFORE write, same order as the Reply lane's assertMutationAllowed:
  // classify -> confirmation -> expansion readiness. Throws => nothing written.
  const exposureClassification = classifySolicitationExposure(before, after);
  const expansion = exposureClassification === 'expansion';
  const requiredConfirmationLevel = assertConfirmationProvided(input, expansion);
  if (expansion) {
    await assertSolicitationExpansionAllowed(tx, input, lockedAccount, offboardingState);
  }

  const newPolicyId = uuidv7();
  await upsertSolicitationAccountDefault(tx, newPolicyId, input.accountId, after);
  await writeSolicitationAudit(
    tx,
    input,
    before,
    {
      id: before?.id ?? newPolicyId,
      vetoWindowMinutes: after.vetoWindowMinutes,
      dailySendCap: after.dailySendCap,
      suspendedAt: before?.suspendedAt ?? null,
    },
    { exposureClassification, expansion, requiredConfirmationLevel },
  );
}

/**
 * Exposure classification for the Solicitation lane (the
 * classifyPolicyExposure analogue — policy.ts owns the Reply lane's 15/30
 * dial types, so this lane keeps its two dimensions here). Enabling the lane
 * — no row before — is ALWAYS an expansion: the opt-in itself is the exposure
 * (D20). On an existing row, a shorter veto window widens exposure, and the
 * cap is compared through resolveAccountDailySendCap so the platform clamp
 * ("the dial moves toward restraint only", <= 10) is what classifies: storing
 * 50 over a stored 30 changes nothing either enforces.
 */
function classifySolicitationExposure(
  before: SolicitationPolicyRowState | null,
  after: SolicitationLaneConfig,
): PolicyExposureClassification {
  if (before === null) return 'expansion';

  const windowDimension: PolicyExposureClassification =
    after.vetoWindowMinutes < before.vetoWindowMinutes
      ? 'expansion'
      : after.vetoWindowMinutes > before.vetoWindowMinutes
        ? 'contraction'
        : 'no_change';
  const effectiveCapBefore = resolveAccountDailySendCap({ dailySendCap: before.dailySendCap });
  const effectiveCapAfter = resolveAccountDailySendCap({ dailySendCap: after.dailySendCap });
  const capDimension: PolicyExposureClassification =
    effectiveCapAfter > effectiveCapBefore
      ? 'expansion'
      : effectiveCapAfter < effectiveCapBefore
        ? 'contraction'
        : 'no_change';

  const dimensions = [windowDimension, capDimension];
  if (dimensions.includes('expansion')) return 'expansion';
  if (dimensions.includes('contraction')) return 'contraction';
  return 'no_change';
}

/**
 * The Reply lane's expansion gate (assertExpansionReady) ported to the
 * Solicitation lane's availability facts: runtime = BOTH lane flags
 * (invariant #13 — a dark surface refuses writes, not just hides its card);
 * autopilot = tier entitlement ONLY (`tierGrantsAutopilot` — matching the GET
 * `available` contract; deliberately NOT `autopilotPurchasable`, because an
 * existing Autopilot subscriber keeps entitlement during a sales pause);
 * suspension = the account-wide Governor read (D19, matching
 * decideAutoApproval), not just the Reply default's flag. The provider
 * moderation inputs pass true — moderation readiness is a Reply-lane POSTING
 * precondition with no Solicitation analogue.
 */
async function assertSolicitationExpansionAllowed(
  tx: TransactionSql,
  input: SolicitationPatchInput,
  lockedAccount: SettingsAccountEntitlementRow,
  offboardingState: Awaited<ReturnType<typeof getOffboardingState>>,
): Promise<void> {
  // ONE owner of the D19 account-wide suspension read (R1 standards finding
  // 5): the same function `decideAutoApproval`'s conditions reader delegates
  // to, so this gate can never drift from the runtime gate about suspension.
  const anySuspended = await readAccountWideSuspension(tx, input.accountId);
  const readiness = buildAutoApprovalReadiness({
    runtimeEnabled: solicitationSendEnabled() && solicitationAutoApprovalEnabled(),
    autopilotAvailable: tierGrantsAutopilot(lockedAccount.subscription_tier),
    providerModerationEnabled: true,
    providerModerationValidated: true,
    accountWritable:
      accountSubscriptionWritable(lockedAccount)
      && !isBillingMutationBlocked(offboardingState),
    policySuspended: anySuspended,
    previewEnvironment: isPreviewEnvironment(),
    impersonated: input.impersonated,
  });
  if (!readiness.canExpand) {
    throw new AutoApprovalExpansionBlockedError(readiness.blockReasons);
  }
}

async function writeSolicitationAudit(
  tx: TransactionSql,
  input: SolicitationPatchInput,
  before: SolicitationPolicyRowState | null,
  after: SolicitationPolicyRowState | null,
  context: {
    exposureClassification: PolicyExposureClassification;
    expansion: boolean;
    requiredConfirmationLevel: AutoApprovalConfirmationLevel | null;
  },
): Promise<void> {
  await writeAccountAuditLog(tx, {
    accountId: input.accountId,
    locationId: null,
    actorUserId: input.actorUserId,
    eventType: 'auto_approval_policy_changed',
    entityType: 'auto_approval_policy',
    entityId: after?.id ?? before?.id ?? null,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
    requestId: input.requestId ?? null,
    payload: {
      operation: input.operation,
      persona: POLICY_PERSONA_SOLICITATION,
      scope: 'account_default',
      locationId: null,
      beforeRow: solicitationAuditRow(before),
      afterRow: solicitationAuditRow(after),
      beforeEnabled: before !== null,
      afterEnabled: after !== null,
      exposureClassification: context.exposureClassification,
      expansion: context.expansion,
      requiredConfirmationLevel: context.requiredConfirmationLevel,
      submittedConfirmationLevel: input.confirmationLevel ?? null,
    },
  });
}

function solicitationAuditRow(row: SolicitationPolicyRowState | null) {
  if (row === null) return null;
  return {
    policyId: row.id,
    vetoWindowMinutes: row.vetoWindowMinutes,
    dailySendCap: row.dailySendCap,
    effectiveDailySendCap: resolveAccountDailySendCap({ dailySendCap: row.dailySendCap }),
    suspended: row.suspendedAt !== null,
  };
}

async function loadSolicitationAccountDefault(
  db: SqlExecutor,
  accountId: string,
): Promise<SolicitationPolicyRowState | null> {
  const [row] = await db<{
    id: string;
    veto_window_minutes: number;
    daily_send_cap: number | null;
    suspended_at: Date | null;
  }[]>`
    SELECT id, veto_window_minutes, daily_send_cap, suspended_at
    FROM auto_approval_policies
    WHERE account_id = ${accountId}::uuid
      AND location_id IS NULL
      AND persona = ${POLICY_PERSONA_SOLICITATION}
      AND action_class = ${POLICY_ACTION_SENDING}
    LIMIT 1
  `;
  if (!row) return null;
  return {
    id: row.id,
    vetoWindowMinutes: row.veto_window_minutes,
    dailySendCap: row.daily_send_cap,
    suspendedAt: row.suspended_at,
  };
}

// ON CONFLICT target matches migration 074's account-default partial unique
// index BYTE-FOR-BYTE (the documented Postgres gotcha — see the block comment
// above upsertAccountDefault in settings.ts). Unlike the Reply lane's
// one-column DO UPDATE arms, this arm rewrites BOTH lane dials: the operation
// is declarative lane config, not a single-dial edit. auto_approve_min_star
// and daily_auto_post_cap stay NULL (091's persona-consistency CHECK), and
// the governor-owned suspension columns carry over untouched.
async function upsertSolicitationAccountDefault(
  db: TransactionSql,
  policyId: string,
  accountId: string,
  config: SolicitationLaneConfig,
): Promise<void> {
  await db`
    INSERT INTO auto_approval_policies (
      id,
      account_id,
      location_id,
      persona,
      action_class,
      veto_window_minutes,
      daily_send_cap,
      updated_at
    ) VALUES (
      ${policyId}::uuid,
      ${accountId}::uuid,
      NULL,
      ${POLICY_PERSONA_SOLICITATION},
      ${POLICY_ACTION_SENDING},
      ${config.vetoWindowMinutes},
      ${config.dailySendCap},
      NOW()
    )
    ON CONFLICT (account_id, persona, action_class) WHERE location_id IS NULL
    DO UPDATE SET
      veto_window_minutes = EXCLUDED.veto_window_minutes,
      daily_send_cap = EXCLUDED.daily_send_cap,
      updated_at = NOW()
  `;
}

export async function loadSolicitationApiState(
  db: SqlExecutor,
  accountId: string,
  account: SettingsAccountEntitlementRow | undefined,
): Promise<SolicitationAutoApprovalApiState> {
  const row = await loadSolicitationAccountDefault(db, accountId);
  return {
    available:
      solicitationSendEnabled()
      && solicitationAutoApprovalEnabled()
      && tierGrantsAutopilot(account?.subscription_tier),
    enabled: row !== null,
    dailySendCap: row?.dailySendCap ?? null,
    vetoWindowMinutes: row?.vetoWindowMinutes ?? null,
  };
}
