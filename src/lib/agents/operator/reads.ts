// The account-scoped OWNER READS for the Owner Operator: the polled turn and
// the conversation transcript plus its summary panel.
//
// Split out of `turns.ts`, which owns WRITES — `createTurn`'s transaction, the
// claim/release/predecessor protocol and the terminal transitions. The two
// halves share nothing but the table names, run on opposite sides of the
// worker, and had no reason to be read together.
//
// Invariant #15: every function takes `sql` explicitly and this module never
// imports @/lib/db/server. Invariant #9: EVERY statement carries an
// `account_id` predicate.
import type postgres from 'postgres';
import { getAutoApprovalSettings } from '@/lib/auto-approval/settings';
import { getPendingApprovalCountsForAccount } from '@/lib/dashboard/pending-count';
import { getLocationsForAccount } from '@/lib/locations/repo';
import { readVoiceConfig, type VoiceConfig } from '@/lib/responses/voice-settings';
import {
  projectOperatingRules,
  RECENT_COMPLETED_DAYS,
  readPosted7d,
  type RuleSummary,
} from './context';
import {
  listPendingProposals,
  listProposalsByIds,
  listProposalsForTurn,
  listProposalsForTurns,
  listUnsupportedForTurn,
  listUnsupportedForTurns,
  type ProposalView,
  type UnsupportedView,
} from './proposals';
import { renderSegments, type RenderedSegment } from './render';
import {
  asConnectionStatus,
  asTurnStatus,
  parseReplySegments,
  type ConnectionStatus,
  type TurnStatus,
} from './schema';

type Sql = postgres.Sql;

/**
 * How many turns the transcript returns, most recent first in the query and
 * chronological in the result.
 *
 * A conversation grows without bound and this read runs on every poll, so an
 * unbounded `SELECT … ORDER BY sequence ASC` gets slower for the rest of the
 * conversation's life. Fifty is far more than a screen shows and far less than
 * a year of talking.
 */
export const TRANSCRIPT_TURN_LIMIT = 50;

export type OwnerRefusalView = Extract<RenderedSegment, { type: 'refusal' }>;

/**
 * Restore can reuse a proposal owned by an earlier turn, including one outside
 * this transcript. Fetch only missing referenced IDs, once and account-scoped.
 * Attach the original row without changing its turnId or duplicating its card.
 */
async function hydrateProposalReferences(
  sql: Sql,
  accountId: string,
  turns: { segments: RenderedSegment[]; proposals: ProposalView[] }[],
): Promise<void> {
  const byId = new Map(turns.flatMap((turn) => turn.proposals.map((proposal) => [proposal.id, proposal] as const)));
  const references = turns.map((turn) => ({
    turn,
    ids: turn.segments.flatMap((segment) => segment.type === 'proposal' ? [segment.proposalId] : []),
  }));
  const missing = new Set(references.flatMap(({ ids }) => ids).filter((id) => !byId.has(id)));
  if (missing.size > 0) {
    const referenced = await listProposalsByIds(sql, { accountId, proposalIds: [...missing] });
    for (const proposal of referenced) byId.set(proposal.id, proposal);
  }
  for (const { turn, ids } of references) {
    const proposals = new Map(turn.proposals.map((proposal) => [proposal.id, proposal]));
    for (const id of ids) {
      const proposal = byId.get(id);
      if (proposal) proposals.set(proposal.id, proposal);
    }
    turn.proposals = [...proposals.values()];
  }
}

export interface OwnerTurnView {
  id: string;
  status: TurnStatus;
  failureReason: string | null;
  locationId: string;
  segments: RenderedSegment[];
  proposals: ProposalView[];
  unsupported: UnsupportedView[];
  refused: OwnerRefusalView[];
}

/**
 * The polled read. Account-scoped: a turn under another account returns null,
 * which the route renders as a 404 — indistinguishable from one that does not
 * exist, so the read cannot be used to probe for other tenants' ids.
 *
 * NO metrics read happens here, and that is the design. A stored `status`
 * segment carries the value, its reporting period and the instant it was read
 * at, frozen at fenced completion; re-resolving a metric name now would paint
 * TODAY's count — for whatever location the caller passed — onto a sentence the
 * model wrote days ago. A stored `proposal` segment carries its id the same
 * way, and the pasted-review notice is stored too, so a refresh renders each of
 * them again rather than re-deriving them.
 */
