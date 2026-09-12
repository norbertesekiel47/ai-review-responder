// Live-DB proofs for the OWNER READS (`src/lib/agents/operator/reads.ts`) and
// for `createTurn`'s conversation-ownership re-read.
//
// Nothing is mocked: these are account-scoped SELECTs, and the only thing worth
// proving about them is what the real database returns for a caller who is not
// the owner. A mocked `sql` would answer whatever the double was told to.
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
import { getConversationForOwner, getTurnForOwner, TRANSCRIPT_TURN_LIMIT } from '../reads';
import { TURN_STATUS } from '../schema';
import { createTurn, type CreateTurnResult } from '../turns';

const testDatabaseUrl = resolveTestDatabaseUrl();
let db: postgres.Sql;
let lock: LiveDbLock | undefined;

/** Account A, its owner, and its location. */
let tenant: TenantSeed;
let locationId: string;
/** A SECOND owner user inside account A — the `created_by_user_id` scope. */
let secondUserId: string;
/** Account B: a whole other tenant, for the cross-account cases. */
let other: TenantSeed;
let otherLocationId: string;

function createdOrThrow(result: CreateTurnResult): { conversationId: string; turnId: string } {
  if (result.kind !== 'created') throw new Error(`expected a created turn, got ${result.kind}`);
  return { conversationId: result.conversationId, turnId: result.turnId };
}

function baseTurnInput(overrides: Partial<Parameters<typeof createTurn>[1]> = {}) {
  return {
    accountId: tenant.accountId,
    actorUserId: tenant.userId,
    conversationId: randomUUID(),
    clientTurnKey: randomUUID(),
    locationId,
    text: 'Make my replies warmer.',
    ...overrides,
  };
}

/** Marks a turn completed with a stored reply, without running the worker. */
async function completeTurn(turnId: string, accountId: string, text: string): Promise<void> {
  await db`
    UPDATE agent_turns
    SET status = ${TURN_STATUS.COMPLETED},
        reply = ${db.json([{ type: 'text', text }] as never)},
        completed_at = NOW()
    WHERE id = ${turnId}::uuid AND account_id = ${accountId}::uuid
  `;
}

async function deleteOperatorRows(accountId: string): Promise<void> {
  await db`DELETE FROM agent_unsupported_requests WHERE account_id = ${accountId}::uuid`;
  await db`DELETE FROM agent_proposals WHERE account_id = ${accountId}::uuid`;
  await db`DELETE FROM agent_turns WHERE account_id = ${accountId}::uuid`;
  await db`DELETE FROM agent_conversations WHERE account_id = ${accountId}::uuid`;
}

