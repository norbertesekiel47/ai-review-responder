import { z } from 'zod';

export const JUDGE_VERDICTS = ['pass', 'warn', 'flag'] as const;

/** Enum-only categories: verdict rows and logs never need raw reply/review text. */
export const JUDGE_REASON_CATEGORIES = [
  'compensation_or_discount',
  'personal_information',
  'fabricated_fact',
  'hostility_or_defensiveness',
  'unsafe_or_policy_violation',
  'brand_tone',
] as const;

export const JudgeOutputSchema = z.strictObject({
  verdict: z.enum(JUDGE_VERDICTS),
  reasons: z.array(z.enum(JUDGE_REASON_CATEGORIES)).max(5),
  rationale: z.string().max(500),
});

export type JudgeOutput = z.infer<typeof JudgeOutputSchema>;
