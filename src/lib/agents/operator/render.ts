// Deterministic rendering and validation for Owner Operator replies. Pure: no
// database, no clock of its own, no network. `validateModelOutput` is the
// gate the model cannot talk its way past (spec §5.5).
import { CATALOG, proposableOperation, type PrepareOperation, type ProposableOperation } from './catalog';
import type { Snapshot, SnapshotMetrics } from './context';
import { OPERATOR_REFUSAL_RULES, type OperatorRefusalReason } from './refusals';
import {
  SERVER_NOTICE,
  STATUS_METRICS,
  type ModelOutput,
  type Segment,
  type ServerNotice,
  type StatusMetric,
  type StoredSegment,
} from './schema';

export const REVIEW_TEXT_REMOVED_MARKER = '[review text removed]';

const PASTED_REVIEW_SEGMENT =
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

/**
 * One proposal the validator ACCEPTED, carrying the work it already did: the
 * resolved catalog entry and the narrowed input from that entry's own schema.
 *
 * This exists so the row builder does not repeat the lookup and the parse. The
 * second run was not merely wasteful — it had to re-handle "unknown operation"
 * and "input outside the domain" as unreachable branches, which is a branch
 * nothing can test and nothing can trust.
 */
/** A proposal's target after normalization: the account default has NO `locationId` key. */
export interface ProposalScope {
  accountId: string;
  locationId?: string;
}

export interface ParsedProposal {
  operation: ProposableOperation;
  /** Narrowed by `operation.parseInput`, never the raw model value. */
  input: Record<string, unknown>;
  /**
   * NORMALIZED. The wire admits `locationId: null` because a strict provider
   * schema spells "may be absent" as null; `validateModelOutput` turns null
   * into absence once, so no consumer has two spellings of "account default".
   */
  scope: ProposalScope;
  rationale: string;
}

export interface ParsedRestoreRequest {
  /** Index in the original model proposals array, including ordinary proposals. */
  index: number;
  scope: ProposalScope;
}

export type ValidationResult =
  | { ok: true; output: ModelOutput; proposals: ParsedProposal[]; restoreRequests: ParsedRestoreRequest[] }
  | { ok: false; reasons: string[] };

/** One proposal exactly as the model returned it, before the catalog sees it. */
type ProposedOperation = ModelOutput['proposals'][number];

/** A model proposal with its scope normalized, before the catalog sees it. */
type NormalizedProposal = Omit<ProposedOperation, 'scope'> & { scope: ProposalScope };

function normalizeProposal(proposal: ProposedOperation): NormalizedProposal {
  const { accountId, locationId } = proposal.scope;
  return { ...proposal, scope: locationId == null ? { accountId } : { accountId, locationId } };
}

/** Built once: the validator only ever asks whether a metric name is a member. */
const STATUS_METRIC_SET: ReadonlySet<string> = new Set<string>(STATUS_METRICS);

/**
 * The prose rules, over BOTH prose members. A `question` is model prose exactly
 * as a `text` is — "You have 3 reviews waiting, shall I…?" invents a count just
 * as surely, and reaches the owner in the same sentence position.
 */
function validateTextSegments(segments: readonly Segment[]): string[] {
  const reasons: string[] = [];
  for (const segment of segments) {
    if (segment.type !== 'text' && segment.type !== 'question') continue;
    if (INVENTED_COUNT_PATTERN.test(segment.text)) {
      reasons.push(`a ${segment.type} segment states a count next to a metric word; use a status_ref instead`);
    }
    if (COMPLETION_CLAIM_PATTERN.test(segment.text)) {
      reasons.push(`a ${segment.type} segment claims a completion; nothing is applied until the owner clicks`);
    }
  }
  return reasons;
}

/**
 * The two REFERENCE members: a `status_ref` may only name a snapshot metric,
 * and a `proposal_ref` may only point inside the proposals the same output
 * returned — an index past the end would materialize to nothing.
 */
