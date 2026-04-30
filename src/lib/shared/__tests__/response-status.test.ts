import { describe, it, expect } from 'vitest';
import {
  HANDLED_STATUSES,
  APPROVED_OR_LATER_STATUSES,
  NON_TERMINAL_STATUSES,
  TERMINAL_STATUSES,
  AWAITING_PUBLISH_STATUSES,
  ALL_RESPONSE_STATUSES,
  RECENT_REVIEW_DISPLAY_STATUSES,
} from '../response-status';

describe('response-status groups', () => {
  it('HANDLED_STATUSES includes awaiting_owner_connect and excludes awaiting_manual_post', () => {
    expect(HANDLED_STATUSES).toContain('awaiting_owner_connect');
    expect(([...HANDLED_STATUSES] as string[])).not.toContain('awaiting_manual_post');
  });

  it('APPROVED_OR_LATER_STATUSES is identical to HANDLED_STATUSES', () => {
    expect([...APPROVED_OR_LATER_STATUSES].sort()).toEqual(
      [...HANDLED_STATUSES].sort(),
    );
  });

  it('NON_TERMINAL_STATUSES matches migration 023+026+029 unique-index list', () => {
    expect([...NON_TERMINAL_STATUSES].sort()).toEqual(
      [
        'approved',
        'awaiting_owner_connect',
        'edited',
        'pending_approval',
      ].sort(),
    );
  });

  it('TERMINAL_STATUSES contains superseded, posted, failed', () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(
      ['failed', 'posted', 'superseded'].sort(),
    );
  });

  it('terminal + non-terminal partition is complete and disjoint', () => {
    const all = [...TERMINAL_STATUSES, ...NON_TERMINAL_STATUSES].sort();
    expect(all).toEqual([...ALL_RESPONSE_STATUSES].sort());

    const intersection = [...TERMINAL_STATUSES].filter((s) =>
      ([...NON_TERMINAL_STATUSES] as string[]).includes(s),
    );
    expect(intersection).toEqual([]);
  });

  it('AWAITING_PUBLISH_STATUSES is the subset that signals "owner approved, awaiting publish"', () => {
    expect(AWAITING_PUBLISH_STATUSES).toContain('awaiting_owner_connect');
    expect(([...AWAITING_PUBLISH_STATUSES] as string[])).not.toContain('awaiting_manual_post');
    expect(AWAITING_PUBLISH_STATUSES).not.toContain('pending_approval');
    expect(AWAITING_PUBLISH_STATUSES).not.toContain('posted');
    expect(AWAITING_PUBLISH_STATUSES).not.toContain('superseded');
    expect(AWAITING_PUBLISH_STATUSES).not.toContain('failed');
  });

  it('RECENT_REVIEW_DISPLAY_STATUSES includes pending and excludes terminal-failure cases', () => {
    expect(RECENT_REVIEW_DISPLAY_STATUSES).toContain('pending_approval');
    expect(RECENT_REVIEW_DISPLAY_STATUSES).toContain('awaiting_owner_connect');
    expect(RECENT_REVIEW_DISPLAY_STATUSES).not.toContain('superseded');
    expect(RECENT_REVIEW_DISPLAY_STATUSES).not.toContain('failed');
  });
});
