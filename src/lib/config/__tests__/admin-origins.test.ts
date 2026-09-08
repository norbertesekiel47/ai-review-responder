import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AdminOriginConfigError,
  isAllowedAdminOrigin,
  normalizeOrigin,
  readAdminAppOrigins,
} from '../admin-origins';

const APP_ORIGIN = 'https://repworth.net';
const ADMIN_ORIGIN = 'https://admin.staging.repworth.net';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function withEnv(env: Record<string, string | undefined>): void {
  process.env.NEXT_PUBLIC_APP_URL = APP_ORIGIN;
  delete process.env.VERCEL_TARGET_ENV;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe('readAdminAppOrigins', () => {
  it('throws when an ADMIN_APP_ORIGINS entry contains a wildcard', () => {
    // ADR 0026 D2: the parser's refusal on '*' is what keeps ADR 0026 D7 true —
    // a wildcard Access-Control-Allow-Origin can never be CONFIGURED.
    for (const raw of ['*', 'https://*.repworth.net', `${ADMIN_ORIGIN},*`, 'https://a.example,https://*.b.example']) {
      withEnv({ ADMIN_APP_ORIGINS: raw });
      expect(() => readAdminAppOrigins(), `raw=${raw}`).toThrow(AdminOriginConfigError);
    }
  });

  it('tolerates whitespace and trailing commas in ADMIN_APP_ORIGINS', () => {
    withEnv({ ADMIN_APP_ORIGINS: `  ${ADMIN_ORIGIN} ,, https://admin.repworth.net/ ,  ` });

    expect(readAdminAppOrigins()).toEqual([ADMIN_ORIGIN, 'https://admin.repworth.net']);
  });

  it('admits nothing but loopback and this app\'s own origin when ADMIN_APP_ORIGINS is empty', () => {
    for (const raw of [undefined, '', '   ', ',,']) {
      withEnv({ ADMIN_APP_ORIGINS: raw });
      const allowlist = readAdminAppOrigins();

      expect(allowlist, `raw=${JSON.stringify(raw)}`).toEqual([]);
      expect(isAllowedAdminOrigin(APP_ORIGIN, allowlist)).toBe(true);
      expect(isAllowedAdminOrigin('http://localhost:3000', allowlist)).toBe(true);
      expect(isAllowedAdminOrigin(ADMIN_ORIGIN, allowlist)).toBe(false);
    }
  });

  it('throws when an ADMIN_APP_ORIGINS entry is not a parseable absolute origin', () => {
    for (const raw of ['admin.repworth.net', 'not a url', '//admin.repworth.net', '/api/admin']) {
      withEnv({ ADMIN_APP_ORIGINS: raw });
      expect(() => readAdminAppOrigins(), `raw=${raw}`).toThrow(AdminOriginConfigError);
    }
  });

  it('throws when an ADMIN_APP_ORIGINS entry is not an http or https origin', () => {
    // new URL() happily accepts these. file:/data: serialize to the origin "null",
    // and blob:https://admin.example/id normalizes to https://admin.example — which
    // would silently grant authority to an origin nobody wrote down.
    for (const raw of [
      'file:///etc/passwd',
      'data:text/html,<script>',
      'blob:https://admin.example/1234',
      'javascript:alert(1)',
    ]) {
      withEnv({ ADMIN_APP_ORIGINS: raw });
      expect(() => readAdminAppOrigins(), `raw=${raw}`).toThrow(AdminOriginConfigError);
    }
  });

  it('throws when an ADMIN_APP_ORIGINS entry carries userinfo, a path, a query or a fragment', () => {
    // Discarding these would widen an apparently URL-scoped entry into authority
    // over the whole origin. Only a bare trailing slash is accepted.
    for (const raw of [
      'https://user:pass@admin.repworth.net',
      'https://admin.repworth.net/admin',
      'https://admin.repworth.net/?tenant=1',
      'https://admin.repworth.net/#frag',
    ]) {
      withEnv({ ADMIN_APP_ORIGINS: raw });
      expect(() => readAdminAppOrigins(), `raw=${raw}`).toThrow(AdminOriginConfigError);
    }

    withEnv({ ADMIN_APP_ORIGINS: 'https://admin.repworth.net/' });
    expect(readAdminAppOrigins()).toEqual(['https://admin.repworth.net']);
  });

  it('re-reads ADMIN_APP_ORIGINS and NEXT_PUBLIC_APP_URL on every call', () => {
    // Not memoized, per the src/lib/config/flags.ts precedent.
    withEnv({ ADMIN_APP_ORIGINS: ADMIN_ORIGIN });
    expect(readAdminAppOrigins()).toEqual([ADMIN_ORIGIN]);

    process.env.ADMIN_APP_ORIGINS = 'https://other.example';
    expect(readAdminAppOrigins()).toEqual(['https://other.example']);

    delete process.env.ADMIN_APP_ORIGINS;
    expect(readAdminAppOrigins()).toEqual([]);

    expect(isAllowedAdminOrigin(APP_ORIGIN, [])).toBe(true);
    process.env.NEXT_PUBLIC_APP_URL = 'https://elsewhere.example';
    expect(isAllowedAdminOrigin(APP_ORIGIN, [])).toBe(false);
  });
});

describe('isAllowedAdminOrigin', () => {
  it('refuses lookalike hosts and mismatched schemes or ports', () => {
    withEnv({ ADMIN_APP_ORIGINS: ADMIN_ORIGIN });
    const allowlist = readAdminAppOrigins();

    expect(isAllowedAdminOrigin(ADMIN_ORIGIN, allowlist)).toBe(true);

    for (const origin of [
      'https://admin.staging.repworth.net.evil.example', // suffix attack
      'https://evil.example/admin.staging.repworth.net', // substring attack
      'https://staging.repworth.net', // parent host
      'https://x.admin.staging.repworth.net', // subdomain
      'http://admin.staging.repworth.net', // scheme mismatch
      'https://admin.staging.repworth.net:8443', // port mismatch
      'https://admin-staging.repworth.net', // homoglyph-ish
    ]) {
      expect(isAllowedAdminOrigin(origin, allowlist), `origin=${origin}`).toBe(false);
    }
  });

  it("treats a loopback origin as the code rule's alone, refusing it in the production lane even when listed", () => {
    // ADR 0026 D2: "Loopback is a separate code rule, NOT a list entry." If a
    // listed entry could win, the production lane's inertness would be
    // bypassable from a dashboard.
    withEnv({ ADMIN_APP_ORIGINS: 'http://localhost:3000', VERCEL_TARGET_ENV: 'production' });
    const allowlist = readAdminAppOrigins();

    expect(allowlist).toEqual(['http://localhost:3000']);
    expect(isAllowedAdminOrigin('http://localhost:3000', allowlist)).toBe(false);
    expect(isAllowedAdminOrigin('http://127.0.0.1:3000', allowlist)).toBe(false);
  });

  it('applies the loopback rule across both hosts, any port, and every non-production lane', () => {
    for (const lane of [undefined, 'development', 'preview', 'staging']) {
      withEnv({ ADMIN_APP_ORIGINS: '', VERCEL_TARGET_ENV: lane });

      for (const origin of [
        'http://localhost',
        'http://localhost:3000',
        'http://localhost:65535',
        'http://127.0.0.1',
        'http://127.0.0.1:54321',
      ]) {
        expect(isAllowedAdminOrigin(origin, []), `${origin} @ lane=${lane}`).toBe(true);
      }

      // NOT loopback by this rule (ADR 0024 D7 wrote `http://localhost:*`).
      for (const origin of ['https://localhost:3000', 'http://[::1]:3000', 'http://127.0.0.2']) {
        expect(isAllowedAdminOrigin(origin, []), `${origin} @ lane=${lane}`).toBe(false);
      }
    }

    withEnv({ ADMIN_APP_ORIGINS: '', VERCEL_TARGET_ENV: 'production' });
    expect(isAllowedAdminOrigin('http://localhost:3000', [])).toBe(false);
  });
});

describe('Edge safety', () => {
  it('keeps the CORS import graph free of node builtins, database clients and forbidden SDKs', () => {
    // src/proxy.ts runs at the request edge but sits OUTSIDE every ESLint
    // invariant #1 zone (eslint.config.mjs covers src/app/**, src/instrumentation.ts
    // and src/components/**), so nothing else stops a forbidden import from
    // reaching the proxy through this module. Precedent for the mechanical scan:
    // src/lib/auth/__tests__/admin-transport.test.ts § Edge safety (#1183).
    const repoRoot = join(__dirname, '..', '..', '..', '..');
    const graph = [
      'src/proxy.ts',
      'src/lib/config/admin-origins.ts',
      'src/lib/config/flags.ts',
      'src/lib/shared/csrf.ts',
    ];
    const forbidden = [
      'node:',
      '@/lib/db',
      'postgres',
      'bullmq',
      'openai',
      '@anthropic-ai/sdk',
      '@supabase/supabase-js',
      'ioredis',
    ];

    for (const file of graph) {
      const source = readFileSync(join(repoRoot, file), 'utf8');
      // Strip comments first: these modules NAME the things they must not import.
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      const specifiers = [...code.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);

      for (const bad of forbidden) {
        expect(
          specifiers.filter((s) => s === bad || s.startsWith(`${bad}/`)),
          `${file} must not import ${bad}`,
        ).toEqual([]);
      }
    }
  });
});

describe('normalizeOrigin', () => {
  it('returns the canonical http(s) origin, and null for anything else', () => {
    expect(normalizeOrigin('https://ADMIN.Staging.RepWorth.net')).toBe(ADMIN_ORIGIN);
    expect(normalizeOrigin('https://admin.repworth.net/')).toBe('https://admin.repworth.net');
    expect(normalizeOrigin('http://localhost:3000')).toBe('http://localhost:3000');

    for (const bad of ['', '   ', 'null', 'not a url', 'file:///x', 'data:text/html,x', `${APP_ORIGIN} ${ADMIN_ORIGIN}`, null, undefined]) {
      expect(normalizeOrigin(bad), `input=${JSON.stringify(bad)}`).toBeNull();
    }
  });
});
