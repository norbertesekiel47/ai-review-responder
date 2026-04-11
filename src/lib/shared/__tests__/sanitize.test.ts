import { describe, it, expect } from 'vitest';
import { sanitizeText } from '../sanitize';

describe('sanitizeText', () => {
  it('strips null bytes', () => {
    expect(sanitizeText('hello\x00world')).toBe('helloworld');
  });

  it('strips ASCII control characters except \\n \\r \\t', () => {
    // \x01 (SOH), \x02 (STX), \x1F (US) should be stripped (no space left behind)
    expect(sanitizeText('a\x01b\x02c\x1Fd')).toBe('abcd');
  });

  it('strips DEL and C1 control block', () => {
    expect(sanitizeText('a\x7Fb\x80c\x9Fd')).toBe('abcd');
  });

  it('collapses multiple spaces into one', () => {
    expect(sanitizeText('hello    world')).toBe('hello world');
  });

  it('collapses mixed whitespace (tabs, newlines, spaces) into single space', () => {
    expect(sanitizeText('hello\n\n\t  world')).toBe('hello world');
  });

  it('trims leading and trailing whitespace', () => {
    expect(sanitizeText('  hello world  ')).toBe('hello world');
  });

  it('returns empty string for empty input', () => {
    expect(sanitizeText('')).toBe('');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(sanitizeText('   \t\n  ')).toBe('');
  });

  it('handles normal text unchanged', () => {
    expect(sanitizeText('Great food and service!')).toBe('Great food and service!');
  });

  it('preserves unicode content (non-control)', () => {
    expect(sanitizeText('Muy buen servicio 🌮')).toBe('Muy buen servicio 🌮');
  });

  it('handles combined edge cases', () => {
    expect(sanitizeText('\x00  hello\x01\x7F  \t\n  world  \x9F')).toBe('hello world');
    // Control chars stripped, then whitespace collapsed to single space
  });
});
