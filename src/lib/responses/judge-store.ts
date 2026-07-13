import type { Sql, TransactionSql } from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import { publisherSubscriptionEligibleSql } from '@/lib/shared/subscription-eligibility-sql';
import type { JudgeOutput } from './judge-schema';

export type StoredJudgeVerdict = JudgeOutput['verdict'] | 'error';

export interface InsertJudgeVerdictInput {
  verdictId?: string;
  accountId: string;
  businessId: string;
  reviewId: string;
  responseId: string;
  agentRunId: string | null;
  verdict: StoredJudgeVerdict;
  reasons: JudgeOutput['reasons'] | null;
  rationale: string | null;
  model: string;
  promptVersion: string;
}

export async function insertJudgeVerdict(
  tx: TransactionSql,
  input: InsertJudgeVerdictInput,
): Promise<{ inserted: boolean }> {
  const rows = await tx<{ id: string }[]>`
    INSERT INTO judge_verdicts (
      id, account_id, business_id, review_id, response_id, agent_run_id,
      verdict, reasons, rationale, model, prompt_version
    ) VALUES (
      ${input.verdictId ?? uuidv7()}, ${input.accountId}, ${input.businessId}, ${input.reviewId},
      ${input.responseId}, ${input.agentRunId}, ${input.verdict},
      ${input.reasons === null ? null : tx.json(input.reasons)},
      ${input.rationale}, ${input.model}, ${input.promptVersion}
    )
    ON CONFLICT (response_id) DO NOTHING
    RETURNING id
  `;
  return { inserted: rows.count > 0 };
}

export async function findLatestRunIdForReview(
  tx: TransactionSql,
  reviewId: string,
): Promise<string | null> {
  const [run] = await tx<{ id: string }[]>`
    SELECT id
    FROM agent_runs
    WHERE kind = 'review_handler'
      AND subject_type = 'review'
      AND subject_id = ${reviewId}
    ORDER BY started_at DESC
    LIMIT 1
  `;
  return run?.id ?? null;
}

export interface UnjudgedAutoPost {
  response_id: string;
  business_id: string;
  account_id: string;
}

const MAX_LOOKBACK_HOURS = 24;
const MAX_SCAN_LIMIT = 50;

function assertBoundedScanOptions(options: { lookbackHours: number; limit: number }): void {
  if (
    !Number.isSafeInteger(options.lookbackHours)
    || options.lookbackHours < 1
    || options.lookbackHours > MAX_LOOKBACK_HOURS
    || !Number.isSafeInteger(options.limit)
    || options.limit < 1
    || options.limit > MAX_SCAN_LIMIT
  ) {
    throw new RangeError('judge scan requires integer lookbackHours 1..24 and limit 1..50');
  }
}

export async function listUnjudgedAutoPosts(
  sql: Sql,
  options: { lookbackHours: number; limit: number },
): Promise<UnjudgedAutoPost[]> {
  assertBoundedScanOptions(options);
  return sql<UnjudgedAutoPost[]>`
    SELECT r.id AS response_id, r.business_id, b.account_id
    FROM responses r
    JOIN businesses b ON b.id = r.business_id
    JOIN accounts a ON a.id = b.account_id
    WHERE r.status = 'posted'
      AND r.approval_method = 'auto_policy'
      AND r.posted_at >= NOW() - make_interval(hours => ${options.lookbackHours})
      AND ${publisherSubscriptionEligibleSql(sql)}
      AND NOT EXISTS (
        SELECT 1 FROM judge_verdicts jv
        WHERE jv.response_id = r.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM job_outbox jo
        WHERE jo.topic = ${QUEUE_NAMES.JUDGE_VERDICT}
          AND jo.aggregate_id = r.id
          AND jo.status IN ('pending', 'dispatching', 'dispatched')
      )
    ORDER BY r.posted_at ASC, r.id ASC
    LIMIT ${options.limit}
  `;
}
