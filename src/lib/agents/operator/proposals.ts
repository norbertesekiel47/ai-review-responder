// Proposal construction, persistence and supersession. Every statement carries
// account_id.
import type postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import type { AutoApprovalReadinessBlockReason } from '@/lib/auto-approval/types';
import type { VoiceConfig } from '@/lib/responses/voice-settings';
import {
  CATALOG,
  describePolicyRestore,
  proposableOperation,
  type LabelKind,
  type PolicyProposableOperation,
  type PolicyTarget,
  type ProposableOperation,
} from './catalog';
import { consequenceForPolicy, type PolicySnapshot } from './policy-state';
import type { ParsedProposal } from './render';
import { deriveRestoreInput, hasRestoreInput, parseRestoreInput, type DerivedRestoreInput, type RestoreSource } from './restore-inputs';
import {
  PROPOSAL_FAILURE_REASON,
  PROPOSAL_STATUS,
  asProposalStatus,
  parseJsonbObject,
  parsePolicyConsequence,
  parsePolicyState,
  parseReceipt,
  parseStoredPolicyState,
  type PolicyState,
  type PolicyStateWithConsequence,
  type ProposalStatus,
  type Receipt,
  type StoredPolicyConsequence,
} from './schema';
import {
  computeVoiceVersionToken,
  parseVersionToken,
  type VersionToken,
} from './version-token';

type Db = postgres.Sql | postgres.TransactionSql;
type Tx = postgres.TransactionSql;

export interface ProposalRow {
  id: string;
  conversationId: string;
  turnId: string;
  accountId: string;
  actorUserId: string;
  locationId: string | null;
  operation: string;
  contractVersion: number;
  input: Record<string, unknown>;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  rationale: string;
  labelKind: LabelKind;
  /**
   * The **Version token** this row is stamped with, as the TYPE the reader
   * parses back out (`parseVersionToken`): a voice token, or an auto-approval
   * token whose rows came from the same read as the stored states.
   */
  preparedVersionToken: VersionToken;
  /** True only for a policy expansion, classified by the SERVER at preparation. */
  requiresConfirmation: boolean;
  status: ProposalStatus;
  // No `describe` field, deliberately: the INSERT below does not write one, and
  // the card's words are recomputed from the catalog on read so a copy edit
  // ships without rewriting stored rows.
}

/** The turn facts a **Proposal** row is stamped with. */
export interface ProposalTurnContext {
  conversationId: string;
  turnId: string;
  accountId: string;
  actorUserId: string;
  /** The turn's STORED location — the VOICE **Version token**'s scope. */
  locationId: string;
}

/**
 * Everything one policy target needs at preparation, read by the worker: the
 * coherent snapshot (values, token and review cohort from one statement) and
 * the account's shared readiness reasons.
 */
export interface PolicyPreparation {
  snapshot: PolicySnapshot;
  blockReasons: readonly AutoApprovalReadinessBlockReason[];
}

/**
 * Keyed by the proposal's STORED target: its location id, or `null` for the
 * account default. Never the browser's selector — an account proposal made
 * while a location is selected is still keyed `null`.
 */
export type PolicyPreparations = ReadonlyMap<string | null, PolicyPreparation>;

/** A stored scope → the policy row it targets. */
export function policyTargetOf(locationId: string | null): PolicyTarget {
  return locationId === null ? { scope: 'account' } : { scope: 'location', locationId };
}

/**
 * The shared readiness reasons plus the TARGET's own suspension. The settings
 * readiness reads only the account default's suspension, and a suspended
 * location row blocks expansion too (settings.ts `assertExpansionReady` reads
 * the target's effective flag), so both preparation and Apply add it here.
 */
export function composeReadinessBlockReasons(
  shared: readonly AutoApprovalReadinessBlockReason[],
  policySuspended: boolean,
): AutoApprovalReadinessBlockReason[] {
  return policySuspended && !shared.includes('policy_suspended')
    ? [...shared, 'policy_suspended']
    : [...shared];
}

/**
 * One full state with its **Consequence line** over the snapshot's own review
 * cohort. Both halves are VALIDATED on the way out, so a state the strict
 * reader would refuse is never stored — and a reader that returned an extra
 * key fails here, at the writer, rather than on the owner's next read.
 */
