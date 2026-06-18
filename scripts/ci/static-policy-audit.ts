import { readFile, readdir } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Enforces CLAUDE.md architecture invariants that are otherwise pure
 * developer discipline (no type system or framework catches them):
 *
 *   #10 — Use Node.js native crypto. The `crypto-js` package must never appear
 *         as a dependency or be imported anywhere.
 *   #13 — Feature flags are server-authoritative. The browser must not learn
 *         flag state from a `NEXT_PUBLIC_*` env var, so every `NEXT_PUBLIC_`
 *         read in code must be on an explicit allowlist of browser-safe values.
 *   #14 — Server-owned policy/lifecycle rows must not be read or written
 *         directly by client components through Supabase.
 *    §  — A `'use client'` component must not import `@/lib/db/server`; that
 *         would bundle DATABASE_POOL_URL / SUPABASE_SERVICE_KEY into the browser.
 *         The runtime `server-only` tripwire cannot guard this module — the
 *         Railway worker imports it under tsx and would crash on boot — so this
 *         build-time check stands in (deep-scan §4.3).
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
// This audit names its own forbidden patterns in source/messages; skip it
// so it never flags itself.
const SELF = join('scripts', 'ci', 'static-policy-audit.ts');

export type PolicyRule =
  | 'crypto-js'
  | 'next-public-allowlist'
  | 'server-owned-table-browser-access'
  | 'server-db-client-import'
  | 'subscription-status-literal';

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
// File-local guard only: this catches direct client-component table references.
// It does not follow imports through helper modules, so code review must still
// reject browser Supabase helper indirection for these server-owned tables.
const SERVER_OWNED_BROWSER_FORBIDDEN_TABLES = [
  'account_offboardings',
  'account_offboarding_tokens',
  'auto_approval_policies',
] as const;
const SERVER_OWNED_BROWSER_FORBIDDEN_TABLE_PATTERNS =
  SERVER_OWNED_BROWSER_FORBIDDEN_TABLES.map((table) => ({
    table,
    pattern: new RegExp(`\\b${table}\\b`),
  }));

