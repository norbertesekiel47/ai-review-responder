// The v1 operation catalog. Four kinds, separated by TypeScript type so a write
// cannot be registered as immediately executable (spec §4): three reads, seven
// proposable operations and one capture. The Apply/Decline commands are server
// routes, never catalog entries, so the model cannot name them.
//
// The proposables split again by the settings DOMAIN they write, and the split
// is a discriminant (`domain`), not one interface of optional members: four
// voice operations write through the voice writer, and three auto-approval
// operations write through the shared policy writer
// (`patchAutoApprovalSettingsInTransaction`). A caller narrows on `domain`
// before it can reach a preview or a writer adapter, so a voice executor can
// never be handed a policy input.
import type { ZodType } from 'zod';
import {
  DEFAULT_VETO_WINDOW_MINUTES,
  classifyPolicyExposure,
  resolveDailyCap,
} from '@/lib/auto-approval/policy';
import type {
  AutoApprovalPatchRequest,
  AutoApprovalReadinessBlockReason,
  AutoApprovalThreshold,
  PolicyExposureClassification,
  VetoWindowMinutes,
} from '@/lib/auto-approval/types';
import type { VoiceConfig } from '@/lib/responses/voice-settings';
import {
  OPERATION_INPUT_SCHEMAS,
  type PolicyOperationId,
  type VoiceOperationId,
} from './operation-inputs';
// Type-only, and it must stay so: `schema.ts` imports `operation-inputs.ts` at
// runtime, and a runtime import of `schema.ts` here would start the
// `catalog → schema` chain the leaf module exists to prevent.
import type { PolicyState } from './schema';

/**
 * Every v1 operation id. A TYPE, not a runtime array: nothing iterates the
 * catalog by id — the registry below is the one enumerable list, and the model
 * only ever sees the snapshot's `allowedOperations` slice of it. An `as const`
 * array here was a second, wider list with no consumer.
 */
export type CatalogOperationId =
  | 'read_operating_rules'
  | 'read_pending_work'
  | 'read_recent_completed'
  | VoiceOperationId
  | PolicyOperationId
  | 'record_unsupported_request';

export type LabelKind = 'rule' | 'fact';

export interface ReadOperation {
  id: CatalogOperationId;
  kind: 'read';
  describe: string;
}

export interface CaptureOperation {
  id: CatalogOperationId;
  kind: 'capture';
  describe: string;
}

export interface ProposablePreview {
  before: VoiceConfig;
  after: VoiceConfig;
}

/**
 * A policy **Proposal**'s preview: the FULL effective state of the target
 * scope before and after, row existence included (spec §4). Never only the
 * named dial — a dial change on a location with no row CREATES the row, and the
 * card must show everything that creation changes.
 */
export interface PolicyPreview {
  before: PolicyState;
  after: PolicyState;
}

/** The policy row a Proposal targets, taken from its STORED scope. */
export type PolicyTarget = { scope: 'account' } | { scope: 'location'; locationId: string };

/**
 * The current full states a policy preview starts from. The CALLER supplies
 * them (the turn worker at preparation, Apply under its locks); the catalog
 * reads nothing. `location` is the target location's EFFECTIVE state with its
 * own `rowExists`, and is null only for an account-scope proposal.
 */
export interface PolicyScopeState {
  accountDefault: PolicyState;
  location: PolicyState | null;
}

type ParseInputResult = { ok: true; input: Record<string, unknown> } | { ok: false };

/**
 * What every proposable shares. `parseInput` is the only door: it runs the
 * operation's own zod schema and hands the narrowed value to the other members
 * through a closure, so each `as T` inside `defineVoice`/`definePolicy` is the
 * one place the erasure is undone and it is unreachable without a successful
 * parse. No `any` anywhere.
 */