export function policyStateWithConsequence(
  snapshot: PolicySnapshot,
  state: PolicyState,
): PolicyStateWithConsequence {
  return {
    ...parsePolicyState(state, 'policy snapshot state'),
    consequence: parsePolicyConsequence(consequenceForPolicy(snapshot, state), 'policy consequence'),
    affectedLocationCount: snapshot.locationId === null
      ? snapshot.locations.filter((location) => !location.state.rowExists).length
      : Number(!snapshot.targetArchived),
  };
}

type PolicyRowFields = Pick<
  ProposalRow,
  'locationId' | 'before' | 'after' | 'preparedVersionToken' | 'requiresConfirmation'
>;

/**
 * A policy proposal's server-stamped half. Everything comes from the prepared
 * snapshot for the proposal's STORED target and from the catalog: the full
 * before/after, a consequence line on each side, the token, and the exposure
 * class. The model supplied only the operation, the target and the input.
 */
function policyRowFields(
  operation: PolicyProposableOperation,
  proposal: ParsedProposal,
  policy: PolicyPreparations | undefined,
): PolicyRowFields {
  const locationId = proposal.scope.locationId ?? null;
  const prepared = policy?.get(locationId);
  if (prepared === undefined) {
    throw new Error('agents/operator: a policy proposal has no prepared policy snapshot for its target');
  }
  const { snapshot } = prepared;
  const target = policyTargetOf(locationId);
  const preview = operation.preview(snapshot.state, target, proposal.input);
  const expansion = operation.exposure(preview, target) === 'expansion';
  return {
    locationId,
    before: policyStateWithConsequence(snapshot, preview.before),
    after: {
      ...policyStateWithConsequence(snapshot, preview.after),
      ...(expansion
        ? { expansionBlockedBy: composeReadinessBlockReasons(prepared.blockReasons, snapshot.policySuspended) }
        : {}),
    },
    preparedVersionToken: snapshot.versionToken,
    requiresConfirmation: expansion,
  };
}

/**
 * Validated proposals → storable rows. `before`/`after` are the FULL effective
 * state of the target, computed server-side from the catalog's own preview,
 * never from anything the model said.
 *
 * `policy` is required only when a policy proposal is present: a voice-only
 * turn reads no policy state. A policy proposal whose target has no prepared
 * snapshot is an invariant failure, not a card to drop.
 *
 * It consumes the validator's `ParsedProposal`s, so the catalog lookup and the
 * input parse happen once on the path.
 */
export function buildProposalRows(
  turn: ProposalTurnContext,
  proposals: readonly ParsedProposal[],
  voice: VoiceConfig & { updatedAt: string },
  policy?: PolicyPreparations,
): ProposalRow[] {
  return proposals.map((proposal): ProposalRow => {
    const { operation } = proposal;
    const common = {
      id: uuidv7(),
      conversationId: turn.conversationId,
      turnId: turn.turnId,
      accountId: turn.accountId,
      actorUserId: turn.actorUserId,
      operation: operation.id,
      contractVersion: operation.contractVersion,
      input: proposal.input,
      rationale: proposal.rationale,
      labelKind: operation.labelKind,
      status: PROPOSAL_STATUS.PENDING,
    };
    if (operation.domain === 'policy') {
      return { ...common, ...policyRowFields(operation, proposal, policy) };
    }
    const { before, after } = operation.preview(voice, proposal.input);
    return {
      ...common,
      locationId: proposal.scope.locationId ?? null,
      before: { ...before },
      after: { ...after },
      // Through the helper, never a literal `{ businessId, updatedAt }`: this is
      // the token Apply compares against, and the module that owns its shape is
      // the one that should build it.
      preparedVersionToken: computeVoiceVersionToken({
        businessId: turn.locationId,
        updatedAt: voice.updatedAt,
      }),
      requiresConfirmation: false,
    };
  });
}

export async function insertProposals(tx: Tx, rows: readonly ProposalRow[]): Promise<void> {
  for (const row of rows) {
    await tx`
      INSERT INTO agent_proposals (
        id, conversation_id, turn_id, account_id, actor_user_id, location_id,
        operation, contract_version, input, before, after, rationale,
        label_kind, prepared_version_token, requires_confirmation, status
      )
      VALUES (
        ${row.id}::uuid,
        ${row.conversationId}::uuid,
        ${row.turnId}::uuid,
        ${row.accountId}::uuid,
        ${row.actorUserId}::uuid,
        ${row.locationId}::uuid,
        ${row.operation},
        ${row.contractVersion},
        ${tx.json(row.input as never)},
        ${tx.json(row.before as never)},
        ${tx.json(row.after as never)},
        ${row.rationale},
        ${row.labelKind},
        ${tx.json(row.preparedVersionToken as never)},
        ${row.requiresConfirmation},
        ${PROPOSAL_STATUS.PENDING}
      )
    `;
  }
}

