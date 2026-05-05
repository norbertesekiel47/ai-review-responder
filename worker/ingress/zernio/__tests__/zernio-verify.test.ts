import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyZernioSignature } from '../zernio-verify';

const SECRET = 'test-secret-32-bytes-minimum-zzz';

describe('verifyZernioSignature', () => {
  it('accepts a valid hex signature', () => {
    const body = '{"event":"webhook.test"}';
    const expected = createHmac('sha256', SECRET).update(body).digest('hex');
    expect(verifyZernioSignature(body, expected, SECRET)).toBe(true);
  });

  it('rejects a wrong-but-correctly-shaped signature', () => {
    expect(verifyZernioSignature('{}', '0'.repeat(64), SECRET)).toBe(false);
  });

  it('rejects a non-hex signature of correct length', () => {
    // 64 chars but not hex.
    const nonHex = 'z'.repeat(64);
    expect(verifyZernioSignature('{}', nonHex, SECRET)).toBe(false);
  });

  it('rejects a wrong-length signature', () => {
    expect(verifyZernioSignature('{}', 'abc', SECRET)).toBe(false);
  });

  it('rejects empty string signature', () => {
    expect(verifyZernioSignature('{}', '', SECRET)).toBe(false);
  });

  it('accepts uppercase hex (HEX_64 regex is case-insensitive per spec)', () => {
    const body = '{"event":"webhook.test"}';
    const expected = createHmac('sha256', SECRET).update(body).digest('hex').toUpperCase();
    // Spec §5.3: HEX_64 = /^[0-9a-f]{64}$/i (case-insensitive)
    expect(verifyZernioSignature(body, expected, SECRET)).toBe(true);
  });

  it('rejects when body has been tampered (replay/forgery resistance)', () => {
    const goodBody = '{"event":"webhook.test","id":"evt_1"}';
    const tamperedBody = '{"event":"webhook.test","id":"evt_2"}';
    const sigForGood = createHmac('sha256', SECRET).update(goodBody).digest('hex');
    expect(verifyZernioSignature(tamperedBody, sigForGood, SECRET)).toBe(false);
  });

  it('rejects when secret differs', () => {
    const body = '{"event":"webhook.test"}';
    const sig = createHmac('sha256', 'other-secret').update(body).digest('hex');
    expect(verifyZernioSignature(body, sig, SECRET)).toBe(false);
  });
});
