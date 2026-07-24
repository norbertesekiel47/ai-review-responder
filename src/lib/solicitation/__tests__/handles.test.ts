import { describe, expect, it } from 'vitest';
import { normalizeEmail, normalizePhone } from '../handles';

describe('normalizePhone', () => {
  it('normalizes a 10-digit US phone to E.164', () => {
    expect(normalizePhone('(415) 555-2671')).toBe('+14155552671');
    expect(normalizePhone('415.555.2671')).toBe('+14155552671');
  });
  it('keeps an existing E.164 number', () => {
    expect(normalizePhone('+442071838750')).toBe('+442071838750');
  });
  it('accepts 11 digits with a leading 1 as US', () => {
    expect(normalizePhone('14155552671')).toBe('+14155552671');
  });
  it('returns null for an unparseable phone', () => {
    expect(normalizePhone('call the desk')).toBeNull();
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone('ext. 4155552671')).toBeNull(); // letters reject
  });
});

describe('normalizeEmail', () => {
  it('lowercases and trims email handles', () => {
    expect(normalizeEmail('  Ada.Lovelace@Example.COM ')).toBe('ada.lovelace@example.com');
  });
  it('returns null for implausible syntax', () => {
    expect(normalizeEmail('not-an-email')).toBeNull();
    expect(normalizeEmail('a@b')).toBeNull();
  });
});
