// src/lib/reviews/triage-schema.ts
//
// Single authoritative vocabulary for WS2 Guardian triage: severity levels,
// issue taxonomy, suggested actions, source tags, and the structured-output
// zod schema. Deliberately a leaf module (imports only zod) so BOTH the LLM
// task registry (src/lib/llm/tasks.ts) and the triage domain module can
// import it without a cycle. Values must stay in lockstep with migration
// 072's CHECK constraints.
//
// Per-field types derive from TriageOutput; only add standalone type aliases
// when a non-test consumer exists (fallow dead-code gate).

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

/** Humanized labels for owner-facing escalation notices (WS3). Single owner —
 *  exhaustive over TriageIssue so adding a taxonomy value forces a label. */
export const TRIAGE_ISSUE_LABELS: Record<TriageIssue, string> = {
  service_quality: 'Service quality',
  product_quality: 'Product quality',
  wait_time: 'Wait time',
  pricing: 'Pricing',
  cleanliness: 'Cleanliness',
  staff_conduct: 'Staff conduct',
  order_accuracy: 'Order accuracy',
  communication: 'Communication',
  safety_or_health: 'Safety or health',
  billing_or_refund: 'Billing or refund',
  other: 'Other',
};

/** Humanized severity labels for owner-facing escalation notices (WS3). Single owner. */
export const TRIAGE_SEVERITY_LABELS: Record<TriageSeverity, string> = {
  low: 'Low severity',
  medium: 'Medium severity',
  high: 'High severity',
};

export const TRIAGE_SUGGESTED_ACTIONS = ['respond', 'escalate', 'respond_and_escalate'] as const;

/** The suggested_action values that raise a Guardian escalation (WS3).
 *  Single owner — the raise predicate derives from this so the taxonomy and
 *  the escalation trigger can't drift. */
export const ESCALATING_ACTIONS = ['escalate', 'respond_and_escalate'] as const;
export type EscalatingAction = (typeof ESCALATING_ACTIONS)[number];

export const TRIAGE_SOURCE = {
  LLM: 'llm_triage_v1',
  FALLBACK: 'fallback_high_v1',
  MOCK: 'mock_v1',
} as const;
export type TriageSource = (typeof TRIAGE_SOURCE)[keyof typeof TRIAGE_SOURCE];

export const TriageOutputSchema = z.strictObject({
  severity: z.enum(TRIAGE_SEVERITIES),
  issues: z.array(z.enum(TRIAGE_ISSUES)).max(3),
  suggested_action: z.enum(TRIAGE_SUGGESTED_ACTIONS),
});
export type TriageOutput = z.infer<typeof TriageOutputSchema>;

/** One review's triage result as produced by `classifyReviewTriage`
 *  (src/lib/reviews/triage.ts). Lives here — not in triage.ts — so the
 *  escalation raise module can consume it without a triage ⇄ raise
 *  type-level import cycle (triage.ts re-exports it for callers). */
export interface TriageClassification {
  output: TriageOutput;
  source: TriageSource;
  /** Pinned model id that produced the classification; null for fallback/mock. */
  model: string | null;
  latencyMs: number | null;
  /** Error NAME (enum-like, never message text) when the classification fell
   *  back; undefined on success/mock. Surfaces in the triage step detail. */
  failureReason?: string;
}
