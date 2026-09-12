// Proposal construction, persistence and supersession. Every statement carries
// account_id.
import type postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import type { VoiceConfig } from '@/lib/responses/voice-settings';
import { proposableOperation, type LabelKind } from './catalog';
import type { ParsedProposal } from './render';
import {
  PROPOSAL_STATUS,
  asProposalStatus,
  parseJsonbObject,
  type ProposalStatus,
} from './schema';

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
  preparedVersionToken: Record<string, unknown>;
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
  /** The turn's STORED location — the **Version token**'s scope. */
  locationId: string;
}

/**
 * Validated proposals → storable rows. `before`/`after` are the FULL effective
 * voice state of the location, computed server-side from the catalog's own
 * preview, never from anything the model said. `requires_confirmation` is
 * always false in Run A: no registered operation widens autonomy (L5).
 *
 * It consumes the validator's `ParsedProposal`s, so the catalog lookup and the
 * input parse happen once on the path and there is no unreachable branch here
 * to re-handle what the validator already rejected.
 */
export function buildProposalRows(
  turn: ProposalTurnContext,
  proposals: readonly ParsedProposal[],
  voice: VoiceConfig & { updatedAt: string },
): ProposalRow[] {
  return proposals.map((proposal) => {
    const { before, after } = proposal.operation.preview(voice, proposal.input);
    return {
      id: uuidv7(),
      conversationId: turn.conversationId,
      turnId: turn.turnId,
      accountId: turn.accountId,
      actorUserId: turn.actorUserId,
      locationId: proposal.scope.locationId ?? null,
      operation: proposal.operation.id,
      contractVersion: proposal.operation.contractVersion,
      input: proposal.input,
      before: { ...before },
      after: { ...after },
      rationale: proposal.rationale,
      labelKind: proposal.operation.labelKind,
      preparedVersionToken: { businessId: turn.locationId, updatedAt: voice.updatedAt },
      requiresConfirmation: false,
      status: PROPOSAL_STATUS.PENDING,
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
 * one reply. Excluding only the replacement itself let a single turn that
 * proposed two same-scope changes supersede its own sibling — the owner would
 * be shown one card and one already-dead card from the same sentence, and
 * whichever one died depended on the loop order. This predicate also subsumes
 * the id check: a row of another turn can never be the replacement.
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
    `;
  }
}

type StoredRow = {
  id: string; operation: string; contract_version: number; label_kind: LabelKind;
  location_id: string | null; status: string; rationale: string;
  input: unknown; before: unknown; after: unknown;
};

type StoredRowWithTurn = StoredRow & { turn_id: string };

/** One **Proposal** as the owner reads it. The named public shape of the card. */
export interface ProposalView {
  id: string;
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
}

function mapStored(row: StoredRow): ProposalView {
  const input = parseJsonbObject(row.input, 'agent_proposals.input');
  const operation = proposableOperation(row.operation);
  const parsed = operation?.parseInput(input);
  return {
    id: row.id,
    operation: row.operation,
    contractVersion: row.contract_version,
    labelKind: row.label_kind,
    locationId: row.location_id,
    status: asProposalStatus(row.status),
    rationale: row.rationale,
    input,
    before: parseJsonbObject(row.before, 'agent_proposals.before'),
    after: parseJsonbObject(row.after, 'agent_proposals.after'),
    // The card's words come from the CATALOG at read time, never from a stored
    // string, so a copy edit ships without a data migration. A row whose
    // operation left the catalog (or whose stored input no longer parses under
    // a bumped contract) falls back to its rationale rather than throwing — the
    // card is still readable and Run B's Apply is what refuses it.
    describe: operation && parsed?.ok ? operation.describe(parsed.input) : row.rationale,
  };
}

export async function listProposalsForTurn(
  db: Db,
  input: { turnId: string; accountId: string },
): Promise<ProposalView[]> {
  const rows = await db<StoredRow[]>`
    SELECT id, operation, contract_version, label_kind, location_id, status, rationale,
           input, before, after
    FROM agent_proposals
    WHERE turn_id = ${input.turnId}::uuid
      AND account_id = ${input.accountId}::uuid
    ORDER BY created_at ASC
  `;
  return rows.map(mapStored);
}

/**
 * Every turn's proposals in ONE `turn_id = ANY(...)` read, keyed by turn.
 *
 * The per-turn alternative is an N+1 across a whole transcript — one query per
 * turn, on every poll, over a conversation that grows without bound. An empty
 * id list issues no statement at all rather than a query that can match
 * nothing.
 */
export async function listProposalsForTurns(
  db: Db,
  input: { turnIds: readonly string[]; accountId: string },
): Promise<Map<string, ProposalView[]>> {
  const byTurn = new Map<string, ProposalView[]>();
  if (input.turnIds.length === 0) return byTurn;

  const rows = await db<StoredRowWithTurn[]>`
    SELECT turn_id, id, operation, contract_version, label_kind, location_id, status, rationale,
           input, before, after
    FROM agent_proposals
    WHERE turn_id = ANY(${input.turnIds as string[]}::uuid[])
      AND account_id = ${input.accountId}::uuid
    ORDER BY created_at ASC
  `;
  for (const row of rows) {
    const existing = byTurn.get(row.turn_id);
    if (existing) existing.push(mapStored(row));
    else byTurn.set(row.turn_id, [mapStored(row)]);
  }
  return byTurn;
}

export async function listPendingProposals(
  db: Db,
  input: { conversationId: string; accountId: string },
): Promise<ProposalView[]> {
  const rows = await db<StoredRow[]>`
    SELECT id, operation, contract_version, label_kind, location_id, status, rationale,
           input, before, after
    FROM agent_proposals
    WHERE conversation_id = ${input.conversationId}::uuid
      AND account_id = ${input.accountId}::uuid
      AND status = ${PROPOSAL_STATUS.PENDING}
    ORDER BY created_at ASC
  `;
  return rows.map(mapStored);
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
