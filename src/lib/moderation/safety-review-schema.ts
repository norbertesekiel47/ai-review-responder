import { z } from 'zod';
import type { LLMProviderId } from '@/lib/llm/types';

// The Safety review's output contract. Split from safety-review.ts so the task
// registry (src/lib/llm/tasks.ts) can hold the schema without importing the
// worker-only module and its cost-guard graph. Precedent: judge-schema.ts.

/** The concern classes G4-F1 proved the provider classifier misses. */
export const SAFETY_CONCERNS = [
  'implied_threat',
  'implied_sexual',
  'targeted_abuse',
] as const;
export type SafetyConcern = (typeof SAFETY_CONCERNS)[number];

/**
 * THE REFINE IS THE GATE, not decoration.
 *
 * Without it the object accepts `{ cleared: true, concern: 'implied_threat' }`
 * — a model that names a threat AND permits auto-approval. `runLlmTask`'s
 * authority is schema validation and nothing else (run-task.ts:101 safeParse),
 * and the gate reads only `cleared`, so that contradiction would post. It has
 * to be rejected HERE. A refinement failure raises LLMStructuredOutputError and
 * lands in reviewSafety's fail-closed catch, exactly like malformed JSON.
 *
 * The rule is ONE-DIRECTIONAL on purpose: `cleared: false` with a null concern
 * stays VALID. That is the shape every failure path returns, and the shape a
 * model uses when it declines without classifying.
 *
 * `strictObject`, like JudgeOutputSchema: an extra key means the model answered
 * a different question than the one asked.
 *
 * The refine does NOT survive JSON-Schema conversion — a cross-field constraint
 * has no expression there, so neither provider's structured-output grammar can
 * prevent the contradiction at generation time. That is expected and is why the
 * check belongs in validation: the provider may emit it, and `safeParse` is what
 * refuses it. Verified against the installed `zodResponseFormat` and the
 * Anthropic output-format helper — both convert this schema, both drop the
 * refine, and run-task.ts:101 applies it.
 */
export const SafetyReviewOutputSchema = z
  .strictObject({
    cleared: z.boolean(),
    concern: z.enum(SAFETY_CONCERNS).nullable(),
  })
  .refine((value) => !(value.cleared && value.concern !== null), {
    message: 'cleared=true cannot carry a named safety concern',
    path: ['concern'],
  });

export type SafetyReviewOutput = z.infer<typeof SafetyReviewOutputSchema>;

/**
 * Why a verdict reads the way it does.
 *
 * Load-bearing, not decoration: every failure yields `cleared: false`, so
 * without this a provider outage is indistinguishable from a strict model.
 * - `llm`     — a model answered.
 * - `failed`  — the check itself failed. Fail-closed at runtime; NEVER evidence
 *               (the corpus scores it `safety_error` against a zero budget).
 * - `mock`    — MOCK_EXTERNAL_APIS short-circuit (deviation D2). Local dev only.
 * - `skipped` — the check did not run.
 */
export type SafetyVerdictSource = 'llm' | 'failed' | 'mock' | 'skipped';

export interface SafetyVerdict {
  cleared: boolean;
  concern: SafetyConcern | null;
  source: SafetyVerdictSource;
  /**
   * Which provider answered, or null when none did (`failed`, `mock`,
   * `skipped`). Deviation D5: the owner kept the Anthropic fallback, so a
   * blocked primary reaches it and production may answer from a provider the
   * corpus never measured. Recording this is what stops the evidence claiming
   * coverage it does not have.
   */
  provider: LLMProviderId | null;
}
