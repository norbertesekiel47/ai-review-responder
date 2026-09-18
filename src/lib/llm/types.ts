// The LLM task seam (campaign spec §2.2, docs/superpowers/specs/2026-07-01-modularity-aplus-campaign-design.md).
// Bounded by the agentic design-of-record: four task kinds, per-task pinned
// models with fallback, structured outputs for classification/judge tasks.
// DELIBERATELY ABSENT (the design-of-record disqualifies them): streaming,
// tool-calls, multi-turn loops.
//
// COST-GUARD CONTRACT: every runLlmTask call in production code MUST be
// wrapped in withCostGuard by its caller (see the cost-guard skill). The
// guard stays caller-side because generation's idempotent-cache write must
// happen inside the guarded closure (the M3 race — see generator.ts).
// Demo/eval callers are the sanctioned unguarded exceptions.
import type { z } from 'zod';

export type LLMTaskId =
  | 'reply_generation'
  | 'triage'
  | 'judge'
  | 'insights'
  | 'solicitation_ask'
  | 'owner_operator'
  | 'safety_review';

export type LLMProviderId = 'openai' | 'anthropic';

export interface ChatPrompt {
  system: string;
  user: string;
}

export interface LLMCallResult {
  text: string;
  provider: LLMProviderId;
  model: string;
  usage: { promptTokens: number; completionTokens: number };
  /** Validated output for tasks that declare an outputSchema; absent otherwise. */
  structured?: unknown;
  /**
   * Set by a provider ONLY for a structured request whose completion was
   * refused or cut off at maxTokens. The attempt is still billed: runLlmTask
   * turns it into an LLMStructuredOutputError carrying this usage. Absent on
   * every unstructured result, so those stay byte-identical.
   */
  incomplete?: 'refused' | 'truncated';
}

/**
 * A task's structured-output contract as it crosses the provider seam. Built
 * by runLlmTask from LLMTaskDescriptor.outputSchema — the same Zod object, not
 * a copy — so there is no second schema registry. Each provider derives its
 * own wire schema from it with its SDK's installed helper.
 */
export interface LLMStructuredOutput {
  /** Provider-facing schema name. The task id already satisfies OpenAI's
   *  `^[a-zA-Z0-9_-]{1,64}$` name rule. */
  name: LLMTaskId;
  schema: z.ZodTypeAny;
}

export interface LLMRequest extends ChatPrompt {
  model: string;
  maxTokens: number;
  temperature?: number;
  /** Present only for tasks that declare an outputSchema. Key ABSENT (not
   *  undefined) for unstructured tasks. */
  structuredOutput?: LLMStructuredOutput;
}

export interface LLMProvider {
  readonly id: LLMProviderId;
  complete(request: LLMRequest): Promise<LLMCallResult>;
}

export interface LLMTaskDescriptor {
  taskId: LLMTaskId;
  primary: { provider: LLMProviderId; model: string };
  fallback?: { provider: LLMProviderId; model: string };
  maxTokens: number;
  /** Honored by both providers (anthropic forwarding landed with #628 — see
   *  anthropic-provider.ts). Undefined leaves each SDK's default in force. */
  temperature?: number;
  /** Structured-output contract for classification/judge tasks. Enforced by
   *  runLlmTask: the completion is fence-stripped, JSON.parsed, and validated;
   *  the validated value lands on LLMCallResult.structured. */
  outputSchema?: z.ZodTypeAny;
}
