import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { assertSameOrigin, isSelfOrigin, SameOriginError } from '../csrf';

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

  it('passes when Sec-Fetch-Site is same-origin and Origin matches APP_URL', () => {
    const req = new Request('https://app.example.com/api/test', {
      method: 'POST',
      headers: { Origin: APP_URL, 'Sec-Fetch-Site': 'same-origin' },
    });
    expect(() => assertSameOrigin(req)).not.toThrow();
  });

  it('throws SameOriginError when Sec-Fetch-Site is cross-site', () => {
    const req = new Request('https://app.example.com/api/test', {
      method: 'POST',
      headers: { Origin: APP_URL, 'Sec-Fetch-Site': 'cross-site' },
    });
    expect(() => assertSameOrigin(req)).toThrow(SameOriginError);
    expect(() => assertSameOrigin(req)).toThrow(/cross-site/);
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

  // ── #1186 · ADR 0026 D4 — one predicate owns the own-origin comparison ─────

  it('assertSameOrigin keeps its four refusals after adopting the shared predicate', () => {
    // CHARACTERIZATION. The four throws above assertSameOrigin's verdict must
    // survive the refactor that moves the comparison itself into isSelfOrigin.
    const req = (headers: Record<string, string>) =>
      new Request('https://app.example.com/api/test', { method: 'POST', headers });

    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(() => assertSameOrigin(req({ Origin: APP_URL }))).toThrow(
      /NEXT_PUBLIC_APP_URL not configured/,
    );

    process.env.NEXT_PUBLIC_APP_URL = APP_URL;
    expect(() =>
      assertSameOrigin(req({ Origin: APP_URL, 'Sec-Fetch-Site': 'cross-site' })),
    ).toThrow(/cross-site/);
    expect(() => assertSameOrigin(req({}))).toThrow(/Missing Origin header/);
    expect(() => assertSameOrigin(req({ Origin: 'not a url' }))).toThrow(
      /Malformed Origin or APP_URL/,
    );
    expect(() => assertSameOrigin(req({ Origin: 'https://evil.example.com' }))).toThrow(
      /does not match APP_URL/,
    );
  });

  it('assertSameOrigin still refuses an allowlisted Admin app origin and a loopback origin', () => {
    // The Admin origin allowlist must NOT leak into CSRF. Only isSelfOrigin is
    // shared; reusing the broader admin decision here would silently exempt
    // every allowlisted origin from CSRF.
    process.env.ADMIN_APP_ORIGINS = 'https://admin.staging.repworth.net';
    delete process.env.VERCEL_TARGET_ENV;

    for (const origin of ['https://admin.staging.repworth.net', 'http://localhost:3000']) {
      const req = new Request('https://app.example.com/api/test', {
        method: 'POST',
        headers: { Origin: origin },
      });
      expect(() => assertSameOrigin(req), `origin=${origin}`).toThrow(SameOriginError);
    }
  });
});

describe('isSelfOrigin', () => {
  const originalEnv = process.env.NEXT_PUBLIC_APP_URL;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  });

  afterEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = originalEnv;
  });

  it('isSelfOrigin compares NEXT_PUBLIC_APP_URL by URL origin and is false when it is unset', () => {
    expect(isSelfOrigin(APP_URL)).toBe(true);
    expect(isSelfOrigin('https://app.example.com/')).toBe(true);

    // Subpath APP_URL: only the origin is compared (the assertSameOrigin rule).
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com/prefix';
    expect(isSelfOrigin(APP_URL)).toBe(true);

    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(isSelfOrigin(APP_URL)).toBe(false);
  });

  it('isSelfOrigin is false for absent, malformed, scheme-mismatched and port-mismatched input', () => {
    // TOTAL: it never throws, so the proxy's self-origin test cannot 500.
    for (const input of [null, undefined, '', '   ', 'null', 'not a url', 'app.example.com']) {
      expect(isSelfOrigin(input), `input=${JSON.stringify(input)}`).toBe(false);
    }
    expect(isSelfOrigin('http://app.example.com')).toBe(false); // scheme
    expect(isSelfOrigin('https://app.example.com:8443')).toBe(false); // port
    expect(isSelfOrigin('https://evil.app.example.com')).toBe(false); // subdomain

    process.env.NEXT_PUBLIC_APP_URL = 'not a url';
    expect(isSelfOrigin(APP_URL)).toBe(false); // malformed APP_URL, still no throw
  });

  it('keeps the own-origin comparison in one predicate consumed by both the CORS decision and CSRF', () => {
    // ADR 0026 D4: "One predicate owns the origin comparison." Behavioural
    // agreement is not enough — two equivalent copies pass every behavioural
    // test and then drift apart in someone else's PR.
    const repoRoot = join(__dirname, '..', '..', '..', '..');
    const read = (file: string) =>
      readFileSync(join(repoRoot, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');

    const csrf = read('src/lib/shared/csrf.ts');
    const adminOrigins = read('src/lib/config/admin-origins.ts');
    const proxySource = read('src/proxy.ts');

    // csrf.ts is the single owner: it is the only one of the three that reads
    // NEXT_PUBLIC_APP_URL at all.
    expect(csrf).toContain('NEXT_PUBLIC_APP_URL');
    expect(adminOrigins).not.toContain('NEXT_PUBLIC_APP_URL');
    expect(proxySource).not.toContain('NEXT_PUBLIC_APP_URL');

    // …and the CORS decision consumes it rather than re-spelling it.
    expect(adminOrigins).toMatch(/import\s*\{[^}]*\bisSelfOrigin\b[^}]*\}\s*from\s*['"]@\/lib\/shared\/csrf['"]/);
  });
});
