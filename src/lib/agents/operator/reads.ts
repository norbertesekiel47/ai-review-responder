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
  listProposalsForTurn,
  listProposalsForTurns,
  listUnsupportedForTurn,
  type ProposalView,
  type UnsupportedView,
} from './proposals';
import { renderSegments, type RenderedSegment } from './render';
import { asTurnStatus, parseReplySegments, type TurnStatus } from './schema';

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

export interface OwnerTurnView {
  id: string;
  status: TurnStatus;
  failureReason: string | null;
  locationId: string;
  segments: RenderedSegment[];
  proposals: ProposalView[];
  unsupported: UnsupportedView[];
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

  return {
    id: row.id,
    status: asTurnStatus(row.status),
    failureReason: row.failure_reason,
    locationId: row.location_id,
    segments: renderSegments(parseReplySegments(row.reply), {
      locations: locations.map((l) => ({ id: l.id, name: l.name })),
    }),
    proposals,
    unsupported,
  };
}

export interface OwnerConversationTurn {
  id: string;
  sequence: number;
  status: TurnStatus;
  failureReason: string | null;
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
  pending: { pendingCount: number; draftsWaiting: number };
  recent: { posted7d: number; reportingPeriodDays: number };
  rules: RuleSummary & { locationOverrideExists: boolean };
  facts: (VoiceConfig & { updatedAt: string }) | null;
  pendingProposals: ProposalView[];
  asOf: string;
}

export interface OwnerConversationView {
  conversation: { id: string; lastTurnAt: string | null };
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
  input: { accountId: string; actorUserId: string; conversationId?: string },
): Promise<OwnerConversationView | null> {
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
  if (!conversation) return null;

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
  // looking at. With no turns yet there is nothing to scope to and the summary
  // is omitted — `null`, not a zeroed object.
  const latest = turnRows[turnRows.length - 1];
  const locations = await getLocationsForAccount(sql, input.accountId);
  // ONE `turn_id = ANY(...)` read for the whole transcript, not one per turn.
  const proposalsByTurn = await listProposalsForTurns(sql, {
    turnIds: turnRows.map((turn) => turn.id),
    accountId: input.accountId,
  });

  const turns: OwnerConversationTurn[] = turnRows.map((turn) => ({
    id: turn.id,
    sequence: turn.sequence,
    status: asTurnStatus(turn.status),
    failureReason: turn.failure_reason,
    ownerText: turn.owner_text,
    // A pure mapping: no metrics and no index resolution, because every stored
    // `status` segment already carries its value and every stored `proposal`
    // segment already carries its id.
    segments: renderSegments(parseReplySegments(turn.reply), {
      locations: locations.map((l) => ({ id: l.id, name: l.name })),
    }),
    proposals: proposalsByTurn.get(turn.id) ?? [],
  }));

  if (!latest) {
    return {
      conversation: { id: conversation.id, lastTurnAt: nullableIso(conversation.last_turn_at) },
      turns,
      summary: null,
    };
  }

  // The SUMMARY panel is a live read and says so with `asOf` — spec §3.1 names
  // `getPendingApprovalCountsForAccount` as its source, and reusing the
  // dashboard's own helper (src/lib/dashboard/pending-count.ts) is what keeps
  // the panel's numbers equal to the dashboard's. This is a different question
  // from the TRANSCRIPT, whose `status` segments are frozen values the renderer
  // passes through untouched; the two must not share a source.
  //
  // Sequential by design: one pooled connection, and ci:pool-fanout forbids a
  // Promise combinator over DB-issuing elements.
  const pendingByLocation = await getPendingApprovalCountsForAccount(sql, input.accountId);
  const posted7d = await readPosted7d(sql, {
    accountId: input.accountId,
    locationId: latest.location_id,
  });
  const settings = await getAutoApprovalSettings(sql, {
    accountId: input.accountId,
    impersonated: false,
  });
  const facts = await readVoiceConfig(sql, {
    accountId: input.accountId,
    locationId: latest.location_id,
  });
  const pendingProposals = await listPendingProposals(sql, {
    conversationId: conversation.id,
    accountId: input.accountId,
  });

  let draftsWaiting = 0;
  for (const count of pendingByLocation.values()) draftsWaiting += count;
  // The SINGLE owner of the inheritance projection; see its docblock.
  const rules = projectOperatingRules(settings, latest.location_id);

  return {
    conversation: { id: conversation.id, lastTurnAt: nullableIso(conversation.last_turn_at) },
    turns,
    summary: {
      pending: {
        pendingCount: pendingByLocation.get(latest.location_id) ?? 0,
        draftsWaiting,
      },
      recent: { posted7d, reportingPeriodDays: RECENT_COMPLETED_DAYS },
      rules: { ...rules.location, locationOverrideExists: rules.locationOverrideExists },
      facts,
      pendingProposals,
      asOf: new Date().toISOString(),
    },
  };
}

function nullableIso(value: Date | string | null): string | null {
  return value == null ? null : new Date(value).toISOString();
}
