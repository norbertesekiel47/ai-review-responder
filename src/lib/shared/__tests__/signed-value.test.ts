// src/lib/shared/__tests__/signed-value.test.ts

import { execFileSync } from 'node:child_process';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { constantTimeEqual, signValue, verifySignedValue } from '../signed-value';

describe('constantTimeEqual', () => {
  it('returns true for identical utf8 strings (default encoding)', () => {
    expect(constantTimeEqual('same-token', 'same-token')).toBe(true);
  });

  it('returns false for different utf8 strings of equal length', () => {
    expect(constantTimeEqual('token-aaaa', 'token-bbbb')).toBe(false);
  });

  it('returns false, without throwing, for utf8 strings of different length', () => {
    expect(() => constantTimeEqual('short', 'much-longer-value')).not.toThrow();
    expect(constantTimeEqual('short', 'much-longer-value')).toBe(false);
  });

  it('returns false, without throwing, when two strings have equal JS .length but different UTF-8 byte length', () => {
    // 'é' (U+00E9) is 1 UTF-16 code unit / 2 UTF-8 bytes; 'a' is 1/1. Both
    // candidates are JS-length 1, so a naive `.length` guard would let them
    // through to timingSafeEqual and throw on the byte-length mismatch.
    const multiByte = 'é';
    const singleByte = 'a';
    expect(multiByte.length).toBe(singleByte.length);
    expect(() => constantTimeEqual(multiByte, singleByte)).not.toThrow();
    expect(constantTimeEqual(multiByte, singleByte)).toBe(false);
  });

  it('compares hex-decoded bytes when encoding is "hex"', () => {
    const hex = 'deadbeef';
    expect(constantTimeEqual(hex, 'deadbeef', 'hex')).toBe(true);
    expect(constantTimeEqual(hex, 'deadbeee', 'hex')).toBe(false);
  });

  it('returns false, without throwing, for malformed hex that decodes to a shorter buffer', () => {
    // Buffer.from(str, 'hex') silently truncates at the first invalid
    // character rather than throwing — 'zz' decodes to a zero-length buffer.
    // The four-hex-char original call sites wrapped this in try/catch because
    // the resulting byte-length mismatch made timingSafeEqual throw.
    expect(() => constantTimeEqual('zz', 'ab', 'hex')).not.toThrow();
    expect(constantTimeEqual('zz', 'ab', 'hex')).toBe(false);
  });

  it('returns false, without throwing, for odd-length hex', () => {
    expect(() => constantTimeEqual('abc', 'abcd', 'hex')).not.toThrow();
    expect(constantTimeEqual('abc', 'abcd', 'hex')).toBe(false);
  });

  it('rejects a valid hex MAC with an odd trailing nibble appended, even though it decodes to the same bytes', () => {
    // Buffer.from(str, 'hex') drops a trailing PARTIAL byte rather than
    // throwing: 'deadbeef' and 'deadbeef0' both decode to [0xde, 0xad, 0xbe,
    // 0xef]. A byte-length check alone would accept the 9-char string as a
    // match for the 8-char one — a string that was never issued. The STRING
    // length check (before any decode) must catch this.
    const valid = 'deadbeef';
    const paddedOddNibble = `${valid}0`;
    expect(Buffer.from(valid, 'hex')).toEqual(Buffer.from(paddedOddNibble, 'hex'));
    expect(constantTimeEqual(valid, paddedOddNibble, 'hex')).toBe(false);
  });

  it('rejects a valid hex MAC with invalid trailing characters appended, even though it decodes to the same bytes', () => {
    // Same collision, via an even-length invalid tail: 'deadbeef' and
    // 'deadbeefzz' both decode to [0xde, 0xad, 0xbe, 0xef] because Buffer.from
    // stops at the first invalid hex pair rather than throwing or including it.
    const valid = 'deadbeef';
    const paddedGarbage = `${valid}zz`;
    expect(Buffer.from(valid, 'hex')).toEqual(Buffer.from(paddedGarbage, 'hex'));
    expect(constantTimeEqual(valid, paddedGarbage, 'hex')).toBe(false);
  });

  it('treats a hex digest as literal UTF-8 text when compareEncoding is "utf8" (the impersonation-cookie deviation)', () => {
    // A hex digest re-encoded as hex bytes differs from the same string
    // compared as utf8 text — this pins that the two encodings are genuinely
    // different comparisons, not just different code paths to the same result.
    const digest = 'deadbeef';
    expect(constantTimeEqual(digest, digest, 'utf8')).toBe(true);
    // utf8-encoding 'deadbeef' (8 ASCII bytes) vs hex-decoding it (4 bytes) —
    // same string, different byte length under the two encodings.
    const utf8Bytes = Buffer.from(digest, 'utf8');
    const hexBytes = Buffer.from(digest, 'hex');
    expect(utf8Bytes.length).not.toBe(hexBytes.length);
  });

  it('agrees with a direct timingSafeEqual call on equal-length matching input', () => {
    const a = 'match-me-1234';
    const b = 'match-me-1234';
    expect(constantTimeEqual(a, b)).toBe(
      timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')),
    );
  });
});