interface ProposableCommon {
  kind: 'proposable';
  contractVersion: 1;
  labelKind: LabelKind;
  /**
   * The input-free sentence the PROMPT sees. Distinct from `describe`, which
   * needs an input and is the CARD's words: calling `describe({})` to build the
   * prompt list would throw inside any describer that reads a field.
   */
  summary: string;
  /**
   * The JSON shape of `input`, as the PROMPT declares it to the model — a
   * literal like `{"tone": string}`. The zod schema is the contract; this is
   * its spelling for a reader that never sees zod. T8 (2026-09-13): the first
   * live turn on staging failed `model_output_invalid` on BOTH providers because
   * nothing declared the shape, so the model guessed keys the schema rejects.
   */
  inputShape: string;
  /** The card's one line for an input. Needs no state, so any stored row can be described. */
  describe(input: unknown): string;
  parseInput(value: unknown): ParseInputResult;
}

export interface VoiceProposableOperation extends ProposableCommon {
  id: VoiceOperationId;
  domain: 'voice';
  scopeRule: 'location';
  /** Spec §8.4: tone and facts change future drafts only. */
  affects: 'future_drafts';
  preview(voice: VoiceConfig, input: unknown): ProposablePreview;
  /**
   * The fields this operation — and ONLY this operation — writes, ready for
   * `updateVoiceConfig`'s `fields` bag.
   *
   * NOT `preview().after`. `after` is the FULL effective state, so passing it
   * to the writer would write the four fields the owner did not agree to
   * change, silently reverting a concurrent settings edit to a different
   * field. The **Version token** proves the ROW did not move; once that holds,
   * writing more than was proposed is a widening nobody approved (D10).
   */
  writerFields(input: unknown): Partial<VoiceConfig>;
}

type PolicyWriterOperation =
  | 'set_account_default'
  | 'set_account_manual'
  | 'set_location_override'
  | 'set_location_manual'
  | 'set_account_veto_window'
  | 'set_location_veto_window'
  | 'set_account_daily_cap'
  | 'set_location_daily_cap';

type WithoutConfirmation<T> = T extends unknown ? Omit<T, 'confirmationLevel'> : never;

/**
 * One shared-writer operation WITHOUT `confirmationLevel`. Apply adds that
 * after it checks the typed phrase (spec §6.4), together with the account and
 * actor fields; the catalog never decides a confirmation.
 */
export type PolicyWriterPatch = WithoutConfirmation<
  Extract<AutoApprovalPatchRequest, { operation: PolicyWriterOperation }>
>;

export interface PolicyProposableOperation extends ProposableCommon {
  id: PolicyOperationId;
  domain: 'policy';
  scopeRule: 'account_or_location';
  /** Spec §8.4: future eligible reviews. A draft already granted a veto window keeps it. */
  affects: 'future_eligible_reviews';
  preview(state: PolicyScopeState, target: PolicyTarget, input: unknown): PolicyPreview;
  exposure(preview: PolicyPreview, target: PolicyTarget): PolicyExposureClassification;
  /** The exact words the owner types on an expansion card (spec §3.3). Never shown to the model. */
  confirmationPhrase(after: PolicyState, target: PolicyTarget): string;
  /** This operation's input as ONE shared-writer operation, and nothing more (D10). */
  writerPatch(input: unknown, target: PolicyTarget): PolicyWriterPatch;
  /** The card's full before/after sentence, including the created-row sentence (spec §4). */
  describeChange(input: unknown, preview: PolicyPreview, target: PolicyTarget): string;
}

export type ProposableOperation = VoiceProposableOperation | PolicyProposableOperation;

export type CatalogOperation = ReadOperation | ProposableOperation | CaptureOperation;

function parserFor<T extends Record<string, unknown>>(schema: ZodType<T>) {
  return (value: unknown): ParseInputResult => {
    const parsed = schema.safeParse(value);
    return parsed.success ? { ok: true, input: parsed.data } : { ok: false };
  };
}