export async function getTurnForOwner(
  sql: Sql,
  input: { turnId: string; accountId: string },
): Promise<OwnerTurnView | null> {
  const [row] = await sql<{
    id: string; status: string; failure_reason: string | null; location_id: string;
    reply: unknown;
  }[]>`
    SELECT id, status, failure_reason, location_id, reply
    FROM agent_turns
    WHERE id = ${input.turnId}::uuid
      AND account_id = ${input.accountId}::uuid
  `;
  if (!row) return null;

  // Sequential by design: these share one pooled connection, and
  // CLAUDE.md's ci:pool-fanout rule forbids a Promise combinator over
  // DB-issuing elements.
  const proposals = await listProposalsForTurn(sql, input);
  const unsupported = await listUnsupportedForTurn(sql, input);
  const locations = await getLocationsForAccount(sql, input.accountId);
  const segments = renderSegments(parseReplySegments(row.reply), {
    locations: locations.map((l) => ({ id: l.id, name: l.name })),
  });

  const turn: OwnerTurnView = {
    id: row.id,
    status: asTurnStatus(row.status),
    failureReason: row.failure_reason,
    locationId: row.location_id,
    segments,
    proposals,
    unsupported,
    refused: segments.filter((segment) => segment.type === 'refusal'),
  };
  await hydrateProposalReferences(sql, input.accountId, [turn]);
  return turn;
}

export interface OwnerConversationTurn {
  id: string;
  sequence: number;
  status: TurnStatus;
  failureReason: string | null;
  /**
   * The turn's STORED location. The card's target is rendered from THIS, never
   * from the browser's selector (spec §3.3), and the screen compares it against
   * the current scope to decide whether to show "Prepared for <location>" (D4).
   */
  locationId: string;
  /**
   * This turn's **Requested capability** rows. DURABLE, exactly like the
   * proposals beside them: rendering them only from the in-flight poll meant
   * the card vanished on the next reload or the next send while the row was
   * still in the table (RB-07). Read in ONE batched `listUnsupportedForTurns`.
   */
  unsupported: UnsupportedView[];
  /** Stored decisions with server-owned wording, distinct from unsupported requests. */
  refused: OwnerRefusalView[];
  /** The owner's message, stored VERBATIM — the scrub is a read-path transform. */
  ownerText: string;
  segments: RenderedSegment[];
  /**
   * This turn's **Proposal**s, in every status. A `proposal` segment carries
   * only an id, so the cards it names have to travel with the transcript;
   * `summary.pendingProposals` cannot stand in, because it is pending-only and
   * a superseded card still belongs to the sentence that proposed it.
   */
  proposals: ProposalView[];
}

/** The live summary panel. Null when there is no turn to scope its reads to. */
export interface OwnerConversationSummary {
  /**
   * The location EVERY number below is scoped to — the latest turn's, or the
   * `?locationId=` the browser passed on an empty conversation.
   *
   * The panel says "this location" and its Connect call to action links out of
   * the screen, so a summary that carried no location identity made the panel
   * guess (the browser's current selector, which may have moved since the
   * latest turn) and dropped the scope on the way to /dashboard/connect.
   */
  locationId: string;
  pending: { pendingCount: number; draftsWaiting: number };
  recent: { posted7d: number; reportingPeriodDays: number };
  rules: RuleSummary & { locationOverrideExists: boolean };
  facts: (VoiceConfig & { updatedAt: string }) | null;
  pendingProposals: ProposalView[];
  /**
   * The location's Google connection, as the latest `zernio_connections` row
   * reports it — `'pending' | 'active' | 'disconnected'`, or `null` when the
   * location has never been connected. Account-scoped through `businesses`.
   *
   * The panel shows the existing connect call to action when this is not
   * `'active'` (spec §3.1). It does NOT gate the composer: a settings
   * conversation is not a posting action, and refusing to talk because Google
   * is disconnected would block the very conversation that explains it.
   */
  connectionStatus: ConnectionStatus | null;
  asOf: string;
}

