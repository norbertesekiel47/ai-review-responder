import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { getIpKey } from '../request-ip';

function mkReq(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('https://app.example.com/test', {
    method: 'GET',
    headers,
  });
}

describe('getIpKey', () => {
  it('extracts the leftmost IP from x-forwarded-for', () => {
    const req = mkReq({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8, 9.10.11.12' });
    expect(getIpKey(req, 'signup')).toBe('signup:ip:1.2.3.4');
  });

  it('handles a single-IP x-forwarded-for', () => {
    const req = mkReq({ 'x-forwarded-for': '1.2.3.4' });
    expect(getIpKey(req, 'signup')).toBe('signup:ip:1.2.3.4');
  });

  it('trims whitespace around the leftmost entry', () => {
    const req = mkReq({ 'x-forwarded-for': '  1.2.3.4 , 5.6.7.8' });
    expect(getIpKey(req, 'signup')).toBe('signup:ip:1.2.3.4');
  });

  it('falls back to unknown when header is absent', () => {
    const req = mkReq();
    expect(getIpKey(req, 'signup')).toBe('signup:ip:unknown');
  });

  // B22 — the ?? fallback only caught null/undefined, not empty strings.
  // These three shapes all used to produce `signup:ip:` (with empty IP),
  // collapsing every anonymous request into one bucket and enabling
  // rate-limit dodging via header spoofing.
  describe('regression — empty / whitespace / leading-comma headers', () => {
    it('falls back to unknown when header is empty string', () => {
      const req = mkReq({ 'x-forwarded-for': '' });
      expect(getIpKey(req, 'signup')).toBe('signup:ip:unknown');
    });

    it('falls back to unknown when header is whitespace-only', () => {
      const req = mkReq({ 'x-forwarded-for': '   ' });
      expect(getIpKey(req, 'signup')).toBe('signup:ip:unknown');
    });

    it('falls back to unknown when header has a leading comma', () => {
      // Some misconfigured proxies emit ", 1.2.3.4" — the leftmost entry
      // is empty, but the actual client IP is right after. The function
      // intentionally takes the LEFTMOST entry per the X-Forwarded-For
      // contract (closest to client), so an empty leftmost should fall
      // back to unknown rather than silently use the upstream proxy IP
      // (which would let an attacker reach your-IP rate-limit bucket
      // by spoofing a leading comma).
      const req = mkReq({ 'x-forwarded-for': ', 1.2.3.4' });
      expect(getIpKey(req, 'signup')).toBe('signup:ip:unknown');
    });

    it('falls back to unknown when header is just whitespace + comma', () => {
      const req = mkReq({ 'x-forwarded-for': ' , ' });
      expect(getIpKey(req, 'signup')).toBe('signup:ip:unknown');
    });
  });

  it('ip portion is never empty (key shape invariant)', () => {
    // No matter what shape the header takes, the returned key must always
    // have a non-empty IP segment. This is the load-bearing invariant for
    // every rate-limit + log analysis caller downstream.
    const cases = [
      undefined,
      '',
      '   ',
      ',',
      ', ',
      ' , ',
      ',,,',
      '1.2.3.4',
      '1.2.3.4, 5.6.7.8',
      ' 1.2.3.4 ',
    ];
    for (const headerValue of cases) {
      const req =
        headerValue === undefined ? mkReq() : mkReq({ 'x-forwarded-for': headerValue });
      const key = getIpKey(req, 'signup');
      expect(key).toMatch(/^signup:ip:.+$/);
      expect(key).not.toBe('signup:ip:');
    }
  });

  it('uses the prefix verbatim', () => {
    const req = mkReq({ 'x-forwarded-for': '1.2.3.4' });
    expect(getIpKey(req, 'verify-otp')).toBe('verify-otp:ip:1.2.3.4');
    expect(getIpKey(req, 'select-plan')).toBe('select-plan:ip:1.2.3.4');
  });
});
