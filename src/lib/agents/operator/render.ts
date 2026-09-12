// Deterministic rendering and validation for Owner Operator replies. Pure: no
// database, no clock of its own, no network. `validateModelOutput` is the
// gate the model cannot talk its way past (spec §5.5).
import { proposableOperation } from './catalog';
import type { Snapshot } from './context';
import {
  SERVER_NOTICE,
  STATUS_METRICS,
  type ModelOutput,
  type ServerNotice,
  type StatusMetric,
  type StoredSegment,
} from './schema';

export const REVIEW_TEXT_REMOVED_MARKER = '[review text removed]';

export const PASTED_REVIEW_SEGMENT =
  'I do not read review text here. Open it in the Reviews list to draft a reply.';

// ── Pasted-review scrub ───────────────────────────────────────────────────

/**
 * A RATING LINE, not a rating mention. The distinction is the whole design: an
 * owner saying "change my tone for 4 and 5 star reviews" is giving an
 * instruction, and scrubbing that paragraph would delete the request itself.
 * A pasted review instead OPENS with a rating on a line of its own ("5/5",
 * "Rated: 4 stars", "five stars", "★★★★★"), which is what this matches.
 */
const RATING_LINE_PATTERN =
  /^[ \t]*(?:rating|rated)?[ \t]*:?[ \t]*(?:[1-5](?:\.\d)?[ \t]*(?:\/[ \t]*5|out of 5|stars?|★+)|★{2,}|(?:one|two|three|four|five)[ \t]+stars?)[ \t]*$/im;
