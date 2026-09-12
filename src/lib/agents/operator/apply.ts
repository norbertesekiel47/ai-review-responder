// The Apply protocol (spec §6.4): one call, one transaction, one **Receipt**.
//
// LOCK BEFORE CHECK is the whole design. Every freshness read, every
// revalidation and the write itself happen with the `businesses` row and the
// `agent_proposals` row already locked, so no writer can slip between the check
// and the write. The reverse order — read, then lock — is the classic
// time-of-check/time-of-use hole, and the **Version token** exists precisely to
// close it.
//
// Invariant #15: `sql`/`tx` arrive as parameters; this module never imports
// @/lib/db/server. Invariant #9: every statement carries an `account_id`
// predicate. Invariant #3: the only thing that changes is a location's voice
// columns, through the shared writer.
import type postgres from 'postgres';
import { isSubscriptionTier } from '@/lib/accounts/tier-config';
import { readVoiceConfig, updateVoiceConfig, type VoiceConfig } from '@/lib/responses/voice-settings';
import { assertWritableSubscriptionForAccount } from '@/lib/shared/writable-subscription';
import { proposableOperation } from './catalog';
import {
  lockProposalForAccount,
  markSiblingProposalsStale,
  readProposalForAccount,
  type ProposalView,
} from './proposals';
import {
  PROPOSAL_FAILURE_REASON,
  PROPOSAL_STATUS,
  parseVoiceState,
  type ProposalFailureReason,
  type ProposalStatus,
  type Receipt,
  type VoiceState,
} from './schema';
import {
  computeVoiceVersionToken,
  versionTokensEqual,
  type VoiceVersionToken,
} from './version-token';

type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;

export interface ApplyProposalInput {
  proposalId: string;
  accountId: string;
  actorUserId: string;
  /** The token the CARD was rendered from. All three must agree (D9). */
  expectedVersionToken: VoiceVersionToken;
}

/**
 * Six outcomes, and every non-`not_found` one carries the row, so the card
 * re-renders from what the server actually stored rather than from the
 * browser's interpretation of a status code.
 */
export type ApplyResult =
  | { kind: 'applied'; proposal: ProposalView; repeated: boolean }
  | { kind: 'stale'; proposal: ProposalView }
  | { kind: 'rejected'; proposal: ProposalView; reason: ProposalFailureReason }
  | { kind: 'failed'; proposal: ProposalView }
  | { kind: 'not_pending'; proposal: ProposalView; status: ProposalStatus }
  | { kind: 'not_found' };

