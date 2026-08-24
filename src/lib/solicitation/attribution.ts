/**
 * Review attribution (#632) — the shadow, never-billed `review_attributed`
 * outcome. Spec: 2026-07-28-send-mode-executor-approval-design.md D14/D16.
 *
 * Attribution is a LOOKBACK evaluated when a review arrives (D16b), never a
 * timer: May §6.3's `wait_for_async_signals` presumes an engine that can park
 * a step, and D17 declined to build one. The 14 days are a filter constant.
 *
 * D16d is binding: there is NO deterministic contact-to-review identity seam.
 * A Google review carries a display name and a date, nothing else. This module
 * does not claim to solve that — it abstains rather than guesses, which is why
 * map #617 decision 1 keeps the metric shadow / no-charge.
 *
 * Domain module — receives its DB client explicitly (invariant #15); it never
 * imports the singleton. Every query carries BOTH account_id and business_id
 * (invariant #8).
 */

import type { Sql, TransactionSql } from 'postgres';
import { recordOutcome } from '@/lib/agents/run-spine';
import { reviewTimeAnchor } from '@/lib/kpi/fragments';

/** The Attribution window (May §6.4, spec D16b). The ONE owner of this number. */
export const ATTRIBUTION_WINDOW_DAYS = 14;

/** How far back the owner-facing list reaches. Presentation only. */
export const ATTRIBUTION_DISPLAY_WINDOW_DAYS = 30;

/** Stamped into attribution_detail so a stored verdict stays attributable to
 *  the ruleset that produced it — the ASK_LINT_VERSION precedent. */
export const ATTRIBUTION_MATCHER_VERSION = 'attribution_v1';

/** Byte-matches migration 114's CHECK. */
export const ATTRIBUTION_RULES = ['full_name', 'first_last_initial'] as const;
export type AttributionRule = (typeof ATTRIBUTION_RULES)[number];

export interface AttributionCandidate {
  outreachId: string;
  contactName: string;
  sentAt: string;
  /** NULL when the Lazy child was never minted — columns still get written. */
  agentRunId: string | null;
}

export type AttributionMatch =
  | { resolution: 'attributed'; candidate: AttributionCandidate; rule: AttributionRule }
  | { resolution: 'no_candidates' }
  | { resolution: 'no_match'; candidateCount: number }
  | { resolution: 'ambiguous'; candidateCount: number };

/**
 * NFD, strip combining marks, lowercase, punctuation to space, collapse.
 * Follows `normalizeName` in src/lib/reviews/place-id-resolver.ts.
 */
