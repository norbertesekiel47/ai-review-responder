/**
 * Restraint policy (v-watch): the deterministic, sentiment-blind rule set
 * deciding send vs withhold for each Solicitation candidate.
 *
 * Locked contract: docs/superpowers/specs/2026-07-23-restraint-policy-v-watch.md
 * (#533, built by #542). Sentiment-blindness: ADR 0012 — `recent_negative` is
 * permanently rejected; no sentiment, star rating, or review content may enter
 * this module's inputs or evidence.
 *
 * Pure module: no DB access, no clock reads — `decided_at` and the business
 * category arrive via context, so identical inputs produce identical decisions.
 * Precondition (spec §1 boundary rule): callers pass only valid candidates —
 * ingest hygiene (malformed handles, unparseable/future dates) is #535
 * upload-time rejection, so dates here are trusted `YYYY-MM-DD`/ISO strings.
 *
 * v-watch footnote: `no_consent` (like `suppressed`) cannot fire in v-watch —
 * the #535 consent attestation is blocking, so every uploaded candidate is
 * covered by construction. Both gates ship and are contract-tested so the enum
 * is stable when send-mode lands.
 */

/** Bump when the constants table or gate logic changes (prompt-policy.ts pattern). */
export const RESTRAINT_POLICY_VERSION = 'restraint_v_watch_2026-07-23.1';

/** Closed withhold-reason enum, listed in precedence order (spec §2). */
export const WITHHOLD_REASONS = [
  'no_consent',
  'suppressed',
  'already_reviewed',
  'stale_visit',
  'over_contacted',
  'velocity_banked',
] as const;
export type WithholdReason = (typeof WITHHOLD_REASONS)[number];

/** Closed vertical enum (spec §3.1). */
export const VERTICALS = [
  'food_and_drink',
  'retail',
  'personal_care',
  'fitness',
  'medical_dental',
  'automotive',
  'home_services',
  'other',
] as const;
export type Vertical = (typeof VERTICALS)[number];

// ---------------------------------------------------------------------------
// Tunable day-one constants (spec §3.2, §5.3) — one table, single owner.
// Replaced by learned curves later behind the same gates; every evidence
// snapshot records the value that was applied.
// ---------------------------------------------------------------------------

/** Hard freshness window per vertical: stale iff today − last_visit > window. */
export const FRESHNESS_WINDOW_DAYS: Record<Vertical, number> = {
  food_and_drink: 14,
  retail: 14,
  personal_care: 21,
  fitness: 21,
  medical_dental: 30,
  automotive: 30,
  home_services: 45,
  other: 30,
};

/** Day-one batch cap (spec §5.3). */
export const BATCH_CAP = 25;

/**
 * Day-one minimum days between would-have-sent inclusions of the same
 * candidate. The spec locks over_contacted's evidence shape but no day-one
 * value; 30 is the conservative middle, free to tune in watch-mode. A gap of
 * exactly MIN_GAP_DAYS is allowed (symmetric with stale_visit's boundary).
 */
export const MIN_GAP_DAYS = 30;

// ---------------------------------------------------------------------------
// Inputs — loaded entirely by the caller (#543); no PII beyond what gates need,
// and never any sentiment or rating field (ADR 0012).
// ---------------------------------------------------------------------------

export interface AskCandidate {
  /** contacts row id (UUIDv7) — the only candidate reference evidence carries. */
  contactId: string;
  /** Most recent visit date (visits ledger), YYYY-MM-DD. */
  lastVisitDate: string;
  /** Attestation coverage inherited from the upload (#535 §4). */
  consent: { attested: boolean; uploadId: string };
  /** Suppression-ledger hit, if any (no v-watch source; send-mode scope). */
  suppression: { source: string; suppressedAt: string } | null;
  /** Existing review matched to this contact — any rating; the rating itself is never an input. */
  matchedReview: { reviewId: string; reviewDate: string } | null;
  /** Most recent would-have-sent inclusion in a prior batch (simulated contact history). */
  priorBatch: { batchId: string; decidedAt: string } | null;
}

export interface BatchContext {
  /** Decision timestamp (ISO 8601). "Today" for gate arithmetic is its UTC date. */
  decidedAt: string;
  /** Owner-typed free text `businesses.category`; resolved via resolveVertical. */
  businessCategory: string | null;
}

// ---------------------------------------------------------------------------
// Decisions — evidence field names are snake_case verbatim from the spec §4
// table: they are a serialization contract (stored in JSONB, rendered by the
// batch UI), not internal TS shape.
// ---------------------------------------------------------------------------

