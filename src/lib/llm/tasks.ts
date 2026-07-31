import type { LLMTaskDescriptor, LLMTaskId } from './types';
import { TriageOutputSchema } from '@/lib/reviews/triage-schema';
import { JudgeOutputSchema } from '@/lib/responses/judge-schema';
import { SolicitationAskOutputSchema } from '@/lib/solicitation/ask-schema';

// Pinned snapshots — never a bare alias like 'gpt-4o-mini' (silent-regression
// risk). Guarded by model-pinning.test.ts. Single owner: consumers import
// these directly from here (the generator back-compat re-exports were retired
// in the 2f sweep).
export const OPENAI_MODEL = 'gpt-4o-mini-2024-07-18' as const;
export const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001' as const;

/** Runtime registry. Internal: getLlmTask is the module's door. */
const LLM_TASKS: Record<LLMTaskId, LLMTaskDescriptor> = {
  reply_generation: {
    taskId: 'reply_generation',
    primary: { provider: 'openai', model: OPENAI_MODEL },
    fallback: { provider: 'anthropic', model: ANTHROPIC_MODEL },
    maxTokens: 300,
    temperature: 0.7,
  },
  insights: {
    taskId: 'insights',
    primary: { provider: 'openai', model: OPENAI_MODEL },
    fallback: { provider: 'anthropic', model: ANTHROPIC_MODEL },
    maxTokens: 250,
    temperature: 0.5,
  },
  triage: {
    taskId: 'triage',
    primary: { provider: 'openai', model: OPENAI_MODEL },
    fallback: { provider: 'anthropic', model: ANTHROPIC_MODEL },
    maxTokens: 200,
    temperature: 0,
    outputSchema: TriageOutputSchema,
  },
  judge: {
    taskId: 'judge',
    primary: { provider: 'openai', model: OPENAI_MODEL },
    fallback: { provider: 'anthropic', model: ANTHROPIC_MODEL },
    maxTokens: 300,
    temperature: 0,
    outputSchema: JudgeOutputSchema,
  },
  solicitation_ask: {
    taskId: 'solicitation_ask',
    primary: { provider: 'openai', model: OPENAI_MODEL },
    fallback: { provider: 'anthropic', model: ANTHROPIC_MODEL },
    maxTokens: 400,
    // 0.6 by design (spec §4.3): below reply_generation's 0.7 for the stricter
    // fact-provenance bar, above 0 so sibling asks in one batch don't render
    // near-identical bodies. Structured output does NOT imply temperature 0 here.
    temperature: 0.6,
    outputSchema: SolicitationAskOutputSchema,
  },
};

export function getLlmTask(taskId: LLMTaskId): LLMTaskDescriptor {
  const task = LLM_TASKS[taskId];
  if (!task) throw new Error(`LLM task not registered: ${taskId}`);
  return task;
}
