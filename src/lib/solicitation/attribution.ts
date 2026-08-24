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