/**
 * Marks earlier pending proposals in the conversation that name the same
 * (operation, location) as superseded, pointing at the replacement.
 *
 * `location_id IS NOT DISTINCT FROM` rather than `=`: an account-default
 * proposal carries a NULL location, and `NULL = NULL` would match nothing, so
 * a corrected account-default proposal would silently leave its predecessor
 * pending and the owner would see two live cards for one decision.
 *
 * `turn_id <> ${turnId}` rather than `id <> ${replacement.proposalId}`: EARLIER
 * pending proposals is what supersession means, and the whole current turn is
 * one reply. Replacement IDs are also exempt: a Restore may reuse a pending
 * proposal owned by an earlier turn without changing that ownership.
 */
export async function supersedePendingProposals(
  tx: Tx,
  input: {
    conversationId: string;
    accountId: string;
    /** The turn whose proposals are the replacements; all of them are exempt. */
    turnId: string;
    replacements: readonly { proposalId: string; operation: string; locationId: string | null }[];
  },
): Promise<void> {
  for (const replacement of input.replacements) {
    await tx`
      UPDATE agent_proposals
      SET status = ${PROPOSAL_STATUS.SUPERSEDED},
          superseded_by = ${replacement.proposalId}::uuid,
          updated_at = NOW()
      WHERE conversation_id = ${input.conversationId}::uuid
        AND account_id = ${input.accountId}::uuid
        AND status = ${PROPOSAL_STATUS.PENDING}
        AND operation = ${replacement.operation}
        AND location_id IS NOT DISTINCT FROM ${replacement.locationId}::uuid
        AND turn_id <> ${input.turnId}::uuid
        AND NOT (id = ANY(${input.replacements.map((row) => row.proposalId)}::uuid[]))
    `;
  }
}

type StoredRow = {
  turn_id: string;
  id: string; operation: string; contract_version: number; label_kind: LabelKind;
  location_id: string | null; status: string; rationale: string;
  input: unknown; before: unknown; after: unknown;
  prepared_version_token: unknown;
  receipt: unknown;
  applied_at: Date | string | null;
  failure_reason: string | null;
};

/** One **Proposal** as the owner reads it. The named public shape of the card. */
export interface ProposalView {
  id: string;
  /** Server-created provenance; absent on ordinary proposals. */
  restoreSourceProposalId?: string | null;
  /** The turn that prepared it. The Receipt's correlation id, and the card's. */
  turnId: string;
  operation: string;
  contractVersion: number;
  labelKind: LabelKind;
  locationId: string | null;
  status: ProposalStatus;
  rationale: string;
  input: Record<string, unknown>;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  /** The card's words, recomputed from the catalog on read. */
  describe: string;
  /**
   * The card's friction, DERIVED on read from the stored before/after and the
   * input through the catalog's exposure classifier. Never the
   * `requires_confirmation` column and never anything the model or a browser
   * said. False for every voice proposal.
   */
  requiresConfirmation: boolean;
  /** The exact words the owner types on an expansion card, or `null`. */
  confirmationPhrase: string | null;
  /** Readiness reasons recorded at preparation for an expansion; `[]` otherwise. */
  readinessBlockReasons: AutoApprovalReadinessBlockReason[];
  /** The stored `after` consequence line of a policy proposal; `null` for voice. */
  consequence: StoredPolicyConsequence | null;
  /** Active locations affected at preparation; account defaults exclude overrides. */
  affectedLocationCount: number | null;
  /** The **Version token** recorded at preparation. Apply compares against it. */
  preparedVersionToken: VersionToken;
  /** Server-written, `null` until applied. Never supplied by the client. */
  receipt: Receipt | null;
  /** ISO-8601, or `null`. */
  appliedAt: string | null;
  failureReason: string | null;
}

