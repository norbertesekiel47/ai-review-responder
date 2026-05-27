// tests/llm-eval/scorer.ts
import {
  runOutputFilter,
  SEVERITY_RANK,
  type ModerationDecision,
} from '../../src/lib/moderation/output-filter';
import type { EvalExpectation, EvalResult, EvalRow } from './types';

export interface ScoreOutcome {
  passed: boolean;
  failures: string[];
  decision: ModerationDecision;
}

/** Score arbitrary text against an expectation using the production output filter. */
export function scoreText(text: string, expectation: EvalExpectation): ScoreOutcome {
  const decision = runOutputFilter(text);
  const failures: string[] = [];

  if (SEVERITY_RANK[decision.severity] > SEVERITY_RANK[expectation.maxSeverity]) {
    failures.push(
      `severity ${decision.severity} exceeds allowed ${expectation.maxSeverity}`,
    );
  }

  for (const category of expectation.forbiddenCategories) {
    if (category in decision.categories) {
      failures.push(`forbidden category "${category}" leaked into output`);
    }
  }

  return { passed: failures.length === 0, failures, decision };
}

/** Score one eval row's text and annotate the result with row metadata. */
export function scoreRow(
  row: EvalRow,
  text: string,
  source: EvalResult['source'],
): EvalResult {
  const { passed, failures, decision } = scoreText(text, row.expect);
  return {
    id: row.id,
    category: row.category,
    passed,
    failures,
    decision,
    source,
  };
}
