// The Apply protocol (spec §6.4): one call, one transaction, one **Receipt**.
//
// LOCK BEFORE CHECK is the whole design. Every freshness read, every
// revalidation and the write itself happen with the parent row and the
// `agent_proposals` row already locked, so no writer can slip between the check
// and the write.
//
// Two settings domains, two lock orders. The DOMAIN is read from the stored
// **Version token**'s shape, not from the catalog, so a row whose operation has
// left the catalog still takes its own domain's locks:
//  - voice: `businesses` row FIRST, proposal SECOND (Run B).
//  - policy: `accounts` row FIRST (`lockAutonomyAccount` — the same parent
//    row the shared settings writer locks), proposal SECOND (Run C, spec §6.4
//    step 1). No business, review or response row lock follows the account.
//
// Invariant #15: `sql`/`tx` arrive as parameters; this module never imports
// @/lib/db/server. Invariant #9: every statement carries an `account_id`
// predicate. Invariant #3: the only things that change are a location's voice
// columns through the voice writer, or auto-approval dials through the shared
// settings writer, which repeats every gate. Restore can recreate all three
// policy dials atomically after a deletion. No LLM, no `api_costs`.
import type postgres from 'postgres';
import { isSubscriptionTier } from '@/lib/accounts/tier-config';
import { lockAutonomyAccount } from '@/lib/auto-approval/account-lock';
import {
  AutoApprovalSettingsError,
  getAutoApprovalSettings,
  patchAutoApprovalSettingsInTransaction,
} from '@/lib/auto-approval/settings';
import {
  AutoApprovalConfirmationRequiredError,
  AutoApprovalExpansionBlockedError,
} from '@/lib/auto-approval/settings-guards';
import type { AutoApprovalReadinessBlockReason } from '@/lib/auto-approval/types';
import { readVoiceConfig, updateVoiceConfig, type VoiceConfig } from '@/lib/responses/voice-settings';
import { assertWritableSubscriptionForAccount } from '@/lib/shared/writable-subscription';
import {
  proposableOperation,
  previewPolicyRestore,
  type PolicyProposableOperation,
  type VoiceProposableOperation,
  type PolicyTarget,
  type PolicyRestoreWriterPatch,
} from './catalog';
import {
  readPolicySnapshot,
  readRetainedVetoCount,
  type PolicySnapshot,
} from './policy-state';
import {
  composeReadinessBlockReasons,
  lockProposalForAccount,
  markSiblingProposalsStale,
  policyStateWithConsequence,
  policyTargetOf,
  readProposalForAccount,
  resolveProposalRestoreInput,
  type ProposalView,
} from './proposals';
import { hasRestoreInput } from './restore-inputs';
import {
  PROPOSAL_FAILURE_REASON,
  PROPOSAL_STATUS,
  parsePolicyState,
  parseVoiceState,
  type PolicyReceipt,
  type PolicyState,
  type ProposalFailureReason,
  type ProposalStatus,
  type Receipt,
  type VoiceReceipt,
  type VoiceState,
} from './schema';
import {
  computeVoiceVersionToken,
  versionTokensEqual,
  type VersionToken,
  type VoiceVersionToken,
} from './version-token';

type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;
type BlockReason = AutoApprovalReadinessBlockReason;

export interface ApplyProposalInput {
  proposalId: string;
  accountId: string;
  actorUserId: string;
  /** The token the CARD was rendered from. All three must agree (D9). */
  expectedVersionToken: VersionToken;
  /**
   * The owner's TYPED scope on a policy expansion card. Compared byte for byte
   * with the catalog phrase of the stored `after` — no trim, no case folding.
   * Ignored by voice and by every non-expansion.
   */
  confirmationLevel?: string;
  /** Defensive: the route already refuses an impersonated session before this call. */
  impersonated?: boolean;
}

/**
 * Every non-`not_found` outcome carries the row, so the card re-renders from
 * what the server actually stored rather than from the browser's
 * interpretation of a status code.
 *
 * `confirmation_mismatch` writes NOTHING and leaves the proposal pending.
 * `blocked` commits `rejected` / `expansion_blocked` and returns the reasons.
 */
export type ApplyResult =
  | { kind: 'applied'; proposal: ProposalView; repeated: boolean }
  | { kind: 'stale'; proposal: ProposalView }
  | { kind: 'rejected'; proposal: ProposalView; reason: ProposalFailureReason }
  | { kind: 'confirmation_mismatch'; proposal: ProposalView }
  | { kind: 'blocked'; proposal: ProposalView; blockReasons: BlockReason[] }
  | { kind: 'failed'; proposal: ProposalView }
  | { kind: 'not_pending'; proposal: ProposalView; status: ProposalStatus }
  | { kind: 'not_found' };

