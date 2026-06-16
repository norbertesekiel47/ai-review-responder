import { describe, expect, it } from 'vitest';

// Guards the global response-header block in next.config.mjs. Vitest can import
// the config and invoke headers() directly — the withBotId/withSentryConfig
// wrappers don't break the call. We assert against the REAL exported config, not
// a text scrape, so an accidental edit that drops or weakens a security header
// fails CI. (CSP itself is unit-tested separately in csp.test.ts; it is absent
// here because buildContentSecurityPolicy returns '' outside production and the
// config's .filter drops empty-valued headers.)

type HeaderEntry = { key: string; value: string };
type HeaderRule = { source: string; headers: HeaderEntry[] };
type NextConfigModule = { default: { headers: () => Promise<HeaderRule[]> } };

async function globalHeaderMap(): Promise<Map<string, string>> {
  const mod = (await import('../../../../next.config.mjs')) as unknown as NextConfigModule;
  const rules = await mod.default.headers();
  const globalRule = rules.find((rule) => rule.source === '/(.*)');
  if (!globalRule) throw new Error('expected a /(.*) header rule in next.config.mjs');
  return new Map(globalRule.headers.map((header) => [header.key, header.value]));
}

describe('next.config.mjs global security headers', () => {
  it('sets Cross-Origin-Opener-Policy: same-origin (F-12)', async () => {
    const headers = await globalHeaderMap();
    expect(headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
  });

  it('sets Cross-Origin-Resource-Policy: same-origin (F-12)', async () => {
    const headers = await globalHeaderMap();
    expect(headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
  });

  it('keeps the pre-existing security headers (full-block regression guard)', async () => {
    const headers = await globalHeaderMap();
    expect(headers.get('Strict-Transport-Security')).toContain('max-age=63072000');
    expect(headers.get('Strict-Transport-Security')).toContain('includeSubDomains');
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(headers.get('X-Frame-Options')).toBe('DENY');
    expect(headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(headers.get('Permissions-Policy')).toContain('camera=()');
  });

  it('does NOT add HSTS preload (F-23 held pending owner sign-off)', async () => {
    const headers = await globalHeaderMap();
    expect(headers.get('Strict-Transport-Security')).not.toContain('preload');
  });

  it('does NOT emit a static Content-Security-Policy (F-11: nonce CSP comes from middleware)', async () => {
    // CSP carries a per-request nonce and is set in src/proxy.ts. A second static
    // CSP here would be enforced as the intersection and block Next's inline
    // bootstrap scripts — so it must stay out of next.config.mjs.
    const headers = await globalHeaderMap();
    expect(headers.has('Content-Security-Policy')).toBe(false);
  });
});