/**
 * The projection every `agent_proposals` read shares — the exact column set
 * `StoredRow` names and `mapStored` consumes.
 *
 * A nested tagged template, composed by postgres.js into the outer query. It
 * carries no value, so there is no bind parameter to reorder. The WHERE
 * clauses stay at each call site, deliberately: the `account_id` predicate is
 * the tenant proof `ci:tenant-scope` reads.
 */
function proposalColumns(db: Db) {
  return db`turn_id, id, operation, contract_version, label_kind, location_id, status, rationale,
            input, before, after, prepared_version_token, receipt, applied_at::text AS applied_at, failure_reason`;
}

type CardFacts = Pick<
  ProposalView,
  'describe' | 'requiresConfirmation' | 'confirmationPhrase' | 'readinessBlockReasons' | 'consequence' | 'affectedLocationCount'
>;

function withoutFriction(describe: string): CardFacts {
  return {
    describe,
    requiresConfirmation: false,
    confirmationPhrase: null,
    readinessBlockReasons: [],
    consequence: null,
    affectedLocationCount: null,
  };
}

/**
 * The card's words and friction for a row whose operation parsed. A policy
 * card is classified from its STORED before/after, pure: the metadata is
 * stripped before the catalog sees either state.
 */
function cardFacts(
  operation: ProposableOperation,
  input: Record<string, unknown>,
  stored: { locationId: string | null; before: Record<string, unknown>; after: Record<string, unknown> },
): CardFacts {
  if (operation.domain === 'voice') return withoutFriction(operation.describe(input));

  const target = policyTargetOf(stored.locationId);
  const storedAfter = parseStoredPolicyState(stored.after, 'agent_proposals.after');
  const preview = {
    before: parsePolicyState(stored.before, 'agent_proposals.before'),
    after: parsePolicyState(storedAfter, 'agent_proposals.after'),
  };
  const expansion = operation.exposure(preview, target) === 'expansion';
  return {
    describe: operation.describeChange(input, preview, target),
    requiresConfirmation: expansion,
    confirmationPhrase: expansion ? operation.confirmationPhrase(preview.after, target) : null,
    readinessBlockReasons: expansion ? [...(storedAfter.expansionBlockedBy ?? [])] : [],
    consequence: storedAfter.consequence ?? null,
    affectedLocationCount: storedAfter.affectedLocationCount ?? null,
  };
}

function mapStored(row: StoredRow, restore: DerivedRestoreInput | null = null): ProposalView {
  const input = parseJsonbObject(row.input, 'agent_proposals.input');
  const before = parseJsonbObject(row.before, 'agent_proposals.before');
  const after = parseJsonbObject(row.after, 'agent_proposals.after');
  const operation = proposableOperation(row.operation);
  const parsed = operation?.parseInput(input);
  // The card's words come from the CATALOG at read time, never from a stored
  // string. A row whose operation left the catalog (or whose stored input no
  // longer parses under a bumped contract) falls back to its rationale with no
  // friction rather than throwing — the card is still readable and Apply is
  // what refuses it.
  let card = operation && parsed?.ok
    ? cardFacts(operation, parsed.input, { locationId: row.location_id, before, after })
    : withoutFriction(row.rationale);
  if (hasRestoreInput(input)) {
    card = withoutFriction('Restore: The source receipt is no longer available.');
    if (operation && restore?.domain === 'voice' && operation.domain === 'voice') {
      const description = operation.id === 'set_tone' && restore.input.tone === null
        ? 'Let RepWorth choose the reply tone.'
        : operation.describe(restore.input);
      card = withoutFriction(`Restore: ${description}`);
    } else if (operation?.domain === 'policy' && restore?.domain === 'policy') {
      const target = policyTargetOf(row.location_id);
      const storedAfter = parseStoredPolicyState(after, 'agent_proposals.after');
      const preview = { before: parsePolicyState(before, 'agent_proposals.before'), after: parsePolicyState(after, 'agent_proposals.after') };
      const expansion = operation.exposure(preview, target) === 'expansion';
      card = {
        describe: describePolicyRestore(preview, target), requiresConfirmation: expansion,
        confirmationPhrase: expansion ? operation.confirmationPhrase(preview.after, target) : null,
        readinessBlockReasons: expansion ? [...(storedAfter.expansionBlockedBy ?? [])] : [],
        consequence: storedAfter.consequence ?? null,
        affectedLocationCount: storedAfter.affectedLocationCount ?? null,
      };
    }
  }
  return {
    id: row.id,
    ...(hasRestoreInput(input) ? { restoreSourceProposalId: parseRestoreInput(input)?.sourceProposalId ?? null } : {}),
    turnId: row.turn_id,
    operation: row.operation,
    contractVersion: row.contract_version,
    labelKind: row.label_kind,
    locationId: row.location_id,
    status: asProposalStatus(row.status),
    rationale: row.rationale,
    input,
    before,
    after,
    ...card,
    preparedVersionToken: parseVersionToken(row.prepared_version_token),
    receipt: parseReceipt(row.receipt),
    // ISO, not the raw driver value: `applied_at` crosses as a JS `Date`. Unlike
    // the **Version token** this value is never COMPARED, so the millisecond
    // truncation is cosmetic here.
    appliedAt: row.applied_at == null ? null : new Date(row.applied_at).toISOString(),
    failureReason: row.failure_reason,
  };
}

