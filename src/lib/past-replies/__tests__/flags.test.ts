import { afterEach, describe, expect, it } from 'vitest';
import { readFlag } from '@/lib/config/flags';
import * as flagsModule from '../flags';
import { editRepliesEnabled } from '../flags';

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
  ])('stays disabled for %s EDIT_REPLIES_ENABLED values', (_label, value) => {
    if (value === undefined) {
      delete process.env.EDIT_REPLIES_ENABLED;
    } else {
      process.env.EDIT_REPLIES_ENABLED = value;
    }

    expect(editRepliesEnabled()).toBe(false);
  });

  it('enables editing only for exact string true', () => {
    process.env.EDIT_REPLIES_ENABLED = 'true';
    expect(editRepliesEnabled()).toBe(true);
  });
});

// ── #678 T1 EVAL — PAST_REPLIES_VIEW_ENABLED retirement (S4, F8) ─────────────
//
// `flags.ts` is collapsed to one function. The view flag is
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
