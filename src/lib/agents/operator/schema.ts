// The Owner Operator model-output contract and the four new tables' JSONB
// parse sites. Nothing here touches the database; the parsers take already-read
// column values.
import { z } from 'zod';
import { VoiceVersionTokenSchema } from './version-token';

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
 * The summary panel's connection vocabulary — migration 026's
 * `zernio_connections.status` CHECK, spelled once on the read side.
 *
 * A third narrowing beside the two above rather than an inline `if` chain in
 * `reads.ts`: the CHECK makes the throw unreachable through the database, so
 * the only way to prove the branch refuses an out-of-vocabulary value is to
 * call it directly, which an unexported chain does not allow.
 */
const CONNECTION_STATUS = {
  PENDING: 'pending',
  ACTIVE: 'active',
  DISCONNECTED: 'disconnected',
} as const;
export type ConnectionStatus = (typeof CONNECTION_STATUS)[keyof typeof CONNECTION_STATUS];

export function asConnectionStatus(value: string): ConnectionStatus {
  const members: readonly string[] = Object.values(CONNECTION_STATUS);
  if (!members.includes(value)) {
    throw new Error('agents/operator: zernio_connections.status holds a value no writer produces');
  }
  return value as ConnectionStatus;
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

/**
 * Every reason a **Proposal** can carry in `failure_reason`. Six members, and
 * the split between them is the whole lifecycle (spec §6.3):
 *
 *  - `version_mismatch` → `stale`. The settings moved. Offer **Refresh plan**.
 *  - `contract_changed` → `rejected`. The CODE moved, not the settings; the
 *    plan must be regenerated, not retried.
 *  - `unauthorized` / `account_offboarding` → `rejected`. The actor lost the
 *    right between preparation and the click.
 *  - `location_not_found` → `rejected`. The location was archived.
 *  - `write_failed` → `failed`. The executor DETERMINISTICALLY refused. A
 *    THROWN executor is not this: the transaction rolls back and the row stays
 *    `pending` (plan decision D12).
 *
 * An owner decline stores NO reason — `decided_by_user_id` alone says who, and
 * a reason column filled with `owner_declined` would make "the owner said no"
 * look like a failure in every read that counts non-NULL reasons (D5).
 */
export const PROPOSAL_FAILURE_REASON = {
  VERSION_MISMATCH: 'version_mismatch',
  CONTRACT_CHANGED: 'contract_changed',
  UNAUTHORIZED: 'unauthorized',
  ACCOUNT_OFFBOARDING: 'account_offboarding',
  LOCATION_NOT_FOUND: 'location_not_found',
  WRITE_FAILED: 'write_failed',
} as const;
export type ProposalFailureReason =
  (typeof PROPOSAL_FAILURE_REASON)[keyof typeof PROPOSAL_FAILURE_REASON];

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

// ── The Receipt ───────────────────────────────────────────────────────────
//
// Server-written, in the SAME transaction as the mutation. The client supplies
// no field of it. `.strict()` for the same reason the model schema is strict:
// a Receipt is the owner's record that something changed, and an unknown key
// in it is a writer this codebase does not have.

/**
 * The five `VoiceConfig` fields, as a value rather than an interface, so the
 * Receipt's `before`/`after` can be VALIDATED and not merely asserted. It
 * mirrors `VoiceConfig` (src/lib/responses/voice-settings.ts:10-22) field for
 * field. This is the shape the **Receipt** CARRIES.
 */
const VoiceStateSchema = z.object({
  tone: z.string().nullable(),
  productsServices: z.string().nullable(),
  avoidFacts: z.array(z.string()),
  highlightFacts: z.array(z.string()),
  sampleResponses: z.array(z.string()),
}).strict();
export type VoiceState = z.infer<typeof VoiceStateSchema>;

/**
 * What Run A actually STORED in `agent_proposals.before` / `.after` — the five
 * fields PLUS `updatedAt`, and that extra key is not an accident to be
 * tightened away.
 *
 * `AgentTurnWorker` reads the voice config with `readVoiceConfig`
 * (`worker/jobs/agent-turn/AgentTurnWorker.ts:211-214`), whose return type is
 * `VoiceConfig & { updatedAt: string }`; `defineProposable`'s `preview` returns
 * that object as `before` and spreads it into `after`
 * (`src/lib/agents/operator/catalog.ts:96-98`); and `buildProposalRows` stores
 * both with `{ ...before }` / `{ ...after }`
 * (`src/lib/agents/operator/proposals.ts:77-78`). **Every Proposal Run A has
 * ever written therefore carries SIX keys.** A five-field `.strict()` parse
 * would reject all of them — crashing the card and rolling back Apply on real
 * data while every hand-typed fixture passed.
 *
 * So the parser ACCEPTS `updatedAt` and DROPS it: the `updatedAt` inside a
 * preview is the **Version token**'s own value at preparation time, which the
 * Receipt already records under `versionToken.before`. Carrying it a second
 * time inside `before`/`after` would put two copies of one fact in one
 * document. Any OTHER unknown key is still a hard rejection.
 */
const StoredVoiceStateSchema = VoiceStateSchema.extend({
  updatedAt: z.string().optional(),
}).strict();

/**
 * `agent_proposals.before` / `.after` → a `VoiceState`.
 *
 * NOT a JSONB parse site: `mapStored` already ran `parseJsonbObject` over the
 * column, so this narrows an in-memory object. It throws rather than defaulting
 * because a Proposal whose stored preview cannot be read is one whose Receipt
 * would be a guess.
 */
export function parseVoiceState(value: unknown, column: string): VoiceState {
  const validated = StoredVoiceStateSchema.safeParse(value);
  if (!validated.success) {
    throw new Error(`agents/operator: ${column} holds a voice state no writer produces`);
  }
  // Drop the stored `updatedAt`; the Receipt records it once, under
  // `versionToken`, and nowhere else.
  const { updatedAt: _preparedAt, ...state } = validated.data;
  return state;
}

const ReceiptSchema = z.object({
  /** Bumped only when a stored Receipt's SHAPE changes. Run B writes 1. */
  version: z.literal(1),
  operation: z.string().min(1),
  scope: z.object({ accountId: z.uuid(), locationId: z.uuid() }).strict(),
  /** The state the card SHOWED the owner when they clicked (plan decision P6). */
  before: VoiceStateSchema,
  /** The state that actually committed, read back under the lock. */
  after: VoiceStateSchema,
  /**
   * True when the committed `after` is not the previewed `after` — a seeded
   * column or a concurrent trigger. The Apply still succeeds (spec §6.5); this
   * flag is how the card says the result is not what was previewed.
   */
  differsFromPreview: z.boolean(),
  /** Voice changes take effect at once. A literal, not a boolean: no Run B operation is scheduled. */
  effectiveNow: z.literal(true),
  /** Spec §8.4, the tone/facts row: future drafts only. */
  affects: z.literal('future_drafts'),
  /** Readiness reasons still blocking something. Always `[]` for voice (P7). */
  remainingBlocked: z.array(z.string()),
  appliedAt: z.string().min(1),
  actorUserId: z.uuid(),
  /**
   * WHO the owner reads on the card: `users.name`, or the account email when
   * the name is null. Server-written under the same lock as `actorUserId`,
   * frozen at the Apply — a later rename must not rewrite history.
   *
   * OPTIONAL ON READ, defaulted to `null`. Receipts written before this field
   * existed carry fifteen keys, and a `.strict()` schema that required the
   * sixteenth would throw on every one of them — crashing the card for the
   * exact owners who already applied something. The WRITER always supplies it;
   * the default is for the rows that predate it.
   */
  actorName: z.string().nullable().default(null),
  /** The VERBATIM `owner_text` of the turn that produced the Proposal (§6.5). */
  ownerText: z.string(),
  /** The turn id, as the correlation id (§6.5). */
  turnId: z.uuid(),
  versionToken: z.object({
    before: VoiceVersionTokenSchema,
    after: VoiceVersionTokenSchema,
  }).strict(),
}).strict();
export type Receipt = z.infer<typeof ReceiptSchema>;

/**
 * `agent_proposals.receipt` → a **Receipt**. A PgBouncer JSONB parse site
 * (lab-notes/postgres.md allowlist): guard `typeof x === 'string'`, narrow,
 * throw. `null` is a legitimate value — every Proposal that has not been
 * applied has one — and returns `null` rather than throwing.
 */
export function parseReceipt(value: unknown): Receipt | null {
  if (value == null) return null;
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  const validated = ReceiptSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error('agents/operator: agent_proposals.receipt holds a shape no writer produces');
  }
  return validated.data;
}
