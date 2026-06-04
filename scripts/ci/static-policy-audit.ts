import { readFile, readdir } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Enforces two CLAUDE.md architecture invariants that are otherwise pure
 * developer discipline (no type system or framework catches them):
 *
 *   #10 — Use Node.js native crypto. The `crypto-js` package must never appear
 *         as a dependency or be imported anywhere.
 *   #13 — Feature flags are server-authoritative. The browser must not learn
 *         flag state from a `NEXT_PUBLIC_*` env var, so every `NEXT_PUBLIC_`
 *         read in code must be on an explicit allowlist of browser-safe values.
 *   Auto-approval policy rows are server-owned. Client components must not
 *         read or write `auto_approval_policies` directly through Supabase.
 *
 * Whole-repo (src + worker + scripts), unlike `pnpm lint` which only covers
 * `src`. Adding a genuinely browser-safe public var is a deliberate one-line
 * edit to ALLOWED_NEXT_PUBLIC below — that review is the point.
 */

export const ALLOWED_NEXT_PUBLIC: ReadonlySet<string> = new Set([
  'NEXT_PUBLIC_APP_URL',
  'NEXT_PUBLIC_DOCS_BASE_URL',
  'NEXT_PUBLIC_GOOGLE_MAPS_API_KEY',
  'NEXT_PUBLIC_SENTRY_DSN',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'NEXT_PUBLIC_SUPABASE_URL',
]);

const SCAN_DIRS = ['src', 'worker', 'scripts'] as const;
const SCAN_EXT = /\.(?:ts|tsx|mjs|cjs|js)$/;
const SKIP_DIRS = new Set(['node_modules', '__tests__', 'dist', '.next', 'coverage']);
const SKIP_FILE = /\.(?:test|spec)\.[cm]?tsx?$/;
// This audit names both forbidden patterns in its own source/messages; skip it
// so it never flags itself.
const SELF = join('scripts', 'ci', 'static-policy-audit.ts');

export type PolicyRule =
  | 'crypto-js'
  | 'next-public-allowlist'
  | 'auto-approval-policy-browser-access';

export interface PolicyFinding {
  file: string;
  line: number;
  rule: PolicyRule;
  detail: string;
}

// An ESM/CJS module specifier for the banned package (bare or submodule import).
const CRYPTO_JS_SPECIFIER = /(?:from|require|import)\s*\(?\s*['"]crypto-js(?:\/[^'"]*)?['"]/;
// An actual READ of a public env var (`process.env.NEXT_PUBLIC_X`) — not a
// log/comment that merely names the variable.
const NEXT_PUBLIC_ACCESS = /process\.env\.(NEXT_PUBLIC_[A-Z0-9_]+)/g;
const USE_CLIENT_DIRECTIVE = /^\s*['"]use client['"];?/m;
// File-local guard only: this catches direct client-component table references.
// It does not follow imports through helper modules, so code review must still
// reject browser Supabase helper indirection for auto_approval_policies.
const AUTO_APPROVAL_POLICY_TABLE = /\bauto_approval_policies\b/;

/** Scan one file's text for both forbidden patterns. Pure — unit-tested. */
export function scanFile(file: string, text: string): PolicyFinding[] {
  const findings: PolicyFinding[] = [];
  const lines = text.split('\n');
  const isClientComponent = USE_CLIENT_DIRECTIVE.test(text);
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i]!;

    if (CRYPTO_JS_SPECIFIER.test(lineText)) {
      findings.push({
        file,
        line: i + 1,
        rule: 'crypto-js',
        detail: 'imports the banned crypto-js package — invariant #10: use node:crypto',
      });
    }

    for (const match of lineText.matchAll(NEXT_PUBLIC_ACCESS)) {
      const name = match[1]!;
      if (!ALLOWED_NEXT_PUBLIC.has(name)) {
        findings.push({
          file,
          line: i + 1,
          rule: 'next-public-allowlist',
          detail:
            `${name} is not allowlisted — invariant #13: feature flags are ` +
            'server-authoritative (no NEXT_PUBLIC_ companion). If genuinely ' +
            'browser-safe and not a flag, add it to ALLOWED_NEXT_PUBLIC.',
        });
      }
    }

    if (isClientComponent && AUTO_APPROVAL_POLICY_TABLE.test(lineText)) {
      findings.push({
        file,
        line: i + 1,
        rule: 'auto-approval-policy-browser-access',
        detail:
          'client components must not access auto_approval_policies directly; ' +
          'owner policy reads/writes must flow through server routes',
      });
    }
  }
  return findings;
}

/** Forbid crypto-js as a declared dependency. Pure — unit-tested. */
export function auditPackageJson(pkg: {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}): PolicyFinding[] {
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  if (Object.prototype.hasOwnProperty.call(deps, 'crypto-js')) {
    return [
      {
        file: 'package.json',
        line: 0,
        rule: 'crypto-js',
        detail: 'crypto-js must not be a dependency — invariant #10: use node:crypto',
      },
    ];
  }
  return [];
}

async function collectFiles(dir: string, root: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // directory absent — nothing to scan
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await collectFiles(join(dir, entry.name), root, out);
    } else if (entry.isFile() && SCAN_EXT.test(entry.name) && !SKIP_FILE.test(entry.name)) {
      out.push(relative(root, join(dir, entry.name)));
    }
  }
}

async function main(): Promise<void> {
  const root = process.cwd();

  const files: string[] = [];
  for (const dir of SCAN_DIRS) await collectFiles(resolve(root, dir), root, files);

  const findings: PolicyFinding[] = [];
  for (const file of files) {
    if (file === SELF) continue;
    findings.push(...scanFile(file, await readFile(resolve(root, file), 'utf8')));
  }

  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  findings.push(...auditPackageJson(pkg));

  if (findings.length > 0) {
    console.error('static-policy-audit: failed');
    for (const f of findings) {
      const loc = f.line > 0 ? `${f.file}:${f.line}` : f.file;
      console.error(`${loc} [${f.rule}] ${f.detail}`);
    }
    process.exit(1);
  }
  console.log(`static-policy-audit: passed (${files.length} files scanned)`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((err) => {
    console.error('static-policy-audit: fatal error');
    console.error(err);
    process.exit(1);
  });
}