// Module specifier in a `from '…'` / `import('…')` / `require('…')` position.
const MODULE_SPECIFIER_RE = /(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g;

// True when a specifier resolves to the server-only DB module (`@/lib/db/server`
// or any relative path ending in `lib/db/server` / `db/server`). Mirrors the
// tenant-scope audit's `isDbServerImportSource` so the two stay in agreement.
function isDbServerSpecifier(specifier: string): boolean {
  return specifier === '@/lib/db/server'
    || /(?:^|\/)(?:src\/)?lib\/db\/server$/.test(specifier)
    || /(?:^|\/)db\/server$/.test(specifier);
}

/**
 * True only when `'use client'` is a genuine file-prologue directive — the
 * first non-blank, non-line-comment statement — matching how Next.js treats it.
 * A bare `/^['"]use client['"]/m` regex would also match a `'use client'`
 * string literal later in the file (e.g. a fixture array), falsely flagging a
 * server module as a client component and producing spurious CI failures.
 */
function isClientComponentFile(text: string): boolean {
  return /^['"]use client['"];?/.test(stripLeadingWhitespaceAndComments(text));
}

function stripLeadingWhitespaceAndComments(text: string): string {
  let remaining = text;
  while (remaining.length > 0) {
    const trimmed = remaining.replace(/^\s+/, '');
    if (trimmed.startsWith('//')) {
      const nextLine = trimmed.indexOf('\n');
      remaining = nextLine === -1 ? '' : trimmed.slice(nextLine + 1);
      continue;
    }
    if (trimmed.startsWith('/*')) {
      const commentEnd = trimmed.indexOf('*/');
      if (commentEnd === -1) return trimmed;
      remaining = trimmed.slice(commentEnd + 2);
      continue;
    }
    return trimmed;
  }
  return remaining;
}

// ── Subscription-status bare-literal guard (deep-scan §7.1; repworth.md "Never do") ──
// Subscription status values must use the `SubscriptionStatus` enum
// (src/lib/shared/subscription-status.ts), never bare string literals. Detection
// is LINE-SCOPED to avoid false-positives on OTHER status domains (Zernio
// connection status, review status, job/outbox status): a bare status literal is
// flagged ONLY on a non-comment line that ALSO names the `subscription_status`
// column or `subscriptionStatus` field. The bounded quotes deliberately exclude
// synthetic supersets like 'active_pending_business' / 'pending_payment_admin_handoff'.
// SQL predicates (the enum can't be imported into a postgres.js sql`` template,
// so they keep the literal + a `-- enum:` reference comment) and the dashboard
// view-model discriminant union are the explicit, reviewed allowlist below; the
// carve-out count is printed so growth stays visible.
const SUBSCRIPTION_STATUS_FIELD = /subscription[_]?[Ss]tatus/;
const SUBSCRIPTION_STATUS_LITERAL = /['"](?:active|past_due|cancelled|pending_payment)['"]/;

// file:line sites that legitimately keep a bare literal. Each is either a SQL
// predicate inside a postgres.js sql`` template (annotated with a `-- enum:`
// reference comment) or a type-level discriminant in the dashboard view-model
// union (which mixes enum statuses with synthetic states). Adding a new entry is
// a deliberate, reviewed edit — that review is the point.
export const SUBSCRIPTION_STATUS_LITERAL_ALLOWLIST: ReadonlySet<string> = new Set([
  // ── SQL predicates inside postgres.js sql`` templates (enum can't be imported;
  //    each keeps the literal + a trailing `-- enum: SubscriptionStatus.X` comment) ──
  'src/app/api/admin/billing/grant-extension/route.ts:70',
  'src/app/api/admin/billing/grant-extension/route.ts:108',
  'src/lib/admin/margin-service.ts:135',
  'worker/background/pollers/CancellationGracePoller.ts:46',
  'worker/background/pollers/EmailChannelReconcilePoller.ts:113',
  'worker/background/pollers/EngagementMonitorPoller.ts:90',
  'worker/background/schedulers/MonthlyImpactScheduler.ts:45',
  'worker/background/schedulers/OnboardingDripScheduler.ts:39',
  'worker/background/schedulers/RankingTrackingScheduler.ts:59',
  'worker/background/schedulers/WeeklySummaryScheduler.ts:58',
  'worker/ingress/stripe/checkout-completed.ts:95',
  'worker/ingress/stripe/checkout-completed.ts:101',
  'worker/ingress/stripe/checkout-completed.ts:135',
  'worker/ingress/stripe/checkout-completed.ts:143',
  'worker/ingress/stripe/invoice-paid.ts:36',
  'worker/ingress/stripe/invoice-paid.ts:57',
  'worker/ingress/stripe/invoice-paid.ts:59',
  'worker/ingress/stripe/invoice-payment-failed.ts:37',
  'worker/ingress/stripe/invoice-payment-failed.ts:58',
  'worker/ingress/stripe/invoice-payment-failed.ts:60',
  'worker/ingress/stripe/shared.ts:88',
  'worker/ingress/stripe/subscription-deleted.ts:83',
  'worker/ingress/stripe/subscription-deleted.ts:105',
  // ── dashboard view-model discriminant union (type-level literals; the union
  //    mixes enum statuses with synthetic states like 'active_pending_business') ──
  'src/lib/dashboard/types.ts:110',
  'src/lib/dashboard/types.ts:129',
  'src/lib/dashboard/types.ts:138',
  'src/lib/dashboard/types.ts:257',
]);

/** True when the trimmed line begins a line/block comment (so a status literal
 * mentioned in prose is not mistaken for code). */
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

/** Scan one file's text for both forbidden patterns. Pure — unit-tested. */
export function scanFile(file: string, text: string): PolicyFinding[] {
  const findings: PolicyFinding[] = [];
  const lines = text.split('\n');
  const isClientComponent = isClientComponentFile(text);
  // The subscription-status enum rule targets application code only. `scripts/`
  // (CI tooling, audit allowlist DATA that names real queries) legitimately
  // carries status literals as data and cannot meaningfully import the enum.
  const inAppCode = /^(?:src|worker)[/\\]/.test(file);
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

    if (
      inAppCode &&
      !isCommentLine(lineText) &&
      SUBSCRIPTION_STATUS_FIELD.test(lineText) &&
      SUBSCRIPTION_STATUS_LITERAL.test(lineText) &&
      !SUBSCRIPTION_STATUS_LITERAL_ALLOWLIST.has(`${file}:${i + 1}`)
    ) {
      findings.push({
        file,
        line: i + 1,
        rule: 'subscription-status-literal',
        detail:
          'bare subscription-status string literal — use the SubscriptionStatus ' +
          'enum (src/lib/shared/subscription-status.ts), not a raw string. If this ' +
          'is a SQL predicate or a type-level discriminant that cannot import the ' +
          'enum, add file:line to SUBSCRIPTION_STATUS_LITERAL_ALLOWLIST.',
      });
    }

    if (isClientComponent) {
      for (const { table, pattern } of SERVER_OWNED_BROWSER_FORBIDDEN_TABLE_PATTERNS) {
        if (!pattern.test(lineText)) continue;
        findings.push({
          file,
          line: i + 1,
          rule: 'server-owned-table-browser-access',
          detail:
            `client components must not access ${table} directly; ` +
            'server-owned table reads/writes must flow through server routes',
        });
      }

      // A type-only import (`import type … from`) erases at build time and is
      // harmless; everything else pulls runtime code (and its env secrets).
      if (!/^\s*import\s+type\b/.test(lineText)) {
        for (const match of lineText.matchAll(MODULE_SPECIFIER_RE)) {
          if (!isDbServerSpecifier(match[1]!)) continue;
          findings.push({
            file,
            line: i + 1,
            rule: 'server-db-client-import',
            detail:
              'client components must not import @/lib/db/server (bundles ' +
              'DATABASE_POOL_URL / SUPABASE_SERVICE_KEY into the browser); ' +
              'DB access must flow through server routes',
          });
        }
      }
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
  console.log(
    'static-policy-audit: subscription-status literal carve-outs allowlisted: ' +
    `${SUBSCRIPTION_STATUS_LITERAL_ALLOWLIST.size}`,
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((err) => {
    console.error('static-policy-audit: fatal error');
    console.error(err);
    process.exit(1);
  });
}