export function normalizePersonName(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(raw: string): string[] {
  const normalized = normalizePersonName(raw);
  return normalized.length === 0 ? [] : normalized.split(' ');
}

const isInitial = (token: string): boolean => token.length === 1;

/** Equal, or one side is an initial the other side starts with. */
function compatible(a: string, b: string): boolean {
  if (a === b) return true;
  if (isInitial(a) && b.startsWith(a)) return true;
  if (isInitial(b) && a.startsWith(b)) return true;
  return false;
}

/**
 * The rule, and why each arm exists:
 *   - BOTH sides need >= 2 tokens. A bare first name is a coincidence as often
 *     as a signal, and precision is what the future M3 bar is judged on.
 *   - first AND last must be `compatible`. Middles are ignored, so
 *     "dana m rodriguez" still matches "dana rodriguez".
 *   - At least one position must be a FULL-token match. Without it,
 *     "d. rodriguez" would match "dana r." on two initials and no evidence.
 */
function ruleFor(contactName: string, reviewerName: string): AttributionRule | null {
  const a = tokens(contactName);
  const b = tokens(reviewerName);
  if (a.length < 2 || b.length < 2) return null;

  const firstA = a[0]!, lastA = a[a.length - 1]!;
  const firstB = b[0]!, lastB = b[b.length - 1]!;

  if (!compatible(firstA, firstB) || !compatible(lastA, lastB)) return null;

  const firstExact = firstA === firstB;
  const lastExact = lastA === lastB;
  if (!firstExact && !lastExact) return null;

  return firstExact && lastExact ? 'full_name' : 'first_last_initial';
}

/**
 * Pure. Two or more matches ABSTAIN (grilling decision): a shadow metric that
 * guesses is worse than one that abstains, and the abstention rate is the
 * direct input to the M3 precision question.
 */
export function matchAttribution(
  reviewerName: string | null,
  candidates: AttributionCandidate[],
): AttributionMatch {
  if (candidates.length === 0) return { resolution: 'no_candidates' };
  const candidateCount = candidates.length;
  if (reviewerName === null || normalizePersonName(reviewerName).length === 0) {
    return { resolution: 'no_match', candidateCount };
  }

  const hits: { candidate: AttributionCandidate; rule: AttributionRule }[] = [];
  for (const candidate of candidates) {
    const rule = ruleFor(candidate.contactName, reviewerName);
    if (rule !== null) hits.push({ candidate, rule });
  }

  if (hits.length === 0) return { resolution: 'no_match', candidateCount };
  if (hits.length > 1) return { resolution: 'ambiguous', candidateCount };
  return { resolution: 'attributed', candidate: hits[0]!.candidate, rule: hits[0]!.rule };
}

interface CandidateRow {
  outreach_id: string;
  contact_name: string;
  sent_at: string;
  agent_run_id: string | null;
}

/**
 * Candidates for one review. Every fixed arm byte-matches migration 114's
 * `solicitation_outreach_attribution_candidates` partial predicate, so the
 * index is used; only the sent_at range is parameterized.
 *
 * Why each exclusion (grilling decisions):
 *   - `delivery_status = 'sent'` — `unknown` is "possibly contacted" for
 *     over-contact purposes and explicitly NOT a confirmed send for
 *     review_attributed (spec D12d).
 *   - bounced / complained — the email never reached the person, so a
 *     same-name review cannot have been caused by it.
 *   - unsubscribed rows STAY eligible: an unsubscribe is evidence the mail was
 *     opened, and the two acts happen in either order.
 *   - already attributed — one Outreach row attributes at most one review,
 *     PERMANENTLY. The marker is `attributed_at`, never `attributed_review_id`:
 *     the FK nulls the review id on delete, and keying on it would resurrect
 *     the row as a candidate and overwrite retained provenance (finding A3).
 *
 * The window is INCLUSIVE at both ends (`<= anchor`, `>= anchor - 14d`). The
 * intake excludes only "MORE than 14 days", so an ask sent exactly 14 days
 * before the anchor is eligible (finding A5).
 *
 * The anchor is composed from `reviewTimeAnchor` (ADR 0019), which is the
 * single owner of the Review-time anchor spelling — `fragments.test.ts` fails
 * if any source file outside it spells that expression, PROSE INCLUDED, so this
 * comment names the fragment rather than the SQL. A review whose anchor
 * precedes sent_at is not a candidate: it existed before the ask.
 *
 * `sent_at` is selected as `::text`. postgres.js decodes timestamptz to a JS
 * `Date` and TRUNCATES microseconds doing it (#520), and this value is both
 * compared against an anchor derived from a sibling row and stamped into
 * `attribution_detail` — keeping it text end to end is the documented escape.
 */
async function loadCandidates(
  tx: TransactionSql,
  input: { reviewId: string; businessId: string; accountId: string },
): Promise<AttributionCandidate[]> {
  const rows = await tx<CandidateRow[]>`
    WITH anchor AS (
      SELECT ${reviewTimeAnchor(tx as unknown as Sql, 'r.')} AS at
        FROM reviews r
        JOIN businesses b ON b.id = r.business_id
       WHERE r.id = ${input.reviewId}::uuid
         AND r.business_id = ${input.businessId}::uuid
         AND b.account_id = ${input.accountId}::uuid
    )
    SELECT o.id AS outreach_id, c.name AS contact_name,
           o.sent_at::text AS sent_at, o.agent_run_id
      FROM solicitation_outreach o
      JOIN solicitation_contacts c
        ON c.id = o.contact_id AND c.business_id = o.business_id
     CROSS JOIN anchor
     WHERE o.business_id = ${input.businessId}::uuid
       AND o.account_id  = ${input.accountId}::uuid
       -- The contact's own tenant predicate, spelled out rather than inherited
       -- through the join key: ci:tenant-scope reads raw template text per
       -- table binding, and solicitation_contacts is scoped by business_id.
       -- (No backticks in a SQL comment inside a template literal — one closes
       -- the literal, and the truncated tail still typechecks.)
       AND c.business_id = ${input.businessId}::uuid
       AND o.delivery_status = 'sent'
       AND o.attributed_at IS NULL
       AND o.bounced_at    IS NULL
       AND o.complained_at IS NULL
       AND o.sent_at IS NOT NULL
       AND o.sent_at <= anchor.at
       AND o.sent_at >= anchor.at - make_interval(days => ${ATTRIBUTION_WINDOW_DAYS})
     ORDER BY o.sent_at DESC
  `;
  return rows.map((row) => ({
    outreachId: row.outreach_id,
    contactName: row.contact_name,
    sentAt: row.sent_at,
    agentRunId: row.agent_run_id,
  }));
}

/**
 * Resolve and record attribution for ONE newly ingested review. Runs inside
 * the caller's transaction, NEVER inside the review-ingest transaction: a
 * matcher fault must not roll back a review write (that is why #632 ships an
 * outbox topic rather than an inline call).
 *
 * Idempotent by construction. The UPDATE's `attributed_at IS NULL` guard plus
 * migration 114's partial unique index make a second run a no-op, and
 * `recordOutcome`'s ON CONFLICT makes the outcome emit-once.
 */
export async function attributeReview(
  tx: TransactionSql,
  input: { reviewId: string; businessId: string },
): Promise<AttributionMatch> {
  // The account is RESOLVED here, never carried on the payload (deviation D3):
  // `accountId` is not in scope at the enqueue site in process-review.ts, and
  // resolving it from the FK removes any way a wrong account id could ride a
  // job. Same shape startReviewRun and maybeEnqueueFirstReviewIngested use.
  const [biz] = await tx<{ account_id: string }[]>`
    SELECT account_id FROM businesses WHERE id = ${input.businessId}::uuid
  `;
  // Unreachable: reviews.business_id's FK guarantees the row. Assert rather
  // than branch around a state the invariants exclude.
  if (biz === undefined) {
    throw new Error(`attributeReview: business ${input.businessId} not found`);
  }
  const accountId = biz.account_id;

  const candidates = await loadCandidates(tx, { ...input, accountId });
  const [review] = await tx<{ reviewer_name: string | null; star_rating: number | null }[]>`
    SELECT reviewer_name, star_rating FROM reviews
     WHERE id = ${input.reviewId}::uuid AND business_id = ${input.businessId}::uuid
  `;
  // A missing review is a caller bug, not a replay: the enqueue happens in the
  // same transaction as the INSERT. Assert rather than branch.
  if (review === undefined) {
    throw new Error(`attributeReview: review ${input.reviewId} not found for business`);
  }

  const match = matchAttribution(review.reviewer_name, candidates);
  if (match.resolution !== 'attributed') return match;

  // NO personal data (deviation D2): no reviewer name, no contact name. Both
  // live in their own tables and the owner surface joins for them; a copy here
  // would outlive the review's deletion, which the FK is ON DELETE SET NULL for.
  const detail = {
    rule: match.rule,
    matcher_version: ATTRIBUTION_MATCHER_VERSION,
    sent_at: match.candidate.sentAt,
    star_rating: review.star_rating,
    candidate_count: candidates.length,
  };

  const updated = await tx<{ id: string }[]>`
    UPDATE solicitation_outreach
       SET attributed_review_id = ${input.reviewId}::uuid,
           attributed_at        = NOW(),
           attribution_rule     = ${match.rule},
           attribution_detail   = ${tx.json(detail as never)},
           updated_at           = NOW()
     WHERE id         = ${match.candidate.outreachId}::uuid
       AND account_id = ${accountId}::uuid
       AND business_id = ${input.businessId}::uuid
       -- attributed_at, NOT attributed_review_id (round-2 finding). The
       -- candidate query and the index both moved to the timestamp marker; this
       -- CAS did not, which left a race: a handler that loaded a candidate
       -- before another attribution AND a subsequent review deletion would see
       -- a NULL review id and overwrite permanent provenance. All FOUR sites —
       -- candidate query, enqueue guard, index predicate, this CAS — must agree.
       AND attributed_at IS NULL
    RETURNING id
  `;
  // Zero rows means a concurrent run already attributed it — a replay, not a
  // failure. Return the match without a second outcome.
  if (updated.count === 0) return match;

  if (match.candidate.agentRunId !== null) {
    await recordOutcome(tx, {
      runId: match.candidate.agentRunId,
      accountId,
      businessId: input.businessId,
      attributedAgent: 'solicitation',
      outcomeKind: 'review_attributed',
      unitCount: 1,
    });
  }
  return match;
}

// ── the owner read model ────────────────────────────────────────────────────

export interface AttributedReviewView {
  outreachId: string;
  reviewId: string;
  reviewerName: string | null;
  starRating: number | null;
  reviewDate: string | null;
  askSentAt: string;
  attributedAt: string;
  rule: AttributionRule;
}

interface AttributedReviewRow {
  outreach_id: string;
  review_id: string;
  reviewer_name: string | null;
  star_rating: number | null;
  review_date: string | null;
  ask_sent_at: string;
  attributed_at: string;
  attribution_rule: AttributionRule;
}

/**
 * Every Attributed review for one location in the display window, newest
 * first. Deliberately NOT part of BatchView: that contract is "the most recent
 * batch", and attribution lands up to ATTRIBUTION_WINDOW_DAYS after a send, by
 * which time a newer batch usually exists. A per-batch surface would hide the
 * common case.
 *
 * ATTRIBUTION_DISPLAY_WINDOW_DAYS is PRESENTATION ONLY, and it is a DIFFERENT
 * number from the matcher's filter: how far back the owner's list reaches, not
 * how far back a review may attribute. Neither is re-spelled anywhere.
 *
 * `sendEnabled` is passed IN, never read here (invariant #13) — the same shape
 * readLatestBatch uses for its send lane, so the browser learns the flag state
 * from the response rather than from a NEXT_PUBLIC companion.
 *
 * Rows whose review has since been deleted drop out: migration 114's FK sets
 * attributed_review_id to NULL and the INNER JOIN then excludes them. The
 * outreach row keeps its attributed_at provenance either way.
 *
 * Timestamps are selected as text end to end, matching the candidate query:
 * postgres.js decodes timestamptz to a JS Date and TRUNCATES microseconds
 * doing it (#520), and this module holds ONE convention across both reads.
 */
export async function listAttributedReviews(
  sql: Sql,
  input: { accountId: string; businessId: string; sendEnabled: boolean },
): Promise<AttributedReviewView[]> {
  if (!input.sendEnabled) return [];

  const rows = await sql<AttributedReviewRow[]>`
    SELECT o.id AS outreach_id, r.id AS review_id, r.reviewer_name,
           r.star_rating, r.review_date::text AS review_date,
           o.sent_at::text       AS ask_sent_at,
           o.attributed_at::text AS attributed_at,
           o.attribution_rule
      FROM solicitation_outreach o
      -- The business predicate on this join is NOT redundant (round-1 finding
      -- A6). The FK binds only reviews(id); it does not bind the review's
      -- business to the outreach row's, so joining on id alone would let one
      -- schema-valid bad write expose another tenant's review on this surface.
      -- (No backticks in a SQL comment inside a tagged template — one closes
      -- the literal, and the truncated tail still typechecks.)
      JOIN reviews r
        ON r.id = o.attributed_review_id
       AND r.business_id = o.business_id
     WHERE o.account_id  = ${input.accountId}::uuid
       AND o.business_id = ${input.businessId}::uuid
       -- The reviews binding is spelled out rather than inherited through the
       -- join key: ci:tenant-scope reads raw template text per table and does
       -- not accept a join key as scope evidence.
       AND r.business_id = ${input.businessId}::uuid
       AND o.attributed_review_id IS NOT NULL
       AND o.attributed_at > NOW() - make_interval(days => ${ATTRIBUTION_DISPLAY_WINDOW_DAYS})
     ORDER BY o.attributed_at DESC
  `;

  return rows.map((row) => ({
    outreachId: row.outreach_id,
    reviewId: row.review_id,
    reviewerName: row.reviewer_name,
    starRating: row.star_rating,
    reviewDate: row.review_date,
    askSentAt: row.ask_sent_at,
    attributedAt: row.attributed_at,
    rule: row.attribution_rule,
  }));
}
