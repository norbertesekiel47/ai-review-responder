import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { assertSameOrigin, SameOriginError } from '../csrf';

const APP_URL = 'https://app.example.com';

describe('assertSameOrigin', () => {
  const originalEnv = process.env.NEXT_PUBLIC_APP_URL;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  });

  afterEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = originalEnv;
  });

  it('passes when Origin matches APP_URL exactly', () => {
    const req = new Request('https://app.example.com/api/test', {
      method: 'POST',
      headers: { Origin: APP_URL },
    });
    expect(() => assertSameOrigin(req)).not.toThrow();
  });

  it('throws SameOriginError when Origin differs', () => {
    const req = new Request('https://app.example.com/api/test', {
      method: 'POST',
      headers: { Origin: 'https://evil.example.com' },
    });
    expect(() => assertSameOrigin(req)).toThrow(SameOriginError);
    expect(() => assertSameOrigin(req)).toThrow(/does not match APP_URL/);
  });

  it('throws "Missing Origin" error when Origin header absent', () => {
    const req = new Request('https://app.example.com/api/test', {
      method: 'POST',
    });
    expect(() => assertSameOrigin(req)).toThrow(SameOriginError);
    expect(() => assertSameOrigin(req)).toThrow(/Missing Origin header/);
  });

  it('throws "APP_URL" error when NEXT_PUBLIC_APP_URL unset', () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    const req = new Request('https://app.example.com/api/test', {
      method: 'POST',
      headers: { Origin: APP_URL },
    });
    expect(() => assertSameOrigin(req)).toThrow(SameOriginError);
    expect(() => assertSameOrigin(req)).toThrow(/NEXT_PUBLIC_APP_URL not configured/);
  });

  it('treats trailing slashes as equivalent', () => {
    const reqWithTrailingSlash = new Request('https://app.example.com/api/test', {
      method: 'POST',
      headers: { Origin: 'https://app.example.com/' },
    });
    expect(() => assertSameOrigin(reqWithTrailingSlash)).not.toThrow();

    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com/';
    const reqWithoutTrailingSlash = new Request('https://app.example.com/api/test', {
      method: 'POST',
      headers: { Origin: 'https://app.example.com' },
    });
    expect(() => assertSameOrigin(reqWithoutTrailingSlash)).not.toThrow();
  });

  it('treats subpath APP_URL correctly (compares only origin)', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com/prefix';
    const req = new Request('https://app.example.com/prefix/api/test', {
      method: 'POST',
      headers: { Origin: 'https://app.example.com' },
    });
    expect(() => assertSameOrigin(req)).not.toThrow();
  });

  it('rejects malformed Origin', () => {
    const req = new Request('https://app.example.com/api/test', {
      method: 'POST',
      headers: { Origin: 'not a url' },
    });
    expect(() => assertSameOrigin(req)).toThrow(SameOriginError);
  });
});