export type WithholdEvidence =
  | { reason: 'no_consent'; upload_id: string }
  | { reason: 'suppressed'; suppression_source: string; suppressed_at: string }
  | { reason: 'already_reviewed'; review_id: string; review_date: string }
  | {
      reason: 'stale_visit';
      last_visit_date: string;
      days_since_visit: number;
      vertical: Vertical;
      matched_keyword: string | null;
      freshness_window_days: number;
    }
  | { reason: 'over_contacted'; prior_batch_id: string; prior_decision_at: string; min_gap_days: number }
  | {
      reason: 'velocity_banked';
      batch_cap: number;
      eligible_count: number;
      ordering_basis: { last_visit_date: string; contact_id: string };
    };

/** The five reasons evaluateAsk can assign; velocity_banked is batch-relative and only evaluateBatch assigns it. */
export type PerCandidateWithholdEvidence = Exclude<WithholdEvidence, { reason: 'velocity_banked' }>;

interface DecisionEnvelope {
  contact_id: string;
  policy_version: typeof RESTRAINT_POLICY_VERSION;
  decided_at: string;
}

export type SendDecision = DecisionEnvelope & { decision: 'send' };
export type WithholdDecision = DecisionEnvelope & { decision: 'withhold' } & WithholdEvidence;
export type PerCandidateDecision = SendDecision | (DecisionEnvelope & { decision: 'withhold' } & PerCandidateWithholdEvidence);
export type AskDecision = SendDecision | WithholdDecision;

// ---------------------------------------------------------------------------
// Vertical resolution (spec §3.1): pure, deterministic keyword mapper.
// ---------------------------------------------------------------------------

export interface VerticalResolution {
  vertical: Vertical;
  matchedKeyword: string | null;
}

/**
 * Ordered specific-first; within a vertical, keywords are checked in listed
 * order and the first left-word-boundary match wins (stems like "plumb" match
 * "plumbing"; "car" cannot match "carpet"). `retail` is last: its keywords are
 * the most generic.
 */
const VERTICAL_KEYWORDS: ReadonlyArray<readonly [Vertical, ReadonlyArray<string>]> = [
  ['medical_dental', ['dental', 'dentist', 'orthodont', 'medical', 'clinic', 'doctor', 'physician', 'pediatric', 'chiropract', 'optometr', 'veterinar', 'urgent care', 'dermatolog']],
  ['automotive', ['auto', 'car wash', 'car repair', 'tire', 'mechanic', 'oil change', 'body shop', 'collision', 'dealership', 'smog']],
  ['home_services', ['plumb', 'roof', 'hvac', 'electric', 'landscap', 'contractor', 'pest', 'cleaning', 'painting', 'remodel', 'handyman', 'mover', 'moving', 'locksmith', 'garage door']],
  ['personal_care', ['salon', 'spa', 'barber', 'nail', 'lash', 'brow', 'beauty', 'hair', 'massage', 'tattoo', 'waxing', 'tanning']],
  ['fitness', ['gym', 'fitness', 'yoga', 'pilates', 'crossfit', 'martial arts', 'dance studio', 'personal train', 'boxing']],
  ['food_and_drink', ['restaurant', 'cafe', 'coffee', 'bakery', 'bar', 'pizza', 'food', 'diner', 'bistro', 'grill', 'pub', 'brewery', 'deli', 'taco', 'sushi', 'bbq', 'juice', 'ice cream', 'catering']],
  ['retail', ['shop', 'store', 'boutique', 'retail', 'market', 'florist', 'jewel', 'bookstore', 'clothing', 'furniture', 'pet supply']],
];

/** Resolve the owner-typed category text to a Vertical; `other` when unmapped. */
export function resolveVertical(businessCategory: string | null): VerticalResolution {
  const normalized = (businessCategory ?? '').toLowerCase();
  if (normalized.length > 0) {
    for (const [vertical, keywords] of VERTICAL_KEYWORDS) {
      for (const keyword of keywords) {
        if (new RegExp(`\\b${keyword}`).test(normalized)) {
          return { vertical, matchedKeyword: keyword };
        }
      }
    }
  }
  return { vertical: 'other', matchedKeyword: null };
}

