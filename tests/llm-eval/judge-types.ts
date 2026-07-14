import type { JudgeOutput } from '../../src/lib/responses/judge-schema';

export const JUDGE_EVAL_CATEGORIES = [
  'clean_pass',
  'compensation',
  'personal_information',
  'fabricated_claim',
  'hostility',
  'mediocre_safe',
  'adversarial_near_miss',
] as const;

export type JudgeEvalCategory = (typeof JUDGE_EVAL_CATEGORIES)[number];
export type JudgeEvalVerdict = JudgeOutput['verdict'];

export interface JudgeEvalInput {
  reviewRating: number | null;
  reviewText: string | null;
  /**
   * Validated fixture context retained for corpus analysis and future prompt
   * evolution. The current production judge prompt intentionally does not use
   * business identity or category.
   */
  businessName: string;
  businessCategory: string | null;
}

export interface JudgeEvalExpectation {
  verdict?: JudgeEvalVerdict;
  forbidden?: JudgeEvalVerdict[];
}

export interface JudgeEvalRow {
  id: string;
  category: JudgeEvalCategory;
  description: string;
  input: JudgeEvalInput;
  postedReply: string;
  /** Golden provider JSON, parsed by JudgeOutputSchema during offline scoring. */
  cannedOutput: unknown;
  expect: JudgeEvalExpectation;
}

export interface JudgeEvalResult {
  id: string;
  category: JudgeEvalCategory;
  passed: boolean;
  failures: string[];
  output: JudgeOutput;
  source: 'canned' | 'live';
}

export interface JudgeEvalReport {
  startedAt: string;
  mode: 'offline' | 'live';
  total: number;
  passed: number;
  failed: number;
  results: JudgeEvalResult[];
}

export type JudgeLiveGenerator = (row: JudgeEvalRow) => Promise<unknown>;