export async function applyProposal(sql: Sql, input: ApplyProposalInput): Promise<ApplyResult> {
  // ── Before the transaction (spec §6.4) ──────────────────────────────────
  const loaded = await readProposalForAccount(sql, {
    proposalId: input.proposalId,
    accountId: input.accountId,
  });
  if (!loaded) return { kind: 'not_found' };

  const operation = proposableOperation(loaded.operation);
  const contractCurrent = operation !== null && operation.contractVersion === loaded.contractVersion;

  // The **Contract version** check runs before any lock — but it REWRITES the
  // row only while that row is still pending (plan decision P5). Taken
  // literally on an `applied` row, an unguarded rewrite would overwrite a
  // terminal status with `rejected` and destroy the stored Receipt. A
  // non-pending row falls through to the transaction, whose status branch
  // answers `not_pending`.
  if (!contractCurrent && loaded.status === PROPOSAL_STATUS.PENDING) {
    const outcome = await recordTerminal(sql, {
      proposalId: input.proposalId,
      accountId: input.accountId,
      actorUserId: input.actorUserId,
      status: PROPOSAL_STATUS.REJECTED,
      reason: PROPOSAL_FAILURE_REASON.CONTRACT_CHANGED,
    });
    // `loaded.status` was read WITHOUT a lock, so it is already stale by the
    // time the UPDATE runs: a concurrent Apply can commit in between, and an
    // unguarded write would stamp `rejected` over an `applied` row and destroy
    // its **Receipt**. `recordTerminal`'s `status = 'pending'` predicate is
    // what stops that, and a zero-row result is how this branch learns it lost
    // the race. The row is re-read either way, so the answer is the state that
    // actually exists rather than the one this branch intended.
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

  // ── The transaction ─────────────────────────────────────────────────────
  return sql.begin(async (tx): Promise<ApplyResult> => {
    // A voice **Proposal** always names a location — `scopeRule` is `'location'`
    // on every proposable — so a NULL one is a row no writer this run produces
    // (P8). There is nothing to lock, so this is answered first.
    const locationId = loaded.locationId;
    if (locationId === null) {
      return rejected(tx, input, PROPOSAL_FAILURE_REASON.LOCATION_NOT_FOUND);
    }

    // 1a. The `businesses` row, FIRST and account-scoped and active-only. Its
    //     `updated_at::text` IS the current **Version token** (D9) — the same
    //     spelling `readVoiceConfig` and `updateVoiceConfig` both return, so
    //     the three tokens are comparable as text.
    const [locked] = await tx<{ updated_at: string }[]>`
      SELECT updated_at::text AS updated_at
      FROM businesses
      WHERE id = ${locationId}::uuid
        AND account_id = ${input.accountId}::uuid
        AND archived_at IS NULL
      FOR UPDATE
    `;
    // 1b. The proposal row, SECOND — and SECOND EVEN WHEN 1a FOUND NOTHING.
    //     Archiving a location is a supported owner action
    //     (`src/lib/locations/archive-location-tx.ts`), and migration 120 keeps
    //     the Proposal and its **Receipt** when it happens. Rejecting on the
    //     missing business before reading the proposal's status turns a repeat
    //     Apply on an ALREADY-APPLIED row into a 409 `location_not_found`, and
    //     the owner loses the Receipt that records what did happen. So the
    //     status branch runs first and the location refusal is reserved for a
    //     Proposal that is still `pending`. The business-before-proposal ORDER
    //     is unchanged wherever the business exists — which is the ordering the
    //     freshness check depends on.
    const proposal = await lockProposalForAccount(tx, {
      proposalId: input.proposalId,
      accountId: input.accountId,
    });
    if (!proposal) return { kind: 'not_found' };

    if (!locked) {
      if (proposal.status === PROPOSAL_STATUS.APPLIED) {
        return { kind: 'applied', proposal, repeated: true };
      }
      if (proposal.status !== PROPOSAL_STATUS.PENDING) {
        return { kind: 'not_pending', proposal, status: proposal.status };
      }
      // Still pending, and the location it names is gone: this one genuinely
      // cannot be applied.
      return rejected(tx, input, PROPOSAL_FAILURE_REASON.LOCATION_NOT_FOUND);
    }

    // 2. Ownership and state. A repeat Apply on an `applied` proposal returns
    //    the STORED Receipt and executes nothing (spec §6.4 step 2) — that is
    //    the whole idempotency story, and it is why the read happens under the
    //    lock rather than before it.
    if (proposal.status === PROPOSAL_STATUS.APPLIED) {
      return { kind: 'applied', proposal, repeated: true };
    }
    if (proposal.status !== PROPOSAL_STATUS.PENDING) {
      return { kind: 'not_pending', proposal, status: proposal.status };
    }
    // Reachable only for a non-pending row that fell through the pre-transaction
    // guard; a pending row with a stale contract was already answered above.
    if (!contractCurrent || operation === null) {
      return rejected(tx, input, PROPOSAL_FAILURE_REASON.CONTRACT_CHANGED);
    }

    // 3. Revalidate WITH THE LOCKS HELD. The POST-time gate is not reusable
    //    here: minutes may have passed, the owner may be revoked, and the
    //    account may have entered offboarding. Same three checks
    //    `reauthorizeTurn` makes (src/lib/agents/operator/authorize.ts:21-58),
    //    run against `tx` so they see the locked state.
    const [actor] = await tx<{ id: string }[]>`
      SELECT id
      FROM users
      WHERE id = ${input.actorUserId}::uuid
        AND account_id = ${input.accountId}::uuid
        AND role = 'owner'
    `;
    if (!actor) return rejected(tx, input, PROPOSAL_FAILURE_REASON.UNAUTHORIZED);

    const writable = await assertWritableSubscriptionForAccount(input.accountId, tx);
    if (!writable.ok) {
      return rejected(
        tx,
        input,
        writable.error === 'account_offboarding_blocked'
          ? PROPOSAL_FAILURE_REASON.ACCOUNT_OFFBOARDING
          : PROPOSAL_FAILURE_REASON.UNAUTHORIZED,
      );
    }

    const [account] = await tx<{ subscription_tier: string }[]>`
      SELECT subscription_tier
      FROM accounts
      WHERE id = ${input.accountId}::uuid
    `;
    if (!account || !isSubscriptionTier(account.subscription_tier)) {
      return rejected(tx, input, PROPOSAL_FAILURE_REASON.UNAUTHORIZED);
    }

    // 3b. The three tokens, TEXT TO TEXT (D9). `current` comes from the row we
    //     are holding, `prepared` from the proposal, `expected` from the client.
    //     All three must agree. The client's copy is checked too because a
    //     browser that is one render behind is describing a plan this row is
    //     not, even when the row itself has not moved (spec §6.4 step 3).
    const current = computeVoiceVersionToken({ businessId: locationId, updatedAt: locked.updated_at });
    const prepared = proposal.preparedVersionToken;
    if (
      !versionTokensEqual(current, prepared) ||
      !versionTokensEqual(prepared, input.expectedVersionToken)
    ) {
      const stale = await recordTerminal(tx, {
        proposalId: input.proposalId,
        accountId: input.accountId,
        actorUserId: input.actorUserId,
        status: PROPOSAL_STATUS.STALE,
        reason: PROPOSAL_FAILURE_REASON.VERSION_MISMATCH,
      });
      // `written` is necessarily true here — the row is locked and was read as
      // `pending` three statements ago — so the flag is not branched on. The
      // state change COMMITS; the mutation never happened.
      return { kind: 'stale', proposal: stale.proposal };
    }

    // 4. Confirmation — not in this run. No Run B operation widens autonomy
    //    (`requires_confirmation` is false on every row Run A writes), so the
    //    asymmetric-friction branch is slice 2's and is deliberately absent
    //    rather than stubbed.

    // 5. Execute, through the operation's own fields only (D10). `parseInput`
    //    re-runs because the stored input crossed JSONB; a row whose input no
    //    longer parses under the deployed schema is a contract problem, not a
    //    freshness one.
    const parsedInput = operation.parseInput(proposal.input);
    if (!parsedInput.ok) return rejected(tx, input, PROPOSAL_FAILURE_REASON.CONTRACT_CHANGED);

    const fields: Partial<VoiceConfig> = operation.writerFields(parsedInput.input);
    // A THROW here propagates: postgres.js rolls the whole transaction back,
    // mutation and Receipt together, and the route answers 500 `apply_failed`
    // with the proposal still `pending` (D12). A deterministic REFUSAL is a
    // different thing and is handled below.
    const write = await updateVoiceConfig(tx, {
      accountId: input.accountId,
      locationId,
      fields,
    });
    if (!write.ok) {
      if (write.reason === 'location_not_found') {
        // Unreachable while the lock above holds, but a branch rather than a
        // non-null assertion: the writer owns that reason, not this module.
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

    // 6. The Receipt. Read the committed-to-be state back from the locked row.
    const committed = await readVoiceConfig(tx, { accountId: input.accountId, locationId });
    if (!committed) {
      // The row is locked and was just updated, so this is impossible; throwing
      // rolls everything back rather than writing a Receipt built on a guess.
      throw new Error('agents/operator: voice row vanished inside the Apply transaction');
    }

    const [turn] = await tx<{ owner_text: string }[]>`
      SELECT owner_text
      FROM agent_turns
      WHERE id = ${proposal.turnId}::uuid
        AND account_id = ${input.accountId}::uuid
    `;

    const afterActual = toVoiceState(committed);
    const afterPreviewed = parseVoiceState(proposal.after, 'agent_proposals.after');
    // ONE clock for both the column and the Receipt field (P3).
    const appliedAt = new Date().toISOString();

    const receipt: Receipt = {
      version: 1,
      operation: proposal.operation,
      scope: { accountId: input.accountId, locationId },
      // The state the card SHOWED when the owner clicked (P6).
      before: parseVoiceState(proposal.before, 'agent_proposals.before'),
      after: afterActual,
      differsFromPreview: !voiceStatesEqual(afterActual, afterPreviewed),
      effectiveNow: true,
      affects: 'future_drafts',
      // No readiness gate applies to a fact change (P7).
      remainingBlocked: [],
      appliedAt,
      actorUserId: input.actorUserId,
      // VERBATIM. A missing turn row cannot happen (the FK is NOT NULL), but an
      // empty string is a safer fallback than a throw that would roll back a
      // committed-to-be voice write over a cosmetic field.
      ownerText: turn?.owner_text ?? '',
      turnId: proposal.turnId,
      versionToken: {
        before: prepared,
        after: computeVoiceVersionToken({ businessId: locationId, updatedAt: write.updatedAt }),
      },
    };

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

    // Spec §8.3, in the SAME transaction (D11).
    await markSiblingProposalsStale(tx, {
      accountId: input.accountId,
      locationId,
      excludeProposalId: input.proposalId,
    });

    return { kind: 'applied', proposal: applied, repeated: false };
  });
}

/**
 * One terminal transition plus the re-read that gives the caller the row.
 *
 * `AND status = 'pending'` IS LOAD-BEARING on the pre-transaction path and is
 * kept inside the transaction for symmetry. Before the transaction the status
 * was read WITHOUT a lock, so a concurrent Apply can commit between that read
 * and this UPDATE; without the predicate the write would stamp `rejected` over
 * an `applied` row and destroy a committed **Receipt** — the one thing the
 * Receipt invariant forbids. `written` reports whether the UPDATE matched, so
 * a caller that lost the race can answer with the state that exists rather
 * than the one it intended. Inside `sql.begin` the row is already locked and
 * `written` is always true, but a predicate that is free and correct in both
 * places is better than one that is correct in only one.
 *
 * The re-read rather than a `RETURNING` projection so `mapStored` stays the ONE
 * place a row becomes a `ProposalView` — a second hand-written mapping here is
 * how the card's `describe` and its status start disagreeing. It also returns
 * the CURRENT row on a lost race, which is exactly what the caller needs.
 */
async function recordTerminal(
  db: Sql | Tx,
  input: {
    proposalId: string;
    accountId: string;
    actorUserId: string;
    status: ProposalStatus;
    reason: ProposalFailureReason;
  },
): Promise<{ written: boolean; proposal: ProposalView }> {
  const result = await db`
    UPDATE agent_proposals
    SET status = ${input.status},
        failure_reason = ${input.reason},
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
  // Every caller of this helper holds the proposal's row lock and has already
  // seen it `pending`, so the UPDATE always matches and `written` is not
  // branched on here.
  const { proposal } = await recordTerminal(tx, {
    proposalId: input.proposalId,
    accountId: input.accountId,
    actorUserId: input.actorUserId,
    status: PROPOSAL_STATUS.REJECTED,
    reason,
  });
  return { kind: 'rejected', proposal, reason };
}

/** `VoiceConfig & { updatedAt }` → the Receipt's five-field state. */
function toVoiceState(voice: VoiceConfig): VoiceState {
  return {
    tone: voice.tone,
    productsServices: voice.productsServices,
    avoidFacts: voice.avoidFacts,
    highlightFacts: voice.highlightFacts,
    sampleResponses: voice.sampleResponses,
  };
}

/**
 * Field-by-field, arrays by order. `JSON.stringify` comparison would make key
 * ORDER significant, and the two sides are built by different code paths.
 */
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