/** A byline, in either order: "Reviewed by Alex", "Alex wrote:". */
const REVIEWER_PATTERN =
  /\b(?:reviewed by|posted by|left a review)\b|\b[A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+wrote:|\bwrote:/;
/** Spec §3.4: more than 300 characters of QUOTED prose — quoted, not merely long. */
const QUOTED_BLOCK_PATTERN = /["“][\s\S]{300,}["”]/;
/** A rating line alone is a HEADER: the body it introduces is the next block. */
const RATING_HEADER_MAX_LENGTH = 40;

/**
 * The **Pasted-review scrub**: replaces review-shaped BLOCKS with the marker
 * and leaves the rest of the message alone. Block-level, not message-level, so
 * an owner who quotes a review and then asks a real question keeps the
 * question.
 *
 * There is deliberately NO bare length rule. "More than 300 characters" in the
 * spec qualifies QUOTED prose; a long unquoted instruction is an owner talking
 * at length, and scrubbing it would silently drop the thing the turn is about.
 *
 * There is also deliberately NO marker short-circuit. An earlier draft skipped
 * any block already containing `REVIEW_TEXT_REMOVED_MARKER`, which let an owner
 * (or anything pasted into the composer) TYPE the marker and carry a review
 * body past the scrub in the same block. Re-scrubbing an already-scrubbed
 * message is idempotent because a bare marker matches none of the three
 * patterns and is left alone on its own merits.
 *
 * A short rating LINE is a header, not the review: it introduces the body in
 * the following block, so matching one scrubs both.
 *
 * The caller stores `owner_text` VERBATIM and passes the scrubbed text to the
 * **Context snapshot** and the prompt. This function never sees the stored row.
 */
export function scrubPastedReview(text: string): { text: string; scrubbed: boolean } {
  const blocks = text.split(/\n\s*\n/);
  const drop = new Set<number>();

  blocks.forEach((block, index) => {
    const ratingLine = RATING_LINE_PATTERN.test(block);
    if (ratingLine || REVIEWER_PATTERN.test(block) || QUOTED_BLOCK_PATTERN.test(block)) {
      drop.add(index);
    }
    // "5/5" on its own, then the review in the next block.
    if (ratingLine && block.trim().length <= RATING_HEADER_MAX_LENGTH && index + 1 < blocks.length) {
      drop.add(index + 1);
    }
  });

  if (drop.size === 0) return { text, scrubbed: false };
  return {
    text: blocks.map((block, index) => (drop.has(index) ? REVIEW_TEXT_REMOVED_MARKER : block)).join('\n\n'),
    scrubbed: true,
  };
}

// ── Text-segment patterns (spec §3.4) ─────────────────────────────────────

// EXACTLY the spec §3.4 list. `stars` is deliberately absent: "4 and 5 star
// reviews" is legitimate model text naming a band, not an invented count, and
// including it would reject the most natural sentence about a scope rule.
const METRIC_WORDS = 'reviews|replies|drafts|pending|posted|days|hours';
const INVENTED_COUNT_PATTERN = new RegExp(
  `\\b\\d+\\b[^.!?]{0,24}\\b(?:${METRIC_WORDS})\\b|\\b(?:${METRIC_WORDS})\\b[^.!?]{0,24}\\b\\d+\\b`,
  'i',
);
const COMPLETION_CLAIM_PATTERN =
  /\b(?:applied|changed|updated|saved|done|now active|i(?:'ve| have) (?:set|changed|updated|saved))\b/i;

export type ValidationResult =
  | { ok: true; output: ModelOutput }
  | { ok: false; reasons: string[] };

/**
 * Semantic validation over an ALREADY shape-valid output (the zod schema ran
 * at the seam). Every rejection reason is a short token the retry prompt can
 * quote back; none of them carries owner text or provider output.
 */
export function validateModelOutput(output: ModelOutput, snapshot: Snapshot): ValidationResult {
  const reasons: string[] = [];
  const metrics = new Set<string>(STATUS_METRICS);

  for (const segment of output.segments) {
    if (segment.type === 'text') {
      if (INVENTED_COUNT_PATTERN.test(segment.text)) {
        reasons.push('a text segment states a count next to a metric word; use a status_ref instead');
      }
      if (COMPLETION_CLAIM_PATTERN.test(segment.text)) {
        reasons.push('a text segment claims a completion; nothing is applied until the owner clicks');
      }
    }
    if (segment.type === 'status_ref' && !metrics.has(segment.metric)) {
      reasons.push(`status_ref names a metric outside the snapshot: ${segment.metric}`);
    }
    if (segment.type === 'proposal_ref' && segment.index >= output.proposals.length) {
      reasons.push('proposal_ref points at a proposal index that was not returned');
    }
    if (segment.type === 'scope_check') {
      if (segment.locationId === snapshot.locationId) {
        reasons.push('scope_check names the location this turn is already prepared for');
      } else if (!snapshot.locations.some((l) => l.id === segment.locationId)) {
        reasons.push('scope_check names a location outside this account');
      }
    }
  }

  const hasScopeCheck = output.segments.some((s) => s.type === 'scope_check');
  const targetsStoredLocation = output.proposals.some(
    (p) => p.scope.locationId === snapshot.locationId,
  );
  if (hasScopeCheck && targetsStoredLocation) {
    reasons.push('a scope_check and a proposal for the stored location cannot coexist');
  }

  for (const proposal of output.proposals) {
    const operation = proposableOperation(proposal.operation);
    if (!operation) {
      reasons.push(`proposal names an operation outside the catalog: ${proposal.operation}`);
      continue;
    }
    if (!snapshot.allowedOperations.some((op) => op.id === operation.id)) {
      reasons.push(`proposal names an operation this account may not use: ${proposal.operation}`);
    }
    if (proposal.scope.accountId !== snapshot.accountId) {
      reasons.push('proposal scope names another account');
    }
    // Scope is the stored location, or the account default (no locationId).
    if (proposal.scope.locationId !== undefined && proposal.scope.locationId !== snapshot.locationId) {
      reasons.push('proposal scope is neither the stored location nor the account default');
    }
    // A location-scoped operation with NO locationId would otherwise store a
    // NULL target and read back as an account-default proposal it is not. Every
    // Run A operation is `scopeRule: 'location'`, so this is the common case,
    // not an edge one.
    if (operation.scopeRule === 'location' && proposal.scope.locationId === undefined) {
      reasons.push(`proposal scope must name the stored location for ${proposal.operation}`);
    }
    if (!operation.parseInput(proposal.input).ok) {
      reasons.push(`proposal input is outside the domain for ${proposal.operation}`);
    }
  }

  return reasons.length === 0 ? { ok: true, output } : { ok: false, reasons };
}

// ── Rendering ─────────────────────────────────────────────────────────────

export interface RenderContext {
  /** Stored **Proposal** ids, in the order the model returned them. */
  proposalIds: readonly string[];
  /** The account's active locations, for a `scope_check`'s display name. */
  locations: readonly { id: string; name: string }[];
}

/** Closed token → the sentence the owner reads. Owned here, not in the row. */
const SERVER_NOTICE_TEXT: Record<ServerNotice, string> = {
  [SERVER_NOTICE.PASTED_REVIEW_REMOVED]: PASTED_REVIEW_SEGMENT,
};

export type RenderedSegment =
  | { type: 'text'; text: string }
  | { type: 'question'; text: string }
  | { type: 'status'; metric: StatusMetric; value: number; reportingPeriodDays: number; asOf: string }
  | { type: 'proposal'; proposalId: string }
  | { type: 'scope_check'; locationId: string; locationName: string }
  | { type: 'notice'; text: string };

/**
 * Stored **Reply segment**s → what the screen shows. A PURE MAPPING: it reads
 * no metrics and issues no query, because a stored `status` segment already
 * carries the value, its reporting period and the instant it was read at.
 *
 * That is the point. Resolving a metric name at GET would re-read today's
 * counts — for whatever location the caller passed — and paint them onto a
 * sentence written days ago about a different number.
 */
export function renderSegments(
  segments: readonly StoredSegment[],
  context: RenderContext,
): RenderedSegment[] {
  const rendered: RenderedSegment[] = [];
  for (const segment of segments) {
    switch (segment.type) {
      case 'text':
      case 'question':
        rendered.push({ type: segment.type, text: segment.text });
        break;
      // The scrub notice is STORED, so a refresh renders it again — it is not
      // re-derived from a flag the GET route does not have.
      case 'server_notice':
        rendered.push({ type: 'notice', text: SERVER_NOTICE_TEXT[segment.notice] });
        break;
      // Passthrough: the value was frozen at completion.
      case 'status':
        rendered.push({
          type: 'status',
          metric: segment.metric,
          value: segment.value,
          reportingPeriodDays: segment.reportingPeriodDays,
          asOf: segment.asOf,
        });
        break;
      case 'proposal_ref': {
        const proposalId = context.proposalIds[segment.index];
        if (proposalId) rendered.push({ type: 'proposal', proposalId });
        break;
      }
      case 'scope_check': {
        const location = context.locations.find((l) => l.id === segment.locationId);
        if (location) {
          rendered.push({ type: 'scope_check', locationId: location.id, locationName: location.name });
        }
        break;
      }
    }
  }
  return rendered;
}
