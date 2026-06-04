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

describe('scanFile — auto_approval_policies browser access', () => {
  it('flags client components that reference auto_approval_policies directly', () => {
    const findings = scanFile(
      'src/app/dashboard/settings/auto-approval-panel.tsx',
      [
        "'use client';",
        "await supabase.from('auto_approval_policies').select('*');",
      ].join('\n'),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe('auto-approval-policy-browser-access');
  });

  it('allows server routes and workers to reference auto_approval_policies', () => {
    const findings = scanFile(
      'src/app/api/settings/auto-approval/route.ts',
      "await sql`SELECT * FROM auto_approval_policies`;",
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