describe('signValue / verifySignedValue', () => {
  const secret = 'test-secret-at-least-32-bytes-long!!';

  it('round-trips: verifySignedValue(signValue(v)) === v', () => {
    const signed = signValue('session-id-123', secret);
    expect(verifySignedValue(signed, secret)).toBe('session-id-123');
  });

  it('produces the default "<value>.<hex-hmac>" wire format', () => {
    const signed = signValue('abc', secret);
    const parts = signed.split('.');
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe('abc');
    expect(parts[1]).toMatch(/^[0-9a-f]{64}$/); // sha256 hex digest
    expect(parts[1]).toBe(createHmac('sha256', secret).update('abc').digest('hex'));
  });

  it('returns null for a tampered mac', () => {
    const signed = signValue('abc', secret);
    const tampered = `${signed.slice(0, -4)}dead`;
    expect(verifySignedValue(tampered, secret)).toBeNull();
  });

  it('returns null for a tampered value (mac no longer matches)', () => {
    const signed = signValue('abc', secret);
    const [, mac] = signed.split('.');
    expect(verifySignedValue(`xyz.${mac}`, secret)).toBeNull();
  });

  it('rejects a valid mac with an odd nibble appended ("<value>.<validmac>0")', () => {
    // Regression for the hex decode-collision constantTimeEqual guards
    // against: Buffer.from(mac + '0', 'hex') decodes to the SAME bytes as
    // Buffer.from(mac, 'hex'), so without the string-length check this
    // 65-char mac would wrongly verify.
    const signed = signValue('abc', secret);
    const [value, mac] = signed.split('.');
    expect(verifySignedValue(`${value}.${mac}0`, secret)).toBeNull();
  });

  it('rejects a valid mac with invalid trailing hex characters ("<value>.<validmac>zz")', () => {
    // Same collision via an even-length invalid tail: Buffer.from(mac + 'zz',
    // 'hex') also decodes to the same bytes as Buffer.from(mac, 'hex').
    const signed = signValue('abc', secret);
    const [value, mac] = signed.split('.');
    expect(verifySignedValue(`${value}.${mac}zz`, secret)).toBeNull();
  });

  it('returns null when verifying under a different secret', () => {
    const signed = signValue('abc', secret);
    expect(verifySignedValue(signed, 'a-completely-different-secret-32b!!')).toBeNull();
  });

  it('returns null for missing, empty, null, or undefined input', () => {
    expect(verifySignedValue('', secret)).toBeNull();
    expect(verifySignedValue(null, secret)).toBeNull();
    expect(verifySignedValue(undefined, secret)).toBeNull();
  });

  it('returns null when the separator is missing', () => {
    expect(verifySignedValue('no-separator-here', secret)).toBeNull();
  });

  it('returns null when there is more than one separator (value cannot itself contain it)', () => {
    const signed = signValue('abc', secret);
    expect(verifySignedValue(`extra.${signed}`, secret)).toBeNull();
  });

  it('returns null when either half is empty', () => {
    expect(verifySignedValue('.mac-without-value', secret)).toBeNull();
    expect(verifySignedValue('value-without-mac.', secret)).toBeNull();
  });

  it('supports a custom separator', () => {
    const signed = signValue('session-42', secret, { separator: '|' });
    expect(signed.includes('|')).toBe(true);
    expect(signed.includes('.')).toBe(false);
    expect(verifySignedValue(signed, secret, { separator: '|' })).toBe('session-42');
    // Verifying with the default separator ('.') fails to split correctly.
    expect(verifySignedValue(signed, secret)).toBeNull();
  });

  it('supports a non-hex digest/compare encoding (base64url) and round-trips', () => {
    const options = { digestEncoding: 'base64url' as const, compareEncoding: 'base64url' as const };
    const signed = signValue('nonce-abc', secret, options);
    const [, mac] = signed.split('.');
    expect(mac).toBe(createHmac('sha256', secret).update('nonce-abc').digest('base64url'));
    expect(verifySignedValue(signed, secret, options)).toBe('nonce-abc');
  });

  it('supports compareEncoding "utf8" while digestEncoding stays "hex" — the admin/impersonation deviation', () => {
    // The wire format is identical to the default hex/hex case (a hex digest
    // string), but the verify path decodes it as literal UTF-8 text instead of
    // hex bytes. Since a hex digest is pure ASCII, the result agrees with the
    // hex/hex case for both valid and tampered signatures — proving the two
    // compare paths are wire-compatible for this alphabet, even though they are
    // genuinely different comparisons (pinned in the constantTimeEqual suite
    // above).
    const options = { compareEncoding: 'utf8' as const };
    const signed = signValue('session-77', secret); // digestEncoding defaults to hex either way
    expect(verifySignedValue(signed, secret, options)).toBe('session-77');

    const tampered = `${signed.slice(0, -4)}dead`;
    expect(verifySignedValue(tampered, secret, options)).toBeNull();
  });

  it('supports a message() builder that signs more than the embedded value — the destructive-auth deviation', () => {
    const options = {
      message: (value: string) => `repworth:ctx:v1:user-1:account-1:${value}`,
    };
    const signed = signValue('1700000000000', secret, options);
    expect(verifySignedValue(signed, secret, options)).toBe('1700000000000');

    // Verifying without reproducing the same external context fails, because
    // the signed message differs even though the wire value is unchanged.
    const wrongContext = {
      message: (value: string) => `repworth:ctx:v1:user-2:account-1:${value}`,
    };
    expect(verifySignedValue(signed, secret, wrongContext)).toBeNull();
  });

  it('rejects a value signed under one algorithm when verified under another', () => {
    const signed = signValue('abc', secret, { algorithm: 'sha1' });
    expect(verifySignedValue(signed, secret, { algorithm: 'sha256' })).toBeNull();
    expect(verifySignedValue(signed, secret, { algorithm: 'sha1' })).toBe('abc');
  });
});

