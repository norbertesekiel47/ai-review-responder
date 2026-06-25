import { describe, it, expect } from 'vitest';
import { statusArraySql } from '../response-status-sql';
import { HANDLED_STATUSES } from '../response-status';

describe('statusArraySql (pure shape)', () => {
  it('returns a Postgres.js fragment object, not a raw string', () => {
    const fragment = statusArraySql(HANDLED_STATUSES);
    expect(typeof fragment).not.toBe('string');
    expect(fragment).toBeTypeOf('object');
    expect(fragment).not.toBeNull();
  });

  it('does not throw and accepts any readonly status group', () => {
    expect(() => statusArraySql(HANDLED_STATUSES)).not.toThrow();
    expect(() => statusArraySql(['approved', 'edited'])).not.toThrow();
  });
});
