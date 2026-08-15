import { describe, it, expect } from 'vitest';
import {
  scanFile,
  auditPackageJson,
  ALLOWED_NEXT_PUBLIC,
  SUBSCRIPTION_STATUS_LITERAL_ALLOWLIST,
  scanLegacySubscriptionTiers,
  auditRailwayConfig,
  scanSqlExecutorTagNames,
  scanWorkerNodeEnvReads,
} from '../static-policy-audit';
import { SQL_TAG_NAMES } from '../lib/sql-tag-scan';

describe('legacy subscription-tier AST audit', () => {
  it.each([
    ['comparison', "if (account.subscription_tier === 'basic') return;"],
    ['SQL value', "await sql`UPDATE accounts SET subscription_tier = 'standard'`;"],
    ['interpolated SQL value', "await sql`UPDATE accounts SET subscription_tier = 'standard' WHERE id = ${id}`;"],
    ['schema enum', "const subscriptionTierSchema = z.enum(['premium', 'copilot']);"],
    ['tier map', "const TIER_CONFIG = { founders: { included: 1 } };"],
    ['singular tier', "const subscriptionTier: SubscriptionTier = 'founding';"],
    ['tier return', "function subscriptionTierForAccount() { return 'basic'; }"],
    ['capitalized tier label', "const tierLabel = 'Standard';"],
  ])('flags removed tier in %s context', (_label, source) => {
    const findings = scanLegacySubscriptionTiers('src/example.ts', source);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe('legacy-subscription-tier');
  });

  it.each([
    ['upgrade copy', "const copy = 'Basic includes one location. Upgrade to Standard or Premium.';"],
    ['feature copy', "const copy = 'Multi-location supported on Premium';"],
    ['support label', "const copy = 'Founders: response target';"],
    ['lowercase plan copy', "const copy = 'upgrade to premium plan';"],
    ['explicit founding tier', "const copy = 'founding tier';"],
  ])('flags embedded legacy plan names in %s', (_label, source) => {
    expect(scanLegacySubscriptionTiers('src/example.tsx', source).length).toBeGreaterThan(0);
  });

  it.each([
    ['capitalized Basic auth', "const docs = 'Basic authentication uses a header';"],
    ['capitalized standard confirmation', "const docs = 'Standard confirmation is required';"],
    ['capitalized standard library', "const docs = 'Standard library behavior';"],
    ['capitalized premium adjective', "const docs = 'Premium materials improve durability';"],
    ['legal cancellation term', "const docs = 'Standard cancellation keeps access through the paid period';"],
    ['founding offer', "const copy = 'Founding offer';"],
    ['founding price', "const copy = 'founding price';"],
    ['founding variant', "const copy = 'founding variant';"],
  ])('allows embedded %s as non-tier English', (_label, source) => {
    expect(scanLegacySubscriptionTiers('src/example.ts', source)).toEqual([]);
  });

  it.each([
    ['stored price variant', "const row = { price_variant: 'founding' };"],
    ['PriceVariant type', "type PriceVariant = 'list' | 'founding';"],
    ['variant resolver argument', "resolveTierSnapshot('copilot', 'founding');"],
    ['confirmation level', "const confirmationLevel = 'standard';"],
    ['auth mode', "const authenticationScheme = 'basic';"],
    ['ordinary product adjective', "const serviceQuality = 'premium';"],
    ['ordinary team noun', "const audience = 'founders';"],
    ['ordinary assertion', "expect(row).toEqual('standard');"],
    ['ordinary confirmation call', "requireConfirmation('standard');"],
    ['Basic auth call', "buildAuthHeader('basic');"],
    ['standard library call', "loadLibrary('standard');"],
  ])('allows %s outside the subscription-tier domain', (_label, source) => {
    expect(scanLegacySubscriptionTiers('src/example.ts', source)).toEqual([]);
  });

  it('flags removed enum member symbols without relying on a string literal', () => {
    const findings = scanLegacySubscriptionTiers(
      'src/example.ts',
      'const tier = SubscriptionTier.PREMIUM;',
    );
    expect(findings).toHaveLength(1);
  });

  it('flags removed members declared directly in a subscription-tier enum', () => {
    const findings = scanLegacySubscriptionTiers(
      'src/example.ts',
      "enum SubscriptionTier { PREMIUM = 'premium' }",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.detail).toContain('premium');
  });

  it('flags a retired shorthand key in a tier registry', () => {
    const findings = scanLegacySubscriptionTiers(
      'src/example.ts',
      'const premium = {}; const TIER_CONFIG = { premium };',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.detail).toContain('premium');
  });

  it('flags a retired literal passed indirectly into a tier schema', () => {
    const findings = scanLegacySubscriptionTiers(
      'src/example.ts',
      "const values = ['standard']; const subscriptionTierSchema = z.enum(values);",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.detail).toContain('standard');
  });

  it('allows one-step founding indirection for a price-variant schema', () => {
    expect(scanLegacySubscriptionTiers(
      'src/example.ts',
      "const values = ['list', 'founding']; const priceVariantSchema = z.enum(values);",
    )).toEqual([]);
  });

  it('does not let a nearby price_variant predicate hide a singular tier value', () => {
    const findings = scanLegacySubscriptionTiers(
      'src/example.ts',
      "sql`UPDATE accounts SET price_variant = 'list', subscription_tier = 'founding' WHERE id = ${id}`;",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.detail).toContain('founding');
  });

  it('does not let an adjacent variant declaration hide a singular tier value', () => {
    const findings = scanLegacySubscriptionTiers(
      'src/example.ts',
      "const subscriptionTier = 'founding', priceVariant = 'list';",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.detail).toContain('founding');
  });

  it('allows founding in a price-variant comparison inside tier-domain code', () => {
    expect(
      scanLegacySubscriptionTiers(
        'src/example.ts',
        "const subscriptionTier = priceVariant === 'founding' ? 'copilot' : 'autopilot';",
      ),
    ).toEqual([]);
  });

  it.each([
    "const priceVariant = subscriptionTier === 'founding' ? 'founding' : 'list';",
    "const row = { priceVariant: account.subscriptionTier === 'founding' ? 'founding' : 'list' };",
  ])('does not let a variant-named ancestor hide a nested retired tier comparison', (source) => {
    const findings = scanLegacySubscriptionTiers('src/example.ts', source);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.detail).toContain('founding');
  });

  it.each([
    "expect(account.subscription_tier).toBe('standard');",
    "expect(tier).toEqual('premium');",
    "assert.equal(subscriptionTier, 'founders');",
  ])('flags removed tier values in tier assertions', (source) => {
    expect(scanLegacySubscriptionTiers('tests/example.test.ts', source)).toHaveLength(1);
  });
});

