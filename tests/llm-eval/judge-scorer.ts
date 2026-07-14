import { JudgeOutputSchema } from '../../src/lib/responses/judge-schema';
import type {
  JudgeEvalResult,
  JudgeEvalRow,
} from './judge-types';

/** Parse one golden/live model output and score its verdict contract. */
export function scoreJudgeOutput(
  row: JudgeEvalRow,
  rawOutput: unknown,
  source: JudgeEvalResult['source'],
): JudgeEvalResult {
  const output = JudgeOutputSchema.parse(rawOutput);
  const failures: string[] = [];

  if (row.expect.verdict !== undefined && output.verdict !== row.expect.verdict) {
    failures.push(
      `expected verdict "${row.expect.verdict}", received "${output.verdict}"`,
    );
  }

  if (row.expect.forbidden?.includes(output.verdict)) {
    failures.push(`forbidden verdict "${output.verdict}" returned`);
  }

  return {
    id: row.id,
    category: row.category,
    passed: failures.length === 0,
    failures,
    output,
    source,
  };
}

export function scoreJudgeRow(
  row: JudgeEvalRow,
  source: JudgeEvalResult['source'],
): JudgeEvalResult {
  return scoreJudgeOutput(row, row.cannedOutput, source);
}
