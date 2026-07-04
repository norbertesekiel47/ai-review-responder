import type { LLMTaskDescriptor, LLMTaskId } from './types';

// Pinned snapshots — never a bare alias like 'gpt-4o-mini' (silent-regression
// risk). Guarded by model-pinning.test.ts. Single owner: generator.ts
// re-exports for back-compat until the Stage-2 sweep retargets consumers.
export const OPENAI_MODEL = 'gpt-4o-mini-2024-07-18' as const;
export const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001' as const;

/** Runtime registry. 'triage' / 'judge' / 'insights' exist in the LLMTaskId
 *  vocabulary (types.ts) but get entries only when their feature lands —
 *  no dead task config ships before its tenant (spec §2.2). Internal:
 *  getLlmTask is the module's door. */
const LLM_TASKS: Partial<Record<LLMTaskId, LLMTaskDescriptor>> = {
  reply_generation: {
    taskId: 'reply_generation',
    primary: { provider: 'openai', model: OPENAI_MODEL },
    fallback: { provider: 'anthropic', model: ANTHROPIC_MODEL },
    maxTokens: 300,
    temperature: 0.7,
  },
};

export function getLlmTask(taskId: LLMTaskId): LLMTaskDescriptor {
  const task = LLM_TASKS[taskId];
  if (!task) throw new Error(`LLM task not registered: ${taskId}`);
  return task;
}