export interface OwnerConversationView {
  /**
   * `null` for a first-time owner. `createTurn` makes the conversation row
   * TOGETHER with the first turn and nothing creates an empty one, so "no row"
   * is what every owner looks like before they have said anything — the normal
   * state, not an error. The summary panel and the connect call to action are
   * most useful at exactly that moment, and a 404 would hide both.
   */
  conversation: { id: string; lastTurnAt: string | null } | null;
  turns: OwnerConversationTurn[];
  /**
   * `null` on a conversation with no turns yet — NOT a zeroed summary. Every
   * number in this panel is scoped to a location, and with no turn there is no
   * location to scope to. An all-zeros object with a fresh `asOf` does not read
   * as "nothing to report"; it reads as "just measured, and the answer is
   * zero", which for an account with a dozen drafts waiting is a lie the
   * timestamp vouches for.
   */
  summary: OwnerConversationSummary | null;
}

/**
 * What the transcript read can answer. THREE outcomes, not two, because a
 * `?locationId=` that is not an active location of the account is a different
 * fact from "no such conversation" and the owner is owed a different sentence.
 *
 * Before this split the unusable location produced `null` (→ 404
 * `conversation_not_found`) when the owner had no conversation and a 200 with
 * `summary: null` when they had one — two answers to one question, and the
 * screen could say nothing in either case (S7). The route maps
 * `location_not_found` to its own 404 code in BOTH branches.
 */
export type OwnerConversationResult =
  | { kind: 'view'; view: OwnerConversationView }
  | { kind: 'not_found' }
  | { kind: 'location_not_found' };

/**
 * The transcript plus the summary-panel reads.
 *
 * Without `conversationId`, returns the actor's most recent conversation for
 * this account — `idx_agent_conversations_account_recent` is
 * `(account_id, created_by_user_id, last_turn_at DESC)` for exactly this order.
 *
 * `asOf` is the METRICS' own timestamp, never a second `new Date()`: a number
 * and the instant it was read must not be able to disagree.
 */