function validateRefSegments(output: ModelOutput): string[] {
  const reasons: string[] = [];
  const refusalReasons = new Set<OperatorRefusalReason>();
  for (const segment of output.segments) {
    if (segment.type === 'refusal_ref') {
      if (refusalReasons.has(segment.reason)) reasons.push('duplicate refusal_ref reason');
      refusalReasons.add(segment.reason);
    }
    if (segment.type === 'status_ref' && !STATUS_METRIC_SET.has(segment.metric)) {
      reasons.push(`status_ref names a metric outside the snapshot: ${segment.metric}`);
    }
    if (segment.type === 'proposal_ref' && segment.index >= output.proposals.length) {
      reasons.push('proposal_ref points at a proposal index that was not returned');
    }
  }
  return reasons;
}

/**
 * The scope_check rules, per segment and then across the whole output. A
 * scope_check says "you named ANOTHER location" — so naming this turn's own
 * location, or one outside the account, is incoherent, and so is emitting one
 * alongside a proposal for the very location the turn is already prepared for.
 */
function validateScopeCheck(
  segments: readonly Segment[],
  proposals: readonly NormalizedProposal[],
  snapshot: Snapshot,
): string[] {
  const reasons: string[] = [];
  for (const segment of segments) {
    if (segment.type !== 'scope_check') continue;
    if (segment.locationId === snapshot.locationId) {
      reasons.push('scope_check names the location this turn is already prepared for');
    } else if (!snapshot.locations.some((l) => l.id === segment.locationId)) {
      reasons.push('scope_check names a location outside this account');
    }
  }

  const hasScopeCheck = segments.some((s) => s.type === 'scope_check');
  const targetsStoredLocation = proposals.some(
    (p) => p.scope.locationId === snapshot.locationId,
  );
  if (hasScopeCheck && targetsStoredLocation) {
    reasons.push('a scope_check and a proposal for the stored location cannot coexist');
  }
  return reasons;
}

/** One proposal's scope: the right account, and the stored location or the account default. */
function validateProposalScope(
  proposal: NormalizedProposal,
  operation: ProposableOperation | PrepareOperation,
  snapshot: Snapshot,
): string[] {
  const reasons: string[] = [];
  if (proposal.scope.accountId !== snapshot.accountId) {
    reasons.push('proposal scope names another account');
  }
  // Scope is the stored location, or the account default (no locationId).
  if (proposal.scope.locationId !== undefined && proposal.scope.locationId !== snapshot.locationId) {
    reasons.push('proposal scope is neither the stored location nor the account default');
  }
  // A location-scoped operation with NO locationId would otherwise store a
  // NULL target and read back as an account-default proposal it is not. Every
  // voice operation is `scopeRule: 'location'`, and the scope is already
  // normalized, so a wire `locationId: null` cannot slip past this as a value.
  if (operation.scopeRule === 'location' && proposal.scope.locationId === undefined) {
    reasons.push(`proposal scope must name the stored location for ${proposal.operation}`);
  }
  return reasons;
}

/**
 * The proposal rules. Unlike its three siblings this one also CARRIES WORK
 * FORWARD: the catalog lookup and `parseInput` happen here, once, and the
 * accepted proposals travel out with the reasons so the row builder never
 * repeats either.
 */
function validateProposals(
  proposals: readonly NormalizedProposal[],
  snapshot: Snapshot,
): { reasons: string[]; proposals: ParsedProposal[]; restoreRequests: ParsedRestoreRequest[] } {
  const reasons: string[] = [];
  const parsedProposals: ParsedProposal[] = [];
  const restoreRequests: ParsedRestoreRequest[] = [];
  for (const [index, proposal] of proposals.entries()) {
    if (proposal.operation === 'restore_last') {
      if (!snapshot.allowedOperations.some((op) => op.id === 'restore_last' && op.kind === 'prepare')) {
        reasons.push('restore_last is not available for this account');
      }
      reasons.push(...validateProposalScope(proposal, CATALOG.restore_last as PrepareOperation, snapshot));
      if (Object.keys(proposal.input).length !== 0) reasons.push('restore_last input must be empty');
      restoreRequests.push({ index, scope: proposal.scope });
      continue;
    }
    const operation = proposableOperation(proposal.operation);
    if (!operation) {
      reasons.push(`proposal names an operation outside the catalog: ${proposal.operation}`);
      continue;
    }
    if (!snapshot.allowedOperations.some((op) => op.id === operation.id)) {
      reasons.push(`proposal names an operation this account may not use: ${proposal.operation}`);
    }
    reasons.push(...validateProposalScope(proposal, operation, snapshot));
    const parsed = operation.parseInput(proposal.input);
    if (!parsed.ok) {
      reasons.push(`proposal input is outside the domain for ${proposal.operation}`);
      continue;
    }
    // Collected in the MODEL'S OWN ORDER, which is what `proposal_ref.index`
    // means and what `materializeReply` binds ids by.
    parsedProposals.push({
      operation,
      input: parsed.input,
      scope: proposal.scope,
      rationale: proposal.rationale,
    });
  }
  return { reasons, proposals: parsedProposals, restoreRequests };
}

