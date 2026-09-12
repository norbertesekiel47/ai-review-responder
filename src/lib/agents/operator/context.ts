// The **Context snapshot**: the types the model's world is described in, and
// the reads that fill them. The type half was declared first so the
// catalog/validator work and the route work could agree on the shape without
// waiting on these queries.
//
// Invariant #15: `buildSnapshot` takes its `db` explicitly and this module
// never imports @/lib/db/server. Invariant #9: every statement below carries
// an `account_id` predicate.
import type postgres from 'postgres';
import type { SubscriptionTierValue } from '@/lib/accounts/tier-config';
import { getAutoApprovalSettings } from '@/lib/auto-approval/settings';
import type { AutoApprovalThreshold, VetoWindowMinutes } from '@/lib/auto-approval/types';
import { getLocationsForAccount } from '@/lib/locations/repo';
import { openFlagExistsSql } from '@/lib/moderation/held-draft';
import { readVoiceConfig } from '@/lib/responses/voice-settings';
import { REVIEW_STATUS } from '@/lib/reviews/status';
import { modelVisibleOperations, type ModelVisibleOperation } from './catalog';
import { listPendingProposals } from './proposals';
import { scrubPastedReview } from './render';
import { parseReplySegments, TURN_STATUS } from './schema';

type Sql = postgres.Sql;

export type StarBandKey = '1' | '2' | '3' | '4' | '5';

export interface StarBands {
  /** null on the account aggregate. */
  locationId: string | null;
  /** Includes rows with a NULL star_rating; those are in no band. */
  total: number;
  byStar: Record<StarBandKey, number>;
}

export interface SnapshotMetrics {
  pendingCount: number;
  draftsWaiting: number;
  posted7d: number;
  starBands: StarBands;
  accountStarBands: StarBands;
  reportingPeriodDays: number;
  asOf: string;
}

/**
 * One scope's **Operating rules**: effective, not stored — a location with no
 * override row still has them, inherited from the account default.
 */
export interface RuleSummary {
  /** `AutoApprovalThreshold | null` — null means no threshold is set. */
  threshold: AutoApprovalThreshold | null;
  vetoWindowMinutes: VetoWindowMinutes;
  /** The ENFORCED cap (`effectiveDailyCap`), never the nullable stored value. */
  dailyCap: number;
}

/** The voice facts the model may see. NO `sampleResponses` — that is response text. */
export interface SnapshotFacts {
  tone: string | null;
  productsServices: string | null;
  avoidFacts: string[];
  highlightFacts: string[];
}

/** One earlier turn, reduced to what the model may see. */
export interface SnapshotTurn {
  sequence: number;
  /**
   * Already scrubbed at write time; re-scrubbed here is a belt-and-braces
   * no-op. The **Pasted-review scrub** is a read-path transform — the stored
   * `owner_text` is never modified.
   */
  ownerText: string;
  replyText: string[];
  proposalSummaries: string[];
}

/** A pending **Proposal**, reduced to what the model may see. */
export interface SnapshotProposal {
  id: string;
  operation: string;
  labelKind: string;
  status: string;
  describe: string;
}

/**
 * Everything the model is allowed to see, and NOTHING ELSE.
 *
 * There is deliberately no field on this type that could hold review text,
 * response text or a reviewer name — that is the type-level form of the
 * invariant, and it is what the red-team fixture in T7 asserts against.
 */
export interface Snapshot {
  accountId: string;
  locationId: string;
  locationName: string;
  subscriptionTier: SubscriptionTierValue;
  turns: SnapshotTurn[];
  pendingProposals: SnapshotProposal[];
  operatingRules: { account: RuleSummary; location: RuleSummary; locationOverrideExists: boolean };
  /**
   * The four voice FACTS, and deliberately not `VoiceConfig`:
   * `sampleResponses` is stored RESPONSE TEXT, which the snapshot may never
   * carry (invariant 5). Spelling the projection as its own type is what makes
   * that a compile error rather than a review note.
   */
  facts: SnapshotFacts;
  allowedOperations: readonly ModelVisibleOperation[];
  locations: { id: string; name: string }[];
  metrics: SnapshotMetrics;
}

// ── The reads ─────────────────────────────────────────────────────────────

const EMPTY_BANDS: Record<StarBandKey, number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
const SNAPSHOT_TURN_LIMIT = 10;
export const RECENT_COMPLETED_DAYS = 7;

type StarBandRow = { location_id: string; star_rating: number | null; count: number };

