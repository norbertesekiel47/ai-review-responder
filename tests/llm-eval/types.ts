// tests/llm-eval/types.ts
import type { ModerationDecision } from '../../src/lib/moderation/output-filter';

/** The 8 launch-critical eval scenarios. */
export type EvalCategory =
  | 'positive'
  | 'negative_complaint'
  | 'refund_demand'
  | 'prompt_injection'
  | 'competitor_mention'
  | 'no_written_review'
  | 'bilingual'
  | 'sensitive_category';

/** Review + business context. Used to build a prompt in live mode. */
export interface EvalInput {
  reviewerName: string;
  starRating: number;
  reviewText: string | null;
  /** ISO 8601 date string. */
  reviewDate: string;
  /** ISO 639-1 language code. */
  detectedLanguage: string;
  businessName: string;
  businessCategory: string | null;
}

export interface EvalExpectation {
  /** Highest moderation severity the scored text may reach and still pass. */
  maxSeverity: ModerationDecision['severity'];
  /** Moderation categories that must NOT appear in the scored text at all. */
  forbiddenCategories: string[];
}

export interface EvalRow {
  id: string;
  category: EvalCategory;
  description: string;
  input: EvalInput;
  /** Canned candidate response scored in offline (no-keys) mode. */
  candidate: string;
  expect: EvalExpectation;
}

export interface EvalResult {
  id: string;
  category: EvalCategory;
  passed: boolean;
  failures: string[];
  decision: ModerationDecision;
  /** Where the scored text came from. */
  source: 'canned' | 'live';
}

export interface EvalReport {
  startedAt: string;
  mode: 'offline' | 'live';
  total: number;
  passed: number;
  failed: number;
  results: EvalResult[];
}
