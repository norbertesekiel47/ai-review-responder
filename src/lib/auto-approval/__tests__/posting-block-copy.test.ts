import { describe, expect, it } from 'vitest';
import { buildAutoApprovalPostingStatus } from '../posting-status';
import { POSTING_BLOCK_COPY, postingBlockSentences } from '../posting-block-copy';

describe('POSTING_BLOCK_COPY', () => {
  it('every AutoApprovalPostingBlockReason has exactly one owner sentence', () => {
    const { reasons } = buildAutoApprovalPostingStatus({
      runtimeEnabled: false,
      judgeEnabled: false,
      tierGrantsAutopilot: false,
      providerModerationEnabled: false,
      publisherSubscriptionAllowed: false,
    });

    expect(Object.keys(POSTING_BLOCK_COPY).sort()).toEqual([...reasons].sort());
  });

  it('all five Posting block sentences remain byte-for-byte unchanged after the shared-copy extraction', () => {
    expect(POSTING_BLOCK_COPY.runtime_disabled).toBe(
      'Auto-posting is not switched on for RepWorth yet.',
    );
    expect(POSTING_BLOCK_COPY.judge_disabled).toBe(
      'Our reply review step is switched off right now, and nothing posts without it.',
    );
    expect(POSTING_BLOCK_COPY.autopilot_tier_required).toBe(
      'Auto-posting is part of the Autopilot plan, and this account is on Copilot.',
    );
    expect(POSTING_BLOCK_COPY.provider_moderation_disabled).toBe(
      'Safety screening for replies is switched off right now, so nothing posts on its own.',
    );
    expect(POSTING_BLOCK_COPY.publisher_subscription_denied).toBe(
      'Your billing needs attention before any reply can post.',
    );
  });
});

describe('postingBlockSentences', () => {
  it('returns no placeholder line for an empty reason list', () => {
    expect(postingBlockSentences([])).toEqual([]);
  });

  it('maps reasons to sentences in the given order, adding nothing', () => {
    expect(postingBlockSentences(['judge_disabled', 'runtime_disabled'])).toEqual([
      POSTING_BLOCK_COPY.judge_disabled,
      POSTING_BLOCK_COPY.runtime_disabled,
    ]);
  });
});
