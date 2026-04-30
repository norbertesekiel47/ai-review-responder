import { describe, it, expect } from 'vitest';
import { canonicalizeReplyText } from '../canonicalize-reply';

describe('canonicalizeReplyText', () => {
  it('returns identical text unchanged', () => {
    expect(canonicalizeReplyText('hello')).toBe('hello');
  });

  it('normalizes CRLF → LF', () => {
    expect(canonicalizeReplyText('hello\r\nworld')).toBe('hello\nworld');
  });

  it('normalizes lone CR → LF', () => {
    expect(canonicalizeReplyText('hello\rworld')).toBe('hello\nworld');
  });

  it('normalizes Unicode NFC (decomposed → precomposed)', () => {
    // 'café' with combining acute (NFD) vs precomposed é (NFC).
    const decomposed = 'café'; // e + combining acute
    const precomposed = 'café'; // é precomposed
    expect(canonicalizeReplyText(decomposed)).toBe(canonicalizeReplyText(precomposed));
  });

  it('trims outer whitespace', () => {
    expect(canonicalizeReplyText('  hello  ')).toBe('hello');
  });

  it('preserves internal whitespace (different meaning)', () => {
    expect(canonicalizeReplyText('a  b')).not.toBe(canonicalizeReplyText('a b'));
  });

  it('returns "" for null', () => {
    expect(canonicalizeReplyText(null)).toBe('');
  });

  it('returns "" for undefined', () => {
    expect(canonicalizeReplyText(undefined)).toBe('');
  });

  it('strips leading BOM (U+FEFF)', () => {
    const withBom = '﻿hello';
    expect(canonicalizeReplyText(withBom)).toBe('hello');
  });

  it('strips trailing zero-width space (U+200B)', () => {
    const withZwsp = 'hello​';
    expect(canonicalizeReplyText(withZwsp)).toBe('hello');
  });

  it('strips internal zero-width chars (U+200B–U+200D)', () => {
    expect(canonicalizeReplyText('hello​world')).toBe('helloworld');
    expect(canonicalizeReplyText('hello‌world')).toBe('helloworld');
    expect(canonicalizeReplyText('hello‍world')).toBe('helloworld');
  });

  it('round-trip equality: identical visible text with vs without BOM matches', () => {
    expect(canonicalizeReplyText('﻿hello')).toBe(canonicalizeReplyText('hello'));
    expect(canonicalizeReplyText('hello​')).toBe(canonicalizeReplyText('hello'));
  });
});
