import type { Sql } from 'postgres';
import type { AccountFlagsInput } from '@/lib/shared/subscription-guard';
import { isSubscriptionTier, type SubscriptionTierValue } from '@/lib/accounts/tier-config';

export interface JudgeContext {
  response_id: string;
  business_id: string;
  account_id: string;
  review_id: string;
  posted_reply_text: string;
  star_rating: number | null;
  review_text: string | null;
  subscription_status: string;
  subscription_tier: string;
  account_past_due_at: Date | null;
  account_flags: AccountFlagsInput;
  status: string;
  approval_method: string | null;
}

export async function loadJudgeContext(
  sql: Sql,
  input: { responseId: string; businessId: string; accountId: string },
): Promise<JudgeContext | null> {
  const [context] = await sql<JudgeContext[]>`
    SELECT
      resp.id AS response_id,
      resp.business_id,
      b.account_id,
      resp.review_id,
      COALESCE(resp.approved_text, resp.response_text) AS posted_reply_text,
      rev.star_rating,
      rev.review_text,
      a.subscription_status,
      a.subscription_tier,
      a.past_due_at AS account_past_due_at,
      a.flags AS account_flags,
      resp.status,
      resp.approval_method
    FROM responses resp
    JOIN reviews rev
      ON rev.id = resp.review_id
      AND rev.business_id = resp.business_id
    JOIN businesses b ON b.id = resp.business_id
    JOIN accounts a ON a.id = b.account_id
    WHERE resp.id = ${input.responseId}
      AND resp.business_id = ${input.businessId}
      AND rev.business_id = ${input.businessId}
      AND b.account_id = ${input.accountId}
    LIMIT 1
  `;
  return context ?? null;
}

export function isJudgeEligibleContext(
  context: JudgeContext,
): context is JudgeContext & { subscription_tier: SubscriptionTierValue } {
  return isPostedAutoPolicyResponse(context)
    && isSubscriptionTier(context.subscription_tier);
}

export function isPostedAutoPolicyResponse(
  context: Pick<JudgeContext, 'status' | 'approval_method'>,
): boolean {
  return context.status === 'posted' && context.approval_method === 'auto_policy';
}