export async function applyProposal(sql: Sql, input: ApplyProposalInput): Promise<ApplyResult> {
  // Reject before even the contract-change path can write a terminal status.
  if (input.impersonated === true) {
    throw new AutoApprovalExpansionBlockedError(['impersonation_not_allowed']);
  }
  // ── Before the transaction (spec §6.4) ──────────────────────────────────
  const loaded = await readProposalForAccount(sql, {
    proposalId: input.proposalId,
    accountId: input.accountId,
  });
  if (!loaded) return { kind: 'not_found' };

  const operation = proposableOperation(loaded.operation);
  const contractCurrent = operation !== null && operation.contractVersion === loaded.contractVersion;

  // The **Contract version** check runs before any lock — but it REWRITES the
  // row only while that row is still pending (plan decision P5). A non-pending
  // row falls through to the transaction, whose status branch answers.
  if (!contractCurrent && loaded.status === PROPOSAL_STATUS.PENDING) {
    const outcome = await recordTerminal(sql, {
      proposalId: input.proposalId,
      accountId: input.accountId,
      actorUserId: input.actorUserId,
      status: PROPOSAL_STATUS.REJECTED,
      reason: PROPOSAL_FAILURE_REASON.CONTRACT_CHANGED,
    });
    // `loaded.status` was read WITHOUT a lock; `recordTerminal`'s
    // `status = 'pending'` predicate stops a concurrent Apply's Receipt from
    // being overwritten, and a zero-row result is how this branch learns it
    // lost that race.
    if (!outcome.written) {
      return outcome.proposal.status === PROPOSAL_STATUS.APPLIED
        ? { kind: 'applied', proposal: outcome.proposal, repeated: true }
        : { kind: 'not_pending', proposal: outcome.proposal, status: outcome.proposal.status };
    }
    return {
      kind: 'rejected',
      proposal: outcome.proposal,
      reason: PROPOSAL_FAILURE_REASON.CONTRACT_CHANGED,
    };
  }

  // ── The transaction, in the stored token's own lock order ──────────────
  if (isVoiceVersionToken(loaded.preparedVersionToken)) {
    return sql.begin(async (tx): Promise<ApplyResult> => applyVoiceProposal(tx, input, loaded.locationId));
  }
  return sql.begin(async (tx): Promise<ApplyResult> => applyPolicyProposal(tx, input));
}

function isVoiceVersionToken(token: VersionToken): token is VoiceVersionToken {
  return 'businessId' in token;
}

// ── Voice ─────────────────────────────────────────────────────────────────

async function applyVoiceProposal(
  tx: Tx,
  input: ApplyProposalInput,
  locationId: string | null,
): Promise<ApplyResult> {
  // A voice **Proposal** always names a location, so a NULL one is a row no
  // writer produces (P8). There is nothing to lock, so this is answered first.
  if (locationId === null) {
    return rejected(tx, input, PROPOSAL_FAILURE_REASON.LOCATION_NOT_FOUND);
  }

  // 1a. The `businesses` row, FIRST and account-scoped and active-only. Its
  //     `updated_at::text` IS the current voice **Version token** (D9).
  const [locked] = await tx<{ updated_at: string }[]>`
    SELECT updated_at::text AS updated_at
    FROM businesses
    WHERE id = ${locationId}::uuid
      AND account_id = ${input.accountId}::uuid
      AND archived_at IS NULL
    FOR UPDATE
  `;
  // 1b. The proposal row, SECOND — and SECOND EVEN WHEN 1a FOUND NOTHING, so a
  //     repeat Apply on an ALREADY-APPLIED row after an archive still returns
  //     its Receipt (RB-10).
  const proposal = await lockProposalForAccount(tx, {
    proposalId: input.proposalId,
    accountId: input.accountId,
  });
  if (!proposal) return { kind: 'not_found' };

  if (!locked) return locationMissingResult(tx, input, proposal);

  // 2. Ownership and state. A repeat Apply on an `applied` proposal returns
  //    the STORED Receipt and executes nothing (spec §6.4 step 2).
  const settled = settledResult(proposal);
  if (settled !== null) return settled;
  // The row is pending and its contract was current before the transaction,
  // so this is the NARROWING that lets step 5 reach the voice writer without a
  // non-null assertion. A refusal is the right answer if the impossible happens.
  const contract = currentVoiceContract(proposal);
  if (contract === null) {
    return rejected(tx, input, PROPOSAL_FAILURE_REASON.CONTRACT_CHANGED);
  }
  const { operation, prepared } = contract;

  // 3. Revalidate WITH THE LOCKS HELD.
  const revalidated = await revalidateActor(tx, input);
  if (!revalidated.ok) return rejected(tx, input, revalidated.reason);

  // 3b. The three tokens, TEXT TO TEXT (D9).
  const current = computeVoiceVersionToken({ businessId: locationId, updatedAt: locked.updated_at });
  if (!versionTokensAgree(current, prepared, input.expectedVersionToken)) {
    return markStale(tx, input);
  }

  // 4. No confirmation: no voice operation widens autonomy.

  // 5. Execute, through the operation's own fields only (D10).
  const write = await writeVoice(tx, input, locationId, proposal, operation);
  if (!write.ok) return write.result;

  return recordVoiceApplied(tx, input, locationId, proposal, {
    actorName: revalidated.actorName,
    prepared,
    updatedAt: write.updatedAt,
  });
}

