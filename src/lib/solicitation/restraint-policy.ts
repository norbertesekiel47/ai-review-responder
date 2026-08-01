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
 * That precondition is now ENFORCED, not merely documented: a date this module
 * cannot trust throws `RestraintPolicyDateError` rather than degrading to a
 * decision. See utcDayNumber — the previous NaN path decided `send`.
 *
 * v-watch footnote: `no_consent` CAN fire since #625 — the caller derives
 * consent from the consent ledger (`solicitation_consent`) gated by the
 * SEND_ELIGIBLE_ATTESTATION_VERSIONS allowlist (src/lib/solicitation/
 * attestation.ts), so a candidate with no ledger row, or a row whose
 * attestation_version is not send-eligible (v1), withholds here.
 * `suppressed` still has no v-watch source and stays contract-tested for
 * enum stability until send-mode lands.
 */

/**
 * Bump when the constants table or gate logic changes (prompt-policy.ts pattern).
 * The date names the locked spec, which is unchanged; the serial names the
 * ruleset. `.2` (#555): the vertical keyword table gained whole-word matching
 * plus `barre`/`kitchen`, and unparseable dates now throw instead of resolving
 * to `send` — so a decision made under `.1` is not reproducible under `.2`, and
 * stored evidence must stay attributable to the ruleset that produced it.
 * `.3` (#620 §6.2, built by #625): the no_consent evidence serialization
 * changed (nullable upload_id + attestation_version) AND no_consent gained
 * discriminating power — consent now derives from the consent ledger + the
 * SEND_ELIGIBLE_ATTESTATION_VERSIONS allowlist instead of the tautological
 * upload expression — so a candidate deciding `send` under `.2` can decide
 * withhold/no_consent under `.3`, which is exactly the bump criterion above.
 */
export const RESTRAINT_POLICY_VERSION = 'restraint_v_watch_2026-07-23.3';

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
  /**
   * Attestation coverage resolved by the caller from the consent ledger +
   * SEND_ELIGIBLE_ATTESTATION_VERSIONS allowlist (#620 §6.1). uploadId /
   * attestationVersion are the ledger row's provenance; both null when no
   * row exists for the handle (no_consent case (a)), both populated when a
   * row exists but its version is not send-eligible (case (b)).
   */
  consent: { attested: boolean; uploadId: string | null; attestationVersion: string | null };
  /** Suppression-ledger hit, if any (no v-watch source; send-mode scope). */
  suppression: { source: string; suppressedAt: string } | null;
  /** Existing review matched to this contact — any rating; the rating itself is never an input. */
  matchedReview: { reviewId: string; reviewDate: string } | null;
  /** Most recent would-have-sent inclusion in a prior batch (simulated contact history). */
  priorBatch: { batchId: string; decidedAt: string } | null;
}

