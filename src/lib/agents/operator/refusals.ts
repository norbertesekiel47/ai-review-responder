// Closed Operator refusal decisions. The model selects a reason; only this
// server-owned map chooses its ledger lane, scope, category and owner wording.
import type { RefusalCategory, RefusalSource } from '@/lib/refusals/vocabulary';

export const OPERATOR_REFUSAL_REASONS = [
  'invented_business_fact',
  'customer_data_exposure',
  'reviewer_disparagement',
  'review_incentive',
  'review_edit_pressure',
  'competitor_review_reply',
] as const;
export type OperatorRefusalReason = (typeof OPERATOR_REFUSAL_REASONS)[number];

type OperatorRefusalRule = {
  category: Extract<RefusalCategory, 'request_not_allowed'>;
  rule: string;
} & (
  | { source: Extract<RefusalSource, 'operator_content_refused'>; scope: 'location' }
  | { source: Extract<RefusalSource, 'operator_policy_refused'>; scope: 'account' }
);

export const OPERATOR_REFUSAL_RULES = {
  invented_business_fact: {
    source: 'operator_content_refused', scope: 'location', category: 'request_not_allowed',
    rule: 'RepWorth rules prohibit inventing or claiming unverified business facts, including licenses and credentials.',
  },
  customer_data_exposure: {
    source: 'operator_content_refused', scope: 'location', category: 'request_not_allowed',
    rule: 'RepWorth rules prohibit exposing private customer information in public replies.',
  },
  reviewer_disparagement: {
    source: 'operator_content_refused', scope: 'location', category: 'request_not_allowed',
    rule: 'RepWorth rules prohibit insulting, threatening or disparaging reviewers.',
  },
  review_incentive: {
    source: 'operator_policy_refused', scope: 'account', category: 'request_not_allowed',
    rule: 'RepWorth rules prohibit offering incentives in exchange for reviews.',
  },
  review_edit_pressure: {
    source: 'operator_policy_refused', scope: 'account', category: 'request_not_allowed',
    rule: 'RepWorth rules prohibit pressuring reviewers to edit or delete their reviews.',
  },
  competitor_review_reply: {
    source: 'operator_policy_refused', scope: 'account', category: 'request_not_allowed',
    rule: 'RepWorth rules prohibit replying to reviews on a competitor’s business profile.',
  },
} as const satisfies Record<OperatorRefusalReason, OperatorRefusalRule>;