/**
 * Semantic validation over an ALREADY shape-valid output (the zod schema ran
 * at the seam). Every rejection reason is a short token the retry prompt can
 * quote back; none of them carries owner text or provider output.
 *
 * Four independent passes, one per concern, whose reasons are concatenated:
 * every rule runs on every output, so the retry prompt sees ALL of what is
 * wrong rather than the first thing that was.
 *
 * On success it returns the PARSED proposals alongside the output, so the
 * catalog lookup and `parseInput` happen exactly once on the path.
 */
export function validateModelOutput(output: ModelOutput, snapshot: Snapshot): ValidationResult {
  // The ONE place a wire `locationId: null` becomes absence. Both scope rules
  // and the parsed proposals read the normalized scope.
  const proposals = output.proposals.map(normalizeProposal);
  const proposalCheck = validateProposals(proposals, snapshot);
  const reasons = [
    ...validateTextSegments(output.segments),
    ...validateRefSegments(output),
    ...validateScopeCheck(output.segments, proposals, snapshot),
    ...proposalCheck.reasons,
  ];

  return reasons.length === 0
    ? { ok: true, output, proposals: proposalCheck.proposals, restoreRequests: proposalCheck.restoreRequests }
    : { ok: false, reasons };
}

// ── Materialization (write path) ──────────────────────────────────────────

function isStatusMetric(value: string): value is StatusMetric {
  return (STATUS_METRICS as readonly string[]).includes(value);
}

/**
 * One `status_ref` → the stored `status` it becomes. The validator has already
 * rejected any metric outside `STATUS_METRICS`, so the switch is total.
 */
function materializeStatus(metric: StatusMetric, metrics: SnapshotMetrics): StoredSegment {
  const value = metric === 'pending_count'
    ? metrics.pendingCount
    : metric === 'posted_7d'
      ? metrics.posted7d
      : metrics.draftsWaiting;
  return {
    type: 'status',
    metric,
    value,
    reportingPeriodDays: metrics.reportingPeriodDays,
    asOf: metrics.asOf,
  };
}

export interface MaterializeReplyInput {
  /** The validated MODEL segments, in order. */
  segments: readonly Segment[];
  /** The snapshot's metrics, read once before the model call. */
  metrics: SnapshotMetrics;
  /** Stored **Proposal** ids, in the order the model returned the proposals. */
  proposalIds: readonly (string | null)[];
  /** The server could not prepare at least one requested Restore. */
  restoreUnavailable?: boolean;
  /** Server-minted refusal subjects, keyed by the validated distinct reason. */
  refusalIds?: Readonly<Partial<Record<OperatorRefusalReason, string>>>;
  /** Whether the **Pasted-review scrub** changed the owner's message. */
  scrubbed: boolean;
}

