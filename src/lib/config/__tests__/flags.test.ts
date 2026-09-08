import { afterEach, describe, expect, it } from 'vitest';
import { readFlag, isPreviewEnvironment, isProductionEnvironment } from '../flags';

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

describe('isProductionEnvironment', () => {
  it('isProductionEnvironment is true only for VERCEL_TARGET_ENV=production', () => {
    // #1186: the "production lane" the Admin origin allowlist's loopback rule is
    // inert in. requiresProductionConfig() cannot answer this — Vercel sets
    // NODE_ENV=production on staging and preview builds too, which would make
    // loopback inert on staging, the one environment ADR 0024 D7 built it for.
    delete process.env.VERCEL_ENV;
    delete process.env.VERCEL_TARGET_ENV;
    delete process.env.VERCEL;
    expect(isProductionEnvironment()).toBe(false);

    process.env.VERCEL_TARGET_ENV = 'production';
    expect(isProductionEnvironment()).toBe(true);

    // exact match only
    process.env.VERCEL_TARGET_ENV = 'Production';
    expect(isProductionEnvironment()).toBe(false);

    for (const lane of ['preview', 'staging', 'development']) {
      process.env.VERCEL_TARGET_ENV = lane;
      expect(isProductionEnvironment(), `lane=${lane}`).toBe(false);
    }

    // FAIL CLOSED on a MISSING signal. A Vercel project whose system
    // environment variables are not exposed has no VERCEL_TARGET_ENV on a real
    // production deployment; reading that absence as "not production" would
    // admit http://localhost:* there. Adversarial review A1 (#1186).
    for (const missing of [undefined, '', '   ']) {
      if (missing === undefined) delete process.env.VERCEL_TARGET_ENV;
      else process.env.VERCEL_TARGET_ENV = missing;

      process.env.VERCEL = '1';
      expect(isProductionEnvironment(), `on Vercel, target=${JSON.stringify(missing)}`).toBe(true);

      delete process.env.VERCEL;
      expect(isProductionEnvironment(), `off Vercel, target=${JSON.stringify(missing)}`).toBe(
        false,
      );
    }

    // NODE_ENV is not the signal, and neither is VERCEL_ENV. (@types/node types
    // NODE_ENV as read-only on ProcessEnv, so it is set through Object.assign.)
    process.env.VERCEL_TARGET_ENV = 'staging';
    Object.assign(process.env, { NODE_ENV: 'production' });
    process.env.VERCEL_ENV = 'production';
    expect(isProductionEnvironment()).toBe(false);
  });
});
