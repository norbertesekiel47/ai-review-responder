import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { JUDGE_VERDICTS } from '../../src/lib/responses/judge-schema';
import {
  JUDGE_EVAL_CATEGORIES,
  type JudgeEvalRow,
} from './judge-types';
import { parseJsonLines } from './jsonl';

const HERE = dirname(fileURLToPath(import.meta.url));
export const JUDGE_EVAL_SET_PATH = resolve(HERE, 'judge-eval-set.jsonl');

const JudgeEvalExpectationSchema = z.strictObject({
  verdict: z.enum(JUDGE_VERDICTS).optional(),
  forbidden: z.array(z.enum(JUDGE_VERDICTS)).min(1).optional(),
}).refine(
  (expectation) => expectation.verdict !== undefined
    || expectation.forbidden !== undefined,
  { message: 'must define verdict or forbidden' },
);

const JudgeEvalRowSchema = z.strictObject({
  id: z.string().trim().min(1),
  category: z.enum(JUDGE_EVAL_CATEGORIES),
  description: z.string().trim().min(1),
  input: z.strictObject({
    reviewRating: z.number().int().min(1).max(5).nullable(),
    reviewText: z.string().nullable(),
    businessName: z.string().trim().min(1),
    businessCategory: z.string().trim().min(1).nullable(),
  }),
  postedReply: z.string().trim().min(1),
  cannedOutput: z.record(z.string(), z.unknown()),
  expect: JudgeEvalExpectationSchema,
});

/** Parse and fully shape-check the judge JSONL fixture set. */
export function parseJudgeEvalSet(jsonl: string): JudgeEvalRow[] {
  const rows: JudgeEvalRow[] = [];
  const ids = new Set<string>();

  for (const { lineNumber, value: raw } of parseJsonLines(jsonl, 'judge eval')) {
    const result = JudgeEvalRowSchema.safeParse(raw);
    if (!result.success) {
      const issue = result.error.issues[0];
      const field = issue?.path.join('.') || 'row';
      throw new Error(
        `judge eval line ${lineNumber} invalid ${field}: ${issue?.message ?? 'invalid shape'}`,
      );
    }

    if (ids.has(result.data.id)) {
      throw new Error(`duplicate judge eval row id "${result.data.id}"`);
    }
    ids.add(result.data.id);
    rows.push(result.data);
  }

  if (rows.length === 0) {
    throw new Error('judge eval set must contain at least one row');
  }

  return rows;
}

export function loadJudgeEvalSet(path: string = JUDGE_EVAL_SET_PATH): JudgeEvalRow[] {
  return parseJudgeEvalSet(readFileSync(path, 'utf8'));
}
