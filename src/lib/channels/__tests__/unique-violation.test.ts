// src/lib/channels/__tests__/unique-violation.test.ts
import { describe, it, expect } from 'vitest';
import {
  MultipleMobileChannelsError,
  EnrollmentDatabaseError,
  isMultipleMobileChannelsError,
  classifyEnrollmentError,
} from '../unique-violation';

const PG_UNIQUE_VIOLATION = '23505';
const OLD_CONSTRAINT = 'channel_enrollments_one_mobile_per_biz';
const NEW_CONSTRAINT = 'channel_enrollments_one_mobile_per_scope';

function pgError(code: string, constraintName?: string): Error {
  // Postgres.js attaches `code` and `constraint_name` directly on Error
  // instances. Tests synthesize the same shape.
  const err = new Error(`duplicate key violates ${constraintName ?? 'some_constraint'}`) as Error & {
    code: string;
    constraint_name?: string;
  };
  err.code = code;
  if (constraintName) err.constraint_name = constraintName;
  return err;
}

describe('isMultipleMobileChannelsError', () => {
  it('returns true for 23505 + old constraint name (channel_enrollments_one_mobile_per_biz)', () => {
    expect(isMultipleMobileChannelsError(pgError(PG_UNIQUE_VIOLATION, OLD_CONSTRAINT))).toBe(true);
  });

  it('returns true for 23505 + new constraint name (channel_enrollments_one_mobile_per_scope)', () => {
    expect(isMultipleMobileChannelsError(pgError(PG_UNIQUE_VIOLATION, NEW_CONSTRAINT))).toBe(true);
  });

  it('returns false for 23505 + different constraint name', () => {
    expect(isMultipleMobileChannelsError(pgError(PG_UNIQUE_VIOLATION, 'some_other_index'))).toBe(false);
  });

  it('returns false for 23505 with no constraint name', () => {
    expect(isMultipleMobileChannelsError(pgError(PG_UNIQUE_VIOLATION))).toBe(false);
  });

  it('returns false for non-23505 errors', () => {
    expect(isMultipleMobileChannelsError(pgError('40001', OLD_CONSTRAINT))).toBe(false);
  });

  it('returns false for plain Error', () => {
    expect(isMultipleMobileChannelsError(new Error('boom'))).toBe(false);
  });

  it('returns false for null / undefined / non-objects', () => {
    expect(isMultipleMobileChannelsError(null)).toBe(false);
    expect(isMultipleMobileChannelsError(undefined)).toBe(false);
    expect(isMultipleMobileChannelsError('string')).toBe(false);
    expect(isMultipleMobileChannelsError(42)).toBe(false);
  });
});

describe('classifyEnrollmentError', () => {
  it('throws MultipleMobileChannelsError on 23505 + old constraint name', () => {
    expect(() => classifyEnrollmentError(pgError(PG_UNIQUE_VIOLATION, OLD_CONSTRAINT)))
      .toThrow(MultipleMobileChannelsError);
  });

  it('throws MultipleMobileChannelsError on 23505 + new constraint name', () => {
    expect(() => classifyEnrollmentError(pgError(PG_UNIQUE_VIOLATION, NEW_CONSTRAINT)))
      .toThrow(MultipleMobileChannelsError);
  });

  it('throws EnrollmentDatabaseError on 23505 + other constraint', () => {
    expect(() => classifyEnrollmentError(pgError(PG_UNIQUE_VIOLATION, 'some_other_index')))
      .toThrow(EnrollmentDatabaseError);
  });

  it('rethrows non-23505 errors unchanged', () => {
    const original = pgError('40001', OLD_CONSTRAINT);
    expect(() => classifyEnrollmentError(original)).toThrow(original);
  });

  it('rethrows non-Error values unchanged', () => {
    expect(() => classifyEnrollmentError('not an error')).toThrow('not an error');
  });

  it('EnrollmentDatabaseError message scrubs the original message', () => {
    try {
      classifyEnrollmentError(pgError(PG_UNIQUE_VIOLATION, 'leak_constraint_name'));
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EnrollmentDatabaseError);
      expect((err as Error).message).not.toContain('leak_constraint_name');
    }
  });
});