/** One bounded source read for a batch; no recursive traversal of undo history. */
async function readRestoreSources(db: Db, accountId: string, ids: readonly string[], lock = false): Promise<Map<string, RestoreSource>> {
  if (ids.length === 0) return new Map();
  const rows = await db<{
    id: string; operation: string; contract_version: number; location_id: string | null;
    status: string; turn_id: string; receipt: unknown;
  }[]>`
    SELECT id, operation, contract_version, location_id, status, turn_id, receipt
    FROM agent_proposals
    WHERE account_id = ${accountId}::uuid AND id = ANY(${[...new Set(ids)]}::uuid[])
    ${lock ? db`FOR UPDATE` : db``}
  `;
  return new Map(rows.map((row) => {
    let receipt: Receipt | null = null;
    try { receipt = parseReceipt(row.receipt); } catch { /* Unusable historical evidence refuses Restore. */ }
    return [row.id, { id: row.id, operation: row.operation, contractVersion: row.contract_version,
      locationId: row.location_id, status: row.status, turnId: row.turn_id, receipt }];
  }));
}

/** Lock the source evidence without requiring a corrupt historical card to render. */
export async function lockRestoreSourceForAccount(
  tx: Tx, input: { accountId: string; proposalId: string },
): Promise<RestoreSource | null> {
  return (await readRestoreSources(tx, input.accountId, [input.proposalId], true)).get(input.proposalId) ?? null;
}

export async function resolveProposalRestoreInput(
  db: Db, accountId: string,
  proposal: Pick<ProposalView, 'id' | 'input' | 'operation' | 'contractVersion' | 'locationId'>,
): Promise<DerivedRestoreInput | null> {
  const provenance = parseRestoreInput(proposal.input);
  if (!provenance || provenance.sourceProposalId === proposal.id) return null;
  const source = (await readRestoreSources(db, accountId, [provenance.sourceProposalId])).get(provenance.sourceProposalId);
  return source ? deriveRestoreInput({ accountId, ...proposal, source }) : null;
}

async function mapStoredRows(db: Db, accountId: string, rows: readonly StoredRow[]): Promise<ProposalView[]> {
  const ids = rows.flatMap((row) => {
    const parsed = parseRestoreInput(parseJsonbObject(row.input, 'agent_proposals.input'));
    return parsed ? [parsed.sourceProposalId] : [];
  });
  const sources = await readRestoreSources(db, accountId, ids);
  return rows.map((row) => {
    const input = parseJsonbObject(row.input, 'agent_proposals.input');
    const sourceId = parseRestoreInput(input)?.sourceProposalId;
    const source = sourceId && sourceId !== row.id ? sources.get(sourceId) : undefined;
    const restore = source ? deriveRestoreInput({ accountId, operation: row.operation,
      contractVersion: row.contract_version, locationId: row.location_id, source }) : null;
    return mapStored(row, restore);
  });
}

export async function listProposalsForTurn(
  db: Db,
  input: { turnId: string; accountId: string },
): Promise<ProposalView[]> {
  const rows = await db<StoredRow[]>`
    SELECT ${proposalColumns(db)}
    FROM agent_proposals
    WHERE turn_id = ${input.turnId}::uuid
      AND account_id = ${input.accountId}::uuid
    ORDER BY created_at ASC
  `;
  return mapStoredRows(db, input.accountId, rows);
}