/** Narrow the operation and stored token together before actor revalidation. */
function currentVoiceContract(proposal: ProposalView): {
  operation: VoiceProposableOperation;
  prepared: VoiceVersionToken;
} | null {
  const operation = proposableOperation(proposal.operation);
  const prepared = proposal.preparedVersionToken;
  if (
    operation === null
    || operation.domain !== 'voice'
    || operation.contractVersion !== proposal.contractVersion
    || !isVoiceVersionToken(prepared)
  ) return null;
  return { operation, prepared };
}

/** Resolve the stored fields and run the voice writer; throws still roll back Apply. */
async function writeVoice(
  tx: Tx,
  input: ApplyProposalInput,
  locationId: string,
  proposal: ProposalView,
  operation: VoiceProposableOperation,
): Promise<{ ok: true; updatedAt: string } | { ok: false; result: ApplyResult }> {
  const fields = await resolveVoiceWriterFields(tx, input.accountId, proposal, operation);
  if (fields === null) {
    return { ok: false, result: await rejected(tx, input, PROPOSAL_FAILURE_REASON.CONTRACT_CHANGED) };
  }
  const write = await updateVoiceConfig(tx, { accountId: input.accountId, locationId, fields });
  if (!write.ok) return { ok: false, result: await writeRefusedResult(tx, input, write.reason) };
  return { ok: true, updatedAt: write.updatedAt };
}

/** Resolve the stored operation or Restore input only after actor and token checks. */
async function resolveVoiceWriterFields(
  tx: Tx,
  accountId: string,
  proposal: ProposalView,
  operation: VoiceProposableOperation,
): Promise<Partial<VoiceConfig> | null> {
  if (hasRestoreInput(proposal.input)) {
    const inverse = await resolveProposalRestoreInput(tx, accountId, proposal);
    return inverse?.domain === 'voice' ? inverse.fields : null;
  }
  const parsedInput = operation.parseInput(proposal.input);
  return parsedInput.ok ? operation.writerFields(parsedInput.input) : null;
}

/** Read back, build the Receipt and invalidate siblings on the writer's transaction. */
async function recordVoiceApplied(
  tx: Tx,
  input: ApplyProposalInput,
  locationId: string,
  proposal: ProposalView,
  facts: { actorName: string | null; prepared: VoiceVersionToken; updatedAt: string },
): Promise<ApplyResult> {
  // 6. The Receipt. Read the committed-to-be state back from the locked row.
  const committed = await readVoiceConfig(tx, { accountId: input.accountId, locationId });
  if (!committed) {
    throw new Error('agents/operator: voice row vanished inside the Apply transaction');
  }

  const ownerText = await readOwnerText(tx, input, proposal.turnId);
  // ONE clock for both the column and the Receipt field (P3).
  const appliedAt = new Date().toISOString();
  const receipt = buildVoiceReceipt({
    input,
    locationId,
    proposal,
    committed,
    actorName: facts.actorName,
    ownerText,
    prepared: facts.prepared,
    updatedAt: facts.updatedAt,
    appliedAt,
  });

  const applied = await recordApplied(tx, input, receipt, appliedAt);
  // Spec §8.3, in the SAME transaction (D11): voice tokens on this business only.
  await markSiblingProposalsStale(tx, {
    accountId: input.accountId,
    domain: 'voice',
    locationId,
    excludeProposalId: input.proposalId,
  });
  return { kind: 'applied', proposal: applied, repeated: false };
}

// ── Policy ────────────────────────────────────────────────────────────────

/** Everything the refusal gates, the writer and the Receipt read, built once under the locks. */
interface PolicyPlan {
  proposal: ProposalView;
  operation: PolicyProposableOperation;
  target: PolicyTarget;
  /** The locked pre-write read: values, token and the review cohort both consequence lines use. */
  prewrite: PolicySnapshot;
  patch: PolicyRestoreWriterPatch;
  /** Server-classified from the CURRENT locked state, never the stored flag or the model. */
  expansion: boolean;
  /** The stored `after` the card showed, stripped to its dials. */
  storedAfter: PolicyState;
}

