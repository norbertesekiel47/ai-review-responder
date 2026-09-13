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
import type {
  AutoApprovalSettingsResponse,
  AutoApprovalThreshold,
  VetoWindowMinutes,
} from '@/lib/auto-approval/types';
import { getLocationsForAccount } from '@/lib/locations/repo';
import { openFlagExistsSql } from '@/lib/moderation/held-draft';
import { readVoiceConfig } from '@/lib/responses/voice-settings';
import { REVIEW_STATUS } from '@/lib/reviews/status';
import { modelVisibleOperations, type ModelVisibleOperation } from './catalog';
import { listPendingProposals, listProposalsForTurns } from './proposals';
import { scrubPastedReview } from './render';
import { parseReplySegments, TURN_STATUS, type PolicyState } from './schema';

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

/** Both scopes' **Operating rules**, plus whether the location has its own row. */
export interface OperatingRulesProjection {
  account: RuleSummary;
  location: RuleSummary;
  locationOverrideExists: boolean;
}

/** Both scopes' full policy states, each with its own row existence. */
export interface PolicyStatesProjection {
  accountDefault: PolicyState;
  location: PolicyState;
}

/**
 * `AutoApprovalSettingsResponse` → both scopes' full `PolicyState`. THE single
 * owner of the inheritance rule: `projectOperatingRules` (snapshot and summary
 * panel) derives from it, and policy previews start from it, so the next dial
 * has one place to change.
 *
 * The LOCATION reads `effective`, never `override`: a location with no
 * override row still has operating rules, inherited from the account, and
 * reading `override` would report nulls as if the location had no dials.
 * `effectiveDailyCap` is the enforced number (`dailyAutoPostCap` is the stored
 * value, null meaning "platform default"), which is what an owner asking "what
 * is my cap" means.
 *
 * The effective OBJECT is chosen first, and only then are its fields read. The
 * earlier per-field `effective.threshold ?? account.threshold` read a
 * deliberate manual override (threshold null) as "unset", and reported the
 * account's threshold for a location that auto-posts nothing.
 *
 * `rowExists` is row EXISTENCE, a distinct fact from inheritance: spec §4 says
 * a dial-only change on a location with no row CREATES one, and the card must
 * say so.
 */
export function projectPolicyStates(
  settings: AutoApprovalSettingsResponse,
  locationId: string,
): PolicyStatesProjection {
  const account = settings.accountDefault;
  const accountDefault: PolicyState = {
    domain: 'policy',
    threshold: account.threshold,
    vetoWindowMinutes: account.vetoWindowMinutes,
    dailyAutoPostCap: account.dailyAutoPostCap,
    effectiveDailyCap: account.effectiveDailyCap,
    rowExists: account.exists,
  };
  const locationSettings = settings.locations.find((l) => l.locationId === locationId);
  if (!locationSettings) {
    return { accountDefault, location: { ...accountDefault, rowExists: false } };
  }
  const effective = locationSettings.effective;
  return {
    accountDefault,
    location: {
      domain: 'policy',
      threshold: effective.threshold,
      vetoWindowMinutes: effective.vetoWindowMinutes,
      dailyAutoPostCap: effective.dailyAutoPostCap,
      effectiveDailyCap: effective.effectiveDailyCap,
      rowExists: locationSettings.override.exists,
    },
  };
}

function toRuleSummary(state: PolicyState): RuleSummary {
  return {
    threshold: state.threshold,
    vetoWindowMinutes: state.vetoWindowMinutes,
    dailyCap: state.effectiveDailyCap,
  };
}

/** `AutoApprovalSettingsResponse` → the two `RuleSummary`s, from `projectPolicyStates`. */
export function projectOperatingRules(
  settings: AutoApprovalSettingsResponse,
  locationId: string,
): OperatingRulesProjection {
  const states = projectPolicyStates(settings, locationId);
  return {
    account: toRuleSummary(states.accountDefault),
    location: toRuleSummary(states.location),
    locationOverrideExists: states.location.rowExists,
  };
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
  operatingRules: OperatingRulesProjection;
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
 * Soft-deleted reviews are excluded too (`REVIEW_STATUS.DELETED`,
 * src/lib/reviews/status.ts): the row survives, the Reviews list does not
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

/**
 * The **Recent completed** read. The window is BOUND from
 * `RECENT_COMPLETED_DAYS` rather than spelled as a literal `INTERVAL '7 days'`:
 * the same constant is what the stored `status` segment reports as
 * `reportingPeriodDays`, and a literal beside it is a number that can drift
 * away from the sentence describing it.
 */
export async function readPosted7d(db: Sql, input: { accountId: string; locationId: string }): Promise<number> {
  const [row] = await db<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM responses resp
    JOIN businesses b ON b.id = resp.business_id
    WHERE b.account_id = ${input.accountId}::uuid
      AND resp.business_id = ${input.locationId}::uuid
      AND resp.status = ${REVIEW_STATUS.POSTED}
      AND resp.posted_at >= NOW() - (${RECENT_COMPLETED_DAYS} * INTERVAL '1 day')
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
  const rows = await db<{ id: string; sequence: number; owner_text: string; reply: unknown }[]>`
    SELECT id, sequence, owner_text, reply
    FROM agent_turns
    WHERE conversation_id = ${input.conversationId}::uuid
      AND account_id = ${input.accountId}::uuid
      AND sequence < ${input.beforeSequence}
      AND status IN (${TURN_STATUS.COMPLETED}, ${TURN_STATUS.FAILED})
    ORDER BY sequence DESC
    LIMIT ${SNAPSHOT_TURN_LIMIT}
  `;
  // ONE batched read for every turn above, not one per turn. What the model
  // sees is the CARD's own words (`describe`, recomputed from the catalog) —
  // never the stored input JSONB, so a summary cannot carry anything the
  // catalog would not print.
  const proposalsByTurn = await listProposalsForTurns(db, {
    turnIds: rows.map((row) => row.id),
    accountId: input.accountId,
  });
  return rows
    .slice()
    .reverse()
    .map((row) => ({
      sequence: row.sequence,
      ownerText: scrubPastedReview(row.owner_text).text,
      replyText: parseReplySegments(row.reply)
        .filter((segment): segment is { type: 'text'; text: string } => segment.type === 'text')
        .map((segment) => segment.text),
      proposalSummaries: (proposalsByTurn.get(row.id) ?? []).map((proposal) => proposal.describe),
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
    // The SINGLE owner of this projection is `projectOperatingRules` above; see
    // its docblock for why the location reads `effective` and why row existence
    // is a separate fact. `AutoApprovalSettingsResponse.accountDefault` is an
    // `AutoApprovalPolicyApiState` and each entry of `locations` is an
    // `AutoApprovalLocationSettings` (both in `src/lib/auto-approval/types.ts`).
    operatingRules: projectOperatingRules(settings, input.locationId),
    // Field-by-field, never a spread: a spread would carry `sampleResponses`
    // (response text) into the snapshot the moment someone adds a field.
    facts: {
      tone: voice?.tone ?? null,
      productsServices: voice?.productsServices ?? null,
      avoidFacts: voice?.avoidFacts ?? [],
      highlightFacts: voice?.highlightFacts ?? [],
    },
    // Readiness is attached to the policy operations, never used to hide them:
    // it blocks expansions only, and a Copilot owner can still narrow.
    allowedOperations: modelVisibleOperations(settings.readiness),
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
