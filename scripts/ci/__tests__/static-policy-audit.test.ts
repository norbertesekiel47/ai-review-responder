import { describe, it, expect } from 'vitest';
import {
  scanFile,
  auditPackageJson,
  ALLOWED_NEXT_PUBLIC,
  SUBSCRIPTION_STATUS_LITERAL_ALLOWLIST,
  scanLegacySubscriptionTiers,
} from '../static-policy-audit';

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
    // dashboard/types.ts:176 is an allowlisted type-discriminant — land the literal on line 176.
    const onAllowlistedLine = Array(175).fill('').join('\n') + '\n' + literal;
    expect(scanFile('src/lib/dashboard/types.ts', onAllowlistedLine)).toHaveLength(0);
    // Same file, line 1 (NOT allowlisted) — the carve-out is line-precise, not file-wide.
    expect(scanFile('src/lib/dashboard/types.ts', literal)).toHaveLength(1);
  });

  it('exposes a non-empty, reviewed carve-out allowlist', () => {
    expect(SUBSCRIPTION_STATUS_LITERAL_ALLOWLIST.size).toBeGreaterThan(0);
    expect(SUBSCRIPTION_STATUS_LITERAL_ALLOWLIST.has('worker/ingress/stripe/shared.ts:112')).toBe(true);
    expect(SUBSCRIPTION_STATUS_LITERAL_ALLOWLIST.has('src/lib/dashboard/types.ts:176')).toBe(true);
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