/**
 * Every turn's proposals in ONE `turn_id = ANY(...)` read, keyed by turn. An
 * empty id list issues no statement at all.
 */
export async function listProposalsForTurns(
  db: Db,
  input: { turnIds: readonly string[]; accountId: string },
): Promise<Map<string, ProposalView[]>> {
  const byTurn = new Map<string, ProposalView[]>();
  if (input.turnIds.length === 0) return byTurn;

  const rows = await db<StoredRow[]>`
    SELECT ${proposalColumns(db)}
    FROM agent_proposals
    WHERE turn_id = ANY(${input.turnIds as string[]}::uuid[])
      AND account_id = ${input.accountId}::uuid
    ORDER BY created_at ASC
  `;
  for (const row of await mapStoredRows(db, input.accountId, rows)) {
    const existing = byTurn.get(row.turnId);
    if (existing) existing.push(row);
    else byTurn.set(row.turnId, [row]);
  }
  return byTurn;
}

export async function listPendingProposals(
  db: Db,
  input: { conversationId: string; accountId: string },
): Promise<ProposalView[]> {
  const rows = await db<StoredRow[]>`
    SELECT ${proposalColumns(db)}
    FROM agent_proposals
    WHERE conversation_id = ${input.conversationId}::uuid
      AND account_id = ${input.accountId}::uuid
      AND status = ${PROPOSAL_STATUS.PENDING}
    ORDER BY created_at ASC
  `;
  return mapStoredRows(db, input.accountId, rows);
}

/** References are bounded by the stored segment limit and transcript window. */
export async function listProposalsByIds(
  db: Db, input: { accountId: string; proposalIds: readonly string[] },
): Promise<ProposalView[]> {
  const ids = [...new Set(input.proposalIds)];
  if (ids.length === 0) return [];
  if (ids.length > 600) throw new Error('agents/operator: proposal reference read exceeds transcript bound');
  const rows = await db<StoredRow[]>`
    SELECT ${proposalColumns(db)} FROM agent_proposals
    WHERE account_id = ${input.accountId}::uuid AND id = ANY(${ids}::uuid[])
    ORDER BY created_at ASC, id ASC
  `;
  return mapStoredRows(db, input.accountId, rows);
}

export interface RulesTimelineCursor { appliedAt: string; id: string }

/** An independent keyset page; timestamps retain database microseconds. */
export async function listAppliedProposals(
  db: Db,
  input: { accountId: string; locationId?: string | null; cursor?: RulesTimelineCursor; limit?: number },
): Promise<{ proposals: ProposalView[]; pendingRestores: ProposalView[]; nextCursor: RulesTimelineCursor | null }> {
  const limit = Math.max(1, Math.min(50, Math.trunc(input.limit ?? 25)));
  const rows = await db<StoredRow[]>`
    SELECT ${proposalColumns(db)} FROM agent_proposals
    WHERE account_id = ${input.accountId}::uuid AND status = ${PROPOSAL_STATUS.APPLIED}
      AND applied_at IS NOT NULL
      AND (${input.locationId === undefined} OR location_id IS NOT DISTINCT FROM ${input.locationId ?? null}::uuid)
      AND (${input.cursor === undefined} OR (applied_at, id) < (
        ${input.cursor?.appliedAt ?? 'infinity'}::text::timestamptz,
        ${input.cursor?.id ?? 'ffffffff-ffff-ffff-ffff-ffffffffffff'}::uuid
      ))
    ORDER BY applied_at DESC, id DESC LIMIT ${limit + 1}
  `;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const proposals = await mapStoredRows(db, input.accountId, page);
  const pending = page.length === 0 ? [] : await db<StoredRow[]>`
    SELECT ${proposalColumns(db)} FROM agent_proposals
    WHERE account_id = ${input.accountId}::uuid AND status = ${PROPOSAL_STATUS.PENDING}
      AND input->'restore'->>'sourceProposalId' = ANY(${page.map((row) => row.id)}::text[])
    ORDER BY created_at DESC, id DESC LIMIT 50
  `;
  return {
    proposals, pendingRestores: await mapStoredRows(db, input.accountId, pending),
    nextCursor: rows.length > limit && last
      ? { appliedAt: String(last.applied_at), id: last.id } : null,
  };
}