export async function getConversationForOwner(
  sql: Sql,
  input: {
    accountId: string;
    actorUserId: string;
    conversationId?: string;
    /**
     * D2. Used ONLY when the conversation has no turns yet: the panel has no
     * turn to scope to, but the browser knows which location is selected. An
     * id that is not an active member of the account is `location_not_found`
     * in EITHER branch (S7) — additive to Run A's rule, never a replacement
     * for the latest-turn scoping, which still wins whenever a turn exists.
     */
    locationId?: string;
  },
): Promise<OwnerConversationResult> {
  const [conversation] = input.conversationId
    ? await sql<{ id: string; last_turn_at: Date | string | null }[]>`
        SELECT id, last_turn_at
        FROM agent_conversations
        WHERE id = ${input.conversationId}::uuid
          AND account_id = ${input.accountId}::uuid
      `
    : await sql<{ id: string; last_turn_at: Date | string | null }[]>`
        SELECT id, last_turn_at
        FROM agent_conversations
        WHERE account_id = ${input.accountId}::uuid
          AND created_by_user_id = ${input.actorUserId}::uuid
        ORDER BY last_turn_at DESC NULLS LAST
        LIMIT 1
      `;
  if (!conversation) {
    // A caller that named a SPECIFIC conversation and missed still gets
    // `not_found`, which the route renders as 404. Unchanged.
    if (input.conversationId !== undefined) return { kind: 'not_found' };
    // A caller that named a LOCATION and has no conversation yet gets the
    // empty view with a scoped summary (RB-09).
    if (input.locationId === undefined) return { kind: 'not_found' };
    const firstLocationId = await activeLocationId(sql, input.accountId, input.locationId);
    // The SAME answer this id gets on the branch below, where a conversation
    // exists: an unusable location is one fact with one outcome (S7).
    if (firstLocationId === null) return { kind: 'location_not_found' };
    return {
      kind: 'view',
      view: {
        conversation: null,
        turns: [],
        summary: await readSummary(sql, {
          accountId: input.accountId,
          conversationId: null,
          locationId: firstLocationId,
        }),
      },
    };
  }

  // The MOST RECENT window, taken DESC and reversed — an `ASC` query cannot be
  // bounded to the recent end without a subquery.
  const recentFirst = await sql<{
    id: string; sequence: number; status: string; failure_reason: string | null;
    location_id: string; owner_text: string; reply: unknown;
  }[]>`
    SELECT id, sequence, status, failure_reason, location_id, owner_text, reply
    FROM agent_turns
    WHERE conversation_id = ${conversation.id}::uuid
      AND account_id = ${input.accountId}::uuid
    ORDER BY sequence DESC
    LIMIT ${TRANSCRIPT_TURN_LIMIT}
  `;
  const turnRows = recentFirst.slice().reverse();

  // The panel is scoped to the MOST RECENT turn's location: the selector may
  // have moved since, and the transcript's own target is what the owner is
  // looking at. With no turns yet there is nothing to scope to — unless the
  // caller named a location (D2), in which case the empty screen can still
  // show the panel for what the owner has selected.
  const latest = turnRows[turnRows.length - 1];
  const locations = await getLocationsForAccount(sql, input.accountId);
  // ONE `turn_id = ANY(...)` read for the whole transcript, not one per turn.
  // Both of these, and sequentially — ci:pool-fanout forbids a Promise
  // combinator over DB-issuing elements.
  const proposalsByTurn = await listProposalsForTurns(sql, {
    turnIds: turnRows.map((turn) => turn.id),
    accountId: input.accountId,
  });
  const unsupportedByTurn = await listUnsupportedForTurns(sql, {
    turnIds: turnRows.map((turn) => turn.id),
    accountId: input.accountId,
  });

  const turns: OwnerConversationTurn[] = turnRows.map((turn) => {
    // Render once so the ordered transcript and refusal list share the same
    // stored subjects and server-owned wording, with no extra ledger read.
    const segments = renderSegments(parseReplySegments(turn.reply), {
      locations: locations.map((l) => ({ id: l.id, name: l.name })),
    });
    return {
      id: turn.id,
      sequence: turn.sequence,
      status: asTurnStatus(turn.status),
      failureReason: turn.failure_reason,
      locationId: turn.location_id,
      ownerText: turn.owner_text,
      segments,
      refused: segments.filter((segment) => segment.type === 'refusal'),
      proposals: proposalsByTurn.get(turn.id) ?? [],
      // RB-07: Durable, like proposals. The client always receives an array.
      unsupported: unsupportedByTurn.get(turn.id) ?? [],
    };
  });
  await hydrateProposalReferences(sql, input.accountId, turns);

  // The turn's location is trusted (it was validated at POST). A CALLER-SUPPLIED
  // one is not, so it is checked for active membership before anything is
  // scoped to it — the alternative is a panel of account-scoped zeros for an
  // id that belongs to nobody, which reads as "nothing to report" rather than
  // "not your location".
  let summaryLocationId: string | null = latest?.location_id ?? null;
  if (latest === undefined && input.locationId !== undefined) {
    summaryLocationId = await activeLocationId(sql, input.accountId, input.locationId);
    // An unusable id is refused OUTRIGHT here rather than degraded to a null
    // summary: a 200 whose panel is silently missing is indistinguishable from
    // an account with nothing to report (S7).
    if (summaryLocationId === null) return { kind: 'location_not_found' };
  }

  const view: OwnerConversationView = {
    conversation: { id: conversation.id, lastTurnAt: nullableIso(conversation.last_turn_at) },
    turns,
    // Still `null` when there is no turn AND no caller-supplied location:
    // nothing to scope the panel's location-shaped reads to (Run A's rule).
    summary: summaryLocationId === null ? null : await readSummary(sql, {
      accountId: input.accountId,
      conversationId: conversation.id,
      locationId: summaryLocationId,
    }),
  };
  return { kind: 'view', view };
}

/**
 * The SUMMARY panel, for one location. ONE builder, called from both paths —
 * the first-time-owner empty view and the ordinary transcript — because two
 * copies of this sequence are two things that can drift.
 *
 * It is a live read and says so with `asOf` — spec §3.1 names
 * `getPendingApprovalCountsForAccount` as its source, and reusing the
 * dashboard's own helper (src/lib/dashboard/pending-count.ts) is what keeps
 * the panel's numbers equal to the dashboard's. This is a different question
 * from the TRANSCRIPT, whose `status` segments are frozen values the renderer
 * passes through untouched; the two must not share a source.
 *
 * Sequential by design: one pooled connection, and ci:pool-fanout forbids a
 * Promise combinator over DB-issuing elements.
 *
 * `conversationId` is `string | null`; when it is `null` the
 * `listPendingProposals` read is SKIPPED, because a conversation that does not
 * exist has no pending proposals to list.
 */
