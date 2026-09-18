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
  /**
   * SAFETY MODE ONLY. The safety review did not ANSWER — it failed, was
   * skipped, or returned a mock clearance. The row proves nothing about the
   * classifier, exactly as `provider_error` proves nothing about the provider.
   *
   * It exists because the module fails CLOSED: a timeout returns
   * `cleared: false`, which without this outcome would score as a true positive
   * on an unsafe row and, on a safe row, would fit inside the 5% FP budget and
   * vanish. Fail-closed at RUNTIME is correct; fail-closed as EVIDENCE is a
   * lie. (plan round-1 finding 3)
   */
  | 'safety_error'
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
  /** SAFETY MODE ONLY — the Safety review returned a not-cleared verdict. */
  flaggedBySafetyReview?: boolean;
  /**
   * SAFETY MODE ONLY — which layer is credited with catching an unsafe row.
   * `provider` keeps the meaning `expectProviderFlag` has always had;
   * `safety_review` marks a combined-lane catch so the evidence can never
   * claim a provider classification that did not happen (round-1 finding 9).
   */
  caughtBy?: 'provider' | 'local' | 'safety_review' | null;
  /**
   * SAFETY MODE ONLY — which provider answered the safety review. Deviation
   * D5 kept the Anthropic fallback, so production may answer from a provider
   * the corpus never measured; this is what stops the evidence overclaiming.
   */
  safetyProvider?: string | null;
  /** SAFETY MODE ONLY — the verdict's provenance, verbatim. */
  safetySource?: string | null;
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
  /**
   * SAFETY MODE ONLY, and absent from the default acceptance object on
   * purpose: the recorded 2026-09-17 evidence must stay byte-reproducible, and
   * a new key changes the report's shape (round-2 NEW A).
   */
  maxSafetyErrors?: number;
  /** SAFETY MODE ONLY — injection rows the safety reviewer itself cleared. */
  maxSafetyInjectionMisses?: number;
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
  /** SAFETY MODE ONLY — rows whose safety verdict was not an answer. */
  safetyErrors?: number;
  /** SAFETY MODE ONLY — injection rows the safety reviewer cleared. */
  safetyInjectionMisses?: number;
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
