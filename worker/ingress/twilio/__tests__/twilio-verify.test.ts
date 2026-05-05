import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { parseTwilioBody, verifyTwilioSignature } from '../twilio-verify';

// Twilio's documented signature algorithm:
//   base64(HMAC-SHA1(authToken, url + concat(sortedParamKeys.map(k => k + params[k]))))
function signFixture(authToken: string, url: string, params: Record<string, string>): string {
  const sorted = Object.keys(params).sort().map(k => k + params[k]).join('');
  return createHmac('sha1', authToken).update(url + sorted).digest('base64');
}

describe('parseTwilioBody', () => {
  it('parses form-urlencoded body to key-value object', () => {
    const raw = 'From=%2B15551234567&To=%2B15550001111&Body=STOP&MessageSid=SM123';
    expect(parseTwilioBody(raw)).toEqual({
      From: '+15551234567',
      To: '+15550001111',
      Body: 'STOP',
      MessageSid: 'SM123',
    });
  });

  it('returns empty object for empty body', () => {
    expect(parseTwilioBody('')).toEqual({});
  });

  it('decodes URL-encoded special characters in values', () => {
    const raw = 'Body=Hello%20world%21%20%26%20more';
    expect(parseTwilioBody(raw).Body).toBe('Hello world! & more');
  });
});

describe('verifyTwilioSignature', () => {
  const token = 'test_auth_token_12345';
  const url = 'https://worker.example.com/ingress/twilio/inbound';

  it('returns true for a valid signature', () => {
    const params = { From: '+15551234567', Body: 'STOP', MessageSid: 'SM1' };
    const sig = signFixture(token, url, params);
    expect(verifyTwilioSignature({ authToken: token, signatureHeader: sig, fullUrl: url, params })).toBe(true);
  });

  it('returns false for a tampered signature', () => {
    expect(verifyTwilioSignature({
      authToken: token,
      signatureHeader: 'wrong_sig_base64',
      fullUrl: url,
      params: { From: '+15551234567', Body: 'STOP' },
    })).toBe(false);
  });

  it('returns false when signatureHeader is missing', () => {
    expect(verifyTwilioSignature({
      authToken: token,
      signatureHeader: undefined,
      fullUrl: url,
      params: {},
    })).toBe(false);
  });

  it('fails open in MOCK_EXTERNAL_APIS mode when authToken is missing', () => {
    const prev = process.env.MOCK_EXTERNAL_APIS;
    process.env.MOCK_EXTERNAL_APIS = 'true';
    expect(verifyTwilioSignature({
      authToken: undefined,
      signatureHeader: 'anything',
      fullUrl: url,
      params: {},
    })).toBe(true);
    process.env.MOCK_EXTERNAL_APIS = prev;
  });

  it('fails closed in non-mock mode when authToken is missing', () => {
    const prev = process.env.MOCK_EXTERNAL_APIS;
    process.env.MOCK_EXTERNAL_APIS = 'false';
    expect(verifyTwilioSignature({
      authToken: undefined,
      signatureHeader: 'x',
      fullUrl: url,
      params: {},
    })).toBe(false);
    process.env.MOCK_EXTERNAL_APIS = prev;
  });

  it('returns false when params differ from what was signed', () => {
    const params = { From: '+15551234567', Body: 'STOP' };
    const sig = signFixture(token, url, params);
    // Attacker tampers with the Body but keeps the signature.
    expect(verifyTwilioSignature({
      authToken: token,
      signatureHeader: sig,
      fullUrl: url,
      params: { From: '+15551234567', Body: 'START' },  // tampered
    })).toBe(false);
  });

  it('returns false when URL differs from what was signed', () => {
    const params = { From: '+15551234567', Body: 'STOP' };
    const sig = signFixture(token, url, params);
    expect(verifyTwilioSignature({
      authToken: token,
      signatureHeader: sig,
      fullUrl: 'https://attacker.example.com/ingress/twilio/inbound',  // wrong URL
      params,
    })).toBe(false);
  });
});