// ---------------------------------------------------------------------------
// Date arithmetic — calendar-day differences on UTC dates.
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** UTC day number of a YYYY-MM-DD date (or the date part of an ISO timestamp). */
function utcDayNumber(date: string): number {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  return Date.UTC(year, month - 1, day) / DAY_MS;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Run the five per-candidate gates in precedence order (spec §2):
 * no_consent → suppressed → already_reviewed → stale_visit → over_contacted.
 * First failing gate wins; a withhold carries exactly one reason.
 * velocity_banked is batch-relative — use evaluateBatch for the complete decision.
 */
export function evaluateAsk(candidate: AskCandidate, context: BatchContext): PerCandidateDecision {
  const envelope: DecisionEnvelope = {
    contact_id: candidate.contactId,
    policy_version: RESTRAINT_POLICY_VERSION,
    decided_at: context.decidedAt,
  };

  if (!candidate.consent.attested) {
    return { ...envelope, decision: 'withhold', reason: 'no_consent', upload_id: candidate.consent.uploadId };
  }

  if (candidate.suppression !== null) {
    return {
      ...envelope,
      decision: 'withhold',
      reason: 'suppressed',
      suppression_source: candidate.suppression.source,
      suppressed_at: candidate.suppression.suppressedAt,
    };
  }

  if (candidate.matchedReview !== null) {
    return {
      ...envelope,
      decision: 'withhold',
      reason: 'already_reviewed',
      review_id: candidate.matchedReview.reviewId,
      review_date: candidate.matchedReview.reviewDate,
    };
  }

  const today = utcDayNumber(context.decidedAt);
  const daysSinceVisit = today - utcDayNumber(candidate.lastVisitDate);
  const { vertical, matchedKeyword } = resolveVertical(context.businessCategory);
  const windowDays = FRESHNESS_WINDOW_DAYS[vertical];
  if (daysSinceVisit > windowDays) {
    return {
      ...envelope,
      decision: 'withhold',
      reason: 'stale_visit',
      last_visit_date: candidate.lastVisitDate,
      days_since_visit: daysSinceVisit,
      vertical,
      matched_keyword: matchedKeyword,
      freshness_window_days: windowDays,
    };
  }

  if (candidate.priorBatch !== null && today - utcDayNumber(candidate.priorBatch.decidedAt) < MIN_GAP_DAYS) {
    return {
      ...envelope,
      decision: 'withhold',
      reason: 'over_contacted',
      prior_batch_id: candidate.priorBatch.batchId,
      prior_decision_at: candidate.priorBatch.decidedAt,
      min_gap_days: MIN_GAP_DAYS,
    };
  }

  return { ...envelope, decision: 'send' };
}

/** Most-recent-visit-first; ties on contact row ID ascending (UUIDv7 is time-ordered) so ordering is total. */
function byBankingPriority(a: AskCandidate, b: AskCandidate): number {
  if (a.lastVisitDate !== b.lastVisitDate) {
    return a.lastVisitDate < b.lastVisitDate ? 1 : -1;
  }
  return a.contactId < b.contactId ? -1 : a.contactId > b.contactId ? 1 : 0;
}

/**
 * The complete batch evaluation: evaluateAsk per candidate, then the
 * batch-relative velocity gate (spec §2, §5.2–5.3) — when more than BATCH_CAP
 * candidates survive every per-candidate gate, keep the freshest visits and
 * bank the rest as velocity_banked. Returns one decision per candidate, in
 * input order.
 */
export function evaluateBatch(candidates: AskCandidate[], context: BatchContext): AskDecision[] {
  const evaluated = candidates.map((candidate) => ({ candidate, decision: evaluateAsk(candidate, context) }));
  const eligible = evaluated.filter(({ decision }) => decision.decision === 'send');

  if (eligible.length <= BATCH_CAP) {
    return evaluated.map(({ decision }) => decision);
  }

  const kept = new Set(
    eligible
      .map(({ candidate }) => candidate)
      .sort(byBankingPriority)
      .slice(0, BATCH_CAP)
      .map((candidate) => candidate.contactId),
  );

  return evaluated.map(({ candidate, decision }) => {
    if (decision.decision !== 'send' || kept.has(candidate.contactId)) {
      return decision;
    }
    return {
      contact_id: candidate.contactId,
      policy_version: RESTRAINT_POLICY_VERSION,
      decided_at: context.decidedAt,
      decision: 'withhold',
      reason: 'velocity_banked',
      batch_cap: BATCH_CAP,
      eligible_count: eligible.length,
      ordering_basis: { last_visit_date: candidate.lastVisitDate, contact_id: candidate.contactId },
    };
  });
}