/**
 * The star-band read: ONE query, grouped by location and star.
 *
 * `pending_approval` with held drafts excluded — a draft a moderation flag is
 * holding is not work waiting for the owner, and counting it would tell the
 * owner to go look at something admin-only. `openFlagExistsSql` is the single
 * read-side spelling of that predicate.
 *
 * Soft-deleted reviews are excluded too (`r.status <> 'deleted'`,
 * src/lib/reviews/status.ts:30): the row survives, the Reviews list does not
 * show it, and counting its draft would send the owner looking for work that
 * is not there.
 *
 * The reviews join carries BOTH keys — `r.id = resp.review_id AND
 * r.business_id = b.id`, with `businesses` joined FIRST — so `ci:tenant-scope`
 * can see a tenant predicate for `reviews` and not only for `responses`.
 *
 * A NULL star_rating counts in `total` and in no band; the account aggregate is
 * derived from the same rows, never a second query, so the per-location numbers
 * and the account number cannot disagree.
 */
async function readStarBands(
  db: Sql,
  input: { accountId: string; locationId: string },
): Promise<{ location: StarBands; account: StarBands; pendingCount: number; draftsWaiting: number }> {
  const rows = await db<StarBandRow[]>`
    SELECT
      resp.business_id AS location_id,
      r.star_rating,
      COUNT(*)::int AS count
    FROM responses resp
    JOIN businesses b ON b.id = resp.business_id
    JOIN reviews r
      ON r.id = resp.review_id
      AND r.business_id = b.id
    WHERE b.account_id = ${input.accountId}::uuid
      AND b.archived_at IS NULL
      AND resp.status = ${REVIEW_STATUS.PENDING_APPROVAL}
      AND r.status <> ${REVIEW_STATUS.DELETED}
      AND NOT ${openFlagExistsSql(db, db`resp.id`)}
    GROUP BY resp.business_id, r.star_rating
  `;

  const location: StarBands = { locationId: input.locationId, total: 0, byStar: { ...EMPTY_BANDS } };
  const account: StarBands = { locationId: null, total: 0, byStar: { ...EMPTY_BANDS } };

  for (const row of rows) {
    const band = row.star_rating === null ? null : (String(row.star_rating) as StarBandKey);
    account.total += row.count;
    if (band && band in account.byStar) account.byStar[band] += row.count;
    if (row.location_id !== input.locationId) continue;
    location.total += row.count;
    if (band && band in location.byStar) location.byStar[band] += row.count;
  }

  return {
    location,
    account,
    pendingCount: location.total,
    draftsWaiting: account.total,
  };
}