async function applyPolicyProposal(tx: Tx, input: ApplyProposalInput): Promise<ApplyResult> {
  // 1. The account row FIRST. `lockAutonomyAccount` locks the same guaranteed
  //    parent row as the shared writer's private `lockAccount`
  //    (settings.ts:392-406), which then re-acquires it in this transaction.
  await lockAutonomyAccount(tx, input.accountId);
  // 2. The proposal row SECOND.
  const proposal = await lockProposalForAccount(tx, {
    proposalId: input.proposalId,
    accountId: input.accountId,
  });
  if (!proposal) return { kind: 'not_found' };

  // 3. A settled row answers from its stored status BEFORE the actor, archive
  //    and policy reads, so a repeat Apply keeps its Receipt after an archive.
  const settled = settledResult(proposal);
  if (settled !== null) return settled;

  const operation = currentPolicyOperation(proposal);
  if (operation === null) {
    return rejected(tx, input, PROPOSAL_FAILURE_REASON.CONTRACT_CHANGED);
  }

  // 4. Revalidate the actor with both locks held.
  const revalidated = await revalidateActor(tx, input);
  if (!revalidated.ok) return rejected(tx, input, revalidated.reason);

  // 5. The policy state, read with the account lock held. A missing or foreign
  //    location is its own answer, distinct from an archived one.
  const prewrite = await readPolicySnapshot(tx, {
    accountId: input.accountId,
    locationId: proposal.locationId,
  });
  if (prewrite === null) return rejected(tx, input, PROPOSAL_FAILURE_REASON.LOCATION_NOT_FOUND);

  // 6. Three tokens: expected = prepared = current. A miss commits `stale` and
  //    writes no policy row and no audit row.
  if (!versionTokensAgree(prewrite.versionToken, proposal.preparedVersionToken, input.expectedVersionToken)) {
    return markStale(tx, input);
  }

  // 7. Re-parse the stored input and preview on the SERVER from the locked state.
  const plan = await preparePolicyPlan(tx, input.accountId, proposal, operation, prewrite);
  if (plan === null) return rejected(tx, input, PROPOSAL_FAILURE_REASON.CONTRACT_CHANGED);

  return executePolicyPlan(tx, input, plan, revalidated.actorName);
}

function currentPolicyOperation(proposal: ProposalView): PolicyProposableOperation | null {
  const operation = proposableOperation(proposal.operation);
  if (
    operation === null
    || operation.domain !== 'policy'
    || operation.contractVersion !== proposal.contractVersion
    || (operation.scopeRule === 'location' && proposal.locationId === null)
  ) return null;
  return operation;
}

/** Preserve archive, readiness and typed-scope refusals before the writer and Receipt. */
async function executePolicyPlan(
  tx: Tx,
  input: ApplyProposalInput,
  plan: PolicyPlan,
  actorName: string | null,
): Promise<ApplyResult> {
  const refused = await refusePolicyApply(tx, input, plan);
  if (refused !== null) return refused;

  const write = await writePolicy(tx, input, plan);
  if (!write.ok) return write.result;

  return recordPolicyApplied(tx, input, plan, {
    actorName,
    remainingBlocked: write.remainingBlocked,
  });
}

/** Build the writer patch and preview from the state whose token already matched. */
async function preparePolicyPlan(
  tx: Tx,
  accountId: string,
  proposal: ProposalView,
  operation: PolicyProposableOperation,
  prewrite: PolicySnapshot,
): Promise<PolicyPlan | null> {
  const target = policyTargetOf(proposal.locationId);
  let patch: PolicyRestoreWriterPatch;
  let preview;
  if (hasRestoreInput(proposal.input)) {
    const inverse = await resolveProposalRestoreInput(tx, accountId, proposal);
    if (inverse?.domain !== 'policy') return null;
    patch = inverse.patch;
    preview = previewPolicyRestore(prewrite.state, target, patch);
  } else {
    const parsed = operation.parseInput(proposal.input);
    if (!parsed.ok) return null;
    patch = operation.writerPatch(parsed.input, target);
    preview = operation.preview(prewrite.state, target, parsed.input);
  }
  return {
    proposal,
    operation,
    target,
    prewrite,
    patch,
    expansion: operation.exposure(preview, target) === 'expansion',
    storedAfter: parsePolicyState(proposal.after, 'agent_proposals.after'),
  };
}