async function readSummary(
  sql: Sql,
  input: { accountId: string; conversationId: string | null; locationId: string },
): Promise<OwnerConversationSummary> {
  const pendingByLocation = await getPendingApprovalCountsForAccount(sql, input.accountId);
  const posted7d = await readPosted7d(sql, {
    accountId: input.accountId,
    locationId: input.locationId,
  });
  const settings = await getAutoApprovalSettings(sql, {
    accountId: input.accountId,
    impersonated: false,
  });
  const facts = await readVoiceConfig(sql, {
    accountId: input.accountId,
    locationId: input.locationId,
  });
  const pendingProposals = input.conversationId === null
    ? []
    : await listPendingProposals(sql, {
      conversationId: input.conversationId,
      accountId: input.accountId,
    });
  const connectionStatus = await readConnectionStatus(sql, {
    accountId: input.accountId,
    locationId: input.locationId,
  });

  let draftsWaiting = 0;
  for (const count of pendingByLocation.values()) draftsWaiting += count;
  // The SINGLE owner of the inheritance projection; see its docblock.
  const rules = projectOperatingRules(settings, input.locationId);

  return {
    locationId: input.locationId,
    pending: {
      pendingCount: pendingByLocation.get(input.locationId) ?? 0,
      draftsWaiting,
    },
    recent: { posted7d, reportingPeriodDays: RECENT_COMPLETED_DAYS },
    rules: { ...rules.location, locationOverrideExists: rules.locationOverrideExists },
    facts,
    pendingProposals,
    connectionStatus,
    asOf: new Date().toISOString(),
  };
}

function nullableIso(value: Date | string | null): string | null {
  return value == null ? null : new Date(value).toISOString();
}

/**
 * Is this location an active member of the account? One statement, and the
 * only reason it exists is that `input.locationId` comes from a query string.
 */
async function activeLocationId(
  sql: Sql,
  accountId: string,
  locationId: string,
): Promise<string | null> {
  const [row] = await sql<{ id: string }[]>`
    SELECT id
    FROM businesses
    WHERE id = ${locationId}::uuid
      AND account_id = ${accountId}::uuid
      AND archived_at IS NULL
  `;
  return row?.id ?? null;
}

/**
 * The location's latest `zernio_connections` row.
 *
 * Account-scoped THROUGH `businesses` — `zernio_connections` has no
 * `account_id` of its own, so the join is the tenant proof (`ci:tenant-scope`);
 * the same shape `src/lib/account-offboarding/snapshot.ts` uses.
 *
 * `ORDER BY created_at DESC LIMIT 1` rather than a status filter: disconnected
 * rows are kept for audit (migration 026's soft-delete model), so "the latest
 * row" is the only thing that means "the current state", and a location that
 * has never connected correctly returns `null` rather than `'disconnected'`.
 */
async function readConnectionStatus(
  sql: Sql,
  input: { accountId: string; locationId: string },
): Promise<ConnectionStatus | null> {
  const [row] = await sql<{ status: string }[]>`
    SELECT zc.status
    FROM zernio_connections zc
    JOIN businesses b ON b.id = zc.business_id
    WHERE zc.business_id = ${input.locationId}::uuid
      AND b.account_id = ${input.accountId}::uuid
    ORDER BY zc.created_at DESC
    LIMIT 1
  `;
  // migration 026's CHECK admits exactly three values, so `asConnectionStatus`
  // throwing means a row this codebase did not write.
  return row ? asConnectionStatus(row.status) : null;
}

/**
 * The account's subscription status, for the ONE entitlement question the
 * conversation route asks: may this account read customer KPI data at all?
 *
 * The route owns the ANSWER — it calls `subscriptionAllowsDashboardRead`, the
 * same predicate `/api/dashboard` gates on — and this is only the read that
 * feeds it, here rather than in the route because a composition root
 * orchestrates and does not write SQL. `null` for an account row that does not
 * exist, which no caller past the owner gate can produce.
 */
export async function readSummaryEntitlement(
  sql: Sql,
  accountId: string,
): Promise<string | null> {
  const [row] = await sql<{ subscription_status: string }[]>`
    SELECT subscription_status
    FROM accounts
    WHERE id = ${accountId}::uuid
  `;
  return row?.subscription_status ?? null;
}