describe('scanFile — crypto-js (invariant #10)', () => {
  it('flags a named ESM import of crypto-js', () => {
    const findings = scanFile('src/x.ts', "import { SHA256 } from 'crypto-js';");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe('crypto-js');
  });

  it('flags a require of a crypto-js submodule', () => {
    const findings = scanFile('src/x.ts', "const md5 = require('crypto-js/md5');");
    expect(findings.some((f) => f.rule === 'crypto-js')).toBe(true);
  });

  it('flags a dynamic import of crypto-js', () => {
    const findings = scanFile('src/x.ts', "await import('crypto-js');");
    expect(findings.some((f) => f.rule === 'crypto-js')).toBe(true);
  });

  it('does not flag node:crypto', () => {
    const findings = scanFile('src/x.ts', "import { createHash } from 'node:crypto';");
    expect(findings).toHaveLength(0);
  });
});

describe('scanFile — next/font/google', () => {
  it('flags a named ESM import of next/font/google', () => {
    const findings = scanFile('src/app/layout.tsx', "import { Inter } from 'next/font/google';");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe('next-font-google');
  });

  it('flags a dynamic import of next/font/google', () => {
    const findings = scanFile('src/app/layout.tsx', "await import('next/font/google');");
    expect(findings.some((f) => f.rule === 'next-font-google')).toBe(true);
  });

  // The whole point of the ban: the root layout was migrated first while
  // (authenticated)/layout.tsx still imported the Google loader, and a single
  // remaining import keeps the compile-time fetch — and the outage — alive.
  it('flags a second call site outside the root layout', () => {
    const findings = scanFile(
      'src/app/(authenticated)/layout.tsx',
      "import { Young_Serif, DM_Sans } from 'next/font/google';",
    );
    expect(findings.some((f) => f.rule === 'next-font-google')).toBe(true);
  });

  it('does not flag next/font/local', () => {
    const findings = scanFile('src/app/layout.tsx', "import localFont from 'next/font/local';");
    expect(findings).toHaveLength(0);
  });
});

