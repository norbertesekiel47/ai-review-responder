// The Owner Operator model-output contract and the four new tables' JSONB
// parse sites. Nothing here touches the database; the parsers take already-read
// column values.
import { z } from 'zod';
import type { AutoApprovalReadinessBlockReason } from '@/lib/auto-approval/types';
import {
  DailyCapValueSchema,
  OPERATION_INPUT_SCHEMAS,
  ThresholdValueSchema,
  VetoWindowValueSchema,
  type ProposableOperationId,
} from './operation-inputs';
import { AutoApprovalVersionTokenSchema, VoiceVersionTokenSchema } from './version-token';
import { OPERATOR_REFUSAL_REASONS } from './refusals';

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
  DISPATCH_EXHAUSTED: 'dispatch_exhausted',
} as const;
export type TurnFailureReason =
  (typeof TURN_FAILURE_REASON)[keyof typeof TURN_FAILURE_REASON];

/**
 * Every reason a **Proposal** can carry in `failure_reason`. The split between
 * them is the whole lifecycle (spec §6.3):
 *
 *  - `version_mismatch` → `stale`. The settings moved. Offer **Refresh plan**.
 *  - `contract_changed` → `rejected`. The CODE moved, not the settings; the
 *    plan must be regenerated, not retried.
 *  - `unauthorized` / `account_offboarding` → `rejected`. The actor lost the
 *    right between preparation and the click.
 *  - `location_not_found` → `rejected`. The location is gone, or a voice
 *    location was archived.
 *  - `location_inactive` → `rejected`. A policy change the shared archived
 *    rule refuses on an archived location (a new override, or any expansion).
 *  - `expansion_blocked` → `rejected`. Readiness blocked a policy expansion;
 *    the reasons ride the Apply response, not this column.
 *  - `write_failed` → `failed`. The executor DETERMINISTICALLY refused. A
 *    THROWN executor is not this: the transaction rolls back and the row stays
 *    `pending` (plan decision D12).
 *
 * A typed-scope mismatch stores NOTHING: the proposal stays pending so the
 * owner can correct the field. An owner decline stores NO reason either —
 * `decided_by_user_id` alone says who (D5).
 */