function defineVoice<T extends Record<string, unknown>>(spec: {
  id: VoiceOperationId;
  summary: string;
  inputSchema: ZodType<T>;
  /** Must spell exactly the keys `inputSchema` accepts — the validator is strict. */
  inputShape: string;
  describe: (input: T) => string;
  /**
   * The ONE spelling of what this operation changes. `preview` derives the
   * `after` state from it rather than taking a second `apply` function: an
   * operation that wrote its field twice — once for the card, once for the
   * writer — could show the owner a preview the executor does not honour.
   */
  writerFields: (input: T) => Partial<VoiceConfig>;
}): VoiceProposableOperation {
  return {
    id: spec.id,
    kind: 'proposable',
    domain: 'voice',
    contractVersion: 1,
    labelKind: 'fact',
    scopeRule: 'location',
    affects: 'future_drafts',
    summary: spec.summary,
    inputShape: spec.inputShape,
    parseInput: parserFor(spec.inputSchema),
    describe(input) {
      return spec.describe(input as T);
    },
    // before/after are the FULL effective voice state of the target location,
    // never only the named field (spec §4 "full effective state") — the full
    // state with THIS operation's own fields laid over it, so the card's
    // `after` is the writer's own change by construction.
    preview(voice, input) {
      return { before: voice, after: { ...voice, ...spec.writerFields(input as T) } };
    },
    // Same `as T` erasure undoing as `describe`: unreachable without a
    // successful `parseInput`, which every caller runs first.
    writerFields(input) {
      return spec.writerFields(input as T);
    },
  };
}

// ── Policy previews ───────────────────────────────────────────────────────

interface PolicyDialValues {
  threshold: AutoApprovalThreshold | null;
  vetoWindowMinutes: VetoWindowMinutes;
  dailyAutoPostCap: number | null;
}
type PolicyDial = keyof PolicyDialValues;

/**
 * The ONE spelling of what a policy operation changes: one dial and its new
 * value. The preview, the writer operation and the card sentence are all
 * derived from it, so the card cannot promise a change the writer does not make.
 */
type PolicyDialPatch = { [D in PolicyDial]: { dial: D; value: PolicyDialValues[D] } }[PolicyDial];

function currentPolicyState(state: PolicyScopeState, target: PolicyTarget): PolicyState {
  if (target.scope === 'account') return state.accountDefault;
  if (state.location === null) {
    throw new Error('agents/operator: a location-scope policy preview needs the location state');
  }
  return state.location;
}

/**
 * The row a write CREATES when none exists — `settings.ts` `freshRowSeed`,
 * mirrored for the preview. The threshold is never seeded: a new row starts on
 * manual approval. A location row takes the account default's STORED dials; an
 * account row has no parent and takes the schema defaults.
 */
function freshRowBase(accountDefault: PolicyState, target: PolicyTarget): PolicyState {
  const inherit = target.scope === 'location';
  const dailyAutoPostCap = inherit ? accountDefault.dailyAutoPostCap : null;
  return {
    domain: 'policy',
    threshold: null,
    vetoWindowMinutes: inherit ? accountDefault.vetoWindowMinutes : DEFAULT_VETO_WINDOW_MINUTES,
    dailyAutoPostCap,
    effectiveDailyCap: resolveDailyCap({ dailyAutoPostCap }),
    rowExists: false,
  };
}

function applyDial(base: PolicyState, patch: PolicyDialPatch): PolicyState {
  const dials: PolicyDialValues = {
    threshold: base.threshold,
    vetoWindowMinutes: base.vetoWindowMinutes,
    dailyAutoPostCap: base.dailyAutoPostCap,
  };
  switch (patch.dial) {
    case 'threshold':
      dials.threshold = patch.value;
      break;
    case 'vetoWindowMinutes':
      dials.vetoWindowMinutes = patch.value;
      break;
    case 'dailyAutoPostCap':
      dials.dailyAutoPostCap = patch.value;
      break;
  }
  return { domain: 'policy', ...dials, effectiveDailyCap: resolveDailyCap(dials), rowExists: true };
}

/**
 * Exposure of a policy preview through the shared classifier, with the
 * `completeDisable` flag computed the way `settings.ts` `isCompleteDisable`
 * computes it for these writer operations:
 *
 *  - creating a location row is a complete disable (the new row starts manual),
 *    even when the requested dial by itself widens;
 *  - a threshold change from enabled to manual is a complete disable.
 *
 * Everything else is classified per dimension, and any widening dimension wins.
 * A dial change on an ALREADY-manual row is not a complete disable.
 */