describe('scanFile — NEXT_PUBLIC allowlist (invariant #13)', () => {
  it('flags a non-allowlisted process.env.NEXT_PUBLIC_ read', () => {
    const findings = scanFile(
      'src/x.ts',
      'const on = process.env.NEXT_PUBLIC_BETA_ENABLED === "true";',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe('next-public-allowlist');
    expect(findings[0]!.detail).toContain('NEXT_PUBLIC_BETA_ENABLED');
  });

  it('explicitly rejects public auto-approval flag companions', () => {
    const findings = scanFile(
      'src/x.ts',
      'const on = process.env.NEXT_PUBLIC_AUTO_APPROVAL_ENABLED === "true";',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe('next-public-allowlist');
    expect(findings[0]!.detail).toContain('NEXT_PUBLIC_AUTO_APPROVAL_ENABLED');
  });

  it('explicitly rejects public account offboarding flag companions', () => {
    const findings = scanFile(
      'src/x.ts',
      'const on = process.env.NEXT_PUBLIC_ACCOUNT_OFFBOARDING_ENABLED === "true";',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe('next-public-allowlist');
    expect(findings[0]!.detail).toContain('NEXT_PUBLIC_ACCOUNT_OFFBOARDING_ENABLED');
  });

  it('allows every allowlisted var', () => {
    for (const name of ALLOWED_NEXT_PUBLIC) {
      expect(scanFile('src/x.ts', `const v = process.env.${name};`)).toHaveLength(0);
    }
  });

  it('ignores a NEXT_PUBLIC_ name in a log/comment string (not a process.env read)', () => {
    const findings = scanFile('src/x.ts', "logger.error('NEXT_PUBLIC_NEW_FLAG not set');");
    expect(findings).toHaveLength(0);
  });

  it('reports the correct 1-based line number', () => {
    const text = ['a', 'b', 'const x = process.env.NEXT_PUBLIC_NOPE;'].join('\n');
    expect(scanFile('src/x.ts', text)[0]!.line).toBe(3);
  });
});

describe('scanFile — server-owned table browser access', () => {
  it.each([
    'account_offboardings',
    'account_offboarding_tokens',
    'auto_approval_policies',
  ])('flags client components that reference %s directly', (table) => {
    const findings = scanFile(
      'src/app/dashboard/settings/account-panel.tsx',
      [
        "'use client';",
        `await supabase.from('${table}').select('*');`,
      ].join('\n'),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe('server-owned-table-browser-access');
    expect(findings[0]!.detail).toContain(table);
  });

  it('recognizes client directives after leading block comments', () => {
    const findings = scanFile(
      'src/app/dashboard/settings/account-panel.tsx',
      [
        '/* eslint-disable react-hooks/rules-of-hooks */',
        "'use client';",
        "await supabase.from('account_offboardings').select('*');",
      ].join('\n'),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe('server-owned-table-browser-access');
  });

  it.each([
    'account_offboardings',
    'account_offboarding_tokens',
    'auto_approval_policies',
  ])('allows server routes and workers to reference %s', (table) => {
    const findings = scanFile('src/app/api/account/route.ts', `await sql\`SELECT * FROM ${table}\`;`);

    expect(findings).toHaveLength(0);
  });

  it('does not treat a mid-file "use client" string literal as a client directive', () => {
    const findings = scanFile(
      'src/lib/server/policy-examples.ts',
      [
        'const DIRECTIVES = [',
        "  'use client',",
        '];',
        'await sql`SELECT * FROM account_offboardings`;',
      ].join('\n'),
    );

    expect(findings).toHaveLength(0);
  });
});

describe('scanFile — server-only DB module client import (deep-scan §4.3)', () => {
  it.each([
    "import { sql } from '@/lib/db/server';",
    "import { sql, jsonb } from '@/lib/db/server';",
    "import { supabaseServer } from '../../lib/db/server';",
    "const { sql } = await import('@/lib/db/server');",
    "export { sql } from '@/lib/db/server';",
  ])('flags a client component that imports the DB module: %s', (importLine) => {
    const findings = scanFile(
      'src/app/dashboard/widget.tsx',
      ["'use client';", importLine].join('\n'),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe('server-db-client-import');
    expect(findings[0]!.detail).toContain('@/lib/db/server');
  });

  it('allows a server route to import the DB module', () => {
    const findings = scanFile(
      'src/app/api/feedback/route.ts',
      "import { sql } from '@/lib/db/server';",
    );
    expect(findings).toHaveLength(0);
  });

  it('allows the Railway worker to import the DB module', () => {
    const findings = scanFile(
      'worker/jobs/EngagementAlertWorker.ts',
      "import { sql } from '../../src/lib/db/server';",
    );
    expect(findings).toHaveLength(0);
  });

  it('does not flag a type-only import in a client component (erased at build)', () => {
    const findings = scanFile(
      'src/app/dashboard/widget.tsx',
      ["'use client';", "import type { Sql } from '@/lib/db/server';"].join('\n'),
    );
    expect(findings).toHaveLength(0);
  });

  it('does not flag an unrelated import in a client component', () => {
    const findings = scanFile(
      'src/app/dashboard/widget.tsx',
      ["'use client';", "import { useState } from 'react';"].join('\n'),
    );
    expect(findings).toHaveLength(0);
  });
});

describe('scanFile — subscription-status bare literal (deep-scan §7.1; repworth.md)', () => {
  it('flags a camelCase field compared to a bare status literal', () => {
    const findings = scanFile('src/lib/x.ts', "if (account.subscriptionStatus === 'active') {}");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe('subscription-status-literal');
    expect(findings[0]!.detail).toContain('SubscriptionStatus');
  });

  it('flags a snake_case column compared to a bare status literal', () => {
    const findings = scanFile('worker/jobs/x.ts', "if (row.subscription_status !== 'cancelled') {}");
    expect(findings.some((f) => f.rule === 'subscription-status-literal')).toBe(true);
  });

  it("flags the new 'trialing' status literal (enum invariant covers trialing too)", () => {
    // Regression: the trial feature added 'trialing' to SubscriptionStatus, so a
    // bare 'trialing' literal on a subscription_status line must be flagged just
    // like the other four canonical statuses — otherwise CI silently stops
    // enforcing the enum invariant for the new status.
    const findings = scanFile('worker/jobs/x.ts', "if (row.subscription_status === 'trialing') {}");
    expect(findings.some((f) => f.rule === 'subscription-status-literal')).toBe(true);
  });

  it('does NOT flag another status domain on a line without a subscription field', () => {
    // The trap: connection / review status literals must never be migrated.
    expect(scanFile('src/x.ts', "if (conn.status === 'active') return null;")).toHaveLength(0);
    expect(scanFile('src/x.ts', "const open = review.status === 'pending_approval';")).toHaveLength(0);
  });

  it('does NOT flag synthetic discriminant supersets (bounded quotes)', () => {
    // 'active_pending_business' / 'pending_payment_admin_handoff' are dashboard
    // view-model states, not the enum; the closing-quote anchor excludes them.
    expect(
      scanFile('src/x.ts', "if (data.subscriptionStatus === 'active_pending_business') {}"),
    ).toHaveLength(0);
    expect(
      scanFile('src/x.ts', "if (data.subscriptionStatus === 'pending_payment_admin_handoff') {}"),
    ).toHaveLength(0);
  });

  it('does NOT flag a status literal mentioned in a comment line', () => {
    expect(scanFile('src/x.ts', "// historically subscription_status was 'active'")).toHaveLength(0);
    expect(scanFile('src/x.ts', " * sets subscription_status = 'past_due' on failure")).toHaveLength(0);
  });

  it('does NOT flag in scripts/ (rule is application-code scoped: src/ + worker/)', () => {
    // scripts/ allowlist DATA legitimately names real queries with status literals.
    expect(
      scanFile('scripts/ci/tenant-scope-allowlist.ts', "subscription_status IN ('active', 'past_due')"),
    ).toHaveLength(0);
  });

  it('honors the allowlist line-precisely (allowlisted line passes; same file, other line fails)', () => {
    const literal = "  subscriptionStatus: 'past_due';";
    // dashboard/types.ts:177 is an allowlisted type-discriminant — land the literal on line 177.
    const onAllowlistedLine = Array(176).fill('').join('\n') + '\n' + literal;
    expect(scanFile('src/lib/dashboard/types.ts', onAllowlistedLine)).toHaveLength(0);
    // Same file, line 1 (NOT allowlisted) — the carve-out is line-precise, not file-wide.
    expect(scanFile('src/lib/dashboard/types.ts', literal)).toHaveLength(1);
  });

  it('exposes a non-empty, reviewed carve-out allowlist', () => {
    expect(SUBSCRIPTION_STATUS_LITERAL_ALLOWLIST.size).toBeGreaterThan(0);
    // These two are SAMPLES, not a contract — they exist to prove the allowlist is
    // populated and reviewed. Because the keys are `file:line`, a sample breaks
    // whenever anything is inserted above the cited line in the cited file. This
    // one moved :112 → :137 → :147 inside #677 alone: first when
    // `maybeEnqueueBackfillResume` gained a `sql.begin` + businesses row lock
    // (round-2 F107), then when round-1 O3 replaced its copied payload/enqueue
    // block with the shared `enqueueInitialImport`. The dashboard sample moved
    // :176 → :186 → :177 across admin-invite-funnel: T5 deleted
    // `DashboardDataPendingAdminHandoff` and documented `funnelUrl` above it
    // (pushing it down), then D-11 removed the `paymentUrl` tombstone that
    // deletion had stranded (pulling it back up).
    expect(SUBSCRIPTION_STATUS_LITERAL_ALLOWLIST.has('worker/ingress/stripe/shared.ts:147')).toBe(true);
    expect(SUBSCRIPTION_STATUS_LITERAL_ALLOWLIST.has('src/lib/dashboard/types.ts:177')).toBe(true);
  });
});

describe('auditPackageJson — crypto-js (invariant #10)', () => {
  it('flags crypto-js in dependencies', () => {
    const findings = auditPackageJson({ dependencies: { 'crypto-js': '^4.2.0' } });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe('crypto-js');
  });

  it('flags crypto-js in devDependencies', () => {
    expect(auditPackageJson({ devDependencies: { 'crypto-js': '^4.2.0' } })).toHaveLength(1);
  });

  it('passes when crypto-js is absent', () => {
    expect(auditPackageJson({ dependencies: { uuid: '^14.0.0' } })).toHaveLength(0);
  });
});

describe('scanFile — inline feature-flag ban (invariant #13, Stage-4)', () => {
  it('flags an inline process.env.X_ENABLED read in app code', () => {
    const findings = scanFile('src/app/api/x/route.ts', "if (process.env.FOO_ENABLED === 'true') {}");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe('inline-feature-flag');
    expect(findings[0]!.detail).toContain('FOO_ENABLED');
  });

  it('flags an inline process.env.X_DISABLED read (kill-switch)', () => {
    const findings = scanFile('worker/background/pollers/Y.ts', "if (process.env.BAR_DISABLED === 'true') return;");
    expect(findings.map((f) => f.rule)).toContain('inline-feature-flag');
  });

  it('does NOT flag a <feature>/flags.ts accessor module (the sanctioned home)', () => {
    const findings = scanFile('src/lib/auth/flags.ts', "return process.env.SELF_SERVE_SIGNUP_ENABLED === 'true';");
    expect(findings.filter((f) => f.rule === 'inline-feature-flag')).toHaveLength(0);
  });

  it('does NOT flag the readFlag primitive (config/flags.ts)', () => {
    const findings = scanFile('src/lib/config/flags.ts', "return process.env[name] === 'true';");
    expect(findings.filter((f) => f.rule === 'inline-feature-flag')).toHaveLength(0);
  });

  it('does NOT flag the worker boot-assert (startup-assert.ts)', () => {
    const findings = scanFile('worker/config/startup-assert.ts', "if (process.env.CHANNELS_TELEGRAM_ENABLED !== 'true') return;");
    expect(findings.filter((f) => f.rule === 'inline-feature-flag')).toHaveLength(0);
  });

  it('does NOT flag scripts/ tooling (run standalone via tsx)', () => {
    const findings = scanFile('scripts/verify-x.ts', "const required = process.env.STRIPE_TAX_ENABLED === 'true';");
    expect(findings.filter((f) => f.rule === 'inline-feature-flag')).toHaveLength(0);
  });

  it('does NOT flag a bare flag-name mention without the process.env. prefix (comment/log string)', () => {
    const comment = scanFile('src/x.ts', "  // gated behind FOO_ENABLED when the flag is on");
    const logStr = scanFile('src/y.ts', "    logger.log('BAR_DISABLED=true — not starting');");
    expect(comment.filter((f) => f.rule === 'inline-feature-flag')).toHaveLength(0);
    expect(logStr.filter((f) => f.rule === 'inline-feature-flag')).toHaveLength(0);
  });

  it('does NOT flag a process.env.X_ENABLED that appears on a comment line', () => {
    const findings = scanFile('src/x.ts', "  // historical: process.env.FOO_ENABLED === 'true' gated this");
    expect(findings.filter((f) => f.rule === 'inline-feature-flag')).toHaveLength(0);
  });

  it('does NOT flag dynamic process.env[name] (bracket notation, used by readFlag)', () => {
    const findings = scanFile('src/x.ts', "const on = process.env[flagName] === 'true';");
    expect(findings.filter((f) => f.rule === 'inline-feature-flag')).toHaveLength(0);
  });

  it('flags a NON-allowlisted NEXT_PUBLIC string-bracket read (no notation bypass of the public rule)', () => {
    const bad = scanFile('src/x.ts', "if (process.env['NEXT_PUBLIC_BETA_ENABLED'] === 'true') {}");
    const pub = bad.filter((f) => f.rule === 'next-public-allowlist');
    expect(pub).toHaveLength(1);
    expect(pub[0]!.detail).toContain('NEXT_PUBLIC_BETA_ENABLED');
    // and it is NOT double-flagged by the feature-flag rule
    expect(bad.filter((f) => f.rule === 'inline-feature-flag')).toHaveLength(0);
  });

  it('does NOT flag an ALLOWLISTED NEXT_PUBLIC string-bracket read', () => {
    const ok = scanFile('src/x.ts', "const u = process.env[\"NEXT_PUBLIC_APP_URL\"];");
    expect(ok.filter((f) => f.rule === 'next-public-allowlist')).toHaveLength(0);
  });

  it('flags the string-bracket form process.env[\'X_ENABLED\'] (no notation bypass)', () => {
    const single = scanFile('src/x.ts', "if (process.env['FOO_ENABLED'] === 'true') {}");
    const dbl = scanFile('src/x.ts', 'if (process.env["BAR_DISABLED"] === "true") {}');
    expect(single.filter((f) => f.rule === 'inline-feature-flag').map((f) => f.detail.includes('FOO_ENABLED'))).toEqual([true]);
    expect(dbl.filter((f) => f.rule === 'inline-feature-flag').map((f) => f.detail.includes('BAR_DISABLED'))).toEqual([true]);
  });

  it('does NOT flag near-miss names (word boundary): X_ENABLEDISH / X_ENABLED_FOO / X_ENABLED2', () => {
    for (const code of [
      "process.env.FOO_ENABLEDISH === 'true'",
      "process.env.FOO_ENABLED_FOO === 'true'",
      "process.env.FOO_ENABLED2 === 'true'",
    ]) {
      expect(scanFile('src/x.ts', code).filter((f) => f.rule === 'inline-feature-flag')).toHaveLength(0);
    }
  });

  it('STILL flags a non-accessor file ending in -flags.ts (only real <feature>/flags.ts is exempt)', () => {
    const findings = scanFile('src/lib/x/feature-flags.ts', "if (process.env.FOO_ENABLED === 'true') {}");
    expect(findings.filter((f) => f.rule === 'inline-feature-flag')).toHaveLength(1);
  });

  it('exempts ONLY the repo-root worker/config/startup-assert.ts (a nested look-alike is still flagged)', () => {
    const root = scanFile('worker/config/startup-assert.ts', "if (process.env.FOO_ENABLED !== 'true') return;");
    const nested = scanFile('src/foo/worker/config/startup-assert.ts', "if (process.env.FOO_ENABLED !== 'true') return;");
    expect(root.filter((f) => f.rule === 'inline-feature-flag')).toHaveLength(0);
    expect(nested.filter((f) => f.rule === 'inline-feature-flag')).toHaveLength(1);
  });
});

describe('auditRailwayConfig — single-replica invariant (#567, R1)', () => {
  it('passes the real railway.toml shape (no replica declaration)', () => {
    const toml = ['[deploy]', 'startCommand = "pnpm worker"', 'healthcheckPath = "/api/health"'].join('\n');
    expect(auditRailwayConfig('railway.toml', toml)).toEqual([]);
  });

  it('flags numReplicas in TOML', () => {
    const findings = auditRailwayConfig('railway.toml', 'numReplicas = 2\n');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe('railway-replicas');
    expect(findings[0]!.line).toBe(1);
  });

  it('flags numReplicas in JSON', () => {
    expect(auditRailwayConfig('railway.json', '    "numReplicas": 2,\n')).toHaveLength(1);
  });

  it('flags a multiRegionConfig TOML table header, which carries no numReplicas of its own', () => {
    const findings = auditRailwayConfig('railway.toml', '[deploy.multiRegionConfig.us-west2]\n');
    expect(findings.map((finding) => finding.rule)).toEqual(['railway-replicas']);
  });

  it('flags an inline multiRegionConfig key', () => {
    expect(auditRailwayConfig('railway.json', '  "multiRegionConfig": {}\n')).toHaveLength(1);
  });

  it('does not flag prose mentioning numReplicas in a TOML comment', () => {
    expect(auditRailwayConfig('railway.toml', '# never set numReplicas = 2 here\n')).toEqual([]);
  });

  it('points the reader at the scale-out backlog', () => {
    const [finding] = auditRailwayConfig('railway.toml', 'numReplicas = 2\n');
    expect(finding!.detail).toContain('worker-scaling-hardening-backlog.md');
  });

  // Each of these is a valid Railway config-as-code spelling that the original
  // line-anchored rule let through: anchoring on the key meant any line opening
  // with `{` or a parent segment never matched. Codex adversarial review, #586.
  it.each([
    ['compact single-line JSON', 'railway.json', '{"deploy":{"multiRegionConfig":{"us-west2":{"numReplicas":2}}}}'],
    ['dotted TOML key path', 'railway.toml', 'deploy.multiRegionConfig.us-west2.numReplicas = 2\n'],
    ['TOML inline table on deploy', 'railway.toml', 'deploy = { multiRegionConfig = { "us-west2" = { numReplicas = 2 } } }\n'],
    ['quoted TOML key', 'railway.toml', '"numReplicas" = 2\n'],
    ['deeply nested pretty JSON', 'railway.json', '{\n  "deploy": {\n    "multiRegionConfig": {\n      "us-west2": { "numReplicas": 2 }\n    }\n  }\n}'],
  ])('flags %s', (_label, file, text) => {
    const findings = auditRailwayConfig(file, text);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((finding) => finding.rule === 'railway-replicas')).toBe(true);
  });

  it('does not flag a JSON string value that merely mentions a banned key', () => {
    const json = '{"deploy":{"startCommand":"pnpm worker --note numReplicas"}}';
    expect(auditRailwayConfig('railway.json', json)).toEqual([]);
  });

  it('does not flag a trailing TOML comment after a real setting', () => {
    const toml = 'startCommand = "pnpm worker" # never set numReplicas = 2\n';
    expect(auditRailwayConfig('railway.toml', toml)).toEqual([]);
  });

  it('does not truncate at a # inside a quoted TOML value', () => {
    const toml = 'startCommand = "pnpm worker --tag #1"\nnumReplicas = 2\n';
    const findings = auditRailwayConfig('railway.toml', toml);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.line).toBe(2);
  });

  it('still passes the committed railway.toml', async () => {
    const { readFile } = await import('node:fs/promises');
    const text = await readFile('railway.toml', 'utf8');
    expect(auditRailwayConfig('railway.toml', text)).toEqual([]);
  });
});

describe('scanSqlExecutorTagNames — SQL invisible to the vocabulary audits (#592)', () => {
  const builder = (param: string) => `
    import type { Sql, TransactionSql } from 'postgres';
    type SqlExecutor = Sql | TransactionSql;
    export function primaryTrackedKeywordSql(${param}: SqlExecutor) {
      return ${param}\`SELECT 1 FROM job_outbox WHERE status IN ('pending')\`;
    }
  `;

  it.each([...SQL_TAG_NAMES])('accepts the recognised tag name %s', (name) => {
    expect(scanSqlExecutorTagNames('src/lib/shared/x.ts', builder(name))).toEqual([]);
  });

  it('flags an executor parameter that tags SQL under an unscanned name', () => {
    const findings = scanSqlExecutorTagNames('src/lib/shared/x.ts', builder('runner'));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe('sql-executor-tag-name');
    expect(findings[0]!.detail).toContain('runner');
  });

  it.each(['Sql', 'TransactionSql', 'SqlExecutor', 'Sql | TransactionSql'])(
    'recognises the executor type %s',
    (type) => {
      const src = `
        export async function load(runner: ${type}) {
          return runner\`SELECT 1\`;
        }
      `;
      expect(scanSqlExecutorTagNames('worker/jobs/x.ts', src)).toHaveLength(1);
    },
  );

  it('ignores an executor that is only passed along, never used as a tag', () => {
    const src = `
      import type { Sql } from 'postgres';
      export async function archive(client: Sql, id: string) {
        return purge(client, id);
      }
    `;
    expect(scanSqlExecutorTagNames('src/lib/x.ts', src)).toEqual([]);
  });

  it('ignores a non-executor parameter that happens to tag a template', () => {
    const src = `
      export function label(html: TemplateRenderer) {
        return html\`<p>hi</p>\`;
      }
    `;
    expect(scanSqlExecutorTagNames('src/lib/x.ts', src)).toEqual([]);
  });

  it('scopes to src/ and worker/ — the dirs the four audits actually scan', () => {
    // scripts/health-bundle-differential.ts names its executor `observer` and
    // queries pg_stat_activity; no vocabulary audit reaches scripts/.
    expect(scanSqlExecutorTagNames('scripts/health-bundle-differential.ts', builder('observer')))
      .toEqual([]);
  });

  it('flags a method and an arrow function, not just a declaration', () => {
    const src = `
      import type { Sql } from 'postgres';
      export const read = (runner: Sql) => runner\`SELECT 1\`;
      class Store {
        write(runner: Sql) { return runner\`SELECT 2\`; }
      }
    `;
    expect(scanSqlExecutorTagNames('src/lib/x.ts', src)).toHaveLength(2);
  });
});

describe('scanWorkerNodeEnvReads — the deployment lane owns the lane question (#611)', () => {
  it("static-policy flags a NODE_ENV === 'production' comparison added under worker/", () => {
    const findings = scanWorkerNodeEnvReads(
      'worker/jobs/ExampleWorker.ts',
      "if (process.env.NODE_ENV === 'production') { return; }",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe('worker-node-env-read');
    expect(findings[0]!.line).toBe(1);
    expect(findings[0]!.detail).toContain('requiresProductionConfig');
  });

  it("static-policy flags a NODE_ENV !== 'production' comparison added under worker/", () => {
    const findings = scanWorkerNodeEnvReads(
      'worker/ingress/shared.ts',
      "if (process.env.NODE_ENV !== 'production') { allowDevProxy(); }",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe('worker-node-env-read');
  });

  it('static-policy flags a raw NODE_ENV read assigned to a local under worker/', () => {
    const bindingForms = [
      'const mode = process.env.NODE_ENV;',
      'const { NODE_ENV } = process.env;',
      'const { NODE_ENV: mode } = process.env;',
      "const { ['NODE_ENV']: mode } = process.env;",
    ];
    for (const src of bindingForms) {
      const findings = scanWorkerNodeEnvReads('worker/background/schedulers/Example.ts', src);
      expect(findings, src).toHaveLength(1);
      expect(findings[0]!.rule).toBe('worker-node-env-read');
    }
  });

  it('static-policy flags a raw NODE_ENV read exported from one worker file for use in another', () => {
    // The read is banned rather than the comparison precisely because the audit
    // has no symbol resolution: the comparison below lives in a different file.
    const producer = scanWorkerNodeEnvReads(
      'worker/config/runtime-mode.ts',
      'export const runtimeMode = process.env.NODE_ENV;',
    );
    expect(producer).toHaveLength(1);
    expect(producer[0]!.rule).toBe('worker-node-env-read');

    const consumer = scanWorkerNodeEnvReads(
      'worker/jobs/ExampleWorker.ts',
      [
        "import { runtimeMode } from '../config/runtime-mode';",
        "if (runtimeMode === 'production') { return; }",
      ].join('\n'),
    );
    expect(consumer).toEqual([]);
  });

  it('static-policy flags bracket and template-literal access to NODE_ENV under worker/', () => {
    const src = [
      "const a = process.env['NODE_ENV'];",
      'const b = process.env["NODE_ENV"];',
      'const c = process.env[`NODE_ENV`];',
      "const d = process['env'].NODE_ENV;",
    ].join('\n');
    const findings = scanWorkerNodeEnvReads('worker/jobs/ExampleWorker.ts', src);
    expect(findings.map((f) => f.line)).toEqual([1, 2, 3, 4]);
    expect(findings.every((f) => f.rule === 'worker-node-env-read')).toBe(true);
  });

  it('static-policy does not flag the dynamic required-variable-list reads in startup-assert', async () => {
    // The real shape from worker/config/startup-assert.ts: a name list filtered
    // with a variable key. Banning every dynamic process.env[…] would break it.
    const src = [
      'function missingEnvVars(required: string[]): string[] {',
      '  return required.filter((k) => !process.env[k] || process.env[k]!.trim().length === 0);',
      '}',
      'function invalidOptionalBooleanEnv(required: readonly string[]): string[] {',
      '  return required.filter((key) => {',
      '    const value = process.env[key];',
      "    return value !== undefined && value !== 'true' && value !== 'false';",
      '  });',
      '}',
    ].join('\n');
    expect(scanWorkerNodeEnvReads('worker/config/startup-assert.ts', src)).toEqual([]);

    const { readFile } = await import('node:fs/promises');
    const committed = await readFile('worker/config/startup-assert.ts', 'utf8');
    expect(scanWorkerNodeEnvReads('worker/config/startup-assert.ts', committed)).toEqual([]);
  });

  it('static-policy does not flag the NODE_ENV mention inside a comment or an error-message string under worker/', () => {
    const src = [
      '// NOT NODE_ENV: staging runs with NODE_ENV=production, so asking it is wrong.',
      '/** Fires on any deployed lane, including one that leaves NODE_ENV unset. */',
      'export function laneProof(lane: string): string {',
      "  const detail = 'NODE_ENV=production';",
      '  throw new Error(`[startup] ${detail} ${lane}: neither RAILWAY_ENVIRONMENT_NAME nor NODE_ENV set`);',
      '}',
    ].join('\n');
    expect(scanWorkerNodeEnvReads('worker/sentry.ts', src)).toEqual([]);
  });

  it('static-policy exempts AccountOffboardingPurgePoller.ts by name and records #614 as the removal trigger', async () => {
    const purgeGuard =
      "if (process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production') { return null; }";
    expect(
      scanWorkerNodeEnvReads(
        'worker/background/pollers/AccountOffboardingPurgePoller.ts',
        purgeGuard,
      ),
    ).toEqual([]);
    // The exemption is by exact path — a sibling poller gets no pass.
    expect(
      scanWorkerNodeEnvReads('worker/background/pollers/OutboxPoller.ts', purgeGuard),
    ).toHaveLength(1);

    // …and the removal trigger is recorded next to the exemption itself, so the
    // entry cannot outlive #614 without someone deleting the reason too.
    const { readFile } = await import('node:fs/promises');
    const auditLines = (await readFile('scripts/ci/static-policy-audit.ts', 'utf8')).split('\n');
    const exemptionIndex = auditLines.findIndex((line) =>
      line.includes('AccountOffboardingPurgePoller.ts'),
    );
    expect(exemptionIndex).toBeGreaterThanOrEqual(0);
    const nearby = auditLines
      .slice(Math.max(0, exemptionIndex - 15), exemptionIndex + 2)
      .join('\n');
    expect(nearby).toContain('#614');
  });
});