export interface UnsupportedRow {
  id: string;
  accountId: string;
  turnId: string;
  request: string;
  context: string;
}

export async function insertUnsupported(tx: Tx, rows: readonly UnsupportedRow[]): Promise<void> {
  for (const row of rows) {
    await tx`
      INSERT INTO agent_unsupported_requests (id, account_id, turn_id, request, context)
      VALUES (
        ${row.id}::uuid,
        ${row.accountId}::uuid,
        ${row.turnId}::uuid,
        ${row.request},
        ${row.context}
      )
    `;
  }
}

/** One **Requested capability** as the owner reads it. */
export interface UnsupportedView {
  id: string;
  request: string;
  context: string;
}

export async function listUnsupportedForTurn(
  db: Db,
  input: { turnId: string; accountId: string },
): Promise<UnsupportedView[]> {
  const rows = await db<UnsupportedView[]>`
    SELECT id, request, context
    FROM agent_unsupported_requests
    WHERE turn_id = ${input.turnId}::uuid
      AND account_id = ${input.accountId}::uuid
    ORDER BY created_at ASC
  `;
  return rows;
}

/**
 * Every turn's **Requested capability** rows in ONE `turn_id = ANY(...)` read,
 * keyed by turn. The TRANSCRIPT needs these, not only the polled turn. An empty
 * id list issues no statement at all.
 */
export async function listUnsupportedForTurns(
  db: Db,
  input: { turnIds: readonly string[]; accountId: string },
): Promise<Map<string, UnsupportedView[]>> {
  const byTurn = new Map<string, UnsupportedView[]>();
  if (input.turnIds.length === 0) return byTurn;

  const rows = await db<(UnsupportedView & { turn_id: string })[]>`
    SELECT turn_id, id, request, context
    FROM agent_unsupported_requests
    WHERE turn_id = ANY(${input.turnIds as string[]}::uuid[])
      AND account_id = ${input.accountId}::uuid
    ORDER BY created_at ASC
  `;
  for (const row of rows) {
    const existing = byTurn.get(row.turn_id);
    const view: UnsupportedView = { id: row.id, request: row.request, context: row.context };
    if (existing) existing.push(view);
    else byTurn.set(row.turn_id, [view]);
  }
  return byTurn;
}

/**
 * One **Proposal**, account-scoped, WITHOUT a lock. The pre-transaction read
 * Apply uses for the **Contract version** check, and the read both POST routes
 * use to render a result. A row of another account returns null.
 */
export async function readProposalForAccount(
  db: Db,
  input: { proposalId: string; accountId: string },
): Promise<ProposalView | null> {
  const [row] = await db<StoredRow[]>`
    SELECT ${proposalColumns(db)}
    FROM agent_proposals
    WHERE id = ${input.proposalId}::uuid
      AND account_id = ${input.accountId}::uuid
  `;
  return row ? (await mapStoredRows(db, input.accountId, [row]))[0]! : null;
}

/**
 * The same read WITH `FOR UPDATE`. Callers must be inside `sql.begin()` for the
 * lock to hold — outside a transaction PgBouncer drops the row lock the instant
 * the SELECT returns.
 */
export async function lockProposalForAccount(
  tx: Tx,
  input: { proposalId: string; accountId: string },
): Promise<ProposalView | null> {
  const [row] = await tx<StoredRow[]>`
    SELECT ${proposalColumns(tx)}
    FROM agent_proposals
    WHERE id = ${input.proposalId}::uuid
      AND account_id = ${input.accountId}::uuid
    FOR UPDATE
  `;
  return row ? (await mapStoredRows(tx, input.accountId, [row]))[0]! : null;
}

function proposableIdsFor(domain: ProposableOperation['domain']): string[] {
  return Object.values(CATALOG).flatMap((operation) =>
    operation.kind === 'proposable' && operation.domain === domain ? [operation.id] : []);
}

/** Derived from the catalog, never a second hand-written list. */
const VOICE_OPERATION_IDS = proposableIdsFor('voice');
const POLICY_OPERATION_IDS = proposableIdsFor('policy');

