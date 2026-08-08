import { afterEach, describe, expect, it } from 'vitest';
import { readFlag } from '@/lib/config/flags';
import * as flagsModule from '../flags';
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

  // LEGACY — deleted by Task 8 along with `pastRepliesViewEnabled` and
  // `replyEditingFlagEnabled`. It asserts the pre-#678 composite and therefore
  // contradicts the two #678 titles below on purpose: they are the eval, this is
  // the behaviour they replace.
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

// ── #678 T1 EVAL — PAST_REPLIES_VIEW_ENABLED retirement (S4, F8) ─────────────
//
// RED until Task 8 collapses `flags.ts` to one function. The view flag is
// DELETED rather than flipped: once the **Reviews list** is the consented Review
// import's only destination, keeping it would let `import_decision='accepted'`
// coexist with the imported reviews landing on a `notFound()`.
// EDIT_REPLIES_ENABLED is KEPT — it gates the live-Google mutation, a different
// and larger risk.

describe('past-replies flags after the view-flag retirement', () => {
  it('editRepliesEnabled reads EDIT_REPLIES_ENABLED alone', () => {
    delete process.env.PAST_REPLIES_VIEW_ENABLED;

    process.env.EDIT_REPLIES_ENABLED = 'true';
    expect(editRepliesEnabled()).toBe(true);

    process.env.EDIT_REPLIES_ENABLED = 'false';
    expect(editRepliesEnabled()).toBe(false);

    delete process.env.EDIT_REPLIES_ENABLED;
    expect(editRepliesEnabled()).toBe(false);

    // Still server-authoritative (invariant #13): no NEXT_PUBLIC_* companion.
    expect(process.env.NEXT_PUBLIC_EDIT_REPLIES_ENABLED).toBeUndefined();
  });

  it('EDIT_REPLIES_ENABLED alone preserves stale-marking, edit-publish dispatch, and orphan conversion after view-flag retirement', () => {
    // Those three worker paths (process-review.ts, ResponsePublisherWorker.ts,
    // failed-hook.ts) called the RAW flag; the three past-replies routes called
    // the composite. With the view flag gone the two predicates are identical,
    // so ONE function must survive — a second accessor is how the six call sites
    // would silently drift apart again.
    delete process.env.PAST_REPLIES_VIEW_ENABLED;
    process.env.EDIT_REPLIES_ENABLED = 'true';

    const exportedFunctions = Object.entries(flagsModule)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name);
    expect(exportedFunctions).toEqual(['editRepliesEnabled']);

    // …and it is exactly the raw read the worker paths used to make.
    expect(editRepliesEnabled()).toBe(readFlag('EDIT_REPLIES_ENABLED'));
    expect(editRepliesEnabled()).toBe(true);

    process.env.EDIT_REPLIES_ENABLED = 'false';
    expect(editRepliesEnabled()).toBe(readFlag('EDIT_REPLIES_ENABLED'));
    expect(editRepliesEnabled()).toBe(false);
  });
});
