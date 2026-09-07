// UX audit D12: a failed queue action shows owner copy, never the server's
// machine code or internal sentence.
import { describe, expect, it } from 'vitest';
import { describeActionFailure } from '@/components/dashboard/reviews/action-copy';

describe('describeActionFailure', () => {
  it.each([
    ['past_due_read_only', 402, /past due/i],
    ['subscription_inactive', 403, /subscription isn't active/i],
    ['account_offboarding_blocked', 403, /account is closing/i],
    ['no_business', 403, /couldn't find this location/i],
    ['held_for_review', 409, /checked by our team/i],
    ['rate_limited', 429, /too many requests/i],
    ['conflict_retry', 409, /something else was updating/i],
  ])('maps the %s code to owner copy', (code, status, expected) => {
    const copy = describeActionFailure('approve', { status, code });
    expect(copy.message).toMatch(expected);
    expect(copy.message).not.toContain(code);
    expect(copy.stale).toBe(false);
  });

  it('treats a 409 not-pending sentence as a stale row and never shows the sentence', () => {
    const copy = describeActionFailure('approve', {
      status: 409,
      code: 'Response is no longer pending approval (current status: superseded)',
    });
    expect(copy.stale).toBe(true);
    expect(copy.message).toMatch(/already handled/i);
    expect(copy.message).not.toMatch(/superseded|current status/i);
  });

  it('treats a 404 no-actionable-response as stale', () => {
    expect(describeActionFailure('edit', { status: 404, code: 'No actionable response found for this review' }).stale)
      .toBe(true);
  });

  it('explains a 400 validation failure in reply terms', () => {
    expect(describeActionFailure('edit', { status: 400, code: 'Edited response must not be empty' }).message)
      .toMatch(/your reply needs some text/i);
  });

  it('falls back to an action-specific "try again" for unknown failures', () => {
    expect(describeActionFailure('approve', { status: 500 }).message).toBe("Couldn't approve. Try again.");
    expect(describeActionFailure('edit', { status: 500, code: 'Internal server error' }).message).toBe("Couldn't save. Try again.");
    expect(describeActionFailure('regenerate', { status: 0 }).message).toBe("Couldn't regenerate. Try again.");
  });
});