export async function readPosted7d(db: Sql, input: { accountId: string; locationId: string }): Promise<number> {
  const [row] = await db<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM responses resp
    JOIN businesses b ON b.id = resp.business_id
    WHERE b.account_id = ${input.accountId}::uuid
      AND resp.business_id = ${input.locationId}::uuid
      AND resp.status = ${REVIEW_STATUS.POSTED}
      AND resp.posted_at >= NOW() - INTERVAL '7 days'
  `;
  return row?.count ?? 0;
}

/**
 * The last N FINISHED turns before this one.
 *
 * Two filters, both load-bearing. `sequence < current` excludes the turn being
 * processed, whose own `owner_text` the caller passes separately and already
 * scrubbed — without it the model would see the message twice, once raw.
 * `status IN ('completed','failed')` excludes anything still in flight, which
 * carries no reply to summarise.
 *
 * EVERY historical `owner_text` goes through `scrubPastedReview` on the way out
 * (spec §5.3: "with any pasted review block already replaced by the §3.4
 * marker"). The stored column is verbatim, so the scrub cannot be assumed to
 * have happened at write time — and a review pasted three turns ago is exactly
 * as untrusted as one pasted now.
 */
async function readRecentTurns(
  db: Sql,
  input: { accountId: string; conversationId: string; beforeSequence: number },
): Promise<SnapshotTurn[]> {
  const rows = await db<{ sequence: number; owner_text: string; reply: unknown }[]>`
    SELECT sequence, owner_text, reply
    FROM agent_turns
    WHERE conversation_id = ${input.conversationId}::uuid
      AND account_id = ${input.accountId}::uuid
      AND sequence < ${input.beforeSequence}
      AND status IN (${TURN_STATUS.COMPLETED}, ${TURN_STATUS.FAILED})
    ORDER BY sequence DESC
    LIMIT ${SNAPSHOT_TURN_LIMIT}
  `;
  return rows
    .slice()
    .reverse()
    .map((row) => ({
      sequence: row.sequence,
      ownerText: scrubPastedReview(row.owner_text).text,
      replyText: parseReplySegments(row.reply)
        .filter((segment): segment is { type: 'text'; text: string } => segment.type === 'text')
        .map((segment) => segment.text),
      proposalSummaries: [],
    }));
}

export interface BuildSnapshotInput {
  accountId: string;
  locationId: string;
  locationName: string;
  conversationId: string;
  /** This turn's own sequence — history is everything strictly before it. */
  sequence: number;
  subscriptionTier: SubscriptionTierValue;
}

export async function buildSnapshot(db: Sql, input: BuildSnapshotInput): Promise<Snapshot> {
  // Sequential by design: these share one pooled connection, and CLAUDE.md's
  // ci:pool-fanout rule forbids a Promise combinator over DB-issuing elements.
  const bands = await readStarBands(db, input);
  const posted7d = await readPosted7d(db, input);
  const turns = await readRecentTurns(db, {
    accountId: input.accountId,
    conversationId: input.conversationId,
    beforeSequence: input.sequence,
  });
  const pendingProposals = await listPendingProposals(db, {
    conversationId: input.conversationId,
    accountId: input.accountId,
  });
  const settings = await getAutoApprovalSettings(db, {
    accountId: input.accountId,
    impersonated: false,
  });
  const voice = await readVoiceConfig(db, {
    accountId: input.accountId,
    locationId: input.locationId,
  });
  const locations = await getLocationsForAccount(db, input.accountId);

  const locationSettings = settings.locations.find((l) => l.locationId === input.locationId);

  return {
    accountId: input.accountId,
    locationId: input.locationId,
    locationName: input.locationName,
    subscriptionTier: input.subscriptionTier,
    turns,
    pendingProposals: pendingProposals.map((p) => ({
      id: p.id,
      operation: p.operation,
      labelKind: p.labelKind,
      status: p.status,
      describe: p.describe,
    })),
    // Projection from AutoApprovalSettingsResponse
    // (src/lib/auto-approval/settings.ts:191): `accountDefault` is an
    // AutoApprovalPolicyApiState (src/lib/auto-approval/types.ts:129) and each
    // entry of `locations` is an AutoApprovalLocationSettings
    // (src/lib/auto-approval/types.ts:142) carrying `override` (the row, if
    // any) and `effective` (what actually governs after inheritance).
    //
    // The LOCATION reads `effective`, never `override`: a location with no
    // override row still has operating rules, inherited from the account, and
    // reading `override` would report nulls as if the location had no dials.
    // `effectiveDailyCap` is the enforced number (`dailyAutoPostCap` is the
    // stored value, null meaning "platform default"), which is what an owner
    // asking "what is my cap" means.
    operatingRules: {
      account: {
        threshold: settings.accountDefault.threshold,
        vetoWindowMinutes: settings.accountDefault.vetoWindowMinutes,
        dailyCap: settings.accountDefault.effectiveDailyCap,
      },
      location: {
        threshold: locationSettings?.effective.threshold ?? settings.accountDefault.threshold,
        vetoWindowMinutes:
          locationSettings?.effective.vetoWindowMinutes ?? settings.accountDefault.vetoWindowMinutes,
        dailyCap: locationSettings?.effective.effectiveDailyCap ?? settings.accountDefault.effectiveDailyCap,
      },
      // Row EXISTENCE, which is a distinct fact from inheritance: spec §4 says a
      // dial-only change on a location with no row CREATES one, and the card
      // must say so.
      locationOverrideExists: locationSettings?.override.exists ?? false,
    },
    // Field-by-field, never a spread: a spread would carry `sampleResponses`
    // (response text) into the snapshot the moment someone adds a field.
    facts: {
      tone: voice?.tone ?? null,
      productsServices: voice?.productsServices ?? null,
      avoidFacts: voice?.avoidFacts ?? [],
      highlightFacts: voice?.highlightFacts ?? [],
    },
    allowedOperations: modelVisibleOperations(input.subscriptionTier),
    locations: locations.map((l) => ({ id: l.id, name: l.name })),
    metrics: {
      pendingCount: bands.pendingCount,
      draftsWaiting: bands.draftsWaiting,
      posted7d,
      starBands: bands.location,
      accountStarBands: bands.account,
      reportingPeriodDays: RECENT_COMPLETED_DAYS,
      asOf: new Date().toISOString(),
    },
  };
}
