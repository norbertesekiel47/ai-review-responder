// src/lib/reviews/triage-schema.ts
//
// Single authoritative vocabulary for WS2 Guardian triage: severity levels,
// issue taxonomy, suggested actions, source tags, and the structured-output
// zod schema. Deliberately a leaf module (imports only zod) so BOTH the LLM
// task registry (src/lib/llm/tasks.ts) and the triage domain module can
// import it without a cycle. Values must stay in lockstep with migration
// 072's CHECK constraints.

import { z } from 'zod';

export const TRIAGE_SEVERITIES = ['low', 'medium', 'high'] as const;
export type TriageSeverity = (typeof TRIAGE_SEVERITIES)[number];

/** Fixed issue taxonomy — enums only, so step detail / analytics never carry
 *  raw review text (logging rules). Extend here, nowhere else. */
export const TRIAGE_ISSUES = [
  'service_quality', 'product_quality', 'wait_time', 'pricing',
  'cleanliness', 'staff_conduct', 'order_accuracy', 'communication',
  'safety_or_health', 'billing_or_refund', 'other',
] as const;
export type TriageIssue = (typeof TRIAGE_ISSUES)[number];

export const TRIAGE_SUGGESTED_ACTIONS = ['respond', 'escalate', 'respond_and_escalate'] as const;

export const TRIAGE_SOURCE = {
  LLM: 'llm_triage_v1',
  FALLBACK: 'fallback_high_v1',
  MOCK: 'mock_v1',
} as const;
export type TriageSource = (typeof TRIAGE_SOURCE)[keyof typeof TRIAGE_SOURCE];

export const TriageOutputSchema = z.object({
  severity: z.enum(TRIAGE_SEVERITIES),
  issues: z.array(z.enum(TRIAGE_ISSUES)).max(3),
  suggested_action: z.enum(TRIAGE_SUGGESTED_ACTIONS),
}).strict();
export type TriageOutput = z.infer<typeof TriageOutputSchema>;