function classifyPolicyPreview(
  preview: PolicyPreview,
  target: PolicyTarget,
): PolicyExposureClassification {
  const createsLocationRow = target.scope === 'location'
    && !preview.before.rowExists && preview.after.threshold === null;
  const disablesEnabledPolicy = preview.before.threshold !== null && preview.after.threshold === null;
  return classifyPolicyExposure(preview.before, preview.after, {
    completeDisable: createsLocationRow || disablesEnabledPolicy,
  });
}

const LOCATION_CONFIRMATION_PHRASES: Record<AutoApprovalThreshold, string> = {
  4: '4 and 5 star',
  5: '5 star only',
};

/**
 * The typed scope for an expansion card (spec §3.3). An account change names
 * its reach; a location change names the resulting star scope, including when
 * a dial change is the widening.
 */
function policyConfirmationPhrase(after: PolicyState, target: PolicyTarget): string {
  if (target.scope === 'account') return 'all locations';
  return after.threshold === null ? 'off' : LOCATION_CONFIRMATION_PHRASES[after.threshold];
}

function writerPatchFor(patch: PolicyDialPatch, target: PolicyTarget): PolicyWriterPatch {
  switch (patch.dial) {
    case 'threshold':
      if (target.scope === 'account') {
        return patch.value === null
          ? { operation: 'set_account_manual' }
          : { operation: 'set_account_default', threshold: patch.value };
      }
      return patch.value === null
        ? { operation: 'set_location_manual', locationId: target.locationId }
        : { operation: 'set_location_override', locationId: target.locationId, threshold: patch.value };
    case 'vetoWindowMinutes':
      return target.scope === 'account'
        ? { operation: 'set_account_veto_window', minutes: patch.value }
        : { operation: 'set_location_veto_window', locationId: target.locationId, minutes: patch.value };
    case 'dailyAutoPostCap':
      return target.scope === 'account'
        ? { operation: 'set_account_daily_cap', cap: patch.value }
        : { operation: 'set_location_daily_cap', locationId: target.locationId, cap: patch.value };
  }
}

// ── Policy card words ─────────────────────────────────────────────────────

const THRESHOLD_STATE_WORDS: Record<AutoApprovalThreshold, string> = {
  4: 'replies to 4 and 5 star reviews can auto-post',
  5: 'only replies to 5 star reviews can auto-post',
};

const SCOPE_DESCRIPTIONS: Record<AutoApprovalThreshold, string> = {
  4: 'Let replies to 4 and 5 star reviews auto-post',
  5: 'Let only replies to 5 star reviews auto-post',
};

function capWords(state: PolicyState): string {
  return state.dailyAutoPostCap === null
    ? `daily cap of ${state.effectiveDailyCap} (the platform default)`
    : `daily cap of ${state.effectiveDailyCap}`;
}

function stateWords(state: PolicyState): string {
  const threshold = state.threshold === null ? 'every reply waits for you' : THRESHOLD_STATE_WORDS[state.threshold];
  return `${threshold}, a ${state.vetoWindowMinutes}-minute veto window, a ${capWords(state)}`;
}

function createdRowSentence(dial: PolicyDial, after: PolicyState, target: PolicyTarget): string {
  const startsManual = dial === 'threshold' ? '' : ' Auto-posting starts off.';
  if (target.scope === 'account') {
    return `This creates the account default.${startsManual} Settings it does not name start at the platform defaults.`;
  }
  const inherited = [
    dial === 'vetoWindowMinutes' ? null : `${after.vetoWindowMinutes}-minute veto window`,
    dial === 'dailyAutoPostCap' ? null : capWords(after),
  ].filter((part): part is string => part !== null);
  return `This gives this location its own settings.${startsManual} It keeps the account default's ${inherited.join(' and ')}.`;
}

