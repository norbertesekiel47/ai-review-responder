// The input schema of every proposable Owner Operator operation, in a LEAF
// module with two consumers: the catalog, whose `parseInput` is the only door to
// an operation's write-shaped members, and the model output schema, which nests
// each one under its operation id so a provider can be constrained to a finite
// wire shape. Owning them in either consumer would make the other import it, and
// `catalog.ts` already takes a type from `schema.ts` — this module is what keeps
// that from becoming a `catalog → schema → catalog` runtime cycle.
//
// No `.transform()`: the provider seam converts these with `z.toJSONSchema`,
// which cannot represent one. `.trim()` is a Zod overwrite CHECK, not a
// transform, so it survives the conversion and still normalizes on parse.
import { z } from 'zod';
import type { AutoApprovalThreshold, VetoWindowMinutes } from '@/lib/auto-approval/types';
import { VOICE_FIELD_LIMITS } from '@/lib/responses/voice-settings';

export type VoiceOperationId =
  | 'set_tone'
  | 'set_products_services'
  | 'set_avoid_facts'
  | 'set_highlight_facts';

export type PolicyOperationId = 'set_auto_reply_scope' | 'set_veto_window' | 'set_daily_cap';

export type ProposableOperationId = VoiceOperationId | PolicyOperationId;

// ── Auto-approval value domains ───────────────────────────────────────────
//
// `src/lib/auto-approval/types.ts` owns these domains and keeps its zod schemas
// module-private; its public surface is the TYPES, the guards and the writer's
// `AutoApprovalPatchSchema`. The annotations pin each spelling below to the
// shared type, and operation-inputs.test.ts pins the RUNTIME domain to the
// shared guards and to the writer's own schema, so a change there fails here
// instead of producing a Proposal the writer refuses.

/** 4 = 4 and 5 star, 5 = 5 star only, null = manual (auto-posting off). */
export const ThresholdValueSchema: z.ZodType<AutoApprovalThreshold | null> =
  z.literal([4, 5]).nullable();

export const VetoWindowValueSchema: z.ZodType<VetoWindowMinutes> = z.literal([15, 30]);

/** Stored 1..50; null = the platform default (`resolveDailyCap`). */
export const DailyCapValueSchema: z.ZodType<number | null> =
  z.number().int().min(1).max(50).nullable();

// ── Voice inputs ──────────────────────────────────────────────────────────
//
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

// ── Policy inputs ─────────────────────────────────────────────────────────
//
// One dial each. The TARGET (account default or the turn's location) is the
// proposal's `scope`, never an input key, so the same input means the same
// change at either scope and the writer operation is chosen by the catalog.
const AutoReplyScopeInput = z.object({ threshold: ThresholdValueSchema }).strict();
const VetoWindowInput = z.object({ minutes: VetoWindowValueSchema }).strict();
const DailyCapInput = z.object({ cap: DailyCapValueSchema }).strict();

export const OPERATION_INPUT_SCHEMAS = {
  set_tone: ToneInput,
  set_products_services: ProductsServicesInput,
  set_avoid_facts: AvoidFactsInput,
  set_highlight_facts: HighlightFactsInput,
  set_auto_reply_scope: AutoReplyScopeInput,
  set_veto_window: VetoWindowInput,
  set_daily_cap: DailyCapInput,
} as const satisfies Record<ProposableOperationId, z.ZodType<Record<string, unknown>>>;