export const PROPOSAL_FAILURE_REASON = {
  VERSION_MISMATCH: 'version_mismatch',
  CONTRACT_CHANGED: 'contract_changed',
  UNAUTHORIZED: 'unauthorized',
  ACCOUNT_OFFBOARDING: 'account_offboarding',
  LOCATION_NOT_FOUND: 'location_not_found',
  LOCATION_INACTIVE: 'location_inactive',
  EXPANSION_BLOCKED: 'expansion_blocked',
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

const RefusalRefSegmentSchema = z.strictObject({
  type: z.literal('refusal_ref'),
  reason: z.enum(OPERATOR_REFUSAL_REASONS),
});

const SegmentSchema = z.discriminatedUnion('type', [
  TextSegmentSchema,
  StatusRefSegmentSchema,
  ProposalRefSegmentSchema,
  QuestionSegmentSchema,
  ScopeCheckSegmentSchema,
  RefusalRefSegmentSchema,
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
export const SERVER_NOTICE = {
  PASTED_REVIEW_REMOVED: 'pasted_review_removed',
  RESTORE_UNAVAILABLE: 'restore_unavailable',
} as const;
export type ServerNotice = (typeof SERVER_NOTICE)[keyof typeof SERVER_NOTICE];

const ServerNoticeSegmentSchema = z.strictObject({
  type: z.literal('server_notice'),
  notice: z.enum(SERVER_NOTICE),
});

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

// The durable subject is minted by the server during fenced completion.
// Neither scope nor wording is stored: the closed rule map owns both.
const RefusalSegmentSchema = z.strictObject({
  type: z.literal('refusal'),
  reason: z.enum(OPERATOR_REFUSAL_REASONS),
  subjectId: z.uuid(),
});

/**
 * What `agent_turns.reply` may hold. NOT simply "the model union plus extras":
 * `status_ref` is REPLACED by the materialized `status` on the way in, and
 * `proposal_ref` by the materialized `proposal`, so a stored reply carries a
 * value and an id and never a promise to look either one up.
 * `refusal_ref` becomes `refusal` with its server-minted durable subject.
 * `OperatorModelOutputSchema` accepts none of `server_notice`, `status`,
 * `proposal` or `refusal`, so a model cannot forge a
 * server statement, a count, or a reference to a proposal it did not return.
 */
const StoredSegmentSchema = z.discriminatedUnion('type', [
  TextSegmentSchema,
  ProposalSegmentSchema,
  QuestionSegmentSchema,
  ScopeCheckSegmentSchema,
  ServerNoticeSegmentSchema,
  StatusSegmentSchema,
  RefusalSegmentSchema,
]);
export type StoredSegment = z.infer<typeof StoredSegmentSchema>;

/**
 * `locationId` is NULLABLE AND OPTIONAL. A strict provider schema requires
 * every field and represents "may be absent" only as null (the installed
 * OpenAI helper refuses `.optional()` without `.nullable()`), while absence
 * stays legal for every other caller. Null and absent both mean the account
 * default; `validateModelOutput` normalizes null to absence once, before any
 * consumer reads it.
 *
 * The wire does not encode tenancy. A shape-valid uuid for another account or
 * location is refused by the semantic validator, never here.
 */
const ProposalScopeSchema = z.object({
  accountId: z.uuid(),
  locationId: z.uuid().nullable().optional(),
}).strict();

/**
 * One operation's proposal: its id as a literal, beside exactly that
 * operation's input schema from the leaf module the catalog parses with. The
 * input is therefore finite on the wire — an unknown key, another operation's
 * input, or an out-of-domain value fails shape validation. The semantic
 * validator still runs `parseInput` and every catalog, scope and prose rule.
 */
function proposalSchemaFor<Operation extends ProposableOperationId>(operation: Operation) {
  return z.object({
    operation: z.literal(operation),
    scope: ProposalScopeSchema,
    input: OPERATION_INPUT_SCHEMAS[operation],
    rationale: z.string().trim().min(1).max(500),
  }).strict();
}

// Eight ordinary inputs plus the server-prepared Restore request. The latter
// has no model-authored prior state or source ID; schema tests pin both doors.
const ProposedOperationSchema = z.union([
  proposalSchemaFor('set_tone'),
  proposalSchemaFor('set_products_services'),
  proposalSchemaFor('set_avoid_facts'),
  proposalSchemaFor('set_highlight_facts'),
  proposalSchemaFor('set_auto_reply_scope'),
  proposalSchemaFor('set_veto_window'),
  proposalSchemaFor('set_daily_cap'),
  proposalSchemaFor('clear_location_override'),
  z.strictObject({
    operation: z.literal('restore_last'),
    scope: ProposalScopeSchema,
    input: z.strictObject({}),
    rationale: z.string().trim().min(1).max(500),
  }),
]);

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
 * `AgentTurnWorker` reads the voice config with `readVoiceConfig`, whose return
 * type is `VoiceConfig & { updatedAt: string }`; `defineVoice`'s `preview`
 * returns that object as `before` and spreads it into `after`; and
 * `buildProposalRows` stores both with `{ ...before }` / `{ ...after }`.
 * **Every voice Proposal ever written therefore carries SIX keys.** A
 * five-field `.strict()` parse would reject all of them — crashing the card
 * and rolling back Apply on real data while every hand-typed fixture passed.
 *
 * So the parser ACCEPTS `updatedAt` and DROPS it: the `updatedAt` inside a
 * preview is the **Version token**'s own value at preparation time, which the
 * Receipt already records under `versionToken.before`. Any OTHER unknown key is
 * still a hard rejection.
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

/**
 * The FULL effective auto-approval state of one target scope — what a policy
 * **Proposal** stores in `before`/`after` (spec §4, §6.1): the three dials, the
 * cap actually enforced, and whether the target ROW exists.
 *
 * `domain: 'policy'` is the discriminant. Voice states have no such key and
 * must keep parsing exactly as Run A stored them (six keys, `updatedAt`
 * included), so the policy side carries the tag, and `.strict()` on both sides
 * keeps either shape from parsing as the other.
 *
 * Both cap fields are kept. `dailyAutoPostCap` is the stored value (null =
 * platform default), which exposure classification needs: removing a cap
 * widens even when the default is lower. `effectiveDailyCap` is the enforced
 * number the owner reads.
 */
const PolicyStateSchema = z.object({
  domain: z.literal('policy'),
  threshold: ThresholdValueSchema,
  vetoWindowMinutes: VetoWindowValueSchema,
  dailyAutoPostCap: DailyCapValueSchema,
  effectiveDailyCap: z.number().int().min(1),
  rowExists: z.boolean(),
}).strict();
export type PolicyState = z.infer<typeof PolicyStateSchema>;

/**
 * The settings readiness vocabulary as a CLOSED value set. A mapped type over
 * `AutoApprovalReadinessBlockReason`, so adding a reason there fails typecheck
 * here until it is listed — the stored metadata can never carry a reason the
 * settings module does not know, nor miss one it does.
 */
const READINESS_BLOCK_REASONS: { readonly [Reason in AutoApprovalReadinessBlockReason]: Reason } = {
  auto_approval_disabled: 'auto_approval_disabled',
  autopilot_unavailable: 'autopilot_unavailable',
  provider_moderation_disabled: 'provider_moderation_disabled',
  provider_moderation_not_validated: 'provider_moderation_not_validated',
  subscription_not_writable: 'subscription_not_writable',
  policy_suspended: 'policy_suspended',
  preview_environment: 'preview_environment',
  impersonation_not_allowed: 'impersonation_not_allowed',
};
const ReadinessBlockReasonSchema = z.enum(READINESS_BLOCK_REASONS);

const CountSchema = z.number().int().min(0);

/**
 * The **Consequence line** a policy Proposal and its Receipt carry: the pure
 * simulator's result over the reader's 30-day received cohort, plus the window
 * and the exclusions that make it honest (spec §3.5, plan T5). SERVER metadata:
 * the model output schema has no field for any of it.
 *
 * `eligible` and the three `held` reasons partition `total`; a stored line
 * that does not is a writer this codebase does not have.
 */
const PolicyConsequenceSchema = z.object({
  total: CountSchema,
  eligible: CountSchema,
  held: z.object({
    below_threshold: CountSchema,
    cap_reached: CountSchema,
    manual: CountSchema,
  }).strict(),
  byDay: z.array(z.object({
    day: z.string().min(1),
    total: CountSchema,
    eligible: CountSchema,
    held: CountSchema,
  }).strict()),
  busiestDay: CountSchema,
  windowStart: z.string().min(1),
  windowEnd: z.string().min(1),
  asOf: z.string().min(1),
  source: z.literal('reviews_received_30d'),
  excludedImported: CountSchema,
  excludedUnknown: CountSchema,
}).strict().refine(
  (line) => line.eligible + line.held.below_threshold + line.held.cap_reached + line.held.manual === line.total,
  { message: 'eligible and held must partition total' },
);
export type StoredPolicyConsequence = z.infer<typeof PolicyConsequenceSchema>;

/**
 * What a policy Proposal STORES in `before`/`after`: the pure state plus
 * optional server-only metadata keys. `consequence` rides both sides;
 * `expansionBlockedBy` rides only an expansion's `after`, recording the
 * readiness reasons at preparation. The card's confirmation phrase is NOT
 * stored — it is derived from the stored `after` through the catalog at read.
 */
const StoredPolicyStateSchema = PolicyStateSchema.extend({
  consequence: PolicyConsequenceSchema.optional(),
  affectedLocationCount: CountSchema.optional(),
  expansionBlockedBy: z.array(ReadinessBlockReasonSchema).optional(),
}).strict();
export type StoredPolicyState = z.infer<typeof StoredPolicyStateSchema>;

/**
 * `agent_proposals.before` / `.after` of a policy Proposal, metadata included.
 * NOT a JSONB parse site: the column was already through `parseJsonbObject`.
 */
export function parseStoredPolicyState(value: unknown, column: string): StoredPolicyState {
  const validated = StoredPolicyStateSchema.safeParse(value);
  if (!validated.success) {
    throw new Error(`agents/operator: ${column} holds a policy state no writer produces`);
  }
  return validated.data;
}

/**
 * The same column → the PURE `PolicyState` the catalog previews and classifies.
 * The metadata is dropped here so `catalog.preview`, `exposure` and
 * `confirmationPhrase` never see a count.
 */
export function parsePolicyState(value: unknown, column: string): PolicyState {
  const {
    consequence: _consequence,
    affectedLocationCount: _affectedLocationCount,
    expansionBlockedBy: _expansionBlockedBy,
    ...state
  } = parseStoredPolicyState(value, column);
  return state;
}

/** A consequence line about to be stored, validated so no reader can refuse it later. */
export function parsePolicyConsequence(value: unknown, column: string): StoredPolicyConsequence {
  const validated = PolicyConsequenceSchema.safeParse(value);
  if (!validated.success) {
    throw new Error(`agents/operator: ${column} holds a consequence line no writer produces`);
  }
  return validated.data;
}

/** A policy Receipt's `before`/`after`: the full state, always with its line. */
const PolicyStateWithConsequenceSchema = PolicyStateSchema.extend({
  consequence: PolicyConsequenceSchema,
  affectedLocationCount: CountSchema,
}).strict();
export type PolicyStateWithConsequence = z.infer<typeof PolicyStateWithConsequenceSchema>;

const VoiceReceiptSchema = z.object({
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
  /** Spec §8.4, the tone/facts row: future drafts only. The receipt union's discriminant. */
  affects: z.literal('future_drafts'),
  /** Readiness reasons still blocking something. Always `[]` for voice (P7). */
  remainingBlocked: z.array(z.string()),
  appliedAt: z.string().min(1),
  actorUserId: z.uuid(),
  /**
   * WHO the owner reads on the card: `users.name`, or the account email when
   * the name is null. Frozen at the Apply — a later rename must not rewrite
   * history.
   *
   * OPTIONAL ON READ, defaulted to `null`. Receipts written before this field
   * existed carry fifteen keys, and a `.strict()` schema that required the
   * sixteenth would throw on every one of them. The WRITER always supplies it.
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
export type VoiceReceipt = z.infer<typeof VoiceReceiptSchema>;

/**
 * A policy **Receipt** (Run C). `version: 1` because it is a new ARM, not a
 * change to the voice arm's shape; `affects` tells the two apart.
 *
 * `before` is the ACTUAL pre-write state read under the account lock, not the
 * card's stored `before`: a policy Proposal's token covers every row the state
 * depends on, so the two can only differ by clock and cohort drift, and the
 * Receipt records what the write actually moved. Both consequence lines come
 * from ONE pre-write review cohort, so a review that arrived between the two
 * reads never appears on one side only.
 */
const PolicyReceiptSchema = z.object({
  version: z.literal(1),
  operation: z.string().min(1),
  /** `locationId` null = the account default. */
  scope: z.object({ accountId: z.uuid(), locationId: z.uuid().nullable() }).strict(),
  before: PolicyStateWithConsequenceSchema,
  after: PolicyStateWithConsequenceSchema,
  /** True when the committed dials or row existence differ from the stored `after`. */
  differsFromPreview: z.boolean(),
  effectiveNow: z.literal(true),
  /** Spec §8.4: future eligible reviews; a draft already granted a veto window keeps it. */
  affects: z.literal('future_eligible_reviews'),
  /** Readiness reasons that still block a further expansion after this write. */
  remainingBlocked: z.array(ReadinessBlockReasonSchema),
  appliedAt: z.string().min(1),
  actorUserId: z.uuid(),
  actorName: z.string().nullable(),
  ownerText: z.string(),
  turnId: z.uuid(),
  versionToken: z.object({
    before: AutoApprovalVersionTokenSchema,
    after: AutoApprovalVersionTokenSchema,
  }).strict(),
  /**
   * Auto-approved replies already inside a granted veto window in this scope,
   * counted in the Apply transaction at `asOf`. They keep their granted window.
   */
  retainedVeto: z.object({
    count: CountSchema,
    asOf: z.string().min(1),
  }).strict(),
}).strict();
export type PolicyReceipt = z.infer<typeof PolicyReceiptSchema>;

/** Disjoint by `affects`; each arm is `.strict()`, so neither parses as the other. */
const ReceiptSchema = z.discriminatedUnion('affects', [VoiceReceiptSchema, PolicyReceiptSchema]);
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
