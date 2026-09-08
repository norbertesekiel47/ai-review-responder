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

/**
 * Comments out, LINE comments first. Order is load-bearing: these modules
 * document their own rules, and a line comment naming `/api/admin/**` contains
 * a literal `/*` that opens a phantom block comment which then swallows the
 * import statements up to the next `*` + `/`. Stripping line comments first
 * removes the phantom opener before the block pass ever sees it.
 */
function stripComments(source: string): string {
  return source.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function withEnv(env: Record<string, string | undefined>): void {
  process.env.NEXT_PUBLIC_APP_URL = APP_ORIGIN;
  delete process.env.VERCEL_TARGET_ENV;
  // Off Vercel unless a case says otherwise: isProductionEnvironment fails
  // CLOSED when VERCEL is set with no target-env signal, so leaving a stray
  // VERCEL in the environment would silently make every lane read as production.
  delete process.env.VERCEL;
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

  it("admits nothing but loopback and this app's own origin when ADMIN_APP_ORIGINS is empty", () => {
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
    //
    // The first two fixtures are the ones that actually PIN the scheme guard:
    // they have a root path, no userinfo, no query and no fragment, so the
    // scheme check is the ONLY rule they break. Every other entry below also
    // trips the path guard two clauses later — a red-team mutation deleted the
    // scheme throw and this test still passed until these two were added.
    for (const raw of [
      'ftp://admin.example',
      'ws://admin.example/',
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
      const code = stripComments(readFileSync(join(repoRoot, file), 'utf8'));
      // FOUR import shapes, not one. A red-team pass added
      // `import { createHash } from 'node:crypto'` AND a bare
      // `import 'node:crypto';` and BOTH survived the first version of this
      // guard: the bare form has no `from` clause at all, and the prefix match
      // below was `s.startsWith('node:/')`, which no real specifier ever is.
      // The same bypass is documented on this test's own cited precedent.
      const specifiers = [
        ...code.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g),
        ...code.matchAll(/\bimport\s+['"]([^'"]+)['"]/g),
        ...code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g),
        ...code.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]/g),
      ].map((m) => m[1] ?? '');

      for (const bad of forbidden) {
        // A scheme prefix (`node:`) matches on the prefix alone; a package name
        // matches exactly or on a subpath, so `postgres` never matches
        // `postgres-array`.
        const matches = specifiers.filter((s) =>
          bad.endsWith(':') ? s.startsWith(bad) : s === bad || s.startsWith(`${bad}/`),
        );
        expect(matches, `${file} must not import ${bad}`).toEqual([]);
      }
    }
  });

  it('scans direct specifiers only — the depth-1 limit is stated, not implied', () => {
    // The title above says "import graph"; this is the honest scope of the scan.
    // `src/proxy.ts` imports `@supabase/ssr`, which itself depends on
    // `@supabase/supabase-js` — so the forbidden list is a ban on DIRECT
    // imports by these four files, not a claim about the transitive closure.
    // That is deliberate: `@supabase/ssr` is the Edge-safe client the proxy has
    // always used, and banning its transitive dependency would ban the proxy.
    const proxySource = readFileSync(
      join(__dirname, '..', '..', '..', 'proxy.ts'),
      'utf8',
    );
    expect(proxySource).toContain("from '@supabase/ssr'");
    expect(proxySource).not.toContain("from '@supabase/supabase-js'");
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
