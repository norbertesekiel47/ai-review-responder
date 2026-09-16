// Restore prepares a normal proposal. Only Apply may change owner settings.
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { isSubscriptionTier } from '@/lib/accounts/tier-config';
import { getAutoApprovalSettings } from '@/lib/auto-approval/settings';
import { readVoiceConfig } from '@/lib/responses/voice-settings';
import { assertWritableSubscriptionForAccount } from '@/lib/shared/writable-subscription';
import { previewPolicyRestore, proposableOperation, type PolicyProposableOperation, type ProposableOperation } from './catalog';
import { readPolicySnapshot } from './policy-state';
import {
  composeReadinessBlockReasons, insertProposals, lockRestoreSourceForAccount,
  policyStateWithConsequence, policyTargetOf, readProposalForAccount,
  type ProposalRow, type ProposalView,
} from './proposals';
import { deriveRestoreInput, type DerivedRestoreInput, type RestoreSource } from './restore-inputs';
import { PROPOSAL_FAILURE_REASON, PROPOSAL_STATUS } from './schema';
import { computeVoiceVersionToken, versionTokensEqual } from './version-token';

type Tx = postgres.TransactionSql;
interface RestoreActor { accountId: string; actorUserId: string }
interface RestoreOwner { conversationId: string; turnId: string }
type RestorePreparation = RestoreActor & { locationId: string | null; sourceProposalId?: string; owner?: RestoreOwner };

export type RestoreResult =
  | { kind: 'prepared'; proposal: ProposalView; repeated: boolean }
  | { kind: 'not_found' | 'not_applied' | 'invalid_source' | 'unauthorized' | 'location_not_found' | 'no_history' };

/** Button requests derive their target from the stored source, never the selector. */
export async function createRestoreProposal(
  db: postgres.Sql,
  input: RestoreActor & { sourceProposalId: string; impersonated?: boolean },
): Promise<RestoreResult> {
  if (input.impersonated) return { kind: 'unauthorized' };
  const [source] = await db<{ location_id: string | null }[]>`
    SELECT location_id FROM agent_proposals
    WHERE id = ${input.sourceProposalId}::uuid AND account_id = ${input.accountId}::uuid
  `;
  if (!source) return { kind: 'not_found' };
  return db.begin((tx) => createRestoreProposalInTransaction(tx, { ...input, locationId: source.location_id }));
}

/**
 * Preparation-only locks: lifecycle orders business before account. NO KEY
 * UPDATE serializes with Apply while admitting createTurn's FK KEY SHARE.
 * Never upgrade these parents through an Apply/settings lock helper.
 */
async function lockRestoreScope(tx: Tx, input: RestoreActor & { locationId: string | null }): Promise<boolean> {
  if (input.locationId !== null) {
    const [location] = await tx<{ id: string }[]>`
      SELECT id FROM businesses
      WHERE id = ${input.locationId}::uuid AND account_id = ${input.accountId}::uuid
        AND archived_at IS NULL
      FOR NO KEY UPDATE
    `;
    if (!location) return false;
  }
  const [account] = await tx<{ id: string }[]>`
    SELECT id FROM accounts WHERE id = ${input.accountId}::uuid FOR NO KEY UPDATE
  `;
  return account !== undefined;
}

async function restoreActorWritable(tx: Tx, input: RestoreActor): Promise<boolean> {
  const [actor] = await tx<{ subscription_tier: string }[]>`
    SELECT a.subscription_tier FROM users u JOIN accounts a ON a.id = u.account_id
    WHERE u.id = ${input.actorUserId}::uuid AND u.account_id = ${input.accountId}::uuid
      AND a.id = ${input.accountId}::uuid
      AND u.role = 'owner'
  `;
  return actor !== undefined && isSubscriptionTier(actor.subscription_tier)
    && (await assertWritableSubscriptionForAccount(input.accountId, tx)).ok;
}

type PreparedFields = Pick<ProposalRow, 'before' | 'after' | 'preparedVersionToken' | 'requiresConfirmation'>;

async function prepareRestoreFields(
  tx: Tx, input: RestoreActor & { locationId: string | null },
  source: RestoreSource, inverse: DerivedRestoreInput,
): Promise<PreparedFields | null> {
  const operation = proposableOperation(source.operation);
  if (!operation) return null;
  if (inverse.domain === 'voice' && operation.domain === 'voice' && input.locationId !== null) {
    const voice = await readVoiceConfig(tx, { accountId: input.accountId, locationId: input.locationId });
    if (!voice) return null;
    return {
      before: { ...voice }, after: { ...voice, ...inverse.fields }, requiresConfirmation: false,
      preparedVersionToken: computeVoiceVersionToken({ businessId: input.locationId, updatedAt: voice.updatedAt }),
    };
  }
  if (inverse.domain !== 'policy' || operation.domain !== 'policy') return null;
  return preparePolicyRestoreFields(tx, input, operation, inverse);
}

async function preparePolicyRestoreFields(
  tx: Tx, input: RestoreActor & { locationId: string | null },
  operation: PolicyProposableOperation, inverse: Extract<DerivedRestoreInput, { domain: 'policy' }>,
): Promise<PreparedFields | null> {
  const snapshot = await readPolicySnapshot(tx, { accountId: input.accountId, locationId: input.locationId });
  if (!snapshot || snapshot.targetArchived) return null;
  const target = policyTargetOf(input.locationId);
  const preview = previewPolicyRestore(snapshot.state, target, inverse.patch);
  const expansion = operation.exposure(preview, target) === 'expansion';
  const settings = expansion ? await getAutoApprovalSettings(tx, { accountId: input.accountId, impersonated: false }) : null;
  return {
    before: policyStateWithConsequence(snapshot, preview.before),
    after: {
      ...policyStateWithConsequence(snapshot, preview.after),
      ...(expansion ? { expansionBlockedBy: composeReadinessBlockReasons(settings!.readiness.blockReasons, snapshot.policySuspended) } : {}),
    },
    preparedVersionToken: snapshot.versionToken, requiresConfirmation: expansion,
  };
}