/**
 * The model's segments → what `agent_turns.reply` stores. Four transforms,
 * all of which exist so the stored row is the whole truth and the read path
 * never re-derives anything:
 *
 *  1. every `status_ref` becomes a `status` carrying the value the server
 *     read, its reporting period and the instant it read it. Resolving the
 *     metric name later would paint today's count onto a sentence written
 *     about a different one.
 *  2. every `proposal_ref` becomes a `proposal` carrying the stored id. The
 *     index is only meaningful HERE, where the insertion order is still known;
 *     the rows all share one `NOW()`, so a read-time `ORDER BY created_at`
 *     re-derivation is a tie-only sort with no defined order.
 *  3. a scrubbed message prepends the fixed notice, which the read path could
 *     not re-derive: it never sees the owner's raw message.
 *  4. every refusal binds its server-minted subject, matching the ledger row
 *     written in the same winning completion transaction.
 *
 * A `status_ref` whose metric is unreachable-unknown, or a `proposal_ref`
 * whose index has no id, is DROPPED rather than thrown: the turn's budget is
 * already spent, and one missing sentence beats a retry that cannot converge.
 * A missing refusal subject THROWS: the durable refusal and its ledger row
 * must commit together, never silently lose a recorded decision.
 */
export function materializeReply(input: MaterializeReplyInput): StoredSegment[] {
  const stored: StoredSegment[] = [];
  if (input.scrubbed) {
    stored.push({ type: 'server_notice', notice: SERVER_NOTICE.PASTED_REVIEW_REMOVED });
  }
  for (const segment of input.segments) {
    switch (segment.type) {
      case 'status_ref':
        // The model union types `metric` as a bounded STRING (the schema
        // cannot enum it without the model losing the ability to name a metric
        // the validator can reject with a reason). `validateModelOutput` has
        // already refused anything outside STATUS_METRICS, so this guard is
        // the TYPE narrowing for that decision, not a second policy.
        if (isStatusMetric(segment.metric)) {
          stored.push(materializeStatus(segment.metric, input.metrics));
        }
        break;
      case 'proposal_ref': {
        const proposalId = input.proposalIds[segment.index];
        if (proposalId) stored.push({ type: 'proposal', proposalId });
        break;
      }
      case 'refusal_ref': {
        const subjectId = input.refusalIds?.[segment.reason];
        if (!subjectId) throw new Error('agents/operator: refusal_ref has no server-minted subject ID');
        stored.push({ type: 'refusal', reason: segment.reason, subjectId });
        break;
      }
      default:
        stored.push(segment);
        break;
    }
  }
  if (input.restoreUnavailable) {
    stored.push({ type: 'server_notice', notice: SERVER_NOTICE.RESTORE_UNAVAILABLE });
  }
  return stored;
}

// ── Rendering (read path) ─────────────────────────────────────────────────

export interface RenderContext {
  /** The account's active locations, for a `scope_check`'s display name. */
  locations: readonly { id: string; name: string }[];
}

/** Closed token → the sentence the owner reads. Owned here, not in the row. */
const SERVER_NOTICE_TEXT: Record<ServerNotice, string> = {
  [SERVER_NOTICE.PASTED_REVIEW_REMOVED]: PASTED_REVIEW_SEGMENT,
  [SERVER_NOTICE.RESTORE_UNAVAILABLE]: 'I could not prepare a Restore from the applied history for that scope. Nothing changed.',
};

export type RenderedSegment =
  | { type: 'text'; text: string }
  | { type: 'question'; text: string }
  | { type: 'status'; metric: StatusMetric; value: number; reportingPeriodDays: number; asOf: string }
  | { type: 'proposal'; proposalId: string }
  | { type: 'refusal'; reason: OperatorRefusalReason; subjectId: string; text: string }
  | { type: 'scope_check'; locationId: string; locationName: string }
  | { type: 'notice'; text: string };

/**
 * Stored **Reply segment**s → what the screen shows. A PURE MAPPING: it reads
 * no metrics, resolves no index and issues no query, because a stored `status`
 * segment already carries the value and a stored `proposal` segment already
 * carries the id.
 *
 * That is the point. Resolving a metric name at GET would re-read today's
 * counts — for whatever location the caller passed — and paint them onto a
 * sentence written days ago about a different number; resolving an index would
 * sort rows that share one `created_at`.
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
      // Passthrough: the id was bound at completion.
      case 'proposal':
        rendered.push({ type: 'proposal', proposalId: segment.proposalId });
        break;
      case 'refusal':
        rendered.push({
          type: 'refusal', reason: segment.reason, subjectId: segment.subjectId,
          text: OPERATOR_REFUSAL_RULES[segment.reason].rule,
        });
        break;
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
