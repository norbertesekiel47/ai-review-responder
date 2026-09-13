// Live-DB proofs for src/lib/agents/operator/apply.ts.
//
// Nothing is mocked. The five cases here are the ones a double cannot answer:
// that the Receipt and the voice write share ONE transaction; that the sibling
// sweep touches this location and no other; that the Receipt's `after` is the
// committed state; that a throwing executor leaves nothing behind; and that two
// concurrent Applies serialize on the `businesses` row lock.
//
// Named *.integration.test.ts so vitest's serialized `integration` project
// picks it up (vitest.config.ts:26), and it executes NO DDL at run time — the
// schema is ASSERTED, never applied (.claude/rules/live-db-tests.md).
//
// SILENT SKIP WARNING: without TEST_DATABASE_POOL_URL this whole suite is
// skipped and the run still reports green. A skipped live proof looks exactly
// like a passing one in the summary line. Export TEST_DATABASE_POOL_URL AND
// DATABASE_POOL_URL before trusting a local run.
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  acquireLiveDbLock,
  assertLocalTestDatabaseUrl,
  LIVE_DB_LOCK_HOOK_TIMEOUT_MS,
  resolveTestDatabaseUrl,
  type LiveDbLock,
} from '@/lib/shared/__tests__/helpers/live-db-lock';
import { abortingExecutor } from '@/lib/shared/__tests__/helpers/abort-injection';
import {
  assertSchemaReady,
  MIGRATION_120_OWNER_OPERATOR,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import {
  cleanupTenantAccount,
  seedLocation,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import { readVoiceConfig } from '@/lib/responses/voice-settings';
import { applyProposal } from '../apply';
import { proposableOperation } from '../catalog';
import {
  buildProposalRows,
  insertProposals,
  readProposalForAccount,
  type ProposalRow,
} from '../proposals';
import { PROPOSAL_FAILURE_REASON, PROPOSAL_STATUS, parseVoiceState } from '../schema';
import { createTurn, type CreateTurnResult } from '../turns';

const testDatabaseUrl = resolveTestDatabaseUrl();
let db: postgres.Sql;
let lock: LiveDbLock | undefined;

let tenant: TenantSeed;
let locationId: string;
/** A SECOND location in the same account — the sibling sweep's negative case. */
let secondLocationId: string;

function createdOrThrow(result: CreateTurnResult): { conversationId: string; turnId: string } {
  if (result.kind !== 'created') throw new Error(`expected a created turn, got ${result.kind}`);
  return { conversationId: result.conversationId, turnId: result.turnId };
}

async function seedTurn(targetLocationId: string, text: string) {
  return createdOrThrow(await createTurn(db, {
    accountId: tenant.accountId,
    actorUserId: tenant.userId,
    conversationId: randomUUID(),
    clientTurnKey: randomUUID(),
    locationId: targetLocationId,
    text,
  }));
}

/** The location's current `updated_at::text` — the live **Version token** half. */
async function currentUpdatedAt(id: string): Promise<string> {
  const [row] = await db<{ updated_at: string }[]>`
    SELECT updated_at::text AS updated_at
    FROM businesses
    WHERE id = ${id}::uuid AND account_id = ${tenant.accountId}::uuid
  `;
  if (!row) throw new Error('fixture location vanished');
  return row.updated_at;
}

/**
 * One pending `set_tone` **Proposal** written through the production writer,
 * with its **Version token** taken from the row as it stands NOW.
 *
 * ONE ROW PER TRANSACTION, following src/lib/agents/operator/__tests__/reads.integration.test.ts:84-90:
 * `created_at` defaults to the TRANSACTION's start time, so a batch written
 * inside one `begin` shares a timestamp and `ORDER BY created_at ASC` is free
 * to return them in either order.
 */
async function seedProposal(input: {
  conversationId: string;
  turnId: string;
  targetLocationId: string;
  tone: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}): Promise<{ proposalId: string; token: { businessId: string; updatedAt: string } }> {
  const updatedAt = await currentUpdatedAt(input.targetLocationId);
  const emptyVoice = {
    tone: null, productsServices: null, avoidFacts: [], highlightFacts: [], sampleResponses: [],
  };
  const row: ProposalRow = {
    id: randomUUID(),
    conversationId: input.conversationId,
    turnId: input.turnId,
    accountId: tenant.accountId,
    actorUserId: tenant.userId,
    locationId: input.targetLocationId,
    operation: 'set_tone',
    contractVersion: 1,
    input: { tone: input.tone },
    before: input.before ?? emptyVoice,
    after: input.after ?? { ...emptyVoice, tone: input.tone },
    rationale: 'You asked for warmer replies.',
    labelKind: 'fact',
    preparedVersionToken: { businessId: input.targetLocationId, updatedAt },
    requiresConfirmation: false,
    status: PROPOSAL_STATUS.PENDING,
  };
  await db.begin(async (tx) => { await insertProposals(tx, [row]); });
  return { proposalId: row.id, token: { businessId: input.targetLocationId, updatedAt } };
}

/**
 * A Proposal inserted at a given terminal status, for the archived-location
 * cases. `seedProposal` cannot be reused there: it reads `updated_at` from a
 * row that is archived by the time it runs, and `readVoiceConfig`-shaped reads
 * exclude archived rows by design.
 */
async function seedProposalOnArchived(input: {
  conversationId: string;
  turnId: string;
  targetLocationId: string;
  status: (typeof PROPOSAL_STATUS)[keyof typeof PROPOSAL_STATUS];
}): Promise<string> {
  const emptyVoice = {
    tone: null, productsServices: null, avoidFacts: [], highlightFacts: [], sampleResponses: [],
  };
  const row: ProposalRow = {
    id: randomUUID(),
    conversationId: input.conversationId,
    turnId: input.turnId,
    accountId: tenant.accountId,
    actorUserId: tenant.userId,
    locationId: input.targetLocationId,
    operation: 'set_tone',
    contractVersion: 1,
    input: { tone: 'formal' },
    before: emptyVoice,
    after: { ...emptyVoice, tone: 'formal' },
    rationale: 'A superseded plan.',
    labelKind: 'fact',
    preparedVersionToken: { businessId: input.targetLocationId, updatedAt: '2026-01-01 00:00:00+00' },
    requiresConfirmation: false,
    status: PROPOSAL_STATUS.PENDING,
  };
  await db.begin(async (tx) => { await insertProposals(tx, [row]); });
  await db`
    UPDATE agent_proposals SET status = ${input.status}
    WHERE id = ${row.id}::uuid AND account_id = ${tenant.accountId}::uuid
  `;
  return row.id;
}

async function readTone(id: string): Promise<string | null> {
  const [row] = await db<{ tone: string | null }[]>`
    SELECT tone FROM businesses
    WHERE id = ${id}::uuid AND account_id = ${tenant.accountId}::uuid
  `;
  return row?.tone ?? null;
}

async function deleteOperatorRows(accountId: string): Promise<void> {
  await db`DELETE FROM agent_unsupported_requests WHERE account_id = ${accountId}::uuid`;
  await db`DELETE FROM agent_proposals WHERE account_id = ${accountId}::uuid`;
  await db`DELETE FROM agent_turns WHERE account_id = ${accountId}::uuid`;
  await db`DELETE FROM agent_conversations WHERE account_id = ${accountId}::uuid`;
}

describeWithDb(
  'applyProposal (live DB)',
  { enabled: Boolean(testDatabaseUrl), timeout: 180_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      lock = await acquireLiveDbLock(databaseUrl);
      db = postgres(databaseUrl, {
        max: 4,
        prepare: false,
        connection: { statement_timeout: 30_000 },
      });
      await assertSchemaReady(db, [MIGRATION_120_OWNER_OPERATOR]);

      tenant = await seedTenantAccount(db, {
        userName: 'Operator Apply Owner',
        accountDisplayName: 'Operator Apply Account',
      });
      locationId = (await seedLocation(db, tenant.accountId, { name: 'Salon' })).businessId;
      secondLocationId = (await seedLocation(db, tenant.accountId, {
        name: 'Cafe', isPrimary: false,
      })).businessId;
      process.env.OWNER_OPERATOR_ENABLED = 'true';
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    afterEach(async () => {
      await deleteOperatorRows(tenant.accountId);
      await db`DELETE FROM job_outbox WHERE topic = 'agent_turn'`;
      // Reset the voice columns so each case starts from a known state and its
      // own **Version token** read is meaningful.
      await db`
        UPDATE businesses
        SET tone = NULL, products_services = NULL, avoid_facts = NULL,
            highlight_facts = NULL, sample_responses = NULL
        WHERE account_id = ${tenant.accountId}::uuid
      `;
    }, 60_000);

    afterAll(async () => {
      try {
        if (db) {
          await db`DELETE FROM businesses WHERE account_id = ${tenant.accountId}::uuid`;
          await cleanupTenantAccount(db, tenant);
        }
      } finally {
        try {
          if (db) await db.end({ timeout: 5 });
        } finally {
          await lock?.release();
          lock = undefined;
        }
      }
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    it('applyProposal writes the receipt, status applied and decided_by_user_id in the same transaction as the voice write', async () => {
      const turn = await seedTurn(locationId, 'Make my replies warmer.');
      const { proposalId, token } = await seedProposal({
        conversationId: turn.conversationId,
        turnId: turn.turnId,
        targetLocationId: locationId,
        tone: 'warm and brief',
      });

      const result = await applyProposal(db, {
        proposalId,
        accountId: tenant.accountId,
        actorUserId: tenant.userId,
        expectedVersionToken: token,
      });

      expect(result.kind).toBe('applied');
      if (result.kind !== 'applied') throw new Error('unreachable');
      expect(result.repeated).toBe(false);

      // The COMMITTED row, read back on a fresh statement.
      const [row] = await db<{
        status: string; decided_by_user_id: string | null; applied_at: Date | null;
        receipt: unknown; failure_reason: string | null;
      }[]>`
        SELECT status, decided_by_user_id, applied_at, receipt, failure_reason
        FROM agent_proposals
        WHERE id = ${proposalId}::uuid AND account_id = ${tenant.accountId}::uuid
      `;
      expect(row!.status).toBe(PROPOSAL_STATUS.APPLIED);
      expect(row!.decided_by_user_id).toBe(tenant.userId);
      expect(row!.applied_at).not.toBeNull();
      expect(row!.failure_reason).toBeNull();

      // And the voice write committed with it. One transaction, or neither.
      expect(await readTone(locationId)).toBe('warm and brief');

      const receipt = result.proposal.receipt;
      expect(receipt).not.toBeNull();
      if (receipt?.affects !== 'future_drafts') throw new Error('expected a voice receipt');
      expect(receipt!.version).toBe(1);
      expect(receipt!.operation).toBe('set_tone');
      expect(receipt!.scope).toEqual({ accountId: tenant.accountId, locationId });
      // THE TWO ENDS OF THE MOVE, and they provably differ: `before` is the
      // state the card SHOWED (tone unset), `after` the state that actually
      // committed. A Receipt that recorded the after-state twice would say the
      // owner approved a change from "warm and brief" to "warm and brief".
      expect(receipt!.before.tone).toBeNull();
      expect(receipt!.after.tone).toBe('warm and brief');
      expect(receipt!.effectiveNow).toBe(true);
      expect(receipt!.affects).toBe('future_drafts');
      expect(receipt!.remainingBlocked).toEqual([]);
      expect(receipt!.actorUserId).toBe(tenant.userId);
      // …and WHO in words (S5): the card renders this, never the uuid. Read
      // from the same `users` row the gate checked, inside the transaction.
      expect(receipt!.actorName).toBe('Operator Apply Owner');
      expect(receipt!.turnId).toBe(turn.turnId);
      // VERBATIM owner text (spec §6.5), read from the turn, not from the card.
      expect(receipt!.ownerText).toBe('Make my replies warmer.');
      // The token moved, and the Receipt records both ends of the move.
      expect(receipt!.versionToken.before).toEqual(token);
      expect(receipt!.versionToken.after.updatedAt).not.toBe(token.updatedAt);
      expect(receipt!.versionToken.after.updatedAt).toBe(await currentUpdatedAt(locationId));
      // ONE clock for the column and the field (plan decision P3).
      expect(new Date(receipt!.appliedAt).getTime()).toBe(row!.applied_at!.getTime());
    });

    it('applyProposal marks sibling pending proposals on the same location stale in the same transaction and leaves other locations alone', async () => {
      const turn = await seedTurn(locationId, 'Make my replies warmer.');
      const first = await seedProposal({
        conversationId: turn.conversationId,
        turnId: turn.turnId,
        targetLocationId: locationId,
        tone: 'warm and brief',
      });
      const sibling = await seedProposal({
        conversationId: turn.conversationId,
        turnId: turn.turnId,
        targetLocationId: locationId,
        tone: 'formal',
      });
      // A pending proposal on ANOTHER location, and its own turn. This write
      // does not move that location's `updated_at`, so its token still matches.
      const otherTurn = await seedTurn(secondLocationId, 'And for the cafe.');
      const otherLocation = await seedProposal({
        conversationId: otherTurn.conversationId,
        turnId: otherTurn.turnId,
        targetLocationId: secondLocationId,
        tone: 'playful',
      });
      // An ALREADY-APPLIED proposal on THIS location (RT-03). The sweep's
      // `status = 'pending'` predicate is the only thing keeping it out of the
      // UPDATE, and without that predicate this row would be restamped
      // `stale` / `version_mismatch` — rewriting a terminal outcome, and
      // contradicting the Receipt it still carries.
      const appliedSibling = await seedProposal({
        conversationId: turn.conversationId,
        turnId: turn.turnId,
        targetLocationId: locationId,
        tone: 'brisk',
      });
      await db`
        UPDATE agent_proposals
        SET status = ${PROPOSAL_STATUS.APPLIED}, applied_at = NOW(),
            decided_by_user_id = ${tenant.userId}::uuid
        WHERE id = ${appliedSibling.proposalId}::uuid
          AND account_id = ${tenant.accountId}::uuid
      `;

      const result = await applyProposal(db, {
        proposalId: first.proposalId,
        accountId: tenant.accountId,
        actorUserId: tenant.userId,
        expectedVersionToken: first.token,
      });
      expect(result.kind).toBe('applied');

      const siblingRow = await readProposalForAccount(db, {
        proposalId: sibling.proposalId,
        accountId: tenant.accountId,
      });
      expect(siblingRow!.status).toBe(PROPOSAL_STATUS.STALE);
      expect(siblingRow!.failureReason).toBe(PROPOSAL_FAILURE_REASON.VERSION_MISMATCH);

      const otherRow = await readProposalForAccount(db, {
        proposalId: otherLocation.proposalId,
        accountId: tenant.accountId,
      });
      expect(otherRow!.status).toBe(PROPOSAL_STATUS.PENDING);
      expect(otherRow!.failureReason).toBeNull();

      // The applied one is not swept by its own sweep.
      const appliedRow = await readProposalForAccount(db, {
        proposalId: first.proposalId,
        accountId: tenant.accountId,
      });
      expect(appliedRow!.status).toBe(PROPOSAL_STATUS.APPLIED);

      // …and neither is the sibling that was ALREADY applied on this same
      // location: terminal stays terminal, with no failure reason invented
      // for it (RT-03).
      const priorApplied = await readProposalForAccount(db, {
        proposalId: appliedSibling.proposalId,
        accountId: tenant.accountId,
      });
      expect(priorApplied!.status).toBe(PROPOSAL_STATUS.APPLIED);
      expect(priorApplied!.failureReason).toBeNull();
      expect(priorApplied!.appliedAt).not.toBeNull();
    });

    it('applyProposal rejects a pending proposal whose location was archived after preparation', async () => {
      const toneBefore = await readTone(locationId);
      // RT-04 / RT-08. The `archived_at IS NULL` clause in the businesses lock
      // was pinned only by the SQL TEXT of a unit test; this is the live proof
      // that an archived location refuses the Apply and writes nothing to the
      // voice columns.
      const turn = await seedTurn(locationId, 'Make my replies warmer.');
      const { proposalId, token } = await seedProposal({
        conversationId: turn.conversationId,
        turnId: turn.turnId,
        targetLocationId: locationId,
        tone: 'warm and brief',
      });

      await db`
        UPDATE businesses SET archived_at = NOW()
        WHERE id = ${locationId}::uuid AND account_id = ${tenant.accountId}::uuid
      `;
      try {
        const result = await applyProposal(db, {
          proposalId,
          accountId: tenant.accountId,
          actorUserId: tenant.userId,
          expectedVersionToken: token,
        });

        expect(result).toMatchObject({
          kind: 'rejected',
          reason: PROPOSAL_FAILURE_REASON.LOCATION_NOT_FOUND,
        });
        if (result.kind !== 'rejected') throw new Error('unreachable');
        expect(result.proposal.status).toBe(PROPOSAL_STATUS.REJECTED);
        expect(result.proposal.receipt).toBeNull();
        expect(result.proposal.appliedAt).toBeNull();
      } finally {
        await db`
          UPDATE businesses SET archived_at = NULL
          WHERE id = ${locationId}::uuid AND account_id = ${tenant.accountId}::uuid
        `;
      }

      // NO VOICE WRITE — asserted after the un-archive, so the read is not
      // itself filtered out by the archival it is testing.
      expect(await readTone(locationId)).toBe(toneBefore);
      // The refusal COMMITTED as a terminal state, so the card says why.
      const stored = await readProposalForAccount(db, { proposalId, accountId: tenant.accountId });
      expect(stored!.status).toBe(PROPOSAL_STATUS.REJECTED);
      expect(stored!.failureReason).toBe(PROPOSAL_FAILURE_REASON.LOCATION_NOT_FOUND);
    });

    it('applyProposal receipt after equals the committed voice state and flags a difference from the stored after', async () => {
      const turn = await seedTurn(locationId, 'Make my replies warmer.');
      // The stored preview claims a state that is NOT what this operation
      // writes — a seeded column, or a preview built against a different row.
      const { proposalId, token } = await seedProposal({
        conversationId: turn.conversationId,
        turnId: turn.turnId,
        targetLocationId: locationId,
        tone: 'warm and brief',
        after: {
          tone: 'warm and brief',
          productsServices: 'haircuts and colour',
          avoidFacts: [],
          highlightFacts: [],
          sampleResponses: [],
        },
      });

      const result = await applyProposal(db, {
        proposalId,
        accountId: tenant.accountId,
        actorUserId: tenant.userId,
        expectedVersionToken: token,
      });
      expect(result.kind).toBe('applied');
      if (result.kind !== 'applied') throw new Error('unreachable');

      const receipt = result.proposal.receipt!;
      // The Receipt shows the ACTUAL state (spec §6.5): only `tone` was written,
      // because only `tone` is this operation's own field (D10).
      expect(receipt.after).toEqual({
        tone: 'warm and brief',
        productsServices: null,
        avoidFacts: [],
        highlightFacts: [],
        sampleResponses: [],
      });
      expect(receipt.differsFromPreview).toBe(true);
      // …and the status is still applied. A difference is reported, not refused.
      expect(result.proposal.status).toBe(PROPOSAL_STATUS.APPLIED);
      expect(await readTone(locationId)).toBe('warm and brief');
    });

    it('applyProposal rolls back the receipt when the voice write throws', async () => {
      const toneBefore = await readTone(locationId);
      const turn = await seedTurn(locationId, 'Make my replies warmer.');
      const { proposalId, token } = await seedProposal({
        conversationId: turn.conversationId,
        turnId: turn.turnId,
        targetLocationId: locationId,
        tone: 'warm and brief',
      });

      // THE FAILURE ORIGINATES IN POSTGRES, not in JS: a plain JS throw does not
      // poison a Postgres transaction, so a test built on one proves nothing
      // about the aborted state the real hazard produces
      // (src/lib/shared/__tests__/helpers/abort-injection.ts:15-18). `SELECT 1/0` raises 22012.
      const poisoned = abortingExecutor(db, (tx) => tx`SELECT 1 / 0`);

      await expect(applyProposal(poisoned, {
        proposalId,
        accountId: tenant.accountId,
        actorUserId: tenant.userId,
        expectedVersionToken: token,
      })).rejects.toThrow();

      // NOTHING committed: no Receipt, no status change, no voice write. That
      // is the invariant — there is no committed mutation without a Receipt and
      // no Receipt without a committed mutation.
      const row = await readProposalForAccount(db, { proposalId, accountId: tenant.accountId });
      expect(row!.status).toBe(PROPOSAL_STATUS.PENDING);
      expect(row!.receipt).toBeNull();
      expect(row!.appliedAt).toBeNull();
      expect(await readTone(locationId)).toBe(toneBefore);

      // And a retry finds it still applicable (intake edge case).
      const retry = await applyProposal(db, {
        proposalId,
        accountId: tenant.accountId,
        actorUserId: tenant.userId,
        expectedVersionToken: token,
      });
      expect(retry.kind).toBe('applied');
    });

    it('two concurrent applies on one proposal produce one voice write and both return the same receipt', async () => {
      const turn = await seedTurn(locationId, 'Make my replies warmer.');
      const { proposalId, token } = await seedProposal({
        conversationId: turn.conversationId,
        turnId: turn.turnId,
        targetLocationId: locationId,
        tone: 'warm and brief',
      });

      const call = () => applyProposal(db, {
        proposalId,
        accountId: tenant.accountId,
        actorUserId: tenant.userId,
        expectedVersionToken: token,
      });
      // Two independent connections from the same pool. Both queue on the
      // `businesses` row lock; the loser finds the row `applied` and returns
      // the winner's stored Receipt without executing.
      const [a, b] = await Promise.all([call(), call()]);

      expect(a.kind).toBe('applied');
      expect(b.kind).toBe('applied');
      if (a.kind !== 'applied' || b.kind !== 'applied') throw new Error('unreachable');
      expect([a.repeated, b.repeated].sort()).toEqual([false, true]);
      // ONE Receipt, byte for byte, whichever call won.
      expect(a.proposal.receipt).toEqual(b.proposal.receipt);
      expect(a.proposal.receipt).not.toBeNull();
      if (a.proposal.receipt?.affects !== 'future_drafts') throw new Error('expected a voice receipt');

      // ONE voice write: the second Apply did not re-stamp `updated_at`.
      expect(await currentUpdatedAt(locationId))
        .toBe(a.proposal.receipt!.versionToken.after.updatedAt);
      expect(await readTone(locationId)).toBe('warm and brief');
    });

    it('worker-produced proposals render and apply successfully', async () => {
      // THE FIXTURE IS THE PRODUCTION PATH, and that is the whole case.
      // `AgentTurnWorker` builds a Proposal from `readVoiceConfig`'s result
      // (`worker/jobs/agent-turn/AgentTurnWorker.ts:211-214`), whose type is
      // `VoiceConfig & { updatedAt }`; `preview` returns that object as
      // `before` and spreads it into `after`
      // (`src/lib/agents/operator/catalog.ts:96-98`); `buildProposalRows`
      // stores both (`src/lib/agents/operator/proposals.ts:77-78`). Every real
      // row therefore carries SIX keys, and a hand-typed five-key fixture
      // cannot see a parser that rejects them.
      const turn = await seedTurn(locationId, 'Make my replies warmer.');
      const voice = await readVoiceConfig(db, { accountId: tenant.accountId, locationId });
      if (!voice) throw new Error('fixture voice row missing');
      expect(voice).toHaveProperty('updatedAt');

      const operation = proposableOperation('set_tone');
      if (!operation) throw new Error('set_tone left the catalog');
      const parsed = operation.parseInput({ tone: 'warm and brief' });
      if (!parsed.ok) throw new Error('set_tone rejected its own input');

      const rows = buildProposalRows(
        {
          conversationId: turn.conversationId,
          turnId: turn.turnId,
          accountId: tenant.accountId,
          actorUserId: tenant.userId,
          locationId,
        },
        [{ operation, input: parsed.input, scope: { accountId: tenant.accountId, locationId }, rationale: 'You asked for warmer replies.' }],
        voice,
      );
      await db.begin(async (tx) => { await insertProposals(tx, rows); });

      const proposalId = rows[0]!.id;
      // The stored preview really does carry the extra key.
      expect(Object.keys(rows[0]!.before)).toContain('updatedAt');

      // READ IT BACK through the production mapper: `mapStored` →
      // `parseVoiceState` is what the card calls, and it must not throw.
      const view = await readProposalForAccount(db, { proposalId, accountId: tenant.accountId });
      expect(view).not.toBeNull();
      expect(() => parseVoiceState(view!.before, 'agent_proposals.before')).not.toThrow();
      expect(parseVoiceState(view!.after, 'agent_proposals.after')).not.toHaveProperty('updatedAt');

      const result = await applyProposal(db, {
        proposalId,
        accountId: tenant.accountId,
        actorUserId: tenant.userId,
        expectedVersionToken: { businessId: locationId, updatedAt: voice.updatedAt },
      });

      expect(result.kind).toBe('applied');
      if (result.kind !== 'applied') throw new Error('unreachable');
      // The Receipt's five-field state, with the stored `updatedAt` DROPPED —
      // it is recorded once, under `versionToken.before`, and nowhere else.
      expect(result.proposal.receipt!.before).not.toHaveProperty('updatedAt');
      // …and `before` IS the before the card showed, not a second copy of the
      // after that committed: the stored preview, read through the same
      // production mapper the card calls, byte for byte.
      expect(result.proposal.receipt!.before)
        .toEqual(parseVoiceState(view!.before, 'agent_proposals.before'));
      expect(result.proposal.receipt!.after).not.toHaveProperty('updatedAt');
      if (result.proposal.receipt?.affects !== 'future_drafts') throw new Error('expected a voice receipt');
      expect(result.proposal.receipt!.versionToken.before.updatedAt).toBe(voice.updatedAt);
      expect(await readTone(locationId)).toBe('warm and brief');
    });

    it('repeat Apply after location archival returns the original receipt without writes', async () => {
      const turn = await seedTurn(locationId, 'Make my replies warmer.');
      const { proposalId, token } = await seedProposal({
        conversationId: turn.conversationId,
        turnId: turn.turnId,
        targetLocationId: locationId,
        tone: 'warm and brief',
      });

      const first = await applyProposal(db, {
        proposalId,
        accountId: tenant.accountId,
        actorUserId: tenant.userId,
        expectedVersionToken: token,
      });
      expect(first.kind).toBe('applied');
      if (first.kind !== 'applied') throw new Error('unreachable');

      // The owner archives the location afterwards. This is a supported
      // action, and migration 120 keeps the Proposal and its Receipt.
      await db`
        UPDATE businesses SET archived_at = NOW()
        WHERE id = ${locationId}::uuid AND account_id = ${tenant.accountId}::uuid
      `;

      try {
        const repeat = await applyProposal(db, {
          proposalId,
          accountId: tenant.accountId,
          actorUserId: tenant.userId,
          expectedVersionToken: token,
        });

        // THE STORED RECEIPT, not a 409 `location_not_found`. The business
        // lock finds nothing, but the proposal's status is read first, so the
        // owner keeps the record of what did happen (RB-10).
        expect(repeat).toMatchObject({ kind: 'applied', repeated: true });
        if (repeat.kind !== 'applied') throw new Error('unreachable');
        expect(repeat.proposal.receipt).toEqual(first.proposal.receipt);
        expect(repeat.proposal.status).toBe(PROPOSAL_STATUS.APPLIED);
        expect(repeat.proposal.failureReason).toBeNull();

        // A NON-APPLIED terminal status under the same condition answers
        // `not_pending`, not `location_not_found`.
        const second = await seedProposalOnArchived({
          conversationId: turn.conversationId,
          turnId: turn.turnId,
          targetLocationId: locationId,
          status: PROPOSAL_STATUS.SUPERSEDED,
        });
        const superseded = await applyProposal(db, {
          proposalId: second,
          accountId: tenant.accountId,
          actorUserId: tenant.userId,
          expectedVersionToken: token,
        });
        expect(superseded).toMatchObject({ kind: 'not_pending', status: PROPOSAL_STATUS.SUPERSEDED });
      } finally {
        await db`
          UPDATE businesses SET archived_at = NULL
          WHERE id = ${locationId}::uuid AND account_id = ${tenant.accountId}::uuid
        `;
      }
    });
  },
);
