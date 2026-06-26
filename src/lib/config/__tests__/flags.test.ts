import { afterEach, describe, expect, it } from 'vitest';
import { readFlag, isPreviewEnvironment } from '../flags';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('readFlag', () => {
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['false', 'false'],
    ['uppercase TRUE', 'TRUE'],
    ['mixed-case True', 'True'],
    ['numeric 1', '1'],
    ['padded " true "', ' true '],
  ])('is false for %s', (_label, value) => {
    if (value === undefined) delete process.env.SOME_FLAG_ENABLED;
    else process.env.SOME_FLAG_ENABLED = value;
    expect(readFlag('SOME_FLAG_ENABLED')).toBe(false);
  });

  it('is true ONLY for the exact string "true"', () => {
    process.env.SOME_FLAG_ENABLED = 'true';
    expect(readFlag('SOME_FLAG_ENABLED')).toBe(true);
  });

  it('reads the named var dynamically (works for any flag name)', () => {
    process.env.A_DISABLED = 'true';
    process.env.B_ENABLED = 'false';
    expect(readFlag('A_DISABLED')).toBe(true);
    expect(readFlag('B_ENABLED')).toBe(false);
    expect(readFlag('NEVER_SET_ENABLED')).toBe(false);
  });
});

describe('isPreviewEnvironment', () => {
  it('detects only genuine per-PR previews via VERCEL_TARGET_ENV', () => {
    delete process.env.VERCEL_ENV;
    delete process.env.VERCEL_TARGET_ENV;
    expect(isPreviewEnvironment()).toBe(false);

    process.env.VERCEL_TARGET_ENV = 'preview';
    expect(isPreviewEnvironment()).toBe(true);

    // exact match only
    process.env.VERCEL_TARGET_ENV = 'Preview';
    expect(isPreviewEnvironment()).toBe(false);

    process.env.VERCEL_TARGET_ENV = 'production';
    expect(isPreviewEnvironment()).toBe(false);

    // staging custom env: VERCEL_ENV='preview' but VERCEL_TARGET_ENV='staging'
    // must NOT count as preview (the regression isPreviewEnvironment guards against).
    process.env.VERCEL_ENV = 'preview';
    process.env.VERCEL_TARGET_ENV = 'staging';
    expect(isPreviewEnvironment()).toBe(false);
  });
});