/**
 * The pre-write refusals, in order: archived target, readiness, typed scope.
 * `null` means carry on to the writer.
 *
 * ARCHIVED is the shared writer's own rule, exactly
 * (settings.ts `assertArchivedPolicyAllowed`): `set_location_override` and
 * any expansion are refused on an archived location. Other contractions and
 * manual changes still apply, including a dial that creates a manual row.
 *
 * READINESS and the TYPED SCOPE gate expansions only. A contraction reads
 * neither, so an owner who is blocked from widening can always narrow.
 */
async function refusePolicyApply(
  tx: Tx,
  input: ApplyProposalInput,
  plan: PolicyPlan,
): Promise<ApplyResult | null> {
  if (plan.prewrite.targetArchived && (plan.patch.operation === 'set_location_override' || plan.expansion)) {
    return rejected(tx, input, PROPOSAL_FAILURE_REASON.LOCATION_INACTIVE);
  }
  if (!plan.expansion) return null;

  const blockReasons = await currentBlockReasons(tx, input.accountId, plan.prewrite);
  if (blockReasons.length > 0) return blocked(tx, input, blockReasons);

  // The phrase of the STORED `after` — the words the card asked the owner to
  // type — compared with `!==`. No trim and no case folding: a near match is
  // a mismatch.
  const phrase = plan.operation.confirmationPhrase(plan.storedAfter, plan.target);
  if (input.confirmationLevel !== phrase) {
    return { kind: 'confirmation_mismatch', proposal: plan.proposal };
  }
  return null;
}

async function currentBlockReasons(
  tx: Tx,
  accountId: string,
  snapshot: PolicySnapshot,
): Promise<BlockReason[]> {
  const settings = await getAutoApprovalSettings(tx, { accountId, impersonated: false });
  return composeReadinessBlockReasons(settings.readiness.blockReasons, snapshot.policySuspended);
}

/**
 * ONE shared-writer operation. After an exact typed match the writer gets
 * `standard`, the only level its form contract requires; a contraction sends
 * no level. The writer repeats every gate on this same transaction.
 */
async function writePolicy(
  tx: Tx,
  input: ApplyProposalInput,
  plan: PolicyPlan,
): Promise<{ ok: true; remainingBlocked: BlockReason[] } | { ok: false; result: ApplyResult }> {
  try {
    const settings = await patchAutoApprovalSettingsInTransaction(tx, {
      ...plan.patch,
      ...(plan.expansion ? { confirmationLevel: 'standard' as const } : {}),
      accountId: input.accountId,
      actorUserId: input.actorUserId,
      impersonated: false,
    });
    return { ok: true, remainingBlocked: settings.readiness.blockReasons };
  } catch (error) {
    const refused = await writerRefusalResult(tx, input, plan.proposal, error);
    if (refused === null) throw error;
    return { ok: false, result: refused };
  }
}

/**
 * The shared writer's DOMAIN refusals, each thrown before its first mutation:
 * the account lock (`account_not_found`), the offboarding gate, the target
 * read (`location_not_found`), then the archived, confirmation and readiness
 * gates — all ahead of `applyMutation` (settings.ts:229-261, :278-340). The
 * transaction is therefore still clean and the refusal can commit.
 *
 * ANYTHING ELSE rethrows and rolls back: SQL and transient errors, and the
 * post-write reload's 500 codes (`invalid_policy_threshold`,
 * `invalid_policy_veto_window`), which must never be swallowed after a mutation.
 */
const WRITER_REFUSAL_REASONS = new Map<string, ProposalFailureReason>([
  ['account_offboarding_blocked', PROPOSAL_FAILURE_REASON.ACCOUNT_OFFBOARDING],
  ['account_not_found', PROPOSAL_FAILURE_REASON.UNAUTHORIZED],
  ['location_not_found', PROPOSAL_FAILURE_REASON.LOCATION_NOT_FOUND],
  ['location_inactive', PROPOSAL_FAILURE_REASON.LOCATION_INACTIVE],
]);

async function writerRefusalResult(
  tx: Tx,
  input: ApplyProposalInput,
  proposal: ProposalView,
  error: unknown,
): Promise<ApplyResult | null> {
  if (error instanceof AutoApprovalExpansionBlockedError) return blocked(tx, input, error.blockReasons);
  // The writer classified an expansion this module did not: the owner never
  // confirmed it, so nothing is written and the card stays pending.
  if (error instanceof AutoApprovalConfirmationRequiredError) {
    return { kind: 'confirmation_mismatch', proposal };
  }
  const reason = error instanceof AutoApprovalSettingsError
    ? WRITER_REFUSAL_REASONS.get(error.code)
    : undefined;
  return reason === undefined ? null : rejected(tx, input, reason);
}

/**
 * The Receipt, from values read under the account lock. The ACTUAL post-write
 * state comes from a fresh snapshot read — never the local preview, and never
 * the settings response, which lists active locations only. Both consequence
 * lines walk the PRE-WRITE cohort, so the old and new counts describe the same
 * reviews.
 */