describeWithDb(
  'operator owner reads (live DB)',
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
        userName: 'Operator Reads Owner',
        accountDisplayName: 'Operator Reads Account',
      });
      locationId = (await seedLocation(db, tenant.accountId, { name: 'Salon' })).businessId;
      // A SECOND owner in the SAME account. The no-id conversation read is
      // scoped by `created_by_user_id`, so two owners of one account must not
      // land in each other's transcript.
      secondUserId = randomUUID();
      await db`
        INSERT INTO users (id, name, email, role, account_id)
        VALUES (${secondUserId}::uuid, 'Second Owner',
                ${`second-${secondUserId}@test.local`}, 'owner', ${tenant.accountId}::uuid)
      `;

      other = await seedTenantAccount(db, {
        userName: 'Neighbour Owner',
        accountDisplayName: 'Neighbour Account',
      });
      otherLocationId = (await seedLocation(db, other.accountId, { name: 'Neighbour' })).businessId;
      process.env.OWNER_OPERATOR_ENABLED = 'true';
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    afterEach(async () => {
      await deleteOperatorRows(tenant.accountId);
      await deleteOperatorRows(other.accountId);
      await db`DELETE FROM job_outbox WHERE topic = 'agent_turn'`;
    }, 60_000);

    afterAll(async () => {
      try {
        if (db) {
          await db`DELETE FROM businesses WHERE account_id = ${tenant.accountId}::uuid`;
          await db`DELETE FROM businesses WHERE account_id = ${other.accountId}::uuid`;
          await db`DELETE FROM users WHERE id = ${secondUserId}::uuid`;
          await cleanupTenantAccount(db, tenant);
          await cleanupTenantAccount(db, other);
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

    it('getTurnForOwner returns null for a turn id that belongs to another account', async () => {
      const mine = createdOrThrow(await createTurn(db, baseTurnInput()));
      const theirs = createdOrThrow(await createTurn(db, {
        accountId: other.accountId,
        actorUserId: other.userId,
        conversationId: randomUUID(),
        clientTurnKey: randomUUID(),
        locationId: otherLocationId,
        text: 'Neighbour message.',
      }));

      // The other account's REAL turn id, read with MY account id: null, which
      // the route renders as the same 404 a nonexistent id gets. That
      // indistinguishability is the point — a different answer would turn this
      // read into an oracle for other tenants' ids.
      expect(await getTurnForOwner(db, { turnId: theirs.turnId, accountId: tenant.accountId }))
        .toBeNull();
      // And symmetrically, so the guard is the predicate and not the fixture.
      expect(await getTurnForOwner(db, { turnId: mine.turnId, accountId: other.accountId }))
        .toBeNull();
      // A nonexistent id is the same null.
      expect(await getTurnForOwner(db, { turnId: randomUUID(), accountId: tenant.accountId }))
        .toBeNull();

      // The owner's own read works, so the null above is scope and not breakage.
      const own = await getTurnForOwner(db, { turnId: mine.turnId, accountId: tenant.accountId });
      expect(own).not.toBeNull();
      expect(own!.id).toBe(mine.turnId);
      expect(own!.status).toBe(TURN_STATUS.ACCEPTED);
      expect(own!.locationId).toBe(locationId);
    });

    it('createTurn refuses a conversation id that already exists under another account and writes no turn', async () => {
      // The conversation id is CLIENT-MINTED (migration 120), so a caller can
      // present one that already exists elsewhere. The upsert's `ON CONFLICT
      // (id) DO NOTHING` silently loses to the foreign row; the account-scoped
      // re-read under the lock is what turns that into a 404 instead of handing
      // one account another's transcript.
      const theirs = createdOrThrow(await createTurn(db, {
        accountId: other.accountId,
        actorUserId: other.userId,
        conversationId: randomUUID(),
        clientTurnKey: randomUUID(),
        locationId: otherLocationId,
        text: 'Neighbour message.',
      }));

      const result = await createTurn(db, baseTurnInput({
        conversationId: theirs.conversationId,
      }));
      expect(result.kind).toBe('conversation_not_found');

      // NOTHING was written on my side: no turn, no outbox row — and the
      // foreign conversation still belongs to the other account.
      const mine = await db<{ id: string }[]>`
        SELECT id FROM agent_turns WHERE account_id = ${tenant.accountId}::uuid
      `;
      expect(mine).toHaveLength(0);
      const [conversation] = await db<{ account_id: string }[]>`
        SELECT account_id FROM agent_conversations WHERE id = ${theirs.conversationId}::uuid
      `;
      expect(conversation!.account_id).toBe(other.accountId);
      const theirTurns = await db<{ id: string }[]>`
        SELECT id FROM agent_turns
        WHERE conversation_id = ${theirs.conversationId}::uuid
      `;
      expect(theirTurns).toHaveLength(1);
      expect(theirTurns[0]!.id).toBe(theirs.turnId);
    });

    it('getConversationForOwner scopes the most-recent read to the actor and honours an explicit id', async () => {
      const mine = createdOrThrow(await createTurn(db, baseTurnInput()));
      await completeTurn(mine.turnId, tenant.accountId, 'Mine.');
      const sibling = createdOrThrow(await createTurn(db, baseTurnInput({
        actorUserId: secondUserId, text: 'The other owner speaking.',
      })));
      await completeTurn(sibling.turnId, tenant.accountId, 'Theirs.');

      // No `?id`: each owner gets their OWN most recent conversation, even
      // though both are in the same account and the sibling's is newer.
      const forFirst = await getConversationForOwner(db, {
        accountId: tenant.accountId, actorUserId: tenant.userId,
      });
      expect(forFirst!.conversation.id).toBe(mine.conversationId);
      expect(forFirst!.turns.map((t) => t.id)).toEqual([mine.turnId]);

      const forSecond = await getConversationForOwner(db, {
        accountId: tenant.accountId, actorUserId: secondUserId,
      });
      expect(forSecond!.conversation.id).toBe(sibling.conversationId);

      // An EXPLICIT id is account-scoped, not actor-scoped: one owner may open
      // a colleague's conversation by id, and neither may open another
      // account's.
      const explicit = await getConversationForOwner(db, {
        accountId: tenant.accountId,
        actorUserId: tenant.userId,
        conversationId: sibling.conversationId,
      });
      expect(explicit!.conversation.id).toBe(sibling.conversationId);

      const theirs = createdOrThrow(await createTurn(db, {
        accountId: other.accountId,
        actorUserId: other.userId,
        conversationId: randomUUID(),
        clientTurnKey: randomUUID(),
        locationId: otherLocationId,
        text: 'Neighbour message.',
      }));
      expect(await getConversationForOwner(db, {
        accountId: tenant.accountId,
        actorUserId: tenant.userId,
        conversationId: theirs.conversationId,
      })).toBeNull();

      // The summary is a real panel once a turn exists, scoped to that turn's
      // location.
      expect(forFirst!.summary).not.toBeNull();
      expect(forFirst!.summary!.recent.reportingPeriodDays).toBe(7);
      expect(forFirst!.summary!.rules.vetoWindowMinutes).toBeGreaterThan(0);
    });

    it('getConversationForOwner returns a null summary for a conversation with no turns', async () => {
      // A conversation row with no turn: nothing to scope a location-shaped
      // read to. The panel is OMITTED rather than zeroed — an all-zeros summary
      // with a fresh `asOf` does not read as "nothing to report", it reads as
      // "just measured, and the answer is zero", which for an account with
      // drafts waiting is a lie the timestamp vouches for.
      const conversationId = randomUUID();
      await db`
        INSERT INTO agent_conversations (id, account_id, created_by_user_id)
        VALUES (${conversationId}::uuid, ${tenant.accountId}::uuid, ${tenant.userId}::uuid)
      `;

      const view = await getConversationForOwner(db, {
        accountId: tenant.accountId,
        actorUserId: tenant.userId,
        conversationId,
      });
      expect(view).not.toBeNull();
      expect(view!.turns).toEqual([]);
      expect(view!.summary).toBeNull();
    });

    it('getConversationForOwner bounds the transcript to the most recent turns', async () => {
      const conversationId = randomUUID();
      const total = TRANSCRIPT_TURN_LIMIT + 5;
      for (let i = 1; i <= total; i += 1) {
        const created = createdOrThrow(await createTurn(db, baseTurnInput({
          conversationId, text: `Message ${i}.`,
        })));
        await completeTurn(created.turnId, tenant.accountId, `Reply ${i}.`);
      }

      const view = await getConversationForOwner(db, {
        accountId: tenant.accountId,
        actorUserId: tenant.userId,
        conversationId,
      });

      // Bounded, MOST RECENT, and still chronological: an unbounded read gets
      // slower for the rest of the conversation's life, and a bound taken from
      // the wrong end would show the owner the start of a conversation they are
      // in the middle of.
      expect(view!.turns).toHaveLength(TRANSCRIPT_TURN_LIMIT);
      expect(view!.turns[0]!.sequence).toBe(total - TRANSCRIPT_TURN_LIMIT + 1);
      expect(view!.turns[view!.turns.length - 1]!.sequence).toBe(total);
      expect(view!.turns[view!.turns.length - 1]!.ownerText).toBe(`Message ${total}.`);
      const sequences = view!.turns.map((t) => t.sequence);
      expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);
    });
  },
);
