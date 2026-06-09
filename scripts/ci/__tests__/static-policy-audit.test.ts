import { describe, it, expect } from 'vitest';
import { scanFile, auditPackageJson, ALLOWED_NEXT_PUBLIC } from '../static-policy-audit';

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