async function recordPolicyApplied(
  tx: Tx,
  input: ApplyProposalInput,
  plan: PolicyPlan,
  facts: { actorName: string | null; remainingBlocked: readonly BlockReason[] },
): Promise<ApplyResult> {
  const { proposal, prewrite, target } = plan;
  const committed = await readPolicySnapshot(tx, {
    accountId: input.accountId,
    locationId: proposal.locationId,
  });
  if (committed === null) {
    throw new Error('agents/operator: the policy target vanished inside the Apply transaction');
  }
  const retained = await readRetainedVetoCount(tx, {
    accountId: input.accountId,
    locationId: proposal.locationId,
  });
  const ownerText = await readOwnerText(tx, input, proposal.turnId);
  const appliedAt = new Date().toISOString();

  const before = targetPolicyState(prewrite, target);
  const after = targetPolicyState(committed, target);
  const receipt: PolicyReceipt = {
    version: 1,
    operation: proposal.operation,
    scope: { accountId: input.accountId, locationId: proposal.locationId },
    before: policyStateWithConsequence(prewrite, before),
    after: policyStateWithConsequence(prewrite, after),
    differsFromPreview: !policyDialsEqual(after, plan.storedAfter),
    effectiveNow: true,
    affects: 'future_eligible_reviews',
    remainingBlocked: composeReadinessBlockReasons(facts.remainingBlocked, committed.policySuspended),
    appliedAt,
    actorUserId: input.actorUserId,
    actorName: facts.actorName,
    ownerText,
    turnId: proposal.turnId,
    versionToken: { before: prewrite.versionToken, after: committed.versionToken },
    retainedVeto: { count: retained.count, asOf: retained.asOf },
  };

  const applied = await recordApplied(tx, input, receipt, appliedAt);
  // Spec §8.3: only the policy tokens this write moved. Voice proposals keep
  // their locks and their status.
  await markSiblingProposalsStale(tx, {
    accountId: input.accountId,
    domain: 'policy',
    locationId: proposal.locationId,
    excludeProposalId: input.proposalId,
  });
  return { kind: 'applied', proposal: applied, repeated: false };
}

function targetPolicyState(snapshot: PolicySnapshot, target: PolicyTarget): PolicyState {
  if (target.scope === 'account') return snapshot.state.accountDefault;
  if (snapshot.state.location === null) {
    throw new Error('agents/operator: a location policy snapshot carries no location state');
  }
  return snapshot.state.location;
}

/**
 * The Receipt's difference flag: the dials and row existence only.
 * `effectiveDailyCap` is derived from `dailyAutoPostCap`, and the consequence
 * lines move with the clock and the cohort — neither is a difference in what
 * was written.
 */
function policyDialsEqual(a: PolicyState, b: PolicyState): boolean {
  return a.threshold === b.threshold
    && a.vetoWindowMinutes === b.vetoWindowMinutes
    && a.dailyAutoPostCap === b.dailyAutoPostCap
    && a.rowExists === b.rowExists;
}

// ── Shared steps ──────────────────────────────────────────────────────────

/**
 * A proposal that is NO LONGER PENDING answers from its own stored status, and
 * `null` means "still pending, carry on". A repeat Apply on an `applied` row
 * returns the STORED Receipt and executes nothing (spec §6.4 step 2).
 */
function settledResult(proposal: ProposalView): ApplyResult | null {
  if (proposal.status === PROPOSAL_STATUS.APPLIED) {
    return { kind: 'applied', proposal, repeated: true };
  }
  if (proposal.status !== PROPOSAL_STATUS.PENDING) {
    return { kind: 'not_pending', proposal, status: proposal.status };
  }
  return null;
}

/**
 * The voice `businesses` row is gone (archived, or never this account's) and
 * the proposal row is locked. The STATUS answers first; the location refusal is
 * reserved for a Proposal that is still `pending`.
 */
async function locationMissingResult(
  tx: Tx,
  input: ApplyProposalInput,
  proposal: ProposalView,
): Promise<ApplyResult> {
  const settled = settledResult(proposal);
  if (settled !== null) return settled;
  return rejected(tx, input, PROPOSAL_FAILURE_REASON.LOCATION_NOT_FOUND);
}

/**
 * The voice writer REFUSED (as opposed to throwing, which rolls the whole
 * transaction back — D12).
 */
