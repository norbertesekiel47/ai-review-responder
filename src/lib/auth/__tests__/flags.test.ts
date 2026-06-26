import { afterEach, describe, expect, it } from 'vitest';
import { selfServeSignupEnabled, mfaEnforcementEnabled } from '../flags';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('selfServeSignupEnabled', () => {
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['false', 'false'],
    ['uppercase TRUE', 'TRUE'],
    ['numeric 1', '1'],
  ])('is false for %s', (_label, value) => {
    if (value === undefined) delete process.env.SELF_SERVE_SIGNUP_ENABLED;
    else process.env.SELF_SERVE_SIGNUP_ENABLED = value;
    expect(selfServeSignupEnabled()).toBe(false);
  });

  it('is true ONLY for the exact string "true"', () => {
    process.env.SELF_SERVE_SIGNUP_ENABLED = 'true';
    expect(selfServeSignupEnabled()).toBe(true);
  });
});

describe('mfaEnforcementEnabled', () => {
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['false', 'false'],
    ['uppercase TRUE', 'TRUE'],
    ['numeric 1', '1'],
  ])('is false for %s', (_label, value) => {
    if (value === undefined) delete process.env.MFA_ENFORCEMENT_ENABLED;
    else process.env.MFA_ENFORCEMENT_ENABLED = value;
    expect(mfaEnforcementEnabled()).toBe(false);
  });

  it('is true ONLY for the exact string "true"', () => {
    process.env.MFA_ENFORCEMENT_ENABLED = 'true';
    expect(mfaEnforcementEnabled()).toBe(true);
  });
});
