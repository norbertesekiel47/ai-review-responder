import type { LLMTaskDescriptor, LLMTaskId } from './types';
import { TriageOutputSchema } from '@/lib/reviews/triage-schema';
import { JudgeOutputSchema } from '@/lib/responses/judge-schema';
import { SolicitationAskOutputSchema } from '@/lib/solicitation/ask-schema';
import { OperatorModelOutputSchema } from '@/lib/agents/operator/schema';
import { SafetyReviewOutputSchema } from '@/lib/moderation/safety-review-schema';

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
  safety_review: {
    taskId: 'safety_review',
    primary: { provider: 'openai', model: OPENAI_MODEL },
    // KEPT deliberately (deviation D5, owner decision 2026-09-18). A blocked
    // primary proceeds here (run-task.ts:242) and a healthy fallback returns
    // normally, so ONLY an all-attempts failure yields not-cleared. The locked
    // intake said "open circuit -> no call attempted"; that was never true of
    // this executor. Availability was chosen over the literal contract, and the
    // price is paid by recording `provider` on every verdict and corpus row.
    fallback: { provider: 'anthropic', model: ANTHROPIC_MODEL },
    // 120 is enough for {cleared, concern}: a verdict, not prose.
    maxTokens: 120,
    // 0, like triage and judge. This decides whether a draft POSTS, so the
    // same draft must not clear on one call and block on the next.
    temperature: 0,
    outputSchema: SafetyReviewOutputSchema,
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
  owner_operator: {
    taskId: 'owner_operator',
    primary: { provider: 'openai', model: OPENAI_MODEL },
    fallback: { provider: 'anthropic', model: ANTHROPIC_MODEL },
    // 1200 by design: an Operator reply is an ordered segment list plus up to
    // five proposals with rationales — several times a judge verdict's budget.
    maxTokens: 1200,
    // 0.2, not 0: structured planning output that still needs to read as a
    // sentence. Below reply_generation's 0.7 because a proposal is a contract,
    // not prose. Spec §14 leaves the MODEL choice open; this run only pins it.
    temperature: 0.2,
    outputSchema: OperatorModelOutputSchema,
  },
};

export function getLlmTask(taskId: LLMTaskId): LLMTaskDescriptor {
  const task = LLM_TASKS[taskId];
  if (!task) throw new Error(`LLM task not registered: ${taskId}`);
  return task;
}