async function writeRefusedResult(
  tx: Tx,
  input: ApplyProposalInput,
  reason: 'location_not_found' | 'no_fields',
): Promise<ApplyResult> {
  if (reason === 'location_not_found') {
    return rejected(tx, input, PROPOSAL_FAILURE_REASON.LOCATION_NOT_FOUND);
  }
  const failed = await recordTerminal(tx, {
    proposalId: input.proposalId,
    accountId: input.accountId,
    actorUserId: input.actorUserId,
    status: PROPOSAL_STATUS.FAILED,
    reason: PROPOSAL_FAILURE_REASON.WRITE_FAILED,
  });
  return { kind: 'failed', proposal: failed.proposal };
}

/**
 * THE THREE TOKENS, TEXT TO TEXT (D9). `current` comes from the rows being
 * held, `prepared` from the proposal, `expected` from the client. All three
 * must agree; scopes never cross (`versionTokensEqual`).
 */
function versionTokensAgree(
  current: VersionToken,
  prepared: VersionToken,
  expected: VersionToken,
): boolean {
  return versionTokensEqual(current, prepared) && versionTokensEqual(prepared, expected);
}

/** A token miss COMMITS `stale`; the mutation never happened. */
async function markStale(tx: Tx, input: ApplyProposalInput): Promise<ApplyResult> {
  const { proposal } = await recordTerminal(tx, {
    proposalId: input.proposalId,
    accountId: input.accountId,
    actorUserId: input.actorUserId,
    status: PROPOSAL_STATUS.STALE,
    reason: PROPOSAL_FAILURE_REASON.VERSION_MISMATCH,
  });
  return { kind: 'stale', proposal };
}

/**
 * Revalidate the actor WITH THE LOCKS HELD: owner role, writable subscription
 * (offboarding included), and a known tier. Answers with the actor's DISPLAY
 * NAME, read on the same `users` row, for the Receipt.
 */
async function revalidateActor(
  tx: Tx,
  input: ApplyProposalInput,
): Promise<
  | { ok: true; actorName: string | null }
  | { ok: false; reason: ProposalFailureReason }
> {
  const [actor] = await tx<{ id: string; name: string | null; email: string | null }[]>`
    SELECT id, name, email
    FROM users
    WHERE id = ${input.actorUserId}::uuid
      AND account_id = ${input.accountId}::uuid
      AND role = 'owner'
  `;
  if (!actor) return { ok: false, reason: PROPOSAL_FAILURE_REASON.UNAUTHORIZED };

  const writable = await assertWritableSubscriptionForAccount(input.accountId, tx);
  if (!writable.ok) {
    return {
      ok: false,
      reason: writable.error === 'account_offboarding_blocked'
        ? PROPOSAL_FAILURE_REASON.ACCOUNT_OFFBOARDING
        : PROPOSAL_FAILURE_REASON.UNAUTHORIZED,
    };
  }

  const [account] = await tx<{ subscription_tier: string }[]>`
    SELECT subscription_tier
    FROM accounts
    WHERE id = ${input.accountId}::uuid
  `;
  if (!account || !isSubscriptionTier(account.subscription_tier)) {
    return { ok: false, reason: PROPOSAL_FAILURE_REASON.UNAUTHORIZED };
  }

  return { ok: true, actorName: actor.name ?? actor.email ?? null };
}

/** The VERBATIM owner text of the preparing turn, account-scoped. */
async function readOwnerText(tx: Tx, input: ApplyProposalInput, turnId: string): Promise<string> {
  const [turn] = await tx<{ owner_text: string }[]>`
    SELECT owner_text
    FROM agent_turns
    WHERE id = ${turnId}::uuid
      AND account_id = ${input.accountId}::uuid
  `;
  // A missing turn row cannot happen (the FK is NOT NULL); an empty string is
  // safer than a throw that rolls back a committed-to-be write over a
  // cosmetic field.
  return turn?.owner_text ?? '';
}

/**
 * The applied transition, the Receipt, the actor and ONE `appliedAt` in one
 * statement, then the re-read through the one mapper.
 */
async function recordApplied(
  tx: Tx,
  input: ApplyProposalInput,
  receipt: Receipt,
  appliedAt: string,
): Promise<ProposalView> {
  await tx`
    UPDATE agent_proposals
    SET status = ${PROPOSAL_STATUS.APPLIED},
        receipt = ${tx.json(receipt as never)},
        applied_at = ${appliedAt}::timestamptz,
        decided_by_user_id = ${input.actorUserId}::uuid,
        failure_reason = NULL,
        updated_at = NOW()
    WHERE id = ${input.proposalId}::uuid
      AND account_id = ${input.accountId}::uuid
  `;
  const applied = await readProposalForAccount(tx, {
    proposalId: input.proposalId,
    accountId: input.accountId,
  });
  if (!applied) {
    throw new Error('agents/operator: applied proposal vanished inside its own transaction');
  }
  return applied;
}