function describePolicyChange(dial: PolicyDial, preview: PolicyPreview, target: PolicyTarget): string {
  const scopeWords = target.scope === 'account' ? 'Account default' : 'This location';
  const sentences = [
    `${scopeWords} now: ${stateWords(preview.before)}.`,
    `After Apply: ${stateWords(preview.after)}.`,
  ];
  if (!preview.before.rowExists) sentences.push(createdRowSentence(dial, preview.after, target));
  return sentences.join(' ');
}

function definePolicy<T extends Record<string, unknown>>(spec: {
  id: PolicyOperationId;
  summary: string;
  inputSchema: ZodType<T>;
  /** Must spell exactly the keys `inputSchema` accepts — the validator is strict. */
  inputShape: string;
  describe: (input: T) => string;
  patch: (input: T) => PolicyDialPatch;
}): PolicyProposableOperation {
  return {
    id: spec.id,
    kind: 'proposable',
    domain: 'policy',
    contractVersion: 1,
    labelKind: 'rule',
    scopeRule: 'account_or_location',
    affects: 'future_eligible_reviews',
    summary: spec.summary,
    inputShape: spec.inputShape,
    parseInput: parserFor(spec.inputSchema),
    describe(input) {
      return spec.describe(input as T);
    },
    preview(state, target, input) {
      const before = currentPolicyState(state, target);
      const base = before.rowExists ? before : freshRowBase(state.accountDefault, target);
      return { before, after: applyDial(base, spec.patch(input as T)) };
    },
    exposure: classifyPolicyPreview,
    confirmationPhrase: policyConfirmationPhrase,
    writerPatch(input, target) {
      return writerPatchFor(spec.patch(input as T), target);
    },
    describeChange(input, preview, target) {
      return describePolicyChange(spec.patch(input as T).dial, preview, target);
    },
  };
}

export const CATALOG: Readonly<Record<CatalogOperationId, CatalogOperation>> = {
  read_operating_rules: {
    id: 'read_operating_rules',
    kind: 'read',
    describe: 'Report the current operating rules for this location and the account default',
  },
  read_pending_work: {
    id: 'read_pending_work',
    kind: 'read',
    describe: 'Report how many replies are waiting, by star band. Counts only — never review text',
  },
  read_recent_completed: {
    id: 'read_recent_completed',
    kind: 'read',
    describe: 'Report how many replies posted in the last 7 days',
  },
  set_tone: defineVoice({
    id: 'set_tone',
    summary: 'Set the reply tone',
    inputSchema: OPERATION_INPUT_SCHEMAS.set_tone,
    inputShape: '{"tone": string}',
    describe: (input) => `Set the reply tone to "${input.tone}"`,
    writerFields: (input) => ({ tone: input.tone }),
  }),
  set_products_services: defineVoice({
    id: 'set_products_services',
    summary: 'Update the products and services the replies may mention',
    inputSchema: OPERATION_INPUT_SCHEMAS.set_products_services,
    inputShape: '{"productsServices": string | null}',
    describe: (input) => input.productsServices === null
      ? 'Clear the products and services the replies may mention'
      : 'Update the products and services the replies may mention',
    writerFields: (input) => ({ productsServices: input.productsServices }),
  }),
  set_avoid_facts: defineVoice({
    id: 'set_avoid_facts',
    summary: 'Set what to keep out of every reply',
    inputSchema: OPERATION_INPUT_SCHEMAS.set_avoid_facts,
    inputShape: '{"avoidFacts": string[]}',
    describe: (input) => `Keep ${input.avoidFacts.length} thing(s) out of every reply`,
    writerFields: (input) => ({ avoidFacts: input.avoidFacts }),
  }),
  set_highlight_facts: defineVoice({
    id: 'set_highlight_facts',
    summary: 'Set what to highlight when a reply fits',
    inputSchema: OPERATION_INPUT_SCHEMAS.set_highlight_facts,
    inputShape: '{"highlightFacts": string[]}',
    describe: (input) => `Highlight ${input.highlightFacts.length} thing(s) when a reply fits`,
    writerFields: (input) => ({ highlightFacts: input.highlightFacts }),
  }),
  set_auto_reply_scope: definePolicy({
    id: 'set_auto_reply_scope',
    summary: 'Set which reviews can get an auto-posted reply: 4 and 5 star (4), 5 star only (5), or off (null)',
    inputSchema: OPERATION_INPUT_SCHEMAS.set_auto_reply_scope,
    inputShape: '{"threshold": 4 | 5 | null}',
    describe: (input) => input.threshold === null
      ? 'Turn auto-posting off so every reply waits for you'
      : SCOPE_DESCRIPTIONS[input.threshold],
    patch: (input) => ({ dial: 'threshold', value: input.threshold }),
  }),
  set_veto_window: definePolicy({
    id: 'set_veto_window',
    summary: 'Set how long each auto-post waits for the owner first: 15 or 30 minutes',
    inputSchema: OPERATION_INPUT_SCHEMAS.set_veto_window,
    inputShape: '{"minutes": 15 | 30}',
    describe: (input) => `Make each auto-post wait ${input.minutes} minutes for you first`,
    patch: (input) => ({ dial: 'vetoWindowMinutes', value: input.minutes }),
  }),
  set_daily_cap: definePolicy({
    id: 'set_daily_cap',
    summary: 'Set the most replies that can auto-post each day: 1 to 50, or null for the platform default',
    inputSchema: OPERATION_INPUT_SCHEMAS.set_daily_cap,
    inputShape: '{"cap": integer 1 to 50 | null}',
    describe: (input) => input.cap === null
      ? 'Use the platform daily limit for auto-posts'
      : `Auto-post at most ${input.cap} replies a day`,
    patch: (input) => ({ dial: 'dailyAutoPostCap', value: input.cap }),
  }),
  record_unsupported_request: {
    id: 'record_unsupported_request',
    kind: 'capture',
    describe: 'Record something RepWorth cannot do yet. Nothing changes',
  },
};

