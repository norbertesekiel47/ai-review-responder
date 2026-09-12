// The Owner Operator model-output contract and the four new tables' JSONB
// parse sites. Nothing here touches the database; the parsers take already-read
// column values.
import { z } from 'zod';

export const TURN_STATUS = {
  ACCEPTED: 'accepted',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;
export type TurnStatus = (typeof TURN_STATUS)[keyof typeof TURN_STATUS];

export const PROPOSAL_STATUS = {
  PENDING: 'pending',
  APPLIED: 'applied',
  STALE: 'stale',
  REJECTED: 'rejected',
  FAILED: 'failed',
  SUPERSEDED: 'superseded',
} as const;
export type ProposalStatus = (typeof PROPOSAL_STATUS)[keyof typeof PROPOSAL_STATUS];

/**
 * The two narrowings every read site needs. `status` crosses the driver as a
 * bare `string`, and both columns carry a CHECK constraint (migration 120,
 * `agent_turns_status_check` / `agent_proposals_status_check`), so a value
 * outside the vocabulary means the row was written by something that is not
 * this codebase — a throw, not a silent widening back to `string`.
 */
export function asTurnStatus(value: string): TurnStatus {
  const members: readonly string[] = Object.values(TURN_STATUS);
  if (!members.includes(value)) {
    throw new Error('agents/operator: agent_turns.status holds a value no writer produces');
  }
  return value as TurnStatus;
}

export function asProposalStatus(value: string): ProposalStatus {
  const members: readonly string[] = Object.values(PROPOSAL_STATUS);
  if (!members.includes(value)) {
    throw new Error('agents/operator: agent_proposals.status holds a value no writer produces');
  }
  return value as ProposalStatus;
}

/**
 * Every reason a turn can carry in `failure_reason`. User-safe by
 * construction: each is a token the screen maps to its own wording, never a
 * provider message and never owner text.
 */
export const TURN_FAILURE_REASON = {
  OPERATOR_DISABLED: 'operator_disabled',
  UNAUTHORIZED: 'unauthorized',
  ACCOUNT_OFFBOARDING: 'account_offboarding',
  PREDECESSOR_STALLED: 'predecessor_stalled',
  MODEL_OUTPUT_INVALID: 'model_output_invalid',
  BUDGET_EXCEEDED: 'budget_exceeded',
  EXHAUSTED: 'exhausted',
} as const;
export type TurnFailureReason =
  (typeof TURN_FAILURE_REASON)[keyof typeof TURN_FAILURE_REASON];

export const STATUS_METRICS = ['pending_count', 'posted_7d', 'drafts_waiting'] as const;
export type StatusMetric = (typeof STATUS_METRICS)[number];

// ── Model output ──────────────────────────────────────────────────────────
//
// `.strict()` everywhere is the mechanism behind invariant 6: the schema has no
// field for a count, an approval, a confirmation or a receipt, and an unknown
// key is a hard rejection rather than a silently dropped one. A model that
// tries to emit `{ count: 3 }` fails shape validation before the semantic
// validator ever runs.

const TextSegmentSchema = z.object({
  type: z.literal('text'),
  text: z.string().trim().min(1).max(1200),
}).strict();

const StatusRefSegmentSchema = z.object({
  type: z.literal('status_ref'),
  metric: z.string().trim().min(1).max(40),
}).strict();

const ProposalRefSegmentSchema = z.object({
  type: z.literal('proposal_ref'),
  index: z.number().int().min(0).max(4),
}).strict();

const QuestionSegmentSchema = z.object({
  type: z.literal('question'),
  text: z.string().trim().min(1).max(400),
}).strict();

const ScopeCheckSegmentSchema = z.object({
  type: z.literal('scope_check'),
  locationId: z.uuid(),
}).strict();

const SegmentSchema = z.discriminatedUnion('type', [
  TextSegmentSchema,
  StatusRefSegmentSchema,
  ProposalRefSegmentSchema,
  QuestionSegmentSchema,
  ScopeCheckSegmentSchema,
]);
export type Segment = z.infer<typeof SegmentSchema>;

/**
 * A segment the SERVER writes into the stored reply and the model can never
 * emit. It exists because the fixed pasted-review sentence must survive a page
 * refresh: the scrub happens once, in the worker, and the GET route has no way
 * to re-derive it from the stored row otherwise.
 *
 * `notice` is a closed token, not a sentence: the wording lives in render.ts, so
 * a copy edit ships without rewriting stored rows.
 */
export const SERVER_NOTICE = { PASTED_REVIEW_REMOVED: 'pasted_review_removed' } as const;
export type ServerNotice = (typeof SERVER_NOTICE)[keyof typeof SERVER_NOTICE];

const ServerNoticeSegmentSchema = z.object({
  type: z.literal('server_notice'),
  notice: z.enum([SERVER_NOTICE.PASTED_REVIEW_REMOVED]),
}).strict();

/**
 * A MATERIALIZED status: the value the server read, frozen at completion with
 * the period and instant it was read at.
 *
 * This is what makes spec §3.4's "rendered from the stored snapshot" literally
 * true. The alternative — storing only the metric NAME and resolving it at GET
 * — re-reads TODAY's counts, for whatever location the reader happens to pass,
 * and paints them onto a sentence the model wrote days ago about a different
 * number. A transcript that silently rewrites its own history is worse than one
 * that is stale, because nothing on screen says which it is.
 *
 * The model can never emit this: it supplies `status_ref` with a metric name
 * and the worker turns it into this at fenced completion.
 */
const StatusSegmentSchema = z.object({
  type: z.literal('status'),
  metric: z.enum(STATUS_METRICS),
  value: z.number().int().min(0),
  reportingPeriodDays: z.number().int().min(1),
  asOf: z.string(),
}).strict();

/**
 * A MATERIALIZED proposal reference: the stored **Proposal** id, frozen at
 * fenced completion.
 *
 * Same reasoning as `status`, for a sharper reason. The model emits
 * `proposal_ref` with an INDEX into the proposals it returned in the same
 * output; the rows are then inserted in that order, all with the same `NOW()`.
 * Re-deriving the index at read time means `ORDER BY created_at` over rows
 * whose timestamps TIE, and a tie-only sort has no defined order — so a
 * sentence could point at a different card on the next read. Binding the id
 * once, where the order is still known, removes the question.
 *
 * The model can never emit this: it supplies an index and the worker turns it
 * into this.
 */
const ProposalSegmentSchema = z.object({
  type: z.literal('proposal'),
  proposalId: z.uuid(),
}).strict();

/**
 * What `agent_turns.reply` may hold. NOT simply "the model union plus extras":
 * `status_ref` is REPLACED by the materialized `status` on the way in, and
 * `proposal_ref` by the materialized `proposal`, so a stored reply carries a
 * value and an id and never a promise to look either one up.
 * `OperatorModelOutputSchema` below keeps the five model members and accepts
 * none of `server_notice`, `status` or `proposal`, so a model cannot forge a
 * server statement, a count, or a reference to a proposal it did not return.
 */
const StoredSegmentSchema = z.discriminatedUnion('type', [
  TextSegmentSchema,
  ProposalSegmentSchema,
  QuestionSegmentSchema,
  ScopeCheckSegmentSchema,
  ServerNoticeSegmentSchema,
  StatusSegmentSchema,
]);
export type StoredSegment = z.infer<typeof StoredSegmentSchema>;

const ProposedOperationSchema = z.object({
  operation: z.string().trim().min(1).max(60),
  scope: z.object({
    accountId: z.uuid(),
    locationId: z.uuid().optional(),
  }).strict(),
  // A record, not z.unknown(): the operation's own schema narrows it in the
  // catalog, and a record keeps the key required instead of optional.
  input: z.record(z.string(), z.unknown()),
  rationale: z.string().trim().min(1).max(500),
}).strict();

const UnsupportedRequestSchema = z.object({
  request: z.string().trim().min(1).max(500),
  context: z.string().trim().max(1000),
}).strict();

export const OperatorModelOutputSchema = z.object({
  segments: z.array(SegmentSchema).min(1).max(12),
  proposals: z.array(ProposedOperationSchema).max(5),
  unsupported: z.array(UnsupportedRequestSchema).max(5),
}).strict();
export type ModelOutput = z.infer<typeof OperatorModelOutputSchema>;

// ── JSONB parse sites ─────────────────────────────────────────────────────
//
// Postgres.js behind PgBouncer can return a JSONB column as a string. These
// two functions are the ONLY parse sites for the four Owner Operator tables
// (`agent_turns.reply`, `agent_proposals.input|before|after`); they are listed
// in the lab-notes allowlist. Guard `typeof x === 'string'`, then narrow and
// throw — never widen to `any`.
//
// The object parser is the agents surface's single one, owned by `read.ts` and
// re-exported here so the Operator sites keep importing it from their own
// module. It was a byte-identical copy until the fallow duplication gate said so.
export { parseJsonbObject } from '../read';

/**
 * `agent_turns.reply` is an ordered segment ARRAY, so it needs its own parser
 * rather than `parseJsonbObject`. A stored reply the writers cannot have
 * produced throws rather than rendering a blank transcript.
 */
export function parseReplySegments(value: unknown): StoredSegment[] {
  if (value == null) return [];
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) {
    throw new Error('agents/operator: expected agent_turns.reply to contain a JSON array');
  }
  // The STORED union, which admits `server_notice`; the model union is
  // narrower and is what the LLM seam validates against.
  const validated = z.array(StoredSegmentSchema).safeParse(parsed);
  if (!validated.success) {
    throw new Error('agents/operator: agent_turns.reply holds a segment shape no writer produces');
  }
  return validated.data;
}
