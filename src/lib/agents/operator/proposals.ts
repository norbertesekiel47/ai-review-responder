// Proposal persistence and supersession. Every statement carries account_id.
import type postgres from 'postgres';
import { proposableOperation, type LabelKind } from './catalog';
import { PROPOSAL_STATUS, parseJsonbObject, type ProposalStatus } from './schema';

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
 */
export async function supersedePendingProposals(
  tx: Tx,
  input: {
    conversationId: string;
    accountId: string;
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
        AND id <> ${replacement.proposalId}::uuid
    `;
  }
}

type StoredRow = {
  id: string; operation: string; contract_version: number; label_kind: LabelKind;
  location_id: string | null; status: string; rationale: string;
  input: unknown; before: unknown; after: unknown;
};

function mapStored(row: StoredRow) {
  const input = parseJsonbObject(row.input, 'agent_proposals.input');
  const operation = proposableOperation(row.operation);
  const parsed = operation?.parseInput(input);
  return {
    id: row.id,
    operation: row.operation,
    contractVersion: row.contract_version,
    labelKind: row.label_kind,
    locationId: row.location_id,
    status: row.status,
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

export async function listProposalsForTurn(db: Db, input: { turnId: string; accountId: string }) {
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

export async function listPendingProposals(
  db: Db,
  input: { conversationId: string; accountId: string },
) {
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

export async function listUnsupportedForTurn(db: Db, input: { turnId: string; accountId: string }) {
  const rows = await db<{ id: string; request: string; context: string }[]>`
    SELECT id, request, context
    FROM agent_unsupported_requests
    WHERE turn_id = ${input.turnId}::uuid
      AND account_id = ${input.accountId}::uuid
    ORDER BY created_at ASC
  `;
  return rows;
}