export interface ModelVisibleOperation {
  id: CatalogOperationId;
  kind: CatalogOperation['kind'];
  labelKind: LabelKind | null;
  describe: string;
  /** Proposables only: the `input` shape the model must emit, verbatim from the catalog. */
  input?: string;
  /** Proposables only: which scopes a proposal may target. */
  scopeRule?: ProposableOperation['scopeRule'];
  /**
   * Policy proposables only: the settings readiness reasons that block a
   * WIDENING of auto-posting for this account, verbatim. Empty when nothing
   * blocks. A narrowing is never blocked, so the operation stays listed either
   * way — filtering it out on Copilot would also hide "turn auto-posting off".
   */
  expansionBlockedBy?: readonly AutoApprovalReadinessBlockReason[];
}

/**
 * What the prompt is allowed to name. Every operation is listed on every tier.
 * The tier gate is readiness (`autopilot_unavailable` among its reasons), and
 * it is ATTACHED to the policy operations rather than used as a filter:
 * readiness blocks expansions only (`settings.ts` `assertExpansionReady`), and
 * the server classifies exposure at Apply, never the model.
 */
export function modelVisibleOperations(readiness: {
  readonly blockReasons: readonly AutoApprovalReadinessBlockReason[];
}): readonly ModelVisibleOperation[] {
  return Object.values(CATALOG).map((op): ModelVisibleOperation => {
    if (op.kind !== 'proposable') {
      return { id: op.id, kind: op.kind, labelKind: null, describe: op.describe };
    }
    return {
      id: op.id,
      kind: op.kind,
      labelKind: op.labelKind,
      // `summary`, never `describe({})`: the prompt list has no input to describe.
      describe: op.summary,
      // The input shape rides the operation it belongs to, so the prompt never
      // carries a second, wider list of ids (see the prompt's own note).
      input: op.inputShape,
      scopeRule: op.scopeRule,
      ...(op.domain === 'policy' ? { expansionBlockedBy: [...readiness.blockReasons] } : {}),
    };
  });
}

export function proposableOperation(id: string): ProposableOperation | null {
  const entry = (CATALOG as Record<string, CatalogOperation | undefined>)[id];
  return entry && entry.kind === 'proposable' ? entry : null;
}