async function selectRestoreSource(tx: Tx, input: RestorePreparation) {
  // No advisory candidate is trusted: latest selection occurs under BOTH
  // settings-domain locks, before source locking and current-state capture.
  const [selected] = await tx<{ id: string; conversation_id: string; turn_id: string }[]>`
    SELECT id, conversation_id, turn_id FROM agent_proposals
    WHERE account_id = ${input.accountId}::uuid
      AND location_id IS NOT DISTINCT FROM ${input.locationId}::uuid
      AND (${input.sourceProposalId !== undefined} OR status = ${PROPOSAL_STATUS.APPLIED})
      AND (${input.sourceProposalId === undefined} OR id = ${input.sourceProposalId ?? '00000000-0000-0000-0000-000000000000'}::uuid)
    ORDER BY applied_at DESC NULLS LAST, id DESC LIMIT 1
  `;
  return selected;
}

async function reusableRestoreProposal(
  tx: Tx, input: RestorePreparation, source: RestoreSource, fields: PreparedFields,
): Promise<ProposalView | null> {
  const pending = await tx<{ id: string }[]>`
    SELECT id FROM agent_proposals WHERE account_id = ${input.accountId}::uuid
      AND status = ${PROPOSAL_STATUS.PENDING}
      AND input->'restore'->>'sourceProposalId' = ${source.id}
    ORDER BY created_at DESC, id DESC FOR UPDATE
  `;
  for (const row of pending) {
    const existing = await readProposalForAccount(tx, { accountId: input.accountId, proposalId: row.id });
    if (existing?.restoreSourceProposalId === source.id && existing.operation === source.operation
      && existing.locationId === input.locationId && existing.contractVersion === source.contractVersion
      && versionTokensEqual(existing.preparedVersionToken, fields.preparedVersionToken)) {
      return existing;
    }
  }
  return null;
}

async function resolveRestoreSource(tx: Tx, input: RestorePreparation): Promise<
  | { kind: 'source'; source: RestoreSource; inverse: DerivedRestoreInput; operation: ProposableOperation; owner: RestoreOwner }
  | Exclude<RestoreResult, { kind: 'prepared' }>
> {
  const selected = await selectRestoreSource(tx, input);
  if (!selected) return { kind: input.sourceProposalId ? 'not_found' : 'no_history' };
  const source = await lockRestoreSourceForAccount(tx, { accountId: input.accountId, proposalId: selected.id });
  if (!source || source.locationId !== input.locationId) return { kind: 'not_found' };
  if (source.status !== PROPOSAL_STATUS.APPLIED) return { kind: 'not_applied' };
  const inverse = deriveRestoreInput({ ...input, operation: source.operation, contractVersion: source.contractVersion, source });
  const operation = proposableOperation(source.operation);
  if (!inverse || !operation) return { kind: 'invalid_source' };
  const owner = input.owner ?? { conversationId: selected.conversation_id, turnId: selected.turn_id };
  return { kind: 'source', source, inverse, operation, owner };
}

/** Same function for the button and model, called only after the worker fence. */
export async function createRestoreProposalInTransaction(
  tx: Tx, input: RestorePreparation,
): Promise<RestoreResult> {
  if (!await lockRestoreScope(tx, input)) return { kind: 'location_not_found' };
  if (!await restoreActorWritable(tx, input)) return { kind: 'unauthorized' };

  const resolved = await resolveRestoreSource(tx, input);
  if (resolved.kind !== 'source') return resolved;
  const { source, inverse, operation, owner } = resolved;
  const [owningTurn] = await tx<{ id: string }[]>`
    SELECT id FROM agent_turns WHERE account_id = ${input.accountId}::uuid
      AND id = ${owner.turnId}::uuid AND conversation_id = ${owner.conversationId}::uuid
  `;
  if (!owningTurn) return { kind: 'unauthorized' };
  const fields = await prepareRestoreFields(tx, input, source, inverse);
  if (!fields) return { kind: 'location_not_found' };

  const existing = await reusableRestoreProposal(tx, input, source, fields);
  if (existing) return { kind: 'prepared', proposal: existing, repeated: true };
  const row: ProposalRow = {
    id: randomUUID(), ...owner, accountId: input.accountId, actorUserId: input.actorUserId,
    locationId: source.locationId,
    operation: source.operation, contractVersion: source.contractVersion,
    labelKind: operation.labelKind, rationale: 'Restore the setting from this applied receipt.',
    input: { restore: { sourceProposalId: source.id } }, ...fields, status: PROPOSAL_STATUS.PENDING,
  };
  await insertProposals(tx, [row]);
  // A fresh current token replaces older preparations, never their history.
  await tx`
    UPDATE agent_proposals SET status = ${PROPOSAL_STATUS.STALE},
      failure_reason = ${PROPOSAL_FAILURE_REASON.VERSION_MISMATCH}, updated_at = NOW()
    WHERE account_id = ${input.accountId}::uuid AND status = ${PROPOSAL_STATUS.PENDING}
      AND id <> ${row.id}::uuid AND input->'restore'->>'sourceProposalId' = ${source.id}
  `;
  const proposal = await readProposalForAccount(tx, { accountId: input.accountId, proposalId: row.id });
  if (!proposal) throw new Error('agents/operator: prepared Restore vanished in its transaction');
  return { kind: 'prepared', proposal, repeated: false };
}
