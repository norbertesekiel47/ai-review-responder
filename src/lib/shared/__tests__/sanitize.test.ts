import { describe, it, expect } from 'vitest';
import { sanitizePublicResponseText, sanitizeText } from '../sanitize';

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

describe('sanitizePublicResponseText', () => {
  it('strips null bytes, ASCII controls, and C1 controls', () => {
    expect(sanitizePublicResponseText('a\x00b\x01c\x7Fd\x80e\x9Ff')).toBe('abcdef');
  });

  it('strips common zero-width and directional controls', () => {
    expect(sanitizePublicResponseText('Hello\u200B\u200E \u200F\u202Eworld\u2066!\uFEFF')).toBe('Hello world!');
  });

  it('normalizes spaces and tabs within each line while preserving paragraph breaks', () => {
    expect(sanitizePublicResponseText('  First\t\tline \nSecond   line\n\n Third\tparagraph  ')).toBe(
      'First line\nSecond line\n\nThird paragraph',
    );
  });

  it('normalizes Unicode line and paragraph separators to ordinary newlines', () => {
    expect(sanitizePublicResponseText('First\u2028line\u2029Second paragraph')).toBe(
      'First\nline\n\nSecond paragraph',
    );
  });

  it('caps excessive blank lines at two consecutive newline characters', () => {
    expect(sanitizePublicResponseText('One\n\n\n\nTwo\n\n\nThree')).toBe('One\n\nTwo\n\nThree');
  });

  it('preserves visible unicode language content, punctuation, accents, and emoji', () => {
    expect(sanitizePublicResponseText('Gracias, señor! Café was great 😊 ❤️')).toBe(
      'Gracias, señor! Café was great 😊 ❤️',
    );
  });

  it('preserves compound emoji joined with zero-width joiners', () => {
    const familyEmoji = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}';

    expect(sanitizePublicResponseText(`Loved it ${familyEmoji}!`)).toBe(`Loved it ${familyEmoji}!`);
  });

  it('preserves zero-width non-joiner in non-Latin text', () => {
    const persianWithZwnj = '\u0645\u06CC\u200C\u0631\u0648\u0645';

    expect(sanitizePublicResponseText(`Service: ${persianWithZwnj}`)).toBe(`Service: ${persianWithZwnj}`);
  });

  it('returns empty string when only stripped characters remain', () => {
    expect(sanitizePublicResponseText('\x00\x01\x7F\x80\u200B\u202E\u2066\uFEFF')).toBe('');
  });

  it('is idempotent', () => {
    const input = '  Hello\t\tthere\u200B\n\n\nThanks\x00 again!  ';
    const once = sanitizePublicResponseText(input);

    expect(sanitizePublicResponseText(once)).toBe(once);
  });
});