describe('module boundary (#1370)', () => {
  it('is the only module under src/lib that references node:crypto\'s timingSafeEqual', () => {
    // Scoped to src/lib, matching the issue's stated scope ("seven
    // timingSafeEqual call sites in six files under src/lib"). The
    // worker/ingress webhook-signature verifiers (Resend, Telegram, Zernio) and
    // worker/internal/queue-health.ts are a different domain — inbound
    // third-party payload verification, not the cookie/token signing
    // convention this module owns — and are out of scope for #1370.
    //
    // Four of the seven original call sites additionally guarded with their own
    // try/catch around a `Buffer.from(str, 'hex')` + timingSafeEqual pair; that
    // guard is now internal to constantTimeEqual, so a second raw
    // `timingSafeEqual` call site under src/lib is exactly the drift #1370 was
    // filed to stop.
    const matches = execFileSync(
      'git',
      [
        'grep', '-n', '-F', '-e', 'timingSafeEqual',
        '--', 'src/lib', ':!src/lib/**/__tests__/**',
      ],
      { encoding: 'utf8' },
    ).trim().split('\n');

    const outsideModule = matches.filter((line) => {
      if (line.startsWith('src/lib/shared/signed-value.ts:')) return false;
      // A prose comment merely naming timingSafeEqual (e.g. documenting the
      // out-of-scope worker/ingress webhook-verification convention) is not a
      // second definition — only a real reference outside the module is.
      const content = line.replace(/^[^:]+:\d+:/, '');
      return !content.trim().startsWith('//');
    });
    expect(outsideModule).toEqual([]);
  });
});