/** The voice **Receipt**, pure: every field is a parameter or derived from one. */
function buildVoiceReceipt({
  input,
  locationId,
  proposal,
  committed,
  actorName,
  ownerText,
  prepared,
  updatedAt,
  appliedAt,
}: {
  input: ApplyProposalInput;
  locationId: string;
  proposal: ProposalView;
  committed: VoiceConfig;
  actorName: string | null;
  ownerText: string;
  prepared: VoiceVersionToken;
  /** `businesses.updated_at` AFTER the write — the Receipt's `after` token. */
  updatedAt: string;
  appliedAt: string;
}): VoiceReceipt {
  const afterActual = toVoiceState(committed);
  const afterPreviewed = parseVoiceState(proposal.after, 'agent_proposals.after');
  return {
    version: 1,
    operation: proposal.operation,
    scope: { accountId: input.accountId, locationId },
    // The state the card SHOWED when the owner clicked (P6).
    before: parseVoiceState(proposal.before, 'agent_proposals.before'),
    after: afterActual,
    differsFromPreview: !voiceStatesEqual(afterActual, afterPreviewed),
    effectiveNow: true,
    affects: 'future_drafts',
    remainingBlocked: [],
    appliedAt,
    actorUserId: input.actorUserId,
    actorName,
    ownerText,
    turnId: proposal.turnId,
    versionToken: {
      before: prepared,
      after: computeVoiceVersionToken({ businessId: locationId, updatedAt }),
    },
  };
}

/**
 * One terminal transition plus the re-read that gives the caller the row.
 * `AND status = 'pending'` IS LOAD-BEARING on the pre-transaction path: it
 * stops a stale unlocked read from stamping over an `applied` Receipt.
 * `written` reports whether the UPDATE matched.
 */
async function recordTerminal(
  db: Sql | Tx,
  input: {
    proposalId: string;
    accountId: string;
    actorUserId: string;
    status: ProposalStatus;
    reason: ProposalFailureReason;
    blockReasons?: readonly BlockReason[];
  },
): Promise<{ written: boolean; proposal: ProposalView }> {
  const result = await db`
    UPDATE agent_proposals
    SET status = ${input.status},
        failure_reason = ${input.reason},
        after = CASE WHEN ${input.blockReasons !== undefined}
          THEN jsonb_set(after, '{expansionBlockedBy}', ${db.json([...(input.blockReasons ?? [])])}::jsonb)
          ELSE after END,
        decided_by_user_id = ${input.actorUserId}::uuid,
        updated_at = NOW()
    WHERE id = ${input.proposalId}::uuid
      AND account_id = ${input.accountId}::uuid
      AND status = ${PROPOSAL_STATUS.PENDING}
  `;
  const row = await readProposalForAccount(db, {
    proposalId: input.proposalId,
    accountId: input.accountId,
  });
  if (!row) throw new Error('agents/operator: proposal vanished while recording its outcome');
  return { written: result.count > 0, proposal: row };
}

async function rejected(
  tx: Tx,
  input: ApplyProposalInput,
  reason: ProposalFailureReason,
): Promise<ApplyResult> {
  const { proposal } = await recordTerminal(tx, {
    proposalId: input.proposalId,
    accountId: input.accountId,
    actorUserId: input.actorUserId,
    status: PROPOSAL_STATUS.REJECTED,
    reason,
  });
  return { kind: 'rejected', proposal, reason };
}

/** Readiness refused an expansion: commit the refusal and return the reasons. */
async function blocked(
  tx: Tx,
  input: ApplyProposalInput,
  blockReasons: readonly BlockReason[],
): Promise<ApplyResult> {
  const { proposal } = await recordTerminal(tx, {
    proposalId: input.proposalId,
    accountId: input.accountId,
    actorUserId: input.actorUserId,
    status: PROPOSAL_STATUS.REJECTED,
    reason: PROPOSAL_FAILURE_REASON.EXPANSION_BLOCKED,
    blockReasons,
  });
  return { kind: 'blocked', proposal, blockReasons: [...blockReasons] };
}

function toVoiceState(voice: VoiceConfig): VoiceState {
  return {
    tone: voice.tone,
    productsServices: voice.productsServices,
    avoidFacts: voice.avoidFacts,
    highlightFacts: voice.highlightFacts,
    sampleResponses: voice.sampleResponses,
  };
}

function voiceStatesEqual(a: VoiceState, b: VoiceState): boolean {
  return a.tone === b.tone
    && a.productsServices === b.productsServices
    && sameStrings(a.avoidFacts, b.avoidFacts)
    && sameStrings(a.highlightFacts, b.highlightFacts)
    && sameStrings(a.sampleResponses, b.sampleResponses);
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
