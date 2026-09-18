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
 * The shape only. The CONTRADICTION IS NOT REJECTED HERE, and that is a
 * correction — revision 3a rejected it with a `.refine` and the security review
 * proved what that actually did.
 *
 * A refine failure raises `LLMStructuredOutputError` inside `completeAttempt`,
 * which `attemptProvider` catches and turns into `{ kind: 'error' }`
 * (`run-task.ts`, `attemptProvider`). With a fallback registered — and
 * deviation D5 keeps one — that is a PROVIDER FAILOVER, not a block: Anthropic
 * is asked the same prompt fresh, is never told the primary named a threat, and
 * a `{ cleared: true, concern: null }` answer then opens the auto-approval
 * lane. The model that caught the threat is silently overruled.
 *
 * So the contradiction is resolved by DERIVATION instead — see
 * `deriveSafetyVerdict` below. That was the other branch plan round-1 finding 2
 * offered ("reject the combination, OR derive clearance from a single
 * authoritative field"), and it is the correct one: a contradictory answer
 * becomes a not-cleared VERDICT rather than a failed attempt, so no failover
 * can launder it.
 *
 * `strictObject`, like JudgeOutputSchema: an extra key means the model answered
 * a different question than the one asked. That one IS a shape error and
 * failing over on it is right — nothing about the draft has been asserted.
 */
export const SafetyReviewOutputSchema = z.strictObject({
  cleared: z.boolean(),
  concern: z.enum(SAFETY_CONCERNS).nullable(),
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

/**
 * THE ONE PLACE A VERDICT IS BUILT FROM A MODEL ANSWER.
 *
 * `concern !== null` is authoritative: a model that named a concern has NOT
 * cleared the draft, whatever it put in `cleared`. Deriving rather than
 * validating is what keeps a contradiction inside the verdict instead of
 * turning it into a failed provider attempt that the fallback then retries
 * (see the schema comment above).
 *
 * Exported because the corpus lane must build its verdicts the SAME way. A
 * second spelling there would let the recorded evidence describe a check the
 * deployed one does not match.
 */
export function deriveSafetyVerdict(
  output: SafetyReviewOutput,
  provider: LLMProviderId,
): SafetyVerdict {
  return {
    cleared: output.cleared && output.concern === null,
    concern: output.concern,
    source: 'llm',
    provider,
  };
}

/** Every failure path returns THIS. One object, so no caller can branch on shape. */
export const FAILED_SAFETY_VERDICT: SafetyVerdict = Object.freeze({
  cleared: false,
  concern: null,
  source: 'failed',
  provider: null,
});
