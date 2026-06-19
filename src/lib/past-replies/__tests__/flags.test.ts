import { afterEach, describe, expect, it } from 'vitest';
import {
  editRepliesEnabled,
  pastRepliesViewEnabled,
  replyEditingFlagEnabled,
} from '../flags';

const ORIGINAL_ENV = { ...process.env };

function resetEnv(): void {
  process.env = { ...ORIGINAL_ENV };
}

afterEach(() => {
  resetEnv();
});

describe('past-replies flag helpers', () => {
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['false', 'false'],
    ['uppercase true', 'TRUE'],
    ['mixed case true', 'True'],
    ['numeric true', '1'],
    ['padded true', ' true '],
  ])('keeps the view flag disabled for %s values', (_label, value) => {
    if (value === undefined) {
      delete process.env.PAST_REPLIES_VIEW_ENABLED;
    } else {
      process.env.PAST_REPLIES_VIEW_ENABLED = value;
    }

    expect(pastRepliesViewEnabled()).toBe(false);
  });

  it('enables the view only for exact string true', () => {
    process.env.PAST_REPLIES_VIEW_ENABLED = 'true';
    expect(pastRepliesViewEnabled()).toBe(true);
  });

  it('reads the raw edit flag only from exact EDIT_REPLIES_ENABLED=true', () => {
    process.env.EDIT_REPLIES_ENABLED = 'TRUE';
    expect(replyEditingFlagEnabled()).toBe(false);

    process.env.EDIT_REPLIES_ENABLED = 'true';
    expect(replyEditingFlagEnabled()).toBe(true);
  });

  describe('editRepliesEnabled requires BOTH flags (the user-facing invariant)', () => {
    it.each([
      ['both off', undefined, undefined, false],
      ['view only', 'true', undefined, false],
      ['edit only', undefined, 'true', false],
      ['view on, edit false', 'true', 'false', false],
      ['both on', 'true', 'true', true],
    ])('%s', (_label, view, edit, expected) => {
      if (view === undefined) delete process.env.PAST_REPLIES_VIEW_ENABLED;
      else process.env.PAST_REPLIES_VIEW_ENABLED = view;
      if (edit === undefined) delete process.env.EDIT_REPLIES_ENABLED;
      else process.env.EDIT_REPLIES_ENABLED = edit;

      expect(editRepliesEnabled()).toBe(expected);
    });
  });
});
