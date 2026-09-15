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
import { DEFAULT_DAILY_AUTO_POST_CAP, DEFAULT_VETO_WINDOW_MINUTES } from '@/lib/auto-approval/policy';
import { POLICY_ACTION_POSTING, POLICY_PERSONA_REPLY } from '@/lib/auto-approval/types';
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
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import {
  cleanupTenantAccount,
  seedLocation,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import { RECENT_COMPLETED_DAYS } from '../context';
import { insertProposals, type ProposalRow } from '../proposals';
import {
  getConversationForOwner,
  getTurnForOwner,
  readSummaryEntitlement,
  TRANSCRIPT_TURN_LIMIT,
  type OwnerConversationResult,
  type OwnerConversationView,
} from '../reads';
import { asConnectionStatus, PROPOSAL_STATUS, TURN_STATUS } from '../schema';
import { createTurn, type CreateTurnResult } from '../turns';

const testDatabaseUrl = resolveTestDatabaseUrl();
let db: postgres.Sql;
let lock: LiveDbLock | undefined;

/** Account A, its owner, and its location. */
let tenant: TenantSeed;
let locationId: string;
/**
 * A SECOND location in account A. The summary panel's `locationOverrideExists`
 * is a per-location fact, so proving it needs one location WITH an
 * `auto_approval_policies` override row and one WITHOUT.
 */
let secondLocationId: string;
/** A SECOND owner user inside account A — the `created_by_user_id` scope. */
let secondUserId: string;
/** Account B: a whole other tenant, for the cross-account cases. */
let other: TenantSeed;
let otherLocationId: string;

function createdOrThrow(result: CreateTurnResult): { conversationId: string; turnId: string } {
  if (result.kind !== 'created') throw new Error(`expected a created turn, got ${result.kind}`);
  return { conversationId: result.conversationId, turnId: result.turnId };
}

/**
 * `getConversationForOwner` answers a RESULT KIND in Run B (S7): `view`,
 * `not_found`, or `location_not_found` for a `?locationId=` that is not an
 * active location of the account. These cases assert on a view, so the
 * narrowing is an assertion — any other kind is a real failure and reads as one.
 */
function viewOrThrow(result: OwnerConversationResult): OwnerConversationView {
  expect(result.kind).toBe('view');
  if (result.kind !== 'view') throw new Error(`expected a view, got ${result.kind}`);
  return result.view;
}

/**
 * `OwnerConversationView.conversation` became nullable in Run B: a first-time
 * owner with no conversation row gets `{ conversation: null, … }` rather than
 * a 404 (RB-09). These cases all assert on a conversation that EXISTS, so the
 * narrowing is an assertion, not a cast — a null here is a real failure and
 * should read as one.
 */
function conversationOrThrow(view: OwnerConversationView): { id: string; lastTurnAt: string | null } {
  expect(view.conversation).not.toBeNull();
  return view.conversation!;
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

/**
 * One stored **Proposal** for a turn, written through the production writer.
 *
 * ONE ROW PER TRANSACTION, deliberately: `created_at` defaults to `NOW()`,
 * which is the TRANSACTION's start time, so a batch written inside one `begin`
 * shares a timestamp and the read's `ORDER BY created_at ASC` would be free to
 * return them in either order. Separate transactions give the read a real
 * ordering to be asserted against.
 */
async function seedProposal(
  input: {
    conversationId: string;
    turnId: string;
    accountId: string;
    actorUserId: string;
    /**
     * NOT nullable, and the **Version token** below is why: a voice Proposal
     * always names a location (P8), and `ProposalRow.preparedVersionToken` is
     * a `VoiceVersionToken` whose `businessId` the reader validates as a uuid.
     */
    locationId: string;
    operation: string;
    inputJson: Record<string, unknown>;
    rationale: string;
  },
): Promise<string> {
  const row: ProposalRow = {
    id: randomUUID(),
    conversationId: input.conversationId,
    turnId: input.turnId,
    accountId: input.accountId,
    actorUserId: input.actorUserId,
    locationId: input.locationId,
    operation: input.operation,
    contractVersion: 1,
    input: input.inputJson,
    before: { tone: null },
    after: { tone: null },
    rationale: input.rationale,
    labelKind: 'fact',
    preparedVersionToken: { businessId: input.locationId, updatedAt: '2026-09-11 10:00:00.123456+00' },
    requiresConfirmation: false,
    status: PROPOSAL_STATUS.PENDING,
  };
  await db.begin(async (tx) => { await insertProposals(tx, [row]); });
  return row.id;
}

/** Completes a turn whose stored reply NAMES the proposals seeded for it. */
async function completeTurnWithProposals(
  turnId: string,
  accountId: string,
  text: string,
  proposalIds: readonly string[],
): Promise<void> {
  const segments = [
    { type: 'text', text },
    ...proposalIds.map((proposalId) => ({ type: 'proposal', proposalId })),
  ];
  await db`
    UPDATE agent_turns
    SET status = ${TURN_STATUS.COMPLETED},
        reply = ${db.json(segments as never)},
        completed_at = NOW()
    WHERE id = ${turnId}::uuid AND account_id = ${accountId}::uuid
  `;
}

/** A location-scoped Reply/posting override row — the `locationOverrideExists` fact. */
async function seedLocationOverride(
  accountId: string,
  overrideLocationId: string,
  values: { minStar: number; vetoWindowMinutes: number; dailyCap: number },
): Promise<void> {
  await db`
    INSERT INTO auto_approval_policies (
      id, account_id, location_id, persona, action_class,
      auto_approve_min_star, veto_window_minutes, daily_auto_post_cap
    ) VALUES (
      ${randomUUID()}::uuid, ${accountId}::uuid, ${overrideLocationId}::uuid,
      ${POLICY_PERSONA_REPLY}, ${POLICY_ACTION_POSTING},
      ${values.minStar}, ${values.vetoWindowMinutes}, ${values.dailyCap}
    )
  `;
}

async function deleteOperatorRows(accountId: string): Promise<void> {
  await db`DELETE FROM agent_unsupported_requests WHERE account_id = ${accountId}::uuid`;
  await db`DELETE FROM agent_proposals WHERE account_id = ${accountId}::uuid`;
  await db`DELETE FROM agent_turns WHERE account_id = ${accountId}::uuid`;
  await db`DELETE FROM agent_conversations WHERE account_id = ${accountId}::uuid`;
  await db`DELETE FROM auto_approval_policies WHERE account_id = ${accountId}::uuid`;
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
      secondLocationId = (await seedLocation(db, tenant.accountId, {
        name: 'Cafe', isPrimary: false,
      })).businessId;
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
      const forFirst = viewOrThrow(await getConversationForOwner(db, {
        accountId: tenant.accountId, actorUserId: tenant.userId,
      }));
      expect(conversationOrThrow(forFirst).id).toBe(mine.conversationId);
      expect(forFirst.turns.map((t) => t.id)).toEqual([mine.turnId]);

      const forSecond = viewOrThrow(await getConversationForOwner(db, {
        accountId: tenant.accountId, actorUserId: secondUserId,
      }));
      expect(conversationOrThrow(forSecond).id).toBe(sibling.conversationId);

      // An EXPLICIT id is account-scoped, not actor-scoped: one owner may open
      // a colleague's conversation by id, and neither may open another
      // account's.
      const explicit = viewOrThrow(await getConversationForOwner(db, {
        accountId: tenant.accountId,
        actorUserId: tenant.userId,
        conversationId: sibling.conversationId,
      }));
      expect(conversationOrThrow(explicit).id).toBe(sibling.conversationId);

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
      })).toEqual({ kind: 'not_found' });

      // The summary is a real panel once a turn exists, scoped to that turn's
      // location — and it SAYS which location, so the panel does not have to
      // guess from the browser's selector (C3).
      expect(forFirst.summary).not.toBeNull();
      expect(forFirst.summary!.locationId).toBe(locationId);
      expect(forFirst.summary!.recent.reportingPeriodDays).toBe(7);
      // EQUALITY against the inherited default, not `> 0`: a range-shaped proxy
      // passes for every value the projection could possibly produce, including
      // the account default read where the location's own row was meant to win.
      expect(forFirst.summary!.rules.vetoWindowMinutes).toBe(DEFAULT_VETO_WINDOW_MINUTES);
      expect(forFirst.summary!.rules.dailyCap).toBe(DEFAULT_DAILY_AUTO_POST_CAP);
      expect(forFirst.summary!.rules.threshold).toBeNull();
    });

    it('getConversationForOwner reports the location override and its dials, per location', async () => {
      // ONE location of the two has its own Reply/posting row. The panel is
      // scoped to the MOST RECENT turn's location, so the same account answers
      // differently depending on which location the owner is looking at — which
      // is the whole fact `locationOverrideExists` carries (spec §4: a dial-only
      // change on a location with no row CREATES one, and the card must say so).
      await seedLocationOverride(tenant.accountId, secondLocationId, {
        minStar: 5, vetoWindowMinutes: 30, dailyCap: 7,
      });

      const overridden = createdOrThrow(await createTurn(db, baseTurnInput({
        locationId: secondLocationId, text: 'How does the Cafe post?',
      })));
      await completeTurn(overridden.turnId, tenant.accountId, 'Here are the Cafe rules.');
      const withOverride = viewOrThrow(await getConversationForOwner(db, {
        accountId: tenant.accountId,
        actorUserId: tenant.userId,
        conversationId: overridden.conversationId,
      }));
      expect(withOverride.summary!.rules.locationOverrideExists).toBe(true);
      // The panel's own scope follows the latest turn, not the primary location.
      expect(withOverride.summary!.locationId).toBe(secondLocationId);
      // The location's OWN dials, read from the seeded row — not the account
      // default, and not a range.
      expect(withOverride.summary!.rules.vetoWindowMinutes).toBe(30);
      expect(withOverride.summary!.rules.dailyCap).toBe(7);
      expect(withOverride.summary!.rules.threshold).toBe(5);

      // The OTHER location of the SAME account has no row: false, and every dial
      // inherited from the account default.
      const plain = createdOrThrow(await createTurn(db, baseTurnInput({
        text: 'And the Salon?',
      })));
      await completeTurn(plain.turnId, tenant.accountId, 'Here are the Salon rules.');
      const withoutOverride = viewOrThrow(await getConversationForOwner(db, {
        accountId: tenant.accountId,
        actorUserId: tenant.userId,
        conversationId: plain.conversationId,
      }));
      expect(withoutOverride.summary!.rules.locationOverrideExists).toBe(false);
      expect(withoutOverride.summary!.locationId).toBe(locationId);
      expect(withoutOverride.summary!.rules.vetoWindowMinutes).toBe(DEFAULT_VETO_WINDOW_MINUTES);
      expect(withoutOverride.summary!.rules.dailyCap).toBe(DEFAULT_DAILY_AUTO_POST_CAP);
      expect(withoutOverride.summary!.rules.threshold).toBeNull();
    });

    it('getConversationForOwner carries each turn its own stored proposals, and none of another account\'s', async () => {
      // A stored `proposal` segment carries only an ID, so the CARDS it names
      // have to travel with the transcript. Three turns: two with proposals and
      // one without, so an always-empty batched read, a read keyed by the wrong
      // turn, and a read that drops its account predicate all fail here.
      const conversationId = randomUUID();
      const first = createdOrThrow(await createTurn(db, baseTurnInput({
        conversationId, text: 'Warmer, and stop mentioning parking.',
      })));
      const toneId = await seedProposal({
        conversationId, turnId: first.turnId, accountId: tenant.accountId,
        actorUserId: tenant.userId, locationId,
        operation: 'set_tone', inputJson: { tone: 'warm and brief' },
        rationale: 'You asked for shorter replies.',
      });
      const avoidId = await seedProposal({
        conversationId, turnId: first.turnId, accountId: tenant.accountId,
        actorUserId: tenant.userId, locationId,
        operation: 'set_avoid_facts', inputJson: { avoidFacts: ['parking', 'wait times'] },
        rationale: 'You asked to keep parking out of replies.',
      });
      await completeTurnWithProposals(
        first.turnId, tenant.accountId, 'Two cards below.', [toneId, avoidId],
      );
      // Superseded AFTER insertion: `insertProposals` writes `pending` for
      // every row, so a status read back as anything else can only have come
      // from the stored column — not from a constant in the mapper.
      await db`
        UPDATE agent_proposals SET status = ${PROPOSAL_STATUS.SUPERSEDED}
        WHERE id = ${avoidId}::uuid AND account_id = ${tenant.accountId}::uuid
      `;

      const second = createdOrThrow(await createTurn(db, baseTurnInput({
        conversationId, text: 'Mention the espresso.',
      })));
      const highlightId = await seedProposal({
        conversationId, turnId: second.turnId, accountId: tenant.accountId,
        actorUserId: tenant.userId, locationId,
        operation: 'set_highlight_facts', inputJson: { highlightFacts: ['award-winning espresso'] },
        rationale: 'You asked to mention the espresso.',
      });
      await completeTurnWithProposals(
        second.turnId, tenant.accountId, 'One card below.', [highlightId],
      );

      const third = createdOrThrow(await createTurn(db, baseTurnInput({
        conversationId, text: 'How many are waiting?',
      })));
      await completeTurn(third.turnId, tenant.accountId, 'Nothing to propose.');

      // A row that names MY turn but carries ANOTHER account's id. The FK graph
      // permits it (there is no composite (turn_id, account_id) key), which is
      // exactly why the batched read carries its own `account_id` predicate —
      // without it this row lands in my transcript.
      await seedProposal({
        conversationId, turnId: first.turnId, accountId: other.accountId,
        actorUserId: other.userId, locationId: otherLocationId,
        operation: 'set_tone', inputJson: { tone: 'not mine' },
        rationale: 'Another tenant entirely.',
      });

      const view = viewOrThrow(await getConversationForOwner(db, {
        accountId: tenant.accountId,
        actorUserId: tenant.userId,
        conversationId,
      }));
      const [turnOne, turnTwo, turnThree] = view.turns;

      // Keyed BY TURN, in the read's own order, by id / operation / status.
      expect(turnOne!.proposals.map((p) => ({ id: p.id, operation: p.operation, status: p.status })))
        .toEqual([
          { id: toneId, operation: 'set_tone', status: PROPOSAL_STATUS.PENDING },
          { id: avoidId, operation: 'set_avoid_facts', status: PROPOSAL_STATUS.SUPERSEDED },
        ]);
      expect(turnTwo!.proposals.map((p) => ({ id: p.id, operation: p.operation, status: p.status })))
        .toEqual([
          { id: highlightId, operation: 'set_highlight_facts', status: PROPOSAL_STATUS.PENDING },
        ]);
      // A turn that proposed nothing gets an empty list, NOT the previous turn's.
      expect(turnThree!.proposals).toEqual([]);

      // The card's words come from the CATALOG at read time, keyed by the
      // stored operation — never from a stored string.
      expect(turnOne!.proposals[0]!.describe).toBe('Set the reply tone to "warm and brief"');
      expect(turnOne!.proposals[1]!.describe).toBe('Keep 2 thing(s) out of every reply');
      expect(turnTwo!.proposals[0]!.describe).toBe('Highlight 1 thing(s) when a reply fits');

      // The foreign row reached NEITHER the transcript nor the pending panel.
      expect(JSON.stringify(view.turns)).not.toContain('not mine');
      expect(view.summary!.pendingProposals.map((p) => p.id))
        .toEqual([toneId, highlightId]);

      // And the stored segments still name exactly the ids the cards carry, so
      // the transcript can pair a sentence with its card.
      const named = turnOne!.segments
        .filter((segment): segment is { type: 'proposal'; proposalId: string } =>
          segment.type === 'proposal')
        .map((segment) => segment.proposalId);
      expect(named).toEqual([toneId, avoidId]);
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

      const view = viewOrThrow(await getConversationForOwner(db, {
        accountId: tenant.accountId,
        actorUserId: tenant.userId,
        conversationId,
      }));
      expect(view.turns).toEqual([]);
      expect(view.summary).toBeNull();
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

      const view = viewOrThrow(await getConversationForOwner(db, {
        accountId: tenant.accountId,
        actorUserId: tenant.userId,
        conversationId,
      }));

      // Bounded, MOST RECENT, and still chronological: an unbounded read gets
      // slower for the rest of the conversation's life, and a bound taken from
      // the wrong end would show the owner the start of a conversation they are
      // in the middle of.
      expect(view.turns).toHaveLength(TRANSCRIPT_TURN_LIMIT);
      expect(view.turns[0]!.sequence).toBe(total - TRANSCRIPT_TURN_LIMIT + 1);
      expect(view.turns[view.turns.length - 1]!.sequence).toBe(total);
      expect(view.turns[view.turns.length - 1]!.ownerText).toBe(`Message ${total}.`);
      const sequences = view.turns.map((t) => t.sequence);
      expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);
    });

    it('first-time owner receives a scoped summary and connection CTA before sending', async () => {
      // NO conversation row exists — the normal state before the owner's first
      // message, because `createTurn` creates the conversation together with
      // the first turn and nothing creates an empty one.
      const [conversations] = await db<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM agent_conversations
        WHERE account_id = ${tenant.accountId}::uuid
      `;
      expect(conversations!.count).toBe(0);

      const view = viewOrThrow(await getConversationForOwner(db, {
        accountId: tenant.accountId,
        actorUserId: tenant.userId,
        locationId,
      }));

      // 200-shaped, not a 404: the route renders this as a 200 with an empty
      // transcript, which is what puts the panel on screen before the owner
      // has said anything.
      expect(view.conversation).toBeNull();
      expect(view.turns).toEqual([]);
      expect(view.summary).not.toBeNull();

      const summary = view.summary!;
      // The summary is scoped to the location the BROWSER selected, not to a
      // turn that does not exist — and it names it (C3).
      expect(summary.locationId).toBe(locationId);
      expect(summary.facts).not.toBeNull();
      expect(summary.recent.reportingPeriodDays).toBe(RECENT_COMPLETED_DAYS);
      expect(typeof summary.asOf).toBe('string');
      // A location that has never been connected reports `null`, and the panel
      // shows the connect call to action for anything that is not `active`.
      expect(summary.connectionStatus).toBeNull();
      // No conversation means no pending proposals, and no query for them.
      expect(summary.pendingProposals).toEqual([]);

      // A location that is NOT this account's answers `location_not_found`,
      // which the route renders as its own 404 — the empty view is not a way
      // to probe for another tenant's ids.
      const foreign = await getConversationForOwner(db, {
        accountId: tenant.accountId,
        actorUserId: tenant.userId,
        locationId: otherLocationId,
      });
      expect(foreign).toEqual({ kind: 'location_not_found' });

      // And WITHOUT a location there is nothing to scope to: `not_found`, the
      // 404 Run A already answered.
      const bare = await getConversationForOwner(db, {
        accountId: tenant.accountId,
        actorUserId: tenant.userId,
      });
      expect(bare).toEqual({ kind: 'not_found' });
    });

    it('an unusable ?locationId= answers location_not_found in both branches', async () => {
      // RT-08 / S7. The `archived_at IS NULL` half of the membership predicate
      // is pinned here, not only by the SQL text: an ARCHIVED location of MY
      // OWN account passes every other clause, so a predicate that lost the
      // archival check would answer a scoped summary for a location the owner
      // has retired.
      await db`
        UPDATE businesses SET archived_at = NOW()
        WHERE id = ${secondLocationId}::uuid AND account_id = ${tenant.accountId}::uuid
      `;
      try {
        // BRANCH 1: no conversation row at all.
        expect(await getConversationForOwner(db, {
          accountId: tenant.accountId,
          actorUserId: tenant.userId,
          locationId: secondLocationId,
        })).toEqual({ kind: 'location_not_found' });

        // BRANCH 2: a conversation row EXISTS but has no turns. Before S7 this
        // branch answered 200 with `summary: null` while branch 1 answered a
        // 404 — one fact, two answers, and the screen could say nothing in
        // either case.
        const conversationId = randomUUID();
        await db`
          INSERT INTO agent_conversations (id, account_id, created_by_user_id)
          VALUES (${conversationId}::uuid, ${tenant.accountId}::uuid, ${tenant.userId}::uuid)
        `;
        expect(await getConversationForOwner(db, {
          accountId: tenant.accountId,
          actorUserId: tenant.userId,
          conversationId,
          locationId: secondLocationId,
        })).toEqual({ kind: 'location_not_found' });

        // An ACTIVE location on the same call shape is still a view, so the
        // refusal is the archival predicate and not the branch itself.
        const ok = viewOrThrow(await getConversationForOwner(db, {
          accountId: tenant.accountId,
          actorUserId: tenant.userId,
          conversationId,
          locationId,
        }));
        expect(ok.summary!.locationId).toBe(locationId);
      } finally {
        await db`
          UPDATE businesses SET archived_at = NULL
          WHERE id = ${secondLocationId}::uuid AND account_id = ${tenant.accountId}::uuid
        `;
      }
    });

    it.each([false, true])('hydrates reused proposals without changing their owning turn (outside transcript: %s)', async (outsideTranscript) => {
      const conversationId = randomUUID();
      const source = createdOrThrow(await createTurn(db, baseTurnInput({
        conversationId: outsideTranscript ? randomUUID() : conversationId,
      })));
      const sourceProposal = await seedProposal({
        ...source, accountId: tenant.accountId, actorUserId: tenant.userId,
        locationId, operation: 'set_tone', inputJson: { tone: 'warm' }, rationale: 'Original request.',
      });
      await completeTurnWithProposals(source.turnId, tenant.accountId, 'Original plan.', [sourceProposal]);
      const foreign = createdOrThrow(await createTurn(db, baseTurnInput({
        accountId: other.accountId, actorUserId: other.userId, locationId: otherLocationId,
      })));
      const foreignProposal = await seedProposal({
        ...foreign, accountId: other.accountId, actorUserId: other.userId,
        locationId: otherLocationId, operation: 'set_tone', inputJson: { tone: 'formal' }, rationale: 'Another account.',
      });
      await completeTurn(foreign.turnId, other.accountId, 'Foreign plan.');

      const current = createdOrThrow(await createTurn(db, baseTurnInput({ conversationId })));
      const ownProposal = await seedProposal({
        ...current, accountId: tenant.accountId, actorUserId: tenant.userId,
        locationId, operation: 'set_tone', inputJson: { tone: 'brief' }, rationale: 'Current request.',
      });
      // A foreign id and an absent id must never hydrate. Repeated references
      // and an already-loaded own proposal must never create duplicate cards.
      const referenced = [sourceProposal, ownProposal, sourceProposal, foreignProposal, randomUUID()];
      await completeTurnWithProposals(current.turnId, tenant.accountId, 'Reuse the earlier plan.', referenced);
      const quiet = createdOrThrow(await createTurn(db, baseTurnInput({ conversationId })));
      await completeTurn(quiet.turnId, tenant.accountId, 'No plan in this turn.');

      const expectedBindings = [
        { id: ownProposal, turnId: current.turnId },
        { id: sourceProposal, turnId: source.turnId },
      ];
      const polled = await getTurnForOwner(db, { accountId: tenant.accountId, turnId: current.turnId });
      expect(polled?.proposals.map(({ id, turnId }) => ({ id, turnId }))).toEqual(expectedBindings);
      expect(polled?.segments.filter((segment) => segment.type === 'proposal').map((segment) => segment.proposalId)).toEqual(referenced);
      const resumed = viewOrThrow(await getConversationForOwner(db, {
        accountId: tenant.accountId, actorUserId: tenant.userId, conversationId,
      }));
      expect(resumed.turns.find((turn) => turn.id === current.turnId)?.proposals).toEqual(polled?.proposals);
      expect(resumed.turns.find((turn) => turn.id === quiet.turnId)?.proposals).toEqual([]);
      expect(resumed.turns.some((turn) => turn.id === source.turnId)).toBe(!outsideTranscript);
      const original = await getTurnForOwner(db, { accountId: tenant.accountId, turnId: source.turnId });
      expect(original?.proposals.map(({ id, turnId }) => ({ id, turnId }))).toEqual([
        { id: sourceProposal, turnId: source.turnId },
      ]);
      const [stored] = await db<{ turn_id: string }[]>`
        SELECT turn_id FROM agent_proposals
        WHERE id = ${sourceProposal}::uuid AND account_id = ${tenant.accountId}::uuid
      `;
      expect(stored?.turn_id).toBe(source.turnId);
    });

    it('stored refusals survive both owner GET builders in order and stay scoped to their turn and account', async () => {
      const conversationId = randomUUID();
      const first = createdOrThrow(await createTurn(db, baseTurnInput({
        conversationId, text: 'Say we are licensed and offer an incentive for reviews.',
      })));
      const subjects = [randomUUID(), randomUUID()];
      const stored = [
        { type: 'text', text: 'There are two parts I will not carry out.' },
        { type: 'refusal', reason: 'invented_business_fact', subjectId: subjects[0] },
        { type: 'question', text: 'Would you like to change your reply tone?' },
        { type: 'refusal', reason: 'review_incentive', subjectId: subjects[1] },
      ];
      await db`
        UPDATE agent_turns
        SET status = ${TURN_STATUS.COMPLETED}, reply = ${db.json(stored)},
            completed_at = NOW()
        WHERE id = ${first.turnId}::uuid AND account_id = ${tenant.accountId}::uuid
      `;
      const second = createdOrThrow(await createTurn(db, baseTurnInput({
        conversationId, text: 'Show what needs me.',
      })));
      await completeTurn(second.turnId, tenant.accountId, 'Here is the current work.');
      const expected = [
        {
          type: 'refusal', reason: 'invented_business_fact', subjectId: subjects[0],
          text: 'RepWorth rules prohibit inventing or claiming unverified business facts, including licenses and credentials.',
        },
        {
          type: 'refusal', reason: 'review_incentive', subjectId: subjects[1],
          text: 'RepWorth rules prohibit offering incentives in exchange for reviews.',
        },
      ];
      const polled = await getTurnForOwner(db, { turnId: first.turnId, accountId: tenant.accountId });
      expect(polled?.refused).toEqual(expected);
      expect(polled?.proposals).toEqual([]);
      expect(polled?.unsupported).toEqual([]);
      expect(polled?.segments).toEqual([stored[0], expected[0], stored[2], expected[1]]);
      expect(await getTurnForOwner(db, { turnId: first.turnId, accountId: other.accountId })).toBeNull();

      const resumed = viewOrThrow(await getConversationForOwner(db, {
        accountId: tenant.accountId, actorUserId: tenant.userId, conversationId,
      }));
      expect(resumed.turns.map((turn) => ({ id: turn.id, refused: turn.refused }))).toEqual([
        { id: first.turnId, refused: expected },
        { id: second.turnId, refused: [] },
      ]);
      expect(resumed.turns[0]?.segments).toEqual(polled?.segments);
      expect((await getTurnForOwner(db, {
        turnId: second.turnId, accountId: tenant.accountId,
      }))?.refused).toEqual([]);
      expect(await getConversationForOwner(db, {
        accountId: other.accountId, actorUserId: other.userId, conversationId,
      })).toEqual({ kind: 'not_found' });
    });

    it('each turn carries its own unsupported requests and no other turn\'s', async () => {
      // RT-06. `agent_unsupported_requests` rows are DURABLE and batched by
      // `turn_id = ANY(...)`, so a read keyed by the wrong turn, an always-empty
      // one, and one that drops its `account_id` predicate all fail here.
      const conversationId = randomUUID();
      const first = createdOrThrow(await createTurn(db, baseTurnInput({
        conversationId, text: 'Post to Instagram for me.',
      })));
      await completeTurn(first.turnId, tenant.accountId, 'I cannot do that yet.');
      const second = createdOrThrow(await createTurn(db, baseTurnInput({
        conversationId, text: 'And warmer replies.',
      })));
      await completeTurn(second.turnId, tenant.accountId, 'Here is a plan.');

      const unsupportedId = randomUUID();
      await db`
        INSERT INTO agent_unsupported_requests (id, account_id, turn_id, request, context)
        VALUES (
          ${unsupportedId}::uuid, ${tenant.accountId}::uuid, ${first.turnId}::uuid,
          'Post to Instagram', 'The owner asked for another network.'
        )
      `;
      // A row naming MY turn under ANOTHER account's id. The FK graph permits
      // it (no composite key), which is why the batched read carries its own
      // `account_id` predicate.
      await db`
        INSERT INTO agent_unsupported_requests (id, account_id, turn_id, request, context)
        VALUES (
          ${randomUUID()}::uuid, ${other.accountId}::uuid, ${first.turnId}::uuid,
          'Not mine', 'Another tenant entirely.'
        )
      `;

      const view = viewOrThrow(await getConversationForOwner(db, {
        accountId: tenant.accountId,
        actorUserId: tenant.userId,
        conversationId,
      }));
      const [turnOne, turnTwo] = view.turns;
      expect(turnOne!.unsupported).toEqual([
        { id: unsupportedId, request: 'Post to Instagram', context: 'The owner asked for another network.' },
      ]);
      // The OTHER turn gets `[]`, never the neighbour's list — and never
      // `undefined`, which the client maps unconditionally.
      expect(turnTwo!.unsupported).toEqual([]);
      expect(JSON.stringify(view.turns)).not.toContain('Not mine');

      // And the single-turn read agrees with the transcript's batched one.
      const polled = await getTurnForOwner(db, {
        turnId: first.turnId, accountId: tenant.accountId,
      });
      expect(polled!.unsupported.map((u) => u.id)).toEqual([unsupportedId]);
    });

    it('the summary reports the latest zernio connection for the location, account-scoped', async () => {
      // RT-07. Disconnected rows are KEPT for audit (migration 026's
      // soft-delete model), so "the latest row" is the only thing that means
      // "the current state" — a read that filtered on status, or ordered the
      // other way, would tell an owner whose connection just broke that Google
      // is fine.
      await db`
        INSERT INTO zernio_connections (
          business_id, zernio_profile_id, zernio_account_id, zernio_location_id,
          status, connected_at, created_at
        ) VALUES (
          ${locationId}::uuid, 'prof-1', 'acct-1', 'loc-1',
          'active', NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days'
        )
      `;
      await db`
        INSERT INTO zernio_connections (
          business_id, zernio_profile_id, zernio_account_id, zernio_location_id,
          status, disconnected_at, disconnect_reason, created_at
        ) VALUES (
          ${locationId}::uuid, 'prof-1', 'acct-1', 'loc-1',
          'disconnected', NOW(), 'webhook_event', NOW()
        )
      `;
      // The NEIGHBOUR's location is connected and must not leak: the read is
      // account-scoped through `businesses`, which is the only tenant proof
      // `zernio_connections` has (it carries no `account_id` of its own).
      await db`
        INSERT INTO zernio_connections (
          business_id, zernio_profile_id, zernio_account_id, zernio_location_id,
          status, connected_at, created_at
        ) VALUES (
          ${otherLocationId}::uuid, 'prof-2', 'acct-2', 'loc-2',
          'active', NOW(), NOW()
        )
      `;

      try {
        const turn = createdOrThrow(await createTurn(db, baseTurnInput()));
        await completeTurn(turn.turnId, tenant.accountId, 'Here you go.');
        const view = viewOrThrow(await getConversationForOwner(db, {
          accountId: tenant.accountId,
          actorUserId: tenant.userId,
          conversationId: turn.conversationId,
        }));
        // LATEST WINS, and it is the disconnected one.
        expect(view.summary!.connectionStatus).toBe('disconnected');

        // Reading the SAME location under the neighbour's account id sees
        // nothing at all — the join, not the `business_id`, is what scopes it.
        expect(await getConversationForOwner(db, {
          accountId: other.accountId,
          actorUserId: other.userId,
          locationId,
        })).toEqual({ kind: 'location_not_found' });
      } finally {
        await db`DELETE FROM zernio_connections WHERE business_id IN (${locationId}::uuid, ${otherLocationId}::uuid)`;
      }
    });

    it("readSummaryEntitlement returns the account's subscription status and null for an unknown account", async () => {
      // THE GATE IN FRONT OF CUSTOMER KPI DATA. The conversation route decides
      // with `subscriptionAllowsDashboardRead`; this read is what feeds it —
      // the column, the table and the `WHERE id =` predicate. Its only importer
      // mocks it, so nothing but a live row proves it reads the NAMED account's
      // status rather than, say, the first account in the table.
      const before = {
        tenant: (await db<{ subscription_status: string }[]>`
          SELECT subscription_status FROM accounts WHERE id = ${tenant.accountId}::uuid
        `)[0]!.subscription_status,
        other: (await db<{ subscription_status: string }[]>`
          SELECT subscription_status FROM accounts WHERE id = ${other.accountId}::uuid
        `)[0]!.subscription_status,
      };
      try {
        // TWO ACCOUNTS, TWO DIFFERENT STATUSES, so a read that ignored its
        // argument could not answer both correctly.
        await db`
          UPDATE accounts SET subscription_status = ${SubscriptionStatus.PAST_DUE}
          WHERE id = ${tenant.accountId}::uuid
        `;
        await db`
          UPDATE accounts SET subscription_status = ${SubscriptionStatus.CANCELLED}
          WHERE id = ${other.accountId}::uuid
        `;

        expect(await readSummaryEntitlement(db, tenant.accountId))
          .toBe(SubscriptionStatus.PAST_DUE);
        expect(await readSummaryEntitlement(db, other.accountId))
          .toBe(SubscriptionStatus.CANCELLED);

        // The stored value is READ, not inferred: the same id answers the new
        // status after it changes.
        await db`
          UPDATE accounts SET subscription_status = ${SubscriptionStatus.ACTIVE}
          WHERE id = ${tenant.accountId}::uuid
        `;
        expect(await readSummaryEntitlement(db, tenant.accountId))
          .toBe(SubscriptionStatus.ACTIVE);

        // AN ACCOUNT ROW THAT DOES NOT EXIST answers `null`, which the route
        // reads as a refusal rather than as an empty entitlement.
        expect(await readSummaryEntitlement(db, randomUUID())).toBeNull();
      } finally {
        await db`
          UPDATE accounts SET subscription_status = ${before.tenant}
          WHERE id = ${tenant.accountId}::uuid
        `;
        await db`
          UPDATE accounts SET subscription_status = ${before.other}
          WHERE id = ${other.accountId}::uuid
        `;
      }
    });

    it('a zernio status outside the migration 026 vocabulary is refused, not widened', async () => {
      // RT-07's third half. The throw CANNOT be reached through the database:
      // `zernio_connections_status_check` rejects the row before the read ever
      // sees it, and dropping the constraint would be run-time DDL, which a
      // live-DB suite may not execute (.claude/rules/live-db-tests.md). So both
      // halves of the guard are asserted: the CHECK that makes it unreachable,
      // and the narrowing that refuses the value if it ever is.
      await expect(db`
        INSERT INTO zernio_connections (
          business_id, zernio_profile_id, zernio_account_id, zernio_location_id, status
        ) VALUES (
          ${locationId}::uuid, 'prof-x', 'acct-x', 'loc-x', 'revoked'
        )
      `).rejects.toThrow(/check constraint/i);

      expect(() => asConnectionStatus('revoked')).toThrow(/zernio_connections\.status/);
      expect(asConnectionStatus('disconnected')).toBe('disconnected');
      expect(asConnectionStatus('active')).toBe('active');
      expect(asConnectionStatus('pending')).toBe('pending');
    });
  },
);
