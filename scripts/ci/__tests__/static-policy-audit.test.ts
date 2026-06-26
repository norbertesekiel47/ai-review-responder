import { describe, it, expect } from 'vitest';
import {
  scanFile,
  auditPackageJson,
  ALLOWED_NEXT_PUBLIC,
  SUBSCRIPTION_STATUS_LITERAL_ALLOWLIST,
} from '../static-policy-audit';

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
    // dashboard/types.ts:112 is an allowlisted type-discriminant — land the literal on line 112.
    const onAllowlistedLine = Array(111).fill('').join('\n') + '\n' + literal;
    expect(scanFile('src/lib/dashboard/types.ts', onAllowlistedLine)).toHaveLength(0);
    // Same file, line 1 (NOT allowlisted) — the carve-out is line-precise, not file-wide.
    expect(scanFile('src/lib/dashboard/types.ts', literal)).toHaveLength(1);
  });

  it('exposes a non-empty, reviewed carve-out allowlist', () => {
    expect(SUBSCRIPTION_STATUS_LITERAL_ALLOWLIST.size).toBeGreaterThan(0);
    expect(SUBSCRIPTION_STATUS_LITERAL_ALLOWLIST.has('worker/ingress/stripe/shared.ts:105')).toBe(true);
    expect(SUBSCRIPTION_STATUS_LITERAL_ALLOWLIST.has('src/lib/dashboard/types.ts:112')).toBe(true);
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