export interface BatchContext {
  /** Decision timestamp (ISO 8601, any offset). "Today" for gate arithmetic is the UTC date of the parsed instant. */
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
  // no_consent (#620 §6.1): case (a) both null — no consent row for this
  // handle at this location; case (b) both populated — a row exists but its
  // attestation_version is not send-eligible (owner remedy: re-upload).
  | { reason: 'no_consent'; upload_id: string | null; attestation_version: string | null }
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
 * order and the first match wins. Most keywords are left-word-boundary stems
 * ("plumb" matches "plumbing"; "car" cannot match "carpet"); the short generic
 * ones in WHOLE_WORD_KEYWORDS below need a right boundary too. `retail` is
 * last: its keywords are the most generic.
 */
const VERTICAL_KEYWORDS: ReadonlyArray<readonly [Vertical, ReadonlyArray<string>]> = [
  ['medical_dental', ['dental', 'dentist', 'orthodont', 'medical', 'clinic', 'doctor', 'physician', 'pediatric', 'chiropract', 'optometr', 'veterinar', 'urgent care', 'dermatolog']],
  ['automotive', ['auto', 'car wash', 'car repair', 'tire', 'mechanic', 'oil change', 'body shop', 'collision', 'dealership', 'smog']],
  ['home_services', ['plumb', 'roof', 'hvac', 'electric', 'landscap', 'contractor', 'pest', 'cleaning', 'painting', 'remodel', 'handyman', 'mover', 'moving', 'locksmith', 'garage door']],
  ['personal_care', ['salon', 'spa', 'barber', 'nail', 'lash', 'brow', 'beauty', 'hair', 'massage', 'tattoo', 'waxing', 'tanning']],
  ['fitness', ['gym', 'fitness', 'yoga', 'pilates', 'crossfit', 'barre', 'martial arts', 'dance studio', 'personal train', 'boxing']],
  ['food_and_drink', ['restaurant', 'cafe', 'coffee', 'bakery', 'bar', 'pizza', 'food', 'diner', 'bistro', 'grill', 'kitchen', 'pub', 'brewery', 'deli', 'taco', 'sushi', 'bbq', 'juice', 'ice cream', 'catering']],
  ['retail', ['shop', 'store', 'boutique', 'retail', 'market', 'florist', 'jewel', 'bookstore', 'clothing', 'furniture', 'pet supply']],
];

/**
 * Keywords matched as WHOLE words (plus an optional plural `s`) instead of as
 * stems. Every entry is a short generic word whose stem match reaches into
 * unrelated vocabulary and silently mis-verticals a business — which changes
 * its freshness window, so a stem collision is a wrong send/withhold decision,
 * not a cosmetic mislabel:
 *
 *   bar    → "barre" (fitness, 21d) and "bargain"   pest → "pesto"
 *   spa    → "space", "sparkle"                     brow → "brown"
 *   pub    → "public"                               deli → "delivery"
 *   market → "marketing"
 *
 * Everything else stays a stem so "plumb" still matches "plumbing". Ordering
 * does the rest of the work: "barber" is checked under personal_care before
 * food_and_drink is reached, and "remodel" under home_services before
 * "kitchen" under food_and_drink.
 */
const WHOLE_WORD_KEYWORDS: ReadonlySet<string> = new Set([
  'bar',
  'brow',
  'deli',
  'market',
  'pest',
  'pub',
  'spa',
]);

/** Keyword matchers, compiled once at module load (not per candidate). */
const VERTICAL_KEYWORD_MATCHERS: ReadonlyArray<
  readonly [Vertical, ReadonlyArray<{ keyword: string; pattern: RegExp }>]
> = VERTICAL_KEYWORDS.map(
  ([vertical, keywords]) =>
    [
      vertical,
      keywords.map((keyword) => ({
        keyword,
        pattern: WHOLE_WORD_KEYWORDS.has(keyword)
          ? new RegExp(`\\b${keyword}s?\\b`)
          : new RegExp(`\\b${keyword}`),
      })),
    ] as const,
);

/** Resolve the owner-typed category text to a Vertical; `other` when unmapped. */
export function resolveVertical(businessCategory: string | null): VerticalResolution {
  const normalized = (businessCategory ?? '').toLowerCase();
  if (normalized.length > 0) {
    for (const [vertical, matchers] of VERTICAL_KEYWORD_MATCHERS) {
      for (const { keyword, pattern } of matchers) {
        if (pattern.test(normalized)) {
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

/** Plain calendar date, the shape a `date` column yields via `::text`. */
const PLAIN_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * ISO 8601 date-time carrying an EXPLICIT UTC offset — `Z` or `±hh:mm`.
 * Offset-less forms (`2026-07-23T12:00:00`) are rejected on purpose: ECMAScript
 * parses those in the HOST's local zone, so the identical input would decide
 * differently on a developer laptop and on the Railway worker. A restraint
 * policy whose output depends on where it runs is not deterministic, and
 * "pure module, identical inputs produce identical decisions" is this module's
 * headline contract.
 */
const OFFSET_DATE_TIME =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}(?::?\d{2})?)$/;

/**
 * `Z` | `+00` | `+0530` | `+05:30` → the `±hh:mm` form ECMAScript defines.
 * Postgres renders `timestamptz` as `2026-07-27 06:49:35.109+00` — a SPACE
 * separator and a TWO-digit offset — and that is what `prior_batch.decided_at`
 * actually arrives as, having been read back out of a stored ask. Both forms
 * are outside the ISO grammar `Date.parse` is required to support, so they fall
 * to each engine's legacy parser. Canonicalizing first is what keeps parsing
 * spec-defined instead of V8-defined.
 */
function normalizeUtcOffset(offset: string): string {
  if (offset === 'Z') return 'Z';
  const digits = offset.slice(1).replace(':', '');
  return `${offset[0]}${digits.slice(0, 2)}:${digits.slice(2) || '00'}`;
}

/**
 * A date reached the policy that it cannot trust. Callers guarantee valid dates
 * (#535 rejects malformed ones at upload time), so this is a contract
 * violation, not an expected domain failure — it names the offending field so
 * the fix is obvious rather than requiring a bisect.
 */
export class RestraintPolicyDateError extends Error {
  constructor(field: string, value: string) {
    super(
      `restraint-policy: ${field} is not a trusted date — expected YYYY-MM-DD, or an ISO ` +
        `timestamp with an explicit UTC offset, got ${JSON.stringify(value)}`,
    );
    this.name = 'RestraintPolicyDateError';
  }
}

/**
 * UTC day number of a plain YYYY-MM-DD date, or — for ISO timestamps with an
 * explicit offset — of the parsed instant's UTC date. Timestamps are parsed,
 * never lexically sliced: slicing the date part of an offset timestamp
 * mis-dates instants that cross midnight UTC.
 *
 * FAIL-CLOSED. Anything unparseable throws rather than yielding NaN. NaN
 * propagates into `today - NaN`, and every subsequent comparison against NaN is
 * false — so `stale_visit` and `over_contacted` would both silently pass and
 * the policy would decide **send**. The one component whose entire purpose is
 * restraint must not fail in the direction of contacting people.
 */
function utcDayNumber(value: string, field: string): number {
  const plain = PLAIN_DATE.exec(value);
  if (plain) {
    const milliseconds = Date.UTC(Number(plain[1]), Number(plain[2]) - 1, Number(plain[3]));
    // Date.UTC ROLLS OVER: 2026-02-30 becomes March 2 rather than failing, so a
    // syntactically valid but non-existent date would silently become a real
    // one. Round-tripping is what catches that.
    if (new Date(milliseconds).toISOString().startsWith(value)) return milliseconds / DAY_MS;
    throw new RestraintPolicyDateError(field, value);
  }

  const stamp = OFFSET_DATE_TIME.exec(value);
  if (stamp) {
    const milliseconds = Date.parse(`${stamp[1]}T${stamp[2]}${normalizeUtcOffset(stamp[3]!)}`);
    if (!Number.isNaN(milliseconds)) return Math.floor(milliseconds / DAY_MS);
  }
  throw new RestraintPolicyDateError(field, value);
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
    return {
      ...envelope,
      decision: 'withhold',
      reason: 'no_consent',
      upload_id: candidate.consent.uploadId,
      attestation_version: candidate.consent.attestationVersion,
    };
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

  const today = utcDayNumber(context.decidedAt, 'decided_at');
  const daysSinceVisit = today - utcDayNumber(candidate.lastVisitDate, 'last_visit_date');
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

  if (
    candidate.priorBatch !== null &&
    today - utcDayNumber(candidate.priorBatch.decidedAt, 'prior_batch.decided_at') < MIN_GAP_DAYS
  ) {
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
