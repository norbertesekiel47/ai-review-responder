import { describe, expect, it } from 'vitest';
import { OPERATOR_REFUSAL_REASONS, OPERATOR_REFUSAL_RULES } from '../refusals';

describe('Operator refusal rules', () => {
  it('covers the six reasons with one precise RepWorth clause each and the declared ledger scope', () => {
    const expected = [
      ['invented_business_fact', 'location', 'RepWorth rules prohibit inventing or claiming unverified business facts, including licenses and credentials.'],
      ['customer_data_exposure', 'location', 'RepWorth rules prohibit exposing private customer information in public replies.'],
      ['reviewer_disparagement', 'location', 'RepWorth rules prohibit insulting, threatening or disparaging reviewers.'],
      ['review_incentive', 'account', 'RepWorth rules prohibit offering incentives in exchange for reviews.'],
      ['review_edit_pressure', 'account', 'RepWorth rules prohibit pressuring reviewers to edit or delete their reviews.'],
      ['competitor_review_reply', 'account', 'RepWorth rules prohibit replying to reviews on a competitor’s business profile.'],
    ];
    expect(OPERATOR_REFUSAL_REASONS).toEqual(expected.map(([reason]) => reason));
    expect(OPERATOR_REFUSAL_REASONS.map((reason) => {
      const decision = OPERATOR_REFUSAL_RULES[reason];
      expect(decision.category).toBe('request_not_allowed');
      expect(decision.source).toBe(decision.scope === 'location' ? 'operator_content_refused' : 'operator_policy_refused');
      return [reason, decision.scope, decision.rule];
    })).toEqual(expected);
  });
});
