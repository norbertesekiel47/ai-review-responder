// tests/llm-eval/moderation-types.ts
import type { ModerationDecision } from '../../src/lib/moderation/output-filter';

/**
 * Types for the provider-moderation corpus lane — the recorded run that
 * `docs/runbooks/auto-approval-provider-moderation-validation.md` requires
 * before `AUTO_APPROVAL_PROVIDER_MODERATION_READY` may be set.
 *
 * The corpus holds generated RESPONSE DRAFTS, not reviews: `moderateResponse`
 * runs on the text RepWorth would post, which is what invariant #4 gates.
 */

export type ModerationLabel = 'safe' | 'unsafe';

/** Safe buckets first; every unsafe bucket names the provider risk it probes. */
export type ModerationBucket =
  // safe
  | 'positive_reply'
  | 'negative_apology'
  | 'sensitive_category'
  | 'quoted_complaint'
  | 'violent_idiom'
  | 'bilingual'
  | 'no_review_text'
  // unsafe
  | 'harassment'
  | 'threat'
  | 'hate'
  | 'sexual'
  | 'self_harm'
  | 'violence';

export const SAFE_BUCKETS: readonly ModerationBucket[] = [
  'positive_reply',
  'negative_apology',
  'sensitive_category',
  'quoted_complaint',
  'violent_idiom',
  'bilingual',
  'no_review_text',
];

export const UNSAFE_BUCKETS: readonly ModerationBucket[] = [
  'harassment',
  'threat',
  'hate',
  'sexual',
  'self_harm',
  'violence',
];

export interface ModerationCorpusRow {
  id: string;
  label: ModerationLabel;
  bucket: ModerationBucket;
  description: string;
  /** The response draft scored by `moderateResponse`. */
  text: string;
  /**
   * Unsafe rows only. True when the OpenAI provider must be the layer that
   * catches the row. Such rows avoid every local-filter pattern on purpose, so
   * a flag can only have come from the provider. A local-only catch on such a
   * row is a `provider_miss`, not a pass — it would prove nothing about the
   * provider.
   */
  expectProviderFlag: boolean;
}

export type ModerationOutcome =
  /** safe row, not flagged — correct. */
  | 'true_negative'
  /** unsafe row, flagged by the layer the row targets — correct. */
  | 'true_positive'
  /** safe row, flagged — a false positive. */
  | 'false_positive'
  /** unsafe row, not flagged by any layer — a false negative. */
  | 'false_negative'
  /** unsafe provider-targeted row caught only by the local filter. */
  | 'provider_miss'
  /** the provider call failed; the row proves nothing. */
  | 'provider_error'
  /** the provider was never called; `OPENAI_MODERATION_ENABLED` is not true. */
  | 'provider_not_reached';

export interface ModerationCorpusResult {
  id: string;
  label: ModerationLabel;
  bucket: ModerationBucket;
  outcome: ModerationOutcome;
  /** The always-on local regex layer flagged the text. */
  flaggedByLocal: boolean;
  /** The OpenAI provider flagged the text (`openai_categories` present). */
  flaggedByProvider: boolean;
  /** The merged decision the generation path would act on. */
  flagged: boolean;
  decision: ModerationDecision;
}

export interface ModerationAcceptance {
  /** Unsafe rows that no layer flagged. */
  maxFalseNegatives: number;
  /** Provider-targeted unsafe rows the provider did not flag. */
  maxProviderMisses: number;
  /** Rows where the provider call errored. */
  maxProviderErrors: number;
  /** falsePositives / safeTotal. */
  maxFalsePositiveRate: number;
}

export interface ModerationCorpusReport {
  startedAt: string;
  mode: 'moderation-corpus';
  /** Which deploy environment produced this evidence. Validation is per-env. */
  environment: string;
  providerModel: string;
  total: number;
  safeTotal: number;
  unsafeTotal: number;
  falsePositives: number;
  falsePositiveRate: number;
  falseNegatives: number;
  providerMisses: number;
  providerErrors: number;
  providerNotReached: number;
  acceptance: ModerationAcceptance;
  /** Rows whose outcome is exactly correct. */
  passed: number;
  failed: number;
  /** The authority. `failed > 0` may still pass inside the FP budget. */
  verdict: 'PASS' | 'FAIL';
  /** One line per breached acceptance criterion. Empty on PASS. */
  violations: string[];
  results: ModerationCorpusResult[];
}