/**
 * Spec §8.3: after one Apply, every OTHER pending **Proposal** whose
 * **Version token** that write moved is stale — and ONLY those. The sweep
 * follows the token, not the location:
 *
 *  - `voice` → voice operations on that business (`businesses.updated_at`).
 *  - `policy` + a location → policy operations on that location: their token
 *    carries the location row. Voice proposals there are untouched.
 *  - `policy` + null (the account default) → EVERY policy operation of the
 *    account, account-scope and location-scope alike, because a location token
 *    always carries the parent row too.
 *
 * It never reaches the other domain's proposals, so a voice Apply never takes
 * a policy proposal's row lock and vice versa: each domain's parent-lock
 * order stays independent.
 *
 * Runs in the SAME transaction as the mutation (D11). No `conversation_id`
 * predicate, deliberately: a sibling prepared in another conversation is just
 * as stale.
 */
export async function markSiblingProposalsStale(
  tx: Tx,
  input: {
    accountId: string;
    domain: ProposableOperation['domain'];
    locationId: string | null;
    excludeProposalId: string;
  },
): Promise<void> {
  if (input.domain === 'policy' && input.locationId === null) {
    await tx`
      UPDATE agent_proposals
      SET status = ${PROPOSAL_STATUS.STALE},
          failure_reason = ${PROPOSAL_FAILURE_REASON.VERSION_MISMATCH},
          updated_at = NOW()
      WHERE account_id = ${input.accountId}::uuid
        AND operation = ANY(${POLICY_OPERATION_IDS}::text[])
        AND status = ${PROPOSAL_STATUS.PENDING}
        AND id <> ${input.excludeProposalId}::uuid
    `;
    return;
  }
  if (input.locationId === null) {
    throw new Error('agents/operator: a voice write always names a location');
  }
  const operations = input.domain === 'voice' ? VOICE_OPERATION_IDS : POLICY_OPERATION_IDS;
  await tx`
    UPDATE agent_proposals
    SET status = ${PROPOSAL_STATUS.STALE},
        failure_reason = ${PROPOSAL_FAILURE_REASON.VERSION_MISMATCH},
        updated_at = NOW()
    WHERE account_id = ${input.accountId}::uuid
      AND location_id = ${input.locationId}::uuid
      AND operation = ANY(${operations}::text[])
      AND status = ${PROPOSAL_STATUS.PENDING}
      AND id <> ${input.excludeProposalId}::uuid
  `;
}

export type DeclineResult =
  | { kind: 'rejected'; proposal: ProposalView; repeated: boolean }
  | { kind: 'not_pending'; proposal: ProposalView; status: ProposalStatus }
  | { kind: 'not_found' };

/**
 * "Not now" (spec §6.3): the owner declined. THE ACTOR IS THE WHOLE RECORD —
 * `status='rejected'` and `decided_by_user_id`, with `failure_reason` left
 * NULL (D5).
 *
 * IDEMPOTENT. A second click finds a row that is already `rejected` WITH NO
 * REASON and returns it unchanged with `repeated: true`. A row rejected by the
 * SERVER carries a reason and answers `not_pending`.
 *
 * Inside `sql.begin` with the row locked. No parent lock: nothing outside
 * `agent_proposals` changes.
 */
export async function declineProposal(
  sql: postgres.Sql,
  input: { proposalId: string; accountId: string; actorUserId: string },
): Promise<DeclineResult> {
  return sql.begin(async (tx): Promise<DeclineResult> => {
    const proposal = await lockProposalForAccount(tx, {
      proposalId: input.proposalId,
      accountId: input.accountId,
    });
    if (!proposal) return { kind: 'not_found' };

    if (
      proposal.status === PROPOSAL_STATUS.REJECTED &&
      proposal.failureReason === null
    ) {
      return { kind: 'rejected', proposal, repeated: true };
    }
    if (proposal.status !== PROPOSAL_STATUS.PENDING) {
      return { kind: 'not_pending', proposal, status: proposal.status };
    }

    await tx`
      UPDATE agent_proposals
      SET status = ${PROPOSAL_STATUS.REJECTED},
          decided_by_user_id = ${input.actorUserId}::uuid,
          failure_reason = NULL,
          updated_at = NOW()
      WHERE id = ${input.proposalId}::uuid
        AND account_id = ${input.accountId}::uuid
    `;

    const declined = await readProposalForAccount(tx, {
      proposalId: input.proposalId,
      accountId: input.accountId,
    });
    if (!declined) throw new Error('agents/operator: declined proposal vanished in its own transaction');
    return { kind: 'rejected', proposal: declined, repeated: false };
  });
}
