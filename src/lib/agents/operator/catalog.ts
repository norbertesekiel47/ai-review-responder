// The v1 operation catalog. Four kinds, separated by TypeScript type so a write
// cannot be registered as immediately executable (spec §4). Run A registers
// three reads, FOUR proposable voice operations and one capture; the three
// auto-approval operations and the Apply/Decline commands are Run B and are
// deliberately absent — not stubbed, absent, so `modelVisibleOperations` cannot
// hand the model a name whose executor does not exist.
import { z } from 'zod';
import type { SubscriptionTierValue } from '@/lib/accounts/tier-config';
import { VOICE_FIELD_LIMITS, type VoiceConfig } from '@/lib/responses/voice-settings';

export const CATALOG_OPERATION_IDS = [
  'read_operating_rules',
  'read_pending_work',
  'read_recent_completed',
  'set_tone',
  'set_products_services',
  'set_avoid_facts',
  'set_highlight_facts',
  'record_unsupported_request',
] as const;
export type CatalogOperationId = (typeof CATALOG_OPERATION_IDS)[number];

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
 * The type-erased shape the runtime uses. `parseInput` is the only door: it
 * runs the operation's own zod schema and hands the narrowed value to
 * `describe`/`preview` through a closure, so the `as T` inside `defineProposable`
 * is the one place the erasure is undone and it is unreachable without a
 * successful parse. No `any` anywhere.
 */
export interface ProposableOperation {
  id: CatalogOperationId;
  kind: 'proposable';
  contractVersion: 1;
  labelKind: LabelKind;
  scopeRule: 'location';
  /**
   * The input-free sentence the PROMPT sees. Distinct from `describe`, which
   * needs an input and is the CARD's words: calling `describe({})` to build the
   * prompt list would throw inside any describer that reads a field.
   */
  summary: string;
  describe(input: unknown): string;
  parseInput(value: unknown): { ok: true; input: Record<string, unknown> } | { ok: false };
  preview(voice: VoiceConfig, input: unknown): ProposablePreview;
}

export type CatalogOperation = ReadOperation | ProposableOperation | CaptureOperation;

function defineProposable<T extends Record<string, unknown>>(spec: {
  id: CatalogOperationId;
  labelKind: LabelKind;
  summary: string;
  inputSchema: z.ZodType<T>;
  describe: (input: T) => string;
  apply: (voice: VoiceConfig, input: T) => VoiceConfig;
}): ProposableOperation {
  return {
    id: spec.id,
    kind: 'proposable',
    contractVersion: 1,
    labelKind: spec.labelKind,
    scopeRule: 'location',
    summary: spec.summary,
    parseInput(value) {
      const parsed = spec.inputSchema.safeParse(value);
      return parsed.success ? { ok: true, input: parsed.data } : { ok: false };
    },
    describe(input) {
      return spec.describe(input as T);
    },
    // before/after are the FULL effective voice state of the target location,
    // never only the named field (spec §4 "full effective state").
    preview(voice, input) {
      return { before: voice, after: spec.apply(voice, input as T) };
    },
  };
}

// Limits come from VOICE_FIELD_LIMITS, the single owner of each voice field's
// domain, which the settings route's `VoiceConfigSchema` reads too — so a
// Proposal can never carry a value the shared writer's own route would reject,
// and raising a limit in one place cannot leave the other silently stricter.
// `.min(1)` is this side's own rule: a proposal to set a field to the empty
// string is not a change an owner asked for.
const ToneInput = z.object({
  tone: z.string().trim().min(1).max(VOICE_FIELD_LIMITS.tone.maxLength),
}).strict();
const ProductsServicesInput = z.object({
  productsServices: z.string().max(VOICE_FIELD_LIMITS.productsServices.maxLength).nullable(),
}).strict();
const AvoidFactsInput = z.object({
  avoidFacts: z.array(z.string().trim().min(1).max(VOICE_FIELD_LIMITS.avoidFacts.maxLength))
    .max(VOICE_FIELD_LIMITS.avoidFacts.maxItems),
}).strict();
const HighlightFactsInput = z.object({
  highlightFacts: z.array(z.string().trim().min(1).max(VOICE_FIELD_LIMITS.highlightFacts.maxLength))
    .max(VOICE_FIELD_LIMITS.highlightFacts.maxItems),
}).strict();

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
  set_tone: defineProposable({
    id: 'set_tone',
    labelKind: 'fact',
    summary: 'Set the reply tone',
    inputSchema: ToneInput,
    describe: (input) => `Set the reply tone to "${input.tone}"`,
    apply: (voice, input) => ({ ...voice, tone: input.tone }),
  }),
  set_products_services: defineProposable({
    id: 'set_products_services',
    labelKind: 'fact',
    summary: 'Update the products and services the replies may mention',
    inputSchema: ProductsServicesInput,
    describe: (input) => input.productsServices === null
      ? 'Clear the products and services the replies may mention'
      : 'Update the products and services the replies may mention',
    apply: (voice, input) => ({ ...voice, productsServices: input.productsServices }),
  }),
  set_avoid_facts: defineProposable({
    id: 'set_avoid_facts',
    labelKind: 'fact',
    summary: 'Set what to keep out of every reply',
    inputSchema: AvoidFactsInput,
    describe: (input) => `Keep ${input.avoidFacts.length} thing(s) out of every reply`,
    apply: (voice, input) => ({ ...voice, avoidFacts: input.avoidFacts }),
  }),
  set_highlight_facts: defineProposable({
    id: 'set_highlight_facts',
    labelKind: 'fact',
    summary: 'Set what to highlight when a reply fits',
    inputSchema: HighlightFactsInput,
    describe: (input) => `Highlight ${input.highlightFacts.length} thing(s) when a reply fits`,
    apply: (voice, input) => ({ ...voice, highlightFacts: input.highlightFacts }),
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
}

/**
 * What the prompt is allowed to name. Every Run A operation is available on
 * every tier — the tier-gated operations are the three auto-approval ones,
 * which Run A does not register — so the parameter is threaded now rather than
 * retrofitted when Run B adds them.
 */
export function modelVisibleOperations(
  _tier: SubscriptionTierValue,
): readonly ModelVisibleOperation[] {
  return Object.values(CATALOG).map((op) => ({
    id: op.id,
    kind: op.kind,
    labelKind: op.kind === 'proposable' ? op.labelKind : null,
    // `summary`, never `describe({})`: the prompt list has no input to describe.
    describe: op.kind === 'proposable' ? op.summary : op.describe,
  }));
}

export function proposableOperation(id: string): ProposableOperation | null {
  const entry = (CATALOG as Record<string, CatalogOperation | undefined>)[id];
  return entry && entry.kind === 'proposable' ? entry : null;
}
